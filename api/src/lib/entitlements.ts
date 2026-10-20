import {
  LINEUP_PLAN,
  checkLimit,
  effectiveTier,
  hasFeature,
  normalizeTier,
  tierForFeature,
  type Entitlement,
  type Feature,
  type LimitCheck,
  type LineupResource,
  type TierId,
  type Usage,
} from '@lineup/shared';
import { queryOne } from './db.js';
import { getImpersonation } from './impersonation.js';
import { memo } from './requestScope.js';

/** Paywall is off at launch. Flip PAYWALL_ENABLED=true to enforce tiers. */
export function paywallEnabled(): boolean {
  return process.env.PAYWALL_ENABLED === 'true';
}

/**
 * The entitlement and paywall state to evaluate a user against.
 *
 * Impersonating a tier has to switch the paywall ON for that user, otherwise
 * assuming "free" still reports unlimited capacity while the paywall is off
 * globally — which is exactly the thing you are trying to test.
 */
export function resolvePlanContext(
  userId: string,
): Promise<{ entitlement: Entitlement | null; paywall: boolean; impersonated: boolean }> {
  return memo(`plan:${userId}`, () => loadPlanContext(userId));
}

async function loadPlanContext(
  userId: string,
): Promise<{ entitlement: Entitlement | null; paywall: boolean; impersonated: boolean }> {
  const [real, impersonation] = await Promise.all([
    getEntitlement(userId),
    getImpersonation(userId),
  ]);

  if (!impersonation.tier) {
    return { entitlement: real, paywall: paywallEnabled(), impersonated: false };
  }

  return {
    entitlement: {
      appId: LINEUP_PLAN.appId,
      userId,
      tier: impersonation.tier,
      grantedAt: new Date().toISOString(),
      status: 'active',
      accessUntil: null,
    },
    paywall: true,
    impersonated: true,
  };
}

interface EntitlementRow {
  tier: string;
  overrides: Record<string, number> | null;
  granted_at: Date;
  org_id: string | null;
  region_id: string | null;
  status: string;
  access_until: Date | null;
}

function toEntitlement(row: EntitlementRow, userId: string): Entitlement {
  return {
    appId: LINEUP_PLAN.appId,
    userId,
    tier: normalizeTier(row.tier),
    overrides: row.overrides ?? undefined,
    grantedAt: row.granted_at.toISOString(),
    orgId: row.org_id,
    regionId: row.region_id,
    status: row.status as Entitlement['status'],
    accessUntil: row.access_until ? row.access_until.toISOString() : null,
  };
}

/**
 * The plan covering a user.
 *
 * Paid features belong to the person who pays. A plan held by an organization
 * or region covers only that scope's staff (organization admins, directors
 * and region admins, including region staff inside a paid organization).
 * Coaches, parents and team parents invited into a paid organization still
 * need their own plan.
 */
export function getEntitlement(userId: string): Promise<Entitlement | null> {
  return memo(`ent:${userId}`, () => loadEntitlement(userId));
}

async function loadEntitlement(userId: string): Promise<Entitlement | null> {
  const row = await queryOne<EntitlementRow>(
    `SELECT e.tier, e.overrides, e.granted_at, e.org_id, e.region_id,
            e.status, e.access_until
       FROM entitlement e
       LEFT JOIN membership m
              ON m.user_id = $2
             AND m.role IN ('org_admin', 'director', 'region_admin')
             AND (m.org_id = e.org_id
                  OR m.region_id = e.region_id
                  OR m.region_id IN (SELECT r.id FROM region r WHERE r.org_id = e.org_id))
      WHERE e.app_id = $1
        AND (e.user_id = $2 OR m.user_id = $2)
        AND (e.expires_at IS NULL OR e.expires_at > now())
        AND (e.status = 'active'
             OR (e.status = 'cancelled' AND e.access_until > now()))
      ORDER BY CASE e.tier
                 WHEN 'organizationPlus' THEN 8
                 WHEN 'organization' THEN 7 WHEN 'league' THEN 7
                 WHEN 'region' THEN 6
                 WHEN 'coach' THEN 5 WHEN 'club' THEN 5
                 WHEN 'teamParent' THEN 4 WHEN 'parent' THEN 3
                 WHEN 'referee' THEN 2 ELSE 1 END DESC
      LIMIT 1`,
    [LINEUP_PLAN.appId, userId],
  );

  return row ? toEntitlement(row, userId) : null;
}

export async function getTier(userId: string): Promise<TierId> {
  const { entitlement, paywall } = await resolvePlanContext(userId);
  if (!paywall) return 'organizationPlus';
  return effectiveTier(entitlement);
}

/**
 * Gate adding a region to an organization: Organization allows 20 regions,
 * Organization Plus 40, a standalone Region plan 1. Returns null when allowed.
 */
export async function enforceRegionLimit(userId: string, orgId: string): Promise<Denial | null> {
  const [{ entitlement, paywall }, row] = await Promise.all([
    resolvePlanContext(userId),
    queryOne<{ n: string }>(
      'SELECT COUNT(*) AS n FROM region WHERE org_id = $1 AND deleted_at IS NULL AND NOT is_personal',
      [orgId],
    ),
  ]);
  const check = checkLimit(LINEUP_PLAN, entitlement, { regions: Number(row?.n ?? 0) }, 'regions', 1, paywall);
  if (check.allowed) return null;
  return {
    status: 402,
    body: {
      error: `Your plan allows ${check.limit} region${check.limit === 1 ? '' : 's'}.`,
      code: 'LIMIT_REACHED',
      details: check,
    },
  };
}

export interface StandaloneRegionGate {
  allowed: boolean;
  reason: 'upgrade-required' | 'limit-reached' | null;
  upgradeTo: TierId | null;
}

/**
 * May this person start a standalone region (one with no organization above
 * it)? That is the Region plan: one region of their own. It needs a plan the
 * person actually holds, not the paywall-off default, so a free coach never
 * sees it. Platform admins may set one up to test.
 */
export async function standaloneRegionGate(
  userId: string,
  isPlatformAdmin: boolean,
): Promise<StandaloneRegionGate> {
  const [{ entitlement }, owned] = await Promise.all([
    resolvePlanContext(userId),
    queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n
         FROM region r JOIN organization o ON o.id = r.org_id
        WHERE r.created_by = $1 AND o.is_personal AND NOT r.is_personal
          AND r.deleted_at IS NULL AND o.deleted_at IS NULL`,
      [userId],
    ),
  ]);
  if (Number(owned?.n ?? 0) >= 1) return { allowed: false, reason: 'limit-reached', upgradeTo: null };
  if (isPlatformAdmin || effectiveTier(entitlement) === 'region') {
    return { allowed: true, reason: null, upgradeTo: null };
  }
  return { allowed: false, reason: 'upgrade-required', upgradeTo: 'region' };
}

/** Account-scoped usage: how many teams this user can reach. */
export async function getAccountUsage(userId: string): Promise<Usage<LineupResource>> {
  // Owned teams and teams under the user's team, region or organization
  // memberships (division memberships do not count toward the plan).
  const row = await queryOne<{ teams: string }>(
    `SELECT COUNT(*) AS teams FROM team t
      WHERE t.deleted_at IS NULL AND t.archived_at IS NULL AND t.id IN (
        SELECT id FROM team WHERE owner_id = $1
        UNION SELECT team_id FROM membership WHERE user_id = $1 AND team_id IS NOT NULL
        UNION SELECT t2.id FROM membership m JOIN team t2 ON t2.region_id = m.region_id WHERE m.user_id = $1
        UNION SELECT t2.id FROM membership m JOIN team t2 ON t2.org_id = m.org_id WHERE m.user_id = $1)`,
    [userId],
  );
  return { teams: Number(row?.teams ?? 0) };
}

/**
 * Per-team usage: games and players counted inside one team.
 *
 * Games count per season (August to July, the same season region sign-ups
 * use), so a team's allowance starts again each season within the yearly
 * plan. Games with no date yet count toward the current season.
 */
export async function getTeamUsage(teamId: string): Promise<Usage<LineupResource>> {
  const row = await queryOne<{ games: string; players: string }>(
    `WITH season AS (
       SELECT (date_trunc('year', current_date - interval '7 months') + interval '7 months')::date AS starts
     )
     SELECT
       (SELECT COUNT(*) FROM game, season
         WHERE team_id = $1 AND deleted_at IS NULL AND canceled_at IS NULL
           AND (date IS NULL OR (date >= season.starts AND date < season.starts + interval '1 year'))) AS games,
       (SELECT COUNT(*) FROM player WHERE team_id = $1 AND active) AS players`,
    [teamId],
  );
  return {
    gamesPerTeam: Number(row?.games ?? 0),
    playersPerTeam: Number(row?.players ?? 0),
  };
}

export interface Denial {
  status: number;
  body: {
    error: string;
    code: string;
    details: LimitCheck | { feature: Feature; tier: TierId; upgradeTo?: TierId | null };
  };
}

/** Gate creating a team. Returns null when allowed. */
export async function enforceTeamLimit(userId: string): Promise<Denial | null> {
  const [{ entitlement, paywall }, usage] = await Promise.all([
    resolvePlanContext(userId),
    getAccountUsage(userId),
  ]);

  const check = checkLimit(LINEUP_PLAN, entitlement, usage, 'teams', 1, paywall);
  if (check.allowed) return null;

  return {
    status: 402,
    body: {
      error: `Your plan allows ${check.limit} teams.`,
      code: 'LIMIT_REACHED',
      details: check,
    },
  };
}

/**
 * Gate creating a game or adding a player. Counted per team, so a coach with
 * four free teams gets the full allowance on each of them.
 */
export async function enforceTeamScopedLimit(
  userId: string,
  teamId: string,
  resource: Extract<LineupResource, 'gamesPerTeam' | 'playersPerTeam'>,
  delta = 1,
): Promise<Denial | null> {
  const [{ entitlement, paywall }, usage] = await Promise.all([
    resolvePlanContext(userId),
    getTeamUsage(teamId),
  ]);

  const check = checkLimit(LINEUP_PLAN, entitlement, usage, resource, delta, paywall, teamId);
  if (check.allowed) return null;

  const noun = resource === 'gamesPerTeam' ? 'games' : 'players';
  return {
    status: 402,
    body: {
      error: `Your plan allows ${check.limit} ${noun} per team${resource === 'gamesPerTeam' ? ' each season (August to July)' : ''}.`,
      code: 'LIMIT_REACHED',
      details: check,
    },
  };
}

/** Gate a feature rather than a quantity. */
export async function enforceFeature(
  userId: string,
  feature: Feature,
): Promise<Denial | null> {
  const { entitlement, paywall } = await resolvePlanContext(userId);
  const tier = paywall ? effectiveTier(entitlement) : 'organization';
  if (hasFeature(tier, feature, paywall)) return null;

  return {
    status: 402,
    body: {
      error: `${FEATURE_LABEL[feature] ?? feature} is part of a paid plan. See Account, Plans to subscribe.`,
      code: 'UPGRADE_REQUIRED',
      details: { feature, tier, upgradeTo: tierForFeature(feature) ?? null },
    },
  };
}

/** Whether the caller's plan includes a feature, without building a denial. */
export async function featureEnabled(userId: string, feature: Feature): Promise<boolean> {
  return (await enforceFeature(userId, feature)) === null;
}

/**
 * The referee's running game clock. Someone can hold Referee Premium next to
 * a bigger plan (a coach who also referees); only the biggest plan counts
 * elsewhere, so a live Referee plan is checked on its own here.
 */
export async function refereeClockEnabled(userId: string): Promise<boolean> {
  if (await featureEnabled(userId, 'refereeClock')) return true;
  const { impersonated } = await resolvePlanContext(userId);
  if (impersonated) return false;
  return Boolean(
    await queryOne(
      `SELECT 1 FROM entitlement
        WHERE app_id = $1 AND user_id = $2 AND tier = 'referee'
          AND (expires_at IS NULL OR expires_at > now())
          AND (status = 'active' OR (status = 'cancelled' AND access_until > now()))
        LIMIT 1`,
      [LINEUP_PLAN.appId, userId],
    ),
  );
}

/** Plain names for the upgrade message a coach or parent actually reads. */
const FEATURE_LABEL: Partial<Record<Feature, string>> = {
  matchClock: 'The match day clock',
  fullStats: 'Tracking stats beyond goals, assists and cards',
  longShareLinks: 'Sharing lineups, stats and calendars',
  scopeStandings: 'Organization and region standings',
  customStats: 'Custom stats',
  chatAttachments: 'Photos in team chat',
  ownPlayerStats: "Your child's stats",
  eventFlyers: 'Event flyers',
  playerEvaluation: "Your child's overall rating",
  chatPolls: 'Creating polls in team chat',
  refereeClock: 'The referee game clock',
};

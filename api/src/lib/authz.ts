/**
 * Authorization — loads a caller's memberships and resolves permissions
 * through the shared access engine.
 *
 * Replaces the old assertTeamOwner check, which only understood a single
 * owner per team and had no concept of roles, inheritance or plan gating.
 */

import type { HttpResponseInit } from '@azure/functions';
import {
  canOnTeam,
  canManageScope,
  visiblePlayerIds,
  type AccessContext,
  type Action,
  type Decision,
  type Membership,
  type Role,
  type Scope,
  type TeamContext,
} from '@lineup/shared';
import { query, queryOne } from './db.js';
import { getTier, paywallEnabled } from './entitlements.js';
import { getImpersonation } from './impersonation.js';
import { memo, outsideRequestScope } from './requestScope.js';
import { settleTrials } from './trials.js';
import { sendReminders } from './reminders.js';
import { sendSupportReplies } from './supportEmail.js';
import { purgeArchivedTeams } from './teamPurge.js';
import type { AuthedUser } from './auth.js';

interface MembershipRow {
  role: string;
  org_id: string | null;
  region_id: string | null;
  division_id: string | null;
  team_id: string | null;
}

export function loadMemberships(userId: string): Promise<Membership[]> {
  return memo(`mem:${userId}`, () => readMemberships(userId));
}

async function readMemberships(userId: string): Promise<Membership[]> {
  // Memberships in an organization, region or team paused by a lapsed free
  // trial grant nothing until a subscription restores it.
  const rows = await query<MembershipRow>(
    `SELECT m.role, m.org_id, m.region_id, m.division_id, m.team_id
       FROM membership m
      WHERE m.user_id = $1
        AND NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = m.org_id AND o.paused_by_trial IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM region r WHERE r.id = m.region_id AND r.paused_by_trial IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM team t WHERE t.id = m.team_id AND t.paused_by_trial IS NOT NULL)`,
    [userId],
  );
  return rows.map((r) => ({
    userId,
    role: r.role as Role,
    orgId: r.org_id,
    regionId: r.region_id,
    divisionId: r.division_id,
    teamId: r.team_id,
  }));
}

/** Players this user is a parent or guardian of. */
export function loadGuardianOf(userId: string): Promise<string[]> {
  return memo(`grd:${userId}`, async () => {
    const rows = await query<{ player_id: string }>(
      'SELECT player_id FROM player_guardian WHERE user_id = $1',
      [userId],
    );
    return rows.map((r) => r.player_id);
  });
}

/** Lapsed trials, due reminders, support replies by email and archived teams past their month, started in the background so no click waits for them. */
function runHousekeeping(): void {
  void outsideRequestScope(() =>
    settleTrials()
      .catch(() => undefined)
      .then(() => sendReminders())
      .catch(() => 0)
      .then(() => sendSupportReplies())
      .catch(() => undefined)
      .then(() => purgeArchivedTeams())
      .catch(() => 0),
  );
}

/** The account's own platform-admin flag (impersonation does not change it). */
export function isPlatformAdmin(userId: string): Promise<boolean> {
  return memo(`padmin:${userId}`, async () =>
    Boolean(
      (await queryOne<{ is_platform_admin: boolean }>('SELECT is_platform_admin FROM app_user WHERE id = $1', [userId]))
        ?.is_platform_admin,
    ),
  );
}

export function buildAccessContext(user: AuthedUser): Promise<AccessContext> {
  return memo(`acx:${user.id}`, () => readAccessContext(user));
}

async function readAccessContext(user: AuthedUser): Promise<AccessContext> {
  // Lapsed free trials are paused lazily, and due reminders for games,
  // practices and events go out (there is no timer to do either on the
  // hour). Both are throttled and run beside the request, not before it.
  runHousekeeping();
  const [memberships, guardianOf, tier, platformAdmin, impersonation] = await Promise.all([
    loadMemberships(user.id),
    loadGuardianOf(user.id),
    getTier(user.id),
    isPlatformAdmin(user.id),
    getImpersonation(user.id),
  ]);

  // Impersonation swaps the ROLE on memberships the caller already holds. It
  // deliberately does not add memberships, so assuming org_admin shows you
  // that surface over your own teams and never reaches anyone else's data.
  const effectiveMemberships = impersonation.role
    ? memberships.map((m) => ({ ...m, role: impersonation.role as Role }))
    : memberships;

  return {
    userId: user.id,
    memberships: effectiveMemberships,
    guardianOf,
    tier: impersonation.tier ?? tier,
    // A tier impersonation switches the paywall on for this user, matching
    // resolvePlanContext — otherwise assuming "free" while the global paywall
    // is off would still unlock every paid feature.
    paywallEnabled: impersonation.tier ? true : paywallEnabled(),
    // Never inheritable: impersonation must not be able to mint a platform
    // admin, or the access code becomes a full takeover. It also switches the
    // bypass OFF while active, so an admin testing "team parent" sees exactly
    // what a team parent sees instead of every admin control.
    isPlatformAdmin: impersonation.active ? false : platformAdmin,
  };
}

/** Where a team sits in the hierarchy. Null when it does not exist. */
export function loadTeamContext(teamId: string): Promise<TeamContext | null> {
  return memo(`team:${teamId}`, () => readTeamContext(teamId));
}

async function readTeamContext(teamId: string): Promise<TeamContext | null> {
  const row = await queryOne<{
    id: string;
    org_id: string;
    region_id: string | null;
    division_id: string | null;
    org_personal: boolean;
    region_personal: boolean | null;
    archived: boolean;
  }>(
    `SELECT t.id, t.org_id, t.region_id, t.division_id,
            o.is_personal AS org_personal, r.is_personal AS region_personal,
            (t.archived_at IS NOT NULL) AS archived
       FROM team t
       JOIN organization o ON o.id = t.org_id
       LEFT JOIN region r ON r.id = t.region_id
      WHERE t.id = $1 AND t.deleted_at IS NULL`,
    [teamId],
  );
  if (!row) return null;
  return {
    teamId: row.id,
    orgId: row.org_id,
    regionId: row.region_id,
    divisionId: row.division_id,
    // A real organization, or a standalone region (a real region in a hidden
    // personal organization), makes the team part of a league.
    inLeague: !row.org_personal || Boolean(row.region_id && row.region_personal === false),
    archived: row.archived,
  };
}

/** An archived team is read-only (packages/shared/src/teamArchive.ts). */
export const TEAM_ARCHIVED: HttpResponseInit = {
  status: 409,
  jsonBody: { error: 'This team is archived, so it is read-only.', code: 'TEAM_ARCHIVED' },
};

/** Translate a denial into the right HTTP status and body. */
export function denyResponse(d: Decision): HttpResponseInit {
  if (d.reason === 'archived') return TEAM_ARCHIVED;
  if (d.reason === 'upgrade-required') {
    return {
      status: 402,
      jsonBody: {
        error: 'Your plan does not include this feature.',
        code: 'UPGRADE_REQUIRED',
        details: { feature: d.requiresFeature },
      },
    };
  }
  // Both "no membership" and "role denied" return 403 so the API never
  // reveals whether a record exists to someone who cannot see it.
  return {
    status: 403,
    jsonBody: { error: 'You do not have access to this.', code: 'FORBIDDEN' },
  };
}

export interface TeamGuard {
  ok: true;
  ctx: AccessContext;
  team: TeamContext;
  role: Role;
}
export interface TeamGuardFail {
  ok: false;
  response: HttpResponseInit;
}

/**
 * Single entry point for team-scoped endpoints: resolves the caller, the team
 * and the permission in one call.
 */
export async function guardTeam(
  user: AuthedUser,
  teamId: string | undefined,
  action: Action,
): Promise<TeamGuard | TeamGuardFail> {
  if (!teamId) {
    return {
      ok: false,
      response: { status: 400, jsonBody: { error: 'teamId is required' } },
    };
  }

  // The team and the caller's access are independent lookups: run them together.
  const [team, ctx] = await Promise.all([loadTeamContext(teamId), buildAccessContext(user)]);
  if (!team) {
    // 404 and 403 are deliberately indistinguishable to a non-member.
    return {
      ok: false,
      response: { status: 403, jsonBody: { error: 'You do not have access to this.', code: 'FORBIDDEN' } },
    };
  }

  const decision = canOnTeam(ctx, team, action);
  if (!decision.allowed) {
    return { ok: false, response: denyResponse(decision) };
  }

  return { ok: true, ctx, team, role: decision.matchedRole ?? 'viewer' };
}

/** Guard an org/region/division management action. */
export async function guardScope(
  user: AuthedUser,
  scope: Scope,
): Promise<{ ok: true; ctx: AccessContext } | TeamGuardFail> {
  const ctx = await buildAccessContext(user);
  const decision = canManageScope(ctx, scope);
  if (!decision.allowed) {
    return { ok: false, response: denyResponse(decision) };
  }
  return { ok: true, ctx };
}

/** Filter a roster down to what the caller may see. */
export function filterRoster<T extends { id: string }>(
  ctx: AccessContext,
  team: TeamContext,
  players: T[],
): T[] {
  const allowed = new Set(visiblePlayerIds(ctx, team, players.map((p) => p.id)));
  return players.filter((p) => allowed.has(p.id));
}

/**
 * Ids of the teams a user can reach: teams they own, plus every team under a
 * team, division, region or organization they belong to. Written as a union
 * of index lookups, so it stays fast with many teams. $1 is the user id.
 */
export const REACHABLE_TEAM_IDS_SQL = `
  SELECT id FROM team WHERE owner_id = $1
  UNION SELECT team_id FROM membership WHERE user_id = $1 AND team_id IS NOT NULL
  UNION SELECT t.id FROM membership m JOIN team t ON t.division_id = m.division_id WHERE m.user_id = $1
  UNION SELECT t.id FROM membership m JOIN team t ON t.region_id = m.region_id WHERE m.user_id = $1
  UNION SELECT t.id FROM membership m JOIN team t ON t.org_id = m.org_id WHERE m.user_id = $1`;

/** Team ids the caller can reach, for list endpoints. */
export function reachableTeamIds(userId: string): Promise<string[]> {
  return memo(`reach:${userId}`, async () => {
    const rows = await query<{ id: string }>(
      `SELECT t.id FROM team t
        WHERE t.deleted_at IS NULL AND t.id IN (${REACHABLE_TEAM_IDS_SQL})`,
      [userId],
    );
    return rows.map((r) => r.id);
  });
}

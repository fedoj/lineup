/**
 * Free trials: starting them, what each person's trials look like, and what
 * happens when an organization or region trial runs out unpaid.
 *
 * There is no timer in Static Web Apps managed functions, so lapsed trials
 * are settled lazily: settleTrials() runs at most once a minute per instance
 * from the access check every request already makes. Settling pauses the
 * lapsed organization or region (hidden from everyone, kept for
 * TRIAL_KEEP_DAYS) and deletes paused data once that window has passed.
 */

import type pg from 'pg';
import {
  LINEUP_PLAN,
  TRIAL_KEEP_DAYS,
  trialDaysLeft,
  trialKeepUntil,
  trialState,
  type TrialInfo,
  type TrialKind,
  type TrialStatus,
  type TrialTier,
} from '@lineup/shared';
import { query, queryOne, transaction } from './db.js';

interface TrialRow {
  id: string;
  user_id: string;
  kind: TrialKind;
  tier: TrialTier;
  org_id: string | null;
  region_id: string | null;
  scope_name: string | null;
  started_at: Date;
  ends_at: Date;
  converted_at: Date | null;
  paused_at: Date | null;
  dismissed_at: Date | null;
  purged_at: Date | null;
}

const SETTLE_EVERY_MS = 60_000;
let lastSettle = 0;
let settling: Promise<void> | null = null;

/**
 * Pause organization and region trials that ran out unpaid, and delete paused
 * data older than the keep window. Throttled; pass force to run it now.
 */
export async function settleTrials(force = false): Promise<void> {
  if (settling) return settling;
  const now = Date.now();
  if (!force && now - lastSettle < SETTLE_EVERY_MS) return;
  lastSettle = now;
  settling = (async () => {
    try {
      const due = await query<{ id: string }>(
        `SELECT id FROM plan_trial
          WHERE kind = 'scope' AND converted_at IS NULL AND paused_at IS NULL
            AND ends_at <= now()
          ORDER BY ends_at LIMIT 25`,
      );
      for (const t of due) await pauseTrial(t.id);

      const expired = await query<{ id: string }>(
        `SELECT id FROM plan_trial
          WHERE kind = 'scope' AND converted_at IS NULL AND paused_at IS NOT NULL
            AND purged_at IS NULL AND ends_at <= now() - make_interval(days => $1)
          ORDER BY ends_at LIMIT 10`,
        [TRIAL_KEEP_DAYS],
      );
      for (const t of expired) await purgeTrial(t.id);
    } finally {
      settling = null;
    }
  })();
  return settling;
}

/** The organization a trial's scope sits in (a hidden one for a standalone region). */
async function trialOrgId(c: pg.PoolClient, t: Pick<TrialRow, 'org_id' | 'region_id'>): Promise<string | null> {
  if (t.org_id) return t.org_id;
  if (!t.region_id) return null;
  const r = await c.query<{ org_id: string }>('SELECT org_id FROM region WHERE id = $1', [t.region_id]);
  return r.rows[0]?.org_id ?? null;
}

/**
 * A trial ran out unpaid. Teams that were linked in from elsewhere go back to
 * their coaches as standalone teams; the organization or region, its regions
 * and the teams created in it are hidden from everyone until a subscription
 * restores them or the keep window ends.
 */
export async function pauseTrial(trialId: string): Promise<void> {
  await transaction(async (c) => {
    const claimed = await c.query<TrialRow>(
      `UPDATE plan_trial SET paused_at = now()
        WHERE id = $1 AND paused_at IS NULL AND converted_at IS NULL
        RETURNING *`,
      [trialId],
    );
    const t = claimed.rows[0];
    if (!t) return;
    const orgId = await trialOrgId(c, t);
    if (!orgId) return;

    const outside = await c.query<{ id: string; name: string; owner_id: string }>(
      `SELECT id, name, owner_id FROM team
        WHERE org_id = $1 AND deleted_at IS NULL
          AND (created_at < $2 OR joined_league_at IS NOT NULL)`,
      [orgId, t.started_at],
    );
    for (const team of outside.rows) {
      const org = await c.query<{ id: string }>(
        `INSERT INTO organization (name, is_personal, created_by)
         VALUES ($1, true, $2) RETURNING id`,
        [team.name, team.owner_id],
      );
      const reg = await c.query<{ id: string }>(
        `INSERT INTO region (org_id, name, is_personal, created_by)
         VALUES ($1, 'Default', true, $2) RETURNING id`,
        [org.rows[0].id, team.owner_id],
      );
      // Custom divisions belong to the trial's region, so the link is dropped.
      await c.query(
        `UPDATE team SET org_id = $2, region_id = $3, division_id = NULL, joined_league_at = NULL
          WHERE id = $1`,
        [team.id, org.rows[0].id, reg.rows[0].id],
      );
    }

    await c.query(
      `UPDATE team SET deleted_at = now(), paused_by_trial = $2
        WHERE org_id = $1 AND deleted_at IS NULL`,
      [orgId, t.id],
    );
    await c.query(
      `UPDATE region SET deleted_at = now(), paused_by_trial = $2
        WHERE org_id = $1 AND deleted_at IS NULL`,
      [orgId, t.id],
    );
    await c.query(
      `UPDATE organization SET deleted_at = now(), paused_by_trial = $2
        WHERE id = $1 AND deleted_at IS NULL`,
      [orgId, t.id],
    );
  });
}

/** The keep window has passed: delete what the trial paused. */
export async function purgeTrial(trialId: string): Promise<void> {
  await transaction(async (c) => {
    const claimed = await c.query<{ id: string }>(
      `UPDATE plan_trial SET purged_at = now()
        WHERE id = $1 AND purged_at IS NULL AND converted_at IS NULL AND paused_at IS NOT NULL
        RETURNING id`,
      [trialId],
    );
    if (!claimed.rows[0]) return;
    const ids = await c.query<{ id: string }>(
      `SELECT id FROM organization WHERE paused_by_trial = $1
       UNION ALL SELECT id FROM region WHERE paused_by_trial = $1
       UNION ALL SELECT id FROM team WHERE paused_by_trial = $1`,
      [trialId],
    );
    // Logos are stored apart from what they belong to, without a foreign key.
    await c.query('DELETE FROM logo WHERE ref_id = ANY($1::uuid[])', [ids.rows.map((r) => r.id)]);
    await c.query('DELETE FROM team WHERE paused_by_trial = $1', [trialId]);
    await c.query('DELETE FROM region WHERE paused_by_trial = $1', [trialId]);
    await c.query('DELETE FROM organization WHERE paused_by_trial = $1', [trialId]);
  });
}

/**
 * Someone with a trial subscribed. The trial is marked converted and, if it
 * had already been paused, everything it paused comes back as it was.
 */
export async function convertTrial(c: pg.PoolClient, userId: string, tier: string): Promise<boolean> {
  const kind: TrialKind = tier === 'coach' ? 'coach' : 'scope';
  if (!['coach', 'region', 'organization', 'organizationPlus'].includes(tier)) return false;
  const r = await c.query<{ id: string }>(
    `UPDATE plan_trial SET converted_at = now()
      WHERE user_id = $1 AND kind = $2 AND converted_at IS NULL AND purged_at IS NULL
      RETURNING id`,
    [userId, kind],
  );
  const t = r.rows[0];
  if (!t) return false;
  for (const table of ['organization', 'region', 'team']) {
    await c.query(`UPDATE ${table} SET deleted_at = NULL, paused_by_trial = NULL WHERE paused_by_trial = $1`, [t.id]);
  }
  return true;
}

function toInfo(r: TrialRow, now: Date): TrialInfo {
  const state = trialState({ endsAt: r.ends_at, convertedAt: r.converted_at, purgedAt: r.purged_at }, now);
  return {
    id: r.id,
    kind: r.kind,
    tier: r.tier,
    name: r.scope_name,
    orgId: r.org_id,
    regionId: r.region_id,
    startedAt: r.started_at.toISOString(),
    endsAt: r.ends_at.toISOString(),
    daysLeft: trialDaysLeft(r.ends_at, now),
    state,
    dismissed: Boolean(r.dismissed_at),
    keepUntil: state === 'ended' && r.kind === 'scope' ? trialKeepUntil(r.ends_at).toISOString() : null,
  };
}

/** The plan this person holds on their own account, if it is live. */
async function ownLivePlan(userId: string): Promise<{ tier: string; trial: boolean } | null> {
  const row = await queryOne<{ tier: string; external_ref: string | null }>(
    `SELECT tier, external_ref FROM entitlement
      WHERE app_id = $1 AND user_id = $2 AND tier <> 'free'
        AND (expires_at IS NULL OR expires_at > now())
        AND (status = 'active' OR (status = 'cancelled' AND access_until > now()))`,
    [LINEUP_PLAN.appId, userId],
  );
  return row ? { tier: row.tier, trial: row.external_ref === 'trial' } : null;
}

export async function getTrialStatus(userId: string): Promise<TrialStatus> {
  const now = new Date();
  const [rows, plan] = await Promise.all([
    query<TrialRow>('SELECT * FROM plan_trial WHERE user_id = $1', [userId]),
    ownLivePlan(userId),
  ]);
  const scope = rows.find((r) => r.kind === 'scope');
  const coach = rows.find((r) => r.kind === 'coach');
  const paid = Boolean(plan && !plan.trial);
  const scopeRunning = Boolean(scope && trialState({ endsAt: scope.ends_at, convertedAt: scope.converted_at }, now) === 'active');
  return {
    scope: scope ? toInfo(scope, now) : null,
    coach: coach ? toInfo(coach, now) : null,
    canStart: {
      organization: !paid && !scope,
      region: !paid && !scope,
      // An organization or region trial already includes every Coach feature.
      coach: !paid && !coach && !scopeRunning,
    },
    blockedReason: paid ? 'You already have a paid plan, so a free trial is not needed.' : null,
  };
}

import {
  LINEUP_PLAN,
  checkLimit,
  type Entitlement,
  type LineupResource,
  type TierId,
  type Usage,
} from '@lineup/shared';
import { queryOne } from './db.js';

/** Paywall is off at launch. Flip PAYWALL_ENABLED=true to enforce tiers. */
export function paywallEnabled(): boolean {
  return process.env.PAYWALL_ENABLED === 'true';
}

export async function getEntitlement(userId: string): Promise<Entitlement | null> {
  const row = await queryOne<{
    tier: string;
    overrides: Record<string, number> | null;
    granted_at: Date;
  }>(
    `SELECT tier, overrides, granted_at
       FROM entitlement
      WHERE app_id = $1 AND user_id = $2
        AND (expires_at IS NULL OR expires_at > now())`,
    [LINEUP_PLAN.appId, userId],
  );

  if (!row) return null;

  return {
    appId: LINEUP_PLAN.appId,
    userId,
    tier: row.tier as TierId,
    overrides: row.overrides ?? undefined,
    grantedAt: row.granted_at.toISOString(),
  };
}

/** Current consumption for the metered resources. */
export async function getUsage(userId: string): Promise<Usage<LineupResource>> {
  const row = await queryOne<{ teams: string; games: string }>(
    `SELECT
       (SELECT COUNT(*) FROM team WHERE owner_id = $1) AS teams,
       (SELECT COUNT(*) FROM game g
          JOIN team t ON t.id = g.team_id
         WHERE t.owner_id = $1) AS games`,
    [userId],
  );

  return {
    teams: Number(row?.teams ?? 0),
    games: Number(row?.games ?? 0),
  };
}

/** Gate a create operation. Returns null when allowed. */
export async function enforceLimit(
  userId: string,
  resource: LineupResource,
  delta = 1,
): Promise<{ status: number; body: unknown } | null> {
  const [entitlement, usage] = await Promise.all([
    getEntitlement(userId),
    getUsage(userId),
  ]);

  const check = checkLimit(
    LINEUP_PLAN,
    entitlement,
    usage,
    resource,
    delta,
    paywallEnabled(),
  );

  if (check.allowed) return null;

  return {
    status: 402,
    body: {
      error: `You have reached the ${resource} limit for your plan.`,
      code: 'LIMIT_REACHED',
      details: check,
    },
  };
}

/**
 * Entitlements — generic capacity-tier engine shared by every app on the platform.
 *
 * An app declares the resources it meters (Lineup: teams, games).
 * A tier grants integer limits per resource. Tiers scale 4x.
 * Paywall is a runtime flag, so launching free requires no code change.
 */

export type TierId = 'free' | 'club' | 'league' | 'region';

export interface Tier<R extends string = string> {
  id: TierId;
  name: string;
  /** One-time price in USD cents. 0 = free. */
  priceCents: number;
  limits: Record<R, number>;
}

export interface AppPlan<R extends string = string> {
  appId: string;
  resources: readonly R[];
  tiers: Record<TierId, Tier<R>>;
}

export interface Entitlement {
  appId: string;
  userId: string;
  tier: TierId;
  grantedAt: string;
  /** Optional per-user overrides, e.g. a comped league. */
  overrides?: Record<string, number>;
}

export type Usage<R extends string = string> = Partial<Record<R, number>>;

export interface LimitCheck {
  allowed: boolean;
  resource: string;
  used: number;
  limit: number;
  remaining: number;
  /** Tier that would satisfy the request, when denied. */
  upgradeTo?: TierId;
}

export const UNLIMITED = Number.MAX_SAFE_INTEGER;

/** Lineup's plan. 4x capacity per tier, 4x price. */
export type LineupResource = 'teams' | 'games';

export const LINEUP_PLAN: AppPlan<LineupResource> = {
  appId: 'lineup',
  resources: ['teams', 'games'],
  tiers: {
    free: {
      id: 'free',
      name: 'Free',
      priceCents: 0,
      limits: { teams: 1, games: 20 },
    },
    club: {
      id: 'club',
      name: 'Club',
      priceCents: 999,
      limits: { teams: 4, games: 80 },
    },
    league: {
      id: 'league',
      name: 'League',
      priceCents: 3999,
      limits: { teams: 16, games: 320 },
    },
    region: {
      id: 'region',
      name: 'Region',
      priceCents: 15999,
      limits: { teams: 64, games: 1280 },
    },
  },
};

export const TIER_ORDER: readonly TierId[] = ['free', 'club', 'league', 'region'];

/**
 * When PAYWALL_ENABLED is false every user is treated as top tier.
 * Launch free, flip the flag later without touching call sites.
 */
export function effectiveLimits<R extends string>(
  plan: AppPlan<R>,
  entitlement: Entitlement | null,
  paywallEnabled: boolean,
): Record<R, number> {
  if (!paywallEnabled) {
    return Object.fromEntries(plan.resources.map((r) => [r, UNLIMITED])) as Record<R, number>;
  }

  const tier = entitlement?.tier ?? 'free';
  const base = { ...plan.tiers[tier].limits };

  if (entitlement?.overrides) {
    for (const [resource, value] of Object.entries(entitlement.overrides)) {
      if (resource in base) {
        (base as Record<string, number>)[resource] = value;
      }
    }
  }
  return base;
}

/** Check whether `delta` more of `resource` is permitted. */
export function checkLimit<R extends string>(
  plan: AppPlan<R>,
  entitlement: Entitlement | null,
  usage: Usage<R>,
  resource: R,
  delta = 1,
  paywallEnabled = true,
): LimitCheck {
  const limits = effectiveLimits(plan, entitlement, paywallEnabled);
  const limit = limits[resource];
  const used = usage[resource] ?? 0;
  const allowed = used + delta <= limit;

  return {
    allowed,
    resource,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    upgradeTo: allowed ? undefined : nextTierFor(plan, resource, used + delta),
  };
}

/** Smallest tier whose limit satisfies `needed`. */
export function nextTierFor<R extends string>(
  plan: AppPlan<R>,
  resource: R,
  needed: number,
): TierId | undefined {
  return TIER_ORDER.find((id) => plan.tiers[id].limits[resource] >= needed);
}

export function formatPrice(cents: number): string {
  return cents === 0 ? 'Free' : `$${(cents / 100).toFixed(2)}`;
}

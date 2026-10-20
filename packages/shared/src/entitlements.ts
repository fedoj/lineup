/**
 * Entitlements — capacity tiers shared by every app on the platform.
 *
 * Two kinds of limit, because they behave differently:
 *
 *   ACCOUNT-SCOPED  counted once across everything you own (teams).
 *   PER-PARENT      counted within each parent record (games per team).
 *
 * Games are per-team: 10 games on each of your 2 free teams, not 10 shared
 * between them. Metering them account-wide would punish a coach for having a
 * second team, which is the opposite of what the free tier is for.
 *
 * Paywall is a runtime flag, so launching free requires no code change.
 */

export type TierId =
  | 'free'
  | 'coach'
  | 'parent'
  | 'referee'
  | 'region'
  | 'organization'
  | 'organizationPlus';

/**
 * Tier ids used before the October 2026 plan change. Stored rows and old
 * clients may still carry them, so they are mapped rather than rejected.
 * ('region' was retired into Organization on 10/9 and returned as its own
 * plan on 10/11; migration 016 had already moved every old region row.
 * Team parent was merged into Parent on 10/19: one plan for every parent.)
 */
export const LEGACY_TIER: Readonly<Record<string, TierId>> = {
  club: 'coach',
  league: 'organization',
  teamParent: 'parent',
};

/** Any stored tier value, current or legacy, as a current TierId. */
export function normalizeTier(raw: string | null | undefined): TierId {
  if (!raw) return 'free';
  if (raw in LEGACY_TIER) return LEGACY_TIER[raw];
  return (TIER_ORDER as readonly string[]).includes(raw) ? (raw as TierId) : 'free';
}

/** Features unlocked by tier, as opposed to quantities. */
export type Feature =
  | 'orgs'
  | 'regions'
  | 'customDivisions'
  | 'multiTeamAdmin'
  | 'crossTeamAnalytics'
  | 'customStats'
  /** Start and stop the match clock on match day. */
  | 'matchClock'
  /** Stats beyond goals, assists, yellow and red cards. */
  | 'fullStats'
  /**
   * Sharing (Fady, 10/19): lineup and stats pictures and calendar files, made
   * on the phone and never kept. The key keeps its old name so plans need no
   * migration.
   */
  | 'longShareLinks'
  /** Organization and region standings for roles below org and region staff. */
  | 'scopeStandings'
  | 'chatAttachments'
  /** Practice schedules longer than 100 days. */
  | 'extendedPractice'
  /** Recording practice attendance by hand rather than from check-ins. */
  | 'manualAttendance'
  /** A parent's view of their own child's stats. */
  | 'ownPlayerStats'
  /** Flyers attached to team events. */
  | 'eventFlyers'
  /** A family's view of their own child's overall rating. Rating players is free for coaches. */
  | 'playerEvaluation'
  /** Editing (10 minutes) and deleting your own team chat messages. */
  | 'chatEditing'
  /** Creating polls in team chat. Voting is free for everyone in the chat. */
  | 'chatPolls'
  /** "Add to my calendar" on a game, practice or event. */
  | 'addToCalendar'
  /** The running game clock on the referee's match screen. */
  | 'refereeClock'
  | 'adFree';

export interface Tier<R extends string = string> {
  id: TierId;
  name: string;
  /** Price per billing interval (see AppPlan.interval) in USD cents. 0 = free. */
  priceCents: number;
  /** Capacity per resource. */
  limits: Record<R, number>;
  /** Unlocked capabilities. */
  features: readonly Feature[];
  /** Shown on the pricing table. */
  blurb: string;
}

export type BillingInterval = 'year' | 'month';

export interface AppPlan<R extends string = string> {
  appId: string;
  /** How often a paid tier renews. Prices are quoted per interval. */
  interval: BillingInterval;
  resources: readonly R[];
  /** Resources counted inside each parent rather than across the account. */
  perParentResources: readonly R[];
  tiers: Record<TierId, Tier<R>>;
}

export interface Entitlement {
  appId: string;
  userId: string;
  tier: TierId;
  grantedAt: string;
  /** Optional per-user overrides, e.g. a comped league. */
  overrides?: Record<string, number>;
  /** Scope the plan attaches to; absent means a personal plan. */
  orgId?: string | null;
  regionId?: string | null;
  status?: 'active' | 'cancelled' | 'expired';
  /** Cancelled plans keep working until this moment. */
  accessUntil?: string | null;
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
  /** Set when the limit is counted inside a parent, e.g. games on one team. */
  scopedTo?: string;
}

export const UNLIMITED = Number.MAX_SAFE_INTEGER;

/* ------------------------------------------------------------- the plan */

export type LineupResource = 'teams' | 'gamesPerTeam' | 'playersPerTeam' | 'regions';

/** Everything an organization or region plan unlocks for its staff. */
const STAFF_FEATURES: readonly Feature[] = [
  'regions', 'customDivisions', 'multiTeamAdmin', 'crossTeamAnalytics',
  'customStats', 'matchClock', 'fullStats', 'longShareLinks', 'scopeStandings',
  'chatAttachments', 'extendedPractice', 'manualAttendance', 'ownPlayerStats',
  'eventFlyers', 'playerEvaluation', 'chatEditing', 'chatPolls', 'addToCalendar', 'refereeClock', 'adFree',
];

/** Teams and games a paid region holds; organization plans scale by region. */
const TEAMS_PER_REGION = 20;
const GAMES_PER_TEAM_PAID = 20;

export const LINEUP_PLAN: AppPlan<LineupResource> = {
  appId: 'lineup',
  interval: 'year',
  resources: ['teams', 'gamesPerTeam', 'playersPerTeam', 'regions'],
  perParentResources: ['gamesPerTeam', 'playersPerTeam'],
  tiers: {
    free: {
      id: 'free',
      name: 'Free',
      priceCents: 0,
      limits: { teams: 2, gamesPerTeam: 12, playersPerTeam: 30, regions: 0 },
      features: [],
      blurb: 'Up to 2 teams, 12 games each per season including friendlies.',
    },
    // One plan for every parent (Fady, 10/19: Parent and Team parent merged).
    // What a parent can do with it depends on their role on the team: a team
    // parent also adds flyers to the events they create and takes practice
    // attendance by hand.
    parent: {
      id: 'parent',
      name: 'Parent',
      priceCents: 499,
      limits: { teams: 2, gamesPerTeam: 12, playersPerTeam: 30, regions: 0 },
      features: [
        'ownPlayerStats', 'playerEvaluation', 'scopeStandings', 'chatAttachments', 'chatEditing',
        'chatPolls', 'addToCalendar', 'eventFlyers', 'manualAttendance', 'adFree',
      ],
      blurb:
        "For parents and team parents: your child's stats and player card, designing their avatar, organization and region standings, photos, polls and message editing in team chat, adding games and events to your calendar, and, as a team parent, flyers on your team events and practice attendance by hand.",
    },
    // Approved by Fady 10/15 at the Parent price. Referee sign-up and the
    // match screen are free; this adds the running game clock.
    referee: {
      id: 'referee',
      name: 'Referee',
      priceCents: 499,
      limits: { teams: 2, gamesPerTeam: 12, playersPerTeam: 30, regions: 0 },
      features: ['refereeClock', 'adFree'],
      blurb: 'For referees: the running game clock on the referee match screen, so subs, goals and cards are timed for you.',
    },
    // Six teams covers a busy club coach (typically two to four teams); 20
    // games per team matches league teams. The team cap also stops one paid
    // login being shared across a whole club.
    // Includes everything in Parent, so a subscribed coach who is also a
    // parent gets their own child's stats and player card without a second
    // plan (Fady, 10/19).
    coach: {
      id: 'coach',
      name: 'Coach',
      priceCents: 999,
      limits: { teams: 6, gamesPerTeam: GAMES_PER_TEAM_PAID, playersPerTeam: 40, regions: 0 },
      features: [
        'customDivisions', 'multiTeamAdmin', 'customStats', 'matchClock', 'fullStats',
        'longShareLinks', 'scopeStandings', 'chatAttachments', 'extendedPractice',
        'manualAttendance', 'eventFlyers', 'chatEditing', 'chatPolls', 'addToCalendar', 'adFree',
        'ownPlayerStats', 'playerEvaluation',
      ],
      blurb: "For coaches and assistant coaches: every paid team feature, 6 teams, 20 games each per season, plus your own child's stats and player card.",
    },
    // A standalone region, not part of any organization.
    region: {
      id: 'region',
      name: 'Region',
      priceCents: 19900,
      limits: { teams: TEAMS_PER_REGION, gamesPerTeam: GAMES_PER_TEAM_PAID, playersPerTeam: 60, regions: 1 },
      features: STAFF_FEATURES,
      blurb: 'One region on its own: every paid feature for its admins and directors, 20 teams, 20 games each per season.',
    },
    organization: {
      id: 'organization',
      name: 'Organization',
      priceCents: 29900,
      limits: { teams: 20 * TEAMS_PER_REGION, gamesPerTeam: GAMES_PER_TEAM_PAID, playersPerTeam: 60, regions: 20 },
      features: ['orgs', ...STAFF_FEATURES],
      blurb: 'Up to 20 regions with 20 teams each. Every paid feature for organization and region admins and directors, top down.',
    },
    organizationPlus: {
      id: 'organizationPlus',
      name: 'Organization Plus',
      priceCents: 49900,
      limits: { teams: 40 * TEAMS_PER_REGION, gamesPerTeam: GAMES_PER_TEAM_PAID, playersPerTeam: 60, regions: 40 },
      features: ['orgs', ...STAFF_FEATURES],
      blurb: 'Up to 40 regions with 20 teams each. Everything in Organization.',
    },
  },
};

/** Cheapest first, so upgrade prompts suggest the smallest plan that fits. */
export const TIER_ORDER: readonly TierId[] = [
  'free', 'parent', 'referee', 'coach', 'region', 'organization', 'organizationPlus',
];

/**
 * The paid plan a role would buy, for "Test as: Premium". Organization and
 * region staff test on Organization; everyone else on their own plan.
 */
export function premiumTierFor(role: string | null | undefined): TierId {
  switch (role) {
    case 'org_admin':
    case 'director':
    case 'region_admin':
      return 'organization';
    case 'parent':
    case 'player':
    case 'team_parent':
      return 'parent';
    default:
      return 'coach';
  }
}

/* -------------------------------------------------------------- queries */

export function isPerParent<R extends string>(plan: AppPlan<R>, resource: R): boolean {
  return plan.perParentResources.includes(resource);
}

export function tierFeatures(tier: TierId): readonly Feature[] {
  return LINEUP_PLAN.tiers[normalizeTier(tier)].features;
}

export function hasFeature(tier: TierId, feature: Feature, paywallEnabled = true): boolean {
  if (!paywallEnabled) return true;
  return LINEUP_PLAN.tiers[normalizeTier(tier)].features.includes(feature);
}

/** Smallest tier that includes a feature, for upgrade prompts. */
export function tierForFeature(feature: Feature): TierId | undefined {
  return TIER_ORDER.find((id) => LINEUP_PLAN.tiers[id].features.includes(feature));
}

/** A cancelled plan still works until accessUntil passes. */
export function isEntitlementLive(e: Entitlement | null, now = new Date()): boolean {
  if (!e) return false;
  if (e.status === 'expired') return false;
  if (e.status === 'cancelled') {
    return Boolean(e.accessUntil && new Date(e.accessUntil) > now);
  }
  return true;
}

/** Tier in force right now, accounting for cancellation. */
export function effectiveTier(e: Entitlement | null, now = new Date()): TierId {
  return isEntitlementLive(e, now) ? normalizeTier((e as Entitlement).tier) : 'free';
}

/**
 * When PAYWALL_ENABLED is false every user is treated as top tier.
 * Launch free, flip the flag later without touching call sites.
 */
export function effectiveLimits<R extends string>(
  plan: AppPlan<R>,
  entitlement: Entitlement | null,
  paywallEnabled: boolean,
  now = new Date(),
): Record<R, number> {
  if (!paywallEnabled) {
    return Object.fromEntries(plan.resources.map((r) => [r, UNLIMITED])) as Record<R, number>;
  }

  const tier = effectiveTier(entitlement, now);
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

/**
 * Check whether `delta` more of `resource` is permitted.
 *
 * For a per-parent resource, `usage` must already be scoped to that parent —
 * pass the game count for one team, not the account total.
 */
export function checkLimit<R extends string>(
  plan: AppPlan<R>,
  entitlement: Entitlement | null,
  usage: Usage<R>,
  resource: R,
  delta = 1,
  paywallEnabled = true,
  scopedTo?: string,
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
    scopedTo: isPerParent(plan, resource) ? scopedTo : undefined,
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

/** Price with its billing interval, e.g. "$9.99/yr". */
export function formatPlanPrice(plan: Pick<AppPlan, 'interval'>, cents: number): string {
  if (cents === 0) return formatPrice(cents);
  return `${formatPrice(cents)}/${plan.interval === 'year' ? 'yr' : 'mo'}`;
}

/**
 * Access control for Lineup.
 *
 * Two independent gates, both of which must pass:
 *
 *   1. ROLE  — does this user's membership grant the action at this scope?
 *   2. TIER  — is the feature included in the plan covering that scope?
 *
 * Keeping them separate matters: a free coach and a paid coach have the same
 * role but different feature surfaces, and an org_admin on a lapsed plan keeps
 * their role while losing the paid features.
 *
 * Pure functions only — no database, no I/O — so every branch is unit testable.
 */

import { hasFeature, type Feature, type TierId } from './entitlements.js';

/* ------------------------------------------------------------------ roles */

export type Role =
  | 'org_admin'
  | 'director'
  | 'region_admin'
  /**
   * Organization or region scheduler (Fady, 10/20): schedules and edits the
   * games of its existing leagues and tournaments, and manages field maps.
   * Nothing else: no leagues created, players placed, people invited or rosters.
   */
  | 'scheduler'
  | 'coach'
  | 'assistant'
  /** Team mom or manager: events, snack schedule and calendar, never match day. */
  | 'team_parent'
  | 'parent'
  | 'player'
  | 'viewer'
  /**
   * A custom role (Shadi, 10/21): made by organization or region staff, it
   * covers chosen teams (by age group or one by one) and grants only the
   * permissions picked for it. Never stored in membership: holders get
   * team-level memberships expanded from custom_role (see customRoles.ts).
   */
  | 'custom';

/**
 * Higher wins. Used only to compare two roles, never to imply capability.
 * A director (organization or region) is the top role at their level: they
 * rename it and invite the admins who help run it.
 */
export const ROLE_RANK: Record<Role, number> = {
  director: 70,
  org_admin: 60,
  region_admin: 50,
  scheduler: 45,
  custom: 44,
  coach: 40,
  assistant: 30,
  team_parent: 25,
  parent: 20,
  player: 15,
  viewer: 10,
};

/** Roles that only exist on a paid plan. Free teams can never mint these. */
export const PAID_ONLY_ROLES: readonly Role[] = ['org_admin', 'director', 'region_admin', 'scheduler'];

/** Family and spectator roles: they join teams by invite and never run one. */
export const FAMILY_ROLES: readonly Role[] = ['team_parent', 'parent', 'player', 'viewer'];

/**
 * True when every role someone holds is a family role, so they have no use
 * for creating teams or team and game limits. Nobody with no roles at all
 * counts: that is a new coach who has not created a team yet.
 */
export function isFamilyOnly(roles: readonly (Role | string | null | undefined)[]): boolean {
  return roles.length > 0 && roles.every((r) => (FAMILY_ROLES as readonly string[]).includes(String(r)));
}

export type Scope = 'org' | 'region' | 'division' | 'team';

export interface Membership {
  userId: string;
  role: Role;
  orgId?: string | null;
  regionId?: string | null;
  divisionId?: string | null;
  teamId?: string | null;
  /**
   * Custom roles only: exactly what this membership may do, replacing the
   * role's grants. Always team-level, so it never reaches the scope itself.
   */
  actions?: readonly Action[];
  /** Custom roles only: the role's name, for display. */
  customRoleName?: string | null;
}

/** Where a team sits in the hierarchy, as resolved from the database. */
export interface TeamContext {
  teamId: string;
  orgId: string;
  regionId?: string | null;
  divisionId?: string | null;
  /** In an organization or region, rather than a coach's standalone team. */
  inLeague?: boolean;
  /** Archived: read-only for everyone (see teamArchive.ts). */
  archived?: boolean;
}

/* ---------------------------------------------------------------- actions */

export type Action =
  // org / region / division management — paid surface
  | 'org.manage'
  | 'org.billing'
  | 'region.manage'
  /** Rename the organization or region: directors only, not admins. */
  | 'scope.rename'
  | 'division.manage'
  | 'member.invite'
  | 'member.manage'
  // team
  | 'team.create'
  | 'team.edit'
  | 'team.delete'
  | 'team.view'
  // roster
  | 'roster.edit'
  /** Add or remove players, as opposed to editing numbers and positions. */
  | 'roster.add'
  | 'roster.view'
  // games and lineups
  | 'game.create'
  | 'game.edit'
  | 'game.delete'
  | 'game.view'
  /** Schedule and edit games in an existing league or tournament (no creating or deleting them). */
  | 'fixture.schedule'
  /** Add, change and remove a region's fields and their maps. */
  | 'field.manage'
  | 'lineup.edit'
  | 'timer.run'
  // records
  | 'attendance.edit'
  | 'attendance.view'
  | 'stats.edit'
  | 'stats.view'
  | 'analytics.view'
  // team events (party, picture day, ...) and the snack schedule
  | 'event.create'
  | 'event.edit'
  | 'event.view'
  | 'snack.edit'
  | 'snack.view'
  | 'calendar.share'
  // player evaluation (premium): coaches and assistants rate, staff read
  | 'evaluation.edit'
  | 'evaluation.view'
  // data rights
  | 'data.export'
  | 'account.delete';

/**
 * What each role may do. Deliberately explicit rather than inherited: a parent
 * is not a weak coach, and writing the matrix out stops a future role change
 * from silently granting something.
 */
const TEAM_LIFE: readonly Action[] = [
  'event.create', 'event.edit', 'event.view', 'snack.edit', 'snack.view', 'calendar.share',
];

const ROLE_GRANTS: Record<Role, readonly Action[]> = {
  org_admin: [
    'org.manage', 'org.billing', 'region.manage', 'division.manage',
    'member.invite', 'member.manage',
    'team.create', 'team.edit', 'team.delete', 'team.view',
    'roster.edit', 'roster.add', 'roster.view',
    'game.create', 'game.edit', 'game.delete', 'game.view', 'fixture.schedule', 'field.manage',
    'lineup.edit', 'timer.run',
    'attendance.edit', 'attendance.view',
    'stats.edit', 'stats.view', 'analytics.view',
    ...TEAM_LIFE,
    'evaluation.view',
    'data.export', 'account.delete',
  ],
  director: [
    // At an organization: everything an org admin does, plus renaming and
    // billing. At a region: the region's top role.
    'org.manage', 'org.billing', 'scope.rename',
    'region.manage', 'division.manage', 'member.invite', 'member.manage',
    'team.create', 'team.edit', 'team.delete', 'team.view',
    'roster.edit', 'roster.add', 'roster.view',
    'game.create', 'game.edit', 'game.delete', 'game.view', 'fixture.schedule', 'field.manage',
    'lineup.edit', 'timer.run',
    'attendance.edit', 'attendance.view',
    'stats.edit', 'stats.view', 'analytics.view',
    ...TEAM_LIFE,
    'evaluation.view',
    'data.export', 'account.delete',
  ],
  region_admin: [
    'division.manage', 'member.invite',
    'team.create', 'team.edit', 'team.view',
    'roster.edit', 'roster.add', 'roster.view',
    'game.create', 'game.edit', 'game.view', 'fixture.schedule', 'field.manage',
    'lineup.edit', 'timer.run',
    'attendance.edit', 'attendance.view',
    'stats.edit', 'stats.view', 'analytics.view',
    ...TEAM_LIFE,
    'evaluation.view',
    'data.export',
  ],
  // Schedules the games of existing leagues and tournaments and keeps the field
  // maps; sees the teams and games it schedules, nothing else.
  scheduler: ['team.view', 'game.view', 'fixture.schedule', 'field.manage'],
  coach: [
    'member.invite',
    'team.edit', 'team.delete', 'team.view',
    'roster.edit', 'roster.add', 'roster.view',
    'game.create', 'game.edit', 'game.delete', 'game.view',
    'lineup.edit', 'timer.run',
    'attendance.edit', 'attendance.view',
    'stats.edit', 'stats.view', 'analytics.view',
    ...TEAM_LIFE,
    'evaluation.edit', 'evaluation.view',
    'data.export',
  ],
  // Assistant runs matchday but cannot change the roster or delete anything.
  assistant: [
    'team.view', 'roster.view',
    'game.create', 'game.edit', 'game.view',
    'lineup.edit', 'timer.run',
    'attendance.edit', 'attendance.view',
    'stats.edit', 'stats.view', 'analytics.view',
    ...TEAM_LIFE,
    'evaluation.edit', 'evaluation.view',
  ],
  // Team mom or manager: team events, the snack schedule and sharing the
  // calendar. Sees the schedule and the roster names, never match day.
  team_parent: ['team.view', 'roster.view', 'game.view', ...TEAM_LIFE],
  // Read-only, and further narrowed to linked children by canViewPlayer().
  parent: ['team.view', 'roster.view', 'game.view', 'attendance.view', 'stats.view', 'event.view', 'snack.view'],
  player: ['team.view', 'roster.view', 'game.view', 'stats.view', 'event.view', 'snack.view'],
  viewer: ['team.view', 'game.view', 'event.view'],
  // Grants come from the membership's own actions (see grantsOn).
  custom: [],
};

/* ------------------------------------------------------------------ tiers */

// The tier -> feature mapping lives in entitlements.ts so the pricing table
// and the permission check can never disagree.
export type PaidFeature = Feature;

/** Actions that are gated by plan as well as by role. */
const ACTION_REQUIRES_FEATURE: Partial<Record<Action, PaidFeature>> = {
  'org.manage': 'orgs',
  'org.billing': 'orgs',
  'region.manage': 'regions',
  'scope.rename': 'regions',
  'division.manage': 'customDivisions',
};

export function tierHasFeature(tier: TierId, feature: PaidFeature): boolean {
  return hasFeature(tier, feature);
}

/* -------------------------------------------------------------- resolution */

export interface AccessContext {
  userId: string;
  memberships: readonly Membership[];
  /** Tier of the plan covering the scope being accessed. */
  tier: TierId;
  /** When false every tier gate passes — lets the product launch free. */
  paywallEnabled: boolean;
  /** Player ids this user is a guardian of; required for parent/player roles. */
  guardianOf?: readonly string[];
  isPlatformAdmin?: boolean;
}

export interface Decision {
  allowed: boolean;
  reason?: 'no-membership' | 'role-denied' | 'upgrade-required' | 'not-guardian' | 'archived';
  /** Set when the block is commercial rather than permissional. */
  requiresFeature?: PaidFeature;
  matchedRole?: Role;
}

const ALLOW = (role: Role): Decision => ({ allowed: true, matchedRole: role });

/** Memberships that apply to a team, nearest scope first. */
export function membershipsForTeam(
  memberships: readonly Membership[],
  team: TeamContext,
): Membership[] {
  const matches = memberships.filter(
    (m) =>
      (m.teamId && m.teamId === team.teamId) ||
      (m.divisionId && m.divisionId === team.divisionId) ||
      (m.regionId && m.regionId === team.regionId) ||
      (m.orgId && m.orgId === team.orgId),
  );
  // Strongest role first so the first match is the effective one.
  return matches.sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role]);
}

export function roleGrants(role: Role, action: Action): boolean {
  return ROLE_GRANTS[role].includes(action);
}

/**
 * On a team in an organization or region, who is on the roster and who joins
 * the team is the league's call: only its staff add or remove players and
 * invite people. Coaches still do both on standalone teams they run.
 */
const LEAGUE_STAFF_ACTIONS: readonly Action[] = ['roster.add', 'member.invite'];
const LEAGUE_STAFF_ROLES: readonly Role[] = ['org_admin', 'director', 'region_admin'];

/** What still works on an archived team: looking, and downloading its data. */
export function isReadOnlyAction(action: Action): boolean {
  return action.endsWith('.view') || action === 'data.export';
}

/** Can this user perform `action` on `team`? */
export function canOnTeam(
  ctx: AccessContext,
  team: TeamContext,
  action: Action,
): Decision {
  const decision = canOnTeamIgnoringArchive(ctx, team, action);
  // An archived team is read-only for everyone, platform admins included.
  if (decision.allowed && team.archived && !isReadOnlyAction(action)) {
    return { allowed: false, reason: 'archived', matchedRole: decision.matchedRole };
  }
  return decision;
}

function canOnTeamIgnoringArchive(
  ctx: AccessContext,
  team: TeamContext,
  action: Action,
): Decision {
  if (ctx.isPlatformAdmin) return { allowed: true, matchedRole: 'org_admin' };

  const applicable = membershipsForTeam(ctx.memberships, team);
  if (applicable.length === 0) return { allowed: false, reason: 'no-membership' };

  const leagueOnly = team.inLeague && LEAGUE_STAFF_ACTIONS.includes(action);
  // A custom role's actions were handed down by league staff, so they count
  // as the league's call too.
  const granting = applicable.find((m) =>
    m.actions
      ? m.teamId === team.teamId && m.actions.includes(action)
      : roleGrants(m.role, action) && (!leagueOnly || LEAGUE_STAFF_ROLES.includes(m.role)),
  );
  if (!granting) {
    return { allowed: false, reason: 'role-denied', matchedRole: applicable[0].role };
  }

  const feature = ACTION_REQUIRES_FEATURE[action];
  if (feature && ctx.paywallEnabled && !tierHasFeature(ctx.tier, feature)) {
    return {
      allowed: false,
      reason: 'upgrade-required',
      requiresFeature: feature,
      matchedRole: granting.role,
    };
  }

  return ALLOW(granting.role);
}

/**
 * Can this user perform `action` at an org or region rather than on a team?
 * Resolves through the same memberships as canOnTeam: an org-scope membership
 * covers every region in it, while team-scope memberships never reach upward.
 */
export function canOnScope(
  ctx: AccessContext,
  scope: { orgId: string; regionId?: string | null },
  action: Action,
): Decision {
  return canOnTeam(
    ctx,
    { teamId: '', orgId: scope.orgId, regionId: scope.regionId ?? null, divisionId: null },
    action,
  );
}

/**
 * Parents and players see only their linked children. A parent membership with
 * no guardian link resolves to nothing, so the default is no visibility rather
 * than whole-team visibility.
 */
export function canViewPlayer(
  ctx: AccessContext,
  team: TeamContext,
  playerId: string,
): Decision {
  const base = canOnTeam(ctx, team, 'roster.view');
  if (!base.allowed) return base;

  const role = base.matchedRole;
  if (role === 'parent' || role === 'player') {
    const linked = ctx.guardianOf ?? [];
    if (!linked.includes(playerId)) {
      return { allowed: false, reason: 'not-guardian', matchedRole: role };
    }
  }
  return base;
}

/** Visible subset of a roster for the caller. */
export function visiblePlayerIds(
  ctx: AccessContext,
  team: TeamContext,
  allPlayerIds: readonly string[],
): string[] {
  const base = canOnTeam(ctx, team, 'roster.view');
  if (!base.allowed) return [];
  if (base.matchedRole === 'parent' || base.matchedRole === 'player') {
    const linked = new Set(ctx.guardianOf ?? []);
    return allPlayerIds.filter((id) => linked.has(id));
  }
  return [...allPlayerIds];
}

/**
 * Org and region management is a paid surface. A free user still has a hidden
 * personal org so foreign keys resolve, but may not act on it.
 */
export function canManageScope(ctx: AccessContext, scope: Scope): Decision {
  const action: Action =
    scope === 'org' ? 'org.manage'
    : scope === 'region' ? 'region.manage'
    : scope === 'division' ? 'division.manage'
    : 'team.edit';

  if (ctx.isPlatformAdmin) return { allowed: true, matchedRole: 'org_admin' };

  const holder = ctx.memberships
    .filter((m) => roleGrants(m.role, action))
    .sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role])[0];

  if (!holder) return { allowed: false, reason: 'role-denied' };

  const feature = ACTION_REQUIRES_FEATURE[action];
  if (feature && ctx.paywallEnabled && !tierHasFeature(ctx.tier, feature)) {
    return {
      allowed: false,
      reason: 'upgrade-required',
      requiresFeature: feature,
      matchedRole: holder.role,
    };
  }
  return ALLOW(holder.role);
}

/** Roles this user may hand out — never more than their own, never paid-only on free. */
export function assignableRoles(ctx: AccessContext, actorRole: Role): Role[] {
  const rank = ROLE_RANK[actorRole];
  return (Object.keys(ROLE_RANK) as Role[]).filter((r) => {
    // Custom roles are given from their own card, never through an invite role.
    if (r === 'custom') return false;
    if (ROLE_RANK[r] > rank) return false;
    if (PAID_ONLY_ROLES.includes(r) && ctx.paywallEnabled && !tierHasFeature(ctx.tier, 'orgs')) {
      return false;
    }
    return true;
  });
}

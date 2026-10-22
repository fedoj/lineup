/**
 * Custom roles (Shadi, 10/21). Organization or region staff make a role, pick
 * the teams it covers (whole age groups such as BU10, and/or single teams)
 * and the permissions it carries, then give it to people. Holders act only on
 * those teams and only within the chosen permissions; nothing at the
 * organization or region itself.
 */
import type { Action } from './access.js';

export type CustomPermission =
  | 'view'
  | 'schedule'
  | 'teams'
  | 'people'
  | 'matchday'
  | 'events'
  | 'ratings'
  | 'chats'
  | 'chatPhotos'
  | 'chatPolls';

export interface CustomPermissionInfo {
  key: CustomPermission;
  label: string;
  hint: string;
  actions: readonly Action[];
  /** Always on: a role that cannot see its teams makes no sense. */
  fixed?: boolean;
}

export const CUSTOM_PERMISSIONS: readonly CustomPermissionInfo[] = [
  {
    key: 'view',
    label: 'See their teams',
    hint: 'Rosters, games, calendars, attendance and stats.',
    actions: [
      'team.view', 'roster.view', 'game.view', 'event.view', 'snack.view',
      'attendance.view', 'stats.view', 'analytics.view',
    ],
    fixed: true,
  },
  {
    key: 'schedule',
    label: 'Schedule games',
    hint: 'Add games and change dates, times and fields.',
    actions: ['game.create', 'game.edit', 'fixture.schedule'],
  },
  {
    key: 'teams',
    label: 'Edit teams and rosters',
    hint: 'Team details, player numbers and positions, adding and removing players.',
    actions: ['team.edit', 'roster.edit', 'roster.add'],
  },
  {
    key: 'people',
    label: 'Invite people',
    hint: 'Invite coaches and families to their teams.',
    actions: ['member.invite'],
  },
  {
    key: 'matchday',
    label: 'Run match day',
    hint: 'Lineups, the game clock, stats and attendance.',
    actions: ['lineup.edit', 'timer.run', 'stats.edit', 'attendance.edit'],
  },
  {
    key: 'events',
    label: 'Team events and snacks',
    hint: 'Parties and picture days, the snack schedule, sharing the calendar.',
    actions: ['event.create', 'event.edit', 'snack.edit', 'calendar.share'],
  },
  {
    key: 'ratings',
    label: 'See player ratings',
    hint: 'Read the coaches\u2019 player evaluations.',
    actions: ['evaluation.view'],
  },
  {
    key: 'chats',
    label: 'Start chats',
    hint: 'Chats with people from their teams, by role.',
    actions: [],
  },
  // In chats only, free of a paid plan (Shadi, 10/22).
  {
    key: 'chatPhotos',
    label: 'Photos in chat',
    hint: 'Send photos in the chats they are in.',
    actions: [],
  },
  {
    key: 'chatPolls',
    label: 'Polls in chat',
    hint: 'Create polls in the chats they are in.',
    actions: [],
  },
];

const KEYS = new Set<string>(CUSTOM_PERMISSIONS.map((p) => p.key));

export function isCustomPermission(key: unknown): key is CustomPermission {
  return typeof key === 'string' && KEYS.has(key);
}

/** Every action a set of permissions grants. Seeing the teams is always included. */
export function customRoleActions(permissions: readonly string[]): Action[] {
  const out = new Set<Action>();
  for (const p of CUSTOM_PERMISSIONS) {
    if (p.fixed || permissions.includes(p.key)) for (const a of p.actions) out.add(a);
  }
  return [...out];
}

export const CUSTOM_ROLE_NAME_MAX = 40;
/** Plenty for any league, small enough to keep the access check cheap. */
export const CUSTOM_ROLE_TEAMS_MAX = 200;

const AGE_CODE_RE = /^[BGC]U\d{1,2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CustomRoleInput {
  name: string;
  permissions: CustomPermission[];
  /** Age group codes such as BU10: every team in that age group is covered. */
  divisions: string[];
  /** Single teams covered on their own. */
  teamIds: string[];
}

/** Tidy what the form sent, or say what is wrong with it. */
export function cleanCustomRole(input: {
  name?: unknown;
  permissions?: unknown;
  divisions?: unknown;
  teamIds?: unknown;
}): CustomRoleInput | { error: string } {
  const name = typeof input.name === 'string' ? input.name.replace(/\s+/g, ' ').trim() : '';
  if (!name) return { error: 'Give the role a name.' };
  if (name.length > CUSTOM_ROLE_NAME_MAX) {
    return { error: `Keep the name under ${CUSTOM_ROLE_NAME_MAX} characters.` };
  }
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const permissions = [...new Set(list(input.permissions).filter(isCustomPermission))].filter(
    (p) => p !== 'view',
  );
  const divisions = [...new Set(list(input.divisions).map((d) => d.trim().toUpperCase()))].filter((d) =>
    AGE_CODE_RE.test(d),
  );
  const teamIds = [...new Set(list(input.teamIds).map((t) => t.trim().toLowerCase()))].filter((t) =>
    UUID_RE.test(t),
  );
  if (!divisions.length && !teamIds.length) {
    return { error: 'Pick at least one age group or team for this role.' };
  }
  if (teamIds.length > CUSTOM_ROLE_TEAMS_MAX) return { error: 'That is too many single teams.' };
  return { name, permissions: permissions.sort(), divisions: divisions.sort(), teamIds };
}

/** "Schedule games, Run match day" for a role's summary line. */
export function customPermissionSummary(permissions: readonly string[]): string {
  const picked = CUSTOM_PERMISSIONS.filter((p) => !p.fixed && permissions.includes(p.key));
  return picked.length ? picked.map((p) => p.label).join(', ') : 'View only';
}

/**
 * Group chats (Shadi, 10/21). Organization and region staff, and people whose
 * custom role allows it, start a chat for people across teams: everyone with
 * the chosen roles on the chosen teams (whole age groups or single teams),
 * plus holders of chosen custom roles, plus the staff if picked. Membership
 * is worked out each time, so people who join those roles later are in. A
 * chat can have an end date, after which it is read-only and archived, and
 * can be archived or brought back by hand.
 */

/** Never parents: a group chat is for running the league (Shadi, 10/21). */
export type GroupChatRole = 'coach' | 'assistant' | 'team_parent' | 'staff';

export const GROUP_CHAT_ROLES: ReadonlyArray<{ key: GroupChatRole; label: string }> = [
  { key: 'coach', label: 'Coaches' },
  { key: 'assistant', label: 'Assistant coaches' },
  { key: 'team_parent', label: 'Team parents' },
  { key: 'staff', label: 'Organization and region staff' },
];

/** Membership roles counted as "staff" for a group chat. */
export const GROUP_CHAT_STAFF_ROLES: readonly string[] = ['org_admin', 'director', 'region_admin', 'scheduler'];

export const GROUP_CHAT_NAME_MAX = 60;
export const GROUP_CHAT_TEAMS_MAX = 300;

const ROLE_KEYS = new Set<string>(GROUP_CHAT_ROLES.map((r) => r.key));
const AGE_CODE_RE = /^[BGC]U\d{1,2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface GroupChatInput {
  name: string;
  roles: GroupChatRole[];
  /** Age groups (BU10...) whose teams are in; with no teams either, every team in scope. */
  divisions: string[];
  teamIds: string[];
  customRoleIds: string[];
  /** Last day of the chat (YYYY-MM-DD), or null for no end. */
  endsOn: string | null;
}

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** A YYYY-MM-DD date from today on, or null. Anything else is an error. */
export function cleanEndDate(v: unknown, today: string): string | null | { error: string } {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    return { error: 'Pick a valid end date.' };
  }
  if (v < today) return { error: 'The end date has already passed.' };
  return v;
}

/** Tidy what the form sent, or say what is wrong with it. `today` is YYYY-MM-DD. */
export function cleanGroupChat(
  input: { name?: unknown; roles?: unknown; divisions?: unknown; teamIds?: unknown; customRoleIds?: unknown; endsOn?: unknown },
  today: string,
): GroupChatInput | { error: string } {
  const name = typeof input.name === 'string' ? input.name.replace(/\s+/g, ' ').trim() : '';
  if (!name) return { error: 'Give the chat a name.' };
  if (name.length > GROUP_CHAT_NAME_MAX) return { error: `Keep the name under ${GROUP_CHAT_NAME_MAX} characters.` };
  const roles = [...new Set(list(input.roles))].filter((r): r is GroupChatRole => ROLE_KEYS.has(r));
  const customRoleIds = [...new Set(list(input.customRoleIds).map((s) => s.toLowerCase()))].filter((s) => UUID_RE.test(s));
  if (!roles.length && !customRoleIds.length) return { error: 'Pick who is in the chat.' };
  const divisions = [...new Set(list(input.divisions).map((d) => d.trim().toUpperCase()))].filter((d) => AGE_CODE_RE.test(d));
  const teamIds = [...new Set(list(input.teamIds).map((t) => t.trim().toLowerCase()))].filter((t) => UUID_RE.test(t));
  if (teamIds.length > GROUP_CHAT_TEAMS_MAX) return { error: 'That is too many teams.' };
  const endsOn = cleanEndDate(input.endsOn, today);
  if (endsOn && typeof endsOn === 'object') return endsOn;
  return { name, roles, divisions: divisions.sort(), teamIds, customRoleIds, endsOn };
}

/** Open for new messages: not archived, and its end date (a whole day) not passed. */
export function groupChatOpen(chat: { archivedAt?: string | null; endsOn?: string | null }, today: string): boolean {
  return !chat.archivedAt && (!chat.endsOn || chat.endsOn >= today);
}

/** "Coaches, Team parents and BU10 Director" for a chat's summary line. */
export function groupChatAudience(roles: readonly string[], customRoleNames: readonly string[] = []): string {
  const parts = [
    ...GROUP_CHAT_ROLES.filter((r) => roles.includes(r.key)).map((r) => r.label),
    // Only the default "Admins & directors" chat has this one.
    ...(roles.includes('admins') ? ['Admins and directors'] : []),
    ...customRoleNames,
  ];
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

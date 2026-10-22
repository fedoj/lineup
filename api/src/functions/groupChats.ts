import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import {
  CHAT_MAX_LENGTH,
  CHAT_PHOTOS_PER_SEND,
  CHAT_POLL_MAX_OPTIONS,
  CHAT_REACTIONS,
  CHAT_RETENTION_DAYS,
  GROUP_CHAT_STAFF_ROLES,
  canOnScope,
  cleanChatPoll,
  cleanChatVote,
  cleanEndDate,
  cleanGroupChat,
  groupChatAudience,
  groupChatOpen,
  parseChatImage,
  type AccessContext,
} from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { buildAccessContext } from '../lib/authz.js';
import { query, queryOne, transaction } from '../lib/db.js';
import { featureEnabled } from '../lib/entitlements.js';
import { outsideRequestScope } from '../lib/requestScope.js';
import { appToday } from '../lib/today.js';
import { loadPlace, teamsIn, type Place } from './customRoles.js';

/**
 * Group chats (Shadi, 10/21). See packages/shared/src/groupChat.ts for who is
 * in a chat. Organization and region staff (who can invite there) start
 * chats for their organization or region; someone whose custom role has
 * "Start group chats" starts them for that role's teams only. The person who
 * started a chat and the staff of its organization or region manage it:
 * rename it, set or clear the end date, archive or reopen it, delete it.
 *
 * GET               my chats, and whether I can start one
 * GET ?create=1     where I can start one: teams, age groups, custom roles
 * GET ?id=          one chat: its people and messages (marks it read)
 * POST { action: 'create' | 'send' | 'edit' | 'archive' | 'delete' | 'deleteMessage', ... }
 */

const FORBIDDEN: HttpResponseInit = {
  status: 403,
  jsonBody: { error: 'You do not have access to this.', code: 'FORBIDDEN' },
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGES_SHOWN = 200;
const MAX_CHATS_PER_SCOPE = 100;

/** A team (alias t) belongs to a group chat (alias gc). */
const TEAM_IN_CHAT = `
  (CASE WHEN gc.region_id IS NULL THEN t.org_id = gc.org_id ELSE t.region_id = gc.region_id END)
  AND ((cardinality(gc.team_ids) = 0 AND cardinality(gc.divisions) = 0)
       OR t.id = ANY(gc.team_ids)
       OR COALESCE(t.catalog_division_id, (SELECT d.code FROM division d WHERE d.id = t.division_id)) = ANY(gc.divisions))`;

/**
 * A membership (alias m) sits at the chat's level (Shadi, 10/21): an
 * organization chat reaches the organization's staff and every region's; a
 * region chat only that region's own.
 */
const LEVEL_OF_CHAT = `
  (CASE WHEN gc.region_id IS NULL
        THEN m.org_id = gc.org_id OR m.region_id IN (SELECT r.id FROM region r WHERE r.org_id = gc.org_id)
        ELSE m.region_id = gc.region_id END)`;

/** Staff ('staff' in a chat's roles): directors, admins and schedulers at its level. $2 is GROUP_CHAT_STAFF_ROLES. */
const STAFF_OF_CHAT = `m.role = ANY($2::text[]) AND ${LEVEL_OF_CHAT}`;

/** 'admins' in a chat's roles (the default "Admins & directors" chat): no schedulers. */
const ADMINS_OF_CHAT = `m.role IN ('org_admin', 'director', 'region_admin') AND ${LEVEL_OF_CHAT}`;

/** User $1 is in chat gc. $2 is GROUP_CHAT_STAFF_ROLES. */
const IS_MEMBER = `(
  gc.created_by = $1
  OR EXISTS (SELECT 1 FROM custom_role_member cm JOIN custom_role cr ON cr.id = cm.custom_role_id AND cr.deleted_at IS NULL
              WHERE cm.user_id = $1 AND cm.custom_role_id = ANY(gc.custom_role_ids))
  OR EXISTS (SELECT 1 FROM membership m JOIN team t ON t.id = m.team_id OR t.division_id = m.division_id
              WHERE m.user_id = $1 AND m.role = ANY(gc.roles) AND t.deleted_at IS NULL AND t.archived_at IS NULL
                AND ${TEAM_IN_CHAT})
  OR ('staff' = ANY(gc.roles) AND EXISTS (SELECT 1 FROM membership m WHERE m.user_id = $1 AND ${STAFF_OF_CHAT}))
  OR ('admins' = ANY(gc.roles) AND EXISTS (SELECT 1 FROM membership m WHERE m.user_id = $1 AND ${ADMINS_OF_CHAT})))`;

/** User $1 may be a manager of chat gc (confirmed with canOnScope). */
const MAY_MANAGE = `(
  gc.created_by = $1
  OR EXISTS (SELECT 1 FROM membership m WHERE m.user_id = $1 AND m.role IN ('org_admin', 'director', 'region_admin')
              AND (m.org_id = gc.org_id OR (gc.region_id IS NOT NULL AND m.region_id = gc.region_id))))`;

/** Everyone in chat $1 ($2 is GROUP_CHAT_STAFF_ROLES). */
const MEMBERS_SQL = `
  SELECT gc.created_by AS user_id FROM group_chat gc WHERE gc.id = $1 AND gc.created_by IS NOT NULL
  UNION
  SELECT cm.user_id FROM group_chat gc
    JOIN custom_role_member cm ON cm.custom_role_id = ANY(gc.custom_role_ids)
    JOIN custom_role cr ON cr.id = cm.custom_role_id AND cr.deleted_at IS NULL
   WHERE gc.id = $1
  UNION
  SELECT m.user_id FROM group_chat gc
    JOIN team t ON t.deleted_at IS NULL AND t.archived_at IS NULL AND ${TEAM_IN_CHAT}
    JOIN membership m ON (m.team_id = t.id OR m.division_id = t.division_id) AND m.role = ANY(gc.roles)
   WHERE gc.id = $1
  UNION
  SELECT m.user_id FROM group_chat gc JOIN membership m ON 'staff' = ANY(gc.roles) AND ${STAFF_OF_CHAT}
   WHERE gc.id = $1
  UNION
  SELECT m.user_id FROM group_chat gc JOIN membership m ON 'admins' = ANY(gc.roles) AND ${ADMINS_OF_CHAT}
   WHERE gc.id = $1`;

interface ChatRow {
  id: string;
  kind: 'custom' | 'staff' | 'admins';
  name: string;
  org_id: string;
  region_id: string | null;
  roles: string[];
  divisions: string[];
  team_ids: string[];
  custom_role_ids: string[];
  ends_on: string | null;
  archived_at: Date | null;
  created_by: string | null;
  org_name: string;
  org_personal: boolean;
  region_name: string | null;
}

const CHAT_COLUMNS = `gc.id, gc.kind, gc.name, gc.org_id, gc.region_id, gc.roles, gc.divisions, gc.team_ids, gc.custom_role_ids,
  gc.ends_on::text AS ends_on, gc.archived_at, gc.created_by,
  o.name AS org_name, o.is_personal AS org_personal, r.name AS region_name`;
const CHAT_FROM = `group_chat gc JOIN organization o ON o.id = gc.org_id LEFT JOIN region r ON r.id = gc.region_id`;

function scopeLabel(c: { org_name: string; org_personal: boolean; region_name: string | null }): string {
  if (!c.region_name) return c.org_name;
  return c.org_personal ? c.region_name : `${c.region_name} · ${c.org_name}`;
}

function personName(name: string | null, email: string | null): string {
  return name?.trim() || email?.split('@')[0] || 'Someone';
}

function groupKey(chatId: string): string {
  return `chat:g:${chatId}`;
}

/** Opens the chat on its organization's or region's Chats tab. */
function chatLink(chat: { id: string; org_id: string; region_id: string | null }): string {
  const where = chat.region_id ? `region=${chat.region_id}` : `org=${chat.org_id}`;
  return `/groups?${where}&focus=${chat.id}`;
}

function canManage(access: AccessContext, userId: string, c: ChatRow): boolean {
  return c.created_by === userId || canOnScope(access, { orgId: c.org_id, regionId: c.region_id }, 'member.invite').allowed;
}

async function customRoleNames(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await query<{ id: string; name: string }>('SELECT id, name FROM custom_role WHERE id = ANY($1::uuid[])', [ids]);
  return new Map(rows.map((r) => [r.id, r.name]));
}

function chatOut(c: ChatRow, names: Map<string, string>, today: string) {
  const endsOn = c.ends_on;
  const archivedAt = c.archived_at ? c.archived_at.toISOString() : null;
  return {
    id: c.id,
    kind: c.kind,
    // The Staff and Admins & directors chats every organization and region has.
    isDefault: c.kind !== 'custom',
    name: c.name,
    scope: c.region_id ? ('region' as const) : ('org' as const),
    scopeId: c.region_id ?? c.org_id,
    scopeLabel: scopeLabel(c),
    audience: groupChatAudience(c.roles, c.custom_role_ids.map((id) => names.get(id)).filter((n): n is string => Boolean(n))),
    roles: c.roles,
    divisions: c.divisions,
    teamCount: c.team_ids.length,
    endsOn,
    archivedAt,
    open: groupChatOpen({ archivedAt, endsOn }, today),
  };
}

/* --------------------------------------------------------- where to start one */

interface CreateOption {
  scope: 'org' | 'region';
  id: string;
  label: string;
  /** Staff pick any teams here; otherwise only the teams of the caller's custom roles. */
  staff: boolean;
  viaRoles: string[];
  ageGroups: string[];
  teams: Array<{ id: string; name: string; ageGroup: string | null; regionName: string | null }>;
  customRoles: Array<{ id: string; name: string }>;
}

/** Where the caller can start a chat; `only` ('org:<id>' or 'region:<id>') limits it to one place. */
async function createOptions(access: AccessContext, userId: string, only?: string): Promise<CreateOption[]> {
  const [places, held] = await Promise.all([
    query<{ kind: 'org' | 'region'; id: string; name: string; org_id: string; org_name: string; org_personal: boolean }>(
      `SELECT 'org' AS kind, o.id, o.name, o.id AS org_id, o.name AS org_name, o.is_personal AS org_personal
         FROM organization o
        WHERE o.deleted_at IS NULL AND NOT o.is_personal
          AND o.id IN (SELECT org_id FROM membership WHERE user_id = $1 AND org_id IS NOT NULL)
       UNION ALL
       SELECT 'region', r.id, r.name, r.org_id, o.name, o.is_personal
         FROM region r JOIN organization o ON o.id = r.org_id
        WHERE r.deleted_at IS NULL AND NOT r.is_personal AND o.deleted_at IS NULL
          AND (r.id IN (SELECT region_id FROM membership WHERE user_id = $1 AND region_id IS NOT NULL)
               OR r.org_id IN (SELECT org_id FROM membership WHERE user_id = $1 AND org_id IS NOT NULL))
        ORDER BY 3`,
      [userId],
    ),
    // Custom roles held with "Start group chats".
    query<{ id: string; name: string; org_id: string; region_id: string | null }>(
      `SELECT cr.id, cr.name, cr.org_id, cr.region_id
         FROM custom_role_member cm JOIN custom_role cr ON cr.id = cm.custom_role_id AND cr.deleted_at IS NULL
        WHERE cm.user_id = $1 AND 'chats' = ANY(cr.permissions)`,
      [userId],
    ),
  ]);

  const out: CreateOption[] = [];
  const staffKeys = new Set<string>();
  for (const p of places) {
    if (only && `${p.kind}:${p.id}` !== only) continue;
    const place: Place = {
      scope: p.kind,
      id: p.id,
      name: p.name,
      orgId: p.org_id,
      regionId: p.kind === 'region' ? p.id : null,
    };
    if (!canOnScope(access, { orgId: place.orgId, regionId: place.regionId }, 'member.invite').allowed) continue;
    staffKeys.add(`${p.kind}:${p.id}`);
    const [teams, roles] = await Promise.all([teamsIn(place), scopeCustomRoles(place)]);
    out.push({
      scope: p.kind,
      id: p.id,
      label: p.kind === 'org' ? `${p.name} (all regions)` : p.org_personal ? p.name : `${p.name} · ${p.org_name}`,
      staff: true,
      viaRoles: [],
      ageGroups: [...new Set(teams.map((t) => t.code).filter((c): c is string => Boolean(c)))].sort(),
      teams: teams.map((t) => ({ id: t.id, name: t.name, ageGroup: t.code, regionName: t.region_name })),
      customRoles: roles,
    });
  }

  // Custom role holders start chats for their role's teams, at the role's level.
  const byPlace = new Map<string, typeof held>();
  for (const h of held) {
    const key = h.region_id ? `region:${h.region_id}` : `org:${h.org_id}`;
    if (staffKeys.has(key) || (only && key !== only)) continue;
    byPlace.set(key, [...(byPlace.get(key) ?? []), h]);
  }
  for (const [key, roles] of byPlace) {
    const [scope, id] = key.split(':') as ['org' | 'region', string];
    const place = await loadPlace(scope, id);
    if (!place) continue;
    const teams = await customRoleTeams(roles.map((r) => r.id));
    out.push({
      scope,
      id,
      label: place.name,
      staff: false,
      viaRoles: roles.map((r) => r.name),
      ageGroups: [...new Set(teams.map((t) => t.ageGroup).filter((c): c is string => Boolean(c)))].sort(),
      teams,
      customRoles: roles.map((r) => ({ id: r.id, name: r.name })),
    });
  }
  return out;
}

/** Custom roles whose people can be put in a chat at this organization or region. */
async function scopeCustomRoles(place: Place) {
  return query<{ id: string; name: string }>(
    `SELECT id, name FROM custom_role
      WHERE deleted_at IS NULL
        AND ${place.scope === 'org' ? 'org_id = $1' : '(region_id = $1 OR (region_id IS NULL AND org_id = $2))'}
      ORDER BY lower(name)`,
    place.scope === 'org' ? [place.orgId] : [place.id, place.orgId],
  );
}

/** The teams some custom roles cover today. */
async function customRoleTeams(roleIds: string[]) {
  const rows = await query<{ id: string; name: string; code: string | null; region_name: string | null }>(
    `SELECT DISTINCT t.id, t.name, COALESCE(t.catalog_division_id, d.code) AS code, r.name AS region_name
       FROM custom_role cr
       JOIN team t ON t.deleted_at IS NULL
        AND (CASE WHEN cr.region_id IS NULL THEN t.org_id = cr.org_id ELSE t.region_id = cr.region_id END)
       LEFT JOIN division d ON d.id = t.division_id
       LEFT JOIN region r ON r.id = t.region_id AND NOT r.is_personal
      WHERE cr.id = ANY($1::uuid[]) AND cr.deleted_at IS NULL
        AND (t.id = ANY(cr.team_ids) OR COALESCE(t.catalog_division_id, d.code) = ANY(cr.divisions))
      ORDER BY code NULLS LAST, t.name`,
    [roleIds],
  );
  return rows.map((t) => ({ id: t.id, name: t.name, ageGroup: t.code, regionName: t.region_name }));
}

/* ------------------------------------------------------------- notifications */

/** New messages: one bell entry per person and chat while unread, pushed like team chat. */
async function notifyChat(chat: ChatRow, senderId: string, senderName: string, preview: string): Promise<void> {
  const text = preview.replace(/\s+/g, ' ').trim();
  const body = text.length > 120 ? `${text.slice(0, 117)}…` : text;
  await query(
    `WITH r AS (
       SELECT DISTINCT x.user_id FROM (${MEMBERS_SQL}) x
         JOIN app_user u ON u.id = x.user_id AND u.deleted_at IS NULL
        WHERE x.user_id <> $3
     ),
     latest AS (
       SELECT DISTINCT ON (n.user_id) n.id, n.user_id, n.read_at
         FROM notification n JOIN r ON r.user_id = n.user_id
        WHERE n.group_key = $7
        ORDER BY n.user_id, n.created_at DESC
     ),
     upd AS (
       UPDATE notification n
          SET batch = CASE WHEN l.read_at IS NULL THEN n.batch + 1 ELSE 1 END,
              title = $4,
              body = CASE WHEN l.read_at IS NULL THEN n.body ELSE $5 END,
              from_name = CASE WHEN l.read_at IS NULL THEN n.from_name ELSE $8 END,
              read_at = NULL,
              created_at = now(),
              pushed_at = NULL
         FROM latest l
        WHERE n.id = l.id
        RETURNING n.user_id
     )
     INSERT INTO notification (user_id, kind, title, body, link, group_key, from_name)
     SELECT r.user_id, 'message', $4, $5, $6, $7, $8 FROM r
      WHERE NOT EXISTS (SELECT 1 FROM latest l WHERE l.user_id = r.user_id)
     ON CONFLICT (user_id, group_key) WHERE read_at IS NULL AND group_key IS NOT NULL
     DO UPDATE SET batch = notification.batch + 1, created_at = now(), pushed_at = NULL`,
    [chat.id, GROUP_CHAT_STAFF_ROLES, senderId, `New messages in ${chat.name}`, body, chatLink(chat), groupKey(chat.id), senderName],
  );
}

/* ------------------------------------------------------------------ handler */

const lastPrune = new Map<string, number>();

function pruneOldMessages(chatId: string): void {
  const now = Date.now();
  if (now - (lastPrune.get(chatId) ?? 0) < 60 * 60_000) return;
  lastPrune.set(chatId, now);
  // Messages are kept for 90 days, like team chat.
  void outsideRequestScope(() =>
    query(`DELETE FROM group_chat_message WHERE chat_id = $1 AND created_at < now() - make_interval(days => $2)`, [
      chatId,
      CHAT_RETENTION_DAYS,
    ]),
  ).catch(() => lastPrune.delete(chatId));
}

async function loadChat(id: unknown): Promise<ChatRow | null> {
  if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
  return (await queryOne<ChatRow>(`SELECT ${CHAT_COLUMNS} FROM ${CHAT_FROM} WHERE gc.id = $1`, [id])) ?? null;
}

async function isMember(chatId: string, userId: string): Promise<boolean> {
  return Boolean(
    await queryOne(`SELECT 1 FROM group_chat gc WHERE gc.id = $3 AND ${IS_MEMBER}`, [userId, GROUP_CHAT_STAFF_ROLES, chatId]),
  );
}

/**
 * Photos and polls (Shadi, 10/22), as in team chat: free for everyone in the
 * Staff and Admins & directors chats; elsewhere a paid plan, or a custom role
 * in that organization that allows them.
 */
async function chatPerks(userId: string, chat: ChatRow): Promise<{ canPhoto: boolean; canPoll: boolean }> {
  if (chat.kind !== 'custom') return { canPhoto: true, canPoll: true };
  const [photos, polls, role] = await Promise.all([
    featureEnabled(userId, 'chatAttachments'),
    featureEnabled(userId, 'chatPolls'),
    queryOne<{ photos: boolean; polls: boolean }>(
      `SELECT bool_or('chatPhotos' = ANY(cr.permissions)) AS photos, bool_or('chatPolls' = ANY(cr.permissions)) AS polls
         FROM custom_role_member cm JOIN custom_role cr ON cr.id = cm.custom_role_id AND cr.deleted_at IS NULL
        WHERE cm.user_id = $1 AND cr.org_id = $2`,
      [userId, chat.org_id],
    ),
  ]);
  return { canPhoto: photos || Boolean(role?.photos), canPoll: polls || Boolean(role?.polls) };
}

function imageUrl(messageId: string): string {
  return `/api/group-chats/image?id=${messageId}`;
}

/** Can this person write in the chat right now (in it, or managing it, and it is open)? */
async function writable(userId: string, chat: ChatRow, manage: boolean, today: string): Promise<HttpResponseInit | null> {
  if (!manage && !(await isMember(chat.id, userId))) return FORBIDDEN;
  if (!groupChatOpen({ archivedAt: chat.archived_at?.toISOString() ?? null, endsOn: chat.ends_on }, today)) {
    return { status: 409, jsonBody: { error: 'This chat has ended, so it is read-only.', code: 'CHAT_CLOSED' } };
  }
  return null;
}

/** Bump the chat to the top of the list and mark it read for the sender. */
async function afterPost(chat: ChatRow, userId: string): Promise<void> {
  await Promise.all([
    query('UPDATE group_chat SET last_message_at = now() WHERE id = $1', [chat.id]),
    query(
      `INSERT INTO group_chat_read (chat_id, user_id) VALUES ($1, $2)
       ON CONFLICT (chat_id, user_id) DO UPDATE SET read_at = now()`,
      [chat.id, userId],
    ),
  ]);
}

export async function groupChatsHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    const access = await buildAccessContext(user);
    const today = appToday();
    const noStore = { 'Cache-Control': 'no-store' };

    if (req.method === 'GET') {
      // The organization or region whose Chats tab is open (Shadi, 10/21: chats
      // live at the level they were made).
      const scope = req.query.get('scope');
      const scopeId = req.query.get('id') ?? '';
      const only = (scope === 'org' || scope === 'region') && UUID_RE.test(scopeId) ? `${scope}:${scopeId}` : undefined;

      if (req.query.get('create')) {
        return { status: 200, headers: noStore, jsonBody: { options: await createOptions(access, user.id, only) } };
      }

      const chatId = req.query.get('chat') ?? (only ? null : req.query.get('id'));
      if (chatId) {
        const chat = await loadChat(chatId);
        if (!chat) return FORBIDDEN;
        const member = await isMember(chat.id, user.id);
        const manage = canManage(access, user.id, chat);
        if (!member && !manage) return FORBIDDEN;
        pruneOldMessages(chat.id);
        const [names, people, messages, perks] = await Promise.all([
          customRoleNames(chat.custom_role_ids),
          query<{ id: string; display_name: string | null; email: string | null }>(
            `SELECT u.id, u.display_name, u.email FROM (${MEMBERS_SQL}) x
               JOIN app_user u ON u.id = x.user_id AND u.deleted_at IS NULL
              ORDER BY lower(COALESCE(u.display_name, u.email))`,
            [chat.id, GROUP_CHAT_STAFF_ROLES],
          ),
          query<{
            id: string;
            user_id: string | null;
            kind: 'message' | 'system' | 'poll';
            body: string;
            created_at: Date;
            has_image: boolean;
            display_name: string | null;
            email: string | null;
          }>(
            `SELECT * FROM (
               SELECT m.id, m.user_id, m.kind, m.body, m.created_at, (m.image_mime IS NOT NULL) AS has_image,
                      u.display_name, u.email
                 FROM group_chat_message m LEFT JOIN app_user u ON u.id = m.user_id
                WHERE m.chat_id = $1
                ORDER BY m.created_at DESC LIMIT $2) x
             ORDER BY created_at`,
            [chat.id, MESSAGES_SHOWN],
          ),
          chatPerks(user.id, chat),
        ]);
        const ids = messages.map((m) => m.id);
        const pollIds = messages.filter((m) => m.kind === 'poll').map((m) => m.id);
        const [reactions, polls, votes] = await Promise.all([
          ids.length
            ? query<{ message_id: string; emoji: string; n: number; mine: boolean }>(
                `SELECT message_id, emoji, COUNT(*)::int AS n, bool_or(user_id = $2) AS mine
                   FROM group_chat_reaction WHERE message_id = ANY($1::uuid[])
                  GROUP BY message_id, emoji ORDER BY emoji`,
                [ids, user.id],
              )
            : Promise.resolve([]),
          pollIds.length
            ? query<{ message_id: string; options: string[]; multi: boolean; closed_at: Date | null }>(
                'SELECT message_id, options, multi, closed_at FROM group_chat_poll WHERE message_id = ANY($1::uuid[])',
                [pollIds],
              )
            : Promise.resolve([]),
          pollIds.length
            ? query<{ message_id: string; user_id: string; option_no: number; display_name: string | null; email: string | null }>(
                `SELECT v.message_id, v.user_id, v.option_no, u.display_name, u.email
                   FROM group_chat_poll_vote v JOIN app_user u ON u.id = v.user_id
                  WHERE v.message_id = ANY($1::uuid[])
                  ORDER BY v.voted_at`,
                [pollIds],
              )
            : Promise.resolve([]),
        ]);
        // Opening the chat reads it, in the list and in the bell.
        await Promise.all([
          query(
            `INSERT INTO group_chat_read (chat_id, user_id) VALUES ($1, $2)
             ON CONFLICT (chat_id, user_id) DO UPDATE SET read_at = now()`,
            [chat.id, user.id],
          ),
          query('UPDATE notification SET read_at = now() WHERE user_id = $1 AND group_key = $2 AND read_at IS NULL', [
            user.id,
            groupKey(chat.id),
          ]),
        ]);
        const out = chatOut(chat, names, today);
        const pollFor = (m: (typeof messages)[number]) => {
          const p = polls.find((x) => x.message_id === m.id);
          if (!p) return null;
          const these = votes.filter((v) => v.message_id === m.id);
          return {
            options: p.options.map((text, i) => {
              const on = these.filter((v) => v.option_no === i);
              return {
                text,
                votes: on.length,
                voters: on.map((v) => (v.user_id === user.id ? 'You' : personName(v.display_name, v.email))),
                mine: on.some((v) => v.user_id === user.id),
              };
            }),
            multi: p.multi,
            closed: Boolean(p.closed_at),
            voters: new Set(these.map((v) => v.user_id)).size,
            canClose: !p.closed_at && (m.user_id === user.id || manage),
          };
        };
        return {
          status: 200,
          headers: noStore,
          jsonBody: {
            chat: {
              ...out,
              member,
              canManage: manage,
              canPost: out.open && (member || manage),
              canPhoto: perks.canPhoto,
              canPoll: perks.canPoll,
              people: people.map((p) => ({ id: p.id, name: personName(p.display_name, p.email) })),
            },
            maxLength: CHAT_MAX_LENGTH,
            reactions: CHAT_REACTIONS,
            pollMaxOptions: CHAT_POLL_MAX_OPTIONS,
            photosPerSend: CHAT_PHOTOS_PER_SEND,
            messages: messages.map((m) => ({
              id: m.id,
              kind: m.kind,
              author: personName(m.display_name, m.email),
              mine: m.user_id === user.id,
              body: m.body,
              image: m.has_image ? { url: imageUrl(m.id) } : null,
              createdAt: m.created_at.toISOString(),
              reactions: reactions
                .filter((x) => x.message_id === m.id)
                .map((x) => ({ emoji: x.emoji, count: x.n, mine: x.mine })),
              poll: m.kind === 'poll' ? pollFor(m) : null,
              canDelete: m.kind !== 'system' && (m.user_id === user.id || manage),
            })),
          },
        };
      }

      // Every organization and region has a Staff chat and an Admins &
      // directors chat (Shadi, 10/22), made the first time its tab opens.
      if (only) {
        const here = await loadPlace(scope, scopeId);
        if (here) {
          await query(
            `INSERT INTO group_chat (org_id, region_id, name, roles, kind)
             VALUES ($1, $2, 'Staff', '{staff}', 'staff'), ($1, $2, 'Admins & directors', '{admins}', 'admins')
             ON CONFLICT DO NOTHING`,
            [here.orgId, here.regionId],
          );
        }
      }

      const rows = await query<
        ChatRow & {
          is_member: boolean;
          unread: number;
          last_body: string | null;
          last_at: Date | null;
          last_name: string | null;
          last_email: string | null;
          last_kind: string | null;
        }
      >(
        `SELECT ${CHAT_COLUMNS}, COALESCE(${IS_MEMBER}, false) AS is_member,
                (SELECT COUNT(*) FROM group_chat_message msg
                  WHERE msg.chat_id = gc.id AND msg.kind = 'message' AND msg.user_id IS DISTINCT FROM $1
                    AND msg.created_at > COALESCE((SELECT rd.read_at FROM group_chat_read rd
                                                    WHERE rd.chat_id = gc.id AND rd.user_id = $1), gc.created_at))::int AS unread,
                CASE WHEN lm.body = '' AND lm.has_image THEN '📷 Photo' WHEN lm.kind = 'poll' THEN '📊 ' || lm.body ELSE lm.body END AS last_body,
                lm.created_at AS last_at, lm.kind AS last_kind,
                lu.display_name AS last_name, lu.email AS last_email
           FROM ${CHAT_FROM}
           LEFT JOIN LATERAL (SELECT body, created_at, user_id, kind, (image_mime IS NOT NULL) AS has_image FROM group_chat_message
                               WHERE chat_id = gc.id ORDER BY created_at DESC LIMIT 1) lm ON true
           LEFT JOIN app_user lu ON lu.id = lm.user_id
          WHERE o.deleted_at IS NULL AND (${IS_MEMBER} OR ${MAY_MANAGE})
            AND ($3::text IS NULL
                 OR ($3::text = 'org' AND gc.org_id = $4::uuid AND gc.region_id IS NULL)
                 OR ($3::text = 'region' AND gc.region_id = $4::uuid))
          ORDER BY gc.last_message_at DESC
          LIMIT 300`,
        [user.id, GROUP_CHAT_STAFF_ROLES, only ? scope : null, only ? scopeId : null],
      );
      const place = only ? await loadPlace(scope, scopeId) : null;
      const [names, options] = await Promise.all([
        customRoleNames([...new Set(rows.flatMap((r) => r.custom_role_ids))]),
        // Whether to offer "New group chat" (the details load when it is tapped):
        // here, its staff or a custom role made here that may start chats.
        place
          ? canOnScope(access, { orgId: place.orgId, regionId: place.regionId }, 'member.invite').allowed
            ? Promise.resolve([{ n: 1 }])
            : query<{ n: number }>(
                `SELECT COUNT(*)::int AS n FROM custom_role_member cm JOIN custom_role cr ON cr.id = cm.custom_role_id
                  WHERE cm.user_id = $1 AND cr.deleted_at IS NULL AND 'chats' = ANY(cr.permissions)
                    AND ${place.regionId ? 'cr.region_id = $2' : 'cr.org_id = $2 AND cr.region_id IS NULL'}`,
                [user.id, place.id],
              )
          : query<{ n: number }>(
              `SELECT ((SELECT COUNT(*) FROM membership WHERE user_id = $1
                         AND role IN ('org_admin', 'director', 'region_admin'))
                     + (SELECT COUNT(*) FROM custom_role_member cm JOIN custom_role cr ON cr.id = cm.custom_role_id
                         WHERE cm.user_id = $1 AND cr.deleted_at IS NULL AND 'chats' = ANY(cr.permissions)))::int AS n`,
              [user.id],
            ),
      ]);
      const chats = rows
        .map((r) => {
          const manage = canManage(access, user.id, r);
          if (!r.is_member && !manage) return null;
          return {
            ...chatOut(r, names, today),
            member: r.is_member,
            canManage: manage,
            unread: r.is_member ? r.unread : 0,
            last: r.last_at
              ? {
                  author: r.last_kind === 'system' ? null : personName(r.last_name, r.last_email),
                  body: (r.last_body ?? '').slice(0, 140),
                  at: r.last_at.toISOString(),
                }
              : null,
          };
        })
        .filter((c): c is NonNullable<typeof c> => c !== null);
      return { status: 200, headers: noStore, jsonBody: { canCreate: (options[0]?.n ?? 0) > 0, chats } };
    }

    const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    const me = await queryOne<{ display_name: string | null; email: string | null }>(
      'SELECT display_name, email FROM app_user WHERE id = $1',
      [user.id],
    );
    const myName = personName(me?.display_name ?? null, me?.email ?? null);

    if (body.action === 'create') {
      const options = await createOptions(access, user.id);
      const opt = options.find((o) => o.scope === body.scope && o.id === body.id);
      if (!opt) return FORBIDDEN;
      const clean = cleanGroupChat(body, today);
      if ('error' in clean) return { status: 400, jsonBody: { error: clean.error } };
      const offered = new Set(opt.teams.map((t) => t.id));
      let teamIds = clean.teamIds.filter((t) => offered.has(t));
      let divisions = clean.divisions;
      if (!opt.staff) {
        // Only the role's own teams, written out, so the chat never grows past them.
        const fromAges = opt.teams.filter((t) => t.ageGroup && divisions.includes(t.ageGroup)).map((t) => t.id);
        teamIds = [...new Set([...teamIds, ...fromAges])];
        if (!teamIds.length) teamIds = opt.teams.map((t) => t.id);
        divisions = [];
        if (!teamIds.length) return { status: 400, jsonBody: { error: 'Your role has no teams yet.' } };
      }
      const roleIds = new Set(opt.customRoles.map((r) => r.id));
      const customRoleIds = clean.customRoleIds.filter((r) => roleIds.has(r));
      if (!clean.roles.length && !customRoleIds.length) return { status: 400, jsonBody: { error: 'Pick who is in the chat.' } };
      const place = await loadPlace(opt.scope, opt.id);
      if (!place) return FORBIDDEN;
      const count = await queryOne<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM group_chat WHERE ${place.regionId ? 'region_id = $1' : 'org_id = $1 AND region_id IS NULL'}
            AND archived_at IS NULL`,
        [place.id],
      );
      if ((count?.n ?? 0) >= MAX_CHATS_PER_SCOPE) {
        return { status: 400, jsonBody: { error: `Up to ${MAX_CHATS_PER_SCOPE} open group chats here. Archive some first.` } };
      }
      const row = await queryOne<{ id: string }>(
        `INSERT INTO group_chat (org_id, region_id, name, roles, divisions, team_ids, custom_role_ids, ends_on, created_by)
         VALUES ($1,$2,$3,$4,$5,$6::uuid[],$7::uuid[],$8,$9) RETURNING id`,
        [place.orgId, place.regionId, clean.name, clean.roles, divisions, teamIds, customRoleIds, clean.endsOn, user.id],
      );
      if (!row) return { status: 500, jsonBody: { error: 'Internal error' } };
      await query(`INSERT INTO group_chat_message (chat_id, user_id, kind, body) VALUES ($1, $2, 'system', $3)`, [
        row.id,
        user.id,
        `${myName} started this chat`,
      ]);
      const members = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM (${MEMBERS_SQL}) x`, [
        row.id,
        GROUP_CHAT_STAFF_ROLES,
      ]);
      return { status: 201, jsonBody: { id: row.id, people: members?.n ?? 0 } };
    }

    if (body.action === 'deleteMessage') {
      if (typeof body.messageId !== 'string' || !UUID_RE.test(body.messageId)) return FORBIDDEN;
      const m = await queryOne<{ chat_id: string; user_id: string | null; kind: string }>(
        'SELECT chat_id, user_id, kind FROM group_chat_message WHERE id = $1',
        [body.messageId],
      );
      const chat = m ? await loadChat(m.chat_id) : null;
      if (!m || !chat || m.kind === 'system') return FORBIDDEN;
      if (m.user_id !== user.id && !canManage(access, user.id, chat)) return FORBIDDEN;
      await query('DELETE FROM group_chat_message WHERE id = $1', [body.messageId]);
      return { status: 200, jsonBody: { ok: true } };
    }

    // Reacting, voting and closing a poll work on one message.
    if (body.action === 'react' || body.action === 'vote' || body.action === 'closePoll') {
      if (typeof body.messageId !== 'string' || !UUID_RE.test(body.messageId)) return FORBIDDEN;
      const m = await queryOne<{ id: string; chat_id: string; user_id: string | null; kind: string }>(
        'SELECT id, chat_id, user_id, kind FROM group_chat_message WHERE id = $1',
        [body.messageId],
      );
      const chat = m ? await loadChat(m.chat_id) : null;
      if (!m || !chat || m.kind === 'system') return FORBIDDEN;
      const manage = canManage(access, user.id, chat);
      const blocked = await writable(user.id, chat, manage, today);
      if (blocked) return blocked;

      if (body.action === 'react') {
        const emoji = String(body.emoji ?? '');
        if (!CHAT_REACTIONS.includes(emoji)) return { status: 400, jsonBody: { error: 'Pick one of the reactions.' } };
        const removed = await queryOne(
          'DELETE FROM group_chat_reaction WHERE message_id = $1 AND user_id = $2 AND emoji = $3 RETURNING emoji',
          [m.id, user.id, emoji],
        );
        if (!removed) {
          await query(
            'INSERT INTO group_chat_reaction (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [m.id, user.id, emoji],
          );
        }
        return { status: 200, jsonBody: { ok: true } };
      }

      const p = await queryOne<{ options: string[]; multi: boolean; closed_at: Date | null }>(
        'SELECT options, multi, closed_at FROM group_chat_poll WHERE message_id = $1',
        [m.id],
      );
      if (m.kind !== 'poll' || !p) return { status: 400, jsonBody: { error: 'That message is not a poll.' } };
      if (p.closed_at) return { status: 409, jsonBody: { error: 'This poll is closed.', code: 'POLL_CLOSED' } };
      if (body.action === 'closePoll') {
        if (m.user_id !== user.id && !manage) return FORBIDDEN;
        await query('UPDATE group_chat_poll SET closed_at = now(), closed_by = $2 WHERE message_id = $1', [m.id, user.id]);
        return { status: 200, jsonBody: { ok: true } };
      }
      // Voting is free for everyone in the chat; a vote replaces the last one.
      const picked = cleanChatVote(body.choices, { options: p.options.length, multi: p.multi });
      if ('error' in picked) return { status: 400, jsonBody: { error: picked.error } };
      await query(
        `WITH gone AS (
           DELETE FROM group_chat_poll_vote
            WHERE message_id = $1 AND user_id = $2 AND NOT (option_no = ANY($3::smallint[]))
         )
         INSERT INTO group_chat_poll_vote (message_id, user_id, option_no)
         SELECT $1, $2, n FROM unnest($3::smallint[]) AS n
         ON CONFLICT (message_id, user_id, option_no) DO NOTHING`,
        [m.id, user.id, picked],
      );
      return { status: 200, jsonBody: { ok: true, choices: picked } };
    }

    const chat = await loadChat(body.chatId);
    if (!chat) return FORBIDDEN;
    const manage = canManage(access, user.id, chat);

    if (body.action === 'send') {
      const text = typeof body.body === 'string' ? body.body.trim() : '';
      // Up to CHAT_PHOTOS_PER_SEND photos at once, each its own message; the
      // caption goes with the first.
      const rawImages = Array.isArray(body.images) ? body.images : [];
      if (rawImages.length > CHAT_PHOTOS_PER_SEND) {
        return { status: 400, jsonBody: { error: `Send up to ${CHAT_PHOTOS_PER_SEND} photos at a time.` } };
      }
      const images: Array<{ mime: string; base64: string }> = [];
      for (const raw of rawImages) {
        const image = parseChatImage(raw);
        if (image && 'error' in image) return { status: 400, jsonBody: { error: image.error } };
        if (image) images.push(image);
      }
      if (!text && !images.length) return { status: 400, jsonBody: { error: 'Write a message first.' } };
      if (text.length > CHAT_MAX_LENGTH) return { status: 400, jsonBody: { error: `Keep it under ${CHAT_MAX_LENGTH} characters.` } };
      const blocked = await writable(user.id, chat, manage, today);
      if (blocked) return blocked;
      if (images.length && !(await chatPerks(user.id, chat)).canPhoto) {
        return {
          status: 402,
          jsonBody: {
            error: 'Sending photos in chat is part of a paid plan. See Account, Plans to subscribe.',
            code: 'UPGRADE_REQUIRED',
            details: { feature: 'chatAttachments' },
          },
        };
      }
      const parts = images.length ? images : [null];
      const rows = await query<{ id: string }>(
        `INSERT INTO group_chat_message (chat_id, user_id, body, image_mime, image_data, created_at)
         SELECT $1, $2, CASE WHEN i = 1 THEN $3 ELSE '' END, (m.mimes)[i], decode((m.datas)[i], 'base64'),
                clock_timestamp() + make_interval(secs => (i - 1) * 0.001)
           FROM (SELECT $4::text[] AS mimes, $5::text[] AS datas) m, generate_series(1, $6::int) AS i
         RETURNING id`,
        [chat.id, user.id, text, parts.map((p) => p?.mime ?? null), parts.map((p) => p?.base64 ?? null), parts.length],
      );
      const photos = images.length > 1 ? `📷 ${images.length} photos` : images.length ? '📷 Photo' : '';
      const preview = photos ? (text ? `${photos} · ${text}` : photos) : text;
      await Promise.all([
        afterPost(chat, user.id),
        notifyChat(chat, user.id, myName, preview).catch((err) => ctx.warn('group chat notify failed', err)),
      ]);
      return { status: 201, jsonBody: { id: rows[0]?.id ?? null, ids: rows.map((r) => r.id) } };
    }

    if (body.action === 'poll') {
      const blocked = await writable(user.id, chat, manage, today);
      if (blocked) return blocked;
      if (!(await chatPerks(user.id, chat)).canPoll) {
        return {
          status: 402,
          jsonBody: {
            error: 'Creating polls is part of a paid plan. See Account, Plans to subscribe. Anyone in the chat can vote.',
            code: 'UPGRADE_REQUIRED',
            details: { feature: 'chatPolls' },
          },
        };
      }
      const poll = cleanChatPoll({ question: body.question, options: body.options, multi: body.multi });
      if ('error' in poll) return { status: 400, jsonBody: { error: poll.error } };
      const id = await transaction(async (c) => {
        const row = await c.query<{ id: string }>(
          `INSERT INTO group_chat_message (chat_id, user_id, kind, body) VALUES ($1, $2, 'poll', $3) RETURNING id`,
          [chat.id, user.id, poll.question],
        );
        await c.query('INSERT INTO group_chat_poll (message_id, options, multi) VALUES ($1, $2, $3)', [
          row.rows[0].id,
          poll.options,
          poll.multi,
        ]);
        return row.rows[0].id;
      });
      await Promise.all([
        afterPost(chat, user.id),
        notifyChat(chat, user.id, myName, `📊 Poll: ${poll.question}`).catch((err) => ctx.warn('group chat notify failed', err)),
      ]);
      return { status: 201, jsonBody: { id } };
    }

    if (!manage) return FORBIDDEN;
    // The Staff and Admins & directors chats are always there, as they are.
    if (chat.kind !== 'custom') {
      return { status: 400, jsonBody: { error: 'This chat comes with every organization and region, so it can’t be changed or removed.' } };
    }

    if (body.action === 'edit') {
      const name = typeof body.name === 'string' ? body.name.replace(/\s+/g, ' ').trim() : chat.name;
      if (!name || name.length > 60) return { status: 400, jsonBody: { error: 'Give the chat a name under 60 characters.' } };
      const endsOn = 'endsOn' in body ? cleanEndDate(body.endsOn, today) : chat.ends_on;
      if (endsOn && typeof endsOn === 'object') return { status: 400, jsonBody: { error: endsOn.error } };
      await query('UPDATE group_chat SET name = $2, ends_on = $3 WHERE id = $1', [chat.id, name, endsOn]);
      return { status: 200, jsonBody: { ok: true } };
    }

    if (body.action === 'archive') {
      const archive = body.archived !== false;
      if (archive) {
        await query('UPDATE group_chat SET archived_at = COALESCE(archived_at, now()) WHERE id = $1', [chat.id]);
      } else {
        // Reopening a chat whose end date has passed clears the end date.
        await query(
          `UPDATE group_chat SET archived_at = NULL,
                  ends_on = CASE WHEN ends_on < $2::date THEN NULL ELSE ends_on END
            WHERE id = $1`,
          [chat.id, today],
        );
      }
      await query(`INSERT INTO group_chat_message (chat_id, user_id, kind, body) VALUES ($1, $2, 'system', $3)`, [
        chat.id,
        user.id,
        archive ? `${myName} archived this chat` : `${myName} reopened this chat`,
      ]);
      return { status: 200, jsonBody: { ok: true } };
    }

    if (body.action === 'delete') {
      await query('DELETE FROM notification WHERE group_key = $1', [groupKey(chat.id)]);
      await query('DELETE FROM group_chat WHERE id = $1', [chat.id]);
      return { status: 200, jsonBody: { ok: true } };
    }

    return { status: 400, jsonBody: { error: 'Unknown action' } };
  } catch (err) {
    ctx.error('group chats failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/** A photo in a chat, for the people who can read that chat. */
export async function groupChatImageHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    const id = req.query.get('id') ?? '';
    if (!UUID_RE.test(id)) return { status: 400, jsonBody: { error: 'id is required' } };
    const row = await queryOne<{ chat_id: string; image_mime: string | null; image_data: Buffer | null }>(
      'SELECT chat_id, image_mime, image_data FROM group_chat_message WHERE id = $1',
      [id],
    );
    const chat = row ? await loadChat(row.chat_id) : null;
    if (!row || !chat) return FORBIDDEN;
    const access = await buildAccessContext(user);
    if (!canManage(access, user.id, chat) && !(await isMember(chat.id, user.id))) return FORBIDDEN;
    if (!row.image_mime || !row.image_data) return { status: 404 };
    return {
      status: 200,
      body: new Uint8Array(row.image_data),
      headers: {
        'Content-Type': row.image_mime,
        'Content-Disposition': 'inline; filename="photo"',
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      },
    };
  } catch (err) {
    ctx.error('group chat image failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('groupChatImage', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'group-chats/image',
  handler: groupChatImageHandler,
});

app.http('groupChats', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'group-chats',
  handler: groupChatsHandler,
});

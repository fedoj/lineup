import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import {
  CHAT_CHANNELS,
  CHAT_CHANNEL_LABEL,
  CHAT_DROP_IN_ROLES,
  CHAT_EDIT_MINUTES,
  CHAT_MAX_LENGTH,
  CHAT_PHOTOS_PER_SEND,
  CHAT_POLL_MAX_OPTIONS,
  CHAT_REACTIONS,
  CHAT_RETENTION_DAYS,
  canDeleteChatMessage,
  canEditChatMessage,
  chatChannelsForRole,
  cleanChatPoll,
  cleanChatVote,
  isChatChannel,
  membershipsForTeam,
  parseChatImage,
  type AccessContext,
  type ChatChannel,
  findMentions,
  mentionGroupKey,
  type TeamContext,
} from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { buildAccessContext, loadTeamContext } from '../lib/authz.js';
import { query, queryOne, transaction } from '../lib/db.js';
import { featureEnabled } from '../lib/entitlements.js';
import { chatLink } from '../lib/links.js';
import { outsideRequestScope } from '../lib/requestScope.js';

/**
 * Team chat: three chats per team (everyone, staff, coaches). See
 * packages/shared/src/chat.ts for who belongs where and the edit and delete
 * rules. Organization and region staff drop in: they enter a chat, everyone
 * sees them join, and while in they read and post like anyone else.
 */

const FORBIDDEN: HttpResponseInit = {
  status: 403,
  jsonBody: { error: 'You do not have access to this.', code: 'FORBIDDEN' },
};

const ROLE_LABEL: Record<string, string> = {
  coach: 'Coach',
  assistant: 'Assistant coach',
  team_parent: 'Team parent',
  parent: 'Parent',
  viewer: 'Viewer',
  org_admin: 'Organization admin',
  director: 'Director',
  region_admin: 'Region admin',
  scheduler: 'Scheduler',
  platform_admin: 'Lineup support',
};

type Access = 'member' | 'dropin' | null;

/** Which chats the caller belongs to, and which they may drop in to. */
function chatAccess(
  ctx: AccessContext,
  team: TeamContext,
): { channels: Record<ChatChannel, Access>; dropInRole: string | null; moderator: boolean } {
  const applicable = membershipsForTeam(ctx.memberships, team);
  const teamRoles = applicable
    .filter((m) => m.teamId === team.teamId || (m.divisionId && m.divisionId === team.divisionId))
    .map((m) => m.role);
  const member = new Set(teamRoles.flatMap(chatChannelsForRole));
  const staff = applicable.find((m) => !m.teamId && !m.divisionId && CHAT_DROP_IN_ROLES.includes(m.role));
  const dropInRole = staff?.role ?? (ctx.isPlatformAdmin ? 'platform_admin' : null);
  const channels = Object.fromEntries(
    CHAT_CHANNELS.map((c) => [c, member.has(c) ? 'member' : dropInRole ? 'dropin' : null]),
  ) as Record<ChatChannel, Access>;
  // Coaches, and organization or region staff, can remove anyone's message
  // (for example something inappropriate). Free on every plan.
  const moderator = teamRoles.includes('coach') || dropInRole !== null;
  return { channels, dropInRole, moderator };
}

/** A name to show in chat: never an email address. */
function personName(displayName: string | null, email: string | null): string {
  const raw = (displayName ?? '').trim();
  if (raw && !raw.includes('@')) return raw;
  return (raw || email || '').split('@')[0] || 'Team member';
}

async function isPresent(teamId: string, channel: ChatChannel, userId: string): Promise<boolean> {
  return Boolean(
    await queryOne('SELECT 1 FROM chat_presence WHERE team_id = $1 AND channel = $2 AND user_id = $3', [
      teamId,
      channel,
      userId,
    ]),
  );
}

/** One unread notification per chat: later messages update it with a count. */
function chatGroupKey(teamId: string, channel: ChatChannel): string {
  return `chat:${teamId}:${channel}`;
}

/**
 * The people in a chat, for @mentions (Shadi, 10/21): its team members with a
 * role in that chat, and staff dropped in.
 */
async function chatMembers(teamId: string, channel: ChatChannel): Promise<Array<{ id: string; name: string }>> {
  const rows = await query<{ id: string; display_name: string | null; email: string | null }>(
    `SELECT u.id, u.display_name, u.email
       FROM app_user u
      WHERE u.id IN (SELECT m.user_id FROM membership m WHERE m.team_id = $1 AND m.role = ANY($3::text[])
                     UNION SELECT p.user_id FROM chat_presence p WHERE p.team_id = $1 AND p.channel = $2)`,
    [teamId, channel, rolesInChannel(channel)],
  );
  return rows
    .map((r) => ({ id: r.id, name: personName(r.display_name, r.email) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Staff mention @everyone: coaches, assistants, team parents, and organization or region staff. */
function canMentionAll(ctx: AccessContext, team: TeamContext): boolean {
  const ca = chatAccess(ctx, team);
  if (ca.dropInRole) return true;
  return membershipsForTeam(ctx.memberships, team).some(
    (m) => (m.teamId === team.teamId || (m.divisionId && m.divisionId === team.divisionId)) && ['coach', 'assistant', 'team_parent'].includes(m.role),
  );
}

/**
 * Tell the people @mentioned in a message, or everyone for @everyone. One
 * unread notification per person and chat, like messages; it is pushed even
 * to people who only want mentions.
 */
async function notifyMentions(
  teamId: string,
  channel: ChatChannel,
  senderId: string,
  senderName: string,
  preview: string,
  targets: string[] | 'all',
) {
  const info = await queryOne<{ name: string }>('SELECT name FROM team WHERE id = $1', [teamId]);
  const where = channel === 'all' ? info?.name ?? 'Team chat' : `${info?.name ?? 'Team'} · ${CHAT_CHANNEL_LABEL[channel]}`;
  const text = preview.replace(/\s+/g, ' ').trim();
  const body = text.length > 120 ? `${text.slice(0, 117)}…` : text;
  const title = targets === 'all' ? `${senderName} to everyone in ${where}` : `${senderName} mentioned you in ${where}`;
  const ids = targets === 'all' ? (await chatMembers(teamId, channel)).map((m) => m.id) : targets;
  const to = ids.filter((id) => id !== senderId);
  if (!to.length) return;
  await query(
    `INSERT INTO notification (user_id, kind, title, body, link, group_key, from_name)
     SELECT u, 'message', $2, $3, $4, $5, $6 FROM unnest($1::uuid[]) AS u
     ON CONFLICT (user_id, group_key) WHERE read_at IS NULL AND group_key IS NOT NULL
     DO UPDATE SET batch = notification.batch + 1, title = EXCLUDED.title, body = EXCLUDED.body,
                   from_name = EXCLUDED.from_name, created_at = now(), pushed_at = NULL`,
    [to, title, body, chatLink(teamId, channel), mentionGroupKey(teamId, channel), senderName],
  );
}

/** Roles that belong to a chat (organization and region staff only while dropped in). */
function rolesInChannel(channel: ChatChannel): string[] {
  return ['coach', 'assistant', 'team_parent', 'parent'].filter((r) => chatChannelsForRole(r).includes(channel));
}

/**
 * Tell everyone in the chat, except the sender, about a new message or poll.
 * Each person has one notification per chat: while it is unread, later
 * messages only add to its count (it keeps the first message and who sent
 * it); once read, the next message brings that same notification back as
 * unread instead of adding another, so a busy chat never fills the bell.
 * Opening the chat marks it read.
 */
async function notifyChat(
  teamId: string,
  channel: ChatChannel,
  senderId: string,
  senderName: string,
  preview: string,
  /** People told by an @mention instead. */
  skip: string[] = [],
) {
  const info = await queryOne<{ name: string; kids: string | null; role: string | null }>(
    `SELECT t.name,
            (SELECT string_agg(split_part(p.name, ' ', 1), ' & ' ORDER BY p.name)
               FROM player_guardian g JOIN player p ON p.id = g.player_id
              WHERE p.team_id = t.id AND g.user_id = $2) AS kids,
            (SELECT m.role FROM membership m WHERE m.team_id = t.id AND m.user_id = $2 LIMIT 1) AS role
       FROM team t WHERE t.id = $1`,
    [teamId, senderId],
  );
  const where = channel === 'all' ? info?.name ?? 'Team chat' : `${info?.name ?? 'Team'} · ${CHAT_CHANNEL_LABEL[channel]}`;
  const text = preview.replace(/\s+/g, ' ').trim();
  const body = text.length > 120 ? `${text.slice(0, 117)}…` : text;
  // The sender's child on this team (in a lighter colour), else their role.
  const detail = info?.kids || (info?.role ? ROLE_LABEL[info.role] ?? null : null);
  await query(
    `WITH r AS (
       SELECT DISTINCT u.user_id
         FROM (SELECT m.user_id FROM membership m WHERE m.team_id = $1 AND m.role = ANY($3::text[])
               UNION SELECT p.user_id FROM chat_presence p WHERE p.team_id = $1 AND p.channel = $2) u
        WHERE u.user_id <> $8 AND NOT (u.user_id = ANY($11::uuid[]))
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
              from_name = CASE WHEN l.read_at IS NULL THEN n.from_name ELSE $9 END,
              from_detail = CASE WHEN l.read_at IS NULL THEN n.from_detail ELSE $10 END,
              read_at = NULL,
              created_at = now(),
              -- Sent to phones again with the new count.
              pushed_at = NULL
         FROM latest l
        WHERE n.id = l.id
       RETURNING n.user_id
     )
     INSERT INTO notification (user_id, kind, title, body, link, group_key, from_name, from_detail)
     SELECT r.user_id, 'message', $4, $5, $6, $7, $9, $10 FROM r
      WHERE NOT EXISTS (SELECT 1 FROM latest l WHERE l.user_id = r.user_id)
     ON CONFLICT (user_id, group_key) WHERE read_at IS NULL AND group_key IS NOT NULL
     DO UPDATE SET batch = notification.batch + 1, created_at = now(), pushed_at = NULL`,
    [
      teamId,
      channel,
      rolesInChannel(channel),
      `New messages in ${where}`,
      body,
      chatLink(teamId, channel),
      chatGroupKey(teamId, channel),
      senderId,
      senderName,
      detail,
      skip,
    ],
  );
}

interface MessageRow {
  id: string;
  mentions: Array<{ id: string; name: string }> | null;
  mention_all: boolean;
  user_id: string | null;
  kind: 'message' | 'system' | 'poll';
  body: string;
  has_image: boolean;
  reply_to: string | null;
  created_at: Date;
  edited_at: Date | null;
  display_name: string | null;
  email: string | null;
  role: string | null;
  replies: number;
  reply_body: string | null;
  reply_has_image: boolean | null;
  reply_name: string | null;
  reply_email: string | null;
}

/** A photo's address in the app. */
function imageUrl(id: string): string {
  return `/api/chat/image?id=${id}`;
}

/** Last 90-day clean-up per team in this instance; it runs at most hourly, beside a read. */
const lastPrune = new Map<string, number>();
const PRUNE_EVERY_MS = 60 * 60_000;

function pruneOldMessages(teamId: string): void {
  const now = Date.now();
  if (now - (lastPrune.get(teamId) ?? 0) < PRUNE_EVERY_MS) return;
  lastPrune.set(teamId, now);
  // Messages are kept for 90 days.
  void outsideRequestScope(() =>
    query(`DELETE FROM chat_message WHERE team_id = $1 AND created_at < now() - make_interval(days => $2)`, [
      teamId,
      CHAT_RETENTION_DAYS,
    ]),
  ).catch(() => lastPrune.delete(teamId));
}

export async function chatHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    if (req.method === 'GET') {
      const [access, team] = await Promise.all([
        buildAccessContext(user),
        loadTeamContext(req.query.get('teamId') ?? ''),
      ]);
      if (!team) return FORBIDDEN;
      const ca = chatAccess(access, team);
      const available = CHAT_CHANNELS.filter((c) => ca.channels[c]);
      if (available.length === 0) return FORBIDDEN;
      const asked = req.query.get('channel');
      const channel: ChatChannel = isChatChannel(asked) && ca.channels[asked] ? asked : available[0];

      pruneOldMessages(team.teamId);

      // Everything below needs only the team and channel, so it is read at
      // once; the messages are dropped if the caller turns out not to be in.
      const [presenceRows, paid, canPoll, canPhoto, rawRows, visitors] = await Promise.all([
        query<{ channel: ChatChannel }>('SELECT channel FROM chat_presence WHERE team_id = $1 AND user_id = $2', [
          team.teamId,
          user.id,
        ]),
        featureEnabled(user.id, 'chatEditing'),
        featureEnabled(user.id, 'chatPolls'),
        featureEnabled(user.id, 'chatAttachments'),
        query<MessageRow>(
          `SELECT m.id, m.user_id, m.kind, m.body, (m.image_mime IS NOT NULL) AS has_image, m.mentions, m.mention_all,
                  m.reply_to, m.created_at, m.edited_at,
                  u.display_name, u.email,
                  COALESCE(
                    (SELECT mm.role FROM membership mm WHERE mm.user_id = m.user_id AND mm.team_id = m.team_id LIMIT 1),
                    (SELECT mm.role FROM membership mm JOIN team t ON t.id = m.team_id
                      WHERE mm.user_id = m.user_id AND mm.role = ANY($3::text[])
                        AND (mm.org_id = t.org_id OR mm.region_id = t.region_id) LIMIT 1)
                  ) AS role,
                  (SELECT COUNT(*) FROM chat_message r WHERE r.reply_to = m.id)::int AS replies,
                  p.body AS reply_body, (p.image_mime IS NOT NULL) AS reply_has_image,
                  pu.display_name AS reply_name, pu.email AS reply_email
             FROM chat_message m
             LEFT JOIN app_user u ON u.id = m.user_id
             LEFT JOIN chat_message p ON p.id = m.reply_to
             LEFT JOIN app_user pu ON pu.id = p.user_id
            WHERE m.team_id = $1 AND m.channel = $2
              AND m.created_at >= now() - make_interval(days => $4)
            ORDER BY m.created_at DESC
            LIMIT 100`,
          [team.teamId, channel, CHAT_DROP_IN_ROLES, CHAT_RETENTION_DAYS],
        ),
        query<{ display_name: string | null; email: string | null; role: string | null }>(
          `SELECT u.display_name, u.email,
                  (SELECT mm.role FROM membership mm WHERE mm.user_id = u.id AND mm.role = ANY($3::text[])
                     AND (mm.org_id = $4 OR mm.region_id = $5) LIMIT 1) AS role
             FROM chat_presence p JOIN app_user u ON u.id = p.user_id
            WHERE p.team_id = $1 AND p.channel = $2`,
          [team.teamId, channel, CHAT_DROP_IN_ROLES, team.orgId, team.regionId ?? null],
        ),
      ]);
      const presence = new Set(presenceRows.map((r) => r.channel));
      const canRead = ca.channels[channel] === 'member' || presence.has(channel);

      // Reading the chat clears its notification in the bell (beside the reads below).
      if (canRead) {
        void query('UPDATE notification SET read_at = now() WHERE user_id = $1 AND group_key = ANY($2::text[]) AND read_at IS NULL', [
          user.id,
          [chatGroupKey(team.teamId, channel), mentionGroupKey(team.teamId, channel)],
        ]).catch(() => undefined);
      }
      let messages: unknown[] = [];
      if (canRead) {
        const rows = rawRows.reverse();
        // Polls: the answers, who picked each, and whether the caller voted.
        const pollIds = rows.filter((r) => r.kind === 'poll').map((r) => r.id);
        const authorIds = [...new Set(rows.map((r) => r.user_id).filter((x): x is string => Boolean(x)))];
        const [reactions, polls, votes, kids] = await Promise.all([
          rows.length
            ? query<{ message_id: string; emoji: string; n: number; mine: boolean }>(
                `SELECT message_id, emoji, COUNT(*)::int AS n, bool_or(user_id = $2) AS mine
                   FROM chat_reaction WHERE message_id = ANY($1::uuid[])
                  GROUP BY message_id, emoji ORDER BY emoji`,
                [rows.map((r) => r.id), user.id],
              )
            : Promise.resolve([]),
          pollIds.length
            ? query<{ message_id: string; options: string[]; multi: boolean; closed_at: Date | null }>(
                'SELECT message_id, options, multi, closed_at FROM chat_poll WHERE message_id = ANY($1::uuid[])',
                [pollIds],
              )
            : Promise.resolve([]),
          pollIds.length
            ? query<{ message_id: string; user_id: string; option_no: number; display_name: string | null; email: string | null }>(
                `SELECT v.message_id, v.user_id, v.option_no, u.display_name, u.email
                   FROM chat_poll_vote v JOIN app_user u ON u.id = v.user_id
                  WHERE v.message_id = ANY($1::uuid[])
                  ORDER BY v.voted_at`,
                [pollIds],
              )
            : Promise.resolve([]),
          // Each parent's child (or children) on this team, shown beside their name.
          authorIds.length
            ? query<{ user_id: string; kids: string }>(
                `SELECT g.user_id, string_agg(split_part(p.name, ' ', 1), ' & ' ORDER BY p.name) AS kids
                   FROM player_guardian g JOIN player p ON p.id = g.player_id
                  WHERE p.team_id = $1 AND g.user_id = ANY($2::uuid[])
                  GROUP BY g.user_id`,
                [team.teamId, authorIds],
              )
            : Promise.resolve([]),
        ]);
        const kidsOf = new Map(kids.map((k) => [k.user_id, k.kids]));
        const pollFor = (r: MessageRow) => {
          const p = polls.find((x) => x.message_id === r.id);
          if (!p) return null;
          const mineVotes = votes.filter((v) => v.message_id === r.id);
          return {
            options: p.options.map((text, i) => {
              const on = mineVotes.filter((v) => v.option_no === i);
              return {
                text,
                votes: on.length,
                voters: on.map((v) => (v.user_id === user.id ? 'You' : personName(v.display_name, v.email))),
                mine: on.some((v) => v.user_id === user.id),
              };
            }),
            multi: p.multi,
            closed: Boolean(p.closed_at),
            voters: new Set(mineVotes.map((v) => v.user_id)).size,
            canClose: !p.closed_at && (r.user_id === user.id || ca.moderator),
          };
        };
        messages = rows.map((r) => {
          const mine = r.user_id === user.id;
          const reacts = reactions.filter((x) => x.message_id === r.id);
          const total = reacts.reduce((s, x) => s + x.n, 0);
          const poll = r.kind === 'poll' ? pollFor(r) : null;
          const responses = total + (poll?.voters ?? 0);
          return {
            id: r.id,
            kind: r.kind,
            mine,
            author: personName(r.display_name, r.email),
            child: r.user_id ? kidsOf.get(r.user_id) ?? null : null,
            role: r.role ? ROLE_LABEL[r.role] ?? r.role : null,
            body: r.body,
            // Names to highlight as @mentions.
            mentions: Array.isArray(r.mentions) ? r.mentions.map((x) => x.name) : [],
            mentionAll: r.mention_all,
            image: r.has_image ? { url: imageUrl(r.id) } : null,
            createdAt: r.created_at.toISOString(),
            editedAt: r.edited_at ? r.edited_at.toISOString() : null,
            replyTo: r.reply_to
              ? {
                  id: r.reply_to,
                  author: personName(r.reply_name, r.reply_email),
                  body: (r.reply_body || (r.reply_has_image ? '📷 Photo' : '')).slice(0, 140),
                }
              : null,
            replies: r.replies,
            reactions: reacts.map((x) => ({ emoji: x.emoji, count: x.n, mine: x.mine })),
            poll,
            canEdit: r.kind === 'message' && canEditChatMessage({ isAuthor: mine, createdAt: r.created_at, paid }),
            // A poll counts its votes as responses: once people vote, it stays.
            canDelete:
              r.kind !== 'system' &&
              canDeleteChatMessage({ isAuthor: mine, paid, reactions: responses, replies: r.replies }),
            canRemove: r.kind !== 'system' && !mine && ca.moderator,
          };
        });
      }

      return {
        status: 200,
        jsonBody: {
          teamId: team.teamId,
          channel,
          channels: available.map((c) => ({
            id: c,
            label: CHAT_CHANNEL_LABEL[c],
            access: ca.channels[c],
            present: presence.has(c),
          })),
          canRead,
          dropIn: ca.channels[channel] === 'dropin',
          present: presence.has(channel),
          paid,
          canPoll,
          canPhoto,
          pollMaxOptions: CHAT_POLL_MAX_OPTIONS,
          editMinutes: CHAT_EDIT_MINUTES,
          retentionDays: CHAT_RETENTION_DAYS,
          maxLength: CHAT_MAX_LENGTH,
          reactions: CHAT_REACTIONS,
          // Who can be @mentioned here, and whether the caller can mention @everyone.
          members: canRead ? (await chatMembers(team.teamId, channel)).filter((m) => m.id !== user.id) : [],
          canMentionAll: canMentionAll(access, team),
          visitors: visitors.map((v) => ({
            name: personName(v.display_name, v.email),
            role: v.role ? ROLE_LABEL[v.role] ?? v.role : 'Lineup support',
          })),
          messages,
        },
      };
    }

    const b = (await req.json()) as {
      action?: string;
      teamId?: string;
      channel?: string;
      body?: string;
      replyTo?: string;
      messageId?: string;
      emoji?: string;
      question?: string;
      options?: unknown;
      multi?: boolean;
      choices?: unknown;
      image?: string;
      images?: unknown[];
    };
    const action = String(b.action ?? '');

    // Actions on one message resolve the team and chat from the message.
    let teamId = String(b.teamId ?? '').slice(0, 36);
    let channel: ChatChannel | null = isChatChannel(b.channel) ? b.channel : null;
    type TargetRow = {
      id: string;
      team_id: string;
      channel: ChatChannel;
      user_id: string | null;
      kind: string;
      created_at: Date;
      has_image: boolean;
    };
    let message: TargetRow | null = null;
    if (['edit', 'delete', 'react', 'vote', 'closePoll'].includes(action)) {
      message =
        (await queryOne<TargetRow>(
          `SELECT id, team_id, channel, user_id, kind, created_at, (image_mime IS NOT NULL) AS has_image
             FROM chat_message WHERE id = $1`,
          [String(b.messageId ?? '').slice(0, 36)],
        )) ?? null;
      if (!message) return FORBIDDEN;
      teamId = message.team_id;
      channel = message.channel;
    }
    if (!channel) return { status: 400, jsonBody: { error: 'Pick a chat.' } };
    // Who may act, the caller's name and (for a poll) the poll are read at once.
    const [access, team, me, pollRow] = await Promise.all([
      buildAccessContext(user),
      loadTeamContext(teamId),
      queryOne<{ display_name: string | null; email: string | null }>(
        'SELECT display_name, email FROM app_user WHERE id = $1',
        [user.id],
      ),
      message && (action === 'vote' || action === 'closePoll')
        ? queryOne<{ options: string[]; multi: boolean; closed_at: Date | null }>(
            'SELECT options, multi, closed_at FROM chat_poll WHERE message_id = $1',
            [message.id],
          )
        : Promise.resolve(null),
    ]);
    if (!team) return FORBIDDEN;
    // An archived team's chats are read-only.
    if (team.archived) {
      return { status: 409, jsonBody: { error: 'This team is archived, so its chat is read-only.', code: 'TEAM_ARCHIVED' } };
    }
    const ca = chatAccess(access, team);
    const level = ca.channels[channel];
    if (!level) return FORBIDDEN;

    const myName = personName(me?.display_name ?? null, me?.email ?? null);

    if (action === 'enter' || action === 'leave') {
      if (level !== 'dropin') return { status: 400, jsonBody: { error: 'You are already a member of this chat.' } };
      if (action === 'enter') {
        const added = await queryOne(
          `INSERT INTO chat_presence (team_id, channel, user_id) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING RETURNING user_id`,
          [team.teamId, channel, user.id],
        );
        if (added) {
          await query(
            `INSERT INTO chat_message (team_id, channel, user_id, kind, body) VALUES ($1, $2, $3, 'system', $4)`,
            [team.teamId, channel, user.id, `${myName} (${ROLE_LABEL[ca.dropInRole ?? ''] ?? 'Staff'}) joined the chat`],
          );
        }
      } else {
        const gone = await queryOne(
          'DELETE FROM chat_presence WHERE team_id = $1 AND channel = $2 AND user_id = $3 RETURNING user_id',
          [team.teamId, channel, user.id],
        );
        if (gone) {
          await query(
            `INSERT INTO chat_message (team_id, channel, user_id, kind, body) VALUES ($1, $2, $3, 'system', $4)`,
            [team.teamId, channel, user.id, `${myName} left the chat`],
          );
        }
      }
      return { status: 200, jsonBody: { ok: true } };
    }

    // Everything else needs to be in the chat: a member, or dropped in.
    const inChat = level === 'member' || (await isPresent(team.teamId, channel, user.id));
    if (!inChat) {
      return { status: 403, jsonBody: { error: 'Enter the chat first.', code: 'CHAT_NOT_ENTERED' } };
    }

    if (action === 'send') {
      const body = String(b.body ?? '').trim();
      // Up to CHAT_PHOTOS_PER_SEND photos at once; each becomes its own
      // message, and the caption and reply go with the first.
      const rawImages = Array.isArray(b.images) ? b.images : b.image ? [b.image] : [];
      if (rawImages.length > CHAT_PHOTOS_PER_SEND) {
        return { status: 400, jsonBody: { error: `Send up to ${CHAT_PHOTOS_PER_SEND} photos at a time.` } };
      }
      const images: Array<{ mime: string; base64: string }> = [];
      for (const raw of rawImages) {
        const image = parseChatImage(raw);
        if (image && 'error' in image) return { status: 400, jsonBody: { error: image.error } };
        if (image) images.push(image);
      }
      if (!body && images.length === 0) return { status: 400, jsonBody: { error: 'Write a message first.' } };
      if (body.length > CHAT_MAX_LENGTH) {
        return { status: 400, jsonBody: { error: `Messages can be up to ${CHAT_MAX_LENGTH} characters.` } };
      }
      // Sending photos is paid; seeing them is free for everyone in the chat.
      if (images.length && !(await featureEnabled(user.id, 'chatAttachments'))) {
        return {
          status: 402,
          jsonBody: {
            error: 'Sending photos in team chat is part of a paid plan. See Account, Plans to subscribe.',
            code: 'UPGRADE_REQUIRED',
            details: { feature: 'chatAttachments' },
          },
        };
      }
      let replyTo: string | null = null;
      if (b.replyTo) {
        const parent = await queryOne<{ id: string }>(
          'SELECT id FROM chat_message WHERE id = $1 AND team_id = $2 AND channel = $3',
          [String(b.replyTo).slice(0, 36), team.teamId, channel],
        );
        replyTo = parent?.id ?? null;
      }
      // @mentions (Shadi, 10/21): people in this chat named as "@Name", and
      // "@everyone" from staff. They are told by a mention instead.
      const members = body ? (await chatMembers(team.teamId, channel)).filter((m) => m.id !== user.id) : [];
      const found = findMentions(body, members, canMentionAll(access, team));
      const mentioned = members.filter((m) => found.ids.includes(m.id));
      // One statement for all of them; a millisecond apart so they keep their order.
      const parts = images.length ? images : [null];
      const rows = await query<{ id: string }>(
        `INSERT INTO chat_message (team_id, channel, user_id, body, reply_to, image_mime, image_data, created_at,
                                   mentions, mention_all)
         SELECT $1, $2, $3, CASE WHEN i = 1 THEN $4 ELSE '' END, CASE WHEN i = 1 THEN $5::uuid END,
                (m.mimes)[i], decode((m.datas)[i], 'base64'),
                clock_timestamp() + make_interval(secs => (i - 1) * 0.001),
                CASE WHEN i = 1 THEN $9::jsonb END, i = 1 AND $10::boolean
           FROM (SELECT $6::text[] AS mimes, $7::text[] AS datas) m,
                generate_series(1, $8::int) AS i
         RETURNING id`,
        [
          team.teamId,
          channel,
          user.id,
          body,
          replyTo,
          parts.map((p) => p?.mime ?? null),
          parts.map((p) => p?.base64 ?? null),
          parts.length,
          mentioned.length ? JSON.stringify(mentioned) : null,
          found.all,
        ],
      );
      const photos = images.length > 1 ? `📷 ${images.length} photos` : images.length ? '📷 Photo' : '';
      const preview = photos ? (body ? `${photos} · ${body}` : photos) : body;
      try {
        if (found.all) {
          await notifyMentions(team.teamId, channel, user.id, myName, preview, 'all');
        } else {
          if (mentioned.length) {
            await notifyMentions(team.teamId, channel, user.id, myName, preview, mentioned.map((m) => m.id));
          }
          await notifyChat(team.teamId, channel, user.id, myName, preview, mentioned.map((m) => m.id));
        }
      } catch (e) {
        ctx.warn('chat notify failed', e);
      }
      return { status: 201, jsonBody: { id: rows[0]?.id, ids: rows.map((r) => r.id) } };
    }

    if (action === 'poll') {
      const denied = !(await featureEnabled(user.id, 'chatPolls'));
      if (denied) {
        return {
          status: 402,
          jsonBody: {
            error: 'Creating polls is part of a paid plan. See Account, Plans to subscribe. Anyone in the chat can vote.',
            code: 'UPGRADE_REQUIRED',
            details: { feature: 'chatPolls' },
          },
        };
      }
      const poll = cleanChatPoll({ question: b.question, options: b.options, multi: b.multi });
      if ('error' in poll) return { status: 400, jsonBody: { error: poll.error } };
      const id = await transaction(async (c) => {
        const row = await c.query<{ id: string }>(
          `INSERT INTO chat_message (team_id, channel, user_id, kind, body) VALUES ($1, $2, $3, 'poll', $4) RETURNING id`,
          [team.teamId, channel, user.id, poll.question],
        );
        await c.query('INSERT INTO chat_poll (message_id, options, multi) VALUES ($1, $2, $3)', [
          row.rows[0].id,
          poll.options,
          poll.multi,
        ]);
        return row.rows[0].id;
      });
      await notifyChat(team.teamId, channel, user.id, myName, `📊 Poll: ${poll.question}`).catch((e) =>
        ctx.warn('chat notify failed', e),
      );
      return { status: 201, jsonBody: { id } };
    }

    if (action === 'vote' || action === 'closePoll') {
      const m = message!;
      const p = pollRow;
      if (m.kind !== 'poll' || !p) return { status: 400, jsonBody: { error: 'That message is not a poll.' } };
      if (p.closed_at) return { status: 409, jsonBody: { error: 'This poll is closed.', code: 'POLL_CLOSED' } };
      if (action === 'closePoll') {
        if (m.user_id !== user.id && !ca.moderator) {
          return { status: 403, jsonBody: { error: 'Only the person who made the poll, or a coach, can close it.', code: 'FORBIDDEN' } };
        }
        await query('UPDATE chat_poll SET closed_at = now(), closed_by = $2 WHERE message_id = $1', [m.id, user.id]);
        return { status: 200, jsonBody: { ok: true } };
      }
      // Voting is free for everyone in the chat. A vote replaces the last one;
      // no answers takes it back. One statement: answers no longer picked go,
      // new ones are added, so a tap costs a single trip to the database.
      const picked = cleanChatVote(b.choices, { options: p.options.length, multi: p.multi });
      if ('error' in picked) return { status: 400, jsonBody: { error: picked.error } };
      await query(
        `WITH gone AS (
           DELETE FROM chat_poll_vote
            WHERE message_id = $1 AND user_id = $2 AND NOT (option_no = ANY($3::smallint[]))
         )
         INSERT INTO chat_poll_vote (message_id, user_id, option_no)
         SELECT $1, $2, n FROM unnest($3::smallint[]) AS n
         ON CONFLICT (message_id, user_id, option_no) DO NOTHING`,
        [m.id, user.id, picked],
      );
      return { status: 200, jsonBody: { ok: true, choices: picked } };
    }

    if (action === 'react') {
      const emoji = String(b.emoji ?? '');
      if (!CHAT_REACTIONS.includes(emoji)) return { status: 400, jsonBody: { error: 'Pick one of the reactions.' } };
      const removed = await queryOne(
        'DELETE FROM chat_reaction WHERE message_id = $1 AND user_id = $2 AND emoji = $3 RETURNING emoji',
        [message!.id, user.id, emoji],
      );
      if (!removed) {
        await query('INSERT INTO chat_reaction (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
          message!.id,
          user.id,
          emoji,
        ]);
      }
      return { status: 200, jsonBody: { ok: true } };
    }

    if (action === 'edit' || action === 'delete') {
      const m = message!;
      // A coach (or organization or region staff) removes someone else's
      // message. It simply disappears for everyone: no notice of who wrote it
      // or who removed it, so removals don't turn into arguments.
      if (action === 'delete' && m.kind !== 'system' && m.user_id !== user.id && ca.moderator) {
        await query('DELETE FROM chat_message WHERE id = $1', [m.id]);
        return { status: 200, jsonBody: { ok: true, removed: true } };
      }
      if (m.kind === 'system' || m.user_id !== user.id || (action === 'edit' && m.kind !== 'message')) {
        return { status: 403, jsonBody: { error: 'You can only change your own messages.', code: 'FORBIDDEN' } };
      }
      const paid = await featureEnabled(user.id, 'chatEditing');
      if (!paid) {
        return {
          status: 402,
          jsonBody: {
            error: 'Editing and deleting messages is part of a paid plan. See Account, Plans to subscribe.',
            code: 'UPGRADE_REQUIRED',
            details: { feature: 'chatEditing' },
          },
        };
      }
      if (action === 'edit') {
        const body = String(b.body ?? '').trim();
        // A photo's caption can be cleared; a text message needs its text.
        if ((!body && !m.has_image) || body.length > CHAT_MAX_LENGTH) {
          return { status: 400, jsonBody: { error: 'Write a message first.' } };
        }
        if (!canEditChatMessage({ isAuthor: true, createdAt: m.created_at, paid })) {
          return {
            status: 409,
            jsonBody: { error: `Messages can be edited for ${CHAT_EDIT_MINUTES} minutes after sending.`, code: 'CHAT_EDIT_CLOSED' },
          };
        }
        await query('UPDATE chat_message SET body = $2, edited_at = now() WHERE id = $1', [m.id, body]);
        return { status: 200, jsonBody: { ok: true } };
      }
      const counts = await queryOne<{ reactions: number; replies: number }>(
        `SELECT ((SELECT COUNT(*) FROM chat_reaction WHERE message_id = $1)
                 + (SELECT COUNT(*) FROM chat_poll_vote WHERE message_id = $1))::int AS reactions,
                (SELECT COUNT(*) FROM chat_message WHERE reply_to = $1)::int AS replies`,
        [m.id],
      );
      if (!canDeleteChatMessage({ isAuthor: true, paid, reactions: counts?.reactions ?? 0, replies: counts?.replies ?? 0 })) {
        return {
          status: 409,
          jsonBody: {
            error:
              m.kind === 'poll'
                ? 'People have already voted, reacted or replied, so this poll stays. You can close it instead.'
                : 'Someone has already reacted or replied to this message, so it stays.',
            code: 'CHAT_HAS_RESPONSES',
          },
        };
      }
      await query('DELETE FROM chat_message WHERE id = $1', [m.id]);
      return { status: 200, jsonBody: { ok: true } };
    }

    return { status: 400, jsonBody: { error: 'Unknown action.' } };
  } catch (err) {
    ctx.error('chat failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('chat', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'chat',
  handler: chatHandler,
});

/** A photo from team chat, for anyone who can read that chat. */
export async function chatImageHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    const id = req.query.get('id') ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(id)) return { status: 400, jsonBody: { error: 'id is required' } };
    const row = await queryOne<{ team_id: string; channel: ChatChannel; image_mime: string | null; image_data: Buffer | null }>(
      'SELECT team_id, channel, image_mime, image_data FROM chat_message WHERE id = $1',
      [id],
    );
    if (!row) return FORBIDDEN;
    const team = await loadTeamContext(row.team_id);
    if (!team) return FORBIDDEN;
    const level = chatAccess(await buildAccessContext(user), team).channels[row.channel];
    const canRead = level === 'member' || (level === 'dropin' && (await isPresent(team.teamId, row.channel, user.id)));
    if (!canRead) return FORBIDDEN;
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
    ctx.error('chat image failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('chatImage', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'chat/image',
  handler: chatImageHandler,
});

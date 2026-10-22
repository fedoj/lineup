/**
 * What gets pushed to someone's phone or computer (Shadi, 10/21). Every
 * notification still lands in the bell; these settings only decide which of
 * them are also pushed. Organization, sign-up and other notices always are.
 */

export type NotifyCategory = 'game' | 'practice' | 'event' | 'chat' | 'mention' | 'other';

export type ChatNotify = 'all' | 'mentions' | 'off';

export interface NotifyPrefs {
  games: boolean;
  practices: boolean;
  events: boolean;
  chat: ChatNotify;
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = { games: true, practices: true, events: true, chat: 'all' };

export const CHAT_NOTIFY_LABEL: Record<ChatNotify, string> = {
  all: 'Every message',
  mentions: 'Only when someone @mentions me',
  off: 'Off',
};

/** The group key of a chat's @mention notifications (one per person and chat while unread). */
export function mentionGroupKey(teamId: string, channel: string): string {
  return `mention:${teamId}:${channel}`;
}

/** Sorts a notification by its link and group (calendar focus, chat, lineup). */
export function notifyCategory(link: string | null | undefined, groupKey: string | null | undefined): NotifyCategory {
  const g = groupKey ?? '';
  if (g.startsWith('mention:')) return 'mention';
  if (g.startsWith('chat:')) return 'chat';
  if (g.startsWith('lineup:')) return 'game';
  const focus = /[?&]focus=([a-z]+)/.exec(link ?? '')?.[1] ?? '';
  if (focus === 'game' || (link ?? '').startsWith('/matchday')) return 'game';
  if (focus === 'practice' || focus === 'practices') return 'practice';
  if (focus === 'event') return 'event';
  return 'other';
}

/** Is a notification of this kind pushed under these settings? */
export function pushAllowed(category: NotifyCategory, prefs: NotifyPrefs | null | undefined): boolean {
  const p = prefs ?? DEFAULT_NOTIFY_PREFS;
  switch (category) {
    case 'game':
      return p.games;
    case 'practice':
      return p.practices;
    case 'event':
      return p.events;
    case 'chat':
      return p.chat === 'all';
    case 'mention':
      return p.chat !== 'off';
    default:
      return true;
  }
}

/** Settings from a request body, keeping what was not sent. */
export function cleanNotifyPrefs(input: unknown, current: NotifyPrefs = DEFAULT_NOTIFY_PREFS): NotifyPrefs {
  const b = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const flag = (v: unknown, was: boolean) => (typeof v === 'boolean' ? v : was);
  const chat = b.chat === 'all' || b.chat === 'mentions' || b.chat === 'off' ? b.chat : current.chat;
  return {
    games: flag(b.games, current.games),
    practices: flag(b.practices, current.practices),
    events: flag(b.events, current.events),
    chat,
  };
}

/**
 * The people a chat message mentions: "@Name" for each person in the chat
 * whose name is in the text (longest names first, so "@Ann Lee" wins over
 * "@Ann"), and "@everyone" for staff.
 */
export function findMentions(
  body: string,
  members: ReadonlyArray<{ id: string; name: string }>,
  canMentionAll: boolean,
): { ids: string[]; all: boolean } {
  const text = body.toLowerCase();
  const all = canMentionAll && /(^|\s)@everyone\b/.test(text);
  const ids: string[] = [];
  const taken: Array<[number, number]> = [];
  const sorted = [...members].filter((m) => m.name.trim()).sort((a, b) => b.name.length - a.name.length);
  for (const m of sorted) {
    const needle = `@${m.name.toLowerCase()}`;
    let from = 0;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at < 0) break;
      const end = at + needle.length;
      const before = at === 0 ? ' ' : text[at - 1];
      const after = end >= text.length ? ' ' : text[end];
      const overlaps = taken.some(([s, e]) => at < e && end > s);
      if (/\s/.test(before) && !/[\p{L}\p{N}]/u.test(after) && !overlaps) {
        taken.push([at, end]);
        if (!ids.includes(m.id)) ids.push(m.id);
        break;
      }
      from = at + 1;
    }
  }
  return { ids, all };
}

/**
 * Team chat rules, shared by the API and the app.
 *
 * Every team has three chats: one for everyone on the team, one for staff
 * (coaches, assistant coaches and team parents) and one for coaches. People
 * see only the chats their role belongs to. Organization and region staff can
 * drop in to any of their teams' chats without approval; everyone in the chat
 * sees them join and leave, and while in they post like anyone else.
 */

import { sizeLabel } from './media.js';

export type ChatChannel = 'all' | 'staff' | 'coaches';

export const CHAT_CHANNELS: readonly ChatChannel[] = ['all', 'staff', 'coaches'];

export const CHAT_CHANNEL_LABEL: Record<ChatChannel, string> = {
  all: 'Everyone',
  staff: 'Staff',
  coaches: 'Coaches',
};

/** Messages older than this are deleted. */
export const CHAT_RETENTION_DAYS = 90;
/** A message can be edited for this long after it is sent. */
export const CHAT_EDIT_MINUTES = 10;
export const CHAT_MAX_LENGTH = 2000;
export const CHAT_REACTIONS: readonly string[] = ['👍', '❤️', '😂', '🎉', '⚽', '🚀', '😢', '🔥'];

/**
 * Photos in team chat are a paid feature (chatAttachments); everyone in the
 * chat sees them. The app shrinks a photo before sending (a phone picture
 * arrives as about 100-250 KB), so the limit is for what arrives at the
 * server. Photos are deleted with their message.
 */
export const CHAT_IMAGE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const CHAT_IMAGE_MAX_BYTES = 256 * 1024;
/** Longest side, in pixels, the app shrinks a photo to before sending. */
export const CHAT_IMAGE_MAX_SIDE = 1024;
/** Photos that can be sent at once; each goes as its own message. */
export const CHAT_PHOTOS_PER_SEND = 4;

/**
 * How long an open chat waits before checking for new messages, given how
 * long ago anything happened in it (a message, reaction or vote arrived, or
 * the person sent, typed or came back to the chat). A conversation in
 * progress refreshes every 3 seconds; a quiet chat slows down step by step
 * to every 30 seconds, and speeds up again the moment something happens.
 */
export function chatRefreshDelay(msSinceActivity: number): number {
  if (msSinceActivity < 60_000) return 3_000;
  if (msSinceActivity < 3 * 60_000) return 10_000;
  if (msSinceActivity < 10 * 60_000) return 20_000;
  return 30_000;
}

/** A photo sent as a data URL, checked, or the reason it can't be sent. */
export function parseChatImage(raw: unknown): { mime: string; base64: string } | null | { error: string } {
  if (raw === null || raw === undefined || raw === '') return null;
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(raw));
  if (!m) return { error: 'Send a JPEG, PNG, WebP or GIF photo.' };
  // Four base64 characters carry three bytes.
  const bytes = Math.floor((m[2].length * 3) / 4) - (m[2].endsWith('==') ? 2 : m[2].endsWith('=') ? 1 : 0);
  if (bytes <= 0) return { error: 'That photo is empty.' };
  if (bytes > CHAT_IMAGE_MAX_BYTES) {
    return { error: `That photo is too large. Photos can be up to ${sizeLabel(CHAT_IMAGE_MAX_BYTES)}.` };
  }
  return { mime: m[1], base64: m[2] };
}

/** Roles that drop in to their teams' chats rather than belong to them. */
export const CHAT_DROP_IN_ROLES: readonly string[] = ['org_admin', 'director', 'region_admin'];

/** The chats a team role belongs to. */
export function chatChannelsForRole(role: string): ChatChannel[] {
  switch (role) {
    case 'coach':
    case 'assistant':
      return ['all', 'staff', 'coaches'];
    case 'team_parent':
      return ['all', 'staff'];
    case 'parent':
      return ['all'];
    default:
      return [];
  }
}

export function isChatChannel(v: unknown): v is ChatChannel {
  return typeof v === 'string' && (CHAT_CHANNELS as readonly string[]).includes(v);
}

/**
 * Editing: the author only, within 10 minutes of sending, on a paid plan.
 */
export function canEditChatMessage(m: {
  isAuthor: boolean;
  createdAt: Date | string;
  paid: boolean;
  now?: Date;
}): boolean {
  if (!m.isAuthor || !m.paid) return false;
  const age = (m.now ?? new Date()).getTime() - new Date(m.createdAt).getTime();
  return age <= CHAT_EDIT_MINUTES * 60_000;
}

/**
 * Deleting for everyone: the author only, on a paid plan, and only while
 * nobody has reacted or replied. Once people have responded it stays.
 */
export function canDeleteChatMessage(m: {
  isAuthor: boolean;
  paid: boolean;
  reactions: number;
  replies: number;
}): boolean {
  return m.isAuthor && m.paid && m.reactions === 0 && m.replies === 0;
}

/* ----------------------------------------------------------------- polls */

/**
 * Polls in team chat. Creating one is a paid feature (chatPolls); anyone in
 * the chat can vote, on any plan. The person who made it, or a chat
 * moderator, can close it, after which nobody can vote.
 */
export const CHAT_POLL_MIN_OPTIONS = 2;
export const CHAT_POLL_MAX_OPTIONS = 6;
export const CHAT_POLL_QUESTION_MAX = 200;
export const CHAT_POLL_OPTION_MAX = 80;

/** A poll as typed, cleaned up, or the reason it can't be posted. */
export function cleanChatPoll(input: {
  question?: unknown;
  options?: unknown;
  multi?: unknown;
}): { question: string; options: string[]; multi: boolean } | { error: string } {
  const question = String(input.question ?? '').trim().replace(/\s+/g, ' ');
  if (!question) return { error: 'Write the poll question.' };
  if (question.length > CHAT_POLL_QUESTION_MAX) {
    return { error: `Keep the question under ${CHAT_POLL_QUESTION_MAX} characters.` };
  }
  const raw = Array.isArray(input.options) ? input.options : [];
  const options: string[] = [];
  for (const o of raw) {
    const text = String(o ?? '').trim().replace(/\s+/g, ' ');
    if (!text) continue;
    if (text.length > CHAT_POLL_OPTION_MAX) return { error: `Keep each answer under ${CHAT_POLL_OPTION_MAX} characters.` };
    if (options.some((x) => x.toLowerCase() === text.toLowerCase())) return { error: 'Each answer must be different.' };
    options.push(text);
  }
  if (options.length < CHAT_POLL_MIN_OPTIONS) return { error: `Give at least ${CHAT_POLL_MIN_OPTIONS} answers.` };
  if (options.length > CHAT_POLL_MAX_OPTIONS) return { error: `A poll can have up to ${CHAT_POLL_MAX_OPTIONS} answers.` };
  return { question, options, multi: input.multi === true };
}

/**
 * A vote as sent, checked against the poll: answer numbers that exist, one
 * answer unless the poll allows several, and none to take a vote back.
 */
export function cleanChatVote(choices: unknown, poll: { options: number; multi: boolean }): number[] | { error: string } {
  const list = Array.isArray(choices) ? choices : [choices];
  const picked = [...new Set(list.map(Number))].filter((n) => Number.isInteger(n));
  if (picked.some((n) => n < 0 || n >= poll.options)) return { error: 'Pick one of the answers.' };
  if (!poll.multi && picked.length > 1) return { error: 'This poll takes one answer.' };
  return picked.sort((a, b) => a - b);
}

/** A poll's answers as the chat shows them. */
export interface PollTally {
  options: Array<{ text: string; votes: number; voters: string[]; mine: boolean }>;
  /** People who voted, however many answers each picked. */
  voters: number;
}

/**
 * The poll as it reads once the caller's vote is in, so the tap shows at once
 * while the vote is saved. `choices` replaces the caller's last vote; none
 * takes it back.
 */
export function applyPollVote<P extends PollTally>(poll: P, choices: readonly number[], me = 'You'): P {
  const picked = new Set(choices);
  const had = poll.options.some((o) => o.mine);
  return {
    ...poll,
    options: poll.options.map((o, i) => {
      const now = picked.has(i);
      if (now === o.mine) return o;
      return {
        ...o,
        mine: now,
        votes: Math.max(0, o.votes + (now ? 1 : -1)),
        voters: now ? [...o.voters, me] : o.voters.filter((v) => v !== me),
      };
    }),
    voters: Math.max(0, poll.voters - (had ? 1 : 0) + (picked.size > 0 ? 1 : 0)),
  };
}

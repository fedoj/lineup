/**
 * Referees: the three spots on a league game, and the referee code an
 * organization (or standalone region) shares so referees can join it.
 */

export const REFEREE_SLOTS = ['main', 'ar1', 'ar2'] as const;
export type RefereeSlot = (typeof REFEREE_SLOTS)[number];

export const REFEREE_SLOT_LABELS: Record<RefereeSlot, string> = {
  main: 'Main referee',
  ar1: 'Assistant referee 1',
  ar2: 'Assistant referee 2',
};

export function isRefereeSlot(value: unknown): value is RefereeSlot {
  return typeof value === 'string' && (REFEREE_SLOTS as readonly string[]).includes(value);
}

/** What someone typed or pasted, as a code: "ref-7kx2 qpm" -> "REF7KX2QPM". */
export function cleanRefereeCode(raw: unknown): string {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidRefereeCode(code: string): boolean {
  return /^[A-Z0-9]{6,12}$/.test(code);
}

// No 0/O or 1/I, so a code read aloud or off a flyer is not mistyped.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A new 8-character referee code. */
export function newRefereeCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < 8; i++) code += CODE_CHARS[Math.floor(random() * CODE_CHARS.length)];
  return code;
}

/* ------------------------------------------------ the referee's match report */

/**
 * What the main referee records on a league game: goals, own goals, cards and
 * substitutions, each with the minute. The final score the referee submits is
 * the official result and replaces whatever the coaches recorded.
 */
export const REF_EVENT_KINDS = ['goal', 'own_goal', 'yellow', 'red', 'sub'] as const;
export type RefEventKind = (typeof REF_EVENT_KINDS)[number];

export const REF_EVENT_LABELS: Record<RefEventKind, string> = {
  goal: 'Goal',
  own_goal: 'Own goal',
  yellow: 'Yellow card',
  red: 'Red card',
  sub: 'Substitution',
};

export function isRefEventKind(value: unknown): value is RefEventKind {
  return typeof value === 'string' && (REF_EVENT_KINDS as readonly string[]).includes(value);
}

/** Starting, on the bench, or not playing (absent, injured or sent home). */
export const REF_PLAYER_STATUSES = ['start', 'bench', 'absent'] as const;
export type RefPlayerStatus = (typeof REF_PLAYER_STATUSES)[number];

export function isRefPlayerStatus(value: unknown): value is RefPlayerStatus {
  return typeof value === 'string' && (REF_PLAYER_STATUSES as readonly string[]).includes(value);
}

export type RefSide = 'home' | 'away';

/** The score from the referee's events: an own goal counts for the other side. */
export function refScore(events: ReadonlyArray<{ side: RefSide; kind: string }>): { home: number; away: number } {
  let home = 0;
  let away = 0;
  for (const e of events) {
    if (e.kind === 'goal') {
      if (e.side === 'home') home++;
      else away++;
    } else if (e.kind === 'own_goal') {
      if (e.side === 'home') away++;
      else home++;
    }
  }
  return { home, away };
}

/**
 * The minute shown for an event, counted like a referee's watch: the first
 * minute of the game is 1. Earlier periods count in full.
 */
export function refMinute(periodIndex: number, elapsedSec: number, periodLengthSec: number): number {
  const total = Math.max(0, periodIndex) * Math.max(60, periodLengthSec) + Math.max(0, elapsedSec);
  return Math.min(200, Math.floor(total / 60) + 1);
}

/** A minute typed in by hand: a whole number from 1 to 200, or none. */
export function cleanRefMinute(value: unknown): number | null | { error: string } {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 200) return { error: 'The minute must be a number from 1 to 200.' };
  return n;
}

/** A final score typed by the referee: 0 to 99 for each side. */
export function cleanRefScore(home: unknown, away: unknown): { home: number; away: number } | { error: string } {
  const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === '';
  const h = Number(home);
  const a = Number(away);
  if (blank(home) || blank(away) || !Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0 || h > 99 || a > 99) {
    return { error: 'Enter the final score for both teams (0 to 99).' };
  }
  return { home: h, away: a };
}

/** Who took part: everyone who started, and everyone who came on as a sub. */
export function playersWhoPlayed(starters: Iterable<string>, subsOn: Iterable<string | null | undefined>): Set<string> {
  const out = new Set(starters);
  for (const id of subsOn) if (id) out.add(id);
  return out;
}

/**
 * Practice rules, shared by the API and the app.
 *
 * Coaches and assistant coaches set a practice schedule; the free plan covers
 * up to 100 days at a time (extendedPractice for longer). Parents check their
 * child in as soon as a practice is on the schedule, until it starts, and the
 * check-in is the practice attendance. Marking attendance by hand is a paid
 * feature (manualAttendance).
 */

/** Longest practice schedule on the free plan, in days. */
export const PRACTICE_FREE_DAYS = 100;
/** Practices listed for check-in, soonest first. */
export const PRACTICE_CHECKIN_LIST = 40;
/** Safety cap on practices made from one schedule. */
export const PRACTICE_MAX_PER_SCHEDULE = 400;

/**
 * Why a practice or a game is cancelled. Rain, heat and lightning are one
 * "weather" reason (10/14); older apps may still send them, and they map to
 * weather.
 */
export type CancelReason = 'weather' | 'field' | 'emergency' | 'other';
export type PracticeCancelReason = CancelReason;

export const CANCEL_REASONS: ReadonlyArray<[CancelReason, string]> = [
  ['weather', 'Weather (rain, heat, lightning)'],
  ['field', 'Field closed'],
  ['emergency', 'Emergency'],
  ['other', 'Other'],
];
export const PRACTICE_CANCEL_REASONS = CANCEL_REASONS;

const WEATHER_WORDS = ['rain', 'heat', 'lightning'];

/** A cancel reason as sent, legacy weather words included; null if unknown. */
export function cancelReasonOf(v: unknown): CancelReason | null {
  if (typeof v !== 'string') return null;
  if (WEATHER_WORDS.includes(v)) return 'weather';
  return CANCEL_REASONS.some(([k]) => k === v) ? (v as CancelReason) : null;
}

export function isPracticeCancelReason(v: unknown): v is PracticeCancelReason {
  return CANCEL_REASONS.some(([k]) => k === v);
}

/** The short label shown on a cancelled game or practice. */
export function cancelLabel(reason: string | null | undefined): string {
  const r = cancelReasonOf(reason);
  if (r === 'weather') return 'Weather';
  return CANCEL_REASONS.find(([k]) => k === r)?.[1] ?? 'Cancelled';
}

const DAY_MS = 86_400_000;

function parseDay(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Days in a schedule, counting both ends: Oct 1 to Oct 1 is 1 day. */
export function scheduleLengthDays(startsOn: string, endsOn: string): number {
  return Math.round((parseDay(endsOn) - parseDay(startsOn)) / DAY_MS) + 1;
}

/**
 * Every date from startsOn to endsOn (inclusive) that falls on one of the
 * given weekdays (0 = Sunday ... 6 = Saturday), as YYYY-MM-DD.
 */
export function practiceDates(startsOn: string, endsOn: string, days: readonly number[]): string[] {
  const want = new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  const out: string[] = [];
  for (let t = parseDay(startsOn); t <= parseDay(endsOn) && out.length < PRACTICE_MAX_PER_SCHEDULE; t += DAY_MS) {
    const d = new Date(t);
    if (want.has(d.getUTCDay())) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Seasons and tournaments (Fady, 10/16): standalone objects with a name,
 * start and end dates and the teams taking part. Games scheduled in one show
 * on every participating team's calendar; its standings count only its games.
 * It is read-only from the day after its end date, and is deleted
 * COMPETITION_KEEP_MONTHS months after that.
 */

export type CompetitionKind = 'season' | 'tournament';
export type CompetitionStatus = 'upcoming' | 'active' | 'archived';

export const COMPETITION_KINDS: ReadonlyArray<[CompetitionKind, string]> = [
  // Stored as 'season'; shown as League (Fady, 10/16: a season and a league are the same thing).
  ['season', 'League'],
  ['tournament', 'Tournament'],
];

export const COMPETITION_NAME_MAX = 80;
export const COMPETITION_KEEP_MONTHS = 3;

/** Upcoming before its start date, active through its end date, archived after. */
export function competitionStatus(startsOn: string, endsOn: string, today: string): CompetitionStatus {
  if (today < startsOn) return 'upcoming';
  if (today <= endsOn) return 'active';
  return 'archived';
}

/** The day an archived season or tournament is deleted (YYYY-MM-DD). */
export function competitionDeleteOn(endsOn: string, months = COMPETITION_KEEP_MONTHS): string {
  const [y, m, d] = endsOn.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last) + 1);
  return target.toISOString().slice(0, 10);
}

/** A season or tournament as typed in, checked; or why it can't be saved. */
export function cleanCompetition(raw: {
  kind?: unknown;
  name?: unknown;
  startsOn?: unknown;
  endsOn?: unknown;
}): { kind: CompetitionKind; name: string; startsOn: string; endsOn: string } | { error: string } {
  const kind = raw.kind === 'tournament' ? 'tournament' : raw.kind === 'season' ? 'season' : null;
  if (!kind) return { error: 'Pick a league or a tournament.' };
  const name = String(raw.name ?? '').replace(/\s+/g, ' ').trim();
  if (!name) return { error: 'Give it a name, for example "Fall 2026".' };
  if (name.length > COMPETITION_NAME_MAX) return { error: `Use up to ${COMPETITION_NAME_MAX} characters for the name.` };
  const date = /^\d{4}-\d{2}-\d{2}$/;
  const startsOn = String(raw.startsOn ?? '');
  const endsOn = String(raw.endsOn ?? '');
  if (!date.test(startsOn) || !date.test(endsOn)) return { error: 'Pick a start date and an end date.' };
  if (endsOn < startsOn) return { error: 'The end date must be on or after the start date.' };
  return { kind, name, startsOn, endsOn };
}

/** Days after a league or tournament ends during which its games can still be changed (Fady, 10/16). */
export const GAME_LOCK_DAYS = 3;

/** The day a league's or tournament's games lock (YYYY-MM-DD): GAME_LOCK_DAYS after it ends. */
export function gameLockDay(endsOn: string): string {
  const d = new Date(`${endsOn}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + GAME_LOCK_DAYS + 1);
  return d.toISOString().slice(0, 10);
}

/** Are a league's or tournament's games locked on `today` (no score, lineup or event changes)? */
export function isGameLocked(endsOn: string | null | undefined, today: string): boolean {
  return Boolean(endsOn) && today >= gameLockDay(endsOn!);
}

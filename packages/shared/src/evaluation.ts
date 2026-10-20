/**
 * Player evaluation: a coach rates each player 1 to 10 in seven categories,
 * plus their strong foot. The overall rating is the average of the
 * categories that have been rated, so a partly filled evaluation still
 * gives a fair number.
 *
 * The player card (Fady, 10/16) shows it FIFA-style: an overall out of 99 and
 * six stats out of 99 (pace, shooting, passing, dribbling, defending and
 * teamwork, which is teamwork and effort together), on a bronze, silver or
 * gold card. Ratings saved on the old 1 to 5 scale were doubled (migration 044).
 */

export const EVALUATION_CATEGORIES = [
  ['ballControl', 'Ball control'],
  ['passing', 'Passing'],
  ['shooting', 'Shooting'],
  ['defending', 'Defending'],
  ['speed', 'Speed'],
  ['teamwork', 'Teamwork'],
  ['effort', 'Effort'],
] as const;

/** Highest score in a category. */
export const EVALUATION_MAX = 10;

export type EvaluationCategory = (typeof EVALUATION_CATEGORIES)[number][0];

export type EvaluationScores = Partial<Record<EvaluationCategory, number>>;

export type StrongFoot = 'left' | 'right' | 'both';

export const STRONG_FEET: readonly StrongFoot[] = ['left', 'right', 'both'];

const CATEGORY_IDS = EVALUATION_CATEGORIES.map(([id]) => id) as readonly string[];

/** Keep only known categories with whole-number scores from 1 to 10. */
export function cleanScores(raw: unknown): EvaluationScores {
  const out: EvaluationScores = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = typeof v === 'number' ? v : Number(v);
    if (CATEGORY_IDS.includes(k) && Number.isInteger(n) && n >= 1 && n <= EVALUATION_MAX) {
      out[k as EvaluationCategory] = n;
    }
  }
  return out;
}

/** Average of the rated categories (1 to 10), to one decimal; null when nothing is rated. */
export function overallRating(scores: EvaluationScores): number | null {
  const values = Object.values(cleanScores(scores));
  if (values.length === 0) return null;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.round(avg * 10) / 10;
}

/** A 1 to 10 score as a card number out of 99 (10 is 99, 5 is 50). */
export function toCardNumber(score: number): number {
  return Math.max(1, Math.min(99, Math.round(score * 9.9)));
}

/** The card's big number, out of 99; null when nothing is rated. */
export function cardRating(scores: EvaluationScores): number | null {
  const o = overallRating(scores);
  return o === null ? null : toCardNumber(o);
}

export const CARD_STATS = [
  ['PAC', 'Pace'],
  ['SHO', 'Shooting'],
  ['PAS', 'Passing'],
  ['DRI', 'Dribbling'],
  ['DEF', 'Defending'],
  ['TEA', 'Teamwork'],
] as const;

export type CardStat = (typeof CARD_STATS)[number][0];

/** The six card stats out of 99 (null where not rated). */
export function cardStats(scores: EvaluationScores): Record<CardStat, number | null> {
  const s = cleanScores(scores);
  const one = (v: number | undefined) => (v === undefined ? null : toCardNumber(v));
  const team = [s.teamwork, s.effort].filter((v): v is number => v !== undefined);
  return {
    PAC: one(s.speed),
    SHO: one(s.shooting),
    PAS: one(s.passing),
    DRI: one(s.ballControl),
    DEF: one(s.defending),
    TEA: team.length ? toCardNumber(team.reduce((a, b) => a + b, 0) / team.length) : null,
  };
}

export type CardTier = 'bronze' | 'silver' | 'gold';

/** FIFA colours: gold from 75, silver from 65, bronze below. */
export function cardTier(rating: number | null): CardTier {
  if (rating !== null && rating >= 75) return 'gold';
  if (rating !== null && rating >= 65) return 'silver';
  return 'bronze';
}

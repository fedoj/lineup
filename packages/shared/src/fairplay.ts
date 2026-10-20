/**
 * Fair play — automatic lineup assignment that spreads playing time evenly.
 *
 * Ported from the v1 `autoFill` routine, with four changes that matter:
 *
 *   1. Absent players are excluded up front rather than filtered at render.
 *   2. Formations may differ per period, so slots are resolved per period.
 *   3. The tie-break is a seeded PRNG, not Math.random, so a given input
 *      always produces the same lineup — testable, and a coach pressing
 *      "auto" twice doesn't get a different answer by accident.
 *   4. It returns a fairness report instead of only mutating state.
 *
 * Priority when choosing who plays the next period:
 *   fewest periods played  ->  sat out last period  ->  seeded shuffle
 *
 * The keeper is chosen from the players already selected to play, favouring
 * whoever has kept least. Outfield slots favour players who have spent least
 * time in that position, so nobody is parked at left back all game.
 */

import {
  slotsForFormation,
  type Format,
  type Slot,
} from './formations.js';
import { playerSlotAffinity } from './positions.js';

export interface FairPlayer {
  id: string;
  /** Shown in the report; not used for decisions. */
  name?: string;
  /** Excluded entirely when false — absent, injured, not showing up. */
  available: boolean;
  /** Keeps this player out of goal (a coach override). */
  neverKeeper?: boolean;
  /** Preferred position, used only as a soft bias. */
  primaryPos?: string | null;
  secondaryPos?: string | null;
}

export interface FairPlayInput {
  players: readonly FairPlayer[];
  format: Format;
  /** Number of periods: 2 for halves, 4 for quarters. */
  periods: number;
  /** Formation per period. A single entry applies to every period. */
  formations: readonly string[];
  /** Any seed gives a repeatable result. */
  seed?: number;
  /** Periods already played, carried in so a mid-game re-run stays fair. */
  priorPlayed?: Record<string, number>;
  priorKeeper?: Record<string, number>;
}

/** periodIndex -> slotId -> playerId */
export type Assignments = Record<string, Record<string, string>>;

export interface PlayerFairness {
  playerId: string;
  name?: string;
  periodsPlayed: number;
  periodsBenched: number;
  keeperPeriods: number;
  positions: Record<string, number>;
  /** Longest run of consecutive benched periods. */
  longestBenchRun: number;
}

export interface FairPlayResult {
  assignments: Assignments;
  fairness: PlayerFairness[];
  /** max(periodsPlayed) - min(periodsPlayed). 0 or 1 is fair. */
  spread: number;
  /** Players on the pitch per period. */
  onPitch: number;
  warnings: string[];
}

/** Mulberry32 — small, fast, deterministic. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleTieBreak<T>(items: T[], rng: () => number): T[] {
  return items
    .map((v) => ({ v, k: rng() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.v);
}

/**
 * Build a fair lineup across every period.
 *
 * Throws nothing: an impossible request (too few players) comes back as a
 * warning with whatever assignment could be made, because a coach standing on
 * a touchline needs a partial answer, not an exception.
 */
export function buildFairLineup(input: FairPlayInput): FairPlayResult {
  const rng = makeRng(input.seed ?? 1);
  const squad = input.players.filter((p) => p.available);
  const warnings: string[] = [];

  const slotsByPeriod: Slot[][] = [];
  for (let p = 0; p < input.periods; p++) {
    const formation = input.formations[p] ?? input.formations[0];
    slotsByPeriod.push(slotsForFormation(input.format, formation));
  }
  const onPitch = slotsByPeriod[0]?.length ?? 0;

  const played: Record<string, number> = {};
  const keeperCount: Record<string, number> = {};
  const benched: Record<string, number> = {};
  const benchRun: Record<string, number> = {};
  const longestBenchRun: Record<string, number> = {};
  const satOutLast: Record<string, boolean> = {};
  const posHistory: Record<string, Record<string, number>> = {};

  for (const p of squad) {
    played[p.id] = input.priorPlayed?.[p.id] ?? 0;
    keeperCount[p.id] = input.priorKeeper?.[p.id] ?? 0;
    benched[p.id] = 0;
    benchRun[p.id] = 0;
    longestBenchRun[p.id] = 0;
    satOutLast[p.id] = false;
    posHistory[p.id] = {};
  }

  const assignments: Assignments = {};

  /**
   * Rank a candidate for one slot. Lower wins.
   *
   * Base is how many times they have already filled this position, so rotation
   * still drives the choice. Affinity then shifts a candidate by at most
   * `POSITION_BIAS` of a rotation step, which is enough to pick the natural
   * left back out of two equally-rotated players but never enough to park
   * somebody in one position all game.
   */
  const POSITION_BIAS = 0.9;
  const slotScore = (p: FairPlayer, slot: Slot): number => {
    const timesHere = posHistory[p.id][slot.pos] ?? 0;
    const affinity = playerSlotAffinity(p.primaryPos, p.secondaryPos, slot);
    return timesHere - affinity * POSITION_BIAS;
  };

  if (squad.length === 0) {
    warnings.push('No available players.');
    return { assignments, fairness: [], spread: 0, onPitch, warnings };
  }
  if (squad.length < onPitch) {
    warnings.push(
      `Only ${squad.length} available but ${onPitch} needed — some positions will be empty.`,
    );
  }

  for (let p = 0; p < input.periods; p++) {
    const slots = slotsByPeriod[p];
    const need = Math.min(slots.length, squad.length);
    const keeperSlot = slots.find((s) => s.isKeeper);
    const periodAssign: Record<string, string> = {};

    // Pick the keeper BEFORE the outfield pool. Choosing the pool first can
    // bench the only keeper-eligible player, which then forces a never-keeper
    // into goal. Selecting here guarantees the constraint is satisfiable.
    let keeper: FairPlayer | undefined;
    if (keeperSlot && need > 0) {
      const eligible = squad.filter((x) => !x.neverKeeper);
      const pickFrom = eligible.length > 0 ? eligible : squad;
      if (eligible.length === 0) {
        warnings.push(`Period ${p + 1}: every available player is marked never-keeper.`);
      }
      // Fewest keeper periods, then fewest periods played, then seeded.
      // A declared keeper carries a bonus worth half a turn, so they get the
      // gloves roughly twice as often as the rest without monopolising them.
      const GK_BIAS = 0.5;
      const keeperScore = (x: FairPlayer) =>
        keeperCount[x.id] -
        (x.primaryPos === 'GK' ? GK_BIAS : x.secondaryPos === 'GK' ? GK_BIAS * 0.6 : 0);

      keeper = shuffleTieBreak([...pickFrom], rng).sort((a, b) => {
        const sa = keeperScore(a);
        const sb = keeperScore(b);
        if (sa !== sb) return sa - sb;
        return played[a.id] - played[b.id];
      })[0];
    }

    // Who else plays: least minutes first, then anyone who just sat, then seeded.
    const rest = squad.filter((x) => x.id !== keeper?.id);
    const pool = shuffleTieBreak(rest, rng).sort((a, b) => {
      if (played[a.id] !== played[b.id]) return played[a.id] - played[b.id];
      if (satOutLast[a.id] !== satOutLast[b.id]) return satOutLast[a.id] ? -1 : 1;
      return 0;
    });

    const outfieldNeed = keeper ? need - 1 : need;
    const outfield = pool.slice(0, Math.max(0, outfieldNeed));
    const resting = pool.slice(Math.max(0, outfieldNeed));
    const playing = keeper ? [keeper, ...outfield] : outfield;

    if (keeper && keeperSlot) {
      periodAssign[keeperSlot.id] = keeper.id;
      keeperCount[keeper.id]++;
      posHistory[keeper.id]['GK'] = (posHistory[keeper.id]['GK'] ?? 0) + 1;
    }

    // Outfield: balance how often each player has had this position against
    // how well it suits them. Position preference is a BIAS, never a filter —
    // if the whole squad declares itself a striker, every candidate scores the
    // same and this quietly degrades to the old rotation-only behaviour.
    const remaining = [...outfield];
    for (const slot of slots.filter((s) => !s.isKeeper)) {
      if (remaining.length === 0) break;
      const ranked = shuffleTieBreak([...remaining], rng).sort((a, b) => {
        const sa = slotScore(a, slot);
        const sb = slotScore(b, slot);
        // Lower is better: times already played here, minus a preference bonus.
        return sa - sb;
      });
      const pick = ranked[0];
      remaining.splice(remaining.indexOf(pick), 1);
      periodAssign[slot.id] = pick.id;
      posHistory[pick.id][slot.pos] = (posHistory[pick.id][slot.pos] ?? 0) + 1;
    }

    assignments[String(p)] = periodAssign;

    for (const x of playing) {
      played[x.id]++;
      satOutLast[x.id] = false;
      benchRun[x.id] = 0;
    }
    for (const x of resting) {
      benched[x.id]++;
      satOutLast[x.id] = true;
      benchRun[x.id]++;
      longestBenchRun[x.id] = Math.max(longestBenchRun[x.id], benchRun[x.id]);
    }
  }

  const fairness: PlayerFairness[] = squad.map((p) => ({
    playerId: p.id,
    name: p.name,
    periodsPlayed: played[p.id],
    periodsBenched: benched[p.id],
    keeperPeriods: keeperCount[p.id],
    positions: posHistory[p.id],
    longestBenchRun: longestBenchRun[p.id],
  }));

  const counts = fairness.map((f) => f.periodsPlayed);
  const spread = counts.length ? Math.max(...counts) - Math.min(...counts) : 0;
  if (spread > 1) {
    warnings.push(`Playing time spread is ${spread} periods.`);
  }

  return { assignments, fairness, spread, onPitch, warnings };
}

/**
 * Strip absent players out of an existing lineup, leaving their slots empty
 * for the coach to refill. Used when someone is marked absent on matchday
 * after the lineup was already built.
 */
export function removeUnavailable(
  assignments: Assignments,
  unavailablePlayerIds: readonly string[],
): { assignments: Assignments; removed: number } {
  const gone = new Set(unavailablePlayerIds);
  const next: Assignments = {};
  let removed = 0;

  for (const [period, slots] of Object.entries(assignments)) {
    next[period] = {};
    for (const [slotId, playerId] of Object.entries(slots)) {
      if (gone.has(playerId)) {
        removed++;
        continue;
      }
      next[period][slotId] = playerId;
    }
  }
  return { assignments: next, removed };
}

/**
 * Copy a lineup from another game, keeping only players still on the roster
 * and available, and only slots that exist in the target formation.
 */
export function copyLineup(
  source: Assignments,
  opts: {
    format: Format;
    formations: readonly string[];
    periods: number;
    eligiblePlayerIds: readonly string[];
  },
): { assignments: Assignments; dropped: string[] } {
  const eligible = new Set(opts.eligiblePlayerIds);
  const dropped: string[] = [];
  const next: Assignments = {};

  for (let p = 0; p < opts.periods; p++) {
    const formation = opts.formations[p] ?? opts.formations[0];
    const validSlots = new Set(
      slotsForFormation(opts.format, formation).map((s) => s.id),
    );
    const from = source[String(p)] ?? {};
    next[String(p)] = {};

    for (const [slotId, playerId] of Object.entries(from)) {
      if (!validSlots.has(slotId)) continue;
      if (!eligible.has(playerId)) {
        if (!dropped.includes(playerId)) dropped.push(playerId);
        continue;
      }
      next[String(p)][slotId] = playerId;
    }
  }
  return { assignments: next, dropped };
}

/**
 * Whether a game counts towards the season record and playing time. A game
 * dated before today has been played; so has any game with a score. A game
 * today or later with no score is still to come, even with a lineup planned.
 */
export function isGamePlayed(
  date: string | null | undefined,
  us: number,
  them: number,
  today: string,
): boolean {
  if (us + them > 0) return true;
  return Boolean(date) && date! < today;
}

/** A substitution made during a period (planned on match day and marked done). */
export interface DoneSub {
  periodIndex: number;
  atSec: number;
  offPlayerId: string;
  onPlayerId: string;
}

/**
 * Seconds played per player, for the analytics page. Each period's lineup
 * counts in full; a sub made during a period moves the rest of that period
 * from the player going off to the player coming on.
 */
export function minutesFromAssignments(
  assignments: Assignments,
  periodLengthSec: number,
  subs: readonly DoneSub[] = [],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const slots of Object.values(assignments)) {
    for (const playerId of Object.values(slots)) {
      out[playerId] = (out[playerId] ?? 0) + periodLengthSec;
    }
  }
  for (const s of subs) {
    const onPitch = Object.values(assignments[String(s.periodIndex)] ?? {});
    if (!onPitch.includes(s.offPlayerId) || onPitch.includes(s.onPlayerId)) continue;
    const rest = Math.max(0, periodLengthSec - Math.min(Math.max(0, s.atSec), periodLengthSec));
    out[s.offPlayerId] = Math.max(0, (out[s.offPlayerId] ?? 0) - rest);
    out[s.onPlayerId] = (out[s.onPlayerId] ?? 0) + rest;
  }
  return out;
}

/** Due planned subs: not done or skipped, and the period clock has reached them. */
export function dueSubs<T extends { periodIndex: number; atSec: number; done: boolean; skipped: boolean }>(
  subs: readonly T[],
  periodIndex: number,
  elapsedSec: number,
): T[] {
  return subs.filter((s) => s.periodIndex === periodIndex && !s.done && !s.skipped && s.atSec <= elapsedSec);
}

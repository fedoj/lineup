/**
 * Tournament brackets (Fady, 10/16): single elimination, seeded so the top
 * seeds meet last, byes for the top seeds when the field is not a power of
 * two, and an optional third-place game. Teams can be on Lineup (teamId) or
 * typed in by name. Pure functions; the API stores round one and the results,
 * and everything after round one is worked out from them.
 */

export interface BracketEntry {
  /** A team on Lineup; absent for a team typed in by name. */
  teamId?: string | null;
  name: string;
  /** A place still to be decided, e.g. "Winner Group A" while the group plays. */
  pending?: boolean;
}

export interface BracketSlot {
  round: number;
  slot: number;
  thirdPlace: boolean;
  home: BracketEntry | null;
  away: BracketEntry | null;
}

export type BracketSide = 'home' | 'away';

/** Most teams in one bracket. */
export const BRACKET_MAX_TEAMS = 64;

/** The bracket size for `n` teams: the next power of two, at least 2. */
export function bracketSize(n: number): number {
  let size = 2;
  while (size < n) size *= 2;
  return size;
}

/** Rounds in a bracket of `size` (2 → 1 round, 8 → 3). */
export function bracketRounds(size: number): number {
  return Math.round(Math.log2(size));
}

/**
 * Seed numbers in bracket order for a power-of-two size: consecutive pairs
 * meet in round one, so 1 plays the lowest seed and 1 and 2 can only meet in
 * the final. 4 → [1, 4, 2, 3]; 8 → [1, 8, 4, 5, 2, 7, 3, 6].
 */
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order;
}

/** "Final", "Semi-finals", "Quarter-finals", "Round of 16"... */
export function roundName(round: number, rounds: number, thirdPlace = false): string {
  if (thirdPlace) return 'Third place';
  const left = rounds - round;
  if (left === 0) return 'Final';
  if (left === 1) return 'Semi-finals';
  if (left === 2) return 'Quarter-finals';
  return `Round of ${2 ** (left + 1)}`;
}

/**
 * Every match of a new bracket, entries in seed order (best first). Round one
 * is filled in; later rounds wait for winners. Throws on fewer than 2 or more
 * than BRACKET_MAX_TEAMS entries.
 */
export function buildBracket(entries: readonly BracketEntry[], thirdPlace: boolean): BracketSlot[] {
  if (entries.length < 2) throw new Error('A bracket needs at least 2 teams.');
  if (entries.length > BRACKET_MAX_TEAMS) throw new Error(`A bracket takes at most ${BRACKET_MAX_TEAMS} teams.`);
  const size = bracketSize(entries.length);
  const rounds = bracketRounds(size);
  const order = seedOrder(size);
  const out: BracketSlot[] = [];
  for (let i = 0; i < size / 2; i++) {
    out.push({
      round: 1,
      slot: i,
      thirdPlace: false,
      home: entries[order[2 * i] - 1] ?? null,
      away: entries[order[2 * i + 1] - 1] ?? null,
    });
  }
  for (let r = 2; r <= rounds; r++) {
    for (let i = 0; i < size / 2 ** r; i++) out.push({ round: r, slot: i, thirdPlace: false, home: null, away: null });
  }
  if (thirdPlace && rounds >= 2) out.push({ round: rounds, slot: 0, thirdPlace: true, home: null, away: null });
  return out;
}

export interface BracketMatchIn {
  id: string;
  round: number;
  slot: number;
  thirdPlace: boolean;
  /** Stored for round one only. */
  home: BracketEntry | null;
  away: BracketEntry | null;
  /** Set by hand (for example after penalties); wins over the score. */
  winnerOverride: BracketSide | null;
  /** The played game's score from the home side, if any. */
  result: { home: number; away: number } | null;
}

export interface BracketMatchOut {
  id: string;
  round: number;
  slot: number;
  thirdPlace: boolean;
  home: BracketEntry | null;
  away: BracketEntry | null;
  winner: BracketSide | null;
  /** How the winner was decided. */
  decidedBy: 'bye' | 'score' | 'hand' | null;
}

/**
 * Who plays in every match and who won: round one as stored, later rounds
 * from the winners before them, the third-place game from the semi-final
 * losers. A bye goes through on its own; a draw waits for a winner by hand.
 */
export function resolveBracket(matches: readonly BracketMatchIn[]): BracketMatchOut[] {
  const rounds = Math.max(1, ...matches.filter((m) => !m.thirdPlace).map((m) => m.round));
  const byKey = new Map<string, BracketMatchOut>();
  const key = (round: number, slot: number) => `${round}:${slot}`;
  const sorted = [...matches].sort((a, b) => a.round - b.round || Number(a.thirdPlace) - Number(b.thirdPlace) || a.slot - b.slot);
  const out: BracketMatchOut[] = [];

  const winnerOf = (m: BracketMatchOut | undefined): BracketEntry | null =>
    m && m.winner ? (m.winner === 'home' ? m.home : m.away) : null;
  const loserOf = (m: BracketMatchOut | undefined): BracketEntry | null => {
    if (!m || !m.winner || m.decidedBy === 'bye') return null;
    return m.winner === 'home' ? m.away : m.home;
  };

  for (const m of sorted) {
    let home: BracketEntry | null;
    let away: BracketEntry | null;
    if (m.thirdPlace) {
      home = loserOf(byKey.get(key(rounds - 1, 0)));
      away = loserOf(byKey.get(key(rounds - 1, 1)));
    } else if (m.round === 1) {
      home = m.home;
      away = m.away;
    } else {
      home = winnerOf(byKey.get(key(m.round - 1, 2 * m.slot)));
      away = winnerOf(byKey.get(key(m.round - 1, 2 * m.slot + 1)));
    }

    let winner: BracketSide | null = null;
    let decidedBy: BracketMatchOut['decidedBy'] = null;
    if (home?.pending || away?.pending) {
      // Waiting for a group to finish.
    } else if (m.round === 1 && !m.thirdPlace && (home === null) !== (away === null)) {
      winner = home ? 'home' : 'away';
      decidedBy = 'bye';
    } else if (home && away) {
      if (m.winnerOverride) {
        winner = m.winnerOverride;
        decidedBy = 'hand';
      } else if (m.result && m.result.home !== m.result.away) {
        winner = m.result.home > m.result.away ? 'home' : 'away';
        decidedBy = 'score';
      }
    }
    const done: BracketMatchOut = { id: m.id, round: m.round, slot: m.slot, thirdPlace: m.thirdPlace, home, away, winner, decidedBy };
    if (!m.thirdPlace) byKey.set(key(m.round, m.slot), done);
    out.push(done);
  }
  return out;
}

/** Trim a typed team name; null when empty. */
export function cleanEntryName(raw: unknown): string | null {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  return name || null;
}

/* ------------------------------------------------------------ group stage */

/** Teams per group a tournament can choose, and how many may go through. */
export const GROUP_SIZES = [3, 4, 5, 6] as const;

/** "A", "B", ... for group n (0-based). */
export function groupLabel(i: number): string {
  return String.fromCharCode(65 + i);
}

/**
 * Split seeded entries (best first) into groups of about `perGroup`, snake
 * style so each group gets a fair mix: A gets seed 1, B seed 2, ... then the
 * order turns back. Every group has at least 2 teams.
 */
export function makeGroups<T>(entries: readonly T[], perGroup: number): T[][] {
  const per = Math.max(2, Math.floor(perGroup));
  if (entries.length < 3) throw new Error('A group stage needs at least 3 teams.');
  let count = Math.max(1, Math.ceil(entries.length / per));
  while (count > 1 && Math.floor(entries.length / count) < 2) count -= 1;
  const groups: T[][] = Array.from({ length: count }, () => []);
  entries.forEach((e, i) => {
    const lap = Math.floor(i / count);
    const pos = i % count;
    groups[lap % 2 === 0 ? pos : count - 1 - pos].push(e);
  });
  return groups;
}

/**
 * Everyone plays everyone once (circle method). Returns [home, away, matchday]
 * index triples; matchdays start at 1.
 */
export function roundRobin(n: number): Array<[number, number, number]> {
  const ids = Array.from({ length: n % 2 ? n + 1 : n }, (_, i) => i);
  const bye = n % 2 ? n : -1;
  const out: Array<[number, number, number]> = [];
  const days = ids.length - 1;
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < ids.length / 2; i++) {
      const a = ids[i];
      const b = ids[ids.length - 1 - i];
      if (a === bye || b === bye) continue;
      // Alternate home and away so nobody is always at home.
      out.push(d % 2 === 0 ? [a, b, d + 1] : [b, a, d + 1]);
    }
    ids.splice(1, 0, ids.pop()!);
  }
  return out;
}

export interface GroupRow<T> {
  entry: T;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
  gd: number;
  pts: number;
}

/**
 * A group's table from its results (3 points a win, 1 a draw; then goal
 * difference, goals scored, the result between them, seed). Entries are
 * matched by index; `complete` once every match has a result.
 */
export function groupTable<T>(
  entries: readonly T[],
  matches: ReadonlyArray<{ home: number; away: number; result: { home: number; away: number } | null }>,
): { rows: Array<GroupRow<T>>; complete: boolean } {
  const rows = entries.map((entry) => ({ entry, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, pts: 0 }));
  for (const m of matches) {
    if (!m.result) continue;
    const h = rows[m.home];
    const a = rows[m.away];
    if (!h || !a) continue;
    h.played++;
    a.played++;
    h.gf += m.result.home;
    h.ga += m.result.away;
    a.gf += m.result.away;
    a.ga += m.result.home;
    if (m.result.home > m.result.away) {
      h.won++;
      a.lost++;
      h.pts += 3;
    } else if (m.result.home < m.result.away) {
      a.won++;
      h.lost++;
      a.pts += 3;
    } else {
      h.drawn++;
      a.drawn++;
      h.pts++;
      a.pts++;
    }
  }
  for (const r of rows) r.gd = r.gf - r.ga;
  const headToHead = (x: number, y: number) => {
    let s = 0;
    for (const m of matches) {
      if (!m.result) continue;
      if (m.home === x && m.away === y) s += Math.sign(m.result.home - m.result.away);
      if (m.home === y && m.away === x) s += Math.sign(m.result.away - m.result.home);
    }
    return s;
  };
  const order = rows.map((_, i) => i);
  order.sort((x, y) => {
    const a = rows[x];
    const b = rows[y];
    return b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || -headToHead(x, y) || x - y;
  });
  return { rows: order.map((i) => rows[i]), complete: matches.length > 0 && matches.every((m) => m.result) };
}

/**
 * The knockout's places from the groups, best first: every group winner, then
 * every runner-up, and so on ("A1", "B1", "A2", "B2"), so winners get the byes
 * and meet runners-up of other groups.
 */
export function groupPlaces(groupCount: number, advance: number): string[] {
  const out: string[] = [];
  for (let place = 1; place <= advance; place++) {
    for (let g = 0; g < groupCount; g++) out.push(`${groupLabel(g)}${place}`);
  }
  return out;
}

/** "Winner Group A", "2nd Group B"... */
export function placeName(ref: string): string {
  const group = ref.slice(0, 1);
  const place = Number(ref.slice(1));
  const nth = place === 1 ? 'Winner' : place === 2 ? '2nd' : place === 3 ? '3rd' : `${place}th`;
  return `${nth} Group ${group}`;
}

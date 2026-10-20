import type { HttpResponseInit } from '@azure/functions';
import {
  buildBracket,
  cleanEntryName,
  groupLabel,
  groupPlaces,
  groupTable,
  isGamePlayed,
  makeGroups,
  placeName,
  resolveBracket,
  roundName,
  roundRobin,
  type BracketEntry,
  type BracketMatchIn,
} from '@lineup/shared';
import { query, queryOne, transaction } from './db.js';
import { enforceTeamScopedLimit } from './entitlements.js';
import { appToday } from './today.js';
import type { CompetitionRow } from '../functions/competitions.js';
import { insertLeagueGame, insertTeamGame } from '../functions/league.js';

/**
 * Tournament brackets (Fady, 10/16), stored in competition_match: an optional
 * group stage (everyone in a group plays everyone once) and a knockout. Who
 * plays after the knockout's first round, which group places go through, and
 * who won are worked out on every read (packages/shared/src/bracket.ts) from
 * the stored first round, the games' scores (or scores entered by hand) and
 * winners set by hand.
 */

interface MatchRow {
  id: string;
  stage: 'group' | 'knockout';
  group_label: string | null;
  round: number;
  slot: number;
  third_place: boolean;
  home_team_id: string | null;
  home_name: string | null;
  away_team_id: string | null;
  away_name: string | null;
  home_ref: string | null;
  away_ref: string | null;
  home_seed: number | null;
  away_seed: number | null;
  home_score: number | null;
  away_score: number | null;
  winner_override: 'home' | 'away' | null;
  date: string | null;
  kickoff: string | null;
  location: string | null;
  fixture_id: string | null;
  home_game_id: string | null;
  away_game_id: string | null;
}

interface GameRow {
  id: string;
  team_id: string;
  fixture_id: string | null;
  fixture_home: string | null;
  us: number;
  them: number;
  date: string | null;
  canceled: boolean;
}

const MATCH_COLUMNS = `id, stage, group_label, round, slot, third_place, home_team_id, home_name, away_team_id, away_name,
  home_ref, away_ref, home_seed, away_seed, home_score, away_score, winner_override,
  to_char(date, 'YYYY-MM-DD') AS date, kickoff, location, fixture_id, home_game_id, away_game_id`;

type Score = { home: number; away: number };

async function bracketState(competitionId: string) {
  const rows = await query<MatchRow>(
    `SELECT ${MATCH_COLUMNS} FROM competition_match WHERE competition_id = $1
      ORDER BY stage, group_label NULLS LAST, round, third_place, slot`,
    [competitionId],
  );
  if (!rows.length) return null;
  const gameIds = rows.flatMap((r) => [r.home_game_id, r.away_game_id]).filter((x): x is string => Boolean(x));
  const fixtureIds = rows.map((r) => r.fixture_id).filter((x): x is string => Boolean(x));
  const teamIds = [...new Set(rows.flatMap((r) => [r.home_team_id, r.away_team_id]).filter((x): x is string => Boolean(x)))];
  const [games, teams] = await Promise.all([
    gameIds.length || fixtureIds.length
      ? query<GameRow>(
          `SELECT g.id, g.team_id, g.fixture_id, f.home_team_id AS fixture_home, g.us, g.them,
                  to_char(g.date, 'YYYY-MM-DD') AS date, (g.canceled_at IS NOT NULL) AS canceled
             FROM game g LEFT JOIN fixture f ON f.id = g.fixture_id
            WHERE g.deleted_at IS NULL AND (g.id = ANY($1::uuid[]) OR g.fixture_id = ANY($2::uuid[]))`,
          [gameIds, fixtureIds],
        )
      : Promise.resolve([] as GameRow[]),
    teamIds.length
      ? query<{ id: string; name: string }>('SELECT id, name FROM team WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL', [teamIds])
      : Promise.resolve([]),
  ]);
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const today = appToday();
  const played = (g: GameRow | undefined) => Boolean(g && !g.canceled && isGamePlayed(g.date, g.us, g.them, today));
  const entry = (teamId: string | null, name: string | null): BracketEntry | null =>
    teamId && teamName.has(teamId) ? { teamId, name: teamName.get(teamId)! } : name ? { teamId: null, name } : null;
  const hasGame = (r: MatchRow) => Boolean(r.fixture_id || r.home_game_id || r.away_game_id);

  const resultOf = (r: MatchRow): Score | null => {
    if (r.fixture_id) {
      const g = games.find((x) => x.fixture_id === r.fixture_id && x.team_id === x.fixture_home);
      return g && played(g) ? { home: g.us, away: g.them } : null;
    }
    const h = games.find((x) => x.id === r.home_game_id);
    if (played(h)) return { home: h!.us, away: h!.them };
    const a = games.find((x) => x.id === r.away_game_id);
    if (played(a)) return { home: a!.them, away: a!.us };
    // No game on Lineup: a score entered by hand.
    if (!hasGame(r) && r.home_score !== null && r.away_score !== null) return { home: r.home_score, away: r.away_score };
    return null;
  };

  // The group stage: each group's teams (by seed within the group) and table.
  const groupRows = rows.filter((r) => r.stage === 'group');
  const labels = [...new Set(groupRows.map((r) => r.group_label!))].sort();
  const places = new Map<string, BracketEntry | null>();
  const groups = labels.map((label) => {
    const ms = groupRows.filter((r) => r.group_label === label);
    const entries: BracketEntry[] = [];
    for (const r of ms) {
      if (r.home_seed !== null) entries[r.home_seed] ??= entry(r.home_team_id, r.home_name) ?? { name: 'Team' };
      if (r.away_seed !== null) entries[r.away_seed] ??= entry(r.away_team_id, r.away_name) ?? { name: 'Team' };
    }
    const table = groupTable(
      entries,
      ms.map((r) => ({ home: r.home_seed ?? -1, away: r.away_seed ?? -1, result: resultOf(r) })),
    );
    table.rows.forEach((row, i) => places.set(`${label}${i + 1}`, table.complete ? row.entry : null));
    return { label, matches: ms, table };
  });
  const sideOf = (ref: string | null, teamId: string | null, name: string | null): BracketEntry | null => {
    if (!ref) return entry(teamId, name);
    const label = ref.slice(0, 1);
    const g = groups.find((x) => x.label === label);
    if (!g || !g.table.complete) return { name: placeName(ref), pending: true };
    // A place the group does not have (it is smaller) is a bye.
    return places.get(ref) ?? null;
  };

  const knockoutRows = rows.filter((r) => r.stage === 'knockout');
  const ins: BracketMatchIn[] = knockoutRows.map((r) => ({
    id: r.id,
    round: r.round,
    slot: r.slot,
    thirdPlace: r.third_place,
    home: r.round === 1 && !r.third_place ? sideOf(r.home_ref, r.home_team_id, r.home_name) : null,
    away: r.round === 1 && !r.third_place ? sideOf(r.away_ref, r.away_team_id, r.away_name) : null,
    winnerOverride: r.winner_override,
    result: resultOf(r),
  }));
  return { rows, games, groups, knockoutRows, ins, resolved: resolveBracket(ins), entry, resultOf, hasGame };
}

/** The bracket for a tournament's page; null when it has none yet. `mine`: teams whose match day the caller can open. */
export async function loadBracket(competitionId: string, mine: Set<string>) {
  const state = await bracketState(competitionId);
  if (!state) return null;
  const { games, groups, knockoutRows, ins, resolved, entry, resultOf, hasGame } = state;
  const linksOf = (r: MatchRow) =>
    games
      .filter((g) => (r.fixture_id && g.fixture_id === r.fixture_id) || g.id === r.home_game_id || g.id === r.away_game_id)
      .filter((g) => mine.has(g.team_id))
      .map((g) => ({ teamId: g.team_id, gameId: g.id }));
  const common = (r: MatchRow) => ({
    date: r.date,
    kickoff: r.kickoff,
    location: r.location,
    scheduled: hasGame(r),
    links: linksOf(r),
    // A score is typed in only when there is no game on Lineup to keep it.
    canEnterScore: !hasGame(r),
  });
  // resolveBracket keeps the order it was given, so index i matches knockoutRows[i].
  const byId = new Map(knockoutRows.map((r, i) => [r.id, i]));
  const rounds = knockoutRows.length ? Math.max(...knockoutRows.filter((r) => !r.third_place).map((r) => r.round)) : 0;
  return {
    rounds,
    groups: groups.map((g) => ({
      label: g.label,
      complete: g.table.complete,
      table: g.table.rows.map((row) => ({
        teamId: row.entry.teamId ?? null,
        name: row.entry.name,
        played: row.played,
        won: row.won,
        drawn: row.drawn,
        lost: row.lost,
        gf: row.gf,
        ga: row.ga,
        gd: row.gd,
        pts: row.pts,
      })),
      matches: g.matches.map((r) => ({
        id: r.id,
        matchday: r.round,
        home: entry(r.home_team_id, r.home_name),
        away: entry(r.away_team_id, r.away_name),
        score: resultOf(r),
        ...common(r),
      })),
    })),
    matches: resolved.map((m) => {
      const i = byId.get(m.id)!;
      const r = knockoutRows[i];
      return {
        id: m.id,
        round: m.round,
        slot: m.slot,
        thirdPlace: m.thirdPlace,
        roundName: roundName(m.round, rounds, m.thirdPlace),
        home: m.home,
        away: m.away,
        winner: m.winner,
        decidedBy: m.decidedBy,
        score: ins[i].result,
        ...common(r),
      };
    }),
  };
}

const bad = (error: string, status = 400): HttpResponseInit => ({ status, jsonBody: { error } });

/** A side typed in by the manager: one of the tournament's teams, or (a coach's own tournament) a name. */
async function cleanSide(raw: unknown, teamsInIt: Set<string>, namesAllowed: boolean): Promise<BracketEntry | null | { error: string }> {
  if (raw === null || raw === undefined) return null;
  const r = raw as { teamId?: unknown; name?: unknown };
  const teamId = String(r.teamId ?? '').slice(0, 36);
  if (teamId) {
    if (!teamsInIt.has(teamId)) return { error: 'Add that team to the tournament first.' };
    const t = await queryOne<{ name: string }>('SELECT name FROM team WHERE id = $1', [teamId]);
    return { teamId, name: t?.name ?? 'Team' };
  }
  const name = cleanEntryName(r.name);
  // An organization's or region's tournament uses its own teams only (Fady, 10/16).
  if (name && !namesAllowed) return { error: 'Pick the teams from the list.' };
  return name ? { teamId: null, name } : null;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type NewRow = {
  stage: 'group' | 'knockout';
  group: string | null;
  round: number;
  slot: number;
  third: boolean;
  home: BracketEntry | null;
  away: BracketEntry | null;
  homeRef: string | null;
  awayRef: string | null;
  homeSeed: number | null;
  awaySeed: number | null;
};

export async function bracketAction(
  c: CompetitionRow,
  b: {
    action?: string;
    entries?: unknown;
    thirdPlace?: boolean;
    groups?: { perGroup?: unknown; advance?: unknown } | null;
    matchId?: string;
    home?: unknown;
    away?: unknown;
    winner?: string | null;
    homeScore?: unknown;
    awayScore?: unknown;
    date?: string;
    kickoff?: string | null;
    location?: string | null;
  },
  userId: string,
): Promise<HttpResponseInit> {
  if (c.kind !== 'tournament') return bad('Brackets are for tournaments.');
  const teamsInIt = new Set(
    (await query<{ team_id: string }>('SELECT team_id FROM competition_team WHERE competition_id = $1', [c.id])).map((r) => r.team_id),
  );
  const namesAllowed = Boolean(c.owner_user_id);

  if (b.action === 'bracketCreate') {
    const existing = await queryOne<{ n: number }>('SELECT COUNT(*)::int AS n FROM competition_match WHERE competition_id = $1', [c.id]);
    if ((existing?.n ?? 0) > 0) return bad('This tournament already has a bracket. Remove it first to make a new one.', 409);
    const raw = Array.isArray(b.entries) ? b.entries : [];
    const entries: BracketEntry[] = [];
    const seen = new Set<string>();
    for (const e of raw) {
      const side = await cleanSide(e, teamsInIt, namesAllowed);
      if (side && 'error' in side) return bad(side.error);
      if (!side) continue;
      const k = side.teamId ? `t:${side.teamId}` : `n:${side.name.toLowerCase()}`;
      if (seen.has(k)) continue;
      seen.add(k);
      entries.push(side);
    }

    const thirdPlace = b.thirdPlace !== false;
    const out: NewRow[] = [];
    try {
      if (b.groups) {
        // Group stage, then a knockout of the top teams of each group.
        const perGroup = Math.min(6, Math.max(3, Number(b.groups.perGroup) || 4));
        const groups = makeGroups(entries, perGroup);
        const smallest = Math.min(...groups.map((g) => g.length));
        const advance = Math.min(Math.max(1, Number(b.groups.advance) || 2), smallest);
        if (groups.length * advance < 2) return bad('With one group, at least 2 teams have to go through.');
        groups.forEach((teams, gi) => {
          const label = groupLabel(gi);
          const perDay = new Map<number, number>();
          for (const [h, a, day] of roundRobin(teams.length)) {
            const slot = perDay.get(day) ?? 0;
            perDay.set(day, slot + 1);
            out.push({ stage: 'group', group: label, round: day, slot, third: false, home: teams[h], away: teams[a], homeRef: null, awayRef: null, homeSeed: h, awaySeed: a });
          }
        });
        const refs = groupPlaces(groups.length, advance);
        for (const s of buildBracket(refs.map((name) => ({ name })), thirdPlace)) {
          out.push({ stage: 'knockout', group: null, round: s.round, slot: s.slot, third: s.thirdPlace, home: null, away: null, homeRef: s.home?.name ?? null, awayRef: s.away?.name ?? null, homeSeed: null, awaySeed: null });
        }
      } else {
        for (const s of buildBracket(entries, thirdPlace)) {
          out.push({ stage: 'knockout', group: null, round: s.round, slot: s.slot, third: s.thirdPlace, home: s.home, away: s.away, homeRef: null, awayRef: null, homeSeed: null, awaySeed: null });
        }
      }
    } catch (e) {
      return bad(e instanceof Error ? e.message : 'Could not make the bracket.');
    }
    await transaction(async (tx) => {
      for (const s of out) {
        await tx.query(
          `INSERT INTO competition_match (competition_id, stage, group_label, round, slot, third_place,
                                          home_team_id, home_name, away_team_id, away_name, home_ref, away_ref, home_seed, away_seed)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            c.id, s.stage, s.group, s.round, s.slot, s.third,
            s.home?.teamId ?? null, s.home?.name ?? null, s.away?.teamId ?? null, s.away?.name ?? null,
            s.homeRef, s.awayRef, s.homeSeed, s.awaySeed,
          ],
        );
      }
    });
    return { status: 201, jsonBody: { matches: out.length } };
  }

  if (b.action === 'bracketDelete') {
    // Games already scheduled stay on the calendars.
    await query('DELETE FROM competition_match WHERE competition_id = $1', [c.id]);
    return { status: 204 };
  }

  const state = await bracketState(c.id);
  const matchId = String(b.matchId ?? '').slice(0, 36);
  const row = state?.rows.find((r) => r.id === matchId);
  if (!state || !row) return bad('That match is not in this bracket.', 404);
  const knockout = row.stage === 'knockout' ? state.resolved.find((m) => m.id === matchId) : undefined;
  // Who plays: a group match as stored; a knockout match as worked out.
  const home = row.stage === 'group' ? state.entry(row.home_team_id, row.home_name) : knockout?.home ?? null;
  const away = row.stage === 'group' ? state.entry(row.away_team_id, row.away_name) : knockout?.away ?? null;
  const known = Boolean(home && away && !home.pending && !away.pending);
  const scheduled = state.hasGame(row);

  if (b.action === 'bracketSet') {
    if (row.stage !== 'knockout' || row.round !== 1 || row.third_place) {
      return bad('Only first-round knockout matches are set by hand; the rest fill in from the results.');
    }
    if (scheduled) return bad('This match is already scheduled. Change it on the calendar, or remove the games first.', 409);
    const h = await cleanSide(b.home, teamsInIt, namesAllowed);
    const a = await cleanSide(b.away, teamsInIt, namesAllowed);
    if (h && 'error' in h) return bad(h.error);
    if (a && 'error' in a) return bad(a.error);
    if (!h && !a) return bad('A match needs at least one team.');
    await query(
      `UPDATE competition_match SET home_team_id = $2, home_name = $3, away_team_id = $4, away_name = $5,
              home_ref = NULL, away_ref = NULL, winner_override = NULL, updated_at = now() WHERE id = $1`,
      [row.id, h?.teamId ?? null, h?.name ?? null, a?.teamId ?? null, a?.name ?? null],
    );
    return { status: 200, jsonBody: { id: row.id } };
  }

  if (b.action === 'bracketWinner') {
    if (row.stage !== 'knockout') return bad('Group games are decided by their score.');
    const winner = b.winner === 'home' || b.winner === 'away' ? b.winner : null;
    if (winner && !known) return bad('Both teams have to be known first.');
    await query('UPDATE competition_match SET winner_override = $2, updated_at = now() WHERE id = $1', [row.id, winner]);
    return { status: 200, jsonBody: { id: row.id } };
  }

  if (b.action === 'bracketScore') {
    if (scheduled) return bad('This game is on Lineup: enter its score on match day.', 409);
    if (!known) return bad('Both teams have to be known first.');
    const clear = b.homeScore === null || b.homeScore === undefined || b.homeScore === '';
    const hs = Number(b.homeScore);
    const as = Number(b.awayScore);
    if (!clear && (!Number.isInteger(hs) || !Number.isInteger(as) || hs < 0 || as < 0 || hs > 99 || as > 99)) {
      return bad('Enter both scores as whole numbers.');
    }
    await query('UPDATE competition_match SET home_score = $2, away_score = $3, updated_at = now() WHERE id = $1', [
      row.id, clear ? null : hs, clear ? null : as,
    ]);
    return { status: 200, jsonBody: { id: row.id } };
  }

  if (b.action === 'bracketSchedule') {
    if (scheduled) return bad('This match is already scheduled. Change its date on the calendar.', 409);
    if (!home || !away || !known) return bad('Both teams have to be known before the match can be scheduled.');
    const date = String(b.date ?? '').slice(0, 10);
    const kickoff = String(b.kickoff ?? '').slice(0, 5) || null;
    const location = String(b.location ?? '').trim().slice(0, 160) || null;
    if (!DATE_RE.test(date)) return bad('Pick a date.');
    if (!kickoff || !location) return bad('Kick-off time and location are required.');
    if (!TIME_RE.test(kickoff)) return bad('Kick-off must be a time like 09:30.');
    if (date < c.starts_on || date > c.ends_on) return bad(`Pick a date from ${c.starts_on} to ${c.ends_on} for ${c.name}.`);

    const lineupTeams = [home.teamId, away.teamId].filter((x): x is string => Boolean(x));
    const info = lineupTeams.length
      ? await query<{ id: string; org_id: string; org_personal: boolean; region_id: string | null; region_personal: boolean | null; archived: boolean }>(
          `SELECT t.id, t.org_id, o.is_personal AS org_personal, t.region_id, r.is_personal AS region_personal,
                  (t.archived_at IS NOT NULL) AS archived
             FROM team t JOIN organization o ON o.id = t.org_id LEFT JOIN region r ON r.id = t.region_id
            WHERE t.id = ANY($1::uuid[]) AND t.deleted_at IS NULL`,
          [lineupTeams],
        )
      : [];
    if (info.length !== lineupTeams.length) return bad('One of those teams is no longer on Lineup.');
    if (info.some((t) => t.archived)) return bad('One of those teams is archived.', 409);
    for (const t of lineupTeams) {
      const denied = await enforceTeamScopedLimit(userId, t, 'gamesPerTeam');
      if (denied) return { status: denied.status, jsonBody: denied.body };
    }
    const inLeague = (t: (typeof info)[number]) => !t.org_personal || Boolean(t.region_id && t.region_personal === false);
    const league = info.length === 2 && info[0].org_id === info[1].org_id && info.every(inLeague);

    await transaction(async (tx) => {
      let fixtureId: string | null = null;
      let homeGame: string | null = null;
      let awayGame: string | null = null;
      if (league) {
        fixtureId = await insertLeagueGame(tx, {
          homeTeamId: home.teamId!, awayTeamId: away.teamId!, date, kickoff, location, userId, competitionId: c.id,
        });
      } else {
        if (home.teamId) {
          homeGame = await insertTeamGame(tx, { teamId: home.teamId, opponent: away.name, isHome: true, date, kickoff, location, competitionId: c.id });
        }
        if (away.teamId) {
          awayGame = await insertTeamGame(tx, { teamId: away.teamId, opponent: home.name, isHome: false, date, kickoff, location, competitionId: c.id });
        }
      }
      await tx.query(
        `UPDATE competition_match SET date = $2::date, kickoff = $3, location = $4, fixture_id = $5,
                home_game_id = $6, away_game_id = $7, updated_at = now() WHERE id = $1`,
        [row.id, date, kickoff, location, fixtureId, homeGame, awayGame],
      );
    });
    return { status: 200, jsonBody: { id: row.id } };
  }

  return bad('Unknown action');
}

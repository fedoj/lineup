import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import {
  canOnScope,
  cardRating,
  cleanTeamType,
  fairnessOf,
  isGamePlayed,
  minutesFromAssignments,
  MISSED_GAME_STATUSES,
  overallRating,
  type Assignments,
  type EvaluationScores,
} from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { buildAccessContext } from '../lib/authz.js';
import { query, queryOne } from '../lib/db.js';
import { cachedStats, registerStats } from '../lib/statsCache.js';
import { appToday } from '../lib/today.js';
import { doneSubsByGame } from './subs.js';

/**
 * Stats for an organization or region (Shadi, 10/21), for its staff (admins
 * and directors): this season's leaders across its teams, from what coaches
 * record during matches (goals, assists, saves, clearances, cards) and their
 * player evaluations, plus each team's record. Narrow it to one region (for
 * an organization) or one team. The season runs August to July.
 *
 * GET /api/scope-stats?scope=org|region&id=<id>[&regionId=<id>][&teamId=<id>][&teamType=<type>]
 *
 * Also: injured players in the last two months, and fair play (which teams
 * share minutes most and least evenly, counting only games a player came to).
 * Read from the copy worked out at night (lib/statsCache.ts).
 */

const FORBIDDEN: HttpResponseInit = { status: 403, jsonBody: { error: 'You do not have access to this.', code: 'FORBIDDEN' } };
const UUID_RE = /^[0-9a-f-]{36}$/i;
const LIMIT = 10;

interface PlayerRow {
  id: string;
  name: string;
  team_id: string;
  team_name: string;
}

/**
 * Works out an organization's or region's stats from a cache key
 * `scope:<orgId>:<regionId>:<teamId>:<o|r>:<teamType>` (empty parts = all).
 */
async function computeScopeStats(key: string) {
  const [, orgId, regionId, teamParam, kind, typeParam] = key.split(':');
  const teams = await query<{ id: string; name: string; region_id: string | null; region_name: string | null; team_type: string | null }>(
    `SELECT t.id, t.name, t.region_id, r.name AS region_name, t.team_type
       FROM team t LEFT JOIN region r ON r.id = t.region_id
      WHERE t.org_id = $1 AND t.deleted_at IS NULL AND ($2::uuid IS NULL OR t.region_id = $2)
      ORDER BY t.name`,
    [orgId, regionId || null],
  );
  const regions =
    kind === 'o'
      ? await query<{ id: string; name: string }>(
          'SELECT id, name FROM region WHERE org_id = $1 AND deleted_at IS NULL AND NOT is_personal ORDER BY name',
          [orgId],
        )
      : [];
  const teamTypes = [...new Set(teams.map((t) => t.team_type).filter((x): x is string => Boolean(x)))].sort();
  const inScope = teams.filter((t) => !typeParam || t.team_type === typeParam);
  const teamIds = teamParam && inScope.some((t) => t.id === teamParam) ? [teamParam] : inScope.map((t) => t.id);
  const base = {
    regions,
    teams: teams.map((t) => ({ id: t.id, name: t.name, regionName: t.region_name, teamType: t.team_type })),
    teamTypes,
  };
  if (teamIds.length === 0) return { ...base, leaders: {}, teamTable: [], injuries: [], fairPlay: { fairest: [], leastFair: [] } };

  // This season's games (August to July), played or scheduled, not cancelled.
  const SEASON = `(date_trunc('year', current_date - interval '7 months') + interval '7 months')::date`;
  const [events, evaluations, players, games, missed, injuries] = await Promise.all([
    query<{ player_id: string | null; assist_id: string | null; kind: string; against: boolean }>(
      `SELECT e.player_id, e.assist_id, e.kind, COALESCE(e.against, false) AS against
         FROM game_event e JOIN game g ON g.id = e.game_id
        WHERE g.team_id = ANY($1::uuid[]) AND g.deleted_at IS NULL AND g.canceled_at IS NULL
          AND (g.date IS NULL OR g.date >= ${SEASON})
          AND e.kind IN ('goal', 'assist', 'save', 'near_goal_clearance', 'yellow', 'red', 'shot')`,
      [teamIds],
    ),
    query<{ player_id: string; scores: EvaluationScores }>(
      `SELECT ev.player_id, ev.scores FROM player_evaluation ev JOIN player p ON p.id = ev.player_id
        WHERE ev.team_id = ANY($1::uuid[]) AND p.active`,
      [teamIds],
    ),
    query<PlayerRow>(
      `SELECT p.id, p.name, p.team_id, t.name AS team_name FROM player p JOIN team t ON t.id = p.team_id
        WHERE p.team_id = ANY($1::uuid[]) AND p.active`,
      [teamIds],
    ),
    query<{ id: string; team_id: string; date: string | null; us: number; them: number; assignments: Assignments | null; period_length_sec: number | null }>(
      `SELECT g.id, g.team_id, to_char(g.date, 'YYYY-MM-DD') AS date, g.us, g.them, g.assignments, g.period_length_sec
         FROM game g
        WHERE g.team_id = ANY($1::uuid[]) AND g.deleted_at IS NULL AND g.canceled_at IS NULL
          AND g.date IS NOT NULL AND g.date >= ${SEASON}`,
      [teamIds],
    ),
    // Who missed which game: said they couldn't come, or marked absent on the day.
    query<{ game_id: string; player_id: string }>(
      `SELECT a.game_id, a.player_id FROM game_availability a JOIN game g ON g.id = a.game_id
        WHERE g.team_id = ANY($1::uuid[]) AND a.status = ANY($2::text[])
       UNION
       SELECT at.game_id, at.player_id FROM attendance at
        WHERE at.team_id = ANY($1::uuid[]) AND at.game_id IS NOT NULL AND at.status = ANY($2::text[])`,
      [teamIds, MISSED_GAME_STATUSES],
    ),
    // Injured in the last two months (Shadi, 10/21): from game replies and attendance.
    query<{ player_id: string; on_date: string; times: number }>(
      `SELECT player_id, to_char(max(on_date), 'YYYY-MM-DD') AS on_date, count(*)::int AS times FROM (
         SELECT a.player_id, g.date AS on_date FROM game_availability a JOIN game g ON g.id = a.game_id
          WHERE g.team_id = ANY($1::uuid[]) AND (a.status = 'injured' OR a.reason = 'injured')
            AND g.date >= current_date - interval '2 months' AND g.deleted_at IS NULL
         UNION ALL
         SELECT at.player_id, at.on_date FROM attendance at
          WHERE at.team_id = ANY($1::uuid[]) AND at.reason = 'injured' AND at.on_date >= current_date - interval '2 months'
       ) x GROUP BY player_id ORDER BY max(on_date) DESC LIMIT 50`,
      [teamIds],
    ),
  ]);

  const byId = new Map(players.map((p) => [p.id, p]));
  const tally = (pick: (e: (typeof events)[number]) => string | null) => {
    const counts = new Map<string, number>();
    for (const e of events) {
      const pid = pick(e);
      if (pid && byId.has(pid)) counts.set(pid, (counts.get(pid) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || byId.get(a[0])!.name.localeCompare(byId.get(b[0])!.name))
      .slice(0, LIMIT)
      .map(([pid, value]) => ({ playerId: pid, name: byId.get(pid)!.name, team: byId.get(pid)!.team_name, value }));
  };

  const rated = evaluations
    .map((e) => ({ e, p: byId.get(e.player_id), overall: overallRating(e.scores), card: cardRating(e.scores) }))
    .filter((x) => x.p && x.overall !== null);
  const topRated = [...rated]
    .sort((a, b) => (b.overall ?? 0) - (a.overall ?? 0))
    .slice(0, LIMIT)
    .map((x) => ({ playerId: x.p!.id, name: x.p!.name, team: x.p!.team_name, value: x.overall!, card: x.card }));
  const clearances = new Map<string, number>();
  for (const e of events) {
    if (e.kind === 'near_goal_clearance' && e.player_id && !e.against) clearances.set(e.player_id, (clearances.get(e.player_id) ?? 0) + 1);
  }
  const defenders = evaluations
    .map((e) => ({ p: byId.get(e.player_id), def: Number((e.scores as Record<string, unknown>)?.defending) || 0 }))
    .filter((x) => x.p && (x.def > 0 || clearances.has(x.p.id)))
    .map((x) => ({ ...x, clr: clearances.get(x.p!.id) ?? 0 }));
  for (const [pid, clr] of clearances) {
    if (!defenders.some((d) => d.p!.id === pid) && byId.has(pid)) defenders.push({ p: byId.get(pid), def: 0, clr });
  }
  const topDefenders = defenders
    .sort((a, b) => b.def - a.def || b.clr - a.clr)
    .slice(0, LIMIT)
    .map((x) => ({ playerId: x.p!.id, name: x.p!.name, team: x.p!.team_name, value: x.def || null, clearances: x.clr }));

  const teamInfo = new Map(teams.map((t) => [t.id, t]));
  const today = appToday();
  const played = games.filter((g) => isGamePlayed(g.date, g.us, g.them, today));
  const table = new Map<string, { played: number; won: number; drawn: number; lost: number; gf: number; ga: number; cleanSheets: number }>();
  for (const g of played) {
    const row = table.get(g.team_id) ?? { played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, cleanSheets: 0 };
    row.played++;
    row.gf += g.us;
    row.ga += g.them;
    if (g.us > g.them) row.won++;
    else if (g.us === g.them) row.drawn++;
    else row.lost++;
    if (g.them === 0) row.cleanSheets++;
    table.set(g.team_id, row);
  }
  const teamTable = [...table.entries()]
    .map(([tid, r]) => ({
      teamId: tid,
      name: teamInfo.get(tid)?.name ?? 'Team',
      regionName: teamInfo.get(tid)?.region_name ?? null,
      teamType: teamInfo.get(tid)?.team_type ?? null,
      ...r,
    }))
    .sort((a, b) => b.won * 3 + b.drawn - (a.won * 3 + a.drawn) || b.gf - b.ga - (a.gf - a.ga));

  // Fair play (Shadi, 10/21): how evenly each team shares minutes, judged per
  // game each player was there for, so missed games never count against it.
  const missedBy = new Map<string, Set<string>>();
  for (const m of missed) {
    const set = missedBy.get(m.game_id) ?? new Set<string>();
    set.add(m.player_id);
    missedBy.set(m.game_id, set);
  }
  const subsOf = await doneSubsByGame(played.map((g) => g.id));
  const perTeam = new Map<string, Map<string, { minutes: number; gamesAvailable: number }>>();
  for (const p of players) {
    const m = perTeam.get(p.team_id) ?? new Map();
    m.set(p.id, { minutes: 0, gamesAvailable: 0 });
    perTeam.set(p.team_id, m);
  }
  const teamGames = new Map<string, number>();
  for (const g of played) {
    const squad = perTeam.get(g.team_id);
    if (!squad || !g.assignments || Object.keys(g.assignments).length === 0) continue;
    teamGames.set(g.team_id, (teamGames.get(g.team_id) ?? 0) + 1);
    const mins = minutesFromAssignments(g.assignments, g.period_length_sec ?? 720, subsOf.get(g.id) ?? []);
    const away = missedBy.get(g.id);
    for (const [pid, row] of squad) {
      if (away?.has(pid)) continue;
      row.gamesAvailable += 1;
      row.minutes += Math.round((mins[pid] ?? 0) / 60);
    }
  }
  const fair = [...perTeam.entries()]
    .filter(([tid]) => (teamGames.get(tid) ?? 0) >= 2)
    .map(([tid, squad]) => {
      const f = fairnessOf([...squad.values()]);
      return f
        ? { teamId: tid, name: teamInfo.get(tid)?.name ?? 'Team', regionName: teamInfo.get(tid)?.region_name ?? null, games: teamGames.get(tid) ?? 0, ...f }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.spread - b.spread);
  const half = Math.ceil(fair.length / 2);

  return {
    ...base,
    leaders: {
      goals: tally((e) => (e.kind === 'goal' && !e.against ? e.player_id : null)),
      // An assist is recorded on the goal (assist_id) or as its own event.
      assists: tally((e) => (e.kind === 'goal' && !e.against ? e.assist_id : e.kind === 'assist' && !e.against ? e.player_id : null)),
      saves: tally((e) => (e.kind === 'save' && !e.against ? e.player_id : null)),
      shots: tally((e) => (e.kind === 'shot' && !e.against ? e.player_id : null)),
      topRated,
      defenders: topDefenders,
      cards: tally((e) => ((e.kind === 'yellow' || e.kind === 'red') && !e.against ? e.player_id : null)),
    },
    teamTable,
    fairPlay: {
      fairest: fair.slice(0, Math.min(5, half)),
      leastFair: fair.length > 1 ? fair.slice(half).reverse().slice(0, 5) : [],
    },
    injuries: injuries
      .filter((i) => byId.has(i.player_id))
      .map((i) => ({ playerId: i.player_id, name: byId.get(i.player_id)!.name, team: byId.get(i.player_id)!.team_name, lastDate: i.on_date, times: i.times })),
    rated: rated.length,
    players: players.length,
  };
}

registerStats('scope', computeScopeStats);
export async function scopeStatsHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    const access = await buildAccessContext(user);
    const scope = req.query.get('scope');
    const id = String(req.query.get('id') ?? '');
    if ((scope !== 'org' && scope !== 'region') || !UUID_RE.test(id)) {
      return { status: 400, jsonBody: { error: 'scope and id are required' } };
    }
    const place =
      scope === 'org'
        ? await queryOne<{ org_id: string; region_id: null }>('SELECT id AS org_id, NULL AS region_id FROM organization WHERE id = $1 AND deleted_at IS NULL', [id])
        : await queryOne<{ org_id: string; region_id: string }>('SELECT org_id, id AS region_id FROM region WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!place) return FORBIDDEN;
    const allowed = canOnScope(
      access,
      place.region_id ? { orgId: place.org_id, regionId: place.region_id } : { orgId: place.org_id },
      'analytics.view',
    ).allowed;
    if (!allowed) return FORBIDDEN;

    const regionParam = String(req.query.get('regionId') ?? '');
    const teamParam = String(req.query.get('teamId') ?? '');
    const typeParam = cleanTeamType(req.query.get('teamType'));
    const regionId = scope === 'org' && UUID_RE.test(regionParam) ? regionParam : place.region_id;
    const teamId = UUID_RE.test(teamParam) ? teamParam : '';
    // Season-long numbers come from the copy worked out overnight (Shadi, 10/21).
    const key = ['scope', place.org_id, regionId ?? '', teamId, scope === 'org' ? 'o' : 'r', typeParam ?? ''].join(':');
    const { data, computedAt } = await cachedStats(key, () => computeScopeStats(key));
    return { status: 200, jsonBody: { ...(data as object), computedAt } };
  } catch (err) {
    ctx.error('scope stats failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('scopeStats', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'scope-stats',
  handler: scopeStatsHandler,
});

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import {
  REF_EVENT_LABELS,
  cleanRefMinute,
  cleanRefScore,
  isRefEventKind,
  isRefPlayerStatus,
  playersWhoPlayed,
  refMinute,
  refScore,
  type AccessContext,
  type RefPlayerStatus,
  type RefSide,
} from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { buildAccessContext } from '../lib/authz.js';
import { query, queryOne, transaction } from '../lib/db.js';
import { refereeClockEnabled } from '../lib/entitlements.js';
import { calendarLinkSql } from '../lib/links.js';
import { canManageFixture, loadFixture, loadFixtureReferees, type FixtureRow } from './referees.js';

/**
 * Referees, parts 2 and 3: the referee's match screen and the official score.
 *
 * The main referee of a league game opens it with both rosters, prefilled from
 * the coaches' lineups (who starts) and check-ins (who is not coming). They
 * can change who starts, who is on the bench and who is not playing, and
 * record substitutions, goals, own goals and cards with the minute. The
 * running game clock fills the minute in by itself; it is Referee Premium.
 *
 * Submitting the final score makes it the official result: both teams' games
 * take it, and a trigger (migration 039) keeps it there, so the standings
 * follow the referee rather than the coaches. The organization's or region's
 * staff (whoever schedules the game) can open the same screen to correct it.
 * Assistant referees see it but do not record.
 */

const FORBIDDEN: HttpResponseInit = {
  status: 403,
  jsonBody: { error: 'Only the main referee and the organizers can record this game.', code: 'FORBIDDEN' },
};

type Role = 'main' | 'assistant' | 'staff';

function clip(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

/** First name and last initial: referees are outside the team. */
function shortName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Player';
  const [first, ...rest] = parts;
  return rest.length ? `${first} ${rest[rest.length - 1][0].toUpperCase()}.` : first;
}

/** Today on the US east coast, the earliest a game day starts. */
function gameDay(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

async function roleFor(userId: string, access: AccessContext, f: FixtureRow): Promise<Role | null> {
  const spot = await queryOne<{ slot: string }>(
    'SELECT slot FROM fixture_referee WHERE fixture_id = $1 AND user_id = $2',
    [f.id, userId],
  );
  if (spot?.slot === 'main') return 'main';
  if (canManageFixture(access, f)) return 'staff';
  return spot ? 'assistant' : null;
}

interface ReportRow {
  period_index: number;
  elapsed_sec: number;
  started_at: Date | null;
  home_score: number | null;
  away_score: number | null;
  final_at: Date | null;
  final_by_name: string | null;
  notes: string | null;
}

interface GameRow {
  id: string;
  team_id: string;
  assignments: Record<string, Record<string, string>> | null;
  periods: string;
  period_length_sec: number | null;
  us: number;
  them: number;
}

interface PlayerRow {
  id: string;
  team_id: string;
  name: string;
  number: string;
  public_id: string | null;
  availability: string | null;
}

interface EventRow {
  id: string;
  team_id: string;
  kind: string;
  player_id: string | null;
  player_out_id: string | null;
  minute: number | null;
  period_index: number | null;
  player_name: string | null;
  player_out_name: string | null;
}

async function loadReport(fixtureId: string): Promise<ReportRow | null> {
  return (
    (await queryOne<ReportRow>(
      `SELECT rr.period_index, rr.elapsed_sec, rr.started_at, rr.home_score, rr.away_score, rr.final_at,
              COALESCE(NULLIF(u.display_name, ''), 'Referee') AS final_by_name, rr.notes
         FROM fixture_ref_report rr LEFT JOIN app_user u ON u.id = rr.final_by
        WHERE rr.fixture_id = $1`,
      [fixtureId],
    )) ?? null
  );
}

/** Seconds on the clock in the current period, counting a running clock. */
function liveElapsed(r: Pick<ReportRow, 'elapsed_sec' | 'started_at'> | null, now = Date.now()): number {
  if (!r) return 0;
  const running = r.started_at ? Math.max(0, Math.floor((now - r.started_at.getTime()) / 1000)) : 0;
  return r.elapsed_sec + running;
}

/** The first period's lineup: the players the coach starts. */
function startersOf(assignments: GameRow['assignments']): Set<string> {
  const a = assignments ?? {};
  const first = Object.keys(a).sort((x, y) => Number(x) - Number(y))[0];
  return new Set(first !== undefined ? Object.values(a[first] ?? {}).filter(Boolean) : []);
}

function byNumberThenName(a: { number: string; name: string }, b: { number: string; name: string }): number {
  const na = Number.parseInt(a.number, 10);
  const nb = Number.parseInt(b.number, 10);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  if (Number.isFinite(na) !== Number.isFinite(nb)) return Number.isFinite(na) ? -1 : 1;
  return a.name.localeCompare(b.name);
}

async function matchView(f: FixtureRow, role: Role, userId: string) {
  const teamIds = [f.home_team_id, f.away_team_id];
  const [report, games, players, overrides, events, refs, clockPaid] = await Promise.all([
    loadReport(f.id),
    query<GameRow>(
      `SELECT id, team_id, assignments, periods, period_length_sec, us, them
         FROM game WHERE fixture_id = $1 AND deleted_at IS NULL`,
      [f.id],
    ),
    query<PlayerRow>(
      `SELECT p.id, p.team_id, p.name, p.number, p.public_id, a.status AS availability
         FROM player p
         LEFT JOIN game g ON g.fixture_id = $1 AND g.team_id = p.team_id AND g.deleted_at IS NULL
         LEFT JOIN game_availability a ON a.game_id = g.id AND a.player_id = p.id
        WHERE p.team_id = ANY($2::uuid[]) AND p.active`,
      [f.id, teamIds],
    ),
    query<{ player_id: string; status: RefPlayerStatus }>(
      'SELECT player_id, status FROM fixture_ref_player WHERE fixture_id = $1',
      [f.id],
    ),
    query<EventRow>(
      `SELECT e.id, e.team_id, e.kind, e.player_id, e.player_out_id, e.minute, e.period_index,
              p.name AS player_name, po.name AS player_out_name
         FROM fixture_ref_event e
         LEFT JOIN player p ON p.id = e.player_id
         LEFT JOIN player po ON po.id = e.player_out_id
        WHERE e.fixture_id = $1
        ORDER BY COALESCE(e.minute, 999), e.created_at`,
      [f.id],
    ),
    loadFixtureReferees([f.id]),
    refereeClockEnabled(userId),
  ]);

  const sideOf = (teamId: string): RefSide => (teamId === f.home_team_id ? 'home' : 'away');
  const override = new Map(overrides.map((o) => [o.player_id, o.status]));
  const homeGame = games.find((g) => g.team_id === f.home_team_id) ?? null;
  const periodCount = (homeGame ?? games[0])?.periods === 'halves' ? 2 : 4;
  const periodLengthSec = (homeGame ?? games[0])?.period_length_sec ?? 720;

  const evs = events.map((e) => ({
    id: e.id,
    side: sideOf(e.team_id),
    kind: e.kind,
    label: REF_EVENT_LABELS[e.kind as keyof typeof REF_EVENT_LABELS] ?? e.kind,
    playerId: e.player_id,
    playerName: e.player_name ? shortName(e.player_name) : null,
    playerOutId: e.player_out_id,
    playerOutName: e.player_out_name ? shortName(e.player_out_name) : null,
    minute: e.minute,
    periodIndex: e.period_index,
  }));

  const side = (teamId: string, name: string) => {
    const game = games.find((g) => g.team_id === teamId) ?? null;
    const starters = startersOf(game?.assignments ?? null);
    const subsOn = evs.filter((e) => e.kind === 'sub' && e.side === sideOf(teamId)).map((e) => e.playerId);
    const roster = players
      .filter((p) => p.team_id === teamId)
      .map((p) => {
        const fromCoach: RefPlayerStatus =
          p.availability === 'absent' || p.availability === 'injured' ? 'absent' : starters.has(p.id) ? 'start' : 'bench';
        return { p, fromCoach, status: override.get(p.id) ?? fromCoach };
      });
    const played = playersWhoPlayed(
      roster.filter((r) => r.status === 'start').map((r) => r.p.id),
      subsOn,
    );
    return {
      teamId,
      name,
      lineupSet: starters.size > 0,
      players: roster
        .map(({ p, fromCoach, status }) => ({
          id: p.id,
          name: shortName(p.name),
          number: p.number,
          publicId: p.public_id,
          status,
          fromCoach,
          changed: override.has(p.id) && override.get(p.id) !== fromCoach,
          played: played.has(p.id),
          yellow: evs.filter((e) => e.kind === 'yellow' && e.playerId === p.id).length,
          red: evs.filter((e) => e.kind === 'red' && e.playerId === p.id).length,
          goals: evs.filter((e) => e.kind === 'goal' && e.playerId === p.id).length,
        }))
        .sort(byNumberThenName),
    };
  };

  const canEdit = role !== 'assistant' && !f.canceled;
  const isFinal = Boolean(report?.final_at);
  const show = (h: { name: string } | null | undefined) => (h ? h.name : null);
  const r = refs.get(f.id);

  return {
    fixtureId: f.id,
    date: f.date,
    kickoff: f.kickoff,
    location: f.location,
    field: f.field,
    regionName: f.region_name,
    canceled: f.canceled,
    role,
    canEdit,
    canFinal: canEdit && f.date <= gameDay(),
    clockPaid,
    periods: periodCount,
    periodLengthSec,
    clock: {
      periodIndex: report?.period_index ?? 0,
      elapsedSec: liveElapsed(report),
      running: Boolean(report?.started_at) && !isFinal,
    },
    referees: { main: show(r?.main), ar1: show(r?.ar1), ar2: show(r?.ar2) },
    home: side(f.home_team_id, f.home_name),
    away: side(f.away_team_id, f.away_name),
    events: evs,
    score: refScore(evs),
    coachScore: !isFinal && homeGame && homeGame.us + homeGame.them > 0 ? { home: homeGame.us, away: homeGame.them } : null,
    official: isFinal
      ? {
          home: report!.home_score,
          away: report!.away_score,
          at: report!.final_at!.toISOString(),
          by: report!.final_by_name,
        }
      : null,
    notes: report?.notes ?? '',
  };
}

function bad(error: string, code?: string, status = 400): HttpResponseInit {
  return { status, jsonBody: code ? { error, code } : { error } };
}

export async function refMatchHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    const access = await buildAccessContext(user);

    const b =
      req.method === 'GET'
        ? {}
        : (((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>);
    const f = await loadFixture(clip(req.method === 'GET' ? req.query.get('fixtureId') : b.fixtureId, 40));
    if (!f) return bad('That game is no longer on the calendar.', 'NOT_FOUND', 404);
    const role = await roleFor(user.id, access, f);
    if (!role) return { status: 403, jsonBody: { error: 'You do not have access to this.', code: 'FORBIDDEN' } };

    if (req.method === 'GET') return { status: 200, jsonBody: await matchView(f, role, user.id) };

    if (role === 'assistant') return FORBIDDEN;
    if (f.canceled) return bad('This game was cancelled.', 'CANCELED', 409);

    const action = clip(b.action, 20);
    await query('INSERT INTO fixture_ref_report (fixture_id) VALUES ($1) ON CONFLICT DO NOTHING', [f.id]);
    const report = await loadReport(f.id);
    const isFinal = Boolean(report?.final_at);
    if (isFinal && ['status', 'event', 'deleteEvent', 'clock'].includes(action)) {
      return bad('The result has been submitted. Reopen it to make changes.', 'FINAL', 409);
    }

    const sideTeam = (side: unknown): string | null =>
      side === 'home' ? f.home_team_id : side === 'away' ? f.away_team_id : null;
    const playerOn = async (playerId: unknown, teamId: string) =>
      queryOne<{ id: string }>('SELECT id FROM player WHERE id = $1 AND team_id = $2 AND active', [
        clip(playerId, 40),
        teamId,
      ]).catch(() => null);

    if (action === 'status') {
      if (!isRefPlayerStatus(b.status)) return bad('Pick starting, bench or not playing.');
      const p = await queryOne<{ id: string }>(
        'SELECT id FROM player WHERE id = $1 AND team_id = ANY($2::uuid[]) AND active',
        [clip(b.playerId, 40), [f.home_team_id, f.away_team_id]],
      ).catch(() => null);
      if (!p) return bad('Pick a player from one of the two teams.');
      await query(
        `INSERT INTO fixture_ref_player (fixture_id, player_id, status) VALUES ($1, $2, $3)
         ON CONFLICT (fixture_id, player_id) DO UPDATE SET status = EXCLUDED.status`,
        [f.id, p.id, b.status],
      );
    } else if (action === 'event') {
      if (!isRefEventKind(b.kind)) return bad('Pick a goal, own goal, card or substitution.');
      const teamId = sideTeam(b.side);
      if (!teamId) return bad('Pick the team.');
      const kind = b.kind;
      let playerId: string | null = null;
      let playerOutId: string | null = null;
      if (b.playerId) {
        playerId = (await playerOn(b.playerId, teamId))?.id ?? null;
        if (!playerId) return bad('Pick a player from that team.');
      }
      if ((kind === 'yellow' || kind === 'red' || kind === 'sub') && !playerId) {
        return bad(kind === 'sub' ? 'Pick the player coming on.' : 'Pick the player who got the card.');
      }
      if (kind === 'sub') {
        playerOutId = (await playerOn(b.playerOutId, teamId))?.id ?? null;
        if (!playerOutId) return bad('Pick the player going off.');
        if (playerOutId === playerId) return bad('The players coming on and going off must be different.');
      }
      const typed = cleanRefMinute(b.minute);
      if (typed !== null && typeof typed === 'object') return bad(typed.error);
      let minute = typed;
      // With the running clock the minute fills itself in.
      if (minute === null && report && (report.started_at || report.elapsed_sec > 0 || report.period_index > 0)) {
        if (await refereeClockEnabled(user.id)) {
          const games = await query<{ period_length_sec: number | null }>(
            'SELECT period_length_sec FROM game WHERE fixture_id = $1 AND team_id = $2 AND deleted_at IS NULL',
            [f.id, f.home_team_id],
          );
          minute = refMinute(report.period_index, liveElapsed(report), games[0]?.period_length_sec ?? 720);
        }
      }
      await query(
        `INSERT INTO fixture_ref_event (fixture_id, team_id, kind, player_id, player_out_id, period_index, minute, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [f.id, teamId, kind, playerId, playerOutId, report?.period_index ?? 0, minute, user.id],
      );
    } else if (action === 'deleteEvent') {
      await query('DELETE FROM fixture_ref_event WHERE id = $1 AND fixture_id = $2', [clip(b.eventId, 40), f.id]).catch(
        () => undefined,
      );
    } else if (action === 'clock') {
      if (!(await refereeClockEnabled(user.id))) {
        return {
          status: 402,
          jsonBody: {
            error: 'The running game clock is part of Referee Premium. You can still type the minute for each event.',
            code: 'UPGRADE_REQUIRED',
            details: { feature: 'refereeClock' },
          },
        };
      }
      const op = clip(b.op, 10);
      const g = await queryOne<{ periods: string }>(
        'SELECT periods FROM game WHERE fixture_id = $1 AND deleted_at IS NULL ORDER BY (team_id = $2) DESC LIMIT 1',
        [f.id, f.home_team_id],
      );
      const last = (g?.periods === 'halves' ? 2 : 4) - 1;
      const pause = `elapsed_sec = elapsed_sec + COALESCE(FLOOR(EXTRACT(EPOCH FROM now() - started_at))::int, 0), started_at = NULL`;
      if (op === 'start') {
        await query('UPDATE fixture_ref_report SET started_at = COALESCE(started_at, now()), updated_at = now() WHERE fixture_id = $1', [f.id]);
      } else if (op === 'pause') {
        await query(`UPDATE fixture_ref_report SET ${pause}, updated_at = now() WHERE fixture_id = $1`, [f.id]);
      } else if (op === 'next') {
        await query(
          `UPDATE fixture_ref_report SET elapsed_sec = 0, started_at = NULL, period_index = LEAST(period_index + 1, $2), updated_at = now()
            WHERE fixture_id = $1`,
          [f.id, last],
        );
      } else if (op === 'reset') {
        await query(
          'UPDATE fixture_ref_report SET elapsed_sec = 0, started_at = NULL, period_index = 0, updated_at = now() WHERE fixture_id = $1',
          [f.id],
        );
      } else {
        return bad('Unknown clock action.');
      }
    } else if (action === 'notes') {
      const notes = clip(b.notes, 1000);
      await query('UPDATE fixture_ref_report SET notes = $2, updated_at = now() WHERE fixture_id = $1', [f.id, notes || null]);
    } else if (action === 'final') {
      if (f.date > gameDay()) return bad('You can submit the result on game day.', 'NOT_YET', 409);
      const score = cleanRefScore(b.homeScore, b.awayScore);
      if ('error' in score) return bad(score.error);
      await transaction(async (c) => {
        await c.query(
          `UPDATE fixture_ref_report
              SET home_score = $2, away_score = $3, final_at = now(), final_by = $4,
                  elapsed_sec = elapsed_sec + COALESCE(FLOOR(EXTRACT(EPOCH FROM now() - started_at))::int, 0),
                  started_at = NULL, updated_at = now()
            WHERE fixture_id = $1`,
          [f.id, score.home, score.away, user.id],
        );
        // Both teams' games take the official score (the trigger holds it).
        await c.query(
          `UPDATE game g
              SET us = CASE WHEN g.team_id = $2 THEN $3::int ELSE $4::int END,
                  them = CASE WHEN g.team_id = $2 THEN $4::int ELSE $3::int END,
                  updated_at = now()
            WHERE g.fixture_id = $1 AND g.deleted_at IS NULL`,
          [f.id, f.home_team_id, score.home, score.away],
        );
      });
      const title = `Official result: ${f.home_name} ${score.home}–${score.away} ${f.away_name}`;
      await query(
        `INSERT INTO notification (user_id, kind, title, body, link)
         SELECT DISTINCT ON (m.user_id) m.user_id, 'system', $3, $4, ${calendarLinkSql('m.team_id::text', "'game:' || g.id::text")}
           FROM membership m
           JOIN game g ON g.team_id = m.team_id AND g.fixture_id = $1 AND g.deleted_at IS NULL
          WHERE m.team_id = ANY($2::uuid[]) AND m.role IN ('coach', 'assistant') AND m.user_id <> $5`,
        [
          f.id,
          [f.home_team_id, f.away_team_id],
          title,
          'The referee submitted the final score. It is the official result and counts in the standings.',
          user.id,
        ],
      ).catch((e) => ctx.warn('official result notify failed', e));
    } else if (action === 'reopen') {
      await query('UPDATE fixture_ref_report SET final_at = NULL, final_by = NULL, updated_at = now() WHERE fixture_id = $1', [f.id]);
    } else {
      return bad('Unknown action.');
    }

    return { status: 200, jsonBody: await matchView(f, role, user.id) };
  } catch (err) {
    ctx.error('ref match failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('refMatch', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'ref-match',
  handler: refMatchHandler,
});

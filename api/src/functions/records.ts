import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { GAME_EVENT_KINDS, isGamePlayed, minutesFromAssignments, type GameEventKind } from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { filterRoster, guardTeam } from '../lib/authz.js';
import { query, queryOne } from '../lib/db.js';
import { gameLocked } from '../lib/gameLock.js';
import { doneSubsByGame } from './subs.js';
import { enforceFeature } from '../lib/entitlements.js';
import { appToday } from '../lib/today.js';

function isEventKind(k: unknown): k is GameEventKind {
  return typeof k === 'string' && (GAME_EVENT_KINDS as readonly string[]).includes(k);
}

/** Event kinds that move the scoreline. */
const SCORING_KINDS = new Set<GameEventKind>(['goal', 'own_goal']);

/** What a free plan may log: the score, assists and cards. */
const FREE_EVENT_KINDS = new Set<string>(['goal', 'own_goal', 'assist', 'yellow', 'red']);

/**
 * Recompute a game's score from its recorded goals.
 *
 * `against` marks the team the event belongs to, so a normal goal by the
 * opposition counts for them — but an OWN goal flips: one scored by our
 * player gives the opposition a goal, and vice versa.
 */
async function recountScore(gameId: string): Promise<void> {
  await query(
    `UPDATE game SET
       us = (SELECT COUNT(*) FROM game_event
              WHERE game_id = $1
                AND ((kind = 'goal' AND NOT against)
                  OR (kind = 'own_goal' AND against))),
       them = (SELECT COUNT(*) FROM game_event
                WHERE game_id = $1
                  AND ((kind = 'goal' AND against)
                    OR (kind = 'own_goal' AND NOT against))),
       updated_at = now()
     WHERE id = $1`,
    [gameId],
  );
}

/* ----------------------------------------------------------- attendance */

/** Attendance for any date — practice, game or standalone session. */
export async function attendanceHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    const teamId = req.query.get('teamId') ?? undefined;
    const guard = await guardTeam(
      user,
      teamId,
      req.method === 'GET' ? 'attendance.view' : 'attendance.edit',
    );
    if (!guard.ok) return guard.response;

    if (req.method === 'GET') {
      const from = req.query.get('from');
      const to = req.query.get('to');
      const rows = await query<{ id: string; player_id: string }>(
        `SELECT a.id, a.player_id, a.on_date, a.status, a.note,
                a.practice_id, a.game_id
           FROM attendance a
          WHERE a.team_id = $1
            AND ($2::date IS NULL OR a.on_date >= $2)
            AND ($3::date IS NULL OR a.on_date <= $3)
          ORDER BY a.on_date DESC`,
        [teamId, from, to],
      );
      // Parents only see their own children's attendance.
      const visible = filterRoster(
        guard.ctx,
        guard.team,
        rows.map((r) => ({ ...r, id: r.player_id })),
      );
      return { status: 200, jsonBody: visible };
    }

    const body = (await req.json()) as {
      entries?: Array<{
        playerId: string;
        onDate: string;
        status?: string;
        note?: string;
        practiceId?: string;
        gameId?: string;
      }>;
    };
    if (!body.entries?.length) {
      return { status: 400, jsonBody: { error: 'entries is required' } };
    }

    for (const e of body.entries) {
      await query(
        `INSERT INTO attendance (team_id, player_id, practice_id, game_id,
                                 on_date, status, note, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (player_id, on_date, practice_id, game_id)
         DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note,
                       recorded_by = EXCLUDED.recorded_by, recorded_at = now()`,
        [
          teamId, e.playerId, e.practiceId ?? null, e.gameId ?? null,
          e.onDate, e.status ?? 'present', e.note ?? null, user.id,
        ],
      );
    }
    return { status: 200, jsonBody: { saved: body.entries.length } };
  } catch (err) {
    ctx.error('attendance failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/* ---------------------------------------------------------------- stats */

/** Goals, assists and cards. */
export async function eventsHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    const gameId = req.query.get('gameId') ?? undefined;
    if (!gameId) return { status: 400, jsonBody: { error: 'gameId is required' } };

    const g = await queryOne<{ team_id: string }>(
      'SELECT team_id FROM game WHERE id = $1 AND deleted_at IS NULL',
      [gameId],
    );
    const guard = await guardTeam(
      user,
      g?.team_id,
      req.method === 'GET' ? 'stats.view' : 'stats.edit',
    );
    if (!guard.ok) return guard.response;
    if (req.method !== 'GET') {
      const lock = await gameLocked(gameId);
      if (lock) return lock;
    }

    if (req.method === 'GET') {
      const rows = await query(
        `SELECT id, player_id AS "playerId", assist_id AS "assistId", kind,
                period_index AS "periodIndex", clock_sec AS "clockSec",
                against, note
           FROM game_event WHERE game_id = $1
          ORDER BY period_index NULLS LAST, clock_sec NULLS LAST`,
        [gameId],
      );
      return { status: 200, jsonBody: rows };
    }

    if (req.method === 'DELETE') {
      const id = req.query.get('id');
      if (!id) return { status: 400, jsonBody: { error: 'id is required' } };
      const removed = await queryOne<{ kind: string }>(
        'DELETE FROM game_event WHERE id = $1 AND game_id = $2 RETURNING kind',
        [id, gameId],
      );
      // Removing a goal has to pull the scoreline back down with it.
      if (removed && SCORING_KINDS.has(removed.kind as GameEventKind)) {
        await recountScore(gameId);
      }
      return { status: 204 };
    }

    const body = (await req.json()) as {
      playerId?: string;
      assistId?: string;
      kind?: string;
      periodIndex?: number;
      clockSec?: number;
      against?: boolean;
      note?: string;
    };
    if (!body.kind) return { status: 400, jsonBody: { error: 'kind is required' } };
    // Reject anything the database CHECK would refuse anyway, but with a
    // message that names the valid options instead of a 500.
    if (!isEventKind(body.kind)) {
      return {
        status: 400,
        jsonBody: {
          error: `Unknown event type '${body.kind}'.`,
          code: 'EVENT_KIND_INVALID',
          details: { allowed: GAME_EVENT_KINDS },
        },
      };
    }
    // Free plans track goals (with assists) and cards; everything else is paid.
    if (!FREE_EVENT_KINDS.has(body.kind)) {
      const denial = await enforceFeature(user.id, 'fullStats');
      if (denial) return { status: denial.status, jsonBody: denial.body };
    }

    const row = await queryOne(
      `INSERT INTO game_event (game_id, player_id, assist_id, kind,
                               period_index, clock_sec, against, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, player_id AS "playerId", assist_id AS "assistId", kind,
                 period_index AS "periodIndex", clock_sec AS "clockSec", against, note`,
      [
        gameId, body.playerId ?? null, body.assistId ?? null, body.kind,
        body.periodIndex ?? null, body.clockSec ?? null,
        body.against ?? false, body.note ?? null,
      ],
    );

    // Keep the scoreline in step with recorded goals.
    if (SCORING_KINDS.has(body.kind)) {
      await recountScore(gameId);
    }

    return { status: 201, jsonBody: row };
  } catch (err) {
    ctx.error('events failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/* ------------------------------------------------------------ analytics */

export async function analyticsHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    const teamId = req.query.get('teamId') ?? undefined;
    const guard = await guardTeam(user, teamId, 'analytics.view');
    if (!guard.ok) return guard.response;

    const [players, games, events, attendance] = await Promise.all([
      query<{ id: string; name: string; number: string }>(
        'SELECT id, name, number FROM player WHERE team_id = $1 AND active ORDER BY name',
        [teamId],
      ),
      query<{
        id: string; game_no: number; date: Date | null; opponent: string;
        us: number; them: number; assignments: Record<string, Record<string, string>>;
        period_length_sec: number;
      }>(
        `SELECT id, game_no, date, opponent, us, them, assignments, period_length_sec
           FROM game WHERE team_id = $1 AND deleted_at IS NULL AND canceled_at IS NULL ORDER BY game_no`,
        [teamId],
      ),
      query<{ player_id: string | null; assist_id: string | null; kind: string; against: boolean }>(
        `SELECT e.player_id, e.assist_id, e.kind, e.against
           FROM game_event e JOIN game g ON g.id = e.game_id
          WHERE g.team_id = $1 AND g.deleted_at IS NULL`,
        [teamId],
      ),      query<{ player_id: string; status: string }>(
        'SELECT player_id, status FROM attendance WHERE team_id = $1',
        [teamId],
      ),
    ]);

    const byPlayer = new Map(
      players.map((p) => [
        p.id,
        {
          playerId: p.id,
          name: p.name,
          number: p.number,
          goals: 0,
          assists: 0,
          ownGoals: 0,
          yellow: 0,
          red: 0,
          fouls: 0,
          saves: 0,
          clearances: 0,
          minutes: 0,
          gamesPlayed: 0,
          present: 0,
          absent: 0,
          attendanceRate: 0,
        },
      ]),
    );

    // Upcoming games (even with a lineup planned) are not results yet.
    const today = appToday();
    const played = games.filter((g) =>
      isGamePlayed(g.date ? g.date.toISOString().slice(0, 10) : null, g.us, g.them, today),
    );

    const subsOf = await doneSubsByGame(played.map((g) => g.id));
    for (const g of played) {
      const mins = minutesFromAssignments(g.assignments ?? {}, g.period_length_sec, subsOf.get(g.id) ?? []);
      for (const [pid, secs] of Object.entries(mins)) {
        const row = byPlayer.get(pid);
        if (!row) continue;
        row.minutes += Math.round(secs / 60);
        row.gamesPlayed += 1;
      }
    }

    // Team-level tallies that are not tied to a single player.
    const team = {
      corners: 0,
      cornersAgainst: 0,
      fouls: 0,
      foulsAgainst: 0,
      yellow: 0,
      yellowAgainst: 0,
      red: 0,
      redAgainst: 0,
    };

    for (const e of events) {
      if (e.kind === 'corner') {
        if (e.against) team.cornersAgainst += 1;
        else team.corners += 1;
      } else if (e.kind === 'foul') {
        if (e.against) team.foulsAgainst += 1;
        else team.fouls += 1;
      } else if (e.kind === 'yellow') {
        if (e.against) team.yellowAgainst += 1;
        else team.yellow += 1;
      } else if (e.kind === 'red') {
        if (e.against) team.redAgainst += 1;
        else team.red += 1;
      }

      // Everything below credits one of our players, so opposition events
      // and events with no player attached are skipped.
      if (e.against || !e.player_id) {
        // An assist can still be recorded on a goal credited to us.
        if (!e.against && e.assist_id) {
          const a = byPlayer.get(e.assist_id);
          if (a) a.assists += 1;
        }
        continue;
      }

      const r = byPlayer.get(e.player_id);
      if (!r) continue;
      switch (e.kind) {
        case 'goal':
          r.goals += 1;
          break;
        case 'own_goal':
          r.ownGoals += 1;
          break;
        case 'yellow':
          r.yellow += 1;
          break;
        case 'red':
          r.red += 1;
          break;
        case 'foul':
          r.fouls += 1;
          break;
        case 'save':
          r.saves += 1;
          break;
        case 'near_goal_clearance':
          r.clearances += 1;
          break;
      }

      if (e.assist_id) {
        const a = byPlayer.get(e.assist_id);
        if (a) a.assists += 1;
      }
    }

    for (const a of attendance) {
      const r = byPlayer.get(a.player_id);
      if (!r) continue;
      if (a.status === 'present' || a.status === 'late') r.present += 1;
      else r.absent += 1;
    }
    for (const r of byPlayer.values()) {
      const total = r.present + r.absent;
      r.attendanceRate = total ? Math.round((r.present / total) * 100) : 0;
    }

    const visible = filterRoster(
      guard.ctx,
      guard.team,
      [...byPlayer.values()].map((r) => ({ ...r, id: r.playerId })),
    );

    const record = {
      played: played.length,
      won: played.filter((g) => g.us > g.them).length,
      drawn: played.filter((g) => g.us === g.them).length,
      lost: played.filter((g) => g.us < g.them).length,
      goalsFor: played.reduce((a, g) => a + g.us, 0),
      goalsAgainst: played.reduce((a, g) => a + g.them, 0),
    };

    // Fairness: how evenly minutes are spread across the squad.
    const minutes = visible.map((p) => p.minutes);
    const fairness = minutes.length
      ? {
          min: Math.min(...minutes),
          max: Math.max(...minutes),
          spread: Math.max(...minutes) - Math.min(...minutes),
          average: Math.round(minutes.reduce((a, b) => a + b, 0) / minutes.length),
        }
      : null;

    return {
      status: 200,
      jsonBody: {
        record,
        team,
        fairness,
        players: visible,
        games: played.map((g) => ({
          id: g.id,
          gameNo: g.game_no,
          date: g.date ? g.date.toISOString().slice(0, 10) : null,
          opponent: g.opponent,
          us: g.us,
          them: g.them,
        })),
      },
    };
  } catch (err) {
    ctx.error('analytics failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('attendance', {
  methods: ['GET', 'POST'], authLevel: 'anonymous', route: 'attendance',
  handler: attendanceHandler,
});
app.http('events', {
  methods: ['GET', 'POST', 'DELETE'], authLevel: 'anonymous', route: 'events',
  handler: eventsHandler,
});
app.http('analytics', {
  methods: ['GET'], authLevel: 'anonymous', route: 'analytics',
  handler: analyticsHandler,
});

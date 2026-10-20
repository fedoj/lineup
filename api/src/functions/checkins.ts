import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { canOnTeam, cleanRsvpReason, nameWithReason, removeUnavailable } from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { guardTeam, TEAM_ARCHIVED } from '../lib/authz.js';
import { query, queryOne } from '../lib/db.js';
import { appToday } from '../lib/today.js';

/**
 * Game check-ins.
 *
 * A parent says whether their child is coming to an upcoming game. Check-in
 * opens as soon as the game is on the schedule and closes at the end of game
 * day. The answer is the game's availability, so a "not going" child drops
 * out of the lineup and auto formation exactly as if the coach had marked
 * them absent. Coaches and staff see who is going, who is not and who has not
 * answered.
 */

/** Upcoming games listed for check-in, soonest first. */
const MAX_GAMES = 20;

const FORBIDDEN: HttpResponseInit = {
  status: 403,
  jsonBody: { error: 'You do not have access to this.', code: 'FORBIDDEN' },
};

interface GameRow {
  id: string;
  date: string;
  kickoff: string | null;
  opponent: string;
  is_home: boolean;
  location: string | null;
  canceled: boolean;
}

export async function checkinsHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    if (req.method === 'GET') {
      const guard = await guardTeam(user, req.query.get('teamId') ?? undefined, 'game.view');
      if (!guard.ok) return guard.response;
      // Who is going is shown to the staff and the team parent, as for
      // practices; marking a game for someone else stays with the staff.
      const seesNames = canOnTeam(guard.ctx, guard.team, 'lineup.edit').allowed || guard.role === 'team_parent';

      const today = appToday();
      const [games, players, answers] = await Promise.all([
        query<GameRow>(
          `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, kickoff, opponent, is_home, location,
                  (canceled_at IS NOT NULL) AS canceled
             FROM game
            WHERE team_id = $1 AND deleted_at IS NULL AND date >= $3::date
            ORDER BY date, kickoff NULLS LAST
            LIMIT $2`,
          [guard.team.teamId, MAX_GAMES, today],
        ),
        query<{ id: string; name: string }>('SELECT id, name FROM player WHERE team_id = $1 AND active ORDER BY name', [
          guard.team.teamId,
        ]),
        // Answers for the team's upcoming games, read beside the games themselves.
        query<{ game_id: string; player_id: string; status: string; reason: string | null; note: string | null }>(
          `SELECT a.game_id, a.player_id, a.status, a.reason, a.note
             FROM game_availability a JOIN game g ON g.id = a.game_id
            WHERE g.team_id = $1 AND g.deleted_at IS NULL AND g.date >= $2::date`,
          [guard.team.teamId, today],
        ),
      ]);
      const mine = new Set(guard.ctx.guardianOf ?? []);
      const children = players.filter((p) => mine.has(p.id));
      const answerOf = (gameId: string, playerId: string) =>
        answers.find((a) => a.game_id === gameId && a.player_id === playerId) ?? null;
      const statusOf = (gameId: string, playerId: string) => answerOf(gameId, playerId)?.status ?? null;
      // Staff see why a player is not going; the comment only with "other".
      const named = (gameId: string, p: { id: string; name: string }) => {
        const a = answerOf(gameId, p.id);
        return nameWithReason(p.name, a?.reason ?? (a?.status === 'injured' ? 'injured' : null), a?.reason === 'other' ? a.note : null);
      };

      return {
        status: 200,
        jsonBody: {
          canSeeSummary: seesNames,
          games: games.map((g) => {
            const going = players.filter((p) => statusOf(g.id, p.id) === 'available');
            const notGoing = players.filter((p) => ['absent', 'injured'].includes(statusOf(g.id, p.id) ?? ''));
            const late = players.filter((p) => statusOf(g.id, p.id) === 'late');
            const noAnswer = players.filter((p) => statusOf(g.id, p.id) === null);
            return {
              id: g.id,
              date: g.date,
              kickoff: g.kickoff,
              opponent: g.opponent,
              isHome: g.is_home,
              location: g.location,
              // A cancelled game takes no answers.
              open: !g.canceled,
              canceled: g.canceled,
              children: children.map((c) => {
                const a = answerOf(g.id, c.id);
                return {
                  playerId: c.id,
                  name: c.name,
                  status: a?.status ?? null,
                  reason: a?.reason ?? (a?.status === 'injured' ? 'injured' : null),
                  note: a?.reason === 'other' ? a.note : null,
                };
              }),
              // Everyone on the team sees the totals. Names are for the staff and
              // the team parent: parents see only the players linked to them
              // (privacy policy).
              counts: { going: going.length, notGoing: notGoing.length, late: late.length, noAnswer: noAnswer.length },
              summary: seesNames
                ? {
                    going: going.map((p) => p.name),
                    notGoing: notGoing.map((p) => named(g.id, p)),
                    late: late.map((p) => p.name),
                    noAnswer: noAnswer.map((p) => p.name),
                  }
                : null,
            };
          }),
        },
      };
    }

    // POST: a parent answers for their own child. Not going carries a reason
    // (sick, injured, other with an optional comment); injured is kept as the
    // game's "injured" availability so match day shows it.
    const b = (await req.json()) as { gameId?: string; playerId?: string; status?: string; reason?: string; note?: string };
    const asked = b.status === 'available' || b.status === 'absent' ? b.status : null;
    if (!asked) return { status: 400, jsonBody: { error: 'Choose going or not going.' } };
    const why = asked === 'absent' ? cleanRsvpReason(b.reason, b.note) : { reason: null, note: null };
    const status = asked === 'absent' && why.reason === 'injured' ? 'injured' : asked;
    const game = await queryOne<{ id: string; team_id: string; date: string | null; closed: boolean; canceled: boolean }>(
      `SELECT id, team_id, to_char(date, 'YYYY-MM-DD') AS date, ($2::date > date) AS closed,
              (canceled_at IS NOT NULL) AS canceled
         FROM game WHERE id = $1 AND deleted_at IS NULL`,
      [String(b.gameId ?? '').slice(0, 36), appToday()],
    );
    if (!game) return FORBIDDEN;
    const guard = await guardTeam(user, game.team_id, 'game.view');
    if (!guard.ok) return guard.response;
    if (guard.team.archived) return TEAM_ARCHIVED;

    const playerId = String(b.playerId ?? '').slice(0, 36);
    const player = await queryOne<{ id: string }>(
      'SELECT id FROM player WHERE id = $1 AND team_id = $2 AND active',
      [playerId, game.team_id],
    );
    const isGuardian = (guard.ctx.guardianOf ?? []).includes(playerId);
    const staff = canOnTeam(guard.ctx, guard.team, 'lineup.edit').allowed;
    if (!player || (!isGuardian && !staff)) return FORBIDDEN;

    if (!game.date) return { status: 409, jsonBody: { error: 'This game has no date yet.', code: 'CHECKIN_NO_DATE' } };
    if (game.closed) return { status: 409, jsonBody: { error: 'Check-in for this game has closed.', code: 'CHECKIN_CLOSED' } };
    if (game.canceled) return { status: 409, jsonBody: { error: 'This game is cancelled.', code: 'GAME_CANCELED' } };

    await query(
      `INSERT INTO game_availability (game_id, player_id, status, reason, note, responded_by, responded_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (game_id, player_id)
       DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason, note = EXCLUDED.note,
                     responded_by = EXCLUDED.responded_by, responded_at = now()`,
      [game.id, playerId, status, why.reason, why.note, user.id],
    );

    // Not going takes the child out of the saved lineup, as match day does.
    if (status !== 'available') {
      const row = await queryOne<{ assignments: Record<string, Record<string, string>> }>(
        'SELECT assignments FROM game WHERE id = $1',
        [game.id],
      );
      if (row) {
        const { assignments, removed } = removeUnavailable(row.assignments ?? {}, [playerId]);
        if (removed > 0) {
          await query('UPDATE game SET assignments = $2, updated_at = now() WHERE id = $1', [
            game.id,
            JSON.stringify(assignments),
          ]);
        }
      }
    }

    return { status: 200, jsonBody: { gameId: game.id, playerId, status, reason: why.reason } };
  } catch (err) {
    ctx.error('checkins failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('checkins', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'checkins',
  handler: checkinsHandler,
});

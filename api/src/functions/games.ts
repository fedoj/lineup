import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import type { Game } from '@lineup/shared';
import { assertTeamOwner, requireUser } from '../lib/auth.js';
import { query, queryOne } from '../lib/db.js';
import { enforceLimit } from '../lib/entitlements.js';

interface GameRow {
  id: string;
  team_id: string;
  game_no: number;
  date: Date | null;
  opponent: string;
  us: number;
  them: number;
  is_home: boolean;
  format: string;
  periods: string;
  formation: string;
  tactic: string;
  assignments: Record<string, Record<string, string>>;
  notes: string | null;
  updated_at: Date;
}

function toGame(row: GameRow): Game {
  return {
    id: row.id,
    teamId: row.team_id,
    gameNo: row.game_no,
    date: row.date ? row.date.toISOString().slice(0, 10) : '',
    opponent: row.opponent,
    us: row.us,
    them: row.them,
    isHome: row.is_home,
    format: row.format as Game['format'],
    periods: row.periods as Game['periods'],
    formation: row.formation,
    tactic: row.tactic,
    assignments: row.assignments ?? {},
    notes: row.notes ?? undefined,
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function gamesHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) {
      return { status: 401, jsonBody: { error: 'Not authenticated' } };
    }

    const teamId = req.query.get('teamId') ?? undefined;

    if (req.method === 'GET') {
      if (!teamId) {
        return { status: 400, jsonBody: { error: 'teamId is required' } };
      }
      if (!(await assertTeamOwner(user.id, teamId))) {
        return { status: 403, jsonBody: { error: 'Not your team' } };
      }
      const rows = await query<GameRow>(
        'SELECT * FROM game WHERE team_id = $1 ORDER BY game_no',
        [teamId],
      );
      return { status: 200, jsonBody: rows.map(toGame) };
    }

    // POST — upsert by (team_id, game_no)
    const body = (await req.json()) as Partial<Game>;
    if (!body.teamId) {
      return { status: 400, jsonBody: { error: 'teamId is required' } };
    }
    if (!(await assertTeamOwner(user.id, body.teamId))) {
      return { status: 403, jsonBody: { error: 'Not your team' } };
    }

    const existing = await queryOne<{ id: string }>(
      'SELECT id FROM game WHERE team_id = $1 AND game_no = $2',
      [body.teamId, body.gameNo ?? 0],
    );

    // Only a brand new game consumes quota.
    if (!existing) {
      const denied = await enforceLimit(user.id, 'games');
      if (denied) {
        return { status: denied.status, jsonBody: denied.body };
      }
    }

    const row = await queryOne<GameRow>(
      `INSERT INTO game (team_id, game_no, date, opponent, us, them, is_home,
                         format, periods, formation, tactic, assignments, notes, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
       ON CONFLICT (team_id, game_no) DO UPDATE SET
         date = EXCLUDED.date,
         opponent = EXCLUDED.opponent,
         us = EXCLUDED.us,
         them = EXCLUDED.them,
         is_home = EXCLUDED.is_home,
         format = EXCLUDED.format,
         periods = EXCLUDED.periods,
         formation = EXCLUDED.formation,
         tactic = EXCLUDED.tactic,
         assignments = EXCLUDED.assignments,
         notes = EXCLUDED.notes,
         updated_at = now()
       RETURNING *`,
      [
        body.teamId,
        body.gameNo ?? 0,
        body.date || null,
        body.opponent ?? '',
        body.us ?? 0,
        body.them ?? 0,
        body.isHome ?? true,
        body.format ?? '7v7',
        body.periods ?? 'quarters',
        body.formation ?? '2-3-1',
        body.tactic ?? 'balanced',
        JSON.stringify(body.assignments ?? {}),
        body.notes ?? null,
      ],
    );

    return { status: existing ? 200 : 201, jsonBody: row ? toGame(row) : null };
  } catch (err) {
    ctx.error('games failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('games', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'games',
  handler: gamesHandler,
});

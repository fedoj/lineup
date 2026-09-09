import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import type { Player } from '@lineup/shared';
import { assertTeamOwner, requireUser } from '../lib/auth.js';
import { query, transaction } from '../lib/db.js';

interface PlayerRow {
  id: string;
  team_id: string;
  number: string;
  name: string;
  active: boolean;
}

const toPlayer = (r: PlayerRow): Player => ({
  id: r.id,
  teamId: r.team_id,
  number: r.number,
  name: r.name,
  active: r.active,
});

export async function playersHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) {
      return { status: 401, jsonBody: { error: 'Not authenticated' } };
    }

    if (req.method === 'GET') {
      const teamId = req.query.get('teamId');
      if (!teamId) {
        return { status: 400, jsonBody: { error: 'teamId is required' } };
      }
      if (!(await assertTeamOwner(user.id, teamId))) {
        return { status: 403, jsonBody: { error: 'Not your team' } };
      }
      const rows = await query<PlayerRow>(
        'SELECT * FROM player WHERE team_id = $1 ORDER BY number',
        [teamId],
      );
      return { status: 200, jsonBody: rows.map(toPlayer) };
    }

    // PUT — replace the whole roster in one transaction
    const body = (await req.json()) as { teamId?: string; players?: Partial<Player>[] };
    if (!body.teamId) {
      return { status: 400, jsonBody: { error: 'teamId is required' } };
    }
    if (!(await assertTeamOwner(user.id, body.teamId))) {
      return { status: 403, jsonBody: { error: 'Not your team' } };
    }

    const players = body.players ?? [];
    const saved = await transaction(async (client) => {
      await client.query('DELETE FROM player WHERE team_id = $1', [body.teamId]);
      const out: PlayerRow[] = [];
      for (const p of players) {
        if (!p.name?.trim()) continue;
        const res = await client.query<PlayerRow>(
          `INSERT INTO player (team_id, number, name, active)
           VALUES ($1,$2,$3,$4) RETURNING *`,
          [body.teamId, p.number ?? '', p.name.trim(), p.active ?? true],
        );
        if (res.rows[0]) out.push(res.rows[0]);
      }
      return out;
    });

    return { status: 200, jsonBody: saved.map(toPlayer) };
  } catch (err) {
    ctx.error('players failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('players', {
  methods: ['GET', 'PUT'],
  authLevel: 'anonymous',
  route: 'players',
  handler: playersHandler,
});

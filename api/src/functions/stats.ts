import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { canOnTeam } from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { guardTeam } from '../lib/authz.js';
import { query, queryOne } from '../lib/db.js';
import { enforceFeature } from '../lib/entitlements.js';

/**
 * Custom stats: a paid feature.
 *
 * Coaches and above (team.edit) define the stats their team tracks. Anyone who
 * runs match day (stats.edit) records counts per player per game. Viewing
 * follows the same rules as the rest of a team's stats.
 */

function clip(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

interface StatRow {
  id: string;
  name: string;
}

/** Stats defined for a team, with season totals per player. */
export async function teamStatsHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    if (req.method === 'GET') {
      const guard = await guardTeam(user, req.query.get('teamId') ?? undefined, 'stats.view');
      if (!guard.ok) return guard.response;
      const locked = Boolean(await enforceFeature(user.id, 'customStats'));
      const [stats, totals] = await Promise.all([
        query<StatRow>(
          `SELECT id, name FROM team_stat WHERE team_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
          [guard.team.teamId],
        ),
        query<{ player_id: string; stat_id: string; total: number }>(
          `SELECT v.player_id, v.stat_id, SUM(v.value)::int AS total
             FROM player_stat_value v
             JOIN team_stat s ON s.id = v.stat_id AND s.deleted_at IS NULL
             JOIN game g ON g.id = v.game_id AND g.deleted_at IS NULL
            WHERE s.team_id = $1
            GROUP BY v.player_id, v.stat_id`,
          [guard.team.teamId],
        ),
      ]);
      const byPlayer: Record<string, Record<string, number>> = {};
      for (const t of totals) (byPlayer[t.player_id] ??= {})[t.stat_id] = t.total;
      return {
        status: 200,
        jsonBody: {
          stats,
          totals: byPlayer,
          locked,
          canManage: !locked && canOnTeam(guard.ctx, guard.team, 'team.edit').allowed,
          canRecord: !locked && canOnTeam(guard.ctx, guard.team, 'stats.edit').allowed,
        },
      };
    }

    if (req.method === 'DELETE') {
      const id = req.query.get('id') ?? '';
      const row = await queryOne<{ team_id: string }>(
        'SELECT team_id FROM team_stat WHERE id = $1 AND deleted_at IS NULL',
        [id],
      );
      const guard = await guardTeam(user, row?.team_id, 'team.edit');
      if (!guard.ok) return guard.response;
      await query('UPDATE team_stat SET deleted_at = now() WHERE id = $1', [id]);
      return { status: 204 };
    }

    // POST — add a stat.
    const b = (await req.json()) as { teamId?: string; name?: string };
    const guard = await guardTeam(user, clip(b.teamId, 40) || undefined, 'team.edit');
    if (!guard.ok) return guard.response;
    const denied = await enforceFeature(user.id, 'customStats');
    if (denied) return { status: denied.status, jsonBody: denied.body };

    const name = clip(b.name, 40);
    if (!name) return { status: 400, jsonBody: { error: 'Give the stat a name.' } };
    const count = await queryOne<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM team_stat WHERE team_id = $1 AND deleted_at IS NULL',
      [guard.team.teamId],
    );
    if ((count?.n ?? 0) >= 12) {
      return { status: 409, jsonBody: { error: 'A team can track up to 12 custom stats.' } };
    }
    try {
      const row = await queryOne<StatRow>(
        `INSERT INTO team_stat (team_id, name, created_by) VALUES ($1, $2, $3) RETURNING id, name`,
        [guard.team.teamId, name, user.id],
      );
      return { status: 201, jsonBody: row };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        return { status: 409, jsonBody: { error: 'This team already tracks a stat with that name.' } };
      }
      throw e;
    }
  } catch (err) {
    ctx.error('team stats failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/** Per-game counts: read them all, or add/subtract one for a player. */
export async function statValuesHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    const gameId =
      req.method === 'GET'
        ? req.query.get('gameId') ?? ''
        : clip(((await req.clone().json()) as { gameId?: string }).gameId, 40);
    const game = await queryOne<{ team_id: string }>(
      'SELECT team_id FROM game WHERE id = $1 AND deleted_at IS NULL',
      [gameId],
    );

    if (req.method === 'GET') {
      const guard = await guardTeam(user, game?.team_id, 'stats.view');
      if (!guard.ok) return guard.response;
      const rows = await query<{ player_id: string; stat_id: string; value: number }>(
        `SELECT v.player_id, v.stat_id, v.value
           FROM player_stat_value v JOIN team_stat s ON s.id = v.stat_id AND s.deleted_at IS NULL
          WHERE v.game_id = $1`,
        [gameId],
      );
      return {
        status: 200,
        jsonBody: rows.map((r) => ({ playerId: r.player_id, statId: r.stat_id, value: r.value })),
      };
    }

    const guard = await guardTeam(user, game?.team_id, 'stats.edit');
    if (!guard.ok) return guard.response;
    const denied = await enforceFeature(user.id, 'customStats');
    if (denied) return { status: denied.status, jsonBody: denied.body };

    const b = (await req.json()) as { playerId?: string; statId?: string; delta?: number };
    const delta = Math.max(-1, Math.min(1, Math.trunc(Number(b.delta) || 0)));
    if (!delta) return { status: 400, jsonBody: { error: 'delta must be 1 or -1' } };

    // Both must belong to this game's team, or a crafted request could write
    // stats onto someone else's roster.
    const ok = await queryOne<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM player WHERE id = $1 AND team_id = $3)
          AND EXISTS (SELECT 1 FROM team_stat WHERE id = $2 AND team_id = $3 AND deleted_at IS NULL) AS ok`,
      [clip(b.playerId, 40), clip(b.statId, 40), guard.team.teamId],
    );
    if (!ok?.ok) return { status: 400, jsonBody: { error: 'Unknown player or stat for this team.' } };

    const row = await queryOne<{ value: number }>(
      `INSERT INTO player_stat_value (game_id, player_id, stat_id, value)
       VALUES ($1, $2, $3, GREATEST(0, $4))
       ON CONFLICT (game_id, player_id, stat_id)
       DO UPDATE SET value = GREATEST(0, player_stat_value.value + $4), updated_at = now()
       RETURNING value`,
      [gameId, b.playerId, b.statId, delta],
    );
    return { status: 200, jsonBody: { playerId: b.playerId, statId: b.statId, value: row?.value ?? 0 } };
  } catch (err) {
    ctx.error('stat values failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('teamStats', {
  methods: ['GET', 'POST', 'DELETE'], authLevel: 'anonymous', route: 'team-stats', handler: teamStatsHandler,
});
app.http('statValues', {
  methods: ['GET', 'POST'], authLevel: 'anonymous', route: 'stat-values', handler: statValuesHandler,
});

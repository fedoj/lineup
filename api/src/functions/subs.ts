import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { periodCount, type DoneSub, type Periods } from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { guardTeam } from '../lib/authz.js';
import { query, queryOne, transaction } from '../lib/db.js';
import { gameLocked } from '../lib/gameLock.js';

/**
 * Planned substitutions on match day (Fady, 10/17, migration 050). Coaches
 * and assistant coaches plan who comes off and on, in which period and at
 * what time on the period clock; match day reminds them when the clock gets
 * there. "Done" records a 'sub' match event and moves the rest of the period's
 * minutes to the player coming on (minutesFromAssignments).
 */

const MAX_PER_GAME = 40;

interface SubRow {
  id: string;
  period_index: number;
  at_sec: number;
  off_player_id: string;
  on_player_id: string;
  done: boolean;
  skipped: boolean;
}

const out = (r: SubRow) => ({
  id: r.id,
  periodIndex: r.period_index,
  atSec: r.at_sec,
  offPlayerId: r.off_player_id,
  onPlayerId: r.on_player_id,
  done: r.done,
  skipped: r.skipped,
});

async function listSubs(gameId: string) {
  const rows = await query<SubRow>(
    `SELECT id, period_index, at_sec, off_player_id, on_player_id,
            (done_at IS NOT NULL) AS done, (skipped_at IS NOT NULL) AS skipped
       FROM game_sub_plan WHERE game_id = $1 ORDER BY period_index, at_sec, created_at`,
    [gameId],
  );
  return rows.map(out);
}

/** Subs marked done, per game, for counting minutes. */
export async function doneSubsByGame(gameIds: string[]): Promise<Map<string, DoneSub[]>> {
  const map = new Map<string, DoneSub[]>();
  if (!gameIds.length) return map;
  const rows = await query<{ game_id: string; period_index: number; at_sec: number; off_player_id: string; on_player_id: string }>(
    `SELECT game_id, period_index, at_sec, off_player_id, on_player_id FROM game_sub_plan
      WHERE game_id = ANY($1::uuid[]) AND done_at IS NOT NULL ORDER BY at_sec`,
    [gameIds],
  );
  for (const r of rows) {
    const list = map.get(r.game_id) ?? [];
    list.push({ periodIndex: r.period_index, atSec: r.at_sec, offPlayerId: r.off_player_id, onPlayerId: r.on_player_id });
    map.set(r.game_id, list);
  }
  return map;
}

async function gameOf(id: string) {
  return queryOne<{ id: string; team_id: string; periods: string | null; period_length_sec: number | null }>(
    'SELECT id, team_id, periods, period_length_sec FROM game WHERE id = $1 AND deleted_at IS NULL',
    [id],
  );
}

export async function subsHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    if (req.method === 'GET') {
      const game = await gameOf((req.query.get('gameId') ?? '').slice(0, 36));
      const guard = await guardTeam(user, game?.team_id, 'game.view');
      if (!guard.ok || !game) return guard.ok ? { status: 404, jsonBody: { error: 'Game not found' } } : guard.response;
      return { status: 200, jsonBody: { subs: await listSubs(game.id) } };
    }

    const b = (await req.json()) as {
      action?: string;
      gameId?: string;
      id?: string;
      periodIndex?: unknown;
      atSec?: unknown;
      offPlayerId?: string;
      onPlayerId?: string;
    };

    // Everything but "add" works on an existing planned sub.
    let gameId = String(b.gameId ?? '').slice(0, 36);
    let existing: { id: string; game_id: string; period_index: number; at_sec: number; on_player_id: string; off_player_id: string; event_id: string | null } | undefined;
    if (b.action !== 'add') {
      existing = await queryOne(
        'SELECT id, game_id, period_index, at_sec, on_player_id, off_player_id, event_id FROM game_sub_plan WHERE id = $1',
        [String(b.id ?? '').slice(0, 36)],
      );
      if (!existing) return { status: 404, jsonBody: { error: 'That sub is not planned.' } };
      gameId = existing.game_id;
    }
    const game = await gameOf(gameId);
    // Coaches and assistant coaches plan subs (no approval needed, Fady 10/17).
    const guard = await guardTeam(user, game?.team_id, 'lineup.edit');
    if (!guard.ok) return guard.response;
    if (!game) return { status: 404, jsonBody: { error: 'Game not found' } };
    const lock = await gameLocked(game.id);
    if (lock) return lock;

    if (b.action === 'add') {
      const periodIndex = Number(b.periodIndex);
      const atSec = Math.round(Number(b.atSec));
      const count = periodCount((game.periods ?? 'quarters') as Periods);
      const length = game.period_length_sec ?? 720;
      if (!Number.isInteger(periodIndex) || periodIndex < 0 || periodIndex >= count) {
        return { status: 400, jsonBody: { error: 'Pick a period.' } };
      }
      if (!Number.isFinite(atSec) || atSec < 0 || atSec > length) {
        return { status: 400, jsonBody: { error: `Pick a time within the period (0:00 to ${Math.floor(length / 60)}:00).` } };
      }
      const off = String(b.offPlayerId ?? '').slice(0, 36);
      const on = String(b.onPlayerId ?? '').slice(0, 36);
      if (!off || !on || off === on) return { status: 400, jsonBody: { error: 'Pick who comes off and who comes on.' } };
      const players = await query<{ id: string }>(
        `SELECT id FROM player WHERE team_id = $1 AND id = ANY($2::uuid[])
         UNION
         SELECT player_id FROM game_guest WHERE game_id = $3 AND status = 'approved' AND player_id = ANY($2::uuid[])`,
        [game.team_id, [off, on], game.id],
      );
      if (players.length !== 2) return { status: 400, jsonBody: { error: 'Both players must be on this team or guests in this game.' } };
      const n = await queryOne<{ n: number }>('SELECT COUNT(*)::int AS n FROM game_sub_plan WHERE game_id = $1', [game.id]);
      if ((n?.n ?? 0) >= MAX_PER_GAME) return { status: 400, jsonBody: { error: `A game can have at most ${MAX_PER_GAME} planned subs.` } };
      await query(
        `INSERT INTO game_sub_plan (game_id, period_index, at_sec, off_player_id, on_player_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [game.id, periodIndex, atSec, off, on, user.id],
      );
      return { status: 201, jsonBody: { subs: await listSubs(game.id) } };
    }

    const sub = existing!;
    if (b.action === 'remove') {
      await query('DELETE FROM game_sub_plan WHERE id = $1', [sub.id]);
    } else if (b.action === 'done') {
      await transaction(async (c) => {
        const names = await c.query<{ id: string; name: string }>('SELECT id, name FROM player WHERE id = ANY($1::uuid[])', [
          [sub.on_player_id, sub.off_player_id],
        ]);
        const offName = names.rows.find((p) => p.id === sub.off_player_id)?.name ?? 'a teammate';
        // The match log shows it like a sub tapped in by hand.
        const ev = await c.query<{ id: string }>(
          `INSERT INTO game_event (game_id, player_id, kind, period_index, clock_sec, against, note)
           VALUES ($1, $2, 'sub', $3, $4, false, $5) RETURNING id`,
          [game.id, sub.on_player_id, sub.period_index, sub.at_sec, `on for ${offName}`],
        );
        await c.query('UPDATE game_sub_plan SET done_at = now(), skipped_at = NULL, event_id = $2 WHERE id = $1', [
          sub.id,
          ev.rows[0].id,
        ]);
      });
    } else if (b.action === 'skip') {
      await query('UPDATE game_sub_plan SET skipped_at = now() WHERE id = $1 AND done_at IS NULL', [sub.id]);
    } else if (b.action === 'undo') {
      await transaction(async (c) => {
        if (sub.event_id) await c.query('DELETE FROM game_event WHERE id = $1', [sub.event_id]);
        await c.query('UPDATE game_sub_plan SET done_at = NULL, skipped_at = NULL, event_id = NULL WHERE id = $1', [sub.id]);
      });
    } else {
      return { status: 400, jsonBody: { error: 'Unknown action' } };
    }
    return { status: 200, jsonBody: { subs: await listSubs(game.id) } };
  } catch (err) {
    ctx.error('subs failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('subs', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'subs',
  handler: subsHandler,
});

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import {
  buildFairLineup,
  copyLineup,
  removeUnavailable,
  periodCount,
  type Format,
  type Periods,
} from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { guardTeam } from '../lib/authz.js';
import { query, queryOne, transaction } from '../lib/db.js';
import { gameLocked } from '../lib/gameLock.js';
import { enforceFeature } from '../lib/entitlements.js';
import { lineupGate, loadProposal, notifyDecision, saveProposal } from '../lib/lineupApproval.js';

interface PeriodRow {
  id: string;
  game_id: string;
  period_index: number;
  formation: string | null;
  length_sec: number;
  elapsed_sec: number;
  started_at: Date | null;
  ended_at: Date | null;
}

function toPeriod(r: PeriodRow) {
  // Live elapsed includes time accrued since the clock was started.
  const running = Boolean(r.started_at && !r.ended_at);
  const since = running ? Math.floor((Date.now() - r.started_at!.getTime()) / 1000) : 0;
  return {
    id: r.id,
    gameId: r.game_id,
    periodIndex: r.period_index,
    formation: r.formation,
    lengthSec: r.length_sec,
    elapsedSec: r.elapsed_sec + since,
    running,
    startedAt: r.started_at?.toISOString() ?? null,
    endedAt: r.ended_at?.toISOString() ?? null,
  };
}

async function gameTeamId(gameId: string): Promise<string | undefined> {
  const row = await queryOne<{ team_id: string }>(
    'SELECT team_id FROM game WHERE id = $1 AND deleted_at IS NULL',
    [gameId],
  );
  return row?.team_id;
}

/** Create the period rows for a game if they do not exist yet. */
async function ensurePeriods(
  gameId: string,
  periods: Periods,
  lengthSec: number,
  formation: string,
): Promise<void> {
  const count = periodCount(periods);
  await transaction(async (client) => {
    for (let i = 0; i < count; i++) {
      await client.query(
        `INSERT INTO game_period (game_id, period_index, formation, length_sec)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (game_id, period_index) DO NOTHING`,
        [gameId, i, formation, lengthSec],
      );
    }
    // Drop any periods beyond the current count, e.g. quarters -> halves.
    await client.query(
      'DELETE FROM game_period WHERE game_id = $1 AND period_index >= $2',
      [gameId, count],
    );
  });
}

/* --------------------------------------------------------------- periods */

export async function periodsHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    const gameId = req.query.get('gameId') ?? undefined;
    if (!gameId) return { status: 400, jsonBody: { error: 'gameId is required' } };

    const teamId = await gameTeamId(gameId);
    const action = req.method === 'GET' ? 'game.view' : 'timer.run';
    const guard = await guardTeam(user, teamId, action);
    if (!guard.ok) return guard.response;
    if (req.method !== 'GET') {
      const lock = await gameLocked(gameId);
      if (lock) return lock;
    }

    if (req.method === 'GET') {
      const game = await queryOne<{
        periods: string;
        period_length_sec: number;
        formation: string;
      }>('SELECT periods, period_length_sec, formation FROM game WHERE id = $1', [gameId]);

      if (game) {
        await ensurePeriods(
          gameId,
          game.periods as Periods,
          game.period_length_sec,
          game.formation,
        );
      }

      const rows = await query<PeriodRow>(
        'SELECT * FROM game_period WHERE game_id = $1 ORDER BY period_index',
        [gameId],
      );
      return { status: 200, jsonBody: rows.map(toPeriod) };
    }

    // POST — clock control and per-period formation.
    const body = (await req.json()) as {
      periodIndex?: number;
      action?: 'start' | 'pause' | 'reset' | 'end' | 'setFormation' | 'setLength';
      formation?: string;
      lengthSec?: number;
    };

    const idx = body.periodIndex ?? 0;

    // Running the match clock is a paid feature; formations stay free.
    if (body.action === 'start' || body.action === 'pause' || body.action === 'reset' || body.action === 'end') {
      const denial = await enforceFeature(user.id, 'matchClock');
      if (denial) return { status: denial.status, jsonBody: denial.body };
    }

    switch (body.action) {
      case 'start':
        // started_at is only set when not already running, so a double tap
        // does not reset the accrued time.
        await query(
          `UPDATE game_period
              SET started_at = COALESCE(started_at, now()), ended_at = NULL, updated_at = now()
            WHERE game_id = $1 AND period_index = $2 AND started_at IS NULL`,
          [gameId, idx],
        );
        break;

      case 'pause':
        // Fold the running time into elapsed_sec, then stop the clock.
        await query(
          `UPDATE game_period
              SET elapsed_sec = elapsed_sec
                  + GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - started_at)))::int),
                  started_at = NULL,
                  updated_at = now()
            WHERE game_id = $1 AND period_index = $2 AND started_at IS NOT NULL`,
          [gameId, idx],
        );
        break;

      case 'reset':
        await query(
          `UPDATE game_period
              SET elapsed_sec = 0, started_at = NULL, ended_at = NULL, updated_at = now()
            WHERE game_id = $1 AND period_index = $2`,
          [gameId, idx],
        );
        break;

      case 'end':
        await query(
          `UPDATE game_period
              SET elapsed_sec = elapsed_sec
                  + CASE WHEN started_at IS NULL THEN 0
                         ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - started_at)))::int)
                    END,
                  started_at = NULL, ended_at = now(), updated_at = now()
            WHERE game_id = $1 AND period_index = $2`,
          [gameId, idx],
        );
        break;

      case 'setFormation': {
        // Before the game an assistant's new shape is part of their proposal.
        const gate = await lineupGate(guard, gameId);
        if (gate.needsApproval) {
          const [proposal, game] = await Promise.all([
            loadProposal(gameId),
            queryOne<{ assignments: Record<string, Record<string, string>> }>('SELECT assignments FROM game WHERE id = $1', [gameId]),
          ]);
          const formations = { ...(proposal?.formations ?? {}), [String(idx)]: body.formation ?? '' };
          await saveProposal(gameId, user.id, proposal?.assignments ?? game?.assignments ?? {}, formations);
          const rows = await query<PeriodRow>('SELECT * FROM game_period WHERE game_id = $1 ORDER BY period_index', [gameId]);
          return {
            status: 200,
            jsonBody: rows.map((r) => {
              const p = toPeriod(r);
              return formations[String(p.periodIndex)] ? { ...p, formation: formations[String(p.periodIndex)] } : p;
            }),
          };
        }
        await query(
          `UPDATE game_period SET formation = $3, updated_at = now()
            WHERE game_id = $1 AND period_index = $2`,
          [gameId, idx, body.formation ?? null],
        );
        break;
      }

      case 'setLength':
        await query(
          `UPDATE game_period SET length_sec = $3, updated_at = now()
            WHERE game_id = $1 AND period_index = $2`,
          [gameId, idx, body.lengthSec ?? 720],
        );
        break;

      default:
        return { status: 400, jsonBody: { error: 'Unknown action' } };
    }

    const rows = await query<PeriodRow>(
      'SELECT * FROM game_period WHERE game_id = $1 ORDER BY period_index',
      [gameId],
    );
    return { status: 200, jsonBody: rows.map(toPeriod) };
  } catch (err) {
    ctx.error('periods failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/* ---------------------------------------------------------- availability */

export async function availabilityHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    const gameId = req.query.get('gameId') ?? undefined;
    if (!gameId) return { status: 400, jsonBody: { error: 'gameId is required' } };

    const teamId = await gameTeamId(gameId);
    const guard = await guardTeam(
      user,
      teamId,
      req.method === 'GET' ? 'game.view' : 'lineup.edit',
    );
    if (!guard.ok) return guard.response;

    if (req.method === 'GET') {
      const rows = await query<{ player_id: string; status: string; note: string | null }>(
        'SELECT player_id, status, note FROM game_availability WHERE game_id = $1',
        [gameId],
      );
      return { status: 200, jsonBody: rows };
    }

    const body = (await req.json()) as {
      playerId?: string;
      status?: string;
      note?: string;
      /** When true, also strip the player from the saved lineup. */
      stripFromLineup?: boolean;
    };
    if (!body.playerId) return { status: 400, jsonBody: { error: 'playerId is required' } };

    await query(
      `INSERT INTO game_availability (game_id, player_id, status, note)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (game_id, player_id)
       DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note`,
      [gameId, body.playerId, body.status ?? 'available', body.note ?? null],
    );

    // Marking someone absent pulls them out of the lineup automatically (and
    // out of an assistant's pending proposal), with no approval needed.
    if (body.stripFromLineup !== false && body.status && body.status !== 'available') {
      const game = await queryOne<{ assignments: Record<string, Record<string, string>> }>(
        'SELECT assignments FROM game WHERE id = $1',
        [gameId],
      );
      if (game) {
        const { assignments } = removeUnavailable(game.assignments ?? {}, [body.playerId]);
        await query('UPDATE game SET assignments = $2, updated_at = now() WHERE id = $1', [
          gameId,
          JSON.stringify(assignments),
        ]);
      }
      const proposal = await loadProposal(gameId);
      if (proposal) {
        const { assignments } = removeUnavailable(proposal.assignments, [body.playerId]);
        await query('UPDATE lineup_proposal SET assignments = $2::jsonb WHERE game_id = $1', [
          gameId,
          JSON.stringify(assignments),
        ]);
      }
    }

    const rows = await query<{ player_id: string; status: string; note: string | null }>(
      'SELECT player_id, status, note FROM game_availability WHERE game_id = $1',
      [gameId],
    );
    return { status: 200, jsonBody: rows };
  } catch (err) {
    ctx.error('availability failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/* ---------------------------------------------------------------- lineup */

/** Auto-fill, copy from a previous game, or save a manual placement. */
export async function lineupHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    const body = (await req.json()) as {
      gameId?: string;
      action?: 'auto' | 'copy' | 'set' | 'clear';
      sourceGameId?: string;
      seed?: number;
      periodIndex?: number;
      slotId?: string;
      playerId?: string | null;
      assignments?: Record<string, Record<string, string>>;
    };

    if (!body.gameId) return { status: 400, jsonBody: { error: 'gameId is required' } };

    const teamId = await gameTeamId(body.gameId);
    const guard = await guardTeam(user, teamId, 'lineup.edit');
    if (!guard.ok) return guard.response;
    const lock = await gameLocked(body.gameId);
    if (lock) return lock;

    const game = await queryOne<{
      id: string;
      team_id: string;
      format: string;
      periods: string;
      formation: string;
      assignments: Record<string, Record<string, string>>;
    }>('SELECT id, team_id, format, periods, formation, assignments FROM game WHERE id = $1', [
      body.gameId,
    ]);
    if (!game) return { status: 404, jsonBody: { error: 'Game not found' } };

    // Before the game an assistant's changes go into a proposal for the coach.
    const [gate, proposal] = await Promise.all([lineupGate(guard, game.id), loadProposal(game.id)]);
    const proposing = gate.needsApproval;

    const count = periodCount(game.periods as Periods);

    // Per-period formations, falling back to the game default.
    const periodRows = await query<{ period_index: number; formation: string | null }>(
      'SELECT period_index, formation FROM game_period WHERE game_id = $1 ORDER BY period_index',
      [game.id],
    );
    const formations = Array.from(
      { length: count },
      (_, i) =>
        (proposing ? proposal?.formations[String(i)] : undefined) ??
        periodRows.find((p) => p.period_index === i)?.formation ??
        game.formation,
    );

    let next = (proposing ? proposal?.assignments : undefined) ?? game.assignments ?? {};
    let report: unknown = null;

    if (body.action === 'auto') {
      const players = await query<{
        id: string;
        name: string;
        status: string | null;
        primary_pos: string | null;
        secondary_pos: string | null;
        never_keeper: boolean;
      }>(
        `SELECT p.id, p.name, a.status, p.primary_pos, p.secondary_pos, p.never_keeper
           FROM player p
           LEFT JOIN game_availability a ON a.player_id = p.id AND a.game_id = $2
          WHERE (p.team_id = $1 AND p.active)
             -- Players borrowed from another team for this game (Fady, 10/18).
             OR p.id IN (SELECT player_id FROM game_guest WHERE game_id = $2 AND status = 'approved')
          ORDER BY p.name`,
        [game.team_id, game.id],
      );

      const result = buildFairLineup({
        players: players.map((p) => ({
          id: p.id,
          name: p.name,
          available: !p.status || p.status === 'available' || p.status === 'late',
          primaryPos: p.primary_pos,
          secondaryPos: p.secondary_pos,
          neverKeeper: p.never_keeper,
        })),
        format: game.format as Format,
        periods: count,
        formations,
        seed: body.seed ?? Date.now() % 100000,
      });
      next = result.assignments;
      report = { fairness: result.fairness, spread: result.spread, warnings: result.warnings };
    } else if (body.action === 'copy') {
      if (!body.sourceGameId) {
        return { status: 400, jsonBody: { error: 'sourceGameId is required' } };
      }
      // The source must be a game on the same team, so a copy cannot reach
      // across into a team the caller does not own.
      const source = await queryOne<{
        assignments: Record<string, Record<string, string>>;
      }>('SELECT assignments FROM game WHERE id = $1 AND team_id = $2', [
        body.sourceGameId,
        game.team_id,
      ]);
      if (!source) return { status: 404, jsonBody: { error: 'Source game not found' } };

      const eligible = await query<{ id: string }>(
        `SELECT p.id FROM player p
           LEFT JOIN game_availability a ON a.player_id = p.id AND a.game_id = $2
          WHERE ((p.team_id = $1 AND p.active)
                 OR p.id IN (SELECT player_id FROM game_guest WHERE game_id = $2 AND status = 'approved'))
            AND (a.status IS NULL OR a.status IN ('available','late'))`,
        [game.team_id, game.id],
      );

      const result = copyLineup(source.assignments ?? {}, {
        format: game.format as Format,
        formations,
        periods: count,
        eligiblePlayerIds: eligible.map((e) => e.id),
      });
      next = result.assignments;
      report = { dropped: result.dropped };

      if (!proposing) {
        await query('UPDATE game SET copied_from_game_id = $2 WHERE id = $1', [
          game.id,
          body.sourceGameId,
        ]);
      }
    } else if (body.action === 'set') {
      // Single slot placement — the tap-to-place interaction.
      const p = String(body.periodIndex ?? 0);
      const slot = body.slotId;
      if (!slot) return { status: 400, jsonBody: { error: 'slotId is required' } };

      next = { ...next, [p]: { ...(next[p] ?? {}) } };
      if (body.playerId) {
        // A player can only occupy one slot per period.
        for (const key of Object.keys(next[p])) {
          if (next[p][key] === body.playerId) delete next[p][key];
        }
        next[p][slot] = body.playerId;
      } else {
        delete next[p][slot];
      }
    } else if (body.action === 'clear') {
      next = {};
    } else if (body.assignments) {
      next = body.assignments;
    } else {
      return { status: 400, jsonBody: { error: 'Unknown action' } };
    }

    if (proposing) {
      await saveProposal(game.id, user.id, next, proposal?.formations ?? {});
      return { status: 200, jsonBody: { assignments: next, report, proposal: true } };
    }

    await query('UPDATE game SET assignments = $2, updated_at = now() WHERE id = $1', [
      game.id,
      JSON.stringify(next),
    ]);

    return { status: 200, jsonBody: { assignments: next, report } };
  } catch (err) {
    ctx.error('lineup failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/* ------------------------------------------------------ lineup proposals */

/**
 * GET: the game's pending assistant proposal and what the caller may do.
 * POST: approve or reject it (coaches), or set whether the assistant may
 * change this game's lineup without approval (coaches).
 */
export async function lineupProposalHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    const b =
      req.method === 'GET'
        ? { gameId: req.query.get('gameId') ?? undefined }
        : ((await req.json()) as { gameId?: string; action?: 'approve' | 'reject' | 'assistantFree'; value?: boolean });
    const gameId = String(b.gameId ?? '').slice(0, 36);
    if (!gameId) return { status: 400, jsonBody: { error: 'gameId is required' } };

    const teamId = await gameTeamId(gameId);
    const guard = await guardTeam(user, teamId, req.method === 'GET' ? 'game.view' : 'lineup.edit');
    if (!guard.ok) return guard.response;
    if (req.method !== 'GET') {
      const lock = await gameLocked(gameId);
      if (lock) return lock;
    }

    const state = async () => {
      const [gate, proposal] = await Promise.all([lineupGate(guard, gameId), loadProposal(gameId)]);
      return { ...gate, proposal };
    };

    if (req.method === 'GET') return { status: 200, jsonBody: await state() };

    const action = (b as { action?: string }).action;
    const gate = await lineupGate(guard, gameId);
    if (!gate.canApprove) {
      return { status: 403, jsonBody: { error: 'Only a coach can do that.', code: 'FORBIDDEN' } };
    }

    if (action === 'assistantFree') {
      await query('UPDATE game SET assistant_free = $2, updated_at = now() WHERE id = $1', [
        gameId,
        Boolean((b as { value?: boolean }).value),
      ]);
      return { status: 200, jsonBody: await state() };
    }

    const proposal = await loadProposal(gameId);
    if (!proposal) return { status: 404, jsonBody: { error: 'There is nothing waiting for approval.' } };

    if (action === 'approve') {
      const game = await queryOne<{ periods: string; period_length_sec: number; formation: string }>(
        'SELECT periods, period_length_sec, formation FROM game WHERE id = $1',
        [gameId],
      );
      if (game) await ensurePeriods(gameId, game.periods as Periods, game.period_length_sec, game.formation);
      await transaction(async (c) => {
        await c.query('UPDATE game SET assignments = $2::jsonb, updated_at = now() WHERE id = $1', [
          gameId,
          JSON.stringify(proposal.assignments),
        ]);
        for (const [idx, formation] of Object.entries(proposal.formations)) {
          if (!formation) continue;
          await c.query(
            'UPDATE game_period SET formation = $3, updated_at = now() WHERE game_id = $1 AND period_index = $2',
            [gameId, Number(idx), formation],
          );
        }
        await c.query('DELETE FROM lineup_proposal WHERE game_id = $1', [gameId]);
      });
    } else if (action === 'reject') {
      await query('DELETE FROM lineup_proposal WHERE game_id = $1', [gameId]);
    } else {
      return { status: 400, jsonBody: { error: 'Unknown action' } };
    }
    // The coach has seen it: their "to approve" notification is done.
    await query('UPDATE notification SET read_at = now() WHERE group_key = $1 AND read_at IS NULL', [`lineup:${gameId}`]).catch(
      () => undefined,
    );
    await notifyDecision(gameId, proposal.proposedBy, action === 'approve');
    return { status: 200, jsonBody: await state() };
  } catch (err) {
    ctx.error('lineup proposal failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('periods', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'periods',
  handler: periodsHandler,
});

app.http('availability', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'availability',
  handler: availabilityHandler,
});

app.http('lineup', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'lineup',
  handler: lineupHandler,
});

app.http('lineupProposal', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'lineup-proposal',
  handler: lineupProposalHandler,
});

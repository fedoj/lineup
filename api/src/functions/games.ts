import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { FORMATS, isValidFormation, periodCount, type Format, type Game, type Periods } from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { guardTeam } from '../lib/authz.js';
import { query, queryOne } from '../lib/db.js';
import { gameLocked } from '../lib/gameLock.js';
import { enforceTeamScopedLimit } from '../lib/entitlements.js';
import { lineupGate, loadProposal, saveProposal } from '../lib/lineupApproval.js';

/** The shape a game in this format starts with. */
function defaultFormation(format: string): string {
  return FORMATS[format as Format]?.defaultFormation ?? '2-3-1';
}

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
  period_length_sec: number;
  formation: string;
  tactic: string;
  assignments: Record<string, Record<string, string>>;
  notes: string | null;
  fixture_id: string | null;
  /** A friendly between two Lineup teams: both copies share it. */
  pair_id?: string | null;
  kickoff: string | null;
  location: string | null;
  field: string | null;
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
    periodLengthSec: row.period_length_sec,
    formation: row.formation,
    tactic: row.tactic,
    assignments: row.assignments ?? {},
    notes: row.notes ?? undefined,
    fixtureId: row.fixture_id ?? undefined,
    kickoff: row.kickoff ?? undefined,
    location: row.location ?? undefined,
    field: row.field ?? undefined,
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Calendar dates that count as "today" across the continental US. The game
 * table stores a date without a timezone, so a lineup unlocks from midnight
 * Eastern and stays open until midnight Pacific.
 */
function gameDayDates(now = new Date()): Set<string> {
  const fmt = (timeZone: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(now);
  return new Set([fmt('America/New_York'), fmt('America/Los_Angeles')]);
}

/** Roles that see a lineup only on the day it is played. */
const GAME_DAY_ONLY = new Set(['parent', 'player']);
/** Roles that never see lineups: a team parent runs the team's life, not match day. */
const NO_LINEUP = new Set(['team_parent']);

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
      const guard = await guardTeam(user, teamId, 'game.view');
      if (!guard.ok) return guard.response;

      const rows = await query<GameRow>(
        `SELECT * FROM game WHERE team_id = $1 AND deleted_at IS NULL
          ORDER BY game_no`,
        [guard.team.teamId],
      );
      if (NO_LINEUP.has(guard.role)) {
        return {
          status: 200,
          jsonBody: rows.map((r) => ({ ...toGame(r), assignments: {}, lineupHidden: true })),
        };
      }
      // Parents and players learn the lineup on game day, at the same time
      // as everyone else, so it cannot be lobbied over in advance.
      if (GAME_DAY_ONLY.has(guard.role)) {
        const today = gameDayDates();
        return {
          status: 200,
          jsonBody: rows.map((r) => {
            const g = toGame(r);
            return today.has(g.date) ? g : { ...g, assignments: {}, lineupHidden: true };
          }),
        };
      }
      return { status: 200, jsonBody: rows.map(toGame) };
    }

    // POST — upsert by (team_id, game_no)
    const body = (await req.json()) as Partial<Game>;
    const guard = await guardTeam(user, body.teamId, 'game.edit');
    if (!guard.ok) return guard.response;

    const existing = await queryOne<{
      id: string;
      format: string;
      periods: string;
      formation: string;
      fixture_id: string | null;
    }>('SELECT id, format, periods, formation, fixture_id FROM game WHERE team_id = $1 AND game_no = $2', [
      guard.team.teamId,
      body.gameNo ?? 0,
    ]);
    // A game whose league or tournament ended more than 3 days ago is locked.
    const lock = await gameLocked(existing?.id);
    if (lock) return lock;

    // A league game's date, opponent and venue belong to the fixture, which
    // only the org or region can change; a team edit must not fork them.
    if (existing?.fixture_id) {
      delete body.date;
      delete body.opponent;
      delete body.isHome;
    }

    // Before the game, an assistant's new formation or lineup is a proposal
    // for the coach (match day shows it), not a change to the game.
    let proposed = false;
    if (existing && guard.role === 'assistant') {
      const gate = await lineupGate(guard, existing.id);
      const shapeChange = body.formation && body.formation !== existing.formation && !(body.format && body.format !== existing.format);
      if (gate.needsApproval && (shapeChange || body.assignments)) {
        const [proposal, current] = await Promise.all([
          loadProposal(existing.id),
          queryOne<{ assignments: Record<string, Record<string, string>> }>('SELECT assignments FROM game WHERE id = $1', [existing.id]),
        ]);
        const formations = { ...(proposal?.formations ?? {}) };
        if (shapeChange) {
          for (let i = 0; i < periodCount(existing.periods as Periods); i++) formations[String(i)] = body.formation!;
        }
        await saveProposal(
          existing.id,
          user.id,
          body.assignments ?? proposal?.assignments ?? current?.assignments ?? {},
          formations,
        );
        delete body.formation;
        delete body.assignments;
        proposed = true;
      }
    }

    // Only a brand new game consumes quota, and it is counted per team.
    if (!existing) {
      const denied = await enforceTeamScopedLimit(user.id, guard.team.teamId, 'gamesPerTeam');
      if (denied) {
        return { status: denied.status, jsonBody: denied.body };
      }
    }

    // A new game inherits its match setup from the team's division rather
    // than guessing, so a U14 side does not get a 7v7 pitch.
    const team = await queryOne<{
      format: string | null;
      periods: string | null;
      period_length_sec: number | null;
      default_formation: string | null;
    }>(
      `SELECT format, periods, period_length_sec, default_formation
         FROM team WHERE id = $1`,
      [guard.team.teamId],
    );

    const defaults = {
      format: team?.format ?? '7v7',
      periods: team?.periods ?? 'quarters',
      periodLengthSec: team?.period_length_sec ?? 720,
      formation: team?.default_formation ?? null,
    };

    // Switching format invalidates the old shape (a 7v7 2-3-1 cannot be played
    // 11v11), so fall back to that format's default unless one was supplied.
    const effectiveFormat = body.format ?? existing?.format ?? defaults.format;
    let formation = body.formation ?? null;
    if (!formation && existing && body.format && body.format !== existing.format) {
      formation = defaultFormation(body.format);
    }
    if (!formation && !existing) {
      // A new game starts in the team's usual shape, not the format's generic
      // default, so a coach who always plays 3-2-1 does not reset it each week.
      formation =
        defaults.formation && isValidFormation(effectiveFormat as Format, defaults.formation)
          ? defaults.formation
          : defaultFormation(effectiveFormat);
    }

    // Changing format also changes how long a period runs, so recompute the
    // length from the team's division whenever the caller changes the shape.
    const periodLengthSec = !existing
      ? defaults.periodLengthSec
      : body.periodLengthSec ?? null;

    // Every column is a partial update: a NULL parameter means "not supplied".
    // On INSERT it falls back to the column's real default, and on UPDATE it
    // keeps the stored value — so editing the opponent can never blank the
    // lineup, the score or the formation, which is what EXCLUDED used to do.
    const row = await queryOne<GameRow>(
      `INSERT INTO game (team_id, game_no, date, opponent, us, them, is_home,
                         format, periods, period_length_sec, formation, tactic,
                         assignments, notes, updated_at)
       VALUES ($1, $2, $3::date,
               COALESCE($4, ''), COALESCE($5, 0), COALESCE($6, 0),
               COALESCE($7, true), COALESCE($8, '7v7'), COALESCE($9, 'quarters'),
               COALESCE($10, 720), COALESCE($11, '2-3-1'), COALESCE($12, 'balanced'),
               COALESCE($13::jsonb, '{}'::jsonb), $14, now())
       ON CONFLICT (team_id, game_no) DO UPDATE SET
         date = COALESCE($3::date, game.date),
         opponent = COALESCE($4, game.opponent),
         us = COALESCE($5, game.us),
         them = COALESCE($6, game.them),
         is_home = COALESCE($7, game.is_home),
         format = COALESCE($8, game.format),
         periods = COALESCE($9, game.periods),
         period_length_sec = COALESCE($10, game.period_length_sec),
         formation = COALESCE($11, game.formation),
         tactic = COALESCE($12, game.tactic),
         assignments = COALESCE($13::jsonb, game.assignments),
         notes = COALESCE($14, game.notes),
         updated_at = now()
       RETURNING *`,
      [
        guard.team.teamId,
        body.gameNo ?? 0,
        // '' clears the date; undefined leaves it alone.
        body.date === undefined ? null : body.date || null,
        body.opponent ?? null,
        body.us ?? null,
        body.them ?? null,
        body.isHome ?? null,
        body.format ?? (existing ? null : defaults.format),
        body.periods ?? (existing ? null : defaults.periods),
        periodLengthSec,
        formation,
        body.tactic ?? null,
        body.assignments ? JSON.stringify(body.assignments) : null,
        body.notes ?? null,
      ],
    );

    // Kick-off and venue details belong to the fixture for a league game, so
    // only a team's own games (friendlies) take them from here. undefined
    // leaves a field alone; '' clears it.
    let saved = row;
    if (row && !row.fixture_id && (body.kickoff !== undefined || body.location !== undefined || body.field !== undefined)) {
      const kickoff = body.kickoff === undefined ? undefined : String(body.kickoff ?? '').trim().slice(0, 5) || null;
      if (kickoff && !/^([01]\d|2[0-3]):[0-5]\d$/.test(kickoff)) {
        return { status: 400, jsonBody: { error: 'Kick-off must be a time like 09:30.' } };
      }
      const location = body.location === undefined ? undefined : String(body.location ?? '').trim().slice(0, 160) || null;
      const field = body.field === undefined ? undefined : String(body.field ?? '').trim().slice(0, 40) || null;
      saved =
        (await queryOne<GameRow>(
          `UPDATE game SET
             kickoff = CASE WHEN $2 THEN $3 ELSE kickoff END,
             location = CASE WHEN $4 THEN $5 ELSE location END,
             field = CASE WHEN $6 THEN $7 ELSE field END,
             updated_at = now()
           WHERE id = $1 RETURNING *`,
          [
            row.id,
            kickoff !== undefined, kickoff ?? null,
            location !== undefined, location ?? null,
            field !== undefined, field ?? null,
          ],
        )) ?? row;
    }

    // A friendly between two Lineup teams: the other team's copy follows the
    // date, time, place and score (seen from their side) (Fady, 10/19).
    const shared =
      body.date !== undefined || body.us !== undefined || body.them !== undefined || body.isHome !== undefined ||
      body.kickoff !== undefined || body.location !== undefined || body.field !== undefined;
    if (saved?.pair_id && shared) {
      await query(
        `UPDATE game SET date = $3, kickoff = $4, location = $5, field = $6, us = $7, them = $8, is_home = NOT $9, updated_at = now()
          WHERE pair_id = $1 AND id <> $2 AND deleted_at IS NULL`,
        [saved.pair_id, saved.id, saved.date, saved.kickoff, saved.location, saved.field, saved.them, saved.us, saved.is_home],
      ).catch((e) => ctx.warn('paired friendly sync failed', e));
    }

    return {
      status: existing ? 200 : 201,
      jsonBody: saved ? { ...toGame(saved), ...(proposed ? { proposalPending: true } : {}) } : null,
    };
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

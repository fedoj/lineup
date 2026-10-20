import type { HttpResponseInit } from '@azure/functions';
import { gameLockDay, isGameLocked } from '@lineup/shared';
import { queryOne } from './db.js';
import { appToday } from './today.js';

/**
 * Games lock GAME_LOCK_DAYS (3) after their league or tournament ends (Fady,
 * 10/16): no more score, lineup, period, event or sub changes. Viewing,
 * roster changes and deleting data still work. Endpoints that change a game
 * ask here first.
 */
function locked(name: string, endsOn: string): HttpResponseInit {
  return {
    status: 409,
    jsonBody: {
      error: `${name} ended on ${endsOn}, so its games locked on ${gameLockDay(endsOn)}: scores and lineups can no longer change.`,
      code: 'GAME_LOCKED',
    },
  };
}

/** A 409 when this game belongs to a league or tournament whose games have locked; otherwise null. */
export async function gameLocked(gameId: string | null | undefined): Promise<HttpResponseInit | null> {
  if (!gameId) return null;
  const row = await queryOne<{ name: string; ends_on: string }>(
    `SELECT c.name, to_char(c.ends_on, 'YYYY-MM-DD') AS ends_on
       FROM game g JOIN competition c ON c.id = g.competition_id
      WHERE g.id = $1`,
    [gameId],
  );
  return row && isGameLocked(row.ends_on, appToday()) ? locked(row.name, row.ends_on) : null;
}

/** The same for a league fixture (both teams' games). */
export async function fixtureLocked(fixtureId: string | null | undefined): Promise<HttpResponseInit | null> {
  if (!fixtureId) return null;
  const row = await queryOne<{ name: string; ends_on: string }>(
    `SELECT c.name, to_char(c.ends_on, 'YYYY-MM-DD') AS ends_on
       FROM fixture f JOIN competition c ON c.id = f.competition_id
      WHERE f.id = $1`,
    [fixtureId],
  );
  return row && isGameLocked(row.ends_on, appToday()) ? locked(row.name, row.ends_on) : null;
}

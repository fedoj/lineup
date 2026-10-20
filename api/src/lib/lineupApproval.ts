import { canOnTeam, isGameLive, lineupNeedsApproval, type Assignments } from '@lineup/shared';
import type { TeamGuard } from './authz.js';
import { query, queryOne } from './db.js';
import { calendarLink } from './links.js';
import { appMinutesNow, appToday } from './today.js';

/**
 * Assistant coach lineup proposals (rules in packages/shared/src/lineupApproval.ts).
 * Before a game, an assistant's formation and lineup changes go into one
 * pending proposal per game instead of the game itself; a coach approves it
 * (copied onto the game) or rejects it (deleted).
 */

export interface Proposal {
  assignments: Assignments;
  formations: Record<string, string>;
  proposedBy: string | null;
  proposedByName: string | null;
  updatedAt: string;
}

export interface LineupGate {
  /** The caller's changes wait for the coach. */
  needsApproval: boolean;
  /** The caller may approve or reject proposals and set assistantFree. */
  canApprove: boolean;
  live: boolean;
  assistantFree: boolean;
}

/** Who may do what with this game's lineup right now. */
export async function lineupGate(guard: TeamGuard, gameId: string): Promise<LineupGate> {
  const g = await queryOne<{ date: string | null; kickoff: string | null; assistant_free: boolean; clock_running: boolean }>(
    `SELECT to_char(g.date, 'YYYY-MM-DD') AS date, g.kickoff, g.assistant_free,
            COALESCE((SELECT bool_or(p.started_at IS NOT NULL OR p.elapsed_sec > 0)
                             AND NOT bool_and(p.ended_at IS NOT NULL)
                        FROM game_period p WHERE p.game_id = g.id), false) AS clock_running
       FROM game g WHERE g.id = $1`,
    [gameId],
  );
  const live = g
    ? isGameLive({ date: g.date, kickoff: g.kickoff, clockRunning: g.clock_running }, { today: appToday(), minutes: appMinutesNow() })
    : false;
  const assistantFree = Boolean(g?.assistant_free);
  return {
    needsApproval: lineupNeedsApproval(guard.role, assistantFree, live),
    canApprove: canOnTeam(guard.ctx, guard.team, 'team.edit').allowed,
    live,
    assistantFree,
  };
}

export async function loadProposal(gameId: string): Promise<Proposal | null> {
  const r = await queryOne<{
    assignments: Assignments;
    formations: Record<string, string>;
    proposed_by: string | null;
    name: string | null;
    updated_at: Date;
  }>(
    `SELECT p.assignments, p.formations, p.proposed_by, COALESCE(u.display_name, u.email) AS name, p.updated_at
       FROM lineup_proposal p LEFT JOIN app_user u ON u.id = p.proposed_by
      WHERE p.game_id = $1`,
    [gameId],
  );
  return r
    ? {
        assignments: r.assignments ?? {},
        formations: r.formations ?? {},
        proposedBy: r.proposed_by,
        proposedByName: r.name,
        updatedAt: r.updated_at.toISOString(),
      }
    : null;
}

/**
 * Save the assistant's proposal for a game. The coaches on the team get one
 * notification per game while it is unread ("… proposed lineup changes").
 */
export async function saveProposal(
  gameId: string,
  userId: string,
  assignments: Assignments,
  formations: Record<string, string>,
): Promise<void> {
  const row = await queryOne<{ inserted: boolean }>(
    `INSERT INTO lineup_proposal (game_id, assignments, formations, proposed_by)
     VALUES ($1, $2::jsonb, $3::jsonb, $4)
     ON CONFLICT (game_id) DO UPDATE SET assignments = EXCLUDED.assignments, formations = EXCLUDED.formations,
                                         proposed_by = EXCLUDED.proposed_by, updated_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [gameId, JSON.stringify(assignments), JSON.stringify(formations), userId],
  );
  if (!row?.inserted) return;
  const info = await queryOne<{ team_id: string; opponent: string; who: string | null }>(
    `SELECT g.team_id, g.opponent, (SELECT COALESCE(display_name, email) FROM app_user WHERE id = $2) AS who
       FROM game g WHERE g.id = $1`,
    [gameId, userId],
  );
  if (!info) return;
  await query(
    `INSERT INTO notification (user_id, kind, title, body, link, group_key)
     SELECT m.user_id, 'message', $2, $3, $4, $5 FROM membership m
      WHERE m.team_id = $1 AND m.role = 'coach' AND m.user_id <> $6
     ON CONFLICT (user_id, group_key) WHERE read_at IS NULL AND group_key IS NOT NULL
     DO UPDATE SET batch = notification.batch + 1, created_at = now(), pushed_at = NULL`,
    [
      info.team_id,
      'Lineup changes to approve',
      `${info.who ?? 'Your assistant coach'} proposed lineup changes for the game${info.opponent ? ` vs ${info.opponent}` : ''}. Open match day to approve or reject them.`,
      calendarLink(info.team_id, `game:${gameId}`),
      `lineup:${gameId}`,
      userId,
    ],
  ).catch(() => undefined);
}

/** Tell the assistant what the coach decided. */
export async function notifyDecision(gameId: string, assistantId: string | null, approved: boolean): Promise<void> {
  if (!assistantId) return;
  const g = await queryOne<{ team_id: string; opponent: string }>('SELECT team_id, opponent FROM game WHERE id = $1', [gameId]);
  if (!g) return;
  await query(
    `INSERT INTO notification (user_id, kind, title, body, link) VALUES ($1, 'message', $2, $3, $4)`,
    [
      assistantId,
      approved ? 'Lineup changes approved' : 'Lineup changes not approved',
      approved
        ? `The coach approved your lineup changes for the game${g.opponent ? ` vs ${g.opponent}` : ''}.`
        : `The coach kept the current lineup for the game${g.opponent ? ` vs ${g.opponent}` : ''}.`,
      calendarLink(g.team_id, `game:${gameId}`),
    ],
  ).catch(() => undefined);
}

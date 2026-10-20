/**
 * Assistant coaches and the lineup (Fady, 10/16).
 *
 * An assistant coach marks players absent, late or injured at any time. Their
 * formation and lineup changes before a game are a proposal the coach
 * approves or rejects, unless the coach ticked "Assistant coach can change
 * the lineup without approval" on that game (only a coach can tick it, and
 * it starts unticked). During the game the assistant changes the lineup
 * straight away: from LIVE_BEFORE_KICKOFF_MIN minutes before kick-off on game
 * day (all of game day when no kick-off time is set), or while the match
 * clock is running.
 */

export const LIVE_BEFORE_KICKOFF_MIN = 30;

export interface LiveInput {
  /** Game date, YYYY-MM-DD. */
  date: string | null;
  /** Kick-off, HH:MM, in the app's time zone. */
  kickoff: string | null;
  /** The match clock has started and not every period has ended. */
  clockRunning: boolean;
}

export interface AppNow {
  /** Today in the app's time zone, YYYY-MM-DD. */
  today: string;
  /** Minutes since midnight in the app's time zone. */
  minutes: number;
}

/** Whether the game is being played now, for the assistant's lineup changes. */
export function isGameLive(g: LiveInput, now: AppNow): boolean {
  if (g.clockRunning) return true;
  if (!g.date || g.date !== now.today) return false;
  if (!g.kickoff) return true;
  const [h, m] = g.kickoff.split(':').map(Number);
  if (!Number.isFinite(h)) return true;
  return now.minutes >= h * 60 + (Number.isFinite(m) ? m : 0) - LIVE_BEFORE_KICKOFF_MIN;
}

/** Whether a lineup change by someone with this role on the team waits for the coach. */
export function lineupNeedsApproval(role: string | null | undefined, assistantFree: boolean, live: boolean): boolean {
  return role === 'assistant' && !assistantFree && !live;
}

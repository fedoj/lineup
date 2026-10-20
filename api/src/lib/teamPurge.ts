import { TEAM_RESTORE_DAYS } from '@lineup/shared';
import { query } from './db.js';

/** At most one sweep every 15 minutes per instance; each request may start one. */
const EVERY_MS = 15 * 60_000;
let last = 0;

/**
 * Archived teams past their month (TEAM_RESTORE_DAYS) are deleted with
 * everything in them: roster, games, practices, events, chat, stats and
 * memberships, by the database's cascades (Fady, 10/16). People's accounts,
 * parents and players included, stay: they may hold their own subscriptions.
 * A league game against another team stays on that team's calendar.
 * Returns how many teams were deleted.
 */
export async function purgeArchivedTeams(force = false): Promise<number> {
  if (!force && Date.now() - last < EVERY_MS) return 0;
  last = Date.now();
  const gone = await query<{ id: string }>(
    `DELETE FROM team WHERE id IN (
       SELECT id FROM team
        WHERE archived_at IS NOT NULL AND archived_at < now() - make_interval(days => $1)
        ORDER BY archived_at LIMIT 20)
     RETURNING id`,
    [TEAM_RESTORE_DAYS],
  );
  if (gone.length) {
    await query(`DELETE FROM logo WHERE kind = 'team' AND ref_id = ANY($1::uuid[])`, [gone.map((t) => t.id)]);
  }
  return gone.length;
}

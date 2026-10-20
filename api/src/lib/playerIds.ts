/**
 * Give every player on a team in an organization or region its ID, the first
 * time the roster is read: "AvaG001" (first name, the parent's last initial, a
 * number counting up from 001 for that name), or "Ava001" without a parent's
 * last name. Unique within the organization; players keep their ID when they
 * change team or season.
 */

import { formatPlayerId, nextPlayerNumber, playerIdBase } from '@lineup/shared';
import { query, queryOne } from './db.js';

/** The organization a team's IDs are unique in, or null for a team on its own. */
async function leagueOrgOf(teamId: string): Promise<string | null> {
  const t = await queryOne<{ org_id: string; org_personal: boolean; region_personal: boolean | null }>(
    `SELECT t.org_id, o.is_personal AS org_personal, r.is_personal AS region_personal
       FROM team t JOIN organization o ON o.id = t.org_id
       LEFT JOIN region r ON r.id = t.region_id
      WHERE t.id = $1 AND t.deleted_at IS NULL`,
    [teamId],
  );
  if (!t) return null;
  // A real organization, or a standalone region (inside a hidden personal one).
  return !t.org_personal || t.region_personal === false ? t.org_id : null;
}

export async function ensurePlayerIds(teamId: string): Promise<number> {
  const orgId = await leagueOrgOf(teamId);
  if (!orgId) return 0;
  const missing = await query<{ id: string; name: string; parent: string | null }>(
    `SELECT p.id, p.name,
            (SELECT u.display_name FROM player_guardian g JOIN app_user u ON u.id = g.user_id
              WHERE g.player_id = p.id ORDER BY g.consented_at NULLS LAST LIMIT 1) AS parent
       FROM player p
      WHERE p.team_id = $1 AND p.public_id IS NULL
      ORDER BY p.name, p.id`,
    [teamId],
  );
  let assigned = 0;
  for (const p of missing) {
    const base = playerIdBase(p.name, p.parent);
    // Two rosters read at once can race for the same number: try the next one.
    for (let attempt = 0; attempt < 5; attempt++) {
      const used = await query<{ public_id: string }>(
        `SELECT public_id FROM player WHERE public_org_id = $1 AND lower(public_id) LIKE lower($2) || '%'`,
        [orgId, base],
      );
      const id = formatPlayerId(base, nextPlayerNumber(base, used.map((u) => u.public_id)) + attempt);
      const ok = await queryOne(
        `UPDATE player SET public_id = $2, public_org_id = $3
          WHERE id = $1 AND public_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM player x WHERE x.public_org_id = $3 AND lower(x.public_id) = lower($2))
          RETURNING id`,
        [p.id, id, orgId],
      ).catch(() => null);
      if (ok) {
        assigned++;
        break;
      }
    }
  }
  return assigned;
}
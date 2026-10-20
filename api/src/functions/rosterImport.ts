import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { canOnTeam, type AccessContext } from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { guardTeam, reachableTeamIds, type TeamGuard } from '../lib/authz.js';
import { query, transaction } from '../lib/db.js';
import { enforceTeamScopedLimit } from '../lib/entitlements.js';

/**
 * Bring players into a team from an older roster (Fady, 10/16): a coach picks
 * from their other standalone teams; on a team in a region, its staff pick
 * from the region's teams. Archived teams count, since that is where last
 * season's rosters usually are. Each picked player is copied (name, number,
 * positions, picture); their parents can come along, linked to the child and
 * added to the team. A league Player ID moves with the child when the old
 * team is archived.
 */

const FORBIDDEN: HttpResponseInit = { status: 403, jsonBody: { error: 'You do not have access to this.', code: 'FORBIDDEN' } };

interface SourceTeam {
  id: string;
  name: string;
  archived: boolean;
  region_name: string | null;
}

async function sourceTeams(access: AccessContext, userId: string, target: TeamGuard['team']): Promise<SourceTeam[]> {
  if (target.inLeague) {
    // The same region's teams (or, with no region, the organization's teams outside any region).
    return query<SourceTeam>(
      `SELECT t.id, t.name, (t.archived_at IS NOT NULL) AS archived, r.name AS region_name
         FROM team t LEFT JOIN region r ON r.id = t.region_id
        WHERE t.org_id = $1 AND t.region_id IS NOT DISTINCT FROM $2::uuid
          AND t.id <> $3 AND t.deleted_at IS NULL
        ORDER BY (t.archived_at IS NULL) DESC, t.name`,
      [target.orgId, target.regionId ?? null, target.teamId],
    );
  }
  // The coach's other standalone teams they run.
  const reachable = await reachableTeamIds(userId);
  const rows = await query<
    SourceTeam & { org_id: string; region_id: string | null; org_personal: boolean; region_personal: boolean | null }
  >(
    `SELECT t.id, t.name, (t.archived_at IS NOT NULL) AS archived, NULL::text AS region_name,
            t.org_id, t.region_id, o.is_personal AS org_personal, r.is_personal AS region_personal
       FROM team t JOIN organization o ON o.id = t.org_id LEFT JOIN region r ON r.id = t.region_id
      WHERE t.id = ANY($1::uuid[]) AND t.id <> $2 AND t.deleted_at IS NULL
      ORDER BY t.name`,
    [reachable, target.teamId],
  );
  return rows.filter(
    (t) =>
      t.org_personal &&
      !(t.region_id && t.region_personal === false) &&
      canOnTeam(access, { teamId: t.id, orgId: t.org_id, regionId: t.region_id, divisionId: null }, 'team.edit').allowed,
  );
}

export async function rosterImportHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    if (req.method === 'GET') {
      const guard = await guardTeam(user, (req.query.get('teamId') ?? '').slice(0, 36) || undefined, 'roster.add');
      if (!guard.ok) return guard.response;
      const sources = await sourceTeams(guard.ctx, user.id, guard.team);
      const players = sources.length
        ? await query<{ id: string; team_id: string; name: string; number: string | null; active: boolean; guardians: number }>(
            `SELECT p.id, p.team_id, p.name, p.number, p.active,
                    (SELECT COUNT(*) FROM player_guardian g WHERE g.player_id = p.id)::int AS guardians
               FROM player p WHERE p.team_id = ANY($1::uuid[])
              ORDER BY p.name`,
            [sources.map((s) => s.id)],
          )
        : [];
      return {
        status: 200,
        jsonBody: {
          sources: sources.map((s) => ({
            teamId: s.id,
            name: s.name,
            archived: s.archived,
            regionName: s.region_name,
            players: players
              .filter((p) => p.team_id === s.id)
              .map((p) => ({ id: p.id, name: p.name, number: p.number ?? '', active: p.active, hasParents: p.guardians > 0 })),
          })),
        },
      };
    }

    const b = (await req.json()) as { teamId?: string; sourceTeamId?: string; playerIds?: unknown; withParents?: boolean };
    const guard = await guardTeam(user, String(b.teamId ?? '').slice(0, 36) || undefined, 'roster.add');
    if (!guard.ok) return guard.response;
    const sourceId = String(b.sourceTeamId ?? '').slice(0, 36);
    const source = (await sourceTeams(guard.ctx, user.id, guard.team)).find((s) => s.id === sourceId);
    if (!source) return FORBIDDEN;
    const wanted = [...new Set((Array.isArray(b.playerIds) ? b.playerIds : []).map((x) => String(x).slice(0, 36)))];
    if (!wanted.length) return { status: 400, jsonBody: { error: 'Pick at least one player.' } };

    const picked = await query<{
      id: string;
      name: string;
      number: string | null;
      primary_pos: string | null;
      secondary_pos: string | null;
      never_keeper: boolean | null;
      gender: string | null;
      avatar: unknown;
      public_id: string | null;
      public_org_id: string | null;
    }>(
      `SELECT id, name, number, primary_pos, secondary_pos, never_keeper, gender, avatar, public_id, public_org_id
         FROM player WHERE team_id = $1 AND id = ANY($2::uuid[])`,
      [source.id, wanted],
    );
    if (picked.length !== wanted.length) return { status: 400, jsonBody: { error: 'Some of those players are not on that team.' } };

    // Someone already on the roster (same name) is not added twice.
    const existing = await query<{ name: string }>('SELECT name FROM player WHERE team_id = $1', [guard.team.teamId]);
    const have = new Set(existing.map((p) => p.name.trim().toLowerCase()));
    const toAdd = picked.filter((p) => !have.has(p.name.trim().toLowerCase()));
    if (toAdd.length) {
      const denied = await enforceTeamScopedLimit(user.id, guard.team.teamId, 'playersPerTeam', toAdd.length);
      if (denied) return { status: denied.status, jsonBody: denied.body };
    }

    const result = await transaction(async (c) => {
      let parents = 0;
      const newTeam = (await c.query<{ name: string }>('SELECT name FROM team WHERE id = $1', [guard.team.teamId])).rows[0]?.name ?? 'a new team';
      for (const p of toAdd) {
        // The league Player ID follows the child off an archived team.
        const moveId = source.archived && p.public_id ? p.public_id : null;
        if (moveId) await c.query('UPDATE player SET public_id = NULL WHERE id = $1', [p.id]);
        const row = await c.query<{ id: string }>(
          `INSERT INTO player (team_id, number, name, active, primary_pos, secondary_pos, never_keeper, gender, avatar,
                               public_id, public_org_id)
           VALUES ($1, $2, $3, true, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [
            guard.team.teamId, p.number ?? '', p.name, p.primary_pos, p.secondary_pos, p.never_keeper ?? false, p.gender,
            p.avatar === null || p.avatar === undefined ? null : JSON.stringify(p.avatar),
            moveId, moveId ? p.public_org_id : null,
          ],
        );
        if (!b.withParents) continue;
        const newId = row.rows[0].id;
        const linked = await c.query<{ user_id: string }>(
          `INSERT INTO player_guardian (player_id, user_id, relation, consented_at, consented_by)
           SELECT $1, g.user_id, g.relation, g.consented_at, g.consented_by FROM player_guardian g WHERE g.player_id = $2
           ON CONFLICT (player_id, user_id) DO NOTHING
           RETURNING user_id`,
          [newId, p.id],
        );
        for (const g of linked.rows) {
          // The parent keeps the family role they had on the old team.
          const added = await c.query(
            `INSERT INTO membership (user_id, role, team_id)
             SELECT $1, COALESCE((SELECT m.role FROM membership m
                                   WHERE m.user_id = $1 AND m.team_id = $3 AND m.role IN ('parent', 'team_parent')
                                   LIMIT 1), 'parent'), $2
             ON CONFLICT (user_id, team_id) WHERE team_id IS NOT NULL DO NOTHING
             RETURNING user_id`,
            [g.user_id, guard.team.teamId, source.id],
          );
          if (added.rowCount) {
            parents++;
            await c.query(
              `INSERT INTO notification (user_id, kind, title, body, link)
               SELECT $1, 'system', $2, $3, $4`,
              [
                g.user_id,
                `${p.name} joined a new team`,
                `${p.name} was added to ${newTeam}. You can follow the team in Lineup.`,
                `/?team=${guard.team.teamId}`,
              ],
            );
          }
        }
      }
      return { parents };
    });

    return {
      status: 200,
      jsonBody: { added: toAdd.length, skipped: picked.length - toAdd.length, parentsAdded: result.parents },
    };
  } catch (err) {
    ctx.error('roster import failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('rosterImport', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'roster-import',
  handler: rosterImportHandler,
});

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { canOnScope, canOnTeam } from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import {
  buildAccessContext,
  denyResponse,
  loadTeamContext,
  reachableTeamIds,
} from '../lib/authz.js';
import { query, queryOne } from '../lib/db.js';
import { appToday } from '../lib/today.js';
import { enforceFeature } from '../lib/entitlements.js';

/**
 * Standings for a team, a region or a whole organization.
 *
 * A region or org table is readable by anyone with a role there, and by
 * anyone with a team inside it, so a coach can see where their team sits in
 * the region. Player names are always shortened to a first name and last
 * initial, because these tables cross team boundaries.
 */

const FORBIDDEN: HttpResponseInit = {
  status: 403,
  jsonBody: { error: 'You do not have access to this.', code: 'FORBIDDEN' },
};

function shortName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Player';
  const [first, ...rest] = parts;
  return rest.length ? `${first} ${rest[rest.length - 1][0].toUpperCase()}.` : first;
}

interface Crumb {
  kind: 'org' | 'region' | 'team';
  id: string;
  name: string;
}

export async function standingsHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    const scope = req.query.get('scope') ?? '';
    const id = req.query.get('id') ?? '';
    if (!id || !['team', 'region', 'org'].includes(scope)) {
      return { status: 400, jsonBody: { error: 'scope (team, region or org) and id are required' } };
    }

    const [access, reachableIds, teamCtx, teamRow] = await Promise.all([
      buildAccessContext(user),
      reachableTeamIds(user.id),
      scope === 'team' ? loadTeamContext(id) : Promise.resolve(null),
      scope === 'team'
        ? queryOne<{
            name: string;
            org_id: string;
            org_name: string;
            org_personal: boolean;
            region_id: string | null;
            region_name: string | null;
            region_personal: boolean | null;
          }>(
            `SELECT t.name, o.id AS org_id, o.name AS org_name, o.is_personal AS org_personal,
                    r.id AS region_id, r.name AS region_name, r.is_personal AS region_personal
               FROM team t
               JOIN organization o ON o.id = t.org_id
               LEFT JOIN region r ON r.id = t.region_id
              WHERE t.id = $1`,
            [id],
          )
        : Promise.resolve(undefined),
    ]);
    const reachable = new Set(reachableIds);
    let teamIds: string[] = [];
    let title = '';
    const crumbs: Crumb[] = [];

    if (scope === 'team') {
      const team = teamCtx;
      if (!team) return FORBIDDEN;
      const d = canOnTeam(access, team, 'stats.view');
      if (!d.allowed) return denyResponse(d);
      const row = teamRow;
      if (!row) return FORBIDDEN;
      if (!row.org_personal) crumbs.push({ kind: 'org', id: row.org_id, name: row.org_name });
      if (row.region_id && !row.region_personal && row.region_name) {
        crumbs.push({ kind: 'region', id: row.region_id, name: row.region_name });
      }
      teamIds = [id];
      title = row.name;
    } else if (scope === 'region') {
      const r = await queryOne<{
        id: string;
        name: string;
        org_id: string;
        org_name: string;
        org_personal: boolean;
        is_personal: boolean;
      }>(
        `SELECT r.id, r.name, r.org_id, o.name AS org_name, o.is_personal AS org_personal, r.is_personal
           FROM region r JOIN organization o ON o.id = r.org_id
          WHERE r.id = $1 AND r.deleted_at IS NULL`,
        [id],
      );
      if (!r || r.is_personal) return FORBIDDEN;
      const teams = await query<{ id: string }>(
        'SELECT id FROM team WHERE region_id = $1 AND deleted_at IS NULL',
        [r.id],
      );
      const viaScopeRole = canOnScope(access, { orgId: r.org_id, regionId: r.id }, 'team.view').allowed;
      if (!viaScopeRole && !teams.some((t) => reachable.has(t.id))) return FORBIDDEN;
      // Staff see their own region's table; everyone below needs their own plan.
      if (!viaScopeRole) {
        const denial = await enforceFeature(user.id, 'scopeStandings');
        if (denial) return { status: denial.status, jsonBody: denial.body };
      }
      // A standalone region has no organization above it to link back to.
      if (!r.org_personal) crumbs.push({ kind: 'org', id: r.org_id, name: r.org_name });
      teamIds = teams.map((t) => t.id);
      title = r.name;
    } else {
      const o = await queryOne<{ id: string; name: string; is_personal: boolean }>(
        'SELECT id, name, is_personal FROM organization WHERE id = $1 AND deleted_at IS NULL',
        [id],
      );
      if (!o || o.is_personal) return FORBIDDEN;
      const teams = await query<{ id: string }>(
        'SELECT id FROM team WHERE org_id = $1 AND deleted_at IS NULL',
        [o.id],
      );
      const viaScopeRole = canOnScope(access, { orgId: o.id }, 'team.view').allowed;
      if (!viaScopeRole && !teams.some((t) => reachable.has(t.id))) return FORBIDDEN;
      if (!viaScopeRole) {
        const denial = await enforceFeature(user.id, 'scopeStandings');
        if (denial) return { status: denial.status, jsonBody: denial.body };
      }
      teamIds = teams.map((t) => t.id);
      title = o.name;
    }

    // A game counts once it has a score or its date has passed, so fixtures
    // scheduled for next month do not show up as 0-0 draws. Region and
    // organization tables count league games only; a coach's own friendlies
    // stay on that team's stats and never move the league table.
    const leagueOnly = scope !== 'team';
    const [rows, goals, assists] = teamIds.length
      ? await Promise.all([
          query<{
            id: string;
            name: string;
            region_id: string | null;
            region_name: string | null;
            region_personal: boolean | null;
            played: number;
            won: number;
            drawn: number;
            lost: number;
            gf: number;
            ga: number;
          }>(
            `WITH played AS (
               SELECT g.team_id, g.us, g.them FROM game g
                WHERE g.team_id = ANY($1::uuid[]) AND g.deleted_at IS NULL AND g.canceled_at IS NULL
                  AND (NOT $2::boolean OR g.fixture_id IS NOT NULL)
                  AND (g.us + g.them > 0 OR (g.date IS NOT NULL AND g.date <= $3::date))
             )
             SELECT t.id, t.name, t.region_id, r.name AS region_name, r.is_personal AS region_personal,
                    COUNT(p.team_id)::int AS played,
                    COUNT(p.team_id) FILTER (WHERE p.us > p.them)::int AS won,
                    COUNT(p.team_id) FILTER (WHERE p.us = p.them)::int AS drawn,
                    COUNT(p.team_id) FILTER (WHERE p.us < p.them)::int AS lost,
                    COALESCE(SUM(p.us), 0)::int AS gf,
                    COALESCE(SUM(p.them), 0)::int AS ga
               FROM team t
               LEFT JOIN region r ON r.id = t.region_id
               LEFT JOIN played p ON p.team_id = t.id
              WHERE t.id = ANY($1::uuid[]) AND t.deleted_at IS NULL
              GROUP BY t.id, t.name, t.region_id, r.name, r.is_personal`,
            [teamIds, leagueOnly, appToday()],
          ),
          query<{ id: string; name: string; team_name: string; n: number }>(
            `SELECT p.id, p.name, t.name AS team_name, COUNT(*)::int AS n
               FROM game_event e
               JOIN game g ON g.id = e.game_id AND g.deleted_at IS NULL
                          AND (NOT $2::boolean OR g.fixture_id IS NOT NULL)
               JOIN player p ON p.id = e.player_id AND p.active
               JOIN team t ON t.id = g.team_id
              WHERE g.team_id = ANY($1::uuid[]) AND e.kind = 'goal' AND NOT e.against
              GROUP BY p.id, p.name, t.name`,
            [teamIds, leagueOnly],
          ),
          query<{ id: string; name: string; team_name: string; n: number }>(
            `SELECT p.id, p.name, t.name AS team_name, COUNT(*)::int AS n
               FROM game_event e
               JOIN game g ON g.id = e.game_id AND g.deleted_at IS NULL
                          AND (NOT $2::boolean OR g.fixture_id IS NOT NULL)
               JOIN player p ON p.id = e.assist_id AND p.active
               JOIN team t ON t.id = g.team_id
              WHERE g.team_id = ANY($1::uuid[]) AND NOT e.against
              GROUP BY p.id, p.name, t.name`,
            [teamIds, leagueOnly],
          ),
        ])
      : [[], [], []];

    const table = rows
      .map((t) => ({
        teamId: t.id,
        name: t.name,
        regionId: t.region_personal ? null : t.region_id,
        regionName: t.region_personal ? null : t.region_name,
        reachable: reachable.has(t.id),
        played: t.played,
        won: t.won,
        drawn: t.drawn,
        lost: t.lost,
        gf: t.gf,
        ga: t.ga,
        gd: t.gf - t.ga,
        pts: t.won * 3 + t.drawn,
      }))
      .sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.name.localeCompare(b.name));

    const players = new Map<string, { name: string; teamName: string; goals: number; assists: number }>();
    for (const g of goals) {
      players.set(g.id, { name: shortName(g.name), teamName: g.team_name, goals: g.n, assists: 0 });
    }
    for (const a of assists) {
      const row = players.get(a.id) ?? {
        name: shortName(a.name),
        teamName: a.team_name,
        goals: 0,
        assists: 0,
      };
      row.assists = a.n;
      players.set(a.id, row);
    }
    const scorers = [...players.values()]
      .sort((a, b) => b.goals - a.goals || b.assists - a.assists || a.name.localeCompare(b.name))
      .slice(0, 10);

    return {
      status: 200,
      jsonBody: { scope, id, title, crumbs, table, scorers, leagueOnly },
    };
  } catch (err) {
    ctx.error('standings failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('standings', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'standings',
  handler: standingsHandler,
});

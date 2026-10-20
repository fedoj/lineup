import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { positionLabel } from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { buildAccessContext } from '../lib/authz.js';
import { query } from '../lib/db.js';

/**
 * One search box across everything the caller can reach.
 *
 * Server-side rather than filtering in the browser, because the app only ever
 * holds the currently selected team's roster and fixtures — a client-side
 * search would silently miss the other three teams.
 *
 * Scoped by the same membership rules the rest of the API uses, so a search
 * can never surface a team the caller cannot already open.
 */

interface Hit {
  kind: 'team' | 'player' | 'game';
  id: string;
  teamId: string;
  title: string;
  subtitle: string;
  /** Lower sorts first. */
  rank: number;
}

export async function searchHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    const q = (req.query.get('q') ?? '').trim();
    if (q.length < 2) return { status: 200, jsonBody: { query: q, results: [] } };

    const access = await buildAccessContext(user);
    const like = `%${q.toLowerCase()}%`;

    // Every team the caller can reach, by any membership path.
    const teams = await query<{
      id: string; name: string; age_group: string; coach: string; season: string;
    }>(
      `SELECT DISTINCT t.id, t.name, t.age_group, t.coach, t.season
         FROM team t
         LEFT JOIN membership m ON m.user_id = $1
        WHERE t.deleted_at IS NULL
          AND (t.owner_id = $1 OR m.team_id = t.id
               OR m.division_id = t.division_id
               OR m.region_id = t.region_id
               OR m.org_id = t.org_id)`,
      [user.id],
    );

    const teamIds = teams.map((t) => t.id);
    if (teamIds.length === 0) return { status: 200, jsonBody: { query: q, results: [] } };

    const [players, games] = await Promise.all([
      query<{
        id: string; team_id: string; name: string; number: string;
        primary_pos: string | null; secondary_pos: string | null;
      }>(
        `SELECT id, team_id, name, number, primary_pos, secondary_pos
           FROM player
          WHERE team_id = ANY($1::uuid[]) AND active
            AND (lower(name) LIKE $2 OR number = $3
                 OR lower(coalesce(primary_pos,'')) = $4
                 OR lower(coalesce(secondary_pos,'')) = $4)
          LIMIT 40`,
        [teamIds, like, q, q.toLowerCase()],
      ),
      query<{
        id: string; team_id: string; game_no: number; opponent: string;
        date: Date | null; us: number; them: number;
      }>(
        `SELECT id, team_id, game_no, opponent, date, us, them
           FROM game
          WHERE team_id = ANY($1::uuid[]) AND deleted_at IS NULL
            AND (lower(opponent) LIKE $2
                 OR to_char(date, 'YYYY-MM-DD') LIKE $2
                 OR CAST(game_no AS TEXT) = $3)
          LIMIT 40`,
        [teamIds, like, q],
      ),
    ]);

    const needle = q.toLowerCase();
    // A name that starts with the query is almost always what was meant, so
    // it outranks a mid-string match.
    const rankFor = (text: string) => {
      const t = text.toLowerCase();
      if (t === needle) return 0;
      if (t.startsWith(needle)) return 1;
      return 2;
    };

    const teamById = new Map(teams.map((t) => [t.id, t]));
    const results: Hit[] = [];

    for (const t of teams) {
      const hay = `${t.name} ${t.age_group} ${t.coach} ${t.season}`.toLowerCase();
      if (!hay.includes(needle)) continue;
      results.push({
        kind: 'team',
        id: t.id,
        teamId: t.id,
        title: t.name,
        subtitle: [t.age_group, t.coach && `Coach ${t.coach}`].filter(Boolean).join(' · '),
        rank: rankFor(t.name),
      });
    }

    for (const p of players) {
      const pos = [p.primary_pos, p.secondary_pos].filter(Boolean).map((x) => positionLabel(x!));
      results.push({
        kind: 'player',
        id: p.id,
        teamId: p.team_id,
        title: `${p.number ? `#${p.number} ` : ''}${p.name}`,
        subtitle: [teamById.get(p.team_id)?.name, ...pos].filter(Boolean).join(' · '),
        rank: rankFor(p.name) + 0.1,
      });
    }

    for (const g of games) {
      const when = g.date ? g.date.toISOString().slice(0, 10) : 'no date';
      results.push({
        kind: 'game',
        id: g.id,
        teamId: g.team_id,
        title: `#${g.game_no} ${g.opponent || 'Opponent TBD'}`,
        subtitle: [teamById.get(g.team_id)?.name, when, `${g.us}–${g.them}`]
          .filter(Boolean)
          .join(' · '),
        rank: rankFor(g.opponent || '') + 0.2,
      });
    }

    results.sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title));

    return {
      status: 200,
      jsonBody: { query: q, results: results.slice(0, 25), isPlatformAdmin: access.isPlatformAdmin },
    };
  } catch (err) {
    ctx.error('search failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('search', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'search',
  handler: searchHandler,
});

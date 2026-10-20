import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { canOnTeam, isPositionId, removeUnavailable, type Player } from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { filterRoster, guardTeam } from '../lib/authz.js';
import { enforceTeamScopedLimit } from '../lib/entitlements.js';
import { query, queryOne, transaction } from '../lib/db.js';
import { calendarLink } from '../lib/links.js';
import { ensurePlayerIds } from '../lib/playerIds.js';

interface PlayerRow {
  id: string;
  team_id: string;
  number: string;
  name: string;
  active: boolean;
  primary_pos: string | null;
  secondary_pos: string | null;
  never_keeper: boolean;
  gender: string | null;
  public_id: string | null;
}

const toPlayer = (r: PlayerRow): Player => ({
  id: r.id,
  teamId: r.team_id,
  number: r.number,
  name: r.name,
  active: r.active,
  gender: r.gender === 'boy' || r.gender === 'girl' ? r.gender : null,
  primaryPos: r.primary_pos,
  secondaryPos: r.secondary_pos,
  neverKeeper: r.never_keeper,
  publicId: r.public_id ?? null,
});

/** Unknown position ids are dropped rather than rejected, so a stale client
 *  cannot block a roster save over a cosmetic field. */
const cleanPos = (v: unknown): string | null => (isPositionId(v) ? v : null);
const cleanGender = (v: unknown): 'boy' | 'girl' | null => (v === 'boy' || v === 'girl' ? v : null);

export async function playersHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) {
      return { status: 401, jsonBody: { error: 'Not authenticated' } };
    }

    if (req.method === 'GET') {
      const guard = await guardTeam(user, req.query.get('teamId') ?? undefined, 'roster.view');
      if (!guard.ok) return guard.response;

      let rows = await query<PlayerRow>(
        'SELECT * FROM player WHERE team_id = $1 ORDER BY number',
        [guard.team.teamId],
      );
      // Teams in an organization or region: every player gets its ID, the
      // first time the roster is read without one.
      if (guard.team.inLeague && rows.some((r) => !r.public_id)) {
        const assigned = await ensurePlayerIds(guard.team.teamId).catch((e) => {
          ctx.warn('player ids failed', e);
          return 0;
        });
        if (assigned > 0) {
          rows = await query<PlayerRow>('SELECT * FROM player WHERE team_id = $1 ORDER BY number', [guard.team.teamId]);
        }
      }
      // A parent sees only their own children.
      const visible = filterRoster(guard.ctx, guard.team, rows.map(toPlayer));
      return { status: 200, jsonBody: visible };
    }

    // PUT — replace the whole roster in one transaction.
    const body = (await req.json()) as { teamId?: string; players?: Partial<Player>[] };
    const guard = await guardTeam(user, body.teamId, 'roster.edit');
    if (!guard.ok) return guard.response;

    const players = (body.players ?? []).filter((p) => p.name?.trim());

    // On a team in an organization or region, its staff decide who is on the
    // roster. Coaches still edit numbers, names and positions, but cannot add
    // or remove players there.
    if (!canOnTeam(guard.ctx, guard.team, 'roster.add').allowed) {
      const existing = await query<{ id: string }>('SELECT id FROM player WHERE team_id = $1', [guard.team.teamId]);
      const known = new Set(existing.map((r) => r.id));
      const incomingIds = new Set(players.map((p) => p.id).filter((id): id is string => Boolean(id && id.trim())));
      const adding = players.some((p) => !p.id || !known.has(p.id));
      const removing = existing.some((r) => !incomingIds.has(r.id));
      if (adding || removing) {
        return {
          status: 403,
          jsonBody: {
            error: 'Players on this team are added and removed by its organization or region. You can still change numbers, names and positions.',
            code: 'LEAGUE_MANAGES_ROSTER',
          },
        };
      }
    }

    // Roster size is metered per team. This is a replace, not an append, so
    // only a roster that grows needs to pass the check.
    const current = await query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM player WHERE team_id = $1 AND active',
      [guard.team.teamId],
    );
    const incoming = players.filter((p) => p.active !== false).length;
    if (incoming > Number(current[0]?.n ?? 0)) {
      const denied = await enforceTeamScopedLimit(
        user.id,
        guard.team.teamId,
        'playersPerTeam',
        incoming - Number(current[0]?.n ?? 0),
      );
      if (denied) return { status: denied.status, jsonBody: denied.body };
    }

    const saved = await transaction(async (client) => {
      // A delete-and-reinsert would mint new player ids on every save, which
      // silently orphans everything keyed by player: saved lineups (stored as
      // JSON player ids), match events, availability and attendance. So this
      // is a genuine upsert — existing rows keep their identity.
      const keptIds = players
        .map((p) => p.id)
        .filter((id): id is string => Boolean(id && id.trim()));

      const removed = await client.query<{ id: string }>(
        `DELETE FROM player
          WHERE team_id = $1
            AND (cardinality($2::uuid[]) = 0 OR NOT (id = ANY($2::uuid[])))
        RETURNING id`,
        [guard.team.teamId, keptIds],
      );

      const out: PlayerRow[] = [];
      for (const p of players) {
        const name = p.name!.trim();
        const number = p.number ?? '';
        const active = p.active ?? true;
        const primary = cleanPos(p.primaryPos);
        const secondary = cleanPos(p.secondaryPos);
        const neverKeeper = p.neverKeeper ?? false;
        const gender = cleanGender(p.gender);

        if (p.id && p.id.trim()) {
          const res = await client.query<PlayerRow>(
            `UPDATE player SET number = $3, name = $4, active = $5,
                    primary_pos = $6, secondary_pos = $7, never_keeper = $8, gender = $9
              WHERE id = $1 AND team_id = $2 RETURNING *`,
            [p.id, guard.team.teamId, number, name, active, primary, secondary, neverKeeper, gender],
          );
          if (res.rows[0]) {
            out.push(res.rows[0]);
            continue;
          }
          // Id no longer exists (deleted elsewhere) — fall through to insert.
        }

        const res = await client.query<PlayerRow>(
          `INSERT INTO player (team_id, number, name, active,
                               primary_pos, secondary_pos, never_keeper, gender)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [guard.team.teamId, number, name, active, primary, secondary, neverKeeper, gender],
        );
        if (res.rows[0]) out.push(res.rows[0]);
      }

      // Dropping a player leaves their id behind inside the lineup JSON,
      // which the pitch would then render as an empty, unfillable slot.
      const goneIds = removed.rows.map((r) => r.id);
      if (goneIds.length) {
        const affected = await client.query<{
          id: string;
          assignments: Record<string, Record<string, string>>;
        }>('SELECT id, assignments FROM game WHERE team_id = $1', [guard.team.teamId]);

        for (const g of affected.rows) {
          const { assignments, removed: n } = removeUnavailable(g.assignments ?? {}, goneIds);
          if (n > 0) {
            await client.query(
              'UPDATE game SET assignments = $2, updated_at = now() WHERE id = $1',
              [g.id, JSON.stringify(assignments)],
            );
          }
        }
      }

      return out;
    });

    return { status: 200, jsonBody: saved.map(toPlayer) };
  } catch (err) {
    ctx.error('players failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('players', {
  methods: ['GET', 'PUT'],
  authLevel: 'anonymous',
  route: 'players',
  handler: playersHandler,
});

/** A name to show on the roster: never an email address. */
function personName(displayName: string | null, email: string | null): string {
  const raw = (displayName ?? '').trim();
  if (raw && !raw.includes('@')) return raw;
  return (raw || email || '').split('@')[0] || 'Team member';
}

const STAFF_ORDER = ['coach', 'assistant', 'team_parent'];

/**
 * The people on a team, names only: staff (coaches, assistant coaches and team
 * parents) and parents with the children they follow. Parents, players and
 * viewers get the staff list only.
 *
 * POST links or unlinks a child for a parent, team parent, coach or assistant
 * coach on the team, for people who can invite on the team (coaches on their
 * own team; organization and region staff on league teams).
 */
export async function teamPeopleHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    if (req.method === 'POST') {
      const b = (await req.json()) as { action?: string; teamId?: string; userId?: string; playerId?: string };
      const guard = await guardTeam(user, b.teamId, 'member.invite');
      if (!guard.ok) return guard.response;
      const target = String(b.userId ?? '').slice(0, 36);
      const playerId = String(b.playerId ?? '').slice(0, 36);
      const member = await queryOne<{ role: string }>(
        'SELECT role FROM membership WHERE user_id = $1 AND team_id = $2',
        [target, guard.team.teamId],
      );
      if (!member || !['parent', 'team_parent', 'coach', 'assistant'].includes(member.role)) {
        return { status: 400, jsonBody: { error: 'That person is not a parent or staff member on this team.' } };
      }
      const player = await queryOne<{ id: string; name: string }>(
        'SELECT id, name FROM player WHERE id = $1 AND team_id = $2',
        [playerId, guard.team.teamId],
      );
      if (!player) return { status: 400, jsonBody: { error: 'Pick a player on this team.' } };
      if (b.action === 'unlink') {
        await query('DELETE FROM player_guardian WHERE user_id = $1 AND player_id = $2', [target, player.id]);
        return { status: 200, jsonBody: { ok: true } };
      }
      await query(
        `INSERT INTO player_guardian (player_id, user_id, relation, consented_at, consented_by)
         VALUES ($1, $2, 'parent', now(), $3) ON CONFLICT DO NOTHING`,
        [player.id, target, user.id],
      );
      await query(
        `INSERT INTO notification (user_id, kind, title, body, link) VALUES ($1, 'system', $2, $3, $4)`,
        [target, `Linked to ${player.name}`, `You're now linked to ${player.name} on the team, so you can RSVP for games, practices and events.`, calendarLink(guard.team.teamId)],
      ).catch(() => undefined);
      return { status: 200, jsonBody: { ok: true } };
    }

    const guard = await guardTeam(user, req.query.get('teamId') ?? undefined, 'roster.view');
    if (!guard.ok) return guard.response;
    const family = ['parent', 'player', 'viewer'].includes(guard.role);
    const canLink = canOnTeam(guard.ctx, guard.team, 'member.invite').allowed;

    const [staff, parents] = await Promise.all([
      query<{ id: string; display_name: string | null; email: string | null; role: string; children: Array<{ id: string; name: string }> }>(
        `SELECT u.id, u.display_name, u.email, m.role,
                COALESCE(json_agg(json_build_object('id', p.id, 'name', p.name) ORDER BY p.name)
                         FILTER (WHERE p.id IS NOT NULL), '[]') AS children
           FROM membership m JOIN app_user u ON u.id = m.user_id
           LEFT JOIN player_guardian g ON g.user_id = u.id
           LEFT JOIN player p ON p.id = g.player_id AND p.team_id = m.team_id
          WHERE m.team_id = $1 AND m.role = ANY($2::text[]) AND u.deleted_at IS NULL
          GROUP BY u.id, u.display_name, u.email, m.role`,
        [guard.team.teamId, STAFF_ORDER],
      ),
      family
        ? Promise.resolve([])
        : query<{ id: string; display_name: string | null; email: string | null; children: Array<{ id: string; name: string }> }>(
            `SELECT u.id, u.display_name, u.email,
                    COALESCE(json_agg(json_build_object('id', p.id, 'name', p.name) ORDER BY p.name)
                             FILTER (WHERE p.id IS NOT NULL), '[]') AS children
               FROM membership m
               JOIN app_user u ON u.id = m.user_id
               LEFT JOIN player_guardian g ON g.user_id = u.id
               LEFT JOIN player p ON p.id = g.player_id AND p.team_id = m.team_id
              WHERE m.team_id = $1 AND m.role = 'parent' AND u.deleted_at IS NULL
              GROUP BY u.id, u.display_name, u.email`,
            [guard.team.teamId],
          ),
    ]);

    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    return {
      status: 200,
      jsonBody: {
        canLink,
        staff: staff
          .map((s) => ({
            userId: s.id,
            name: personName(s.display_name, s.email),
            role: s.role,
            // Staff see who is linked to whom; family members see staff names only.
            children: family ? [] : s.children,
          }))
          .sort((a, b) => STAFF_ORDER.indexOf(a.role) - STAFF_ORDER.indexOf(b.role) || byName(a, b)),
        parents: parents
          .map((p) => ({ userId: p.id, name: personName(p.display_name, p.email), children: p.children }))
          .sort(byName),
      },
    };
  } catch (err) {
    ctx.error('team people failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('teamPeople', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'team-people',
  handler: teamPeopleHandler,
});

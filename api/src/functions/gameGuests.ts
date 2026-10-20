import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { canOnTeam } from '@lineup/shared';
import { requireUser, type AuthedUser } from '../lib/auth.js';
import { buildAccessContext, loadTeamContext, reachableTeamIds } from '../lib/authz.js';
import { query, queryOne } from '../lib/db.js';
import { calendarLink } from '../lib/links.js';
import { appToday } from '../lib/today.js';

/**
 * Borrowing a player for a game (Fady, 10/18, migration 055).
 *
 * On its calendar, a team's coach or assistant coach (lineup.edit) asks to
 * borrow a player from another team for one upcoming game: another team in
 * the same organization, or another team they run. That team's coach and
 * assistant coach get a notification; its coach (team.edit) approves or
 * declines. The asking team hears back, and on approval the player's parents
 * are told. An approved guest is listed on the game.
 */

const FORBIDDEN: HttpResponseInit = { status: 403, jsonBody: { error: 'You do not have access to this.', code: 'FORBIDDEN' } };

const clip = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);

async function can(user: AuthedUser, teamId: string, action: 'lineup.edit' | 'team.edit' | 'team.view'): Promise<boolean> {
  const [team, access] = await Promise.all([loadTeamContext(teamId), buildAccessContext(user)]);
  return Boolean(team && canOnTeam(access, team, action).allowed);
}

/** First name and last initial, as shown to another team. */
function shortName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0] ?? 'Player';
}

interface GameRow {
  id: string;
  team_id: string;
  team_name: string;
  org_id: string;
  org_personal: boolean;
  date: string | null;
  kickoff: string | null;
  opponent: string;
  canceled: boolean;
}

async function loadGame(id: string): Promise<GameRow | undefined> {
  return queryOne<GameRow>(
    `SELECT g.id, g.team_id, t.name AS team_name, t.org_id, o.is_personal AS org_personal,
            to_char(g.date, 'YYYY-MM-DD') AS date, COALESCE(f.kickoff, g.kickoff) AS kickoff,
            g.opponent, (g.canceled_at IS NOT NULL) AS canceled
       FROM game g
       JOIN team t ON t.id = g.team_id
       JOIN organization o ON o.id = t.org_id
       LEFT JOIN fixture f ON f.id = g.fixture_id
      WHERE g.id = $1 AND g.deleted_at IS NULL AND t.deleted_at IS NULL`,
    [id],
  );
}

/**
 * Teams a team may borrow from: the other teams of its organization, and the
 * other teams the person asking can reach (their own standalone teams).
 */
async function lenderTeamIds(user: AuthedUser, team: { id: string; org_id: string; org_personal: boolean }): Promise<string[]> {
  const [sameOrg, mine] = await Promise.all([
    team.org_personal
      ? Promise.resolve([] as Array<{ id: string }>)
      : query<{ id: string }>('SELECT id FROM team WHERE org_id = $1 AND deleted_at IS NULL AND archived_at IS NULL', [team.org_id]),
    reachableTeamIds(user.id),
  ]);
  return [...new Set([...sameOrg.map((t) => t.id), ...mine])].filter((id) => id !== team.id);
}

const sayDay = (iso: string | null) =>
  iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : 'a game';

export async function gameGuestsHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    const today = appToday();

    if (req.method === 'GET') {
      const teamId = clip(req.query.get('teamId'), 36);
      if (!(await can(user, teamId, 'team.view'))) return FORBIDDEN;
      const [canBorrow, canDecide] = await Promise.all([can(user, teamId, 'lineup.edit'), can(user, teamId, 'team.edit')]);
      if (!canBorrow && !canDecide) return { status: 200, jsonBody: { canBorrow: false, canDecide: false, outgoing: [], incoming: [] } };

      // Who can be borrowed, when the picker opens.
      if (req.query.get('options')) {
        if (!canBorrow) return FORBIDDEN;
        const team = await queryOne<{ id: string; org_id: string; org_personal: boolean }>(
          `SELECT t.id, t.org_id, o.is_personal AS org_personal FROM team t JOIN organization o ON o.id = t.org_id WHERE t.id = $1`,
          [teamId],
        );
        if (!team) return FORBIDDEN;
        const ids = await lenderTeamIds(user, team);
        const rows = ids.length
          ? await query<{ team_id: string; team_name: string; region_name: string | null; division: string | null; player_id: string; player_name: string; number: string | null }>(
              `SELECT t.id AS team_id, t.name AS team_name, r.name AS region_name,
                      COALESCE(t.catalog_division_id, d.code) AS division,
                      p.id AS player_id, p.name AS player_name, p.number
                 FROM team t
                 LEFT JOIN region r ON r.id = t.region_id AND NOT r.is_personal
                 LEFT JOIN division d ON d.id = t.division_id
                 JOIN player p ON p.team_id = t.id AND p.active
                WHERE t.id = ANY($1::uuid[]) AND t.deleted_at IS NULL AND t.archived_at IS NULL
                ORDER BY r.name NULLS FIRST, t.name, p.name
                LIMIT 3000`,
              [ids],
            )
          : [];
        const teams = new Map<string, { id: string; name: string; regionName: string | null; division: string | null; players: Array<{ id: string; name: string; number: string | null }> }>();
        for (const r of rows) {
          const t = teams.get(r.team_id) ?? { id: r.team_id, name: r.team_name, regionName: r.region_name, division: r.division, players: [] };
          t.players.push({ id: r.player_id, name: r.player_name, number: r.number });
          teams.set(r.team_id, t);
        }
        return { status: 200, jsonBody: { teams: [...teams.values()] } };
      }

      const [outgoing, incoming] = await Promise.all([
        // Guests asked for this team's upcoming games.
        query<{ id: string; game_id: string; player_id: string; player_name: string; number: string | null; from_team_id: string; from_team: string; status: string; requested_by: string | null }>(
          `SELECT gg.id, gg.game_id, gg.player_id, p.name AS player_name, p.number, gg.from_team_id, ft.name AS from_team,
                  gg.status, u.display_name AS requested_by
             FROM game_guest gg
             JOIN game g ON g.id = gg.game_id AND g.deleted_at IS NULL
             JOIN player p ON p.id = gg.player_id
             JOIN team ft ON ft.id = gg.from_team_id
             LEFT JOIN app_user u ON u.id = gg.requested_by
            WHERE g.team_id = $1 AND gg.status IN ('pending', 'approved', 'declined')
              AND (g.date IS NULL OR g.date >= $2::date)
            ORDER BY gg.created_at`,
          [teamId, today],
        ),
        // Requests to borrow this team's players.
        query<{ id: string; game_id: string; date: string | null; kickoff: string | null; opponent: string; borrower: string; player_id: string; player_name: string; status: string; requested_by: string | null; note: string | null }>(
          `SELECT gg.id, gg.game_id, to_char(g.date, 'YYYY-MM-DD') AS date, COALESCE(f.kickoff, g.kickoff) AS kickoff,
                  g.opponent, bt.name AS borrower, gg.player_id, p.name AS player_name, gg.status,
                  u.display_name AS requested_by, gg.note
             FROM game_guest gg
             JOIN game g ON g.id = gg.game_id AND g.deleted_at IS NULL
             JOIN team bt ON bt.id = g.team_id
             JOIN player p ON p.id = gg.player_id
             LEFT JOIN fixture f ON f.id = g.fixture_id
             LEFT JOIN app_user u ON u.id = gg.requested_by
            WHERE gg.from_team_id = $1 AND gg.status IN ('pending', 'approved')
              AND (g.date IS NULL OR g.date >= $2::date)
            ORDER BY g.date NULLS LAST, gg.created_at`,
          [teamId, today],
        ),
      ]);
      const person = (n: string | null) => (n && !n.includes('@') ? n : null);
      return {
        status: 200,
        jsonBody: {
          canBorrow,
          canDecide,
          outgoing: outgoing.map((o) => ({
            id: o.id,
            gameId: o.game_id,
            playerId: o.player_id,
            playerName: o.player_name,
            number: o.number,
            fromTeamId: o.from_team_id,
            fromTeam: o.from_team,
            status: o.status,
            requestedBy: person(o.requested_by),
          })),
          incoming: incoming.map((i) => ({
            id: i.id,
            gameId: i.game_id,
            date: i.date,
            kickoff: i.kickoff,
            opponent: i.opponent,
            borrower: i.borrower,
            playerId: i.player_id,
            playerName: i.player_name,
            status: i.status,
            requestedBy: person(i.requested_by),
            note: i.note,
          })),
        },
      };
    }

    const b = (await req.json()) as { action?: string; gameId?: string; playerId?: string; id?: string; approve?: boolean; note?: string };

    if (b.action === 'request') {
      const game = await loadGame(clip(b.gameId, 36));
      if (!game || !(await can(user, game.team_id, 'lineup.edit'))) return FORBIDDEN;
      if (game.canceled) return { status: 409, jsonBody: { error: 'This game is cancelled.' } };
      if (game.date && game.date < today) return { status: 409, jsonBody: { error: 'This game has already been played.' } };
      const player = await queryOne<{ id: string; name: string; team_id: string; team_name: string }>(
        `SELECT p.id, p.name, p.team_id, t.name AS team_name FROM player p JOIN team t ON t.id = p.team_id
          WHERE p.id = $1 AND p.active AND t.deleted_at IS NULL AND t.archived_at IS NULL`,
        [clip(b.playerId, 36)],
      );
      if (!player || player.team_id === game.team_id) return { status: 400, jsonBody: { error: 'Pick a player from another team.' } };
      const lenders = await lenderTeamIds(user, { id: game.team_id, org_id: game.org_id, org_personal: game.org_personal });
      if (!lenders.includes(player.team_id)) return FORBIDDEN;
      const note = clip(b.note, 300) || null;
      const row = await queryOne<{ id: string }>(
        `INSERT INTO game_guest (game_id, player_id, from_team_id, requested_by, note)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id`,
        [game.id, player.id, player.team_id, user.id, note],
      );
      if (!row) return { status: 409, jsonBody: { error: `${player.name} is already asked for or playing in this game.`, code: 'ALREADY_ASKED' } };
      // The player's coach and assistant coach hear about it; the coach decides.
      await query(
        `INSERT INTO notification (user_id, kind, title, body, link)
         SELECT DISTINCT m.user_id, 'message', $2, $3, $4
           FROM membership m WHERE m.team_id = $1 AND m.role IN ('coach', 'assistant') AND m.user_id <> $5`,
        [
          player.team_id,
          `${game.team_name} wants to borrow ${shortName(player.name)}`,
          `${game.team_name} asks to borrow ${player.name} for their game${game.opponent ? ` against ${game.opponent}` : ''} on ${sayDay(game.date)}. The coach can approve or decline on ${player.team_name}'s calendar.`,
          calendarLink(player.team_id, 'borrow'),
          user.id,
        ],
      ).catch((e) => ctx.warn('borrow notify failed', e));
      return { status: 201, jsonBody: { id: row.id } };
    }

    const gg = await queryOne<{ id: string; game_id: string; player_id: string; player_name: string; from_team_id: string; from_team: string; status: string; requested_by: string | null }>(
      `SELECT gg.id, gg.game_id, gg.player_id, p.name AS player_name, gg.from_team_id, ft.name AS from_team, gg.status, gg.requested_by
         FROM game_guest gg JOIN player p ON p.id = gg.player_id JOIN team ft ON ft.id = gg.from_team_id
        WHERE gg.id = $1`,
      [clip(b.id, 36)],
    );
    if (!gg) return FORBIDDEN;
    const game = await loadGame(gg.game_id);
    if (!game) return FORBIDDEN;

    if (b.action === 'decide') {
      // The lending team's coach (or its league staff) decides.
      if (!(await can(user, gg.from_team_id, 'team.edit'))) return FORBIDDEN;
      if (gg.status !== 'pending') return { status: 409, jsonBody: { error: 'This request has already been answered.' } };
      const approve = b.approve === true;
      await query(
        `UPDATE game_guest SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1`,
        [gg.id, approve ? 'approved' : 'declined', user.id],
      );
      const when = `on ${sayDay(game.date)}${game.opponent ? ` against ${game.opponent}` : ''}`;
      await query(
        `INSERT INTO notification (user_id, kind, title, body, link)
         SELECT DISTINCT m.user_id, 'message', $2, $3, $4
           FROM membership m WHERE m.team_id = $1 AND m.role IN ('coach', 'assistant') AND m.user_id <> $5`,
        [
          game.team_id,
          `${shortName(gg.player_name)} ${approve ? 'can play' : "can't play"} for ${game.team_name}`,
          approve
            ? `${gg.from_team} approved ${gg.player_name} as a guest for your game ${when}.`
            : `${gg.from_team} declined borrowing ${gg.player_name} for your game ${when}.`,
          calendarLink(game.team_id, `game:${game.id}`),
          user.id,
        ],
      ).catch((e) => ctx.warn('borrow decision notify failed', e));
      if (approve) {
        // The player's family should know where their child is playing.
        await query(
          `INSERT INTO notification (user_id, kind, title, body, link)
           SELECT DISTINCT pg.user_id, 'message', $2, $3, $4 FROM player_guardian pg WHERE pg.player_id = $1`,
          [
            gg.player_id,
            `${gg.player_name} is a guest player`,
            `${gg.player_name} will play as a guest for ${game.team_name} ${when}${game.kickoff ? ` at ${game.kickoff}` : ''}, with ${gg.from_team}'s OK.`,
            calendarLink(gg.from_team_id, 'borrow'),
          ],
        ).catch((e) => ctx.warn('borrow family notify failed', e));
      }
      return { status: 200, jsonBody: { status: approve ? 'approved' : 'declined' } };
    }

    if (b.action === 'cancel') {
      if (!(await can(user, game.team_id, 'lineup.edit'))) return FORBIDDEN;
      if (gg.status !== 'pending' && gg.status !== 'approved') return { status: 409, jsonBody: { error: 'Nothing to cancel.' } };
      await query(`UPDATE game_guest SET status = 'cancelled', decided_at = now() WHERE id = $1`, [gg.id]);
      return { status: 200, jsonBody: { status: 'cancelled' } };
    }

    return { status: 400, jsonBody: { error: 'Unknown action' } };
  } catch (err) {
    ctx.error('game guests failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('gameGuests', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'game-guests',
  handler: gameGuestsHandler,
});

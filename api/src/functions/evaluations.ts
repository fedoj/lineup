import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import {
  canOnTeam,
  cardRating,
  cardStats,
  cardTier,
  cleanAvatar,
  cleanCountry,
  cleanScores,
  HOME_COUNTRY,
  overallRating,
  STRONG_FEET,
  type EvaluationScores,
  type StrongFoot,
} from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { guardTeam } from '../lib/authz.js';
import { query, queryOne } from '../lib/db.js';
import { featureEnabled } from '../lib/entitlements.js';
import { ensurePlayerIds } from '../lib/playerIds.js';
import { logoVersions } from './league.js';

/**
 * Player evaluation.
 *
 * Coaches and assistant coaches rate players (evaluation.edit) on any plan.
 * Organization and region admins and directors read them (evaluation.view).
 * Parents and team parents see only the overall rating of their own child,
 * and only on their own paid plan. Nobody else sees evaluations.
 */

const FAMILY_WITH_CHILD = new Set(['parent', 'team_parent']);

interface EvalRow {
  player_id: string;
  player_name: string;
  number: string;
  primary_pos: string | null;
  avatar: unknown;
  public_id: string | null;
  heritage_country: string | null;
  scores: EvaluationScores;
  strong_foot: StrongFoot | null;
  notes: string | null;
  updated_at: Date;
}

/** The FIFA-style card for one player: overall and six stats out of 99, and its colour. */
function card(scores: EvaluationScores) {
  const rating = cardRating(scores);
  return { rating, stats: cardStats(scores), tier: cardTier(rating) };
}

export async function evaluationsHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    if (req.method === 'GET') {
      const guard = await guardTeam(user, req.query.get('teamId') ?? undefined, 'team.view');
      if (!guard.ok) return guard.response;
      const canEdit = canOnTeam(guard.ctx, guard.team, 'evaluation.edit').allowed;
      const canView = canEdit || canOnTeam(guard.ctx, guard.team, 'evaluation.view').allowed;
      const mode: 'edit' | 'view' | 'overall' | null = canEdit
        ? 'edit'
        : canView
          ? 'view'
          : FAMILY_WITH_CHILD.has(guard.role)
            ? 'overall'
            : null;
      if (!mode) {
        return { status: 403, jsonBody: { error: 'You do not have access to this.', code: 'FORBIDDEN' } };
      }

      // Rating players is free for coaches and staff; a family seeing their
      // own child's card is on the family plans, and so is designing the
      // avatar (Fady, 10/17).
      const familyFeature = await featureEnabled(user.id, 'playerEvaluation');
      const locked = mode === 'overall' && !familyFeature;

      // Families see only the players they are linked to.
      const mine = new Set(guard.ctx.guardianOf ?? []);
      const onlyPlayers = mode === 'overall' ? [...mine] : null;
      // Player IDs exist for teams in an organization or region.
      await ensurePlayerIds(guard.team.teamId).catch(() => 0);
      const [rows, place] = await Promise.all([
        query<EvalRow>(
          `SELECT p.id AS player_id, p.name AS player_name, p.number, p.primary_pos, p.avatar,
                  p.public_id, p.heritage_country,
                  COALESCE(e.scores, '{}'::jsonb) AS scores, e.strong_foot, e.notes,
                  COALESCE(e.updated_at, to_timestamp(0)) AS updated_at
             FROM player p
             LEFT JOIN player_evaluation e ON e.player_id = p.id
            WHERE p.team_id = $1 AND p.active
              AND ($2::uuid[] IS NULL OR p.id = ANY($2::uuid[]))
            ORDER BY p.name`,
          [guard.team.teamId, onlyPlayers],
        ),
        // The team's region, for its logo on the card (Fady, 10/19).
        queryOne<{ team_name: string; region_id: string | null; region_name: string | null; region_personal: boolean | null }>(
          `SELECT t.name AS team_name, t.region_id, r.name AS region_name, r.is_personal AS region_personal
             FROM team t LEFT JOIN region r ON r.id = t.region_id WHERE t.id = $1`,
          [guard.team.teamId],
        ),
      ]);
      const regionId = place?.region_id && !place.region_personal ? place.region_id : null;
      const logoV = regionId ? (await logoVersions([regionId])).get(`region:${regionId}`) : undefined;
      const regionLogo = regionId && logoV ? `/api/logo?kind=region&id=${regionId}&v=${logoV}` : null;

      // Who the player is on the card, for everyone who may see it.
      const face = (r: EvalRow) => ({
        playerId: r.player_id,
        playerName: r.player_name,
        number: r.number,
        position: r.primary_pos,
        avatar: r.avatar ? cleanAvatar(r.avatar) : null,
        // Any parent of the child designs the avatar, whatever else they are on the team.
        canEditAvatar: mine.has(r.player_id),
        // On the card (Fady, 10/19): the player's ID, the flags, the team and its region's logo.
        publicId: r.public_id,
        country: HOME_COUNTRY,
        heritage: r.heritage_country,
        teamName: place?.team_name ?? null,
        regionName: regionId ? place?.region_name ?? null : null,
        regionLogo,
      });

      return {
        status: 200,
        jsonBody: {
          mode,
          locked,
          // Designing a child's avatar is paid (the playerEvaluation feature).
          avatarLocked: !familyFeature,
          evaluations: rows.map((r) =>
            mode === 'overall'
              ? locked
                ? { ...face(r), overall: null }
                : { ...face(r), overall: overallRating(r.scores), strongFoot: r.strong_foot, card: card(r.scores) }
              : {
                  ...face(r),
                  scores: cleanScores(r.scores),
                  strongFoot: r.strong_foot,
                  notes: r.notes,
                  overall: overallRating(r.scores),
                  card: card(r.scores),
                  updatedAt: r.updated_at.getTime() > 0 ? r.updated_at.toISOString() : null,
                },
          ),
        },
      };
    }

    // POST: rate one player.
    const b = (await req.json()) as { playerId?: string; scores?: unknown; strongFoot?: string | null; notes?: string | null };
    const player = await queryOne<{ id: string; team_id: string }>(
      'SELECT id, team_id FROM player WHERE id = $1',
      [String(b.playerId ?? '').slice(0, 36)],
    );
    if (!player) return { status: 403, jsonBody: { error: 'You do not have access to this.', code: 'FORBIDDEN' } };
    const guard = await guardTeam(user, player.team_id, 'evaluation.edit');
    if (!guard.ok) return guard.response;

    const scores = cleanScores(b.scores);
    const foot = b.strongFoot && (STRONG_FEET as readonly string[]).includes(b.strongFoot) ? b.strongFoot : null;
    const notes = String(b.notes ?? '').trim().slice(0, 1000) || null;
    await query(
      `INSERT INTO player_evaluation (player_id, team_id, scores, strong_foot, notes, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (player_id) DO UPDATE SET
         scores = EXCLUDED.scores, strong_foot = EXCLUDED.strong_foot, notes = EXCLUDED.notes,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [player.id, player.team_id, JSON.stringify(scores), foot, notes, user.id],
    );
    return { status: 200, jsonBody: { playerId: player.id, scores, strongFoot: foot, notes, overall: overallRating(scores), card: card(scores) } };
  } catch (err) {
    ctx.error('evaluations failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/** A parent designs their child's avatar (any parent linked to the player). */
export async function playerAvatarHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    const b = (await req.json()) as { playerId?: string; avatar?: unknown; heritage?: string | null };
    const player = await queryOne<{ id: string; team_id: string }>('SELECT id, team_id FROM player WHERE id = $1', [
      String(b.playerId ?? '').slice(0, 36),
    ]);
    if (!player) return { status: 403, jsonBody: { error: 'You do not have access to this.', code: 'FORBIDDEN' } };
    const guard = await guardTeam(user, player.team_id, 'team.view');
    if (!guard.ok) return guard.response;
    if (!(guard.ctx.guardianOf ?? []).includes(player.id)) {
      return { status: 403, jsonBody: { error: "Only the player's parents design their avatar.", code: 'FORBIDDEN' } };
    }
    // Designing the avatar is on the paid plans (Fady, 10/17).
    if (!(await featureEnabled(user.id, 'playerEvaluation'))) {
      return {
        status: 402,
        jsonBody: { error: 'Your plan does not include this feature.', code: 'UPGRADE_REQUIRED', details: { feature: 'playerEvaluation' } },
      };
    }
    const avatar = cleanAvatar(b.avatar);
    // The family's home country, shown next to the American flag (optional).
    const heritage = 'heritage' in b ? cleanCountry(b.heritage) : undefined;
    if (heritage === undefined) {
      await query('UPDATE player SET avatar = $2::jsonb WHERE id = $1', [player.id, JSON.stringify(avatar)]);
    } else {
      await query('UPDATE player SET avatar = $2::jsonb, heritage_country = $3 WHERE id = $1', [
        player.id,
        JSON.stringify(avatar),
        heritage,
      ]);
    }
    return { status: 200, jsonBody: { playerId: player.id, avatar, heritage: heritage ?? null } };
  } catch (err) {
    ctx.error('player avatar failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('playerAvatar', {
  methods: ['POST'], authLevel: 'anonymous', route: 'player-avatar', handler: playerAvatarHandler,
});

app.http('evaluations', {
  methods: ['GET', 'POST'], authLevel: 'anonymous', route: 'evaluations', handler: evaluationsHandler,
});

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import {
  canOnScope,
  canOnTeam,
  canRestoreTeam,
  FORMATS,
  isFamilyOnly,
  isValidFormation,
  membershipsForTeam,
  teamRestoreUntil,
  type Format,
  type Team,
} from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { REACHABLE_TEAM_IDS_SQL, buildAccessContext, denyResponse, guardTeam } from '../lib/authz.js';
import { query, queryOne, transaction } from '../lib/db.js';
import { enforceTeamLimit } from '../lib/entitlements.js';

/** Thrown inside the create transaction when the division id is not real. */
class UnknownDivisionError extends Error {
  constructor() {
    super('Unknown division');
    this.name = 'UnknownDivisionError';
  }
}

interface TeamRow {
  id: string;
  owner_id: string;
  name: string;
  age_group: string;
  season: string;
  coach: string;
  assistant_coach: string | null;
  region: string | null;
  division: string | null;
  catalog_division_id: string | null;
  gender: string | null;
  age_u: number | null;
  format: string | null;
  periods: string | null;
  period_length_sec: number | null;
  default_formation: string | null;
  created_at: Date;
  archived_at?: Date | null;
}

function toTeam(row: TeamRow): Team {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    ageGroup: row.age_group,
    season: row.season,
    coach: row.coach,
    assistantCoach: row.assistant_coach ?? undefined,
    region: row.region ?? undefined,
    division: row.division ?? undefined,
    catalogDivisionId: row.catalog_division_id ?? undefined,
    gender: (row.gender as Team['gender']) ?? undefined,
    ageU: row.age_u ?? undefined,
    format: (row.format as Team['format']) ?? undefined,
    periods: (row.periods as Team['periods']) ?? undefined,
    periodLengthSec: row.period_length_sec ?? undefined,
    defaultFormation: row.default_formation ?? undefined,
    createdAt: row.created_at.toISOString(),
    archivedAt: row.archived_at ? row.archived_at.toISOString() : undefined,
    restoreUntil: row.archived_at ? teamRestoreUntil(row.archived_at) : undefined,
  };
}

export async function teamsHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) {
      return { status: 401, jsonBody: { error: 'Not authenticated' } };
    }

    if (req.method === 'GET') {
      // Everything the caller can reach through any membership, not just
      // teams they personally created; the caller's access is read alongside.
      const [rows, access] = await Promise.all([
        query<
          TeamRow & {
            org_id: string;
            region_id: string | null;
            division_id: string | null;
            org_personal: boolean;
            region_personal: boolean | null;
          }
        >(
          `SELECT t.*, o.is_personal AS org_personal, r.is_personal AS region_personal
             FROM team t
             JOIN organization o ON o.id = t.org_id
             LEFT JOIN region r ON r.id = t.region_id
            WHERE t.deleted_at IS NULL AND t.id IN (${REACHABLE_TEAM_IDS_SQL})
            ORDER BY (t.archived_at IS NOT NULL), t.created_at`,
          [user.id],
        ),
        // The caller's strongest role per team lets the app hide screens a role
        // never uses, e.g. match day for a team parent. The API still enforces.
        buildAccessContext(user),
      ]);
      return {
        status: 200,
        jsonBody: rows.map((r) => {
          const scope = {
            teamId: r.id,
            orgId: r.org_id,
            regionId: r.region_id,
            divisionId: r.division_id,
            inLeague: !r.org_personal || Boolean(r.region_id && r.region_personal === false),
            archived: Boolean(r.archived_at),
          };
          return {
            ...toTeam(r),
            myRole: membershipsForTeam(access.memberships, scope)[0]?.role ?? null,
            inLeague: scope.inLeague,
            canAddPlayers: canOnTeam(access, scope, 'roster.add').allowed,
            canInvite: canOnTeam(access, scope, 'member.invite').allowed,
            canArchive: canOnTeam(access, { ...scope, archived: false }, 'team.edit').allowed,
          };
        }),
      };
    }

    if (req.method === 'PATCH') {
      // Teams created before divisions were mandatory carry no format at all,
      // so they need a way to adopt one without being recreated.
      const patch = (await req.json()) as {
        id?: string;
        /** Archive the team (read-only), or bring it back within 1 month. */
        action?: 'archive' | 'restore';
        name?: string;
        coach?: string;
        catalogDivisionId?: string;
        format?: Format;
        periods?: 'quarters' | 'halves';
        defaultFormation?: string;
      };
      if (!patch.id) return { status: 400, jsonBody: { error: 'id is required' } };

      if (patch.action === 'archive' || patch.action === 'restore') {
        const view = await guardTeam(user, patch.id, 'team.view');
        if (!view.ok) return view.response;
        // Whoever may edit the team decides; archiving does not take that away.
        const may = canOnTeam(view.ctx, { ...view.team, archived: false }, 'team.edit');
        if (!may.allowed) return denyResponse(may);
        if (patch.action === 'archive') {
          const row = await queryOne<TeamRow>(
            `UPDATE team SET archived_at = now(), archived_by = $2
              WHERE id = $1 AND deleted_at IS NULL AND archived_at IS NULL RETURNING *`,
            [view.team.teamId, user.id],
          );
          if (!row) return { status: 409, jsonBody: { error: 'This team is already archived.', code: 'ALREADY_ARCHIVED' } };
          return { status: 200, jsonBody: { ...toTeam(row), canArchive: true } };
        }
        const current = await queryOne<{ archived_at: Date | null }>('SELECT archived_at FROM team WHERE id = $1', [
          view.team.teamId,
        ]);
        if (!current?.archived_at) return { status: 409, jsonBody: { error: 'This team is not archived.', code: 'NOT_ARCHIVED' } };
        if (!canRestoreTeam(current.archived_at)) {
          return {
            status: 409,
            jsonBody: {
              error: 'This team was archived more than a month ago, so it stays archived (read-only).',
              code: 'RESTORE_EXPIRED',
            },
          };
        }
        // Back in use, it counts toward the plan's teams again.
        const denied = await enforceTeamLimit(user.id);
        if (denied) return { status: denied.status, jsonBody: denied.body };
        const row = await queryOne<TeamRow>(
          'UPDATE team SET archived_at = NULL, archived_by = NULL WHERE id = $1 RETURNING *',
          [view.team.teamId],
        );
        return { status: 200, jsonBody: row ? { ...toTeam(row), canArchive: true } : null };
      }

      const guard = await guardTeam(user, patch.id, 'team.edit');
      if (!guard.ok) return guard.response;

      let cat: {
        label: string; gender: string; age_u: number;
        format: string; periods: string; period_length_sec: number;
      } | null = null;

      if (patch.catalogDivisionId) {
        cat =
          (await queryOne<{
            label: string; gender: string; age_u: number;
            format: string; periods: string; period_length_sec: number;
          }>(
            `SELECT label, gender, age_u, format, periods, period_length_sec
               FROM division_catalog WHERE id = $1`,
            [patch.catalogDivisionId],
          )) ?? null;
        if (!cat) {
          return {
            status: 400,
            jsonBody: { error: 'That division does not exist.', code: 'DIVISION_UNKNOWN' },
          };
        }
      }

      const row = await queryOne<TeamRow>(
        `UPDATE team SET
           name = COALESCE($2, name),
           coach = COALESCE($3, coach),
           catalog_division_id = COALESCE($4, catalog_division_id),
           age_group = COALESCE($5, age_group),
           gender = COALESCE($6, gender),
           age_u = COALESCE($7, age_u),
           format = COALESCE($8, format),
           periods = COALESCE($9, periods),
           period_length_sec = COALESCE($10, period_length_sec),
           default_formation = COALESCE($11, default_formation)
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING *`,
        [
          guard.team.teamId,
          patch.name?.trim() || null,
          patch.coach ?? null,
          patch.catalogDivisionId ?? null,
          cat?.label ?? null,
          cat?.gender ?? null,
          cat?.age_u ?? null,
          // An explicit choice beats the division's suggestion.
          patch.format ?? cat?.format ?? null,
          patch.periods ?? cat?.periods ?? null,
          cat?.period_length_sec ?? null,
          patch.defaultFormation ?? null,
        ],
      );
      return { status: 200, jsonBody: row ? toTeam(row) : null };
    }

    // POST — create, subject to the teams limit
    // Team parents, parents, players and viewers join teams by invite; they
    // never create one. Someone with no team yet is a new coach signing up.
    const creator = await buildAccessContext(user);
    if (!creator.isPlatformAdmin && isFamilyOnly(creator.memberships.map((m) => m.role))) {
      return {
        status: 403,
        jsonBody: {
          error: 'Team parents and parents join teams by invite and cannot create teams.',
          code: 'ROLE_CANNOT_CREATE_TEAM',
        },
      };
    }
    const denied = await enforceTeamLimit(user.id);
    if (denied) {
      return { status: denied.status, jsonBody: denied.body };
    }

    const body = (await req.json()) as Partial<Team> & {
      catalogDivisionId?: string;
      divisionId?: string;
      orgId?: string;
      regionId?: string;
      gender?: string;
      ageU?: number;
    };
    // Placing a team inside an organization or region is team.create there,
    // and the region has to belong to that organization.
    if (body.orgId || body.regionId) {
      const region = body.regionId
        ? await queryOne<{ org_id: string }>('SELECT org_id FROM region WHERE id = $1 AND deleted_at IS NULL', [body.regionId])
        : null;
      const orgId = body.orgId ?? region?.org_id ?? null;
      if (!orgId || (body.regionId && region?.org_id !== orgId)) {
        return { status: 403, jsonBody: { error: 'You do not have access to this.', code: 'FORBIDDEN' } };
      }
      const decision = canOnScope(creator, { orgId, regionId: body.regionId ?? null }, 'team.create');
      if (!decision.allowed) return denyResponse(decision);
      body.orgId = orgId;
    }
    if (!body.name?.trim()) {
      return { status: 400, jsonBody: { error: 'name is required' } };
    }
    // A team must sit in a division: it is what decides the match format,
    // period structure and period length. Without it every game silently
    // falls back to 7v7, which is wrong for most age groups.
    if (!body.catalogDivisionId?.trim()) {
      return {
        status: 400,
        jsonBody: {
          error: 'Choose a division — it sets the match format for every game.',
          code: 'DIVISION_REQUIRED',
        },
      };
    }

    const row = await transaction(async (client) => {
      let orgId = body.orgId ?? null;
      let regionId = body.regionId ?? null;

      // A free coach has no org of their own, so make a hidden personal one.
      // It keeps foreign keys and cascades honest without exposing hierarchy.
      if (!orgId) {
        const org = await client.query<{ id: string }>(
          `INSERT INTO organization (name, is_personal, created_by)
           VALUES ($1, true, $2) RETURNING id`,
          [body.name!.trim(), user.id],
        );
        orgId = org.rows[0].id;
        const reg = await client.query<{ id: string }>(
          `INSERT INTO region (org_id, name, is_personal, created_by)
           VALUES ($1, 'Default', true, $2) RETURNING id`,
          [orgId, user.id],
        );
        regionId = reg.rows[0].id;
      }

      // Inherit match defaults from the chosen division.
      let gender: string | null = body.gender ?? null;
      let ageU: number | null = body.ageU ?? null;
      let ageGroup = body.ageGroup ?? '';
      let format: string | null = null;
      let periods: string | null = null;
      let periodLengthSec: number | null = null;

      const cat = await client.query<{
        label: string;
        gender: string;
        age_u: number;
        format: string;
        periods: string;
        period_length_sec: number;
      }>(
        `SELECT label, gender, age_u, format, periods, period_length_sec
           FROM division_catalog WHERE id = $1`,
        [body.catalogDivisionId],
      );
      if (!cat.rows[0]) {
        // Surfaced as a 400 by the caller below.
        throw new UnknownDivisionError();
      }
      const d = cat.rows[0];
      gender = gender ?? d.gender;
      ageU = ageU ?? d.age_u;
      ageGroup = ageGroup || d.label;
      // The division only SUGGESTS the match setup. Leagues vary — some play
      // U11 at 7v7, others at 9v9 — so an explicit choice always wins.
      format = body.format ?? d.format;
      periods = body.periods ?? d.periods;
      periodLengthSec = body.periodLengthSec ?? d.period_length_sec;

      const defaultFormation =
        body.defaultFormation && isValidFormation(format as Format, body.defaultFormation)
          ? body.defaultFormation
          : FORMATS[format as Format]?.defaultFormation ?? null;

      const inserted = await client.query<TeamRow>(
        `INSERT INTO team (owner_id, name, age_group, season, coach,
                           assistant_coach, region, division,
                           org_id, region_id, division_id, catalog_division_id,
                           gender, age_u, format, periods, period_length_sec,
                           default_formation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING *`,
        [
          user.id,
          body.name!.trim(),
          ageGroup,
          body.season ?? '',
          body.coach ?? '',
          body.assistantCoach ?? null,
          body.region ?? null,
          body.division ?? null,
          orgId,
          regionId,
          body.divisionId ?? null,
          body.catalogDivisionId,
          gender,
          ageU,
          format,
          periods,
          periodLengthSec,
          defaultFormation,
        ],
      );

      // The creator coaches a team of their own. Organization or region staff
      // creating a team in their league stay staff and invite its coach.
      if (!body.orgId) {
        await client.query(
          `INSERT INTO membership (user_id, role, team_id) VALUES ($1, 'coach', $2)
           ON CONFLICT DO NOTHING`,
          [user.id, inserted.rows[0].id],
        );
      }

      return inserted.rows[0];
    });

    return { status: 201, jsonBody: row ? toTeam(row) : null };
  } catch (err) {
    if (err instanceof UnknownDivisionError) {
      return {
        status: 400,
        jsonBody: { error: 'That division does not exist.', code: 'DIVISION_UNKNOWN' },
      };
    }
    ctx.error('teams failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('teams', {
  methods: ['GET', 'POST', 'PATCH'],
  authLevel: 'anonymous',
  route: 'teams',
  handler: teamsHandler,
});

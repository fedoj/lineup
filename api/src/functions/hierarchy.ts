import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import {
  LINEUP_PLAN,
  ROLE_RANK,
  assignableRoles,
  canManageScope,
  canOnScope,
  canOnTeam,
  tierForFeature,
  type Decision,
  type Role,
} from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import {
  buildAccessContext,
  denyResponse,
  guardScope,
  loadTeamContext,
  reachableTeamIds,
} from '../lib/authz.js';
import { enforceFeature, enforceRegionLimit, standaloneRegionGate } from '../lib/entitlements.js';
import { escapeHtml, sendEmail } from '../lib/email.js';
import { linkCoParentChildren } from '../lib/coParent.js';
import { query, queryOne, transaction } from '../lib/db.js';
import { logoVersions } from './league.js';
import { randomBytes } from 'node:crypto';

/** Indistinguishable from "no access", so ids cannot be probed. */
const NOT_FOUND: HttpResponseInit = {
  status: 403,
  jsonBody: { error: 'You do not have access to this.', code: 'FORBIDDEN' },
};

function clip(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

/** A decision as the UI needs it: allowed, or why not and what would fix it. */
function decisionOut(d: Decision) {
  return {
    allowed: d.allowed,
    reason: d.reason ?? null,
    upgradeTo: d.requiresFeature ? tierForFeature(d.requiresFeature) ?? null : null,
  };
}

/* ----------------------------------------------------- division catalog */

/** The static list free teams choose from. No auth needed — it is public. */
export async function catalogHandler(
  _req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const rows = await query(
      `SELECT id, label, gender, age_u AS "ageU", format, periods,
              period_length_sec AS "periodLengthSec"
         FROM division_catalog ORDER BY sort_order`,
    );
    return { status: 200, jsonBody: rows };
  } catch (err) {
    ctx.error('catalog failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/* ------------------------------------------------------------ divisions */

export async function divisionsHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    if (req.method === 'GET') {
      const regionId = req.query.get('regionId');
      const access = await buildAccessContext(user);
      const regionIds = access.memberships
        .map((m) => m.regionId)
        .filter((x): x is string => Boolean(x));

      const rows = await query(
        `SELECT d.id, d.region_id AS "regionId", d.code, d.name, d.gender,
                d.age_u AS "ageU", d.season, d.format, d.periods,
                d.period_length_sec AS "periodLengthSec"
           FROM division d
           JOIN region r ON r.id = d.region_id
          WHERE d.deleted_at IS NULL
            AND ($1::uuid IS NULL OR d.region_id = $1)
            AND (d.region_id = ANY($2::uuid[])
                 OR r.org_id = ANY($3::uuid[]))
          ORDER BY d.code`,
        [
          regionId,
          regionIds,
          access.memberships.map((m) => m.orgId).filter(Boolean),
        ],
      );
      return { status: 200, jsonBody: rows };
    }

    // Creating a custom division is a paid feature.
    const denied = await enforceFeature(user.id, 'customDivisions');
    if (denied) return { status: denied.status, jsonBody: denied.body };

    const guard = await guardScope(user, 'division');
    if (!guard.ok) return guard.response;

    const body = (await req.json()) as {
      regionId?: string;
      code?: string;
      name?: string;
      gender?: string;
      ageU?: number;
      season?: string;
      format?: string;
      periods?: string;
      periodLengthSec?: number;
    };
    if (!body.regionId || !body.code) {
      return { status: 400, jsonBody: { error: 'regionId and code are required' } };
    }

    const row = await queryOne(
      `INSERT INTO division (region_id, code, name, gender, age_u, season,
                             format, periods, period_length_sec, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (region_id, code, season) DO UPDATE SET
         name = EXCLUDED.name, gender = EXCLUDED.gender, age_u = EXCLUDED.age_u,
         format = EXCLUDED.format, periods = EXCLUDED.periods,
         period_length_sec = EXCLUDED.period_length_sec
       RETURNING id, region_id AS "regionId", code, name, gender,
                 age_u AS "ageU", season, format, periods,
                 period_length_sec AS "periodLengthSec"`,
      [
        body.regionId, body.code, body.name ?? null, body.gender ?? 'coed',
        body.ageU ?? null, body.season ?? '', body.format ?? null,
        body.periods ?? null, body.periodLengthSec ?? null, user.id,
      ],
    );
    return { status: 201, jsonBody: row };
  } catch (err) {
    ctx.error('divisions failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/* --------------------------------------------------------- orgs/regions */

export async function orgsHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    if (req.method === 'GET') {
      const rows = await query(
        `SELECT o.id, o.name, o.slug, o.is_personal AS "isPersonal", m.role
           FROM organization o
           JOIN membership m ON m.org_id = o.id AND m.user_id = $1
          WHERE o.deleted_at IS NULL AND NOT o.is_personal
          ORDER BY o.name`,
        [user.id],
      );
      return { status: 200, jsonBody: rows };
    }

    if (req.method === 'PATCH') {
      const access = await buildAccessContext(user);
      const body = (await req.json()) as { id?: string; name?: string; slug?: string };
      if (!body.id) return { status: 400, jsonBody: { error: 'id is required' } };
      const org = await queryOne<{ id: string; is_personal: boolean }>(
        'SELECT id, is_personal FROM organization WHERE id = $1 AND deleted_at IS NULL',
        [body.id],
      );
      if (!org || org.is_personal) return NOT_FOUND;
      // Renaming the organization is for its directors only, not its admins.
      const decision = canOnScope(access, { orgId: org.id }, 'scope.rename');
      if (!decision.allowed) {
        return decision.reason === 'upgrade-required'
          ? denyResponse(decision)
          : { status: 403, jsonBody: { error: 'Only the organization director can rename it.', code: 'DIRECTOR_ONLY' } };
      }
      const name = clip(body.name, 80);
      if (!name) return { status: 400, jsonBody: { error: 'name is required' } };
      const row = await queryOne(
        `UPDATE organization SET name = $2, slug = COALESCE($3, slug)
          WHERE id = $1
          RETURNING id, name, slug, is_personal AS "isPersonal"`,
        [org.id, name, body.slug ?? null],
      );
      return { status: 200, jsonBody: row };
    }

    // Creating an organization is org.manage: an org-level role, on a plan
    // that includes organizations. A coach is refused by role, an org admin
    // on a lower plan is refused commercially and shown an upgrade prompt.
    const guard = await guardScope(user, 'org');
    if (!guard.ok) return guard.response;

    const body = (await req.json()) as { name?: string; slug?: string };
    const name = clip(body.name, 80);
    if (!name) return { status: 400, jsonBody: { error: 'name is required' } };

    const existing = await queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n
         FROM organization o
         JOIN membership m ON m.org_id = o.id AND m.user_id = $1
        WHERE o.deleted_at IS NULL AND NOT o.is_personal`,
      [user.id],
    );
    if (Number(existing?.n ?? 0) >= 1) {
      return {
        status: 409,
        jsonBody: {
          error: 'Your plan allows one organization. Rename the existing organization instead.',
          code: 'ORG_LIMIT_REACHED',
        },
      };
    }

    const row = await transaction(async (client) => {
      const org = await client.query(
        `INSERT INTO organization (name, slug, is_personal, created_by)
         VALUES ($1, $2, false, $3)
         RETURNING id, name, slug, is_personal AS "isPersonal"`,
        [name, body.slug ?? null, user.id],
      );
      // The person who creates an organization is its director: the top role,
      // who renames it and invites the admins who help run it.
      await client.query(
        `INSERT INTO membership (user_id, role, org_id) VALUES ($1, 'director', $2)
         ON CONFLICT DO NOTHING`,
        [user.id, org.rows[0].id],
      );
      return org.rows[0];
    });

    return { status: 201, jsonBody: row };
  } catch (err) {
    ctx.error('orgs failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

export async function regionsHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    if (req.method === 'GET') {
      const rows = await query(
        `SELECT DISTINCT r.id, r.org_id AS "orgId", r.name,
                r.is_personal AS "isPersonal"
           FROM region r
           LEFT JOIN membership m ON m.user_id = $1
          WHERE r.deleted_at IS NULL AND NOT r.is_personal
            AND (m.region_id = r.id OR m.org_id = r.org_id)
          ORDER BY r.name`,
        [user.id],
      );
      return { status: 200, jsonBody: rows };
    }

    const access = await buildAccessContext(user);

    if (req.method === 'PATCH') {
      // Rename a region, or move it (and every team in it) to another org.
      const body = (await req.json()) as {
        id?: string;
        orgId?: string;
        name?: string;
      };
      if (!body.id) return { status: 400, jsonBody: { error: 'id is required' } };

      const region = await queryOne<{ id: string; org_id: string; is_personal: boolean }>(
        'SELECT id, org_id, is_personal FROM region WHERE id = $1 AND deleted_at IS NULL',
        [body.id],
      );
      if (!region || region.is_personal) return NOT_FOUND;

      const moving = Boolean(body.orgId && body.orgId !== region.org_id);
      const renaming = Boolean(body.name !== undefined && clip(body.name, 80));
      // Moving a region between organizations needs org-level authority on
      // both sides (a region role never moves its own region); changing the
      // region's details needs to manage the region itself, and renaming it is
      // for directors only.
      const source = canOnScope(
        access,
        moving ? { orgId: region.org_id } : { orgId: region.org_id, regionId: region.id },
        moving ? 'org.manage' : 'region.manage',
      );
      if (!source.allowed) return denyResponse(source);
      if (renaming) {
        const current = await queryOne<{ name: string }>('SELECT name FROM region WHERE id = $1', [region.id]);
        if (current && current.name !== clip(body.name, 80)) {
          const rename = canOnScope(access, { orgId: region.org_id, regionId: region.id }, 'scope.rename');
          if (!rename.allowed) {
            return rename.reason === 'upgrade-required'
              ? denyResponse(rename)
              : { status: 403, jsonBody: { error: 'Only a region or organization director can rename a region.', code: 'DIRECTOR_ONLY' } };
          }
        }
      }

      if (moving) {
        const target = await queryOne<{ id: string; is_personal: boolean }>(
          'SELECT id, is_personal FROM organization WHERE id = $1 AND deleted_at IS NULL',
          [body.orgId],
        );
        if (!target || target.is_personal) return NOT_FOUND;
        const dest = canOnScope(access, { orgId: target.id }, 'org.manage');
        if (!dest.allowed) return denyResponse(dest);

        await transaction(async (client) => {
          await client.query('UPDATE region SET org_id = $2 WHERE id = $1', [region.id, target.id]);
          // Teams follow their region, or they would sit in an org that no
          // longer contains the region they claim to be in.
          await client.query('UPDATE team SET org_id = $2 WHERE region_id = $1', [
            region.id,
            target.id,
          ]);
        });
      }

      const row = await queryOne(
        `UPDATE region SET name = COALESCE($2, name)
          WHERE id = $1
          RETURNING id, org_id AS "orgId", name, is_personal AS "isPersonal"`,
        [region.id, clip(body.name, 80) || null],
      );
      return { status: 200, jsonBody: row };
    }

    const body = (await req.json()) as { orgId?: string; name?: string };
    const name = clip(body.name, 80);
    if (!name) return { status: 400, jsonBody: { error: 'name is required' } };

    // No organization: a standalone region, the Region plan. It sits in a
    // hidden personal organization so foreign keys resolve, and its creator
    // runs it as region director.
    if (!body.orgId) {
      const gate = await standaloneRegionGate(user.id, Boolean(access.isPlatformAdmin));
      if (!gate.allowed) {
        return gate.reason === 'limit-reached'
          ? {
              status: 409,
              jsonBody: {
                error: 'The Region plan includes one region, and you already have it.',
                code: 'REGION_LIMIT_REACHED',
              },
            }
          : {
              status: 402,
              jsonBody: {
                error: 'A region of your own is part of the Region plan. See Account, Plans to subscribe.',
                code: 'UPGRADE_REQUIRED',
                details: { feature: 'regions', upgradeTo: 'region' },
              },
            };
      }
      const row = await transaction(async (client) => {
        const org = await client.query<{ id: string }>(
          `INSERT INTO organization (name, is_personal, created_by)
           VALUES ($1, true, $2) RETURNING id`,
          [name, user.id],
        );
        const region = await client.query(
          `INSERT INTO region (org_id, name, is_personal, created_by)
           VALUES ($1, $2, false, $3)
           RETURNING id, org_id AS "orgId", name, is_personal AS "isPersonal"`,
          [org.rows[0].id, name, user.id],
        );
        await client.query(
          `INSERT INTO membership (user_id, role, region_id) VALUES ($1, 'director', $2)
           ON CONFLICT DO NOTHING`,
          [user.id, region.rows[0].id],
        );
        // A Region plan the creator holds now belongs to the region, so the
        // admins and directors they invite are covered by it too.
        await client.query(
          `UPDATE entitlement SET region_id = $3
            WHERE app_id = $1 AND user_id = $2 AND tier = 'region'
              AND org_id IS NULL AND region_id IS NULL`,
          [LINEUP_PLAN.appId, user.id, region.rows[0].id],
        );
        return region.rows[0];
      });
      return { status: 201, jsonBody: { ...row, standalone: true } };
    }

    const org = await queryOne<{ id: string; is_personal: boolean }>(
      'SELECT id, is_personal FROM organization WHERE id = $1 AND deleted_at IS NULL',
      [body.orgId],
    );
    if (!org || org.is_personal) return NOT_FOUND;

    // Checked against THIS org, so a director elsewhere cannot add regions here.
    const decision = canOnScope(access, { orgId: org.id }, 'region.manage');
    if (!decision.allowed) return denyResponse(decision);

    // Organization plans hold 20 regions, Organization Plus 40.
    const overLimit = await enforceRegionLimit(user.id, org.id);
    if (overLimit) return { status: overLimit.status, jsonBody: overLimit.body };

    const row = await queryOne(
      `INSERT INTO region (org_id, name, is_personal, created_by)
       VALUES ($1, $2, false, $3)
       RETURNING id, org_id AS "orgId", name, is_personal AS "isPersonal"`,
      [org.id, name, user.id],
    );
    return { status: 201, jsonBody: row };
  } catch (err) {
    ctx.error('regions failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/* ------------------------------------------------------------ hierarchy */

/**
 * Everything the Organization screen needs in one call: the orgs and regions
 * the caller can see, where each of their teams sits, and what they may
 * change. Decisions come from the access context, so they honour role and
 * plan impersonation exactly as the write endpoints will.
 */
export async function hierarchyHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    // Independent lookups run together; only what needs an earlier answer waits for it.
    const [access, teamIds] = await Promise.all([buildAccessContext(user), reachableTeamIds(user.id)]);

    const [teams, orgs, standalone, createRegion] = await Promise.all([
      query<{
        id: string;
        name: string;
        org_id: string;
        region_id: string | null;
        division_id: string | null;
        org_name: string;
        org_personal: boolean;
        region_name: string | null;
        region_personal: boolean | null;
        archived: boolean;
      }>(
        `SELECT t.id, t.name, t.org_id, t.region_id, t.division_id,
                o.name AS org_name, o.is_personal AS org_personal,
                r.name AS region_name, r.is_personal AS region_personal,
                (t.archived_at IS NOT NULL) AS archived
           FROM team t
           JOIN organization o ON o.id = t.org_id
           LEFT JOIN region r ON r.id = t.region_id
          WHERE t.id = ANY($1::uuid[]) AND t.deleted_at IS NULL
          ORDER BY t.name`,
        [teamIds],
      ),
      // Real organizations only: personal ones exist for foreign keys and are
      // never shown.
      query<{ id: string; name: string }>(
        `SELECT o.id, o.name FROM organization o
          WHERE o.deleted_at IS NULL AND NOT o.is_personal
            AND (o.id IN (SELECT org_id FROM membership
                           WHERE user_id = $1 AND org_id IS NOT NULL)
                 OR o.id IN (SELECT r.org_id FROM membership m
                               JOIN region r ON r.id = m.region_id
                              WHERE m.user_id = $1)
                 OR o.id IN (SELECT org_id FROM team WHERE id = ANY($2::uuid[])))
          ORDER BY o.name`,
        [user.id, teamIds],
      ),
      // Standalone regions (the Region plan): a real region inside a hidden
      // personal organization, shown at the top of the tree on its own.
      query<{ id: string; org_id: string; name: string; teams: number }>(
        `SELECT r.id, r.org_id, r.name,
                (SELECT COUNT(*) FROM team t
                  WHERE t.region_id = r.id AND t.deleted_at IS NULL)::int AS teams
           FROM region r
           JOIN organization o ON o.id = r.org_id
          WHERE r.deleted_at IS NULL AND NOT r.is_personal
            AND o.deleted_at IS NULL AND o.is_personal
            AND (r.id IN (SELECT region_id FROM membership WHERE user_id = $1 AND region_id IS NOT NULL)
                 OR r.org_id IN (SELECT org_id FROM membership WHERE user_id = $1 AND org_id IS NOT NULL)
                 OR r.id IN (SELECT region_id FROM team WHERE id = ANY($2::uuid[]) AND region_id IS NOT NULL))
          ORDER BY r.name`,
        [user.id, teamIds],
      ),
      standaloneRegionGate(user.id, Boolean(access.isPlatformAdmin)),
    ]);

    const [regions, trials, firstLogos] = await Promise.all([
      orgs.length
        ? query<{ id: string; org_id: string; name: string; teams: number }>(
            `SELECT r.id, r.org_id, r.name,
                    (SELECT COUNT(*) FROM team t
                      WHERE t.region_id = r.id AND t.deleted_at IS NULL)::int AS teams
               FROM region r
              WHERE r.org_id = ANY($1::uuid[]) AND r.deleted_at IS NULL AND NOT r.is_personal
              ORDER BY r.name`,
            [orgs.map((o) => o.id)],
          )
        : Promise.resolve([]),
      // Organizations and regions on a free trial show how long is left.
      query<{ org_id: string | null; region_id: string | null; ends_at: Date }>(
        `SELECT org_id, region_id, ends_at FROM plan_trial
          WHERE kind = 'scope' AND converted_at IS NULL AND paused_at IS NULL
            AND (org_id = ANY($1::uuid[]) OR region_id = ANY($2::uuid[]))`,
        [orgs.map((o) => o.id), standalone.map((r) => r.id)],
      ),
      logoVersions([...orgs.map((o) => o.id), ...standalone.map((r) => r.id), ...teams.map((t) => t.id)]),
    ]);
    const trialEnds = new Map<string, string>();
    for (const t of trials) trialEnds.set((t.org_id ?? t.region_id) as string, t.ends_at.toISOString());
    // Regions inside organizations are known only now; their logos join the rest.
    const logos = regions.length
      ? new Map([...firstLogos, ...(await logoVersions(regions.map((r) => r.id)))])
      : firstLogos;

    // Linking a team into an organization or region, or taking it out, is for
    // that organization's or region's admins and directors only. Coaches never
    // move teams: a team in a league was placed there from the top.
    const assignsSomewhere = [...regions, ...standalone].some((r) =>
      canOnScope(access, { orgId: r.org_id, regionId: r.id }, 'team.create').allowed,
    );
    const mayMove = (t: (typeof teams)[number]) => {
      const scope = { teamId: t.id, orgId: t.org_id, regionId: t.region_id, divisionId: t.division_id };
      if (!canOnTeam(access, scope, 'team.edit').allowed) return false;
      // A team is in a league when its organization is real, or when it sits
      // in a standalone region; only that league's staff may take it out.
      const inLeague = !t.org_personal || Boolean(t.region_id && t.region_personal === false);
      return inLeague
        ? canOnScope(access, { orgId: t.org_id, regionId: t.region_personal ? null : t.region_id }, 'team.create').allowed
        : assignsSomewhere;
    };

    const regionOut = (r: (typeof regions)[number]) => ({
      id: r.id,
      name: r.name,
      teams: r.teams,
      logo: logos.get(`region:${r.id}`) ?? null,
      canAssign: canOnScope(access, { orgId: r.org_id, regionId: r.id }, 'team.create').allowed,
      canManage: canOnScope(access, { orgId: r.org_id, regionId: r.id }, 'region.manage').allowed,
      canRename: canOnScope(access, { orgId: r.org_id, regionId: r.id }, 'scope.rename').allowed,
      canInvite: canOnScope(access, { orgId: r.org_id, regionId: r.id }, 'member.invite').allowed,
      // Schedules games and keeps the field maps (staff, and the scheduler role).
      canSchedule: canOnScope(access, { orgId: r.org_id, regionId: r.id }, 'fixture.schedule').allowed,
      trialEndsAt: trialEnds.get(r.id) ?? null,
    });

    return {
      status: 200,
      jsonBody: {
        createOrg: decisionOut(canManageScope(access, 'org')),
        createRegion,
        orgs: orgs.map((o) => ({
          id: o.id,
          name: o.name,
          logo: logos.get(`org:${o.id}`) ?? null,
          canManage: canOnScope(access, { orgId: o.id }, 'org.manage').allowed,
          canRename: canOnScope(access, { orgId: o.id }, 'scope.rename').allowed,
          canInvite: canOnScope(access, { orgId: o.id }, 'member.invite').allowed,
          canSchedule: canOnScope(access, { orgId: o.id }, 'fixture.schedule').allowed,
          trialEndsAt: trialEnds.get(o.id) ?? null,
          addRegion: decisionOut(canOnScope(access, { orgId: o.id }, 'region.manage')),
          regions: regions.filter((r) => r.org_id === o.id).map(regionOut),
        })),
        regions: standalone.map(regionOut),
        teams: teams.map((t) => ({
          id: t.id,
          name: t.name,
          logo: logos.get(`team:${t.id}`) ?? null,
          orgId: t.org_personal ? null : t.org_id,
          orgName: t.org_personal ? null : t.org_name,
          regionId: t.region_id && !t.region_personal ? t.region_id : null,
          regionName: t.region_id && !t.region_personal ? t.region_name : null,
          canMove: mayMove(t),
          archived: t.archived,
        })),
      },
    };
  } catch (err) {
    ctx.error('hierarchy failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/**
 * Link a team into a region (and so its organization), or take it back out.
 *
 * Only staff of the organization or region can do this (team.create at that
 * scope, which coaches never hold): taking a team out needs it at the team's
 * current organization or region, placing it needs it at the target region.
 */
export async function moveTeamHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    const body = (await req.json()) as { teamId?: string; regionId?: string | null };
    if (!body.teamId) return { status: 400, jsonBody: { error: 'teamId is required' } };

    const access = await buildAccessContext(user);
    const team = await loadTeamContext(body.teamId);
    if (!team) return NOT_FOUND;

    const edit = canOnTeam(access, team, 'team.edit');
    if (!edit.allowed) return denyResponse(edit);

    const source = await queryOne<{ org_personal: boolean; region_personal: boolean | null }>(
      `SELECT o.is_personal AS org_personal, r.is_personal AS region_personal
         FROM team t JOIN organization o ON o.id = t.org_id LEFT JOIN region r ON r.id = t.region_id
        WHERE t.id = $1`,
      [team.teamId],
    );
    // Out of a real organization, or out of a standalone region: only that
    // league's admins and directors may take the team out.
    if (source && (!source.org_personal || source.region_personal === false)) {
      const out = canOnScope(
        access,
        { orgId: team.orgId, regionId: source.region_personal ? null : team.regionId },
        'team.create',
      );
      if (!out.allowed) {
        return {
          status: 403,
          jsonBody: {
            error: 'Only the organization or region admins and directors can move this team.',
            code: 'FORBIDDEN',
          },
        };
      }
    }

    // Custom divisions belong to one region; moving would orphan the link.
    if (team.divisionId) {
      return {
        status: 409,
        jsonBody: {
          error: 'This team uses a custom division from its current region, so it cannot move.',
          code: 'CUSTOM_DIVISION',
        },
      };
    }

    if (body.regionId) {
      const region = await queryOne<{ id: string; org_id: string; is_personal: boolean }>(
        'SELECT id, org_id, is_personal FROM region WHERE id = $1 AND deleted_at IS NULL',
        [body.regionId],
      );
      if (!region || region.is_personal) return NOT_FOUND;

      const target = canOnScope(access, { orgId: region.org_id, regionId: region.id }, 'team.create');
      if (!target.allowed) return denyResponse(target);

      // Joining from another organization is remembered, so a lapsed free
      // trial hands the team back to its coach instead of pausing it.
      await query(
        `UPDATE team SET org_id = $2, region_id = $3,
                joined_league_at = CASE WHEN org_id <> $2 THEN now() ELSE joined_league_at END
          WHERE id = $1`,
        [team.teamId, region.org_id, region.id],
      );
      return { status: 200, jsonBody: { teamId: team.teamId, orgId: region.org_id, regionId: region.id } };
    }

    // Back out of any organization: give the team a fresh hidden personal org
    // and region, exactly as if it had just been created.
    const placed = await transaction(async (client) => {
      const t = await client.query<{ name: string }>('SELECT name FROM team WHERE id = $1', [
        team.teamId,
      ]);
      const org = await client.query<{ id: string }>(
        `INSERT INTO organization (name, is_personal, created_by)
         VALUES ($1, true, $2) RETURNING id`,
        [t.rows[0]?.name ?? 'Team', user.id],
      );
      const reg = await client.query<{ id: string }>(
        `INSERT INTO region (org_id, name, is_personal, created_by)
         VALUES ($1, 'Default', true, $2) RETURNING id`,
        [org.rows[0].id, user.id],
      );
      await client.query('UPDATE team SET org_id = $2, region_id = $3, joined_league_at = NULL WHERE id = $1', [
        team.teamId,
        org.rows[0].id,
        reg.rows[0].id,
      ]);
      return { orgId: null, regionId: null };
    });
    return { status: 200, jsonBody: { teamId: team.teamId, ...placed } };
  } catch (err) {
    ctx.error('move team failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/* ------------------------------------------------------------- members */

const ROLE_LABEL: Record<Role, string> = {
  org_admin: 'Org admin',
  director: 'Director',
  region_admin: 'Region admin',
  scheduler: 'Scheduler',
  coach: 'Coach',
  assistant: 'Assistant coach',
  team_parent: 'Team parent',
  parent: 'Parent',
  player: 'Player',
  viewer: 'Viewer',
  custom: 'Custom role',
};

type InviteScopeKind = 'org' | 'region' | 'division' | 'team';

/**
 * Where each role may be granted. A coach invited at region scope would
 * coach every team in that region, so team roles only attach to a team, and
 * an org admin only ever to an organization.
 */
const ROLE_SCOPES: Record<Role, readonly InviteScopeKind[]> = {
  org_admin: ['org'],
  director: ['org', 'region'],
  region_admin: ['org', 'region'],
  scheduler: ['org', 'region'],
  coach: ['team', 'division'],
  assistant: ['team', 'division'],
  team_parent: ['team'],
  parent: ['team'],
  player: ['team'],
  viewer: ['org', 'region', 'division', 'team'],
  // Given from the custom roles card (customRoles.ts), never through this form.
  custom: [],
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Team roles that may come with a child on the team (required only for parent). */
const CHILD_LINK_ROLES: readonly string[] = ['parent', 'player', 'team_parent', 'coach', 'assistant'];

export function appOrigin(): string {
  const configured = process.env.APP_ORIGIN?.replace(/\/+$/, '');
  if (configured) return configured;
  return process.env.APP_ENV === 'prd' ? 'https://lineup.mahoul.io' : 'https://lineup-dev.mahoul.io';
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

/** Resolve an invite or membership scope to the access decision for `action`. */
async function scopeDecision(
  access: Awaited<ReturnType<typeof buildAccessContext>>,
  kind: InviteScopeKind,
  id: string,
  action: 'member.invite' | 'member.manage',
): Promise<{ decision: Decision; name: string } | null> {
  if (kind === 'team') {
    const team = await loadTeamContext(id);
    if (!team) return null;
    const row = await queryOne<{ name: string }>('SELECT name FROM team WHERE id = $1', [id]);
    return { decision: canOnTeam(access, team, action), name: row?.name ?? 'your team' };
  }
  if (kind === 'division') {
    const d = await queryOne<{ id: string; name: string | null; code: string; region_id: string; org_id: string }>(
      `SELECT d.id, d.name, d.code, d.region_id, r.org_id
         FROM division d JOIN region r ON r.id = d.region_id
        WHERE d.id = $1 AND d.deleted_at IS NULL`,
      [id],
    );
    if (!d) return null;
    return {
      decision: canOnTeam(
        access,
        { teamId: '', orgId: d.org_id, regionId: d.region_id, divisionId: d.id },
        action,
      ),
      name: d.name ?? d.code,
    };
  }
  if (kind === 'region') {
    const r = await queryOne<{ id: string; org_id: string; name: string; is_personal: boolean }>(
      'SELECT id, org_id, name, is_personal FROM region WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    if (!r || r.is_personal) return null;
    return { decision: canOnScope(access, { orgId: r.org_id, regionId: r.id }, action), name: r.name };
  }
  const o = await queryOne<{ id: string; name: string; is_personal: boolean }>(
    'SELECT id, name, is_personal FROM organization WHERE id = $1 AND deleted_at IS NULL',
    [id],
  );
  if (!o || o.is_personal) return null;
  return { decision: canOnScope(access, { orgId: o.id }, action), name: o.name };
}

export function inviteEmail(opts: {
  inviter: string;
  scopeName: string;
  roleLabel: string;
  link: string;
  expires: Date;
}) {
  const until = opts.expires.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const subject = `${opts.inviter} invited you to ${opts.scopeName} on Lineup`;
  const text =
    `${opts.inviter} invited you to join ${opts.scopeName} on Lineup as ${opts.roleLabel}.\n\n` +
    `Accept the invite: ${opts.link}\n\n` +
    `The link works once and expires on ${until}. If you were not expecting this, you can ignore it.`;
  const html =
    `<p>${escapeHtml(opts.inviter)} invited you to join <b>${escapeHtml(opts.scopeName)}</b> ` +
    `on Lineup as <b>${escapeHtml(opts.roleLabel)}</b>.</p>` +
    `<p><a href="${escapeHtml(opts.link)}">Accept the invite</a></p>` +
    `<p style="color:#667">The link works once and expires on ${escapeHtml(until)}. ` +
    `If you were not expecting this, you can ignore it.</p>`;
  return { subject, text, html };
}

export async function membersHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    const access = await buildAccessContext(user);

    if (req.method === 'GET') {
      // Member lists carry email addresses, so they are per team and only for
      // people who can invite on that team.
      const teamId = req.query.get('teamId');
      if (!teamId) return { status: 400, jsonBody: { error: 'teamId is required' } };
      const team = await loadTeamContext(teamId);
      if (!team) return NOT_FOUND;
      const d = canOnTeam(access, team, 'member.invite');
      if (!d.allowed) return denyResponse(d);

      const rows = await query(
        `SELECT m.id, m.role, m.user_id AS "userId", u.email, u.display_name AS "displayName",
                m.team_id AS "teamId", m.region_id AS "regionId", m.org_id AS "orgId"
           FROM membership m
           JOIN app_user u ON u.id = m.user_id
          WHERE m.team_id = $1 AND u.deleted_at IS NULL
          ORDER BY u.display_name`,
        [teamId],
      );
      return { status: 200, jsonBody: rows };
    }

    if (req.method === 'DELETE') {
      const id = req.query.get('id');
      if (!id) return { status: 400, jsonBody: { error: 'id is required' } };

      const target = await queryOne<{
        user_id: string;
        role: Role;
        org_id: string | null;
        region_id: string | null;
        division_id: string | null;
        team_id: string | null;
      }>(
        'SELECT user_id, role, org_id, region_id, division_id, team_id FROM membership WHERE id = $1',
        [id],
      );
      if (!target) return NOT_FOUND;

      // Anyone may leave; removing someone else needs authority at that scope.
      if (target.user_id !== user.id) {
        const kind: InviteScopeKind = target.team_id
          ? 'team'
          : target.division_id
            ? 'division'
            : target.region_id
              ? 'region'
              : 'org';
        const scopeId = (target.team_id ?? target.division_id ?? target.region_id ?? target.org_id)!;
        const manage = await scopeDecision(access, kind, scopeId, 'member.manage');
        if (!manage) return NOT_FOUND;
        let allowed = manage.decision.allowed;
        // A coach may remove the people below them on their own team.
        if (!allowed && kind === 'team') {
          const invite = await scopeDecision(access, 'team', scopeId, 'member.invite');
          const by = invite?.decision.matchedRole;
          allowed = Boolean(
            invite?.decision.allowed && by && ROLE_RANK[target.role] < ROLE_RANK[by],
          );
        }
        if (!allowed) return denyResponse(manage.decision);
      }

      // Never remove the last director or admin at the organization level: it
      // would leave nobody able to run it.
      if ((target.role === 'org_admin' || target.role === 'director') && target.org_id) {
        const count = await queryOne<{ n: string }>(
          `SELECT COUNT(*) AS n FROM membership
            WHERE org_id = $1 AND role IN ('org_admin', 'director')`,
          [target.org_id],
        );
        if (Number(count?.n ?? 0) <= 1) {
          return {
            status: 409,
            jsonBody: { error: 'An organization must keep at least one director or admin.' },
          };
        }
      }
      await query('DELETE FROM membership WHERE id = $1', [id]);
      return { status: 204 };
    }

    // POST — invite someone.
    const body = (await req.json()) as {
      email?: string;
      name?: string;
      role?: Role;
      teamId?: string;
      regionId?: string;
      divisionId?: string;
      orgId?: string;
      playerId?: string;
    };
    const email = clip(body.email, 200).toLowerCase();
    if (!email || !EMAIL_RE.test(email) || !body.role) {
      return { status: 400, jsonBody: { error: 'A valid email and a role are required.' } };
    }
    if (!(body.role in ROLE_RANK)) {
      return { status: 400, jsonBody: { error: `Unknown role '${body.role}'.` } };
    }
    // Players do not get accounts of their own; their parents do.
    if (body.role === 'player') {
      return {
        status: 400,
        jsonBody: { error: 'Players do not get their own accounts. Invite a parent instead.', code: 'ROLE_RETIRED' },
      };
    }
    // A parent always belongs to a child on the team, or they would see nothing.
    if (body.role === 'parent' && !body.playerId) {
      return {
        status: 400,
        jsonBody: { error: 'Pick the child this parent belongs to.', code: 'PLAYER_REQUIRED' },
      };
    }

    const scopes = (
      [
        ['org', body.orgId],
        ['region', body.regionId],
        ['division', body.divisionId],
        ['team', body.teamId],
      ] as Array<[InviteScopeKind, string | undefined]>
    ).filter(([, v]) => Boolean(v));
    if (scopes.length !== 1) {
      return {
        status: 400,
        jsonBody: { error: 'Choose exactly one organization, region, division or team.' },
      };
    }
    const [kind, scopeId] = scopes[0] as [InviteScopeKind, string];

    if (!ROLE_SCOPES[body.role].includes(kind)) {
      return {
        status: 400,
        jsonBody: {
          error: `${ROLE_LABEL[body.role]} can only be invited to: ${ROLE_SCOPES[body.role].join(', ')}.`,
          code: 'ROLE_SCOPE_INVALID',
        },
      };
    }

    // The inviter needs invite rights at THIS scope, and their role there
    // caps what they may hand out.
    const scope = await scopeDecision(access, kind, scopeId, 'member.invite');
    if (!scope) return NOT_FOUND;
    if (!scope.decision.allowed) return denyResponse(scope.decision);

    const assignable = assignableRoles(access, scope.decision.matchedRole ?? 'viewer');
    if (!assignable.includes(body.role)) {
      return {
        status: 403,
        jsonBody: {
          error: `You cannot assign the ${ROLE_LABEL[body.role]} role here.`,
          code: 'ROLE_NOT_ASSIGNABLE',
          details: { assignable },
        },
      };
    }

    if (body.playerId) {
      // The guardian link must point at a child on the invited team. Any team
      // role may have a child on the team (a coach or assistant coach who is
      // also a parent); only a parent must have one.
      const owned = await queryOne<{ id: string }>(
        'SELECT id FROM player WHERE id = $1 AND team_id = $2',
        [body.playerId, kind === 'team' ? scopeId : null],
      );
      if (!owned || !CHILD_LINK_ROLES.includes(body.role)) {
        return { status: 400, jsonBody: { error: 'That player is not on this team.' } };
      }
    }

    const token = randomBytes(24).toString('base64url');
    const row = await queryOne<{ id: string; email: string; role: Role; token: string; expiresAt: Date }>(
      `INSERT INTO invite (email, role, org_id, region_id, division_id, team_id,
                           player_id, token, invited_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, email, role, token, expires_at AS "expiresAt"`,
      [
        email, body.role,
        kind === 'org' ? scopeId : null, kind === 'region' ? scopeId : null,
        kind === 'division' ? scopeId : null, kind === 'team' ? scopeId : null,
        body.playerId ?? null, token, user.id,
      ],
    );
    if (!row) return { status: 500, jsonBody: { error: 'Internal error' } };

    const link = `${appOrigin()}/invite/${row.token}`;
    const inviter = await queryOne<{ display_name: string | null }>(
      'SELECT display_name FROM app_user WHERE id = $1',
      [user.id],
    );
    const message = inviteEmail({
      inviter: inviter?.display_name || 'A coach',
      scopeName: scope.name,
      roleLabel: ROLE_LABEL[body.role],
      link,
      expires: new Date(row.expiresAt),
    });
    const sent = await sendEmail({ to: email, toName: clip(body.name, 80) || undefined, ...message });
    if (!sent.sent && sent.reason !== 'not-configured') {
      ctx.warn('invite email failed', { inviteId: row.id, reason: sent.reason });
    }

    return {
      status: 201,
      jsonBody: {
        ...row,
        link,
        scopeName: scope.name,
        emailed: sent.sent,
        emailStatus: sent.sent ? 'sent' : sent.reason === 'not-configured' ? 'not-configured' : 'failed',
        shareText: message.text,
      },
    };
  } catch (err) {
    ctx.error('members failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/**
 * What an invite link is for, shown before sign-in. Anonymous by design, the
 * token is the key, so this reveals only the team or org name, the role, who
 * sent it and a masked address. No ids.
 */
export async function invitePreviewHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' };
  try {
    const token = req.query.get('token') ?? '';
    const gone = { status: 404, headers, jsonBody: { error: 'This invite link is not valid.' } };
    if (token.length < 16) return gone;

    const row = await queryOne<{
      email: string;
      role: Role;
      expires_at: Date;
      accepted_at: Date | null;
      revoked_at: Date | null;
      scope_name: string | null;
      scope_kind: InviteScopeKind;
      inviter: string | null;
      custom_role_name: string | null;
    }>(
      `SELECT i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at,
              COALESCE(t.name, d.name, d.code, r.name, o.name) AS scope_name,
              CASE WHEN i.team_id IS NOT NULL THEN 'team'
                   WHEN i.division_id IS NOT NULL THEN 'division'
                   WHEN i.region_id IS NOT NULL THEN 'region'
                   ELSE 'org' END AS scope_kind,
              u.display_name AS inviter,
              cr.name AS custom_role_name
         FROM invite i
         LEFT JOIN team t ON t.id = i.team_id
         LEFT JOIN division d ON d.id = i.division_id
         LEFT JOIN region r ON r.id = i.region_id
         LEFT JOIN organization o ON o.id = i.org_id
         LEFT JOIN app_user u ON u.id = i.invited_by
         LEFT JOIN custom_role cr ON cr.id = i.custom_role_id
        WHERE i.token = $1`,
      [token],
    );
    if (!row) return gone;

    const status = row.revoked_at
      ? 'revoked'
      : row.accepted_at
        ? 'accepted'
        : row.expires_at.getTime() < Date.now()
          ? 'expired'
          : 'valid';

    return {
      status: 200,
      headers,
      jsonBody: {
        status,
        role: row.role,
        roleLabel: row.custom_role_name ?? ROLE_LABEL[row.role] ?? row.role,
        scopeKind: row.scope_kind,
        scopeName: row.scope_name ?? 'a team',
        inviter: row.inviter ?? 'A coach',
        emailHint: maskEmail(row.email),
        expiresAt: row.expires_at.toISOString(),
      },
    };
  } catch (err) {
    ctx.error('invite preview failed', err);
    return { status: 500, headers, jsonBody: { error: 'Internal error' } };
  }
}

/** Accept an invite. The token is the authorisation. */
export async function acceptInviteHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    const body = (await req.json()) as { token?: string };
    if (!body.token) return { status: 400, jsonBody: { error: 'token is required' } };

    const result = await transaction(async (client) => {
      const inv = await client.query(
        `SELECT * FROM invite
          WHERE token = $1 AND accepted_at IS NULL AND revoked_at IS NULL
            AND expires_at > now()`,
        [body.token],
      );
      if (inv.rowCount === 0) return null;
      const i = inv.rows[0];

      // An invite link is often opened by the coach who sent it, while still
      // signed in as themselves. Accepting it then would burn the invite on the
      // wrong account, so refuse and leave it usable for the invited person.
      if (i.invited_by === user.id) return { blocked: 'own-invite' as const };
      // A custom role invite (customRoles.ts) adds the person to the role,
      // not to a membership at the organization or region.
      if (i.custom_role_id) {
        const role = await client.query(
          'SELECT 1 FROM custom_role WHERE id = $1 AND deleted_at IS NULL',
          [i.custom_role_id],
        );
        if (role.rowCount === 0) return null;
        const added = await client.query(
          `INSERT INTO custom_role_member (custom_role_id, user_id, added_by)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [i.custom_role_id, user.id, i.invited_by],
        );
        if (added.rowCount === 0) return { blocked: 'already-member' as const };
        await client.query(
          'UPDATE invite SET accepted_at = now(), accepted_by = $2 WHERE id = $1',
          [i.id, user.id],
        );
        return { role: i.role, teamId: null, regionId: i.region_id, orgId: i.org_id };
      }

      const already = await client.query(
        `SELECT 1 FROM membership
          WHERE user_id = $1
            AND org_id IS NOT DISTINCT FROM $2 AND region_id IS NOT DISTINCT FROM $3
            AND division_id IS NOT DISTINCT FROM $4 AND team_id IS NOT DISTINCT FROM $5`,
        [user.id, i.org_id, i.region_id, i.division_id, i.team_id],
      );
      // The other parent's invite still links the children when they are
      // already on the team (for a sibling, say).
      if (already.rowCount && !i.co_parent_of) return { blocked: 'already-member' as const };

      await client.query(
        `INSERT INTO membership (user_id, role, org_id, region_id, division_id, team_id)
         SELECT $1,$2,$3,$4,$5,$6
          WHERE NOT EXISTS (SELECT 1 FROM membership WHERE user_id = $1
                              AND org_id IS NOT DISTINCT FROM $3 AND region_id IS NOT DISTINCT FROM $4
                              AND division_id IS NOT DISTINCT FROM $5 AND team_id IS NOT DISTINCT FROM $6)
         ON CONFLICT DO NOTHING`,
        [user.id, i.role, i.org_id, i.region_id, i.division_id, i.team_id],
      );

      // Parent and player invites also create the guardian link, without
      // which those roles resolve to no visible players at all. Coaches,
      // assistant coaches and team parents are often parents too, so a child
      // picked on their invite is linked the same way.
      if (i.player_id && CHILD_LINK_ROLES.includes(i.role)) {
        await client.query(
          `INSERT INTO player_guardian (player_id, user_id, relation, label, consented_at, consented_by)
           VALUES ($1,$2,$3,$5, now(), $4) ON CONFLICT DO NOTHING`,
          [i.player_id, user.id, i.role === 'player' ? 'self' : 'parent', i.invited_by, i.guardian_label ?? null],
        );
      }
      // The other parent (Fady, 10/19): the same children as the parent who invited them.
      if (i.co_parent_of) {
        await linkCoParentChildren(client, i.co_parent_of, user.id, i.guardian_label ?? null);
      }

      await client.query(
        'UPDATE invite SET accepted_at = now(), accepted_by = $2 WHERE id = $1',
        [i.id, user.id],
      );
      return { role: i.role, teamId: i.team_id, regionId: i.region_id, orgId: i.org_id };
    });

    if (!result) {
      return { status: 404, jsonBody: { error: 'Invite is invalid or has expired.' } };
    }
    if ('blocked' in result) {
      const error =
        result.blocked === 'own-invite'
          ? 'You sent this invite, so it cannot be accepted by your account. Sign out, then open the link signed in as the person you invited.'
          : 'This account is already a member there. The invite is for someone else: sign out, then open the link signed in as the person who was invited.';
      return { status: 409, jsonBody: { error, code: result.blocked } };
    }
    return { status: 200, jsonBody: result };
  } catch (err) {
    ctx.error('accept invite failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('catalog', {
  methods: ['GET'], authLevel: 'anonymous', route: 'divisions/catalog',
  handler: catalogHandler,
});
app.http('divisions', {
  methods: ['GET', 'POST'], authLevel: 'anonymous', route: 'divisions',
  handler: divisionsHandler,
});
app.http('orgs', {
  methods: ['GET', 'POST', 'PATCH'], authLevel: 'anonymous', route: 'orgs',
  handler: orgsHandler,
});
app.http('regions', {
  methods: ['GET', 'POST', 'PATCH'], authLevel: 'anonymous', route: 'regions',
  handler: regionsHandler,
});
app.http('hierarchy', {
  methods: ['GET'], authLevel: 'anonymous', route: 'hierarchy',
  handler: hierarchyHandler,
});
app.http('hierarchyMoveTeam', {
  methods: ['POST'], authLevel: 'anonymous', route: 'hierarchy/move-team',
  handler: moveTeamHandler,
});
app.http('members', {
  methods: ['GET', 'POST', 'DELETE'], authLevel: 'anonymous', route: 'members',
  handler: membersHandler,
});
app.http('acceptInvite', {
  methods: ['POST'], authLevel: 'anonymous', route: 'invites/accept',
  handler: acceptInviteHandler,
});
app.http('invitePreview', {
  methods: ['GET'], authLevel: 'anonymous', route: 'invites/preview',
  handler: invitePreviewHandler,
});

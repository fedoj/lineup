import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import {
  CUSTOM_PERMISSIONS,
  canOnScope,
  cleanCustomRole,
  type AccessContext,
} from '@lineup/shared';
import { randomBytes } from 'node:crypto';
import { requireUser } from '../lib/auth.js';
import { buildAccessContext } from '../lib/authz.js';
import { query, queryOne } from '../lib/db.js';
import { sendEmail } from '../lib/email.js';
import { appOrigin, inviteEmail } from './hierarchy.js';

/**
 * Custom roles (Shadi, 10/21). At an organization or region, its staff (who
 * can invite people there) make roles that cover chosen age groups and/or
 * single teams and carry chosen permissions, and give them to people by
 * email. Someone not on Lineup yet gets an invite that adds them on accept.
 * Nobody can hand out a permission they do not hold there themselves.
 *
 * GET  ?scope=org|region&id=   roles, their people, the teams and age groups
 * POST { scope, id, action: 'create' | 'update' | 'delete' | 'assign' | 'unassign', ... }
 */

const FORBIDDEN: HttpResponseInit = {
  status: 403,
  jsonBody: { error: 'You do not have access to this.', code: 'FORBIDDEN' },
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ROLES = 50;
const MAX_PEOPLE = 200;

export interface Place {
  scope: 'org' | 'region';
  id: string;
  name: string;
  orgId: string;
  regionId: string | null;
}

export async function loadPlace(scope: unknown, id: unknown): Promise<Place | null> {
  if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
  if (scope === 'org') {
    const o = await queryOne<{ id: string; name: string }>(
      'SELECT id, name FROM organization WHERE id = $1 AND deleted_at IS NULL AND NOT is_personal',
      [id],
    );
    return o ? { scope, id: o.id, name: o.name, orgId: o.id, regionId: null } : null;
  }
  if (scope === 'region') {
    const r = await queryOne<{ id: string; name: string; org_id: string }>(
      'SELECT id, name, org_id FROM region WHERE id = $1 AND deleted_at IS NULL AND NOT is_personal',
      [id],
    );
    return r ? { scope, id: r.id, name: r.name, orgId: r.org_id, regionId: r.id } : null;
  }
  return null;
}

/** Staff who can invite people at this organization or region manage its custom roles. */
export function mayManage(access: AccessContext, place: Place): boolean {
  return canOnScope(access, { orgId: place.orgId, regionId: place.regionId }, 'member.invite').allowed;
}

/** Permissions the caller cannot hand out, because they do not hold them here. */
function beyondCaller(access: AccessContext, place: Place, permissions: readonly string[]): string[] {
  const scope = { orgId: place.orgId, regionId: place.regionId };
  return CUSTOM_PERMISSIONS.filter(
    (p) => !p.fixed && permissions.includes(p.key) && p.actions.some((a) => !canOnScope(access, scope, a).allowed),
  ).map((p) => p.label);
}

const ROLE_WHERE = (place: Place) =>
  place.scope === 'org' ? 'cr.org_id = $1 AND cr.region_id IS NULL' : 'cr.region_id = $1';

export async function teamsIn(place: Place) {
  return query<{ id: string; name: string; code: string | null; region_name: string | null }>(
    `SELECT t.id, t.name, COALESCE(t.catalog_division_id, d.code) AS code, r.name AS region_name
       FROM team t
       LEFT JOIN division d ON d.id = t.division_id
       LEFT JOIN region r ON r.id = t.region_id AND NOT r.is_personal
      WHERE ${place.scope === 'org' ? 't.org_id = $1' : 't.region_id = $1'}
        AND t.deleted_at IS NULL
      ORDER BY code NULLS LAST, t.name`,
    [place.id],
  );
}

async function payload(place: Place) {
  const [roles, teams] = await Promise.all([
    query<{
      id: string;
      name: string;
      permissions: string[];
      divisions: string[];
      team_ids: string[];
    }>(
      `SELECT cr.id, cr.name, cr.permissions, cr.divisions, cr.team_ids
         FROM custom_role cr
        WHERE ${ROLE_WHERE(place)} AND cr.deleted_at IS NULL
        ORDER BY lower(cr.name)`,
      [place.id],
    ),
    teamsIn(place),
  ]);
  const ids = roles.map((r) => r.id);
  const [people, pending] = ids.length
    ? await Promise.all([
        query<{ custom_role_id: string; user_id: string; name: string | null; email: string | null }>(
          `SELECT cm.custom_role_id, u.id AS user_id, u.display_name AS name, u.email
             FROM custom_role_member cm JOIN app_user u ON u.id = cm.user_id
            WHERE cm.custom_role_id = ANY($1::uuid[])
            ORDER BY lower(COALESCE(u.display_name, u.email))`,
          [ids],
        ),
        query<{ id: string; custom_role_id: string; email: string }>(
          `SELECT id, custom_role_id, email FROM invite
            WHERE custom_role_id = ANY($1::uuid[])
              AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
            ORDER BY created_at`,
          [ids],
        ),
      ])
    : [[], []];

  const codeOf = new Map(teams.map((t) => [t.id, t.code]));
  return {
    scope: place.scope,
    id: place.id,
    name: place.name,
    permissions: CUSTOM_PERMISSIONS.map((p) => ({ key: p.key, label: p.label, hint: p.hint, fixed: Boolean(p.fixed) })),
    ageGroups: [...new Set(teams.map((t) => t.code).filter((c): c is string => Boolean(c)))].sort(),
    teams: teams.map((t) => ({ id: t.id, name: t.name, ageGroup: t.code, regionName: t.region_name })),
    roles: roles.map((r) => ({
      id: r.id,
      name: r.name,
      permissions: r.permissions,
      divisions: r.divisions,
      teamIds: r.team_ids,
      // Teams covered today: its age groups plus its single teams.
      teamCount: teams.filter((t) => r.team_ids.includes(t.id) || (codeOf.get(t.id) && r.divisions.includes(codeOf.get(t.id) as string))).length,
      people: people
        .filter((p) => p.custom_role_id === r.id)
        .map((p) => ({ userId: p.user_id, name: p.name || p.email || 'Someone', email: p.email })),
      invited: pending.filter((p) => p.custom_role_id === r.id).map((p) => ({ inviteId: p.id, email: p.email })),
    })),
  };
}

async function roleIn(place: Place, roleId: unknown) {
  if (typeof roleId !== 'string' || !UUID_RE.test(roleId)) return null;
  return queryOne<{ id: string; name: string }>(
    `SELECT cr.id, cr.name FROM custom_role cr
      WHERE cr.id = $2 AND ${ROLE_WHERE(place)} AND cr.deleted_at IS NULL`,
    [place.id, roleId],
  );
}

export async function customRolesHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    const access = await buildAccessContext(user);

    if (req.method === 'GET') {
      const place = await loadPlace(req.query.get('scope'), req.query.get('id'));
      if (!place || !mayManage(access, place)) return FORBIDDEN;
      return { status: 200, headers: { 'Cache-Control': 'no-store' }, jsonBody: await payload(place) };
    }

    const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    const place = await loadPlace(body.scope, body.id);
    if (!place || !mayManage(access, place)) return FORBIDDEN;
    const done = async (extra: Record<string, unknown> = {}) => ({
      status: 200,
      jsonBody: { ...(await payload(place)), ...extra },
    });

    if (body.action === 'create' || body.action === 'update') {
      const clean = cleanCustomRole(body);
      if ('error' in clean) return { status: 400, jsonBody: { error: clean.error } };
      const beyond = beyondCaller(access, place, clean.permissions);
      if (beyond.length) {
        return { status: 403, jsonBody: { error: `You cannot give what you do not have here: ${beyond.join(', ')}.` } };
      }
      // Single teams must be in this organization or region.
      const inScope = new Set((await teamsIn(place)).map((t) => t.id));
      const teamIds = clean.teamIds.filter((t) => inScope.has(t));
      if (!clean.divisions.length && !teamIds.length) {
        return { status: 400, jsonBody: { error: 'Pick at least one age group or team for this role.' } };
      }
      if (body.action === 'create') {
        const count = await queryOne<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM custom_role cr WHERE ${ROLE_WHERE(place)} AND cr.deleted_at IS NULL`,
          [place.id],
        );
        if ((count?.n ?? 0) >= MAX_ROLES) return { status: 400, jsonBody: { error: `Up to ${MAX_ROLES} custom roles here.` } };
        const row = await queryOne<{ id: string }>(
          `INSERT INTO custom_role (org_id, region_id, name, permissions, divisions, team_ids, created_by)
           VALUES ($1,$2,$3,$4,$5,$6::uuid[],$7) RETURNING id`,
          [place.orgId, place.regionId, clean.name, clean.permissions, clean.divisions, teamIds, user.id],
        );
        return done({ createdId: row?.id ?? null });
      }
      const role = await roleIn(place, body.roleId);
      if (!role) return { status: 404, jsonBody: { error: 'That role is gone.' } };
      await query(
        `UPDATE custom_role SET name = $2, permissions = $3, divisions = $4, team_ids = $5::uuid[], updated_at = now()
          WHERE id = $1`,
        [role.id, clean.name, clean.permissions, clean.divisions, teamIds],
      );
      return done();
    }

    if (body.action === 'delete') {
      const role = await roleIn(place, body.roleId);
      if (!role) return { status: 404, jsonBody: { error: 'That role is gone.' } };
      // Its people and any pending invites go with it.
      await query('DELETE FROM custom_role WHERE id = $1', [role.id]);
      return done();
    }

    if (body.action === 'assign') {
      const role = await roleIn(place, body.roleId);
      if (!role) return { status: 404, jsonBody: { error: 'That role is gone.' } };
      const email = String(body.email ?? '').trim().toLowerCase().slice(0, 254);
      if (!EMAIL_RE.test(email)) return { status: 400, jsonBody: { error: 'Enter a valid email address.' } };
      const size = await queryOne<{ n: number }>(
        'SELECT COUNT(*)::int AS n FROM custom_role_member WHERE custom_role_id = $1',
        [role.id],
      );
      if ((size?.n ?? 0) >= MAX_PEOPLE) return { status: 400, jsonBody: { error: `Up to ${MAX_PEOPLE} people per role.` } };

      const existing = await queryOne<{ id: string }>(
        'SELECT id FROM app_user WHERE lower(email) = $1 AND deleted_at IS NULL LIMIT 1',
        [email],
      );
      const inviter =
        (await queryOne<{ display_name: string | null }>('SELECT display_name FROM app_user WHERE id = $1', [user.id]))
          ?.display_name || 'Your league';

      if (existing) {
        const added = await query<{ user_id: string }>(
          `INSERT INTO custom_role_member (custom_role_id, user_id, added_by) VALUES ($1,$2,$3)
           ON CONFLICT DO NOTHING RETURNING user_id`,
          [role.id, existing.id, user.id],
        );
        if (added.length && existing.id !== user.id) {
          await query(
            `INSERT INTO notification (user_id, kind, title, body, link, from_name)
             VALUES ($1, 'message', $2, $3, '/', $4)`,
            [
              existing.id,
              `You are now ${role.name} at ${place.name}`,
              'Your teams for this role are in the menu.',
              inviter,
            ],
          );
        }
        return done({ result: added.length ? 'added' : 'already' });
      }

      const already = await queryOne<{ id: string }>(
        `SELECT id FROM invite WHERE custom_role_id = $1 AND lower(email) = $2
            AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
        [role.id, email],
      );
      if (already) return done({ result: 'already-invited' });
      const token = randomBytes(24).toString('base64url');
      const inv = await queryOne<{ id: string; expires_at: Date }>(
        `INSERT INTO invite (email, role, org_id, region_id, token, invited_by, custom_role_id)
         VALUES ($1, 'custom', $2, $3, $4, $5, $6) RETURNING id, expires_at`,
        [email, place.regionId ? null : place.orgId, place.regionId, token, user.id, role.id],
      );
      if (!inv) return { status: 500, jsonBody: { error: 'Internal error' } };
      const link = `${appOrigin()}/invite/${token}`;
      const message = inviteEmail({
        inviter,
        scopeName: place.name,
        roleLabel: role.name,
        link,
        expires: new Date(inv.expires_at),
      });
      const sent = await sendEmail({ to: email, ...message });
      if (!sent.sent && sent.reason !== 'not-configured') {
        ctx.warn('custom role invite email failed', { inviteId: inv.id, reason: sent.reason });
      }
      return done({ result: 'invited', emailed: sent.sent, link });
    }

    if (body.action === 'unassign') {
      const role = await roleIn(place, body.roleId);
      if (!role) return { status: 404, jsonBody: { error: 'That role is gone.' } };
      if (typeof body.inviteId === 'string' && UUID_RE.test(body.inviteId)) {
        await query(
          'UPDATE invite SET revoked_at = now() WHERE id = $1 AND custom_role_id = $2 AND accepted_at IS NULL',
          [body.inviteId, role.id],
        );
      } else if (typeof body.userId === 'string' && UUID_RE.test(body.userId)) {
        await query('DELETE FROM custom_role_member WHERE custom_role_id = $1 AND user_id = $2', [role.id, body.userId]);
      } else {
        return { status: 400, jsonBody: { error: 'Who should be removed?' } };
      }
      return done();
    }

    return { status: 400, jsonBody: { error: 'Unknown action' } };
  } catch (err) {
    ctx.error('custom roles failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('customRoles', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'custom-roles',
  handler: customRolesHandler,
});

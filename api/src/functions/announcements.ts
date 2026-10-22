import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { canOnScope, type AccessContext } from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { buildAccessContext } from '../lib/authz.js';
import { query, queryOne, transaction } from '../lib/db.js';

/**
 * Announcements (Shadi, 10/21). Organization and region staff (admins and
 * directors, who can invite there) post a message, links allowed, to:
 * - who: everyone, chosen roles, or referees only (referees belong to the
 *   organization, not to a region or team);
 * - where: the whole organization or region, chosen regions (organization
 *   posts), or chosen teams.
 * Who it went to is saved when it is posted, and each of them gets a
 * notification in the bell, pushed to their devices. GET lists the caller's
 * announcements (and where they may post); POST { action: 'post' | 'delete' }.
 */

const FORBIDDEN: HttpResponseInit = { status: 403, jsonBody: { error: 'You do not have access to this.', code: 'FORBIDDEN' } };

/** Roles that can be picked as an audience; 'staff' is the organization's and regions' admins, directors and schedulers. */
export const ANNOUNCE_ROLES = ['coach', 'assistant', 'team_parent', 'parent', 'staff'] as const;
type AnnounceRole = (typeof ANNOUNCE_ROLES)[number];
const TEAM_ROLES = ['coach', 'assistant', 'team_parent', 'parent', 'player', 'viewer'];
const STAFF_ROLES = ['org_admin', 'director', 'region_admin', 'scheduler'];

const UUID_RE = /^[0-9a-f-]{36}$/i;

function clip(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function ids(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const list = [...new Set(value.map((v) => String(v)).filter((v) => UUID_RE.test(v)))].slice(0, 200);
  return list.length ? list : null;
}

/** Where the caller may post: organizations (all regions) and regions. */
async function postScopes(access: AccessContext, userId: string) {
  const [orgs, regions] = await Promise.all([
    query<{ id: string; name: string; is_personal: boolean }>(
      `SELECT DISTINCT o.id, o.name, o.is_personal
         FROM organization o
        WHERE o.deleted_at IS NULL
          AND (o.id IN (SELECT org_id FROM membership WHERE user_id = $1 AND org_id IS NOT NULL)
               OR o.id IN (SELECT r.org_id FROM membership m JOIN region r ON r.id = m.region_id WHERE m.user_id = $1))
        ORDER BY o.name`,
      [userId],
    ),
    query<{ id: string; name: string; org_id: string; org_personal: boolean }>(
      `SELECT r.id, r.name, r.org_id, o.is_personal AS org_personal
         FROM region r JOIN organization o ON o.id = r.org_id
        WHERE r.deleted_at IS NULL AND NOT r.is_personal
          AND (r.id IN (SELECT region_id FROM membership WHERE user_id = $1 AND region_id IS NOT NULL)
               OR r.org_id IN (SELECT org_id FROM membership WHERE user_id = $1 AND org_id IS NOT NULL))
        ORDER BY r.name`,
      [userId],
    ),
  ]);
  const out: Array<{ scope: 'org' | 'region'; id: string; orgId: string; label: string }> = [];
  for (const o of orgs) {
    if (!o.is_personal && canOnScope(access, { orgId: o.id }, 'member.invite').allowed) {
      out.push({ scope: 'org', id: o.id, orgId: o.id, label: `${o.name} (all regions)` });
    }
  }
  for (const r of regions) {
    if (canOnScope(access, { orgId: r.org_id, regionId: r.id }, 'member.invite').allowed) {
      const org = orgs.find((o) => o.id === r.org_id);
      out.push({ scope: 'region', id: r.id, orgId: r.org_id, label: r.org_personal || !org ? r.name : `${r.name} · ${org.name}` });
    }
  }
  return out;
}

/** The people an announcement goes to. */
async function recipientsFor(a: {
  orgId: string;
  regionId: string | null;
  audience: 'everyone' | 'roles' | 'referees';
  roles: AnnounceRole[] | null;
  regionIds: string[] | null;
  teamIds: string[] | null;
}): Promise<string[]> {
  if (a.audience === 'referees') {
    const rows = await query<{ user_id: string }>('SELECT DISTINCT user_id FROM referee WHERE org_id = $1', [a.orgId]);
    return rows.map((r) => r.user_id);
  }
  const roles = a.audience === 'roles' ? a.roles ?? [] : null;
  const teamRoles = roles ? roles.filter((r) => r !== 'staff') : TEAM_ROLES;
  const withStaff = !roles || roles.includes('staff');
  const rows = await query<{ user_id: string }>(
    `SELECT m.user_id FROM membership m
       JOIN team t ON t.id = m.team_id AND t.deleted_at IS NULL AND t.archived_at IS NULL
      WHERE t.org_id = $1
        AND ($2::uuid IS NULL OR t.region_id = $2)
        AND ($3::uuid[] IS NULL OR t.region_id = ANY($3::uuid[]))
        AND ($4::uuid[] IS NULL OR t.id = ANY($4::uuid[]))
        AND m.role = ANY($5::text[])
     UNION
     SELECT m.user_id FROM membership m
      WHERE $6::boolean AND m.role = ANY($7::text[])
        AND $4::uuid[] IS NULL
        AND ((m.org_id = $1 AND $2::uuid IS NULL)
             OR m.region_id IN (SELECT r.id FROM region r
                                 WHERE r.org_id = $1 AND r.deleted_at IS NULL
                                   AND ($2::uuid IS NULL OR r.id = $2)
                                   AND ($3::uuid[] IS NULL OR r.id = ANY($3::uuid[]))))`,
    [a.orgId, a.regionId, a.regionIds, a.teamIds, teamRoles, withStaff, STAFF_ROLES],
  );
  return [...new Set(rows.map((r) => r.user_id))];
}

export async function announcementsHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    const access = await buildAccessContext(user);

    if (req.method === 'GET') {
      const scopes = await postScopes(access, user.id);
      const scopeOrgs = [...new Set(scopes.map((s) => s.orgId))];
      const [rows, regions, teams] = await Promise.all([
        query<{
          id: string; org_id: string; region_id: string | null; title: string; body: string; audience: string;
          roles: string[] | null; region_ids: string[] | null; team_ids: string[] | null; recipients: number;
          created_at: Date; author_id: string | null; author: string | null; org_name: string; region_name: string | null;
          received: boolean;
        }>(
          `SELECT a.id, a.org_id, a.region_id, a.title, a.body, a.audience, a.roles, a.region_ids, a.team_ids, a.recipients,
                  a.created_at, a.author_id, u.display_name AS author, o.name AS org_name, r.name AS region_name,
                  EXISTS (SELECT 1 FROM announcement_recipient ar WHERE ar.announcement_id = a.id AND ar.user_id = $1) AS received
             FROM announcement a
             JOIN organization o ON o.id = a.org_id
             LEFT JOIN region r ON r.id = a.region_id
             LEFT JOIN app_user u ON u.id = a.author_id
            WHERE a.deleted_at IS NULL AND a.created_at > now() - interval '90 days'
              AND (a.author_id = $1
                   OR EXISTS (SELECT 1 FROM announcement_recipient ar WHERE ar.announcement_id = a.id AND ar.user_id = $1)
                   OR a.org_id = ANY($2::uuid[]))
            ORDER BY a.created_at DESC
            LIMIT 100`,
          [user.id, scopeOrgs],
        ),
        scopeOrgs.length
          ? query<{ id: string; name: string; org_id: string }>(
              'SELECT id, name, org_id FROM region WHERE org_id = ANY($1::uuid[]) AND deleted_at IS NULL AND NOT is_personal ORDER BY name',
              [scopeOrgs],
            )
          : Promise.resolve([]),
        scopeOrgs.length
          ? query<{ id: string; name: string; org_id: string; region_id: string | null }>(
              `SELECT id, name, org_id, region_id FROM team
                WHERE org_id = ANY($1::uuid[]) AND deleted_at IS NULL AND archived_at IS NULL ORDER BY name`,
              [scopeOrgs],
            )
          : Promise.resolve([]),
      ]);
      // Staff see everything posted in their organization or region; others only what was sent to them.
      const canManage = (r: (typeof rows)[number]) =>
        r.author_id === user.id ||
        canOnScope(access, r.region_id ? { orgId: r.org_id, regionId: r.region_id } : { orgId: r.org_id }, 'member.invite').allowed;
      const regionName = new Map(regions.map((r) => [r.id, r.name]));
      const teamName = new Map(teams.map((t) => [t.id, t.name]));
      return {
        status: 200,
        jsonBody: {
          canPost: scopes.length > 0,
          scopes: scopes.map((s) => ({
            ...s,
            regions: s.scope === 'org' ? regions.filter((r) => r.org_id === s.orgId).map((r) => ({ id: r.id, name: r.name })) : [],
            teams: teams
              .filter((t) => t.org_id === s.orgId && (s.scope === 'org' || t.region_id === s.id))
              .map((t) => ({ id: t.id, name: t.name, regionName: t.region_id ? regionName.get(t.region_id) ?? null : null })),
          })),
          announcements: rows
            .filter((r) => r.received || canManage(r))
            .map((r) => {
              const mine = canManage(r);
              return {
                id: r.id,
                title: r.title,
                body: r.body,
                from: r.region_name ?? r.org_name,
                author: r.author,
                createdAt: r.created_at.toISOString(),
                // What staff see about who it went to.
                audience: mine
                  ? {
                      who: r.audience,
                      roles: r.roles ?? [],
                      regions: (r.region_ids ?? []).map((id) => regionName.get(id) ?? 'a region'),
                      teams: (r.team_ids ?? []).map((id) => teamName.get(id) ?? 'a team'),
                      recipients: r.recipients,
                    }
                  : null,
                canDelete: mine,
              };
            }),
        },
      };
    }

    const b = (await req.json().catch(() => ({}))) as {
      action?: string;
      id?: string;
      scope?: string;
      scopeId?: string;
      title?: string;
      body?: string;
      audience?: string;
      roles?: unknown;
      regionIds?: unknown;
      teamIds?: unknown;
    };

    if (b.action === 'delete') {
      const a = await queryOne<{ id: string; org_id: string; region_id: string | null; author_id: string | null }>(
        'SELECT id, org_id, region_id, author_id FROM announcement WHERE id = $1 AND deleted_at IS NULL',
        [clip(b.id, 36)],
      );
      if (!a) return FORBIDDEN;
      const may =
        a.author_id === user.id ||
        canOnScope(access, a.region_id ? { orgId: a.org_id, regionId: a.region_id } : { orgId: a.org_id }, 'member.invite').allowed;
      if (!may) return FORBIDDEN;
      await transaction(async (c) => {
        await c.query('UPDATE announcement SET deleted_at = now() WHERE id = $1', [a.id]);
        await c.query(`DELETE FROM notification WHERE link = $1`, [`/announcements?id=${a.id}`]);
      });
      return { status: 200, jsonBody: { ok: true } };
    }

    if (b.action !== 'post') return { status: 400, jsonBody: { error: 'Unknown action' } };
    const scopes = await postScopes(access, user.id);
    const scope = scopes.find((s) => s.scope === b.scope && s.id === clip(b.scopeId, 36));
    if (!scope) return FORBIDDEN;
    const title = clip(b.title, 120);
    const body = String(b.body ?? '').trim().slice(0, 2000);
    if (!title || !body) return { status: 400, jsonBody: { error: 'Give it a title and a message.' } };
    const audience = b.audience === 'roles' || b.audience === 'referees' ? b.audience : 'everyone';
    const roles =
      audience === 'roles' && Array.isArray(b.roles)
        ? [...new Set(b.roles.map(String).filter((r): r is AnnounceRole => (ANNOUNCE_ROLES as readonly string[]).includes(r)))]
        : null;
    if (audience === 'roles' && !roles?.length) return { status: 400, jsonBody: { error: 'Pick at least one role.' } };
    const regionId = scope.scope === 'region' ? scope.id : null;
    // Only regions and teams of this organization or region.
    const regionIds =
      scope.scope === 'org' && audience !== 'referees'
        ? (await query<{ id: string }>('SELECT id FROM region WHERE org_id = $1 AND id = ANY($2::uuid[])', [scope.orgId, ids(b.regionIds) ?? []])).map(
            (r) => r.id,
          )
        : [];
    const teamIds =
      audience !== 'referees'
        ? (
            await query<{ id: string }>(
              'SELECT id FROM team WHERE org_id = $1 AND ($2::uuid IS NULL OR region_id = $2) AND id = ANY($3::uuid[])',
              [scope.orgId, regionId, ids(b.teamIds) ?? []],
            )
          ).map((t) => t.id)
        : [];
    const target = {
      orgId: scope.orgId,
      regionId,
      audience: audience as 'everyone' | 'roles' | 'referees',
      roles,
      regionIds: regionIds.length ? regionIds : null,
      teamIds: teamIds.length ? teamIds : null,
    };
    // The author gets it too when they are in the audience, so they see it
    // land on their own phone (Shadi, 10/21).
    const people = await recipientsFor(target);
    if (people.length === 0) {
      return { status: 400, jsonBody: { error: 'No one matches who you picked yet.', code: 'NO_RECIPIENTS' } };
    }
    const id = await transaction(async (c) => {
      const row = await c.query<{ id: string }>(
        `INSERT INTO announcement (org_id, region_id, author_id, title, body, audience, roles, region_ids, team_ids, recipients)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [scope.orgId, regionId, user.id, title, body, audience, roles, target.regionIds, target.teamIds, people.length],
      );
      const aid = row.rows[0].id;
      await c.query(
        'INSERT INTO announcement_recipient (announcement_id, user_id) SELECT $1, u FROM unnest($2::uuid[]) AS u ON CONFLICT DO NOTHING',
        [aid, people],
      );
      const preview = body.replace(/\s+/g, ' ');
      await c.query(
        `INSERT INTO notification (user_id, kind, title, body, link, from_name)
         SELECT u, 'message', $2, $3, $4, $5 FROM unnest($1::uuid[]) AS u`,
        [
          people,
          `📣 ${title}`,
          preview.length > 140 ? `${preview.slice(0, 137)}…` : preview,
          `/announcements?id=${aid}`,
          scope.label.replace(/ \(all regions\)$/, ''),
        ],
      );
      return aid;
    });
    return { status: 201, jsonBody: { id, recipients: people.length } };
  } catch (err) {
    ctx.error('announcements failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('announcements', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'announcements',
  handler: announcementsHandler,
});

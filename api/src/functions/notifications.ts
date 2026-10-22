import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { ROLE_RANK, TIER_ORDER, normalizeTier } from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { isAdminAllowlisted } from '../lib/allowlist.js';
import { query, queryOne, transaction } from '../lib/db.js';

/**
 * In-app notifications.
 *
 * Every user has a bell: GET lists their latest notifications with an unread
 * count, POST marks them read. Admins broadcast a message to any scope (the
 * whole platform, an organization, a region or a team), narrowed by role and
 * by plan. Automatic reminders (check-ins) will write into the same table.
 */

const MAX_TITLE = 120;
const MAX_BODY = 1000;

export async function notificationsHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    if (req.method === 'POST') {
      const b = (await req.json()) as { ids?: string[]; all?: boolean };
      if (b.all) {
        await query('UPDATE notification SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [user.id]);
      } else if (Array.isArray(b.ids) && b.ids.length) {
        await query(
          'UPDATE notification SET read_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL',
          [user.id, b.ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 200)],
        );
      }
    }

    const [items, unread] = await Promise.all([
      query(
        `SELECT id, kind, title, body, link, created_at AS "createdAt", read_at AS "readAt",
                batch, from_name AS "fromName", from_detail AS "fromDetail"
           FROM notification WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30`,
        [user.id],
      ),
      queryOne<{ n: number }>(
        'SELECT COUNT(*)::int AS n FROM notification WHERE user_id = $1 AND read_at IS NULL',
        [user.id],
      ),
    ]);
    return { status: 200, jsonBody: { unread: unread?.n ?? 0, items } };
  } catch (err) {
    ctx.error('notifications failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

async function isAdmin(req: HttpRequest) {
  const user = await requireUser(req);
  if (!user) return null;
  if (isAdminAllowlisted(user)) return user;
  const row = await queryOne<{ is_platform_admin: boolean }>('SELECT is_platform_admin FROM app_user WHERE id = $1', [user.id]);
  return row?.is_platform_admin ? user : null;
}

interface Target {
  scope: 'platform' | 'org' | 'region' | 'team';
  id?: string | null;
  roles?: string[];
  tiers?: string[];
}

/**
 * SQL and parameters selecting the recipients of a broadcast. A role filter
 * matches memberships inside the chosen scope; a plan filter matches the
 * user's own plan, where no plan means Free.
 */
function recipientsSql(t: Target): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const roles = (t.roles ?? []).filter((r) => r in ROLE_RANK);
  const tiers = (t.tiers ?? []).map((x) => normalizeTier(x)).filter((x, i, a) => a.indexOf(x) === i);

  let scopeMatch = 'TRUE';
  if (t.scope === 'org') {
    const id = p(t.id);
    scopeMatch = `(m.org_id = ${id}
                   OR m.region_id IN (SELECT id FROM region WHERE org_id = ${id})
                   OR m.team_id IN (SELECT id FROM team WHERE org_id = ${id} AND deleted_at IS NULL))`;
  } else if (t.scope === 'region') {
    const id = p(t.id);
    scopeMatch = `(m.region_id = ${id} OR m.team_id IN (SELECT id FROM team WHERE region_id = ${id} AND deleted_at IS NULL))`;
  } else if (t.scope === 'team') {
    scopeMatch = `m.team_id = ${p(t.id)}`;
  }

  const needsMembership = t.scope !== 'platform' || roles.length > 0;
  const roleMatch = roles.length ? `AND m.role = ANY(${p(roles)}::text[])` : '';
  const tierMatch = tiers.length
    ? `AND COALESCE((SELECT e.tier FROM entitlement e
                      WHERE e.user_id = u.id AND e.app_id = 'lineup' AND e.status = 'active'
                      LIMIT 1), 'free') = ANY(${p(tiers)}::text[])`
    : '';

  const sql = `SELECT DISTINCT u.id FROM app_user u
     ${needsMembership ? `JOIN membership m ON m.user_id = u.id AND ${scopeMatch} ${roleMatch}` : ''}
    WHERE u.deleted_at IS NULL AND u.disabled_at IS NULL AND u.deactivated_at IS NULL ${tierMatch}`;
  return { sql, params };
}

function validTarget(t: Target | undefined): t is Target {
  if (!t || !['platform', 'org', 'region', 'team'].includes(t.scope)) return false;
  if (t.scope !== 'platform' && !(t.id && /^[0-9a-f-]{36}$/i.test(t.id))) return false;
  return true;
}

/** Admin broadcast. dryRun returns the recipient count without sending. */
export async function adminNotifyHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const admin = await isAdmin(req);
    if (!admin) return { status: 403, jsonBody: { error: 'Not permitted', code: 'FORBIDDEN' } };

    if (req.method === 'GET') {
      const [history, orgs, regions, teams] = await Promise.all([
        query(
          `SELECT b.id, b.title, b.body, b.link, b.target, b.recipients, b.created_at AS "createdAt",
                  u.display_name AS "adminName",
                  (SELECT COUNT(*) FROM notification n WHERE n.broadcast_id = b.id AND n.read_at IS NOT NULL)::int AS "readCount"
             FROM notification_broadcast b LEFT JOIN app_user u ON u.id = b.admin_id
            ORDER BY b.created_at DESC LIMIT 50`,
        ),
        query(`SELECT id, name FROM organization WHERE deleted_at IS NULL AND NOT is_personal ORDER BY name`),
        query(
          `SELECT r.id, r.name, o.name AS "orgName" FROM region r JOIN organization o ON o.id = r.org_id
            WHERE r.deleted_at IS NULL AND NOT r.is_personal ORDER BY o.name, r.name`,
        ),
        query(`SELECT id, name FROM team WHERE deleted_at IS NULL ORDER BY name LIMIT 500`),
      ]);
      return {
        status: 200,
        jsonBody: { history, scopes: { orgs, regions, teams }, roles: Object.keys(ROLE_RANK).filter((r) => r !== 'player' && r !== 'custom'), tiers: TIER_ORDER },
      };
    }

    const b = (await req.json()) as {
      title?: string;
      body?: string;
      link?: string;
      target?: Target;
      dryRun?: boolean;
    };
    if (!validTarget(b.target)) {
      return { status: 400, jsonBody: { error: 'Choose who to send to: everyone, an organization, a region or a team.' } };
    }
    const { sql, params } = recipientsSql(b.target);

    if (b.dryRun) {
      const n = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM (${sql}) r`, params);
      return { status: 200, jsonBody: { recipients: n?.n ?? 0 } };
    }

    const title = (b.title ?? '').trim().slice(0, MAX_TITLE);
    const body = (b.body ?? '').trim().slice(0, MAX_BODY);
    if (!title || !body) return { status: 400, jsonBody: { error: 'A title and a message are required.' } };
    const link = b.link && /^(https:\/\/|\/)/.test(b.link.trim()) ? b.link.trim().slice(0, 500) : null;

    const result = await transaction(async (client) => {
      const bc = await client.query(
        `INSERT INTO notification_broadcast (admin_id, title, body, link, target)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [admin.id, title, body, link, JSON.stringify(b.target)],
      );
      const id = bc.rows[0].id as string;
      const offset = params.length;
      const ins = await client.query(
        `INSERT INTO notification (user_id, broadcast_id, kind, title, body, link)
         SELECT r.id, $${offset + 1}, 'message', $${offset + 2}, $${offset + 3}, $${offset + 4}
           FROM (${sql}) r`,
        [...params, id, title, body, link],
      );
      await client.query('UPDATE notification_broadcast SET recipients = $2 WHERE id = $1', [id, ins.rowCount ?? 0]);
      return { id, recipients: ins.rowCount ?? 0 };
    });

    ctx.log('broadcast sent', { by: admin.id, recipients: result.recipients });
    return { status: 201, jsonBody: result };
  } catch (err) {
    ctx.error('admin notify failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('notifications', {
  methods: ['GET', 'POST'], authLevel: 'anonymous', route: 'notifications',
  handler: notificationsHandler,
});
app.http('adminNotify', {
  methods: ['GET', 'POST'], authLevel: 'anonymous', route: 'console/notify',
  handler: adminNotifyHandler,
});

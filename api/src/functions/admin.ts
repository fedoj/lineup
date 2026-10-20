/**
 * Admin panel — platform-operator view.
 *
 * Every route requires either app_user.is_platform_admin (set directly in the
 * database, never through the API) or the caller's object id on the
 * ADMIN_ALLOWLIST setting (sourced from Key Vault). Neither can be granted
 * through the API, so there is no path to self-promote.
 */

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { createHash } from 'node:crypto';
import { requireUser, type AuthedUser } from '../lib/auth.js';
import { normalizeTier } from '@lineup/shared';
import { isAdminAllowlisted } from '../lib/allowlist.js';
import { query, queryOne, transaction } from '../lib/db.js';
import { commentsFor } from './support.js';
import { convertTrial } from '../lib/trials.js';
import { sendSupportReplies } from '../lib/supportEmail.js';

const SUPPORT_STATUSES = ['open', 'in_progress', 'resolved', 'dismissed'];

export async function requireAdmin(req: HttpRequest): Promise<AuthedUser | null> {
  const user = await requireUser(req);
  if (!user) return null;
  if (isAdminAllowlisted(user)) return user;
  const row = await queryOne<{ is_platform_admin: boolean }>(
    'SELECT is_platform_admin FROM app_user WHERE id = $1',
    [user.id],
  );
  return row?.is_platform_admin ? user : null;
}

/** Salted so the log never holds a reversible address. */
export function hashIp(ip: string): string {
  const salt = process.env.IP_HASH_SALT ?? 'lineup';
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 32);
}

/** Record a request for the abuse view. Fire-and-forget from any handler. */
export async function logAccess(
  userId: string,
  route: string,
  ip?: string,
  userAgent?: string,
): Promise<void> {
  try {
    await query(
      `INSERT INTO access_log (user_id, route, ip_hash, user_agent)
       VALUES ($1,$2,$3,$4)`,
      [userId, route, ip ? hashIp(ip) : null, userAgent?.slice(0, 200) ?? null],
    );
    await query('UPDATE app_user SET last_seen_at = now() WHERE id = $1', [userId]);
  } catch {
    // Telemetry must never break a request.
  }
}

export async function adminHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const admin = await requireAdmin(req);
    if (!admin) {
      return { status: 403, jsonBody: { error: 'Not permitted', code: 'FORBIDDEN' } };
    }

    const view = req.query.get('view') ?? 'summary';

    if (view === 'summary') {
      const row = await queryOne<Record<string, string>>(
        `SELECT
          (SELECT COUNT(*) FROM app_user WHERE deleted_at IS NULL) AS users,
          (SELECT COUNT(*) FROM app_user
            WHERE deleted_at IS NULL AND last_seen_at > now() - INTERVAL '30 days') AS active30,
          (SELECT COUNT(*) FROM team WHERE deleted_at IS NULL) AS teams,
          (SELECT COUNT(*) FROM game WHERE deleted_at IS NULL) AS games,
          (SELECT COUNT(*) FROM player WHERE active) AS players,
          (SELECT COUNT(*) FROM organization WHERE NOT is_personal AND deleted_at IS NULL) AS orgs,
          (SELECT COUNT(*) FROM entitlement
            WHERE app_id = 'lineup' AND status = 'active' AND tier <> 'free'
              AND external_ref IS DISTINCT FROM 'trial') AS paid,
          (SELECT COUNT(*) FROM entitlement
            WHERE app_id = 'lineup' AND status = 'cancelled') AS cancelled,
          (SELECT COUNT(*) FROM deletion_request
            WHERE executed_at IS NULL AND cancelled_at IS NULL) AS pendingDeletions`,
      );

      const byTier = await query(
        `SELECT COALESCE(e.tier, 'free') AS tier, COUNT(DISTINCT u.id)::int AS users
           FROM app_user u
           LEFT JOIN entitlement e
                  ON e.user_id = u.id AND e.app_id = 'lineup' AND e.status = 'active'
          WHERE u.deleted_at IS NULL
          GROUP BY 1 ORDER BY 1`,
      );

      return { status: 200, jsonBody: { totals: row, byTier } };
    }

    if (view === 'users') {
      const q = req.query.get('q');
      const limit = Math.min(Number(req.query.get('limit') ?? 50), 200);
      const rows = await query(
        `SELECT u.id, u.email, u.display_name AS "displayName", u.provider,
                u.created_at AS "createdAt", u.last_seen_at AS "lastSeenAt",
                u.is_platform_admin AS "isPlatformAdmin",
                u.disabled_at AS "disabledAt",
                u.deactivated_at AS "deactivatedAt",
                COALESCE(e.tier, 'free') AS tier,
                e.status AS "subscriptionStatus",
                (SELECT MIN(d.execute_at) FROM deletion_request d
                  WHERE d.user_id = u.id AND d.scope = 'account'
                    AND d.executed_at IS NULL AND d.cancelled_at IS NULL) AS "deletionAt",
                (SELECT COUNT(*) FROM membership m WHERE m.user_id = u.id)::int AS memberships,
                (SELECT COUNT(*) FROM team t WHERE t.owner_id = u.id AND t.deleted_at IS NULL)::int AS teams
           FROM app_user u
           LEFT JOIN entitlement e
                  ON e.user_id = u.id AND e.app_id = 'lineup'
          WHERE u.deleted_at IS NULL
            AND ($1::text IS NULL OR u.email ILIKE '%' || $1 || '%'
                 OR u.display_name ILIKE '%' || $1 || '%' OR u.id::text = $1)
          ORDER BY u.last_seen_at DESC NULLS LAST
          LIMIT $2`,
        [q || null, limit],
      );
      return { status: 200, jsonBody: rows };
    }

    if (view === 'user') {
      const id = req.query.get('id') ?? '';
      if (!/^[0-9a-f-]{36}$/i.test(id)) return { status: 400, jsonBody: { error: 'id is required' } };
      const profile = await queryOne(
        `SELECT u.id, u.email, u.display_name AS "displayName", u.provider,
                u.created_at AS "createdAt", u.last_seen_at AS "lastSeenAt",
                u.is_platform_admin AS "isPlatformAdmin",
                u.disabled_at AS "disabledAt", u.disabled_reason AS "disabledReason",
                u.deactivated_at AS "deactivatedAt",
                u.signout_requested_at AS "signoutRequestedAt", u.signout_acked_at AS "signoutAckedAt",
                u.terms_accepted_at AS "termsAcceptedAt",
                COALESCE(e.tier, 'free') AS tier, e.status AS "subscriptionStatus",
                e.access_until AS "accessUntil"
           FROM app_user u
           LEFT JOIN entitlement e ON e.user_id = u.id AND e.app_id = 'lineup'
          WHERE u.id = $1`,
        [id],
      );
      if (!profile) return { status: 404, jsonBody: { error: 'User not found' } };
      const [memberships, teams, activity, deletion, tickets, actions] = await Promise.all([
        query(
          `SELECT m.role,
                  CASE WHEN m.team_id IS NOT NULL THEN 'team' WHEN m.division_id IS NOT NULL THEN 'division'
                       WHEN m.region_id IS NOT NULL THEN 'region' ELSE 'org' END AS scope,
                  COALESCE(t.name, d.name, r.name, o.name) AS name
             FROM membership m
             LEFT JOIN team t ON t.id = m.team_id
             LEFT JOIN division d ON d.id = m.division_id
             LEFT JOIN region r ON r.id = m.region_id
             LEFT JOIN organization o ON o.id = m.org_id
            WHERE m.user_id = $1
            ORDER BY scope, name`,
          [id],
        ),
        query(
          `SELECT t.id, t.name, (SELECT COUNT(*) FROM game g WHERE g.team_id = t.id AND g.deleted_at IS NULL)::int AS games
             FROM team t WHERE t.owner_id = $1 AND t.deleted_at IS NULL ORDER BY t.name`,
          [id],
        ),
        queryOne(
          `SELECT COALESCE(SUM(requests) FILTER (WHERE day > current_date - 7), 0)::int AS "requests7",
                  COALESCE(SUM(requests), 0)::int AS "requests30",
                  COUNT(*)::int AS "activeDays30"
             FROM usage_daily WHERE user_id = $1 AND day > current_date - 30`,
          [id],
        ),
        queryOne(
          `SELECT id, requested_at AS "requestedAt", execute_at AS "executeAt", kind
             FROM deletion_request
            WHERE user_id = $1 AND scope = 'account' AND executed_at IS NULL AND cancelled_at IS NULL
            ORDER BY execute_at LIMIT 1`,
          [id],
        ),
        queryOne(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE status IN ('open','in_progress'))::int AS open
             FROM support_request WHERE user_id = $1`,
          [id],
        ),
        query(
          `SELECT a.action, a.reason, a.created_at AS "createdAt", u.display_name AS "adminName"
             FROM admin_action a LEFT JOIN app_user u ON u.id = a.admin_id
            WHERE a.target_user_id = $1 ORDER BY a.created_at DESC LIMIT 20`,
          [id],
        ),
      ]);
      return {
        status: 200,
        jsonBody: { profile, memberships, teams, activity, deletion, tickets, actions, isSelf: id === admin.id },
      };
    }

    if (view === 'abuse') {
      // Heavy users over the last 24 hours: request volume, and how many
      // distinct source addresses an account is being used from. A single
      // account signing in from many places is the pattern worth seeing.
      const rows = await query(
        `SELECT u.id, u.email, u.display_name AS "displayName",
                COUNT(*)::int AS requests,
                COUNT(DISTINCT a.ip_hash)::int AS distinctIps,
                MAX(a.at) AS "lastAt"
           FROM access_log a
           JOIN app_user u ON u.id = a.user_id
          WHERE a.at > now() - INTERVAL '24 hours'
          GROUP BY u.id, u.email, u.display_name
         HAVING COUNT(*) > 500 OR COUNT(DISTINCT a.ip_hash) > 5
          ORDER BY requests DESC
          LIMIT 100`,
      );
      return { status: 200, jsonBody: rows };
    }

    if (view === 'subscriptions') {
      const rows = await query(
        `SELECT e.id, e.tier, e.status, e.granted_at AS "grantedAt",
                e.cancelled_at AS "cancelledAt", e.access_until AS "accessUntil",
                e.external_ref AS "externalRef",
                u.email, o.name AS "orgName", r.name AS "regionName"
           FROM entitlement e
           LEFT JOIN app_user u ON u.id = e.user_id
           LEFT JOIN organization o ON o.id = e.org_id
           LEFT JOIN region r ON r.id = e.region_id
          WHERE e.app_id = 'lineup'
          ORDER BY e.granted_at DESC
          LIMIT 200`,
      );
      return { status: 200, jsonBody: rows };
    }

    if (view === 'deletions') {
      const rows = await query(
        `SELECT d.id, d.scope, d.kind, d.requested_at AS "requestedAt",
                d.execute_at AS "executeAt", d.cancelled_at AS "cancelledAt",
                d.executed_at AS "executedAt", u.email
           FROM deletion_request d
           LEFT JOIN app_user u ON u.id = d.user_id
          ORDER BY d.requested_at DESC LIMIT 200`,
      );
      return { status: 200, jsonBody: rows };
    }

    if (view === 'insights') {
      // Everything the operator dashboard shows, in one call. Tier is the
      // user's personal plan; anyone without an active paid plan is free.
      const monthlyCost = Number(process.env.PLATFORM_MONTHLY_COST_USD ?? '0') || 0;

      const [subscribers, growth, sessions, daily, support, byTierUsage, topUsers] = await Promise.all([
        query<{ tier: string; users: number }>(
          `WITH t AS (
             SELECT u.id, COALESCE(e.tier, 'free') AS tier
               FROM app_user u
               LEFT JOIN entitlement e ON e.user_id = u.id AND e.app_id = 'lineup'
                                      AND e.status = 'active' AND e.tier <> 'free'
                                      AND e.external_ref IS DISTINCT FROM 'trial'
              WHERE u.deleted_at IS NULL)
           SELECT tier, COUNT(*)::int AS users FROM t GROUP BY tier`,
        ),
        queryOne<Record<string, number>>(
          `SELECT
             (SELECT COUNT(*) FROM app_user WHERE deleted_at IS NULL AND created_at > now() - INTERVAL '1 month')::int  AS users_1m,
             (SELECT COUNT(*) FROM app_user WHERE deleted_at IS NULL AND created_at > now() - INTERVAL '3 months')::int AS users_3m,
             (SELECT COUNT(*) FROM app_user WHERE deleted_at IS NULL AND created_at > now() - INTERVAL '6 months')::int AS users_6m,
             (SELECT COUNT(*) FROM app_user WHERE deleted_at IS NULL AND created_at > now() - INTERVAL '1 year')::int   AS users_12m,
             (SELECT COUNT(*) FROM entitlement WHERE app_id = 'lineup' AND tier <> 'free' AND external_ref IS DISTINCT FROM 'trial' AND granted_at > now() - INTERVAL '1 month')::int  AS subs_1m,
             (SELECT COUNT(*) FROM entitlement WHERE app_id = 'lineup' AND tier <> 'free' AND external_ref IS DISTINCT FROM 'trial' AND granted_at > now() - INTERVAL '3 months')::int AS subs_3m,
             (SELECT COUNT(*) FROM entitlement WHERE app_id = 'lineup' AND tier <> 'free' AND external_ref IS DISTINCT FROM 'trial' AND granted_at > now() - INTERVAL '6 months')::int AS subs_6m,
             (SELECT COUNT(*) FROM entitlement WHERE app_id = 'lineup' AND tier <> 'free' AND external_ref IS DISTINCT FROM 'trial' AND granted_at > now() - INTERVAL '1 year')::int   AS subs_12m,
             (SELECT COUNT(*) FROM entitlement WHERE app_id = 'lineup' AND status = 'cancelled')::int AS cancelled`,
        ),
        queryOne<Record<string, number>>(
          `SELECT
             (SELECT COUNT(*) FROM app_user WHERE last_seen_at > now() - INTERVAL '15 minutes')::int AS online_now,
             (SELECT COUNT(DISTINCT user_id) FROM usage_daily WHERE day = current_date)::int AS today,
             (SELECT COUNT(DISTINCT user_id) FROM usage_daily WHERE day > current_date - 7)::int AS last7,
             (SELECT COUNT(DISTINCT user_id) FROM usage_daily WHERE day > current_date - 30)::int AS last30,
             (SELECT COALESCE(SUM(requests), 0) FROM usage_daily WHERE day > current_date - 30)::int AS requests30`,
        ),
        query<{ day: string; users: number; requests: number }>(
          `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
                  COUNT(u.user_id)::int AS users, COALESCE(SUM(u.requests), 0)::int AS requests
             FROM generate_series(current_date - 13, current_date, INTERVAL '1 day') AS d(day)
             LEFT JOIN usage_daily u ON u.day = d.day::date
            GROUP BY d.day ORDER BY d.day`,
        ),
        query<{ status: string; n: number }>(
          `SELECT status, COUNT(*)::int AS n FROM support_request GROUP BY status`,
        ),
        query<{ tier: string; users: number; active: number; requests: number; teams: number; players: number; games: number }>(
          `WITH ut AS (
             SELECT u.id, COALESCE(e.tier, 'free') AS tier
               FROM app_user u
               LEFT JOIN entitlement e ON e.user_id = u.id AND e.app_id = 'lineup'
                                      AND e.status = 'active' AND e.tier <> 'free'
                                      AND e.external_ref IS DISTINCT FROM 'trial'
              WHERE u.deleted_at IS NULL),
           req AS (SELECT user_id, SUM(requests)::int AS n FROM usage_daily
                    WHERE day > current_date - 30 GROUP BY user_id),
           own AS (SELECT t.owner_id AS user_id, COUNT(DISTINCT t.id)::int AS teams,
                          COUNT(DISTINCT p.id)::int AS players, COUNT(DISTINCT g.id)::int AS games
                     FROM team t
                     LEFT JOIN player p ON p.team_id = t.id
                     LEFT JOIN game g ON g.team_id = t.id AND g.deleted_at IS NULL
                    WHERE t.deleted_at IS NULL GROUP BY t.owner_id)
           SELECT ut.tier, COUNT(*)::int AS users,
                  COUNT(req.user_id)::int AS active,
                  COALESCE(SUM(req.n), 0)::int AS requests,
                  COALESCE(SUM(own.teams), 0)::int AS teams,
                  COALESCE(SUM(own.players), 0)::int AS players,
                  COALESCE(SUM(own.games), 0)::int AS games
             FROM ut LEFT JOIN req ON req.user_id = ut.id LEFT JOIN own ON own.user_id = ut.id
            GROUP BY ut.tier ORDER BY ut.tier`,
        ),
        query<{ id: string; name: string | null; tier: string; requests: number; days: number; teams: number; players: number; games: number; last_seen: Date | null }>(
          `WITH req AS (SELECT user_id, SUM(requests)::int AS n, COUNT(*)::int AS days FROM usage_daily
                         WHERE day > current_date - 30 GROUP BY user_id)
           SELECT u.id, u.display_name AS name, COALESCE(e.tier, 'free') AS tier,
                  COALESCE(req.n, 0) AS requests, COALESCE(req.days, 0) AS days,
                  (SELECT COUNT(*) FROM team t WHERE t.owner_id = u.id AND t.deleted_at IS NULL)::int AS teams,
                  (SELECT COUNT(*) FROM player p JOIN team t ON t.id = p.team_id
                    WHERE t.owner_id = u.id AND t.deleted_at IS NULL)::int AS players,
                  (SELECT COUNT(*) FROM game g JOIN team t ON t.id = g.team_id
                    WHERE t.owner_id = u.id AND t.deleted_at IS NULL AND g.deleted_at IS NULL)::int AS games,
                  u.last_seen_at AS last_seen
             FROM app_user u
             LEFT JOIN entitlement e ON e.user_id = u.id AND e.app_id = 'lineup'
                                    AND e.status = 'active' AND e.tier <> 'free'
                                    AND e.external_ref IS DISTINCT FROM 'trial'
             LEFT JOIN req ON req.user_id = u.id
            WHERE u.deleted_at IS NULL
            ORDER BY COALESCE(req.n, 0) DESC, u.created_at DESC
            LIMIT 50`,
        ),
      ]);

      const totalRequests = sessions?.requests30 ?? 0;
      // Cost is shared out by each tier's and user's share of requests over
      // the last 30 days: a fair proxy for how much of the platform they use.
      const share = (n: number) =>
        monthlyCost > 0 && totalRequests > 0 ? Math.round((monthlyCost * n * 100) / totalRequests) / 100 : null;

      return {
        status: 200,
        jsonBody: {
          monthlyCost: monthlyCost || null,
          subscribers,
          growth,
          sessions,
          daily,
          support,
          tiers: byTierUsage.map((t) => ({ ...t, cost: share(t.requests) })),
          users: topUsers.map((u) => ({
            id: u.id,
            name: u.name,
            tier: u.tier,
            requests: u.requests,
            days: u.days,
            teams: u.teams,
            players: u.players,
            games: u.games,
            lastSeenAt: u.last_seen ? u.last_seen.toISOString() : null,
            cost: share(u.requests),
          })),
        },
      };
    }

    if (view === 'usage') {
      // Most-opened pages and most-tapped buttons (Fady, 10/19), from the
      // per-day counts the app sends: no user or device is stored.
      const days = Math.min(400, Math.max(1, Math.round(Number(req.query.get('days')) || 30)));
      const [pages, clicks, daily] = await Promise.all([
        query<{ name: string; hits: string }>(
          `SELECT name, SUM(hits)::bigint AS hits FROM feature_usage_daily
            WHERE kind = 'page' AND day > current_date - $1::int
            GROUP BY name ORDER BY 2 DESC LIMIT 40`,
          [days],
        ),
        query<{ name: string; hits: string }>(
          `SELECT name, SUM(hits)::bigint AS hits FROM feature_usage_daily
            WHERE kind = 'click' AND day > current_date - $1::int
            GROUP BY name ORDER BY 2 DESC LIMIT 60`,
          [days],
        ),
        query<{ day: string; pages: string; clicks: string }>(
          `SELECT to_char(day, 'YYYY-MM-DD') AS day,
                  SUM(hits) FILTER (WHERE kind = 'page')::bigint AS pages,
                  SUM(hits) FILTER (WHERE kind = 'click')::bigint AS clicks
             FROM feature_usage_daily WHERE day > current_date - $1::int
            GROUP BY day ORDER BY day`,
          [days],
        ),
      ]);
      const num = (v: string | null) => Number(v ?? 0);
      return {
        status: 200,
        jsonBody: {
          days,
          pages: pages.map((r) => ({ name: r.name, hits: num(r.hits) })),
          clicks: clicks.map((r) => ({ name: r.name, hits: num(r.hits) })),
          daily: daily.map((r) => ({ day: r.day, pages: num(r.pages), clicks: num(r.clicks) })),
        },
      };
    }

    if (view === 'support') {
      // Email tickets may have no Lineup account: show the sender instead.
      const rows = await query<{ id: string } & Record<string, unknown>>(
        `SELECT s.id, s.email, s.subject, s.body, s.status, s.source,
                s.scout_eligible AS "scoutEligible", s.scout_note AS "scoutNote",
                s.created_at AS "createdAt", s.updated_at AS "updatedAt",
                s.resolved_at AS "resolvedAt",
                COALESCE(u.display_name, s.from_name, s.email) AS "displayName"
           FROM support_request s
           LEFT JOIN app_user u ON u.id = s.user_id
          ORDER BY
                CASE s.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
                s.created_at DESC
          LIMIT 200`,
      );
      const comments = await commentsFor(rows.map((r) => r.id));
      return {
        status: 200,
        jsonBody: rows.map((r) => ({ ...r, comments: comments.get(r.id) ?? [] })),
      };
    }

    return { status: 400, jsonBody: { error: 'Unknown view' } };
  } catch (err) {
    ctx.error('admin failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/** Grant or revoke an entitlement by hand — comps, refunds, support fixes. */
export async function adminGrantHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const admin = await requireAdmin(req);
    if (!admin) {
      return { status: 403, jsonBody: { error: 'Not permitted', code: 'FORBIDDEN' } };
    }

    const body = (await req.json()) as {
      userId?: string;
      orgId?: string;
      regionId?: string;
      tier?: string;
      overrides?: Record<string, number>;
      expiresAt?: string;
      note?: string;
    };
    if (!body.tier) return { status: 400, jsonBody: { error: 'tier is required' } };
    // Grants are stored under the current plan ids even if an old id is sent.
    body.tier = normalizeTier(body.tier);
    if (!body.userId && !body.orgId && !body.regionId) {
      return { status: 400, jsonBody: { error: 'A target scope is required' } };
    }

    const row = await queryOne(
      `INSERT INTO entitlement (app_id, user_id, org_id, region_id, tier,
                                overrides, expires_at, status, external_ref)
       VALUES ('lineup', $1, $2, $3, $4, $5, $6, 'active', $7)
       ON CONFLICT (app_id, user_id) DO UPDATE SET
         tier = EXCLUDED.tier, overrides = EXCLUDED.overrides,
         expires_at = EXCLUDED.expires_at, status = 'active',
         cancelled_at = NULL, external_ref = EXCLUDED.external_ref
       RETURNING id, tier, status`,
      [
        body.userId ?? null, body.orgId ?? null, body.regionId ?? null,
        body.tier, body.overrides ? JSON.stringify(body.overrides) : null,
        body.expiresAt ?? null, body.note ?? `granted by ${admin.email ?? admin.id}`,
      ],
    );

    // Subscribing ends a free trial: if it had already lapsed, the
    // organization or region it paused comes back as it was.
    const restored = body.userId
      ? await transaction((c) => convertTrial(c, body.userId as string, body.tier as string))
      : false;

    ctx.log('entitlement granted', { by: admin.id, target: body.userId ?? body.orgId, trialConverted: restored });
    return { status: 200, jsonBody: { ...row, trialConverted: restored } };
  } catch (err) {
    ctx.error('admin grant failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/**
 * Answer a support request and/or move it through its states. The reply is
 * visible to the requester on their Help & support screen.
 */
export async function adminSupportHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const admin = await requireAdmin(req);
    if (!admin) {
      return { status: 403, jsonBody: { error: 'Not permitted', code: 'FORBIDDEN' } };
    }

    const b = (await req.json()) as { requestId?: string; body?: string; status?: string; scoutEligible?: boolean };
    const requestId = String(b.requestId ?? '').trim();
    const text = String(b.body ?? '').trim().slice(0, 4000);
    const status = b.status && SUPPORT_STATUSES.includes(b.status) ? b.status : null;
    // An admin decides whether Scout may work on a ticket (email tickets start off).
    const scoutEligible = typeof b.scoutEligible === 'boolean' ? b.scoutEligible : null;
    if (!requestId || (!text && !status && scoutEligible === null)) {
      return { status: 400, jsonBody: { error: 'requestId and a reply or status are required' } };
    }

    const exists = await queryOne<{ id: string }>('SELECT id FROM support_request WHERE id = $1', [
      requestId,
    ]);
    if (!exists) return { status: 404, jsonBody: { error: 'Request not found' } };

    if (text) {
      const who = await queryOne<{ display_name: string | null }>(
        'SELECT display_name FROM app_user WHERE id = $1',
        [admin.id],
      );
      await query(
        `INSERT INTO support_comment (request_id, author_kind, author_id, author_name, body)
         VALUES ($1, 'support', $2, $3, $4)`,
        [requestId, admin.id, `${who?.display_name?.split('@')[0] ?? 'Support'} (support)`, text],
      );
    }
    await query(
      `UPDATE support_request
          SET updated_at = now(),
              status = COALESCE($2, status),
              scout_eligible = COALESCE($3, scout_eligible),
              resolved_at = CASE WHEN $2 IN ('resolved', 'dismissed') THEN now()
                                 WHEN $2 IS NOT NULL THEN NULL
                                 ELSE resolved_at END
        WHERE id = $1`,
      [requestId, status, scoutEligible],
    );
    // A reply on an email ticket goes out by email straight away.
    if (text) void sendSupportReplies(true).catch(() => undefined);

    const comments = await commentsFor([requestId]);
    return { status: 200, jsonBody: { comments: comments.get(requestId) ?? [], status, scoutEligible } };
  } catch (err) {
    ctx.error('admin support failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

type UserAction = 'disable' | 'enable' | 'signout' | 'delete' | 'recover';
const USER_ACTIONS: readonly UserAction[] = ['disable', 'enable', 'signout', 'delete', 'recover'];

/**
 * Account controls from the admin console. Deletion is queued with the same
 * 7-day grace period as a self-service deletion and disables the account
 * at once; recovering cancels the queue entry and re-enables it.
 */
export async function adminUserActionHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const admin = await requireAdmin(req);
    if (!admin) {
      return { status: 403, jsonBody: { error: 'Not permitted', code: 'FORBIDDEN' } };
    }
    const b = (await req.json()) as { userId?: string; action?: string; reason?: string };
    const action = b.action as UserAction;
    if (!b.userId || !/^[0-9a-f-]{36}$/i.test(b.userId) || !USER_ACTIONS.includes(action)) {
      return { status: 400, jsonBody: { error: 'userId and a valid action are required' } };
    }
    if (b.userId === admin.id) {
      return { status: 409, jsonBody: { error: 'You cannot run account actions on your own account.' } };
    }
    const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 300) || null : null;

    const result = await transaction(async (client) => {
      const target = await client.query('SELECT id FROM app_user WHERE id = $1 FOR UPDATE', [b.userId]);
      if (!target.rowCount) return null;

      if (action === 'disable') {
        await client.query(
          `UPDATE app_user SET disabled_at = COALESCE(disabled_at, now()), disabled_reason = $2,
                  signout_requested_at = now() WHERE id = $1`,
          [b.userId, reason],
        );
      } else if (action === 'enable') {
        // Clear the sign-out that came with disabling, so the person is not
        // bounced through a second sign-in once they are let back in.
        await client.query(
          `UPDATE app_user SET disabled_at = NULL, disabled_reason = NULL,
                  signout_acked_at = GREATEST(COALESCE(signout_acked_at, now()), now()) WHERE id = $1`,
          [b.userId],
        );
      } else if (action === 'signout') {
        await client.query('UPDATE app_user SET signout_requested_at = now() WHERE id = $1', [b.userId]);
      } else if (action === 'delete') {
        await client.query(
          `INSERT INTO deletion_request (user_id, scope)
           SELECT $1, 'account'
            WHERE NOT EXISTS (SELECT 1 FROM deletion_request WHERE user_id = $1 AND scope = 'account'
                                AND executed_at IS NULL AND cancelled_at IS NULL)`,
          [b.userId],
        );
        await client.query(
          `UPDATE app_user SET disabled_at = COALESCE(disabled_at, now()),
                  disabled_reason = COALESCE($2, 'Deletion queued by support'),
                  signout_requested_at = now() WHERE id = $1`,
          [b.userId, reason],
        );
      } else if (action === 'recover') {
        await client.query(
          `UPDATE deletion_request SET cancelled_at = now()
            WHERE user_id = $1 AND scope = 'account' AND executed_at IS NULL AND cancelled_at IS NULL`,
          [b.userId],
        );
        await client.query(
          `UPDATE app_user SET disabled_at = NULL, disabled_reason = NULL, deactivated_at = NULL,
                  signout_acked_at = GREATEST(COALESCE(signout_acked_at, now()), now()) WHERE id = $1`,
          [b.userId],
        );
      }

      await client.query(
        'INSERT INTO admin_action (admin_id, target_user_id, action, reason) VALUES ($1,$2,$3,$4)',
        [admin.id, b.userId, action, reason],
      );
      return true;
    });

    if (!result) return { status: 404, jsonBody: { error: 'User not found' } };
    ctx.log('admin user action', { by: admin.id, target: b.userId, action });
    return { status: 200, jsonBody: { ok: true, action } };
  } catch (err) {
    ctx.error('admin user action failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('admin', {
  methods: ['GET'], authLevel: 'anonymous', route: 'console', handler: adminHandler,
});
app.http('adminUserAction', {
  methods: ['POST'], authLevel: 'anonymous', route: 'console/users/action',
  handler: adminUserActionHandler,
});
app.http('adminGrant', {
  methods: ['POST'], authLevel: 'anonymous', route: 'console/grant',
  handler: adminGrantHandler,
});
app.http('adminSupport', {
  methods: ['POST'], authLevel: 'anonymous', route: 'console/support',
  handler: adminSupportHandler,
});

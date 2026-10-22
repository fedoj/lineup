import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { requireUser } from '../lib/auth.js';
import { cleanNotifyPrefs, DEFAULT_NOTIFY_PREFS, type NotifyPrefs } from '@lineup/shared';
import { query, queryOne } from '../lib/db.js';
import { sendTestPush } from '../lib/pushSend.js';
import { FCM_PREFIX, fcmReady, isFcmToken } from '../lib/fcm.js';

/**
 * Push notifications: a device turned on in Account (Fady, 10/19). GET gives
 * the public key the browser needs to subscribe; POST saves this device's
 * subscription (or, with { test: true }, sends a test notification to the
 * person's devices); DELETE removes it. Sending is in lib/pushSend.ts.
 * GET also returns what the person has pushed (prefs), and POST { prefs }
 * changes it (Shadi, 10/21).
 */

async function loadPrefs(userId: string): Promise<NotifyPrefs> {
  const row = await queryOne<NotifyPrefs>('SELECT games, practices, events, chat FROM notification_pref WHERE user_id = $1', [userId]);
  return row ?? DEFAULT_NOTIFY_PREFS;
}
export async function pushHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    const publicKey = process.env.VAPID_PUBLIC_KEY ?? '';

    if (req.method === 'GET') {
      const [rows, prefs] = await Promise.all([
        query<{ n: string }>('SELECT COUNT(*)::text AS n FROM push_subscription WHERE user_id = $1', [user.id]),
        loadPrefs(user.id),
      ]);
      return {
        status: 200,
        jsonBody: {
          available: Boolean(publicKey),
          publicKey: publicKey || null,
          // The Android app pushes through Firebase instead (Shadi, 10/22).
          native: fcmReady(),
          devices: Number(rows[0]?.n ?? 0),
          prefs,
        },
      };
    }

    const b = (req.method === 'POST' ? await req.json().catch(() => ({})) : {}) as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
      test?: boolean;
      report?: { outcome?: string; step?: string; detail?: string; permission?: string; installed?: boolean };
      prefs?: unknown;
      fcmToken?: unknown;
    };
    if (req.method === 'POST') {
      if (b.prefs !== undefined) {
        const next = cleanNotifyPrefs(b.prefs, await loadPrefs(user.id));
        await query(
          `INSERT INTO notification_pref (user_id, games, practices, events, chat, updated_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (user_id) DO UPDATE SET games = EXCLUDED.games, practices = EXCLUDED.practices,
             events = EXCLUDED.events, chat = EXCLUDED.chat, updated_at = now()`,
          [user.id, next.games, next.practices, next.events, next.chat],
        );
        return { status: 200, jsonBody: { prefs: next } };
      }
      // The Android app's Firebase token (Shadi, 10/22): pushed through FCM.
      if (b.fcmToken !== undefined) {
        if (!isFcmToken(b.fcmToken)) {
          return { status: 400, jsonBody: { error: 'That device could not be set up for notifications.' } };
        }
        await query(
          `INSERT INTO push_subscription (user_id, endpoint, p256dh, auth, user_agent)
           VALUES ($1, $2, 'fcm', 'fcm', $3)
           ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, user_agent = EXCLUDED.user_agent`,
          [user.id, `${FCM_PREFIX}${b.fcmToken}`, (req.headers.get('user-agent') ?? '').slice(0, 200) || null],
        );
        return { status: 201, jsonBody: { ok: true, delivered: fcmReady() } };
      }
    }

    if (!publicKey) return { status: 409, jsonBody: { error: 'Notifications are not set up yet.', code: 'PUSH_UNAVAILABLE' } };

    if (req.method === 'DELETE') {
      const endpoint = String(req.query.get('endpoint') ?? '').slice(0, 1000);
      await query('DELETE FROM push_subscription WHERE user_id = $1 AND endpoint = $2', [user.id, endpoint]);
      return { status: 204 };
    }

    if (b.report) {
      // What happened when this person tried to turn notifications on.
      const r = b.report;
      const cut = (v: unknown, n: number) => (typeof v === 'string' && v ? v.slice(0, n) : null);
      await query(
        `INSERT INTO push_setup_log (user_id, outcome, step, detail, permission, installed, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          user.id,
          cut(r.outcome, 40) ?? 'unknown',
          cut(r.step, 40),
          cut(r.detail, 500),
          cut(r.permission, 20),
          typeof r.installed === 'boolean' ? r.installed : null,
          (req.headers.get('user-agent') ?? '').slice(0, 300) || null,
        ],
      );
      await query(`DELETE FROM push_setup_log WHERE user_id = $1 AND created_at < now() - interval '30 days'`, [user.id]);
      return { status: 204 };
    }
    if (b.test) {
      const sent = await sendTestPush(user.id);
      return { status: 200, jsonBody: { sent } };
    }
    const endpoint = String(b.endpoint ?? '');
    const p256dh = String(b.keys?.p256dh ?? '');
    const auth = String(b.keys?.auth ?? '');
    // Only real push services, over https.
    if (!/^https:\/\/[^\s]{10,1000}$/.test(endpoint) || !p256dh || p256dh.length > 200 || !auth || auth.length > 100) {
      return { status: 400, jsonBody: { error: 'That device could not be set up for notifications.' } };
    }
    await query(
      `INSERT INTO push_subscription (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
         user_agent = EXCLUDED.user_agent`,
      [user.id, endpoint, p256dh, auth, (req.headers.get('user-agent') ?? '').slice(0, 200) || null],
    );
    return { status: 201, jsonBody: { ok: true } };
  } catch (err) {
    ctx.error('push failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('push', {
  methods: ['GET', 'POST', 'DELETE'], authLevel: 'anonymous', route: 'push', handler: pushHandler,
});

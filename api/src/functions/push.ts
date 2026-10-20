import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { requireUser } from '../lib/auth.js';
import { query } from '../lib/db.js';
import { sendTestPush } from '../lib/pushSend.js';

/**
 * Push notifications: a device turned on in Account (Fady, 10/19). GET gives
 * the public key the browser needs to subscribe; POST saves this device's
 * subscription (or, with { test: true }, sends a test notification to the
 * person's devices); DELETE removes it. Sending is in lib/pushSend.ts.
 */
export async function pushHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    const publicKey = process.env.VAPID_PUBLIC_KEY ?? '';

    if (req.method === 'GET') {
      const rows = await query<{ n: string }>('SELECT COUNT(*)::text AS n FROM push_subscription WHERE user_id = $1', [user.id]);
      return { status: 200, jsonBody: { available: Boolean(publicKey), publicKey: publicKey || null, devices: Number(rows[0]?.n ?? 0) } };
    }

    if (!publicKey) return { status: 409, jsonBody: { error: 'Notifications are not set up yet.', code: 'PUSH_UNAVAILABLE' } };

    if (req.method === 'DELETE') {
      const endpoint = String(req.query.get('endpoint') ?? '').slice(0, 1000);
      await query('DELETE FROM push_subscription WHERE user_id = $1 AND endpoint = $2', [user.id, endpoint]);
      return { status: 204 };
    }

    const b = (await req.json().catch(() => ({}))) as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
      test?: boolean;
    };
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

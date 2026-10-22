import webpush from 'web-push';
import { notifyCategory, pushAllowed, type NotifyPrefs } from '@lineup/shared';
import { query } from './db.js';
import { FCM_PREFIX, fcmReady, sendFcm } from './fcm.js';

/**
 * Sending push notifications to phones and computers (Fady, 10/19).
 *
 * Every in-app notification (the bell) is also pushed to the devices where
 * the person turned notifications on (push_subscription). Static Web Apps
 * functions only run on requests, so sending happens at the end of each API
 * request: whatever was created and not yet pushed goes out then, usually by
 * the very request that created it. Devices the push service says are gone
 * (404/410) are removed. What each person gets pushed follows their settings
 * (notification_pref, Shadi 10/21): games, practices, events, and chat for
 * every message, @mentions only, or never; the bell keeps everything.
 * Browsers get web push (VAPID); the Android app gets Firebase Cloud
 * Messaging, for devices saved as `fcm:<token>` (lib/fcm.ts, Shadi 10/22).
 */

let configured: boolean | null = null;

function webPushReady(): boolean {
  if (configured !== null) return configured;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  configured = Boolean(pub && priv);
  if (configured) webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? 'mailto:support@mahoul.io', pub!, priv!);
  return configured;
}

function ready(): boolean {
  return webPushReady() || fcmReady();
}

/** Push one message to one device, by the kind of device it is. */
async function deliver(
  d: Device,
  msg: { title: string; body: string; link: string; tag: string },
  ttl: number,
): Promise<'sent' | 'gone' | 'failed'> {
  if (d.endpoint.startsWith(FCM_PREFIX)) {
    return fcmReady() ? sendFcm(d.endpoint.slice(FCM_PREFIX.length), msg, ttl) : 'failed';
  }
  if (!webPushReady()) return 'failed';
  try {
    await webpush.sendNotification({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, JSON.stringify(msg), {
      TTL: ttl,
      urgency: 'normal',
      timeout: 5000,
    });
    return 'sent';
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode;
    return status === 404 || status === 410 ? 'gone' : 'failed';
  }
}

interface Pending {
  id: string;
  user_id: string;
  title: string;
  body: string;
  link: string | null;
  group_key: string | null;
  batch: number | null;
}

interface Device {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

let running: Promise<void> | null = null;
let lastRun = 0;

/** Send what is waiting. Cheap when nothing is: one indexed query. */
export function sendPendingPushes(): Promise<void> {
  if (!ready()) return Promise.resolve();
  if (running) return running;
  // At most twice a second per instance; anything missed goes out next time.
  if (Date.now() - lastRun < 500) return Promise.resolve();
  lastRun = Date.now();
  running = run().finally(() => {
    running = null;
  });
  return running;
}

async function run(): Promise<void> {
  // Claim the batch, so two instances never send the same one twice.
  const pending = await query<Pending>(
    `UPDATE notification n SET pushed_at = now()
      WHERE n.id IN (
        SELECT id FROM notification
         WHERE pushed_at IS NULL AND created_at > now() - interval '1 hour'
         ORDER BY created_at LIMIT 100
         FOR UPDATE SKIP LOCKED)
      RETURNING n.id, n.user_id, n.title, n.body, n.link, n.group_key, n.batch`,
  ).catch(() => [] as Pending[]);
  if (pending.length === 0) return;

  const people = [...new Set(pending.map((p) => p.user_id))];
  const [devices, prefRows] = await Promise.all([
    query<Device>('SELECT id, user_id, endpoint, p256dh, auth FROM push_subscription WHERE user_id = ANY($1::uuid[])', [people]),
    query<NotifyPrefs & { user_id: string }>(
      'SELECT user_id, games, practices, events, chat FROM notification_pref WHERE user_id = ANY($1::uuid[])',
      [people],
    ).catch(() => [] as Array<NotifyPrefs & { user_id: string }>),
  ]);
  if (devices.length === 0) return;
  const prefs = new Map(prefRows.map((r) => [r.user_id, r]));

  const gone: string[] = [];
  const used: string[] = [];
  await Promise.all(
    pending
      .filter((n) => pushAllowed(notifyCategory(n.link, n.group_key), prefs.get(n.user_id)))
      .flatMap((n) =>
      devices
        .filter((d) => d.user_id === n.user_id)
        .map(async (d) => {
          const more = n.batch && n.batch > 1 ? ` (${n.batch} new)` : '';
          const outcome = await deliver(
            d,
            {
              title: `${n.title}${more}`,
              body: n.body.slice(0, 240),
              link: n.link ?? '/',
              // Grouped chat messages replace the earlier one on the phone.
              tag: n.group_key ?? n.id,
            },
            60 * 60 * 24,
          );
          if (outcome === 'sent') used.push(d.id);
          else if (outcome === 'gone') gone.push(d.id);
        }),
    ),
  );
  if (gone.length) await query('DELETE FROM push_subscription WHERE id = ANY($1::uuid[])', [gone]).catch(() => undefined);
  if (used.length) {
    await query('UPDATE push_subscription SET last_used_at = now() WHERE id = ANY($1::uuid[])', [[...new Set(used)]]).catch(() => undefined);
  }
}

/** Send a test notification to one person's devices; returns how many got it. */
export async function sendTestPush(userId: string): Promise<number> {
  if (!ready()) return 0;
  const devices = await query<Device>('SELECT id, user_id, endpoint, p256dh, auth FROM push_subscription WHERE user_id = $1', [userId]);
  let ok = 0;
  for (const d of devices) {
    const outcome = await deliver(
      d,
      { title: 'Lineup notifications are on', body: 'This is how game changes, messages and reminders will look.', link: '/account', tag: 'test' },
      600,
    );
    if (outcome === 'sent') ok++;
    else if (outcome === 'gone') await query('DELETE FROM push_subscription WHERE id = $1', [d.id]).catch(() => undefined);
  }
  return ok;
}

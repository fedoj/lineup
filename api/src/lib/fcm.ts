import { createSign } from 'node:crypto';

/**
 * Push to the Android app through Firebase Cloud Messaging (Shadi, 10/22).
 *
 * The app registers with FCM (the Capacitor push plugin) and gives its token
 * to /api/push, stored as a push_subscription whose endpoint is
 * `fcm:<token>`. Sending uses the FCM HTTP v1 API with the Firebase project's
 * service account (FCM_SERVICE_ACCOUNT_JSON, from Key Vault secret
 * android-app-firebase-serviceaccount-privatekey-json): a short-lived OAuth
 * token is minted from a signed JWT and reused for its hour. No SDK needed.
 */

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export const FCM_PREFIX = 'fcm:';
/** The Android notification channel the app creates on start. */
export const FCM_CHANNEL = 'lineup';

let account: ServiceAccount | null | undefined;

function serviceAccount(): ServiceAccount | null {
  if (account !== undefined) return account;
  try {
    const raw = process.env.FCM_SERVICE_ACCOUNT_JSON;
    const parsed = raw ? (JSON.parse(raw) as Partial<ServiceAccount>) : null;
    account =
      parsed && parsed.project_id && parsed.client_email && parsed.private_key
        ? { project_id: parsed.project_id, client_email: parsed.client_email, private_key: parsed.private_key }
        : null;
  } catch {
    account = null;
  }
  return account;
}

export function fcmReady(): boolean {
  return serviceAccount() !== null;
}

/** An FCM registration token as the plugin hands it over. */
export function isFcmToken(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_:\-.]{20,900}$/.test(v);
}

let cached: { token: string; until: number } | null = null;

async function accessToken(sa: ServiceAccount): Promise<string> {
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`FCM sign-in failed (${res.status})`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: body.access_token, until: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}

export interface FcmMessage {
  title: string;
  body: string;
  link: string;
  /** Same tag replaces the earlier notification on the phone. */
  tag: string;
}

/** 'gone' means the app was uninstalled or the token expired: forget the device. */
export async function sendFcm(token: string, msg: FcmMessage, ttlSeconds = 86_400): Promise<'sent' | 'gone' | 'failed'> {
  const sa = serviceAccount();
  if (!sa) return 'failed';
  try {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken(sa)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: msg.title, body: msg.body },
          data: { link: msg.link, tag: msg.tag },
          android: {
            priority: 'high',
            ttl: `${ttlSeconds}s`,
            notification: { tag: msg.tag, channel_id: FCM_CHANNEL },
          },
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return 'sent';
    const text = await res.text().catch(() => '');
    if (res.status === 404 || /UNREGISTERED|registration token is not a valid/i.test(text)) return 'gone';
    return 'failed';
  } catch {
    return 'failed';
  }
}

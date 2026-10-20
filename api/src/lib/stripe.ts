import crypto from 'node:crypto';

/**
 * A small Stripe client over the REST API (no SDK), and webhook signature
 * checks. Lineup only ever holds a restricted key: customers, checkout,
 * the customer portal, subscriptions, products and prices, coupons and
 * promotion codes, and refunds back to the customer who paid. It can't move
 * money to a bank account.
 *
 * Settings: STRIPE_SECRET_KEY (rk_test_… in dev) and STRIPE_WEBHOOK_SECRET.
 */

const API = 'https://api.stripe.com/v1';

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
  }
}

function key(): string {
  return (process.env.STRIPE_SECRET_KEY ?? '').trim();
}

export function stripeMode(): 'test' | 'live' | null {
  const k = key();
  if (!k) return null;
  return /^(sk|rk)_live_/.test(k) ? 'live' : 'test';
}

/**
 * Stripe is usable here: a key is set, and a live key only ever in
 * production, so dev and local can never charge a real card. A live key also
 * needs the webhook secret, so nobody pays for a plan that would never be
 * switched on.
 */
export function stripeEnabled(): boolean {
  const mode = stripeMode();
  if (!mode) return false;
  if (mode === 'test') return true;
  return process.env.APP_ENV === 'prd' && Boolean((process.env.STRIPE_WEBHOOK_SECRET ?? '').trim());
}

/** Stripe's form encoding: nested objects and arrays as a[b][0]=c. */
export function formEncode(params: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = [];
  const add = (k: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === 'object') parts.push(formEncode(item as Record<string, unknown>, `${k}[${i}]`));
        else add(`${k}[${i}]`, item);
      });
    } else if (typeof v === 'object') {
      const inner = formEncode(v as Record<string, unknown>, k);
      if (inner) parts.push(inner);
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  };
  for (const [k, v] of Object.entries(params)) add(prefix ? `${prefix}[${k}]` : k, v);
  return parts.filter(Boolean).join('&');
}

export async function stripe<T = Record<string, any>>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params: Record<string, unknown> = {},
  idempotencyKey?: string,
): Promise<T> {
  if (!stripeEnabled()) throw new StripeError('Payments are not set up yet.', 503, 'STRIPE_NOT_CONFIGURED');
  const body = formEncode(params);
  const url = method === 'POST' || !body ? `${API}${path}` : `${API}${path}?${body}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${key()}` };
  if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(url, { method, headers, body: method === 'POST' ? body : undefined });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) {
    const err = json.error ?? {};
    throw new StripeError(err.message ?? `Stripe request failed (${res.status})`, res.status, err.code ?? err.type ?? null);
  }
  return json as T;
}

/** The end of the current billing period, on old and new API versions. */
export function periodEnd(sub: Record<string, any>): Date | null {
  const s = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
  return typeof s === 'number' ? new Date(s * 1000) : null;
}

/**
 * Check a webhook's Stripe-Signature header against the raw body: an HMAC of
 * "timestamp.payload" with the endpoint secret, within five minutes.
 */
export function verifyWebhook(
  payload: string,
  header: string | null,
  secret = process.env.STRIPE_WEBHOOK_SECRET ?? '',
  toleranceSec = 300,
  now = Date.now(),
): boolean {
  if (!header || !secret) return false;
  const fields = header.split(',').map((p) => p.split('=') as [string, string]);
  const t = Number(fields.find(([k]) => k === 't')?.[1]);
  const sigs = fields.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!Number.isFinite(t) || sigs.length === 0) return false;
  if (Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${payload}`, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'hex');
  return sigs.some((s) => {
    const b = Buffer.from(s, 'hex');
    return b.length === a.length && crypto.timingSafeEqual(a, b);
  });
}

/** Where people land back in the app after Stripe. */
export function appOrigin(): string {
  const configured = process.env.APP_ORIGIN?.replace(/\/+$/, '');
  if (configured) return configured;
  return process.env.APP_ENV === 'prd' ? 'https://lineup.mahoul.io' : 'https://lineup-dev.mahoul.io';
}

/** Refunds Lineup may issue in one calendar month, in cents. Anything more is done in Stripe by hand. */
export const REFUND_MONTHLY_CAP_CENTS = 30000;

/** The first moment of this month in Pacific time, as a UTC instant. */
export function monthStart(now = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit' })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  // The 1st's UTC offset (-7 in daylight time, -8 otherwise) places midnight.
  const noon = new Date(`${parts.year}-${parts.month}-01T12:00:00Z`);
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'shortOffset' })
    .formatToParts(noon)
    .find((p) => p.type === 'timeZoneName')?.value;
  const hours = Number(/GMT([+-]\d+)/.exec(offset ?? '')?.[1] ?? -8);
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, 1, -hours, 0, 0));
}

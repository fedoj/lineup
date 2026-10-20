import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { LEGACY_TIER, LINEUP_PLAN, TIER_ORDER, normalizeTier, type TierId } from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { query, queryOne, transaction } from '../lib/db.js';
import { convertTrial } from '../lib/trials.js';
import { StripeError, appOrigin, periodEnd, stripe, stripeEnabled, verifyWebhook } from '../lib/stripe.js';

/**
 * Stripe checkout, the customer portal, and the webhook that keeps a person's
 * plan in step with Stripe.
 *
 * Buying a plan opens Stripe's own payment page (Checkout). When it's paid,
 * Stripe tells Lineup through the webhook and the plan starts. Changing the
 * card, seeing invoices and cancelling happen in Stripe's customer portal.
 * Renewals, failed payments and a subscription ending come in the same way.
 */

const PAID_TIERS = TIER_ORDER.filter((t) => t !== 'free' && LINEUP_PLAN.tiers[t].priceCents > 0);

/** The yearly price for a plan, found by its lookup key (lineup_<tier>_yearly). */
export function lookupKey(tier: TierId): string {
  return `lineup_${tier}_yearly`;
}

const priceCache = new Map<string, { id: string; at: number }>();

async function priceFor(tier: TierId): Promise<string | null> {
  const cached = priceCache.get(tier);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.id;
  const r = await stripe<{ data: Array<{ id: string }> }>('GET', '/prices', {
    'lookup_keys[]': lookupKey(tier),
    active: 'true',
    limit: 1,
  });
  const id = r.data[0]?.id ?? null;
  if (id) priceCache.set(tier, { id, at: Date.now() });
  return id;
}

function notConfigured(): HttpResponseInit {
  return { status: 503, jsonBody: { error: 'Online payments are not set up yet.', code: 'STRIPE_NOT_CONFIGURED' } };
}

function stripeFailure(ctx: InvocationContext, err: unknown, what: string): HttpResponseInit {
  if (err instanceof StripeError) {
    ctx.warn(`${what} failed`, err.status, err.code, err.message);
    return { status: 502, jsonBody: { error: `Stripe couldn't ${what} right now. Please try again.`, code: 'STRIPE_ERROR' } };
  }
  throw err;
}

/** The person's Stripe customer, made the first time they pay. */
async function customerFor(user: { id: string; email: string | null }): Promise<string> {
  const row = await queryOne<{ stripe_customer_id: string | null; display_name: string | null; email: string | null }>(
    'SELECT stripe_customer_id, display_name, email FROM app_user WHERE id = $1',
    [user.id],
  );
  if (row?.stripe_customer_id) return row.stripe_customer_id;
  const c = await stripe<{ id: string }>(
    'POST',
    '/customers',
    {
      email: row?.email ?? user.email ?? undefined,
      name: row?.display_name ?? undefined,
      metadata: { user_id: user.id, app: 'lineup' },
    },
    `lineup-customer-${user.id}`,
  );
  await query('UPDATE app_user SET stripe_customer_id = $2 WHERE id = $1 AND stripe_customer_id IS NULL', [user.id, c.id]);
  const saved = await queryOne<{ stripe_customer_id: string }>('SELECT stripe_customer_id FROM app_user WHERE id = $1', [user.id]);
  return saved?.stripe_customer_id ?? c.id;
}

/**
 * The organization or region an Organization or Region plan covers: the
 * scope of the person's free trial, or the one they direct. Left empty when
 * it's unclear or already covered by someone else's plan.
 */
async function planScope(userId: string, tier: TierId): Promise<{ orgId: string | null; regionId: string | null }> {
  const none = { orgId: null, regionId: null };
  if (!['region', 'organization', 'organizationPlus'].includes(tier)) return none;
  const trial = await queryOne<{ org_id: string | null; region_id: string | null }>(
    `SELECT org_id, region_id FROM plan_trial WHERE user_id = $1 AND kind = 'scope' AND purged_at IS NULL`,
    [userId],
  );
  let scope = trial && (trial.org_id || trial.region_id) ? { orgId: trial.org_id, regionId: trial.region_id } : none;
  if (!scope.orgId && !scope.regionId) {
    const rows =
      tier === 'region'
        ? await query<{ id: string }>(
            `SELECT r.id FROM membership m JOIN region r ON r.id = m.region_id
              WHERE m.user_id = $1 AND m.role IN ('director', 'region_admin') AND r.deleted_at IS NULL AND NOT r.is_personal`,
            [userId],
          )
        : await query<{ id: string }>(
            `SELECT o.id FROM membership m JOIN organization o ON o.id = m.org_id
              WHERE m.user_id = $1 AND m.role IN ('director', 'org_admin') AND o.deleted_at IS NULL AND NOT o.is_personal`,
            [userId],
          );
    if (rows.length === 1) scope = tier === 'region' ? { orgId: null, regionId: rows[0].id } : { orgId: rows[0].id, regionId: null };
  }
  // One plan per organization or region.
  if (scope.orgId || scope.regionId) {
    const taken = await queryOne(
      `SELECT 1 FROM entitlement WHERE app_id = $1 AND user_id <> $2
          AND ((org_id IS NOT NULL AND org_id = $3) OR (region_id IS NOT NULL AND region_id = $4))`,
      [LINEUP_PLAN.appId, userId, scope.orgId, scope.regionId],
    );
    if (taken) return none;
  }
  return scope;
}

/** A plan this person already pays for through Stripe, still running. */
async function liveStripePlan(userId: string): Promise<{ tier: string; external_ref: string } | null> {
  return (
    (await queryOne<{ tier: string; external_ref: string }>(
      `SELECT tier, external_ref FROM entitlement
        WHERE app_id = $1 AND user_id = $2 AND external_ref LIKE 'stripe:%'
          AND (status = 'active' OR (status = 'cancelled' AND access_until > now()))`,
      [LINEUP_PLAN.appId, userId],
    )) ?? null
  );
}

/** Start buying a plan: returns the address of Stripe's payment page. */
export async function checkoutHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    if (!stripeEnabled()) return notConfigured();

    const b = ((await req.json().catch(() => ({}))) ?? {}) as { tier?: string };
    const tier = normalizeTier(b.tier);
    if (!PAID_TIERS.includes(tier) || b.tier !== tier) return { status: 400, jsonBody: { error: 'Pick one of the paid plans.' } };

    const current = await liveStripePlan(user.id);
    if (current) {
      return {
        status: 409,
        jsonBody: {
          error: 'You already have a paid plan. Use Manage billing to change your card or cancel it.',
          code: 'HAS_SUBSCRIPTION',
        },
      };
    }

    try {
      const price = await priceFor(tier);
      if (!price) return { status: 503, jsonBody: { error: 'This plan is not available to buy yet.', code: 'NO_PRICE' } };
      const customer = await customerFor(user);
      const scope = await planScope(user.id, tier);
      const metadata = {
        app: 'lineup',
        user_id: user.id,
        tier,
        org_id: scope.orgId ?? '',
        region_id: scope.regionId ?? '',
      };
      const origin = appOrigin();
      const session = await stripe<{ id: string; url: string }>('POST', '/checkout/sessions', {
        mode: 'subscription',
        customer,
        client_reference_id: user.id,
        line_items: [{ price, quantity: 1 }],
        allow_promotion_codes: 'true',
        billing_address_collection: 'auto',
        success_url: `${origin}/account?checkout=success`,
        cancel_url: `${origin}/account?checkout=cancel`,
        metadata,
        subscription_data: { metadata },
      });
      return { status: 200, jsonBody: { url: session.url } };
    } catch (err) {
      return stripeFailure(ctx, err, 'start checkout');
    }
  } catch (err) {
    ctx.error('checkout failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/** Open Stripe's customer portal: card, invoices, cancel. */
export async function portalHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    if (!stripeEnabled()) return notConfigured();
    const row = await queryOne<{ stripe_customer_id: string | null }>('SELECT stripe_customer_id FROM app_user WHERE id = $1', [user.id]);
    if (!row?.stripe_customer_id) {
      return { status: 404, jsonBody: { error: 'There is no billing to manage yet.', code: 'NO_CUSTOMER' } };
    }
    try {
      const session = await stripe<{ url: string }>('POST', '/billing_portal/sessions', {
        customer: row.stripe_customer_id,
        return_url: `${appOrigin()}/account`,
      });
      return { status: 200, jsonBody: { url: session.url } };
    } catch (err) {
      return stripeFailure(ctx, err, 'open billing');
    }
  } catch (err) {
    ctx.error('portal failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/* --------------------------------------------------------------- webhook */

type Sub = Record<string, any>;

function tierOf(sub: Sub): TierId | null {
  const item = sub.items?.data?.[0];
  const raw: string | undefined =
    sub.metadata?.tier ?? item?.price?.metadata?.tier ?? /^lineup_(\w+)_yearly$/.exec(item?.price?.lookup_key ?? '')?.[1];
  const tier = normalizeTier(raw);
  // Older subscriptions may carry a merged plan's id (teamParent -> parent).
  return raw && (tier === raw || LEGACY_TIER[raw] === tier) && PAID_TIERS.includes(tier) ? tier : null;
}

async function userForCustomer(customer: unknown): Promise<string | null> {
  if (typeof customer !== 'string') return null;
  const row = await queryOne<{ id: string }>('SELECT id FROM app_user WHERE stripe_customer_id = $1', [customer]);
  return row?.id ?? null;
}

async function notify(userId: string, title: string, body: string): Promise<void> {
  await query(`INSERT INTO notification (user_id, kind, title, body, link) VALUES ($1, 'system', $2, $3, '/account')`, [
    userId,
    title,
    body,
  ]);
}

/**
 * Bring the person's plan in line with their Stripe subscription. A newer
 * plan is never overwritten by an older subscription's late event.
 */
export async function applySubscription(sub: Sub, fallbackUserId: string | null, ctx?: InvocationContext): Promise<string> {
  const userId = (sub.metadata?.user_id as string | undefined) || fallbackUserId || (await userForCustomer(sub.customer));
  if (!userId) return 'no user';
  const tier = tierOf(sub);
  if (!tier) return 'no tier';
  const ref = `stripe:${sub.id}`;
  const end = periodEnd(sub);
  const status: string = sub.status;

  if (['canceled', 'unpaid', 'incomplete_expired'].includes(status)) {
    await query(
      `UPDATE entitlement SET status = 'expired', access_until = LEAST(COALESCE(access_until, now()), now()),
              cancelled_at = COALESCE(cancelled_at, now())
        WHERE app_id = $1 AND user_id = $2 AND external_ref = $3`,
      [LINEUP_PLAN.appId, userId, ref],
    );
    return 'ended';
  }
  // Not paid yet: the plan starts with the first successful payment.
  if (!['active', 'trialing', 'past_due'].includes(status)) return `waiting (${status})`;

  const cancelAt = sub.cancel_at ? new Date(Number(sub.cancel_at) * 1000) : null;
  const cancelling = Boolean(sub.cancel_at_period_end || cancelAt);
  const accessUntil = cancelling ? cancelAt ?? end : end;
  const orgId = (sub.metadata?.org_id as string) || null;
  const regionId = (sub.metadata?.region_id as string) || null;

  const result = await transaction(async (c) => {
    const existing = await c.query<{ external_ref: string | null; status: string }>(
      'SELECT external_ref, status FROM entitlement WHERE app_id = $1 AND user_id = $2 FOR UPDATE',
      [LINEUP_PLAN.appId, userId],
    );
    const prev = existing.rows[0];
    // Another live Stripe plan is newer than this event: leave it alone.
    if (prev?.external_ref?.startsWith('stripe:') && prev.external_ref !== ref && prev.status !== 'expired') {
      return 'kept newer plan';
    }
    await c.query(
      `INSERT INTO entitlement (app_id, user_id, org_id, region_id, tier, status, cancelled_at, access_until, external_ref, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)
       ON CONFLICT (app_id, user_id) DO UPDATE SET
         org_id = EXCLUDED.org_id, region_id = EXCLUDED.region_id, tier = EXCLUDED.tier,
         status = EXCLUDED.status,
         cancelled_at = CASE WHEN EXCLUDED.status = 'cancelled' THEN COALESCE(entitlement.cancelled_at, now()) END,
         access_until = EXCLUDED.access_until,
         external_ref = EXCLUDED.external_ref, expires_at = NULL`,
      [
        LINEUP_PLAN.appId,
        userId,
        orgId,
        regionId,
        tier,
        cancelling ? 'cancelled' : 'active',
        cancelling ? new Date() : null,
        accessUntil,
        ref,
      ],
    );
    const isNew = prev?.external_ref !== ref;
    if (isNew) await convertTrial(c, userId, tier);
    return isNew ? 'started' : cancelling ? 'cancelling' : 'active';
  });
  if (result === 'started') {
    await notify(
      userId,
      `You're on the ${LINEUP_PLAN.tiers[tier].name} plan`,
      `Thanks for subscribing. Your ${LINEUP_PLAN.tiers[tier].name} plan is active now.`,
    ).catch((e) => ctx?.warn('plan notify failed', e));
  }
  return result;
}

async function handleEvent(event: Record<string, any>, ctx: InvocationContext): Promise<string> {
  const obj = event.data?.object ?? {};
  switch (event.type) {
    case 'checkout.session.completed': {
      if (obj.mode !== 'subscription' || !obj.subscription) return 'ignored';
      const userId = (obj.client_reference_id as string) || (obj.metadata?.user_id as string) || null;
      if (userId && typeof obj.customer === 'string') {
        await query('UPDATE app_user SET stripe_customer_id = COALESCE(stripe_customer_id, $2) WHERE id = $1', [userId, obj.customer]);
      }
      const promo = (obj.discounts ?? []).map((d: any) => d?.promotion_code).find((p: unknown) => typeof p === 'string');
      if (promo) {
        await query('UPDATE coupon SET redemptions = redemptions + 1 WHERE stripe_promotion_code_id = $1', [promo]);
      }
      const sub = await stripe<Sub>('GET', `/subscriptions/${obj.subscription}`);
      return applySubscription(sub, userId, ctx);
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return applySubscription(obj, null, ctx);
    case 'invoice.payment_failed': {
      const userId = await userForCustomer(obj.customer);
      if (userId) {
        await notify(
          userId,
          "Your payment didn't go through",
          'Stripe could not charge your card for your Lineup plan. Open Account, then Manage billing, to update your card.',
        );
      }
      return userId ? 'told the subscriber' : 'no user';
    }
    default:
      return 'ignored';
  }
}

/** Stripe's webhook: signed, handled once per event. */
export async function stripeWebhookHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const payload = await req.text();
  if (!verifyWebhook(payload, req.headers.get('stripe-signature'))) {
    return { status: 400, jsonBody: { error: 'Bad signature' } };
  }
  let event: Record<string, any>;
  try {
    event = JSON.parse(payload);
  } catch {
    return { status: 400, jsonBody: { error: 'Bad payload' } };
  }
  // A live event can never change a test environment, or the other way round.
  const liveKey = /^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY ?? '');
  if (Boolean(event.livemode) !== liveKey) return { status: 200, jsonBody: { ignored: 'mode mismatch' } };

  const fresh = await queryOne('INSERT INTO stripe_event (id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id', [
    String(event.id),
    String(event.type),
  ]);
  if (!fresh) return { status: 200, jsonBody: { duplicate: true } };
  try {
    const outcome = await handleEvent(event, ctx);
    ctx.log('stripe event', event.type, event.id, outcome);
    return { status: 200, jsonBody: { received: true, outcome } };
  } catch (err) {
    // Let Stripe retry: forget the event so the retry is handled.
    await query('DELETE FROM stripe_event WHERE id = $1', [String(event.id)]).catch(() => undefined);
    ctx.error('stripe webhook failed', event.type, err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('billingCheckout', { methods: ['POST'], authLevel: 'anonymous', route: 'billing/checkout', handler: checkoutHandler });
app.http('billingPortal', { methods: ['POST'], authLevel: 'anonymous', route: 'billing/portal', handler: portalHandler });
app.http('stripeWebhook', { methods: ['POST'], authLevel: 'anonymous', route: 'stripe/webhook', handler: stripeWebhookHandler });

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { LINEUP_PLAN, TIER_ORDER, normalizeTier, type TierId } from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { query, queryOne, transaction } from '../lib/db.js';
import { paywallEnabled } from '../lib/entitlements.js';
import { REFUND_MONTHLY_CAP_CENTS, StripeError, monthStart, stripe, stripeEnabled, stripeMode } from '../lib/stripe.js';
import { requireAdmin } from './admin.js';
import { applySubscription, lookupKey } from './stripe.js';

/**
 * Billing in the admin console: coupons, refund requests, a money summary
 * and the status of every connected service. With Stripe connected, coupons
 * become Stripe promotion codes people can enter at checkout, and an approved
 * refund is sent back to the customer's card through Stripe, up to $300 in a
 * calendar month (Pacific time). Anything over the cap is done by hand in the
 * Stripe dashboard.
 */

const PAID_TIERS = TIER_ORDER.filter((t) => t !== 'free');
const CODE_RE = /^[A-Z0-9-]{3,32}$/;

function clip(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

type IntegrationStatus = 'connected' | 'not_connected' | 'off' | 'pending' | 'error';

interface Integration {
  key: string;
  name: string;
  status: IntegrationStatus;
  detail: string;
}

/**
 * What each service is and whether it is set up, from configuration only.
 * Never returns a secret: presence, mode and public values like the sender.
 */
async function integrations(): Promise<Integration[]> {
  const env = process.env;
  let db: Integration;
  try {
    await queryOne('SELECT 1');
    db = { key: 'database', name: 'Database (Azure PostgreSQL)', status: 'connected', detail: 'Responding' };
  } catch {
    db = { key: 'database', name: 'Database (Azure PostgreSQL)', status: 'error', detail: 'Not responding' };
  }

  const stripeKey = env.STRIPE_SECRET_KEY ?? '';
  const mode = stripeMode();
  const stripeIntegration: Integration = !stripeKey
    ? {
        key: 'stripe',
        name: 'Payments (Stripe)',
        status: 'not_connected',
        detail: 'Not connected yet. Checkout, coupons and refunds go live with Stripe subscriptions.',
      }
    : !stripeEnabled()
      ? {
          key: 'stripe',
          name: 'Payments (Stripe)',
          status: 'error',
          detail:
            env.APP_ENV === 'prd'
              ? 'Live key set, but the webhook secret is missing, so checkout stays off until the webhook is created (infra/stripe-setup.cjs prd --live).'
              : 'A live key is set outside production, so payments are switched off here.',
        }
      : {
          key: 'stripe',
          name: 'Payments (Stripe)',
          status: 'connected',
          detail: `${mode === 'live' ? 'Live mode' : 'Test mode (sandbox, no real money)'}${
            env.STRIPE_WEBHOOK_SECRET ? '' : '. Webhook secret missing: plans won’t update after payment.'
          }`,
        };

  const allowlist = (env.ADMIN_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  return [
    {
      key: 'signin',
      name: 'Sign-in (Microsoft Entra External ID)',
      status: env.LINEUP_OIDC_CLIENT_SECRET ? 'connected' : 'not_connected',
      detail: env.LINEUP_OIDC_CLIENT_SECRET ? 'Email and social sign-in' : 'Client secret missing',
    },
    db,
    {
      key: 'email',
      name: 'Email (Azure Communication Services)',
      status: env.ACS_CONNECTION_STRING && env.EMAIL_SENDER ? 'connected' : 'not_connected',
      detail:
        env.ACS_CONNECTION_STRING && env.EMAIL_SENDER
          ? `Sends as ${env.EMAIL_SENDER}`
          : 'Invites are shared as links instead of emailed',
    },
    stripeIntegration,
    {
      key: 'paywall',
      name: 'Paywall',
      status: paywallEnabled() ? 'connected' : 'off',
      detail: paywallEnabled()
        ? 'On: plan limits and paid features are enforced'
        : 'Off: everyone has every feature (early access)',
    },
    {
      key: 'ads',
      name: 'Ads (Google AdSense web, AdMob Android)',
      status: 'pending',
      detail: 'Managed in Google AdSense and AdMob. Web ad units go in once AdSense approves mahoul.io.',
    },
    {
      key: 'admins',
      name: 'Admin access list',
      status: allowlist.length ? 'connected' : 'not_connected',
      detail: `${allowlist.length} account${allowlist.length === 1 ? '' : 's'} on the list, plus platform admins in the database`,
    },
  ];
}

interface CouponRow {
  id: string;
  code: string;
  percent_off: number | null;
  amount_off_cents: number | null;
  tiers: string[];
  max_redemptions: number | null;
  redemptions: number;
  expires_at: Date | null;
  active: boolean;
  note: string | null;
  created_at: Date;
  created_by_name: string | null;
}

function toCoupon(r: CouponRow) {
  return {
    id: r.id,
    code: r.code,
    percentOff: r.percent_off,
    amountOffCents: r.amount_off_cents,
    tiers: r.tiers,
    maxRedemptions: r.max_redemptions,
    redemptions: r.redemptions,
    expiresAt: r.expires_at?.toISOString() ?? null,
    active: r.active,
    expired: Boolean(r.expires_at && r.expires_at < new Date()),
    note: r.note,
    createdAt: r.created_at.toISOString(),
    createdBy: r.created_by_name,
  };
}

const REFUND_STATUSES = ['approved', 'declined', 'refunded'] as const;

const REFUNDED_SQL = 'SELECT COALESCE(SUM(amount_cents), 0)::int AS n FROM refund_request WHERE refunded_at >= $1';

/** Refunds Lineup sent this calendar month (Pacific), in cents. */
async function refundedThisMonth(): Promise<number> {
  return (await queryOne<{ n: number }>(REFUNDED_SQL, [monthStart()]))?.n ?? 0;
}

/** Money in this month from Stripe, and paid plans and refunds from Lineup. */
async function moneySummary() {
  const start = monthStart();
  const [refunded, plans] = await Promise.all([
    refundedThisMonth(),
    queryOne<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM entitlement
        WHERE app_id = 'lineup' AND external_ref LIKE 'stripe:%'
          AND (status = 'active' OR (status = 'cancelled' AND access_until > now()))`,
    ),
  ]);
  let revenueCents: number | null = null;
  if (stripeEnabled()) {
    try {
      const invoices = await stripe<{ data: Array<{ amount_paid: number }> }>('GET', '/invoices', {
        status: 'paid',
        'created[gte]': Math.floor(start.getTime() / 1000),
        limit: 100,
      });
      revenueCents = invoices.data.reduce((sum, i) => sum + (i.amount_paid ?? 0), 0);
    } catch {
      revenueCents = null;
    }
  }
  return {
    mode: stripeEnabled() ? stripeMode() : null,
    monthStart: start.toISOString(),
    revenueCents,
    activePaidPlans: plans?.n ?? 0,
    refundedCents: refunded,
    refundCapCents: REFUND_MONTHLY_CAP_CENTS,
  };
}

/** Product ids for the plans a coupon covers, for Stripe's applies_to. */
async function productsFor(tiers: string[]): Promise<string[]> {
  if (tiers.length === 0) return [];
  const prices = await stripe<{ data: Array<{ product: string }> }>('GET', '/prices', {
    lookup_keys: tiers.map((t) => lookupKey(t as TierId)),
    limit: 20,
  });
  return [...new Set(prices.data.map((p) => p.product))];
}

export async function adminBillingHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const admin = await requireAdmin(req);
    if (!admin) return { status: 403, jsonBody: { error: 'Not permitted', code: 'FORBIDDEN' } };

    if (req.method === 'GET') {
      const [svc, coupons, refunds, subs, money] = await Promise.all([
        integrations(),
        query<CouponRow>(
          `SELECT c.*, u.display_name AS created_by_name
             FROM coupon c LEFT JOIN app_user u ON u.id = c.created_by
            ORDER BY c.active DESC, c.created_at DESC LIMIT 200`,
        ),
        query<{
          id: string; user_id: string; email: string | null; name: string | null; tier: string;
          reason: string; status: string; admin_note: string | null; decided_at: Date | null;
          decided_by_name: string | null; created_at: Date; amount_cents: number | null; refunded_at: Date | null;
          stripe_customer_id: string | null;
        }>(
          `SELECT r.id, r.user_id, u.email, u.display_name AS name, r.tier, r.reason, r.status,
                  r.admin_note, r.decided_at, d.display_name AS decided_by_name, r.created_at,
                  r.amount_cents, r.refunded_at, u.stripe_customer_id
             FROM refund_request r
             JOIN app_user u ON u.id = r.user_id
             LEFT JOIN app_user d ON d.id = r.decided_by
            ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT 200`,
        ),
        query<{ tier: string; n: string }>(
          `SELECT tier, COUNT(*) AS n FROM entitlement
            WHERE app_id = 'lineup' AND tier <> 'free'
              AND external_ref IS DISTINCT FROM 'trial'
              AND (status = 'active' OR (status = 'cancelled' AND access_until > now()))
            GROUP BY tier`,
        ),
        moneySummary(),
      ]);
      const subscribers: Record<string, number> = {};
      for (const s of subs) {
        const t = normalizeTier(s.tier);
        subscribers[t] = (subscribers[t] ?? 0) + Number(s.n);
      }
      return {
        status: 200,
        jsonBody: {
          integrations: svc,
          coupons: coupons.map(toCoupon),
          refunds: refunds.map((r) => ({
            id: r.id,
            userId: r.user_id,
            email: r.email,
            name: r.name,
            tier: normalizeTier(r.tier),
            reason: r.reason,
            status: r.status,
            adminNote: r.admin_note,
            decidedAt: r.decided_at?.toISOString() ?? null,
            decidedBy: r.decided_by_name,
            createdAt: r.created_at.toISOString(),
            amountCents: r.amount_cents,
            refundedAt: r.refunded_at?.toISOString() ?? null,
            // Paid through Stripe, so Lineup can send the refund itself.
            canIssue: stripeEnabled() && Boolean(r.stripe_customer_id) && ['pending', 'approved'].includes(r.status),
          })),
          subscribers,
          prices: Object.fromEntries(PAID_TIERS.map((t) => [t, LINEUP_PLAN.tiers[t].priceCents])),
          money,
        },
      };
    }

    const b = (await req.json()) as Record<string, unknown>;
    const action = String(b.action ?? '');

    if (action === 'coupon.create') {
      const code = clip(b.code, 32).toUpperCase();
      if (!CODE_RE.test(code)) {
        return { status: 400, jsonBody: { error: 'Use 3 to 32 letters, numbers or dashes for the code.' } };
      }
      const percent = b.percentOff == null || b.percentOff === '' ? null : Math.round(Number(b.percentOff));
      const amount = b.amountOffCents == null || b.amountOffCents === '' ? null : Math.round(Number(b.amountOffCents));
      if ((percent === null) === (amount === null)) {
        return { status: 400, jsonBody: { error: 'Set either a percent off or an amount off.' } };
      }
      if (percent !== null && !(percent >= 1 && percent <= 100)) {
        return { status: 400, jsonBody: { error: 'Percent off must be between 1 and 100.' } };
      }
      if (amount !== null && !(amount > 0)) {
        return { status: 400, jsonBody: { error: 'Amount off must be more than $0.' } };
      }
      const tiers = Array.isArray(b.tiers) ? (b.tiers as unknown[]).map(String).filter((t) => (PAID_TIERS as string[]).includes(t)) : [];
      const max = b.maxRedemptions == null || b.maxRedemptions === '' ? null : Math.round(Number(b.maxRedemptions));
      if (max !== null && !(max > 0)) return { status: 400, jsonBody: { error: 'Max uses must be at least 1.' } };
      const expires = clip(b.expiresAt, 10);
      if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
        return { status: 400, jsonBody: { error: 'Pick a valid end date.' } };
      }
      const exists = await queryOne('SELECT 1 FROM coupon WHERE code = $1', [code]);
      if (exists) return { status: 409, jsonBody: { error: `The code ${code} already exists.` } };
      // With Stripe connected the code is also a Stripe promotion code, so
      // people can enter it at checkout.
      let stripeIds: { coupon: string; promo: string } | null = null;
      if (stripeEnabled()) {
        try {
          const products = await productsFor(tiers);
          const redeemBy = expires ? Math.floor(new Date(`${expires}T23:59:59-08:00`).getTime() / 1000) : undefined;
          const sc = await stripe<{ id: string }>('POST', '/coupons', {
            name: code,
            duration: 'once',
            ...(percent !== null ? { percent_off: percent } : { amount_off: amount, currency: 'usd' }),
            ...(max !== null ? { max_redemptions: max } : {}),
            ...(redeemBy ? { redeem_by: redeemBy } : {}),
            ...(products.length ? { applies_to: { products } } : {}),
            metadata: { app: 'lineup' },
          });
          const promo = await stripe<{ id: string }>('POST', '/promotion_codes', {
            // Newer API versions take the coupon under "promotion"; older ones as "coupon".
            coupon: sc.id,
            code,
            metadata: { app: 'lineup' },
          }).catch(async (err) => {
            if (err instanceof StripeError && err.status === 400) {
              return stripe<{ id: string }>('POST', '/promotion_codes', {
                promotion: { type: 'coupon', coupon: sc.id },
                code,
                metadata: { app: 'lineup' },
              });
            }
            throw err;
          });
          stripeIds = { coupon: sc.id, promo: promo.id };
        } catch (err) {
          if (err instanceof StripeError) {
            ctx.warn('stripe coupon failed', err.status, err.code, err.message);
            return { status: 502, jsonBody: { error: `Stripe couldn't create the code: ${err.message}` } };
          }
          throw err;
        }
      }
      const row = await queryOne<CouponRow>(
        `INSERT INTO coupon (code, percent_off, amount_off_cents, tiers, max_redemptions, expires_at, note, created_by,
                             stripe_coupon_id, stripe_promotion_code_id)
         VALUES ($1, $2, $3, $4, $5, $6::date + interval '1 day' - interval '1 second', $7, $8, $9, $10)
         RETURNING *, NULL::text AS created_by_name`,
        [
          code, percent, amount, tiers, max, expires || null, clip(b.note, 200) || null, admin.id,
          stripeIds?.coupon ?? null, stripeIds?.promo ?? null,
        ],
      );
      return { status: 201, jsonBody: toCoupon(row!) };
    }

    if (action === 'coupon.toggle') {
      const active = Boolean(b.active);
      const current = await queryOne<{ stripe_promotion_code_id: string | null }>(
        'SELECT stripe_promotion_code_id FROM coupon WHERE id = $1',
        [clip(b.id, 36)],
      );
      if (current?.stripe_promotion_code_id && stripeEnabled()) {
        try {
          await stripe('POST', `/promotion_codes/${current.stripe_promotion_code_id}`, { active: active ? 'true' : 'false' });
        } catch (err) {
          if (err instanceof StripeError) {
            return { status: 502, jsonBody: { error: `Stripe couldn't update the code: ${err.message}` } };
          }
          throw err;
        }
      }
      const row = await queryOne<CouponRow>(
        'UPDATE coupon SET active = $2 WHERE id = $1 RETURNING *, NULL::text AS created_by_name',
        [clip(b.id, 36), active],
      );
      if (!row) return { status: 404, jsonBody: { error: 'Coupon not found' } };
      return { status: 200, jsonBody: toCoupon(row) };
    }

    if (action === 'refund.issue') {
      return issueRefund(admin.id, b, ctx);
    }

    if (action === 'refund.decide') {
      const status = String(b.status ?? '');
      if (!(REFUND_STATUSES as readonly string[]).includes(status)) {
        return { status: 400, jsonBody: { error: 'status must be approved, declined or refunded' } };
      }
      const note = clip(b.note, 500) || null;
      const row = await queryOne<{ id: string; user_id: string }>(
        `UPDATE refund_request SET status = $2, admin_note = $3, decided_by = $4, decided_at = now()
          WHERE id = $1 RETURNING id, user_id`,
        [clip(b.id, 36), status, note, admin.id],
      );
      if (!row) return { status: 404, jsonBody: { error: 'Refund request not found' } };
      const message =
        status === 'declined'
          ? 'Your refund request was declined.'
          : status === 'refunded'
            ? 'Your refund has been issued.'
            : 'Your refund request was approved. The refund is issued to your original payment method.';
      await query(
        `INSERT INTO notification (user_id, kind, title, body, link) VALUES ($1, 'system', 'Refund request', $2, '/account')`,
        [row.user_id, note ? `${message} Note: ${note}` : message],
      ).catch((e) => ctx.warn('refund notify failed', e));
      return { status: 200, jsonBody: { id: row.id, status } };
    }

    return { status: 400, jsonBody: { error: 'Unknown action' } };
  } catch (err) {
    ctx.error('admin billing failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/**
 * Send an approved refund back to the customer's card through Stripe. The
 * month's refunds can't go over the $300 cap; the check and the refund run
 * under one lock so two admins can't both squeeze under it. By default the
 * plan ends now as well.
 */
async function issueRefund(adminId: string, b: Record<string, unknown>, ctx: InvocationContext): Promise<HttpResponseInit> {
  if (!stripeEnabled()) {
    return { status: 503, jsonBody: { error: 'Stripe is not connected, so refunds are records only.', code: 'STRIPE_NOT_CONFIGURED' } };
  }
  const id = clip(b.id, 36);
  const reqRow = await queryOne<{ id: string; user_id: string; status: string; tier: string; customer: string | null }>(
    `SELECT r.id, r.user_id, r.status, r.tier, u.stripe_customer_id AS customer
       FROM refund_request r JOIN app_user u ON u.id = r.user_id WHERE r.id = $1`,
    [id],
  );
  if (!reqRow) return { status: 404, jsonBody: { error: 'Refund request not found' } };
  if (!['pending', 'approved'].includes(reqRow.status)) {
    return { status: 409, jsonBody: { error: 'This request has already been refunded or declined.' } };
  }
  if (!reqRow.customer) {
    return { status: 400, jsonBody: { error: 'This person did not pay through Stripe. Refund them by hand.', code: 'NO_CUSTOMER' } };
  }
  const note = clip(b.note, 500) || null;
  const endPlan = b.endPlan !== false;

  try {
    // The most recent payment that still has money left to refund.
    const charges = await stripe<{ data: Array<{ id: string; amount: number; amount_refunded: number; paid: boolean; status: string }> }>(
      'GET',
      '/charges',
      { customer: reqRow.customer, limit: 10 },
    );
    const charge = charges.data.find((c) => c.paid && c.status === 'succeeded' && c.amount_refunded < c.amount);
    if (!charge) return { status: 400, jsonBody: { error: 'No payment to refund was found in Stripe.', code: 'NO_CHARGE' } };
    const left = charge.amount - charge.amount_refunded;
    const asked = b.amountCents == null || b.amountCents === '' ? left : Math.round(Number(b.amountCents));
    if (!(asked > 0) || asked > left) {
      return { status: 400, jsonBody: { error: `Refund between $0.01 and $${(left / 100).toFixed(2)}.` } };
    }

    const outcome = await transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext('lineup-refund-cap'))");
      const used = (await c.query<{ n: number }>(REFUNDED_SQL, [monthStart()])).rows[0]?.n ?? 0;
      if (used + asked > REFUND_MONTHLY_CAP_CENTS) {
        return { capped: true as const, used };
      }
      const refund = await stripe<{ id: string; status: string }>(
        'POST',
        '/refunds',
        { charge: charge.id, amount: asked, reason: 'requested_by_customer', metadata: { refund_request_id: id, app: 'lineup' } },
        `lineup-refund-${id}-${asked}`,
      );
      await c.query(
        `UPDATE refund_request
            SET status = 'refunded', amount_cents = $2, stripe_refund_id = $3, refunded_at = now(),
                admin_note = COALESCE($4, admin_note), decided_by = $5, decided_at = now()
          WHERE id = $1`,
        [id, asked, refund.id, note, adminId],
      );
      return { capped: false as const, used: used + asked, refundId: refund.id };
    });

    if (outcome.capped) {
      const left = Math.max(0, REFUND_MONTHLY_CAP_CENTS - outcome.used);
      return {
        status: 409,
        jsonBody: {
          error: `That would go over the $${(REFUND_MONTHLY_CAP_CENTS / 100).toFixed(0)} monthly refund limit ($${(left / 100).toFixed(2)} left this month). Do this one in the Stripe dashboard.`,
          code: 'REFUND_CAP',
          remainingCents: left,
        },
      };
    }

    let planEnded = false;
    if (endPlan) {
      const ent = await queryOne<{ external_ref: string | null }>(
        `SELECT external_ref FROM entitlement WHERE app_id = 'lineup' AND user_id = $1 AND external_ref LIKE 'stripe:%'`,
        [reqRow.user_id],
      );
      if (ent?.external_ref) {
        const sub = await stripe<Record<string, any>>('DELETE', `/subscriptions/${ent.external_ref.slice('stripe:'.length)}`).catch(
          (err) => {
            ctx.warn('ending subscription after refund failed', err);
            return null;
          },
        );
        if (sub) {
          await applySubscription(sub, reqRow.user_id, ctx);
          planEnded = true;
        }
      }
    }

    await query(
      `INSERT INTO notification (user_id, kind, title, body, link) VALUES ($1, 'system', 'Refund issued', $2, '/account')`,
      [
        reqRow.user_id,
        `Your refund of $${(asked / 100).toFixed(2)} is on its way to your original payment method. It usually shows up in 5 to 10 days.${
          planEnded ? ' Your plan has ended.' : ''
        }${note ? ` Note: ${note}` : ''}`,
      ],
    ).catch((e) => ctx.warn('refund notify failed', e));

    return {
      status: 200,
      jsonBody: {
        id,
        status: 'refunded',
        amountCents: asked,
        planEnded,
        refundedThisMonthCents: outcome.used,
        refundCapCents: REFUND_MONTHLY_CAP_CENTS,
      },
    };
  } catch (err) {
    if (err instanceof StripeError) {
      ctx.warn('stripe refund failed', err.status, err.code, err.message);
      return { status: 502, jsonBody: { error: `Stripe couldn't send the refund: ${err.message}` } };
    }
    throw err;
  }
}

/** A subscriber asks for a refund of their own plan. */
export async function refundsHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    if (req.method === 'GET') {
      const rows = await query<{ id: string; tier: string; reason: string; status: string; admin_note: string | null; created_at: Date; decided_at: Date | null }>(
        `SELECT id, tier, reason, status, admin_note, created_at, decided_at
           FROM refund_request WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [user.id],
      );
      return {
        status: 200,
        jsonBody: rows.map((r) => ({
          id: r.id,
          tier: normalizeTier(r.tier),
          reason: r.reason,
          status: r.status,
          adminNote: r.admin_note,
          createdAt: r.created_at.toISOString(),
          decidedAt: r.decided_at?.toISOString() ?? null,
        })),
      };
    }

    const b = (await req.json()) as { reason?: string };
    const reason = clip(b.reason, 1000);
    if (reason.length < 5) return { status: 400, jsonBody: { error: 'Tell us briefly why you would like a refund.' } };

    // Only the person who pays for a plan can ask for its refund, and only
    // once they have cancelled it (Fady, 10/16): a refund ends the plan.
    const plan = await queryOne<{ tier: string; status: string }>(
      `SELECT tier, status FROM entitlement
        WHERE app_id = 'lineup' AND user_id = $1 AND tier <> 'free'
          AND (status = 'active' OR (status = 'cancelled' AND access_until > now()))
        ORDER BY (status = 'cancelled') DESC
        LIMIT 1`,
      [user.id],
    );
    if (!plan) return { status: 400, jsonBody: { error: 'You do not have a paid plan to refund.' } };
    if (plan.status !== 'cancelled') {
      return {
        status: 409,
        jsonBody: {
          error: 'Cancel your subscription first (Account, Manage billing), then request a refund.',
          code: 'CANCEL_FIRST',
        },
      };
    }

    const open = await queryOne('SELECT 1 FROM refund_request WHERE user_id = $1 AND status = $2', [user.id, 'pending']);
    if (open) return { status: 409, jsonBody: { error: 'You already have a refund request waiting for review.' } };

    const row = await queryOne<{ id: string }>(
      'INSERT INTO refund_request (user_id, tier, reason) VALUES ($1, $2, $3) RETURNING id',
      [user.id, normalizeTier(plan.tier), reason],
    );
    return { status: 201, jsonBody: { id: row!.id, status: 'pending' } };
  } catch (err) {
    ctx.error('refunds failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('adminBilling', {
  methods: ['GET', 'POST'], authLevel: 'anonymous', route: 'console/billing', handler: adminBillingHandler,
});
app.http('refunds', {
  methods: ['GET', 'POST'], authLevel: 'anonymous', route: 'refunds', handler: refundsHandler,
});

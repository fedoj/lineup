import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { LINEUP_PLAN, effectiveLimits, effectiveTier, tierFeatures } from '@lineup/shared';
import { requireUser, resolveUser } from '../lib/auth.js';
import { isPlatformAdmin } from '../lib/authz.js';
import { query, queryOne } from '../lib/db.js';
import { getAccountUsage, getEntitlement, paywallEnabled } from '../lib/entitlements.js';
import { getImpersonation } from '../lib/impersonation.js';
import { stripeEnabled, stripeMode } from '../lib/stripe.js';
import { getTrialStatus, settleTrials } from '../lib/trials.js';

/**
 * Current Terms of Use and Privacy Policy revision. Bump it when either
 * changes materially and everyone is asked to accept again.
 */
export const TERMS_VERSION = '2026-10-17';

/** Who am I, what plan am I on, and how much have I used. */
export async function meHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const resolved = await resolveUser(req);
    if (resolved?.block === 'signout') {
      // Acknowledge once: the app now sends the browser through /.auth/logout,
      // and the next sign-in starts clean.
      await query('UPDATE app_user SET signout_acked_at = now() WHERE id = $1', [resolved.user.id]);
      return { status: 401, jsonBody: { error: 'You were signed out. Please sign in again.', code: 'SIGNED_OUT' } };
    }
    if (resolved?.block === 'disabled') {
      return {
        status: 403,
        jsonBody: {
          error: 'This account has been disabled. Contact support through mahoul.io/support.',
          code: 'ACCOUNT_DISABLED',
        },
      };
    }
    if (resolved?.block === 'deactivated') {
      // Closed by the person themselves: the app offers "Reactivate".
      const due = await queryOne<{ execute_at: Date }>(
        `SELECT execute_at FROM deletion_request
          WHERE user_id = $1 AND scope = 'account' AND executed_at IS NULL AND cancelled_at IS NULL
          ORDER BY execute_at LIMIT 1`,
        [resolved.user.id],
      );
      return {
        status: 403,
        jsonBody: {
          error: 'Your account is deactivated.',
          code: 'ACCOUNT_DEACTIVATED',
          details: { deletesAt: due?.execute_at.toISOString() ?? null, email: resolved.user.email },
        },
      };
    }
    const user = resolved?.user ?? null;
    if (!user) {
      return { status: 401, jsonBody: { error: 'Not authenticated' } };
    }

    const [entitlement, usage, impersonation, terms, trial, referee, billingRow, platformAdmin] = await Promise.all([
      getEntitlement(user.id),
      getAccountUsage(user.id),
      getImpersonation(user.id),
      queryOne<{ terms_version: string | null; age_confirmed_at: Date | null }>(
        'SELECT terms_version, age_confirmed_at FROM app_user WHERE id = $1',
        [user.id],
      ),
      settleTrials()
        .catch((err) => ctx.warn('settle trials failed', err))
        .then(() => getTrialStatus(user.id))
        .catch(() => null),
      // Referees get their own screen in the menu.
      queryOne<{ n: number }>('SELECT COUNT(*)::int AS n FROM referee WHERE user_id = $1', [user.id]).catch(() => null),
      // Online billing: whether Stripe is on here, and whether this person pays through it.
      queryOne<{ customer: string | null; ref: string | null }>(
        `SELECT u.stripe_customer_id AS customer,
                (SELECT e.external_ref FROM entitlement e WHERE e.app_id = $2 AND e.user_id = u.id
                    AND e.external_ref LIKE 'stripe:%'
                    AND (e.status = 'active' OR (e.status = 'cancelled' AND e.access_until > now()))) AS ref
           FROM app_user u WHERE u.id = $1`,
        [user.id, LINEUP_PLAN.appId],
      ).catch(() => null),
      isPlatformAdmin(user.id),
    ]);

    // An impersonated tier is enforced as if the paywall were on, so the
    // reported limits match what the user will actually hit.
    const enabled = impersonation.tier ? true : paywallEnabled();
    const effective = impersonation.tier
      ? ({
          appId: LINEUP_PLAN.appId,
          userId: user.id,
          tier: impersonation.tier,
          grantedAt: new Date().toISOString(),
          status: 'active' as const,
          accessUntil: null,
        })
      : entitlement;
    const tier = enabled ? effectiveTier(effective) : 'organization';

    return {
      status: 200,
      jsonBody: {
        user: { id: user.id, email: user.email, provider: user.provider },
        tier,
        paywallEnabled: enabled,
        // Per-team limits are reported alongside each team, not here.
        usage,
        limits: effectiveLimits(LINEUP_PLAN, effective, enabled),
        features: enabled ? tierFeatures(tier) : LINEUP_PLAN.tiers.organization.features,
        impersonation,
        subscription: entitlement
          ? {
              status: entitlement.status ?? 'active',
              accessUntil: entitlement.accessUntil ?? null,
              scope: entitlement.orgId ? 'org' : entitlement.regionId ? 'region' : 'personal',
            }
          : null,
        // Free trials: running, ended, and which ones can still be started.
        trial,
        plan: LINEUP_PLAN,
        refereeOrgs: referee?.n ?? 0,
        // Platform admins get the admin console check; nobody else needs to ask.
        platformAdmin,
        billing: {
          checkout: stripeEnabled(),
          mode: stripeEnabled() ? stripeMode() : null,
          // Can open Stripe's portal (card, invoices, cancel).
          portal: stripeEnabled() && Boolean(billingRow?.customer),
          // The current plan is paid through Stripe.
          stripePlan: Boolean(billingRow?.ref),
        },
        terms: {
          version: TERMS_VERSION,
          accepted: terms?.terms_version === TERMS_VERSION && Boolean(terms?.age_confirmed_at),
        },
      },
    };
  } catch (err) {
    ctx.error('me failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/**
 * Accept the current Terms of Use and Privacy Policy and confirm being 18 or
 * older. Both are required; the app is not available until they are given.
 */
export async function acceptTermsHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    const b = (await req.json()) as { version?: string; over18?: boolean; agree?: boolean };
    if (b.version !== TERMS_VERSION) {
      return { status: 409, jsonBody: { error: 'The terms have changed. Reload and review them again.' } };
    }
    if (b.over18 !== true || b.agree !== true) {
      return {
        status: 400,
        jsonBody: { error: 'You must confirm you are 18 or older and agree to the terms.' },
      };
    }
    await queryOne(
      `UPDATE app_user SET terms_version = $2, terms_accepted_at = now(),
              age_confirmed_at = COALESCE(age_confirmed_at, now())
        WHERE id = $1`,
      [user.id, TERMS_VERSION],
    );
    return { status: 200, jsonBody: { version: TERMS_VERSION, accepted: true } };
  } catch (err) {
    ctx.error('accept terms failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('me', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'me',
  handler: meHandler,
});

app.http('meTerms', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'me/terms',
  handler: acceptTermsHandler,
});

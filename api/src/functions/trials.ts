import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { LINEUP_PLAN, TRIAL_DAYS, isTrialTier, trialEndsAt, trialKind } from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { query, transaction } from '../lib/db.js';
import { getTrialStatus, settleTrials } from '../lib/trials.js';

function clip(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

class TrialUsed extends Error {}

/**
 * GET   this person's trials and which ones they may still start
 * POST  { tier: 'organization' | 'region', name } or { tier: 'coach' }
 *       starts a free trial, no card. An organization or region trial creates
 *       it with the caller as its director.
 */
export async function trialsHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    await settleTrials().catch((err) => ctx.warn('settle trials failed', err));

    if (req.method === 'GET') {
      return { status: 200, jsonBody: await getTrialStatus(user.id) };
    }

    const body = (await req.json().catch(() => ({}))) as { tier?: string; name?: string };
    if (!isTrialTier(body.tier)) {
      return { status: 400, jsonBody: { error: 'Choose an organization, region or coach trial.' } };
    }
    const tier = body.tier;
    const status = await getTrialStatus(user.id);
    if (!status.canStart[tier]) {
      const used = tier === 'coach' ? status.coach : status.scope;
      return {
        status: 409,
        jsonBody: {
          error:
            status.blockedReason ??
            (used
              ? tier === 'coach'
                ? 'You have already had a Coach trial.'
                : 'You have already had an organization or region trial.'
              : 'Your organization or region trial already includes every Coach feature.'),
          code: 'TRIAL_NOT_AVAILABLE',
        },
      };
    }

    const name = clip(body.name, 80);
    if (tier !== 'coach' && !name) {
      return { status: 400, jsonBody: { error: `Give your ${tier} a name.` } };
    }
    const endsAt = trialEndsAt(tier);

    const started = await transaction(async (c) => {
      // Claiming the allowance first means a double tap cannot start two trials.
      const claim = await c.query<{ id: string }>(
        `INSERT INTO plan_trial (user_id, kind, tier, scope_name, ends_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, kind) DO NOTHING
         RETURNING id`,
        [user.id, trialKind(tier), tier, name || null, endsAt],
      );
      const trialId = claim.rows[0]?.id;
      if (!trialId) throw new TrialUsed();

      let orgId: string | null = null;
      let regionId: string | null = null;
      if (tier === 'organization') {
        const org = await c.query<{ id: string }>(
          `INSERT INTO organization (name, is_personal, created_by)
           VALUES ($1, false, $2) RETURNING id`,
          [name, user.id],
        );
        orgId = org.rows[0].id;
        await c.query(
          `INSERT INTO membership (user_id, role, org_id) VALUES ($1, 'director', $2)
           ON CONFLICT DO NOTHING`,
          [user.id, orgId],
        );
      } else if (tier === 'region') {
        // A standalone region sits in a hidden personal organization.
        const org = await c.query<{ id: string }>(
          `INSERT INTO organization (name, is_personal, created_by)
           VALUES ($1, true, $2) RETURNING id`,
          [name, user.id],
        );
        const region = await c.query<{ id: string }>(
          `INSERT INTO region (org_id, name, is_personal, created_by)
           VALUES ($1, $2, false, $3) RETURNING id`,
          [org.rows[0].id, name, user.id],
        );
        regionId = region.rows[0].id;
        await c.query(
          `INSERT INTO membership (user_id, role, region_id) VALUES ($1, 'director', $2)
           ON CONFLICT DO NOTHING`,
          [user.id, regionId],
        );
      }
      await c.query('UPDATE plan_trial SET org_id = $2, region_id = $3 WHERE id = $1', [trialId, orgId, regionId]);

      // The trial plan expires with the trial. Attached to the organization or
      // region, it also covers the admins the director invites.
      await c.query(
        `INSERT INTO entitlement (app_id, user_id, org_id, region_id, tier, expires_at, status, external_ref)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', 'trial')
         ON CONFLICT (app_id, user_id) DO UPDATE SET
           org_id = EXCLUDED.org_id, region_id = EXCLUDED.region_id, tier = EXCLUDED.tier,
           overrides = NULL, expires_at = EXCLUDED.expires_at, status = 'active',
           cancelled_at = NULL, access_until = NULL, external_ref = 'trial', granted_at = now()`,
        [LINEUP_PLAN.appId, user.id, orgId, regionId, tier, endsAt],
      );
      return { trialId, orgId, regionId };
    });

    ctx.log('trial started', { user: user.id, tier });
    return {
      status: 201,
      jsonBody: {
        ...started,
        tier,
        days: TRIAL_DAYS[tier],
        endsAt: endsAt.toISOString(),
        status: await getTrialStatus(user.id),
      },
    };
  } catch (err) {
    if (err instanceof TrialUsed) {
      return { status: 409, jsonBody: { error: 'That free trial has already been used.', code: 'TRIAL_NOT_AVAILABLE' } };
    }
    ctx.error('trials failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/**
 * After an organization or region trial ends, its director carries on as a
 * free coach. The paused trial is still kept until its keep date, so
 * subscribing before then brings it back.
 */
export async function dismissTrialHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    await query(
      `UPDATE plan_trial SET dismissed_at = COALESCE(dismissed_at, now())
        WHERE user_id = $1 AND kind = 'scope' AND converted_at IS NULL AND ends_at <= now()`,
      [user.id],
    );
    return { status: 200, jsonBody: await getTrialStatus(user.id) };
  } catch (err) {
    ctx.error('dismiss trial failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('trials', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'trials',
  handler: trialsHandler,
});

app.http('trialsDismiss', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'trials/dismiss',
  handler: dismissTrialHandler,
});

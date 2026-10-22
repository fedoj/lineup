import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { PAID_ONLY_ROLES, ROLE_RANK, premiumTierFor, type Role, type TierId } from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { loadMemberships } from '../lib/authz.js';
import {
  getImpersonation,
  impersonationEnabled,
  isRole,
  isTier,
  logImpersonation,
  mayImpersonate,
  startImpersonation,
  stopImpersonation,
} from '../lib/impersonation.js';

/**
 * Start, stop or inspect a role/tier impersonation session.
 *
 * GET  -> current state plus the options that can be assumed.
 * POST -> { role?, tier? } to start, or { stop: true } to end.
 *
 * Only people on the configured allowlist may use this. Everyone else is told
 * the feature does not exist, so its presence is not advertised.
 */
export async function impersonateHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    const allowed = impersonationEnabled() && mayImpersonate(user);

    if (req.method === 'GET') {
      const state = await getImpersonation(user.id);
      return {
        status: 200,
        jsonBody: {
          // `available` drives whether the UI renders at all. A user who is
          // not on the list sees nothing, even if a stale session exists —
          // but they can still stop one, so access cannot be stranded.
          available: allowed,
          ...state,
          // Players no longer get accounts, so there is nothing to test as one.
          roles: allowed ? Object.keys(ROLE_RANK).filter((r) => r !== 'player' && r !== 'custom') : [],
          // Plans are tested as Free or Premium; Premium means the paid plan
          // the chosen role would buy (see premiumTierFor).
          tiers: allowed ? ['free', 'premium'] : [],
        },
      };
    }

    const body = (await req.json()) as {
      role?: string | null;
      tier?: string | null;
      stop?: boolean;
    };

    // Stopping is always permitted. Someone removed from the allowlist mid
    // session must still be able to return to their real account.
    if (body.stop) {
      return {
        status: 200,
        jsonBody: { available: allowed, ...(await stopImpersonation(user.id, req)) },
      };
    }

    if (!allowed) {
      await logImpersonation(user.id, 'denied', req);
      return {
        status: 404,
        jsonBody: { error: 'Not found.', code: 'NOT_AVAILABLE' },
      };
    }

    const role = body.role ?? null;
    const requested = body.tier ?? null;
    if (role !== null && !isRole(role)) {
      return { status: 400, jsonBody: { error: `Unknown role '${role}'.` } };
    }
    if (requested !== null && requested !== 'premium' && !isTier(requested)) {
      return { status: 400, jsonBody: { error: `Unknown plan '${requested}'.` } };
    }
    if (role === null && requested === null) {
      return { status: 400, jsonBody: { error: 'Choose a role, a plan, or both.' } };
    }
    // "Premium" is the paid plan the tested role would buy; with no role
    // chosen, the caller's own strongest role decides.
    const roleForPlan =
      role ?? (await loadMemberships(user.id)).sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role])[0]?.role ?? null;
    let effectiveTier: TierId | null = requested === 'premium' ? premiumTierFor(roleForPlan) : (requested as TierId | null);
    // Organization and region admins and directors only exist on a paid
    // organization or region plan, so testing one always uses it.
    if (role !== null && PAID_ONLY_ROLES.includes(role as Role)) {
      if (effectiveTier === 'free') {
        return {
          status: 400,
          jsonBody: { error: 'Organization and region admins and directors are always on a paid plan.' },
        };
      }
      if (!effectiveTier || !['region', 'organization', 'organizationPlus'].includes(effectiveTier)) {
        effectiveTier = 'organization';
      }
    }

    return {
      status: 200,
      jsonBody: { available: allowed, ...(await startImpersonation(user.id, role, effectiveTier, req)) },
    };
  } catch (err) {
    ctx.error('impersonate failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('impersonate', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'impersonate',
  handler: impersonateHandler,
});

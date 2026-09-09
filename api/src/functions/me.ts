import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { LINEUP_PLAN, effectiveLimits } from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { getEntitlement, getUsage, paywallEnabled } from '../lib/entitlements.js';

/** Who am I, what plan am I on, and how much have I used. */
export async function meHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) {
      return { status: 401, jsonBody: { error: 'Not authenticated' } };
    }

    const [entitlement, usage] = await Promise.all([
      getEntitlement(user.id),
      getUsage(user.id),
    ]);

    const enabled = paywallEnabled();

    return {
      status: 200,
      jsonBody: {
        user: { id: user.id, email: user.email, provider: user.provider },
        tier: entitlement?.tier ?? 'free',
        paywallEnabled: enabled,
        usage,
        limits: effectiveLimits(LINEUP_PLAN, entitlement, enabled),
        plan: LINEUP_PLAN,
      },
    };
  } catch (err) {
    ctx.error('me failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('me', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'me',
  handler: meHandler,
});

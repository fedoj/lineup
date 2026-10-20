import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { requireUser } from '../lib/auth.js';
import { clearPhones, inTwoStepGroup, isObjectId, maskPhone, phoneMethods, setTwoStep, twoStepConfig } from '../lib/graph.js';

/**
 * Two-step sign-in (Fady, 10/19): optional, per person. Turned on, the person
 * is asked for a code by text message every time they sign in; the first
 * time, they add their phone number. It works through the Lineup Auth tenant
 * (infra/two-step-setup.cjs): this only adds or removes the person from the
 * group a sign-in policy applies to, and can forget their phone number so the
 * next sign-in asks for a new one. Text messages are charged per message.
 */
export async function twoStepHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    const cfg = twoStepConfig();
    // Only Lineup Auth accounts (the subject is the person's id there).
    if (!cfg || user.provider !== 'lineup' || !isObjectId(user.subject)) {
      return { status: 200, jsonBody: { available: false } };
    }

    let expect: boolean | undefined;
    if (req.method === 'POST') {
      const b = (await req.json().catch(() => ({}))) as { action?: string };
      if (b.action === 'on' || b.action === 'off') {
        await setTwoStep(cfg, user.subject, b.action === 'on');
        expect = b.action === 'on';
      } else if (b.action === 'reset-phone') {
        await clearPhones(cfg, user.subject);
      } else {
        return { status: 400, jsonBody: { error: 'Unknown action' } };
      }
    }

    // After a change, report what was just set: Graph can take a few seconds
    // to show a new group membership.
    const [enabled, phones] = await Promise.all([
      expect !== undefined ? Promise.resolve(expect) : inTwoStepGroup(cfg, user.subject),
      phoneMethods(cfg, user.subject),
    ]);
    return {
      status: 200,
      jsonBody: {
        available: true,
        enabled,
        phone: phones[0] ? maskPhone(phones[0].phoneNumber) : null,
      },
    };
  } catch (err) {
    ctx.error('two-step failed', err);
    return { status: 502, jsonBody: { error: 'Two-step sign-in is not reachable right now. Try again in a minute.' } };
  }
}

app.http('twoStep', {
  methods: ['GET', 'POST'], authLevel: 'anonymous', route: 'two-step', handler: twoStepHandler,
});

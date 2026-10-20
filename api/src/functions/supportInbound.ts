import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { inboundSecretOk, receiveSupportEmail, sendSupportReplies, type InboundEmail } from '../lib/supportEmail.js';

/**
 * POST /api/support/inbound: email to support@mahoul.io, posted by the
 * Cloudflare Email Worker (infra/cloudflare/support-email-worker.js). An
 * anonymous route on Static Web Apps, so the shared secret in the
 * x-lineup-inbound-secret header is what lets a message in.
 *
 * { flush: true } with the same secret sends the replies support and Scout
 * wrote on email tickets now, rather than on the next app request.
 */
export async function supportInboundHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    if (!process.env.SUPPORT_INBOUND_SECRET) {
      return { status: 503, jsonBody: { error: 'Email to support is not set up.' } };
    }
    if (!inboundSecretOk(req.headers.get('x-lineup-inbound-secret'))) {
      return { status: 401, jsonBody: { error: 'Not authorized' } };
    }
    const b = (await req.json()) as InboundEmail & { flush?: boolean };
    if (b.flush) return { status: 200, jsonBody: await sendSupportReplies(true) };

    const r = await receiveSupportEmail(b);
    // Send any waiting replies while we are here.
    void sendSupportReplies().catch(() => undefined);
    if (r.kind === 'limited') return { status: 429, jsonBody: { error: 'Too many emails from this address. Try again later.' } };
    return { status: r.kind === 'ticket' || r.kind === 'comment' ? 201 : 200, jsonBody: r };
  } catch (err) {
    ctx.error('support inbound failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('supportInbound', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'support/inbound',
  handler: supportInboundHandler,
});

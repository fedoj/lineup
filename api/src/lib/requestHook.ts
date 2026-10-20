import { createHash } from 'node:crypto';
import { app, type HttpRequest, type HttpResponseInit } from '@azure/functions';
import { getPool } from './db.js';
import { sendPendingPushes } from './pushSend.js';
import { withRequestScope } from './requestScope.js';

/**
 * Every HTTP function runs inside its own request scope (see requestScope.ts),
 * and JSON answers to GETs get a fingerprint (ETag).
 *
 * The app sends the fingerprint of the answer it already has; when nothing
 * changed the reply is an empty 304 instead of the same JSON again. Team chat
 * asks every 8 seconds and the bell every minute, so most answers are
 * unchanged: this saves the download and, in the app, redrawing the screen.
 *
 * Answers are marked no-store so personal data never lands in the browser's
 * disk cache; the app keeps the copy it compares against in memory only.
 */
function isHttpRequest(v: unknown): v is HttpRequest {
  return Boolean(v && typeof v === 'object' && 'method' in v && 'headers' in v && 'url' in v);
}

function withEtag(req: HttpRequest, res: HttpResponseInit): HttpResponseInit {
  if (req.method !== 'GET' || (res.status ?? 200) !== 200 || res.jsonBody === undefined || res.body !== undefined) {
    return res;
  }
  const body = JSON.stringify(res.jsonBody);
  const etag = `"${createHash('sha1').update(body).digest('base64url').slice(0, 20)}"`;
  const headers = new Headers(res.headers as ConstructorParameters<typeof Headers>[0]);
  headers.set('ETag', etag);
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
  if (req.headers.get('if-none-match') === etag) {
    return { status: 304, headers };
  }
  headers.set('Content-Type', 'application/json');
  const { jsonBody: _unused, ...rest } = res;
  return { ...rest, headers, body };
}

app.hook.preInvocation((context) => {
  const handler = context.functionHandler;
  context.functionHandler = (triggerInput, invocation) =>
    withRequestScope(async () => {
      const res = await handler(triggerInput, invocation);
      // Notifications this request created go out to phones before it ends:
      // Static Web Apps functions only run while answering a request.
      if (isHttpRequest(triggerInput)) await sendPendingPushes().catch(() => undefined);
      return isHttpRequest(triggerInput) && res && typeof res === 'object' ? withEtag(triggerInput, res as HttpResponseInit) : res;
    });
});

// Open the first database connection while the host finishes starting, so the
// first request after a cold start does not also pay for the TLS handshake.
if (process.env.DATABASE_URL) {
  void getPool()
    .query('SELECT 1')
    .catch(() => undefined);
}

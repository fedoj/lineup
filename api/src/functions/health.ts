import { app, type HttpResponseInit } from '@azure/functions';
import { queryOne } from '../lib/db.js';

/** Liveness + DB reachability. Used by deploy smoke tests. */
export async function healthHandler(): Promise<HttpResponseInit> {
  const started = Date.now();
  try {
    await queryOne('SELECT 1 AS ok');
    return {
      status: 200,
      jsonBody: {
        status: 'healthy',
        database: 'connected',
        environment: process.env.APP_ENV ?? 'unknown',
        latencyMs: Date.now() - started,
      },
    };
  } catch (err) {
    return {
      status: 503,
      jsonBody: {
        status: 'degraded',
        database: 'unreachable',
        environment: process.env.APP_ENV ?? 'unknown',
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'health',
  handler: healthHandler,
});

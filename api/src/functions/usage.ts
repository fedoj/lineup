import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { requireUser } from '../lib/auth.js';
import { query } from '../lib/db.js';
import { appToday } from '../lib/today.js';

/**
 * Usage counts for the admin console (Fady, 10/19): the app sends which pages
 * were opened and which buttons were tapped, in small batches, and each one
 * adds to that day's count. No user or device is stored, only the counts.
 */

const MAX_EVENTS = 60;

/** A page or button name: short, printable, with numbers folded so they group. */
export function cleanUsageName(raw: unknown): string | null {
  const s = String(raw ?? '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return s.length > 0 ? s : null;
}

export async function usageHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    const b = (await req.json().catch(() => ({}))) as { events?: Array<{ kind?: string; name?: string; n?: number }> };
    const counts = new Map<string, { kind: string; name: string; n: number }>();
    for (const e of (b.events ?? []).slice(0, MAX_EVENTS)) {
      const kind = e.kind === 'click' ? 'click' : e.kind === 'page' ? 'page' : null;
      const name = cleanUsageName(e.name);
      if (!kind || !name) continue;
      const n = Math.min(50, Math.max(1, Math.round(Number(e.n) || 1)));
      const key = `${kind}\u0000${name}`;
      const cur = counts.get(key);
      if (cur) cur.n += n;
      else counts.set(key, { kind, name, n });
    }
    if (counts.size === 0) return { status: 204 };
    const rows = [...counts.values()];
    await query(
      `INSERT INTO feature_usage_daily (day, kind, name, hits)
       SELECT $1::date, k, n, h FROM unnest($2::text[], $3::text[], $4::int[]) AS t(k, n, h)
       ON CONFLICT (day, kind, name) DO UPDATE SET hits = feature_usage_daily.hits + EXCLUDED.hits`,
      [appToday(), rows.map((r) => r.kind), rows.map((r) => r.name), rows.map((r) => r.n)],
    );
    // Now and then, clear counts older than 13 months so the table stays small.
    if (Math.random() < 0.02) {
      await query(`DELETE FROM feature_usage_daily WHERE day < $1::date - interval '13 months'`, [appToday()]).catch(() => undefined);
    }
    return { status: 204 };
  } catch (err) {
    ctx.warn('usage failed', err);
    // Counting must never get in the way of using the app.
    return { status: 204 };
  }
}

app.http('usage', {
  methods: ['POST'], authLevel: 'anonymous', route: 'usage', handler: usageHandler,
});

import { query, queryOne } from './db.js';

/**
 * Season-long stats are worked out ahead of time and read from a stored copy
 * (Shadi, 10/21), so a busy afternoon never waits on them.
 *
 * - A copy is refreshed at night (1 to 5 am Pacific) once it is more than 20
 *   hours old, by whichever request comes in then (Static Web Apps functions
 *   have no timer), a few at a time, in the background after that request.
 * - During the day the stored copy is served even when it is from yesterday.
 *   Only a copy older than 2 days, or none at all, is worked out on the spot.
 * - Copies nobody has looked at for 2 weeks are dropped.
 *
 * Each kind of stats registers how to work itself out from its key.
 */

type Compute = (key: string) => Promise<unknown>;
const kinds = new Map<string, Compute>();

/** Registers how to work out the stats whose keys start with `prefix:`. */
export function registerStats(prefix: string, compute: Compute): void {
  kinds.set(prefix, compute);
}

const STALE_HOURS = 48;
const NIGHT_REFRESH_HOURS = 20;

function computeFor(key: string): Compute | undefined {
  return kinds.get(key.split(':')[0]);
}

/** Pacific hour of the day, 0 to 23. */
function pacificHour(now = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/Los_Angeles' }).format(now));
}

async function store(key: string, data: unknown): Promise<Date> {
  const row = await queryOne<{ computed_at: Date }>(
    `INSERT INTO stats_snapshot (key, data, computed_at, last_read_at) VALUES ($1, $2, now(), now())
     ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, computed_at = now(), last_read_at = now()
     RETURNING computed_at`,
    [key, JSON.stringify(data)],
  );
  return row?.computed_at ?? new Date();
}

/** The stats for a key: the stored copy, or worked out now when there is none (or it is very old). */
export async function cachedStats<T>(key: string, compute: () => Promise<T>): Promise<{ data: T; computedAt: string }> {
  const row = await queryOne<{ data: T; computed_at: Date; age_h: number }>(
    `UPDATE stats_snapshot SET last_read_at = now() WHERE key = $1
     RETURNING data, computed_at, EXTRACT(EPOCH FROM now() - computed_at) / 3600 AS age_h`,
    [key],
  );
  if (row && Number(row.age_h) < STALE_HOURS) return { data: row.data, computedAt: row.computed_at.toISOString() };
  const data = await compute();
  const at = await store(key, data);
  return { data, computedAt: at.toISOString() };
}

let last = 0;
let running: Promise<void> | null = null;

/**
 * At night, refresh stored copies that are more than 20 hours old, a few per
 * call; called after requests, so it never delays an answer. Also drops
 * copies nobody has read for two weeks.
 */
export function refreshStatsAtNight(force = false): Promise<void> {
  if (running) return running;
  const now = Date.now();
  if (!force && (now - last < 5 * 60_000 || pacificHour() >= 5 || pacificHour() < 1)) return Promise.resolve();
  last = now;
  running = (async () => {
    try {
      await query(`DELETE FROM stats_snapshot WHERE last_read_at < now() - interval '14 days'`);
      const due = await query<{ key: string }>(
        `SELECT key FROM stats_snapshot WHERE computed_at < now() - make_interval(hours => $1)
          ORDER BY last_read_at DESC LIMIT 5`,
        [NIGHT_REFRESH_HOURS],
      );
      for (const { key } of due) {
        const compute = computeFor(key);
        if (!compute) continue;
        await store(key, await compute(key)).catch(() => undefined);
      }
    } catch {
      /* the next request at night tries again */
    } finally {
      running = null;
    }
  })();
  return running;
}

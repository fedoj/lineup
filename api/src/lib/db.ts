import pg from 'pg';
import { forgetRequestMemo } from './requestScope.js';

const { Pool } = pg;

/**
 * Single pool per process. Azure Functions reuses warm instances, so this
 * keeps connection count bounded — important on a burstable Postgres tier
 * where max_connections is low.
 *
 * Idle connections are kept for 5 minutes: opening one costs several round
 * trips to the database (TCP, TLS, sign-in), which the next click would pay.
 */
let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not configured');
    }
    pool = new Pool({
      connectionString,
      max: Number(process.env.PGPOOL_MAX ?? 4),
      idleTimeoutMillis: 300_000,
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

/** Anything but a plain read may change what this request has remembered. */
const READ_ONLY = /^\s*(SELECT|VALUES|SHOW)\b/i;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  if (!READ_ONLY.test(text)) forgetRequestMemo();
  const result = await getPool().query<T>(text, params);
  return result.rows;
}

/**
 * A write that cannot change who someone is, their plan or their access
 * (bookkeeping such as request counts), so the request's memo is kept.
 */
export async function queryQuiet<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const rows = await query<T>(text, params);
  return rows[0];
}

/** Run a set of statements in a single transaction. */
export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  forgetRequestMemo();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    forgetRequestMemo();
  }
}

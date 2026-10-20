/**
 * Apply SQL migrations to a database.
 * Usage: node db/migrate.cjs <databaseName>
 * Reads the admin password from LINEUP_PG_PASSWORD.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const database = process.argv[2];
if (!database) {
  console.error('usage: node db/migrate.cjs <databaseName>');
  process.exit(1);
}

const password = process.env.LINEUP_PG_PASSWORD;
if (!password) {
  console.error('LINEUP_PG_PASSWORD is not set');
  process.exit(1);
}

const dir = path.join(__dirname, 'migrations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

(async () => {
  const client = new Client({
    host: 'wus3-lineup-pg.postgres.database.azure.com',
    port: 5432,
    user: 'lineupadmin',
    password,
    database,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 120000,
  });

  await client.connect();
  console.log(`connected to ${database}`);

  // Track what has already run so re-invoking is safe.
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  for (const file of files) {
    const done = await client.query(
      'SELECT 1 FROM schema_migration WHERE filename = $1',
      [file],
    );
    if (done.rowCount > 0) {
      console.log(`  skip  ${file} (already applied)`);
      continue;
    }

    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    process.stdout.write(`  apply ${file} ... `);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migration (filename) VALUES ($1)',
        [file],
      );
      await client.query('COMMIT');
      console.log('ok');
    } catch (err) {
      await client.query('ROLLBACK');
      console.log('FAILED');
      console.error(err.message);
      process.exitCode = 1;
      break;
    }
  }

  const tables = await client.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public'`,
  );
  const catalog = await client.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'division_catalog'`,
  );
  let divisions = { rows: [{ n: 0 }] };
  if (catalog.rows[0].n > 0) {
    divisions = await client.query('SELECT COUNT(*)::int AS n FROM division_catalog');
  }

  console.log(`tables: ${tables.rows[0].n}, catalog divisions: ${divisions.rows[0].n}`);
  await client.end();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

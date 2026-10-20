/**
 * Confirm every seeded secret matches the value still live in the Static Web
 * App. Guards against shell quoting mangling a connection string, which would
 * only surface later as a failed deploy.
 *
 * Usage: node infra/verify-vault.cjs
 */
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

const VAULT = process.env.LINEUP_KEY_VAULT ?? 'wus3-shared-kv';
const SUB = '5d849fe9-5e3c-4e9a-a77b-c3b05d325519';
const MAP = {
  DATABASE_URL: 'database-url',
  IP_HASH_SALT: 'ip-hash-salt',
  LINEUP_OIDC_CLIENT_ID: 'oidc-client-id',
  LINEUP_OIDC_CLIENT_SECRET: 'oidc-client-secret',
};

const sh = (args) =>
  execFileSync('az', args, { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });

const digest = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);

let fails = 0;
for (const env of ['dev', 'prd']) {
  const url =
    `https://management.azure.com/subscriptions/${SUB}` +
    `/resourceGroups/wus3-lineup-${env}-rg/providers/Microsoft.Web/staticSites` +
    `/lineup-${env}-webapp/listAppSettings?api-version=2022-03-01`;
  const live = JSON.parse(
    sh(['rest', '--method', 'post', '--url', `"${url}"`, '-o', 'json']),
  ).properties;

  console.log(`\n${env}:`);
  for (const [setting, suffix] of Object.entries(MAP)) {
    const name = `lineup-${env}-${suffix}`;
    const vaulted = sh([
      'keyvault', 'secret', 'show',
      '--vault-name', VAULT, '--name', name,
      '--query', 'value', '-o', 'tsv', '--only-show-errors',
    ]).replace(/\r?\n$/, '');

    const same = vaulted === live[setting];
    if (!same) fails++;
    console.log(
      `  ${same ? 'PASS' : 'FAIL'}  ${name}  ` +
        `vault=${digest(vaulted)} live=${digest(live[setting] ?? '')}` +
        `${same ? '' : `  len ${vaulted.length} vs ${(live[setting] ?? '').length}`}`,
    );
  }
}

console.log(fails ? `\n${fails} mismatch(es)` : '\nevery secret round-trips exactly');
process.exit(fails ? 1 : 0);

/**
 * Set who may use role/tier impersonation.
 *
 * Takes email addresses, resolves each to its Entra object id in the CIAM
 * tenant, and stores the resulting list in Key Vault. Object ids are used
 * because the tenant does not emit an email claim, so the id is the only
 * value reliably present in the token.
 *
 * Replaces the whole list every run — pass every person who should have
 * access, not just the new one.
 *
 * Usage: node infra/set-impersonators.cjs <dev|prd> email [email...]
 *        node infra/set-impersonators.cjs <dev|prd> --none      (disable)
 */
const { execFileSync } = require('node:child_process');

const env = process.argv[2];
if (!env || !['dev', 'prd'].includes(env)) {
  console.error('usage: node infra/set-impersonators.cjs <dev|prd> email [email...]');
  console.error('       node infra/set-impersonators.cjs <dev|prd> --none');
  process.exit(1);
}

const emails = process.argv.slice(3);
if (emails.length === 0) {
  console.error('pass at least one email, or --none to disable');
  process.exit(1);
}

const VAULT = process.env.LINEUP_KEY_VAULT ?? 'wus3-shared-kv';
const TENANT = '4412d6d0-0cb9-4270-a8b4-1976b579bafb';

const sh = (args) =>
  execFileSync('az', args, { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });

function graph(path) {
  const token = sh([
    'account', 'get-access-token',
    '--tenant', TENANT,
    '--resource', 'https://graph.microsoft.com',
    '--query', 'accessToken', '-o', 'tsv',
  ]).trim();
  const out = execFileSync(
    'curl.exe',
    ['-s', '-H', `"Authorization: Bearer ${token}"`, `"https://graph.microsoft.com/v1.0${path}"`],
    { encoding: 'utf8', shell: true },
  );
  return JSON.parse(out);
}

function setSecret(name, value) {
  sh([
    'keyvault', 'secret', 'set',
    '--vault-name', VAULT, '--name', name,
    '--value', `"${value}"`,
    '--only-show-errors', '-o', 'none',
  ]);
}

const secretName = `lineup-${env}-impersonation-allowlist`;

if (emails[0] === '--none') {
  setSecret(secretName, '');
  console.log(`${secretName} cleared — impersonation disabled in ${env}`);
  console.log('Run infra/set-settings.cjs to apply.');
  process.exit(0);
}

// One directory read, then match locally: Graph filtering on the identities
// collection is awkward, and this tenant is small.
const all = graph('/users?$select=id,displayName,mail,identities&$top=999').value;

const resolved = [];
let missing = 0;

for (const email of emails) {
  const needle = email.toLowerCase();
  const match = all.find(
    (u) =>
      (u.mail ?? '').toLowerCase() === needle ||
      (u.identities ?? []).some(
        (i) => (i.issuerAssignedId ?? '').toLowerCase() === needle,
      ),
  );

  if (!match) {
    console.error(`  NOT FOUND  ${email} — they must sign up once before being added`);
    missing++;
    continue;
  }
  console.log(`  ${match.id}  ${email}  (${match.displayName})`);
  resolved.push(match.id);
}

if (resolved.length === 0) {
  console.error('\nnobody resolved; nothing written');
  process.exit(1);
}

setSecret(secretName, resolved.join(','));
console.log(`\nwrote ${resolved.length} id(s) to ${secretName} in ${VAULT}`);
if (missing) console.log(`${missing} address(es) could not be resolved and were skipped.`);
console.log('Run infra/set-settings.cjs to apply.');

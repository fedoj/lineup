/**
 * Push a Static Web App's application settings FROM Key Vault.
 *
 * Why push rather than reference: Static Web Apps with a MANAGED functions
 * API cannot resolve `@Microsoft.KeyVault(...)` settings and has no managed
 * identity (both are documented as bring-your-own-functions only). So the
 * vault is the master copy and CI copies the values in at deploy time.
 *
 * Goes through `az rest --body @file` because cmd.exe mangles connection
 * strings containing ? & or ! when passed as a CLI flag.
 *
 * Usage: node infra/set-settings.cjs <dev|prd> [--dry-run]
 * Requires an az login with secret-read rights on the vault.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const env = process.argv[2];
if (!env || !['dev', 'prd'].includes(env)) {
  console.error('usage: node infra/set-settings.cjs <dev|prd> [--dry-run]');
  process.exit(1);
}
const DRY = process.argv.includes('--dry-run');

const VAULT = process.env.LINEUP_KEY_VAULT ?? 'wus3-shared-kv';
const SUB = process.env.AZURE_SUBSCRIPTION_ID ?? '5d849fe9-5e3c-4e9a-a77b-c3b05d325519';
const rg = `wus3-lineup-${env}-rg`;
const swa = `lineup-${env}-webapp`;

const sh = (args) =>
  execFileSync('az', args, { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });

/** Secret suffix in the vault -> app setting name. */
const FROM_VAULT = {
  'database-url': 'DATABASE_URL',
  'ip-hash-salt': 'IP_HASH_SALT',
  'oidc-client-id': 'LINEUP_OIDC_CLIENT_ID',
  'oidc-client-secret': 'LINEUP_OIDC_CLIENT_SECRET',
};

/** Present only in environments where the feature is turned on. */
const OPTIONAL_FROM_VAULT = {
  'impersonation-allowlist': 'IMPERSONATION_ALLOWLIST',
  'admin-allowlist': 'ADMIN_ALLOWLIST',
  'acs-connection-string': 'ACS_CONNECTION_STRING',
  'email-sender': 'EMAIL_SENDER',
  // Stripe (restricted key, test mode in dev) and its webhook signing secret;
  // infra/stripe-setup.cjs creates the products, portal and webhook.
  'stripe-secret-key': 'STRIPE_SECRET_KEY',
  'stripe-webhook-secret': 'STRIPE_WEBHOOK_SECRET',
  // Shared with the Cloudflare Email Worker that posts support@mahoul.io mail
  // to /api/support/inbound (infra/cloudflare/support-email-worker.js).
  'support-inbound-secret': 'SUPPORT_INBOUND_SECRET',
  // Two-step sign-in (text-message codes): the API's own app in the Lineup
  // Auth tenant and the group of people who turned it on. Created by
  // infra/two-step-setup.cjs.
  'graph-client-id': 'GRAPH_CLIENT_ID',
  'graph-client-secret': 'GRAPH_CLIENT_SECRET',
  'two-step-group-id': 'TWO_STEP_GROUP_ID',
  // Push notifications: the VAPID key pair (the public half goes to browsers).
  'vapid-public-key': 'VAPID_PUBLIC_KEY',
  'vapid-private-key': 'VAPID_PRIVATE_KEY',
};

/** Optional settings that are credentials and must never be printed. */
const OPTIONAL_SECRETS = new Set(['ACS_CONNECTION_STRING', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SUPPORT_INBOUND_SECRET', 'GRAPH_CLIENT_SECRET', 'VAPID_PRIVATE_KEY']);

function readSecret(suffix, optional = false) {
  const name = `lineup-${env}-${suffix}`;
  try {
    return sh([
      'keyvault', 'secret', 'show',
      '--vault-name', VAULT, '--name', name,
      '--query', 'value', '-o', 'tsv', '--only-show-errors',
    ]).replace(/\r?\n$/, '');
  } catch (err) {
    if (optional) return null;
    throw new Error(`cannot read ${name} from ${VAULT}: ${err.stderr?.toString() ?? err.message}`);
  }
}

// Non-secret configuration stays in code — it is not sensitive and keeping it
// here means the vault only ever holds things that genuinely must be secret.
const settings = {
  APP_ENV: env,
  // Absolute base for links that leave the app, such as invite emails.
  APP_ORIGIN: env === 'prd' ? 'https://lineup.mahoul.io' : 'https://lineup-dev.mahoul.io',
  PAYWALL_ENABLED: process.env.PAYWALL_ENABLED ?? 'false',
  // Whole-platform Azure spend per month (both environments plus the shared
  // database), used by the admin dashboard to estimate cost per tier and user.
  // ~US$18 from the Oct 2026 month-to-date run rate; update as usage grows.
  PLATFORM_MONTHLY_COST_USD: process.env.PLATFORM_MONTHLY_COST_USD ?? '18',
  // The Lineup Auth (Entra External ID) tenant, for two-step sign-in.
  AUTH_TENANT_ID: '4412d6d0-0cb9-4270-a8b4-1976b579bafb',
};

for (const [suffix, settingName] of Object.entries(FROM_VAULT)) {
  const value = readSecret(suffix);
  if (!value) throw new Error(`secret lineup-${env}-${suffix} is empty`);
  settings[settingName] = value;
}

// Absent is a valid state: with no hash configured the API reports the
// impersonation feature as unavailable and refuses every attempt.
for (const [suffix, settingName] of Object.entries(OPTIONAL_FROM_VAULT)) {
  const value = readSecret(suffix, true);
  if (value) settings[settingName] = value;
}

// A salt must exist but was never in the vault for a brand-new environment;
// mint one and warn, so a fresh deploy is not silently unsalted.
if (!settings.IP_HASH_SALT) {
  settings.IP_HASH_SALT = crypto.randomBytes(24).toString('base64');
  console.warn('WARNING: generated a new IP_HASH_SALT — store it in the vault');
}

const fingerprint = (v) =>
  `${crypto.createHash('sha256').update(v, 'utf8').digest('hex').slice(0, 8)} (${v.length})`;

console.log(`${swa} <- ${VAULT}`);
// The allowlist is configuration, not a credential — show it, because seeing
// who can impersonate is the whole point of reviewing a deploy.
const secretNames = new Set([...Object.values(FROM_VAULT), ...OPTIONAL_SECRETS]);
for (const k of Object.keys(settings).sort()) {
  console.log(`  ${k} = ${secretNames.has(k) ? fingerprint(settings[k]) : settings[k]}`);
}

if (DRY) {
  console.log('\ndry run — nothing written');
  process.exit(0);
}

const bodyFile = path.join(os.tmpdir(), `_swa_${env}.json`);
fs.writeFileSync(bodyFile, JSON.stringify({ properties: settings }));

const url =
  `https://management.azure.com/subscriptions/${SUB}` +
  `/resourceGroups/${rg}/providers/Microsoft.Web/staticSites/${swa}` +
  `/config/appsettings?api-version=2022-03-01`;

try {
  sh(['rest', '--method', 'put', '--url', `"${url}"`, '--body', `"@${bodyFile}"`]);
  console.log(`\n${Object.keys(settings).length} settings applied`);
} catch (err) {
  console.error(`${swa}: FAILED`);
  console.error(err.stderr?.toString() ?? err.message);
  process.exitCode = 1;
} finally {
  fs.unlinkSync(bodyFile);
}

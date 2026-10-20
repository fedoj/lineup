/**
 * Set up Lineup's billing in Stripe: one product and yearly price per paid
 * plan (looked up by lineup_<tier>_yearly), the customer portal, and the
 * webhook that keeps plans in step. Safe to run again: existing prices,
 * portal settings and the webhook are reused.
 *
 * Usage: node infra/stripe-setup.cjs <dev|prd> [--dry-run]
 *
 * Reads the key from Key Vault (lineup-<env>-stripe-secret-key) and stores the
 * webhook signing secret back as lineup-<env>-stripe-webhook-secret. A live
 * key is refused unless the environment is prd and --live is passed.
 * Run `npm run build --workspace packages/shared` first: prices come from the
 * shared plan catalog.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const env = process.argv[2];
if (!['dev', 'prd'].includes(env)) {
  console.error('usage: node infra/stripe-setup.cjs <dev|prd> [--dry-run]');
  process.exit(1);
}
const DRY = process.argv.includes('--dry-run');
const LIVE_OK = env === 'prd' && process.argv.includes('--live');
const VAULT = process.env.LINEUP_KEY_VAULT ?? 'wus3-shared-kv';
const ORIGIN = env === 'prd' ? 'https://lineup.mahoul.io' : 'https://lineup-dev.mahoul.io';
const WEBHOOK_URL = `${ORIGIN}/api/stripe/webhook`;
const EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  'charge.refunded',
];

const az = (args) => execFileSync('az', args, { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });

function readSecret(name) {
  try {
    return az(['keyvault', 'secret', 'show', '--vault-name', VAULT, '--name', name, '--query', 'value', '-o', 'tsv', '--only-show-errors']).trim();
  } catch {
    return null;
  }
}

function writeSecret(name, value) {
  // Through a file, so the value never appears on a command line.
  const file = path.join(os.tmpdir(), `_kv_${process.pid}.txt`);
  fs.writeFileSync(file, value, { mode: 0o600 });
  try {
    az(['keyvault', 'secret', 'set', '--vault-name', VAULT, '--name', name, '--file', `"${file}"`, '--encoding', 'utf-8', '--only-show-errors', '-o', 'none']);
  } finally {
    fs.unlinkSync(file);
  }
}

const KEY = readSecret(`lineup-${env}-stripe-secret-key`);
if (!KEY) {
  console.error(`lineup-${env}-stripe-secret-key is not in ${VAULT}`);
  process.exit(1);
}
const live = /^(sk|rk)_live_/.test(KEY);
if (live && !LIVE_OK) {
  console.error('Refusing a live Stripe key: only prd with --live may use one.');
  process.exit(1);
}

function encode(params, prefix = '') {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((item, i) => parts.push(typeof item === 'object' ? encode(item, `${key}[${i}]`) : `${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`));
    else if (typeof v === 'object') parts.push(encode(v, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return parts.filter(Boolean).join('&');
}

async function api(method, p, params = {}) {
  const body = encode(params);
  const url = method === 'GET' && body ? `https://api.stripe.com/v1${p}?${body}` : `https://api.stripe.com/v1${p}`;
  if (DRY && method !== 'GET') {
    console.log(`  [dry run] ${method} ${p}`);
    return { id: 'dry_run', data: [] };
  }
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, ...(method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) },
    body: method === 'GET' ? undefined : body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${p}: ${json.error?.message ?? res.status}`);
  return json;
}

(async () => {
  const { pathToFileURL } = require('node:url');
  const { LINEUP_PLAN, TIER_ORDER } = await import(pathToFileURL(path.join(__dirname, '..', 'packages', 'shared', 'dist', 'index.js')).href);
  console.log(`Stripe ${live ? 'LIVE' : 'test'} mode, ${env}${DRY ? ' (dry run)' : ''}`);

  // 1. A product and a yearly price per paid plan. Names and descriptions
  // follow the plan catalog, so a reworded plan updates its product too.
  const products = (await api('GET', '/products', { limit: 100, active: 'true' })).data;
  const summary = [];
  for (const tier of TIER_ORDER) {
    const plan = LINEUP_PLAN.tiers[tier];
    if (!plan.priceCents) continue;
    const lookup = `lineup_${tier}_yearly`;
    let product = products.find((p) => p.metadata?.app === 'lineup' && p.metadata?.tier === tier);
    const name = `Lineup ${plan.name}`;
    if (!product) {
      product = await api('POST', '/products', {
        name,
        description: plan.blurb,
        metadata: { app: 'lineup', tier },
      });
      console.log(`  ${plan.name}: product ${product.id} created`);
    } else if (product.name !== name || product.description !== plan.blurb) {
      await api('POST', `/products/${product.id}`, { name, description: plan.blurb });
      console.log(`  ${plan.name}: product ${product.id} name and description updated`);
    }
    summary.push({ name, price: `$${(plan.priceCents / 100).toFixed(2)}/yr`, lookup, description: plan.blurb });
    const existing = (await api('GET', '/prices', { 'lookup_keys[]': lookup, active: 'true', limit: 1 })).data[0];
    if (existing && existing.unit_amount === plan.priceCents && existing.recurring?.interval === 'year') {
      console.log(`  ${plan.name}: price ${existing.id} already set ($${(plan.priceCents / 100).toFixed(2)}/yr)`);
      continue;
    }
    const price = await api('POST', '/prices', {
      product: product.id,
      currency: 'usd',
      unit_amount: plan.priceCents,
      recurring: { interval: 'year' },
      lookup_key: lookup,
      // A changed price takes the lookup key over from the old one.
      transfer_lookup_key: 'true',
      metadata: { app: 'lineup', tier },
    });
    if (existing) await api('POST', `/prices/${existing.id}`, { active: 'false' });
    console.log(`  ${plan.name}: price ${price.id} $${(plan.priceCents / 100).toFixed(2)}/yr`);
  }

  // Plans that no longer exist (Team parent was merged into Parent on 10/19):
  // their prices and products are archived so nobody new can buy them. People
  // already subscribed keep their subscription; the app reads it as the plan
  // it was merged into (LEGACY_TIER).
  for (const p of products.filter((x) => x.metadata?.app === 'lineup' && x.metadata?.tier && !TIER_ORDER.includes(x.metadata.tier))) {
    const prices = (await api('GET', '/prices', { product: p.id, active: 'true', limit: 100 })).data;
    for (const pr of prices) await api('POST', `/prices/${pr.id}`, { active: 'false' });
    await api('POST', `/products/${p.id}`, { active: 'false' });
    console.log(`  ${p.name}: retired plan, ${prices.length} price(s) and the product archived`);
  }

  // 2. The customer portal: card, invoices, cancel at the end of the term.
  const configs = (await api('GET', '/billing_portal/configurations', { is_default: 'true', limit: 1 })).data;
  const portal = {
    business_profile: {
      headline: 'Lineup: manage your plan',
      privacy_policy_url: `${ORIGIN}/privacy`,
      terms_of_service_url: `${ORIGIN}/terms`,
    },
    default_return_url: `${ORIGIN}/account`,
    features: {
      customer_update: { enabled: 'true', allowed_updates: ['email', 'address'] },
      invoice_history: { enabled: 'true' },
      payment_method_update: { enabled: 'true' },
      subscription_cancel: { enabled: 'true', mode: 'at_period_end' },
    },
  };
  if (configs[0]) {
    await api('POST', `/billing_portal/configurations/${configs[0].id}`, portal);
    console.log(`  customer portal ${configs[0].id} updated`);
  } else {
    const c = await api('POST', '/billing_portal/configurations', portal);
    console.log(`  customer portal ${c.id} created`);
  }

  // 3. The webhook. Its secret is only shown when it's created, so an
  // endpoint whose secret isn't in the vault is replaced.
  const secretName = `lineup-${env}-stripe-webhook-secret`;
  const haveSecret = Boolean(readSecret(secretName));
  const hooks = (await api('GET', '/webhook_endpoints', { limit: 100 })).data.filter((h) => h.url === WEBHOOK_URL);
  const keep = haveSecret ? hooks[0] : null;
  for (const h of hooks) {
    if (h !== keep) {
      await api('DELETE', `/webhook_endpoints/${h.id}`);
      console.log(`  webhook ${h.id} removed (secret not in the vault)`);
    }
  }
  if (keep) {
    await api('POST', `/webhook_endpoints/${keep.id}`, { enabled_events: EVENTS, disabled: 'false' });
    console.log(`  webhook ${keep.id} kept, events updated`);
  } else {
    const h = await api('POST', '/webhook_endpoints', {
      url: WEBHOOK_URL,
      enabled_events: EVENTS,
      description: `Lineup ${env}: keeps plans in step with Stripe`,
      metadata: { app: 'lineup', env },
    });
    if (!DRY) writeSecret(secretName, h.secret);
    console.log(`  webhook ${h.id} created -> ${WEBHOOK_URL}; secret stored as ${secretName}`);
  }
  // What the live account needs, to copy by hand or to check after a live run.
  console.log('\nPlans (product name | yearly price | lookup key):');
  for (const s of summary) console.log(`  ${s.name} | ${s.price} | ${s.lookup}\n    ${s.description}`);
  console.log('done');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

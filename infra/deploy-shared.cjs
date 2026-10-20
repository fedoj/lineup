/**
 * Deploy the shared platform stack (Postgres, Key Vault, DNS zone).
 *
 * Goes through a parameters FILE rather than --parameters flags because the
 * Postgres admin password contains shell-significant characters that az
 * mangles when passed inline on Windows.
 *
 * Usage: node infra/deploy-shared.cjs
 * Reads LINEUP_PG_PASSWORD.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const password = process.env.LINEUP_PG_PASSWORD;
if (!password) {
  console.error('LINEUP_PG_PASSWORD is not set');
  process.exit(1);
}

const sh = (args) =>
  execFileSync('az', args, { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });

// shell:true means args are concatenated, not escaped — any path can contain
// a space (this repo lives under "Microsoft Scout"), so quote them ourselves.
const q = (s) => `"${s}"`;

const me = sh(['ad', 'signed-in-user', 'show', '--query', 'id', '-o', 'tsv']).trim();
console.log(`granting vault access to ${me}`);

const params = {
  $schema:
    'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#',
  contentVersion: '1.0.0.0',
  parameters: {
    pgAdminPassword: { value: password },
    vaultAdminObjectIds: { value: [me] },
  },
};

const file = path.join(os.tmpdir(), '_shared_params.json');
fs.writeFileSync(file, JSON.stringify(params));

try {
  const out = sh([
    'deployment', 'sub', 'create',
    '--name', 'shared-platform',
    '--location', 'westus3',
    '--template-file', q(path.join(__dirname, 'shared.bicep')),
    '--parameters', q(`@${file}`),
    '--query', 'properties.outputs',
    '-o', 'json',
  ]);
  const outputs = JSON.parse(out);
  for (const [k, v] of Object.entries(outputs)) {
    console.log(`${k}: ${JSON.stringify(v.value)}`);
  }
} catch (err) {
  console.error('deployment FAILED');
  console.error(err.stderr?.toString() ?? err.message);
  process.exitCode = 1;
} finally {
  fs.unlinkSync(file);
}

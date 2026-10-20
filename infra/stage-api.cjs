/**
 * Stage a self-contained API folder for Static Web Apps deployment.
 *
 * npm workspaces hoist dependencies to the repository root, so the `api`
 * folder on its own has no @azure/functions or pg and the uploaded package
 * registers zero functions. This copies the built bundle plus a clean
 * production install into api-deploy/.
 *
 * Usage: node infra/stage-api.cjs
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'api');
const out = path.join(root, 'api-deploy');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'dist'), { recursive: true });

fs.copyFileSync(path.join(src, 'dist', 'index.js'), path.join(out, 'dist', 'index.js'));
fs.copyFileSync(path.join(src, 'host.json'), path.join(out, 'host.json'));

// Runtime manifest only: no devDependencies, no workspace references, and
// no build script for Oryx to trip over.
const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
fs.writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'lineup-api',
      version: pkg.version,
      type: 'module',
      main: 'dist/index.js',
      dependencies: pkg.dependencies,
    },
    null,
    2,
  ),
);

console.log('installing production dependencies...');
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
  cwd: out,
  stdio: 'inherit',
  shell: true,
});

const mods = fs.readdirSync(path.join(out, 'node_modules')).filter((d) => !d.startsWith('.'));
console.log(`staged ${out}`);
console.log(`  modules: ${mods.length}`);
for (const required of ['@azure', 'pg']) {
  const ok = fs.existsSync(path.join(out, 'node_modules', required));
  console.log(`  ${required}: ${ok ? 'present' : 'MISSING'}`);
}

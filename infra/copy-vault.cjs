/**
 * Copy every secret from one Key Vault to another and verify each one
 * round-trips byte-exact.
 *
 * Used to rename a vault, which Azure cannot do in place: the name is part of
 * the resource's global DNS identity.
 *
 * Usage: node infra/copy-vault.cjs <sourceVault> <targetVault>
 */
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

const [source, target] = process.argv.slice(2);
if (!source || !target) {
  console.error('usage: node infra/copy-vault.cjs <sourceVault> <targetVault>');
  process.exit(1);
}

const sh = (args) =>
  execFileSync('az', args, { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });

const digest = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);

const read = (vault, name) =>
  sh([
    'keyvault', 'secret', 'show',
    '--vault-name', vault, '--name', name,
    '--query', 'value', '-o', 'tsv', '--only-show-errors',
  ]).replace(/\r?\n$/, '');

const names = sh([
  'keyvault', 'secret', 'list',
  '--vault-name', source, '--query', '[].name', '-o', 'tsv', '--only-show-errors',
])
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);

console.log(`copying ${names.length} secret(s): ${source} -> ${target}\n`);

let fails = 0;
for (const name of names) {
  const value = read(source, name);
  sh([
    'keyvault', 'secret', 'set',
    '--vault-name', target, '--name', name,
    '--value', `"${value.replace(/"/g, '\\"')}"`,
    '--only-show-errors', '-o', 'none',
  ]);

  // Read it back from the TARGET rather than trusting the write, so a
  // quoting bug cannot silently corrupt a connection string.
  const copied = read(target, name);
  const ok = copied === value;
  if (!ok) fails++;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}  ${digest(value)}${ok ? '' : ` != ${digest(copied)}`}`,
  );
}

console.log(fails ? `\n${fails} secret(s) did not match` : '\nevery secret copied exactly');
process.exit(fails ? 1 : 0);

import { build } from 'esbuild';

/**
 * Bundle the API into a single file.
 *
 * Static Web Apps packages the `api` folder on its own, so the npm-workspace
 * symlink to @lineup/shared would not resolve at runtime. Inlining it here
 * removes that dependency entirely. Only true runtime packages stay external
 * so the platform can install them normally.
 */
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/index.js',
  sourcemap: false,
  external: ['@azure/functions', 'pg'],
  banner: {
    // pg reaches for require() internally; ESM output needs a shim.
    js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});

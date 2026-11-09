/**
 * Bundle the VS Code integration tests.
 *
 * They are bundled rather than compiled file-by-file for one specific reason:
 * `require('vscode')` only resolves inside an extension host, so the suite must
 * be a single CommonJS file that the host can load, with `vscode` left external
 * and resolved at runtime. Bundling also lets the suite import `src/**`
 * directly, so it exercises the real implementation instead of a mock.
 */

import * as esbuild from 'esbuild';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');

await esbuild.build({
  entryPoints: [
    path.join(root, 'test', 'vscode', 'runTests.ts'),
    path.join(root, 'test', 'vscode', 'suite', 'index.ts'),
  ],
  outdir: path.join(root, 'out-test'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // Resolved by the extension host at runtime, never bundled.
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
});

console.log('[test:vscode] bundled out-test/');

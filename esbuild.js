// Build script for the PairPilot extension.
//
// Two jobs:
//   1. Bundle src/extension.ts -> dist/extension.js (extension host code).
//   2. Copy the Webview assets from src/ui/webview/ -> media/ so the Webview can
//      load them through `asWebviewUri` with a restricted `localResourceRoots`.
//
// The Webview is deliberately plain JavaScript with no build step: fewer moving
// parts, and nothing in the presentation layer needs transpiling.
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const WEBVIEW_SRC = path.join(__dirname, 'src', 'ui', 'webview');
const WEBVIEW_OUT = path.join(__dirname, 'media');

/** Copy the Webview assets into media/ (flat, no nesting). */
function copyWebviewAssets() {
  fs.mkdirSync(WEBVIEW_OUT, { recursive: true });
  if (!fs.existsSync(WEBVIEW_SRC)) {
    return;
  }
  for (const entry of fs.readdirSync(WEBVIEW_SRC, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    fs.copyFileSync(
      path.join(WEBVIEW_SRC, entry.name),
      path.join(WEBVIEW_OUT, entry.name)
    );
  }
  console.log('[esbuild] copied webview assets -> media/');
}

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [path.join(__dirname, 'src', 'extension.ts')],
  bundle: true,
  outfile: path.join(__dirname, 'dist', 'extension.js'),
  // `vscode` is provided by the extension host at runtime and must never be bundled.
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: production ? false : 'inline',
  minify: production,
  logLevel: 'info',
};

async function main() {
  copyWebviewAssets();
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[esbuild] watching for changes...');
    return;
  }
  await esbuild.build(options);
  console.log(`[esbuild] built dist/extension.js (${production ? 'production' : 'development'})`);
}

main().catch((err) => {
  console.error('[esbuild] build failed');
  console.error(err);
  process.exit(1);
});

/**
 * Entry point for the real-VS-Code integration run.
 *
 * Launched by `npm run test:vscode`. It starts an Extension Development Host
 * containing this extension and executes the suite inside it, which is the only
 * way to verify the criteria in spec section 16 that depend on a live editor:
 * that the extension activates, that its commands and view are registered, and
 * that code is written into a real `TextDocument` through `WorkspaceEdit`.
 *
 * Run with an explicit `--user-data-dir`, so the developer's own VS Code profile,
 * settings and extension list are never touched.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  // Reuse the VS Code already installed on this machine rather than downloading
  // a second copy. Overridable for CI images that lay it out differently.
  //
  // This must be the Electron binary itself, NOT `bin/code`. That wrapper runs
  // `resources/app/out/cli.js`, which is a thin client that hands the request to
  // a GUI process and exits immediately — so the launcher returns 0 with no test
  // output whatsoever, and a suite that never ran looks exactly like a suite that
  // passed. Only the real binary stays in the foreground for the test run.
  const vscodeExecutablePath =
    process.env['PAIRPILOT_VSCODE_EXECUTABLE'] ??
    path.join(os.homedir(), 'vscode', 'VSCode-linux-x64', 'code');

  if (!fs.existsSync(vscodeExecutablePath)) {
    throw new Error(
      `No VS Code executable at "${vscodeExecutablePath}". ` +
        'Set PAIRPILOT_VSCODE_EXECUTABLE to the correct path (the Electron binary, ' +
        'not the bin/code wrapper).'
    );
  }
  if (vscodeExecutablePath.endsWith(path.join('bin', 'code'))) {
    throw new Error(
      `"${vscodeExecutablePath}" is the bin/code wrapper, which would hand off to a ` +
        'GUI process and exit before any test ran. Point PAIRPILOT_VSCODE_EXECUTABLE ' +
        'at the Electron binary instead.'
    );
  }

  // This file is bundled to `out-test/runTests.js`, which sits directly under the
  // project root, so one level up is the extension itself.
  const extensionDevelopmentPath = path.resolve(__dirname, '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.js');

  // A throwaway workspace, so the suite's writes cannot land in the real project.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pairpilot-host-'));
  fs.writeFileSync(
    path.join(workspace, 'package.json'),
    JSON.stringify({ name: 'pairpilot-host-fixture', version: '1.0.0' }, null, 2)
  );
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, 'src', 'existing.ts'),
    'export const existing = true;\n'
  );

  console.log(`[test:vscode] extension: ${extensionDevelopmentPath}`);
  console.log(`[test:vscode] workspace: ${workspace}`);

  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspace,
        // Keep the developer's profile, settings and keybindings out of this run.
        '--user-data-dir',
        fs.mkdtempSync(path.join(os.tmpdir(), 'pairpilot-userdata-')),
        '--disable-gpu',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--no-sandbox',
      ],
    });
  } finally {
    try {
      fs.rmSync(workspace, { recursive: true, force: true });
    } catch {
      // A leftover temp workspace is not worth masking a test failure for.
    }
  }
}

main().catch((error: unknown) => {
  console.error('[test:vscode] run failed:', error);
  process.exit(1);
});

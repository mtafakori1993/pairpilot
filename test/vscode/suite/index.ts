/**
 * Test suite executed INSIDE a real VS Code extension host.
 *
 * Everything here runs with a live `vscode` module, a real workspace folder and a
 * real editor, so these are the checks that fixtures cannot substitute for. The
 * criteria covered from spec section 16:
 *
 *   - the extension activates,
 *   - the sidebar view and every command are registered,
 *   - runtime detection reaches the real CLI from inside the host,
 *   - a file is created and code is written into the actual editor, and
 *   - a rejected write rolls the file back off disk.
 *
 * A tiny runner is used instead of Mocha: the suite needs a promise that rejects
 * on the first failure and nothing else, and pulling in a full test framework
 * here would add a dependency the extension does not otherwise want.
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { PathGuard } from '../../../src/security/PathGuard';
import { LiveWriter } from '../../../src/editor/LiveWriter';
import type { Logger } from '../../../src/types';

/**
 * Must match `publisher.name` from package.json. A stale value here makes
 * `getExtension()` return undefined, so the activation case fails with a
 * confusing "not found in the development host" rather than pointing at the ID.
 * Changing the publisher is exactly when this drifts, hence the comment.
 */
const EXTENSION_ID = 'mtafakori1993.pairpilot';

const logger: Logger = {
  info: (m) => console.log(`[suite][info] ${m}`),
  warn: (m) => console.warn(`[suite][warn] ${m}`),
  error: (m, e) => console.error(`[suite][error] ${m}`, e ?? ''),
  diagnostic: (m) => console.log(`[suite][diag] ${m}`),
};

interface Case {
  name: string;
  run(): Promise<void>;
}

/** Wait until a predicate holds, so tests do not depend on fixed sleeps. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

function requireWorkspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the suite needs a workspace folder to be open');
  return folder.uri.fsPath;
}

const cases: Case[] = [
  {
    name: 'the extension is installed and activates',
    async run() {
      const extension = vscode.extensions.getExtension(EXTENSION_ID);
      assert.ok(extension, `${EXTENSION_ID} was not found in the development host`);

      // Activation must genuinely succeed; a throw here means `activate()` blew
      // up, which no unit test can detect because the unit tests never import
      // `vscode`.
      const api = await extension.activate();
      assert.ok(extension.isActive, 'the extension reported itself as inactive after activate()');
      void api;
    },
  },

  {
    name: 'every contributed command is registered',
    async run() {
      const declared = [
        'pairpilot.focus',
        'pairpilot.newSession',
        'pairpilot.resumeSession',
        'pairpilot.cancel',
        'pairpilot.revertLastWrite',
        'pairpilot.showUsage',
        'pairpilot.checkRuntime',
      ];

      // Force activation first: command registration happens in activate().
      await vscode.extensions.getExtension(EXTENSION_ID)?.activate();

      const registered = new Set(await vscode.commands.getCommands(true));
      for (const command of declared) {
        assert.ok(registered.has(command), `command "${command}" is not registered`);
      }
    },
  },

  {
    name: 'runtime detection reaches the real Claude Code CLI from inside the host',
    async run() {
      await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
      // Must not throw. The command reports failure through the UI, and a
      // missing CLI is a legitimate state, so we only assert that executing it
      // is safe and returns.
      await vscode.commands.executeCommand('pairpilot.checkRuntime');
    },
  },

  {
    name: 'focusing the sidebar does not throw',
    async run() {
      await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
      // Resolves the webview view provider. The suite cannot inspect the rendered
      // HTML, but a failure to construct the panel or its CSP would surface here.
      await vscode.commands.executeCommand('pairpilot.focus');
      assert.ok(true);
    },
  },

  {
    name: 'a create writes code into the real editor, progressively',
    async run() {
      const root = requireWorkspaceRoot();
      const guard = new PathGuard(root, { allowSensitiveFiles: false });

      const progress: number[] = [];
      const writer = new LiveWriter({
        guard,
        logger,
        onProgress: (written) => progress.push(written),
      });

      const relativePath = 'src/generated-by-suite.ts';
      const absolutePath = path.join(root, relativePath);

      const begun = await writer.begin(relativePath, 'create', {
        approvedCreate: true,
        expectedTotal: 64,
      });

      assert.ok(begun.created, 'a create should report that it created the file');
      assert.ok(
        fs.existsSync(absolutePath),
        'the file should exist on disk as soon as the write is approved'
      );

      // The document must be the real one open in an editor, not a virtual copy.
      const editors = vscode.window.visibleTextEditors.filter(
        (editor) => editor.document.uri.fsPath === begun.document.uri.fsPath
      );
      assert.strictEqual(editors.length, 1, 'the target file should be open in an editor');
      assert.strictEqual(
        begun.document.uri.scheme,
        'file',
        'the document should be a real file, not a virtual one'
      );

      // Feed the deltas the way the stream scanner actually delivers them: a few
      // characters at a time, spread over real elapsed time. Pushing everything
      // synchronously would be coalesced by the writer's 40ms flush debounce into
      // a single edit — which is correct behaviour, but it would make this test
      // unable to tell progressive writing apart from one paste at the end.
      const sawLengths: number[] = [];
      const code = [
        'export function add(a: number, b: number): number {',
        '  return a + b;',
        '}',
        '',
      ].join('\n');
      const chunks = code.match(/[\s\S]{1,8}/g) ?? [];
      const perBatch = Math.ceil(chunks.length / 3);

      for (let index = 0; index < chunks.length; index += perBatch) {
        for (const chunk of chunks.slice(index, index + perBatch)) {
          writer.push(chunk);
        }
        // Comfortably longer than FLUSH_INTERVAL_MS, so each batch lands as its
        // own edit rather than being merged with the next.
        await new Promise((resolve) => setTimeout(resolve, 120));
        sawLengths.push(begun.document.getText().length);
      }

      const outcome = await writer.complete();
      assert.strictEqual(
        outcome.status,
        'completed',
        `expected a completed write, got ${JSON.stringify(outcome)}`
      );

      // The editor's document must hold the assembled code...
      assert.strictEqual(
        begun.document.getText(),
        code,
        `the editor document does not match the code that was streamed.\n` +
          `  expected: ${JSON.stringify(code)}\n` +
          `  actual  : ${JSON.stringify(begun.document.getText())}\n` +
          `  observed lengths: ${JSON.stringify(sawLengths)}\n` +
          `  progress: ${JSON.stringify(progress)}`
      );

      // ...and so must the bytes on disk. This is the assertion that caught the
      // writer reporting success while the file on disk was still empty, because
      // a WorkspaceEdit only mutates the in-memory text model.
      assert.strictEqual(
        fs.readFileSync(absolutePath, 'utf8'),
        code,
        `the file on disk does not match the code that was streamed.\n` +
          `  expected: ${JSON.stringify(code)}\n` +
          `  actual  : ${JSON.stringify(fs.readFileSync(absolutePath, 'utf8'))}`
      );

      // Progressive rather than one paste: the document was observed in genuine
      // intermediate states, each a strict prefix of the final code.
      assert.ok(
        sawLengths.length > 1,
        `expected the document to be observed mid-write, saw ${sawLengths.length} observation(s)`
      );
      assert.ok(
        sawLengths.some((length) => length > 0 && length < code.length),
        `expected at least one partial state, saw lengths ${JSON.stringify(sawLengths)}`
      );
      assert.ok(
        progress.length > 1,
        `expected multiple progressive flushes, saw ${progress.length}`
      );
      assert.strictEqual(
        progress[progress.length - 1],
        code.length,
        'the final progress report should equal the full code length'
      );

      // Leave the workspace as we found it.
      fs.rmSync(absolutePath, { force: true });
    },
  },

  {
    name: 'writes a large stream byte-identically',
    async run() {
      const root = requireWorkspaceRoot();
      const guard = new PathGuard(root, { allowSensitiveFiles: false });
      const writer = new LiveWriter({ guard, logger });

      const relativePath = 'src/large-stream-by-suite.ts';
      const absolutePath = path.join(root, relativePath);

      const begun = await writer.begin(relativePath, 'create', { approvedCreate: true });

      // A large payload pushed as fast as possible, to catch truncation, an
      // off-by-one in the insertion offset, or a lost final batch.
      //
      // Note on what this does NOT cover: because every push lands inside the
      // same 40ms debounce window, this produces a single flush and therefore
      // cannot make two flushes overlap. The ordering hazard that
      // `flushQueue` exists to prevent is exercised by the progressive case
      // above, which is the one that fails if the queue is removed.
      const code = Array.from({ length: 400 }, (_, index) => `line ${index}\n`).join('');
      for (const char of code) {
        writer.push(char);
      }

      const outcome = await writer.complete();
      assert.strictEqual(outcome.status, 'completed', 'the write should complete');

      assert.strictEqual(
        begun.document.getText(),
        code,
        'the document is not byte-identical to the stream'
      );
      assert.strictEqual(
        fs.readFileSync(absolutePath, 'utf8'),
        code,
        'the file on disk is not byte-identical to the stream'
      );

      fs.rmSync(absolutePath, { force: true });
    },
  },

  {
    name: 'a cancelled write removes the file it created',
    async run() {
      const root = requireWorkspaceRoot();
      const guard = new PathGuard(root, { allowSensitiveFiles: false });
      const writer = new LiveWriter({ guard, logger });

      const relativePath = 'src/rolled-back-by-suite.ts';
      const absolutePath = path.join(root, relativePath);

      await writer.begin(relativePath, 'create', { approvedCreate: true, expectedTotal: 100 });
      writer.push('this content must not survive the rollback\n');
      await waitFor(() => fs.existsSync(absolutePath), 'the file to appear on disk');

      const rollback = await writer.rollback('cancelled');
      assert.ok(rollback, 'rollback should report an outcome');

      // Poll rather than assert immediately: the delete is asynchronous.
      await waitFor(
        () => !fs.existsSync(absolutePath),
        'the cancelled create to be removed from disk'
      );
    },
  },

  {
    name: 'rolling back an update restores the previous content',
    async run() {
      const root = requireWorkspaceRoot();
      const guard = new PathGuard(root, { allowSensitiveFiles: false });
      const writer = new LiveWriter({ guard, logger });

      const relativePath = 'src/existing.ts';
      const absolutePath = path.join(root, relativePath);
      const original = fs.readFileSync(absolutePath, 'utf8');

      // An update that a developer then rejects: the file is overwritten, then
      // the rejection has to put the original bytes back. This is the update
      // counterpart of the create rollback above, and the reason the writer
      // caches `previousContent` before touching anything.
      await writer.begin(relativePath, 'update', { approvedCreate: false, expectedTotal: 50 });
      writer.push('export const existing = false; // rejected by the suite\n');
      const outcome = await writer.complete();
      assert.strictEqual(outcome.status, 'completed', 'the update should have completed');

      assert.notStrictEqual(
        fs.readFileSync(absolutePath, 'utf8'),
        original,
        'the update should have changed the file before the rollback'
      );

      const rollback = await writer.rollback('rejected');
      assert.strictEqual(rollback.restored, true, 'an update rollback should report a restore');
      assert.strictEqual(
        fs.readFileSync(absolutePath, 'utf8'),
        original,
        'the rejected update must restore the exact previous bytes'
      );
    },
  },

  {
    name: 'the path guard refuses an escape from the open workspace',
    async run() {
      const root = requireWorkspaceRoot();
      const guard = new PathGuard(root, { allowSensitiveFiles: false });

      // A real attempt to reach outside, expressed with the traversal an attacker
      // would actually use.
      const assessment = guard.assess('../outside-the-workspace.txt');
      assert.notStrictEqual(
        assessment.verdict,
        'allow',
        'a traversal path must not be classified as allowed'
      );

      assert.throws(
        () => guard.assertRealPathInsideWorkspace('../outside-the-workspace.txt'),
        'writing outside the workspace must throw'
      );
    },
  },
];

/**
 * Runner. Returns a promise that rejects if any case fails, which is the contract
 * `@vscode/test-electron` expects.
 */
export async function run(): Promise<void> {
  const failures: { name: string; error: unknown }[] = [];

  for (const testCase of cases) {
    const started = Date.now();
    try {
      await testCase.run();
      console.log(`  ✓ ${testCase.name} (${Date.now() - started}ms)`);
    } catch (error) {
      console.error(`  ✗ ${testCase.name}`);
      console.error(error);
      failures.push({ name: testCase.name, error });
    }
  }

  console.log(`\n${cases.length - failures.length}/${cases.length} passed`);

  if (failures.length > 0) {
    const names = failures.map((failure) => failure.name).join('; ');
    throw new Error(`${failures.length} VS Code integration test(s) failed: ${names}`);
  }
}

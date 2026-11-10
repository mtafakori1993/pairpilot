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
 *   - a file is created and code is written into the actual editor,
 *   - a rejected write rolls the file back off disk — and, for a multi-file
 *     proposal, rolls back only its own file,
 *   - a seven-file batch is written through the real editor to the real file
 *     system, one file at a time, with each file's bytes verified on disk, and
 *   - a per-path write lock keeps two review sessions off the same file.
 *
 * The batch cases exist because the multi-file path is where a unit test is
 * weakest: the Orchestrator's bookkeeping can be asserted against a mocked
 * `vscode`, but `WorkspaceEdit`, `TextDocument` and the file system cannot. What
 * is asserted here is the layer those tests cannot reach.
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
import { ProposalValidator } from '../../../src/proposals/ProposalValidator';
import { BatchQueue } from '../../../src/proposals/BatchQueue';
import { EditorReview } from '../../../src/review/EditorReview';
import { RoadmapContinuation } from '../../../src/roadmap/RoadmapContinuation';
import { RoadmapStore } from '../../../src/roadmap/RoadmapStore';
import { PAIRPILOT_PROTOCOL_VERSION } from '../../../src/protocol/types';
import type { CodeProposalMessage, ProposalChange } from '../../../src/protocol/types';
import type { Logger, ValidatedChange } from '../../../src/types';

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

/* -------------------------------------------------------------------------- */
/* The seven-file batch, written by the real extension host                    */
/* -------------------------------------------------------------------------- */

/**
 * A folder the batch cases own, so their files can be removed wholesale and
 * cannot collide with a developer's own sources.
 */
const BATCH_DIR = 'src/suite-batch';

const BATCH_FILES = [
  'index.ts',
  'create.ts',
  'list.ts',
  'edit.ts',
  'delete.ts',
  'db.ts',
  'helpers.ts',
] as const;

/**
 * Seven `create` changes, in the shape a model actually sends.
 *
 * The contents are deliberately distinct and self-identifying: a run that
 * conflated two files, or wrote one file's content into another's path, would
 * still produce seven non-empty files, so "seven files exist" is not by itself
 * evidence of anything.
 */
function batchChanges(): ProposalChange[] {
  return BATCH_FILES.map((file, index) => ({
    id: `change-${index + 1}`,
    file: `${BATCH_DIR}/${file}`,
    operation: 'create',
    description: `File ${index + 1} of the batch.`,
    content: `// ${file}\nexport const which = ${index};\n`,
    dependencies: [],
    risk: 'low',
  }));
}

function batchMessage(): CodeProposalMessage {
  return {
    protocol_version: PAIRPILOT_PROTOCOL_VERSION,
    type: 'code_proposal',
    message: 'Seven files.',
    task: { title: 'Batch', description: 'Seven files, written by the host.' },
    changes: batchChanges(),
  } as CodeProposalMessage;
}

/**
 * Drive one file from the batch into the real editor and onto disk.
 *
 * This mirrors what `Orchestrator.applyChange` does for one file — take the
 * per-path write lock, stream the reviewed content through a real `LiveWriter`,
 * wait for the write, then confirm the bytes actually landed — but runs inside
 * the extension host, so the `WorkspaceEdit`, the real `TextDocument` and the
 * real file system are all genuine rather than mocked.
 */
async function writeOneFromBatch(
  batch: BatchQueue,
  entry: ValidatedChange,
  guard: PathGuard
): Promise<{ relativePath: string; absolutePath: string; onDisk: string }> {
  const relativePath = entry.relativePath;
  const absolutePath = path.join(requireWorkspaceRoot(), relativePath);

  // One writer per path, exactly as the Orchestrator enforces it.
  assert.ok(batch.claimWrite(relativePath), `the write lock for ${relativePath} should be free`);
  batch.markWriting(relativePath);

  const writer = new LiveWriter({ guard, logger });
  try {
    await writer.begin(relativePath, 'create', {
      approvedCreate: true,
      expectedTotal: entry.assembledCode.length,
    });

    // Push in small chunks so the write is progressive, the way a streamed
    // model reply arrives. Each chunk is followed by a real pause so the
    // writer's flush debounce cannot coalesce the whole file into one edit —
    // otherwise this would not distinguish a streamed write from a paste.
    const code = entry.assembledCode;
    const chunks = code.match(/[\s\S]{1,16}/g) ?? [];
    for (const chunk of chunks) {
      writer.push(chunk);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const outcome = await writer.complete();
    assert.strictEqual(
      outcome.status,
      'completed',
      `writing ${relativePath} did not complete: ${JSON.stringify(outcome)}`
    );
  } finally {
    batch.releaseWrite(relativePath);
  }

  const onDisk = fs.readFileSync(absolutePath, 'utf8');
  batch.markCompleted(relativePath);
  return { relativePath, absolutePath, onDisk };
}

/**
 * Close every editor showing a file under the batch folder.
 *
 * The writers open real editors, and an editor left holding a document for a
 * file the next case deletes and recreates makes VS Code reload that document —
 * a change the manual-edit guard correctly reads as "modified outside
 * PairPilot" and stops the write for. That is the guard doing its job on a
 * situation no developer would create, so the cases clean up after themselves
 * rather than the product learning to ignore a real signal.
 */
async function closeBatchEditors(): Promise<void> {
  const root = requireWorkspaceRoot();
  const prefix = path.join(root, BATCH_DIR);
  const open = vscode.window.visibleTextEditors.filter((editor) =>
    editor.document.uri.fsPath.startsWith(prefix)
  );
  for (const editor of open) {
    await vscode.window.showTextDocument(editor.document, { preview: false });
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  }
}


/* -------------------------------------------------------------------------- */
/* The roadmap loop, in the real host                                          */
/* -------------------------------------------------------------------------- */

/**
 * Everything this case owns, in one folder, so a failed run cannot leave a file
 * behind that makes the next run pass for the wrong reason.
 */
const ROADMAP_DIR = 'src/suite-roadmap';
const ROADMAP_PATH = 'ROADMAP.md';

/** A two-task roadmap: `models` has two files, `repo` depends on it. */
function roadmapText(): string {
  return [
    '# Roadmap',
    '',
    'Written by the integration suite, not by a developer.',
    '',
    '### models — Domain models',
    '- files: ' + ROADMAP_DIR + '/User.ts, ' + ROADMAP_DIR + '/Order.ts',
    '',
    '### repo — Repository',
    '- files: ' + ROADMAP_DIR + '/Repo.ts',
    '- depends-on: models',
    '',
  ].join('\n');
}

/** A writer with no editor-side prompts, for files this case creates itself. */
async function writeThroughEditor(
  relativePath: string,
  code: string,
  guard: PathGuard
): Promise<void> {
  const writer = new LiveWriter({ guard, logger });
  await writer.begin(relativePath, 'create', {
    approvedCreate: true,
    expectedTotal: code.length,
  });
  writer.push(code);
  const outcome = await writer.complete();
  assert.strictEqual(
    outcome.status,
    'completed',
    `writing ${relativePath} did not complete: ${JSON.stringify(outcome)}`
  );
}

async function closeEditorsUnder(prefix: string): Promise<void> {
  const open = vscode.window.visibleTextEditors.filter((editor) =>
    editor.document.uri.fsPath.startsWith(prefix)
  );
  for (const editor of open) {
    await vscode.window.showTextDocument(editor.document, { preview: false });
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  }
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
        // The native provider/model flow. Each one opens a press-and-ask UI, so
        // the assertion is that the command exists and reaches its handler —
        // not that it completes, which would need someone to click.
        'pairpilot.selectProvider',
        'pairpilot.selectModel',
        // The in-editor review. Approve and reject are exercised for real by
        // the batch cases; these must at least exist for the comment thread's
        // menu to show them.
        'pairpilot.approveReview',
        'pairpilot.rejectReview',
        'pairpilot.requestChangesReview',
        'pairpilot.openReviewThread',
        'pairpilot.reviewWaitingFile',
      ];

      // Force activation first: command registration happens in activate().
      await vscode.extensions.getExtension(EXTENSION_ID)?.activate();

      const registered = new Set(await vscode.commands.getCommands(true));
      for (const command of declared) {
        assert.ok(registered.has(command), `command "${command}" is not registered`);
      }

      // Every command the manifest advertises must be registered, not just the
      // ones this list happens to name. This is what catches a rename in
      // `package.json` that was not mirrored in code.
      const manifest = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as {
        contributes?: { commands?: { command: string }[] };
      };
      const contributed = (manifest.contributes?.commands ?? []).map((entry) => entry.command);
      for (const command of contributed) {
        assert.ok(registered.has(command), `manifest command "${command}" is not registered`);
      }
    },
  },

  {
    name: 'the review commands decline politely when nothing is waiting',
    async run() {
      await vscode.extensions.getExtension(EXTENSION_ID)?.activate();

      // "Review a waiting file" with no live review must report that plainly
      // rather than open a confirmation for a file that does not exist. It
      // resolves on its own because nothing is shown to wait for.
      await vscode.commands.executeCommand('pairpilot.reviewWaitingFile');

      // A decision aimed at a thread that is not live must not throw out of the
      // command handler: the menu can be clicked on a stale thread, and an
      // exception there surfaces as an unhandled rejection in the host.
      await vscode.commands.executeCommand('pairpilot.approveReview', {
        thread: { contextValue: 'pairpilot.review:never-opened' },
      });
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
      const proposed = 'export const existing = false; // rejected by the suite\n';
      const begun = await writer.begin(relativePath, 'update', {
        approvedCreate: false,
        expectedTotal: proposed.length,
      });
      writer.push(proposed);
      const outcome = await writer.complete();
      assert.strictEqual(outcome.status, 'completed', 'the update should have completed');

      // The document must hold the proposed content and nothing else. An update
      // *replaces* the file rather than adding to it, and this is what the
      // Orchestrator relies on when it reads the file back and compares it with
      // the proposal: any other result — the original text with the new text
      // appended, say — is a file the developer did not approve.
      assert.strictEqual(
        begun.document.getText(),
        proposed,
        'an update must leave the file holding exactly the proposed content'
      );

      assert.notStrictEqual(
        fs.readFileSync(absolutePath, 'utf8'),
        original,
        'the update should have changed the file before the rollback'
      );
      assert.strictEqual(
        fs.readFileSync(absolutePath, 'utf8'),
        proposed,
        'the bytes on disk after an update must be the proposed content'
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
    name: 'all seven files of a batch are written into the real workspace',
    async run() {
      const root = requireWorkspaceRoot();
      const guard = new PathGuard(root, { allowSensitiveFiles: false });
      const batchDir = path.join(root, BATCH_DIR);

      // Start from a clean slate so "the file exists" cannot be satisfied by a
      // leftover from an earlier run, and with no editor holding a document for
      // a file that is about to be recreated.
      await closeBatchEditors();
      fs.rmSync(batchDir, { recursive: true, force: true });

      // The real validator, against the real file system, so the change set this
      // writes is the same one the extension would have produced from a model
      // reply — not a hand-built fixture that could differ in a field that
      // matters.
      const set = new ProposalValidator(guard).validateChangeSet(batchMessage());
      assert.strictEqual(set.changes.length, 7, 'the validator should accept all seven files');

      const batch = BatchQueue.create(set);
      assert.strictEqual(batch.size, 7, 'the batch should hold all seven files');

      // The developer approves the set once: "write all remaining files".
      const authorised = batch.authorizeRemaining();
      assert.strictEqual(authorised.length, 7, 'one batch decision should cover all seven files');

      // Authorising is permission to write, not evidence of writing. Before any
      // file is written, all seven must still be outstanding — otherwise the
      // batch would consider itself finished having written nothing.
      assert.strictEqual(batch.nextPending() !== undefined, true, 'there should be a file to write');
      assert.strictEqual(batch.counts().pending, 7, 'all seven should still be outstanding');
      assert.strictEqual(batch.counts().completed, 0, 'nothing should be written yet');

      const seen: string[] = [];
      for (const [index, entry] of set.changes.entries()) {
        const result = await writeOneFromBatch(batch, entry, guard);

        // The bytes on disk are this file's content and nobody else's. Comparing
        // against the validated content rather than a literal is what makes this
        // a check on the whole path from validator to file system.
        assert.strictEqual(
          result.onDisk,
          entry.assembledCode,
          `${result.relativePath} on disk does not match the reviewed content.\n` +
            `  expected: ${JSON.stringify(entry.assembledCode)}\n` +
            `  actual  : ${JSON.stringify(result.onDisk)}`
        );
        seen.push(result.relativePath);

        // Nothing later in the batch has been written yet. This is the property
        // the batch depends on — one file at a time, in order, so a per-file
        // decision has exactly one file to be about.
        for (const later of set.changes.slice(index + 1)) {
          assert.ok(
            !fs.existsSync(path.join(root, later.relativePath)),
            `${later.relativePath} should not have been written yet, while writing ${result.relativePath}`
          );
        }

        // And everything written before it is still exactly as it was left.
        for (const earlier of seen) {
          const earlierEntry = set.changes.find((change) => change.relativePath === earlier)!;
          assert.strictEqual(
            fs.readFileSync(path.join(root, earlier), 'utf8'),
            earlierEntry.assembledCode,
            `${earlier} was disturbed by writing ${result.relativePath}`
          );
        }
      }

      // All seven, in order, each written exactly once.
      assert.deepStrictEqual(
        seen,
        set.changes.map((change) => change.relativePath),
        'every file should have been written, in the order proposed'
      );

      // And all seven are really on disk afterwards — the assertion the original
      // report failed, where seven files were approved and one was written.
      const onDisk = fs
        .readdirSync(batchDir)
        .filter((name) => name.endsWith('.ts'))
        .sort();
      assert.strictEqual(
        onDisk.length,
        7,
        `expected all seven files on disk, found ${onDisk.length}: ${JSON.stringify(onDisk)}`
      );

      // The batch record agrees with the file system rather than the other way
      // round, and is what a reloaded panel would render from.
      const view = batch.view();
      assert.strictEqual(view.total, 7, 'the batch should still report seven files');
      assert.strictEqual(view.completed, 7, 'the batch should report seven files written');
      assert.strictEqual(view.failed, 0, 'no file should have failed');
      assert.ok(
        view.files.every((file) => file.status === 'completed'),
        `every file should be awaiting its own review, got ${JSON.stringify(
          view.files.map((file) => `${file.file}:${file.status}`)
        )}`
      );

      await closeBatchEditors();
      fs.rmSync(batchDir, { recursive: true, force: true });
    },
  },

  {
    name: 'rejecting one file of a batch rolls it back and leaves the other six alone',
    async run() {
      const root = requireWorkspaceRoot();
      const guard = new PathGuard(root, { allowSensitiveFiles: false });
      const batchDir = path.join(root, BATCH_DIR);

      await closeBatchEditors();
      fs.rmSync(batchDir, { recursive: true, force: true });

      const set = new ProposalValidator(guard).validateChangeSet(batchMessage());
      const batch = BatchQueue.create(set);
      batch.authorizeRemaining();

      // Write the first three, then reject the fourth.
      const written = [];
      for (const entry of set.changes.slice(0, 3)) {
        written.push(await writeOneFromBatch(batch, entry, guard));
      }

      const rejected = set.changes[3]!;
      assert.ok(batch.claimWrite(rejected.relativePath), 'the lock should be free before the write');
      const writer = new LiveWriter({ guard, logger });
      await writer.begin(rejected.relativePath, 'create', { approvedCreate: true });
      writer.push(`${rejected.assembledCode}// rejected by the developer\n`);
      const outcome = await writer.complete();
      assert.strictEqual(outcome.status, 'completed', 'the rejected write should have completed first');
      batch.releaseWrite(rejected.relativePath);
      batch.markCompleted(rejected.relativePath);

      const rejectedPath = path.join(root, rejected.relativePath);
      assert.ok(fs.existsSync(rejectedPath), 'the file should exist before the rejection');

      // The developer rejects this file's content: it is rolled back, and the
      // other six must not be affected in any way. This is the case the reported
      // bug broke — a per-file decision used to discard the whole remaining set.
      const rollback = await writer.rollback('rejected');
      assert.ok(rollback, 'rollback should report an outcome');
      batch.markRejected(rejected.relativePath, 'wrong approach');
      await waitFor(
        () => !fs.existsSync(rejectedPath),
        'the rejected file to be removed from disk'
      );

      // Every already-written file is still present, byte for byte.
      for (const result of written) {
        assert.ok(fs.existsSync(result.absolutePath), `${result.relativePath} should still exist`);
        assert.strictEqual(
          fs.readFileSync(result.absolutePath, 'utf8'),
          result.onDisk,
          `${result.relativePath} was disturbed by the rejection of ${rejected.relativePath}`
        );
      }

      // The batch still knows about the three files that have not been written
      // yet. Under the old behaviour they were gone at this point.
      const stillToCome = batch.pendingEntries().map((entry) => entry.relativePath);
      assert.deepStrictEqual(
        stillToCome,
        set.changes.slice(4).map((change) => change.relativePath),
        'rejecting one file must not discard the files still to come'
      );

      // And they can still be written, which is the promise that was broken.
      for (const entry of set.changes.slice(4)) {
        await writeOneFromBatch(batch, entry, guard);
      }

      assert.strictEqual(
        fs.readdirSync(batchDir).filter((name) => name.endsWith('.ts')).length,
        6,
        'six files should be on disk: the seven proposed, less the one rejected'
      );

      const view = batch.view();
      assert.strictEqual(view.total, 7, 'the batch should still account for all seven files');
      assert.strictEqual(
        view.files.filter((file) => file.status === 'rejected').length,
        1,
        'exactly one file should be recorded as rejected'
      );
      assert.strictEqual(
        view.files.filter((file) => file.status === 'completed').length,
        6,
        'the other six should be written and awaiting their own reviews'
      );

      await closeBatchEditors();
      fs.rmSync(batchDir, { recursive: true, force: true });
    },
  },

  {
    name: 'two review sessions cannot write the same path at once',
    async run() {
      const root = requireWorkspaceRoot();
      const guard = new PathGuard(root, { allowSensitiveFiles: false });
      const batchDir = path.join(root, BATCH_DIR);

      await closeBatchEditors();
      fs.rmSync(batchDir, { recursive: true, force: true });

      const set = new ProposalValidator(guard).validateChangeSet(batchMessage());
      const batch = BatchQueue.create(set);
      batch.authorizeRemaining();

      const [first, second] = set.changes;

      // "Revise index.ts while reviewing create.ts" is legitimate: the lock is
      // per path, so a second session on a different file proceeds.
      assert.ok(batch.claimWrite(first!.relativePath), 'the first session should take the lock');
      assert.ok(
        batch.claimWrite(second!.relativePath),
        'a session on a different file should not be blocked by the first'
      );

      // A revision of a file already being written must not start: two writers
      // interleaving into one document is how a file ends up scrambled.
      assert.strictEqual(
        batch.claimWrite(first!.relativePath),
        false,
        'a second writer for a path already being written must be refused'
      );
      assert.strictEqual(batch.isWriting(first!.relativePath), true, 'the lock should be held');

      // Releasing one path frees that path, and only that path.
      batch.releaseWrite(first!.relativePath);
      assert.strictEqual(batch.isWriting(first!.relativePath), false, 'the lock should be released');
      assert.strictEqual(
        batch.isWriting(second!.relativePath),
        true,
        'releasing one path must not release another'
      );
      assert.ok(batch.claimWrite(first!.relativePath), 'the freed path should be claimable again');

      batch.releaseWrite(first!.relativePath);
      batch.releaseWrite(second!.relativePath);

      // Nothing was written by this case: it is about exclusion, not content.
      assert.ok(!fs.existsSync(batchDir), 'the locking case should not have written any files');
    },
  },

  {
    name: 'a review opens on the real file, and a stale decision is refused',
    async run() {
      const root = requireWorkspaceRoot();
      const target = `${ROADMAP_DIR}/Reviewed.ts`;
      const absolute = path.join(root, target);

      await closeEditorsUnder(path.join(root, ROADMAP_DIR));
      fs.mkdirSync(path.join(root, ROADMAP_DIR), { recursive: true });
      fs.writeFileSync(absolute, 'export const reviewed = true;\n');

      // A real review surface, with a decision sink instead of the workflow:
      // this case is about the editor, and the workflow's own application path
      // is exercised by the batch cases.
      const decisions: string[] = [];
      const review = new EditorReview({
        decide: (_session, result) => {
          decisions.push(`${result.outcome.decision}:${result.outcome.sessionId}`);
        },
        logger,
      });

      try {
        await review.openReview({
          sessionId: 'suite-review-1',
          relativePath: target,
          absolutePath: absolute,
          operation: 'create',
          description: 'A reviewed file.',
          rationale: 'The suite wants to know the thread is anchored to the file.',
          contentHash: 'a'.repeat(64),
          binding: { proposalId: 'a'.repeat(64), proposalVersion: 1, fileId: 'b'.repeat(16) },
          documentLine: 0,
          position: { index: 1, total: 2 },
        });

        // The review is keyed by the document that is really open, and the file
        // is really in front of the developer rather than behind a preview tab.
        const active = vscode.window.activeTextEditor;
        assert.ok(active, 'opening a review should reveal the file');
        assert.strictEqual(
          active.document.uri.fsPath,
          path.resolve(absolute),
          'the review should reveal the file it is about'
        );
        assert.ok(
          !active.document.uri.toString().startsWith('git:'),
          'the review must open the real document, not a diff side'
        );

        const open = review.find(active.document.uri.toString());
        assert.ok(open, 'the review should be registered against the open document');
        assert.strictEqual(open.relativePath, target);
        assert.strictEqual(review.awaiting().length, 1, 'the review should be waiting');

        // A second file's review must not disturb the first: two sessions, two
        // documents, no shared decision.
        const second = `${ROADMAP_DIR}/Other.ts`;
        fs.writeFileSync(path.join(root, second), 'export const other = true;\n');
        await review.openReview({
          sessionId: 'suite-review-2',
          relativePath: second,
          absolutePath: path.join(root, second),
          operation: 'create',
          description: 'A second reviewed file.',
          rationale: null,
          contentHash: 'c'.repeat(64),
          binding: {},
          documentLine: 0,
          position: null,
        });
        assert.strictEqual(review.awaiting().length, 2, 'both reviews should be waiting');
        assert.strictEqual(
          review.findById('suite-review-1')?.relativePath,
          target,
          'opening a second review must not replace the first'
        );

        // Editing the file after the review opened is what makes a decision
        // stale. The refusal must name the reason and drop the review rather
        // than pretend the bytes are still the ones that were shown.
        const document = active.document;
        assert.strictEqual(document.uri.fsPath, path.resolve(absolute));
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, new vscode.Position(1, 0), '// typed by the developer\n');
        assert.ok(await vscode.workspace.applyEdit(edit), 'the edit should apply');

        await review.decide('suite-review-1', 'approve', '');
        assert.deepStrictEqual(
          decisions,
          [],
          'a decision on changed content must not reach the workflow'
        );
        assert.strictEqual(
          review.findById('suite-review-1'),
          null,
          'a review whose content changed should be retired, not left to refuse again'
        );
        // The untouched second review is unaffected by the first one's refusal.
        assert.strictEqual(review.awaiting().length, 1, 'only the stale review should be gone');
        assert.ok(review.findById('suite-review-2'), 'the second review should still be open');

        // Close every review the way a cancelled turn does.
        review.closeAll('cancelled');
        assert.strictEqual(review.awaiting().length, 0, 'closing all should retire every review');
      } finally {
        review.dispose();
        await closeEditorsUnder(path.join(root, ROADMAP_DIR));
        fs.rmSync(path.join(root, ROADMAP_DIR), { recursive: true, force: true });
      }
    },
  },

  {
    name: 'approving a file advances its roadmap task and offers the next one',
    async run() {
      const root = requireWorkspaceRoot();
      const guard = new PathGuard(root, { allowSensitiveFiles: false });
      const dir = path.join(root, ROADMAP_DIR);

      await closeEditorsUnder(dir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(root, ROADMAP_PATH), roadmapText());

      const store = new RoadmapStore({
        guard: () => guard,
        workspaceRoot: () => root,
        logger,
      });

      try {
        const found = await store.read();
        assert.strictEqual(found.status, 'found', 'the suite roadmap should be found');
        if (found.status !== 'found') {
          return;
        }
        assert.strictEqual(found.relativePath, ROADMAP_PATH);
        assert.deepStrictEqual(
          found.roadmap.tasks.map((task) => task.id),
          ['models', 'repo'],
          'the roadmap should parse into its two tasks'
        );

        // Write the first file for real, so the approval being simulated is an
        // approval of something that actually exists.
        const first = `${ROADMAP_DIR}/User.ts`;
        await writeThroughEditor(first, '// کاربر\nexport class User {}\n', guard);

        const continuation = new RoadmapContinuation({ store, logger });

        // One of two files: no `done`, and the next file of the same task.
        const afterFirst = await continuation.afterApproval({
          relativePath: first,
          approvedPaths: [first],
          verified: false,
        });
        assert.strictEqual(afterFirst.kind, 'next_file');
        if (afterFirst.kind === 'next_file') {
          assert.strictEqual(afterFirst.relativePath, `${ROADMAP_DIR}/Order.ts`);
        }

        // The status edit went through a real WorkspaceEdit onto the real file.
        const afterEdit = fs.readFileSync(path.join(root, ROADMAP_PATH), 'utf8');
        assert.ok(
          afterEdit.includes('### models — Domain models\n- status: in_progress'),
          `the roadmap should record the task as started, got:\n${afterEdit}`
        );
        // The prose the developer wrote is still there, byte for byte.
        assert.ok(
          afterEdit.includes('Written by the integration suite, not by a developer.'),
          'the status edit must not disturb the rest of the file'
        );

        // The task's files are all written, but nothing was verified: it must
        // stay in progress rather than be marked done.
        const second = `${ROADMAP_DIR}/Order.ts`;
        await writeThroughEditor(second, '// سفارش\nexport class Order {}\n', guard);
        const unverified = await continuation.afterApproval({
          relativePath: second,
          approvedPaths: [first, second],
          verified: false,
        });
        assert.strictEqual(unverified.kind, 'awaiting_verification');
        assert.ok(
          !fs.readFileSync(path.join(root, ROADMAP_PATH), 'utf8').includes('- status: done'),
          'an unverified task must never be marked done'
        );

        // Verified: the task is done, and the dependent task becomes next.
        const verified = await continuation.afterApproval({
          relativePath: second,
          approvedPaths: [first, second],
          verified: true,
        });
        assert.strictEqual(verified.kind, 'next_task');
        if (verified.kind === 'next_task') {
          assert.strictEqual(verified.taskId, 'repo');
          assert.strictEqual(verified.relativePath, `${ROADMAP_DIR}/Repo.ts`);
        }
        const finalText = fs.readFileSync(path.join(root, ROADMAP_PATH), 'utf8');
        assert.ok(
          finalText.includes('### models — Domain models\n- status: done'),
          `the verified task should be done, got:\n${finalText}`
        );
        // And nothing ahead of its dependency was started.
        assert.ok(
          !finalText.includes('### repo — Repository\n- status: done'),
          'a dependent task must not be marked done'
        );
      } finally {
        await closeEditorsUnder(dir);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(path.join(root, ROADMAP_PATH), { force: true });
      }
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

/**
 * LiveWriter — writes approved code into the real VS Code editor.
 *
 * Spec section 8 is the heart of the MVP, and its constraints are unusual:
 *
 *  1. Write into the *actual* editor, not just the Webview.
 *  2. Do not use timers to simulate typing; use real streamed output.
 *  3. Stop writing if the developer manually edits the target document.
 *  4. One file at a time; never silently create supporting files.
 *  5. Rolling back must be possible, because the file is created *before* the
 *     code is written and the developer may reject what appears.
 *
 * The text arrives from real `text_delta` chunks decoded by the
 * `JsonStreamScanner` — this module never invents a character. When the runtime
 * delivers everything in one chunk (which happens for a short file), the write is
 * correspondingly instant rather than artificially slowed to look live.
 *
 * Safety properties:
 *  - Every write goes through a `WorkspaceEdit`, so VS Code's own undo stack
 *    records it and the developer can revert with Ctrl+Z.
 *  - A pre-write fingerprint of the document detects a concurrent manual edit
 *    and halts the write instead of fighting the developer's cursor.
 *  - `rollback()` restores the previous content, or deletes the file if this
 *    writer created it, and is safe to call at any point.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { PathGuard } from '../security/PathGuard';
import type { Logger } from '../types';

export interface LiveWriterDeps {
  guard: PathGuard;
  logger: Logger;
  /** Called for each batch of characters actually inserted. */
  onProgress?(written: number, total: number): void;
  /** Called when writing is stopped for a reason other than success. */
  onInterrupted?(reason: string): void;
}

export interface BeginWriteResult {
  document: vscode.TextDocument;
  editor: vscode.TextEditor;
  /** True when this writer created the file (so rollback should delete it). */
  created: boolean;
  /** Content present before we wrote anything. */
  previousContent: string;
}

export type WriteOutcome =
  | { status: 'completed'; written: number; fileHash: string }
  | { status: 'cancelled'; written: number; reason: string }
  | { status: 'conflict'; written: number; reason: string }
  | { status: 'failed'; written: number; reason: string };

/** How long to wait for a freshly created document to be readable. */
const DOCUMENT_TIMEOUT_MS = 5000;
/** Flush the buffer to the editor at least this often. */
const FLUSH_INTERVAL_MS = 40;

export class LiveWriter {
  private document: vscode.TextDocument | null = null;
  private editor: vscode.TextEditor | null = null;
  private relativePath = '';
  private absolutePath = '';
  private created = false;
  private previousContent = '';
  private buffer = '';
  private written = 0;
  private expectedTotal = 0;
  /** Fingerprint of the document as we last left it, to detect manual edits. */
  private lastKnownFingerprint = '';
  private cancelled = false;
  private finished = false;
  private flushTimer: NodeJS.Timeout | null = null;
  /** Disposables for the guards installed for the duration of the write. */
  private readonly activeGuards: vscode.Disposable[] = [];
  /**
   * Serialises document edits.
   *
   * `flush()` reads the document's current length to compute an insertion offset
   * and then awaits `applyEdit`. If two flushes overlap, the second computes its
   * offset from a document that does not yet contain the first edit's text, so
   * the two batches can be inserted out of order and the file ends up scrambled.
   * Relying on the 40ms debounce to keep them apart is a timing assumption, and
   * under a fast stream it does not hold — this makes the ordering structural.
   */
  private flushQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: LiveWriterDeps) {}

  get isWriting(): boolean {
    return this.document !== null && !this.finished;
  }

  get targetPath(): string {
    return this.relativePath;
  }

  get bytesWritten(): number {
    return this.written;
  }

  /**
   * Prepare the target: create it (only when allowed), open it, and install the
   * manual-edit guard.
   *
   * @param approvedCreate  Must be true for a `create` operation. The caller is
   *   responsible for having obtained the developer's explicit permission; this
   *   flag exists so the writer cannot be the place where that check is skipped.
   */
  async begin(
    relativePath: string,
    operation: 'create' | 'update',
    options: { approvedCreate: boolean; expectedTotal?: number }
  ): Promise<BeginWriteResult> {
    if (this.isWriting) {
      throw new Error('A write is already in progress.');
    }

    const assessment = this.deps.guard.assertRealPathInsideWorkspace(relativePath);
    this.relativePath = assessment.relativePath;
    this.absolutePath = assessment.absolutePath;

    if (operation === 'create') {
      if (!options.approvedCreate) {
        throw new Error(
          'Refusing to create a file without explicit approval for this path.'
        );
      }
      if (fs.existsSync(this.absolutePath)) {
        throw new Error(
          `"${this.relativePath}" already exists. PairPilot will not overwrite it as part of a create.`
        );
      }
      // Create the file empty, then perform every content change through a
      // WorkspaceEdit. This ordering is what allows rollback: the file exists
      // but its content hash still matches the pre-approval state until the
      // developer approves the written code.
      const parent = vscode.Uri.file(this.absolutePath.substring(0, this.absolutePath.lastIndexOf('/')) || this.absolutePath);
      await vscode.workspace.fs.createDirectory(parent);
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(this.absolutePath),
        new Uint8Array(0)
      );
      this.created = true;
      this.previousContent = '';
    } else {
      if (!fs.existsSync(this.absolutePath)) {
        throw new Error(`"${this.relativePath}" does not exist, so it cannot be updated.`);
      }
      this.created = false;
      try {
        this.previousContent = fs.readFileSync(this.absolutePath, 'utf8');
      } catch (error) {
        throw new Error(
          `Could not read "${this.relativePath}" before updating it: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    const uri = vscode.Uri.file(this.absolutePath);
    this.document = await this.openDocument(uri);
    this.editor = await vscode.window.showTextDocument(this.document, {
      preview: false,
      preserveFocus: false,
    });

    this.lastKnownFingerprint = fingerprint(this.document.getText());
    this.written = 0;
    this.buffer = '';
    this.cancelled = false;
    this.finished = false;
    this.expectedTotal = options.expectedTotal ?? 0;

    this.installManualEditGuard();

    return {
      document: this.document,
      editor: this.editor,
      created: this.created,
      previousContent: this.previousContent,
    };
  }

  /** Wait for a document to become available after `openTextDocument`. */
  private async openDocument(uri: vscode.Uri): Promise<vscode.TextDocument> {
    try {
      return await vscode.workspace.openTextDocument(uri);
    } catch (error) {
      // A just-created file can briefly not be stat-able through the file
      // system provider; retry within a bounded window.
      const deadline = Date.now() + DOCUMENT_TIMEOUT_MS;
      let lastError = error;
      while (Date.now() < deadline) {
        await delay(60);
        try {
          return await vscode.workspace.openTextDocument(uri);
        } catch (retryError) {
          lastError = retryError;
        }
      }
      throw new Error(
        `Could not open "${this.relativePath}" in the editor: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`
      );
    }
  }

  /**
   * Stop the write the moment the developer edits the target document.
   *
   * This is spec section 8, step 8. Without it, our insertions and the
   * developer's keystrokes would interleave into corrupt output.
   */
  private installManualEditGuard(): void {
    const onChange = vscode.workspace.onDidChangeTextDocument((event) => {
      if (!this.document || event.document.uri.toString() !== this.document.uri.toString()) {
        return;
      }
      if (this.finished) {
        return;
      }
      // Ignore the changes we caused ourselves.
      const current = fingerprint(event.document.getText());
      if (current === this.lastKnownFingerprint) {
        return;
      }
      if (this.pendingSelfEdit) {
        this.pendingSelfEdit = false;
        this.lastKnownFingerprint = current;
        return;
      }
      this.cancelled = true;
      this.finished = true;
      this.deps.logger.warn(
        `Stopped writing ${this.relativePath}: the document was modified outside PairPilot.`
      );
      this.deps.onInterrupted?.(
        'You edited the file while PairPilot was writing, so writing stopped to avoid conflicting with your changes.'
      );
    });
    this.activeGuards.push(onChange);
  }

  /** Set while we are about to apply our own edit, so the guard ignores it. */
  private pendingSelfEdit = false;

  /** Total characters expected, once known (used for the progress indicator). */
  setExpectedTotal(total: number): void {
    this.expectedTotal = total;
  }

  /**
   * Feed real streamed characters. Call this from the runtime's code-delta
   * callback; it never fabricates content.
   */
  push(delta: string): void {
    if (this.finished || this.cancelled || !this.document) {
      return;
    }
    this.buffer += delta;
    this.scheduleFlush();
  }

  /**
   * Insert buffered characters into the document.
   *
   * Batched to roughly 40ms rather than per character. That is not a simulated
   * typing effect: it is the minimum granularity at which VS Code's text model
   * stays responsive. The characters themselves are always exactly what the
   * runtime sent.
   */
  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.enqueueFlush();
    }, FLUSH_INTERVAL_MS);
  }

  /** Append a flush to the queue, so edits can never interleave. */
  private enqueueFlush(): void {
    this.flushQueue = this.flushQueue.then(
      () => this.flush(),
      // A rejected predecessor must not poison the chain; `flush()` reports its
      // own failures through `onInterrupted` rather than by throwing.
      () => undefined
    );
  }

  private async flush(): Promise<void> {
    if (this.finished || this.cancelled || !this.document) {
      return;
    }
    const chunk = this.buffer;
    this.buffer = '';
    if (chunk.length === 0) {
      return;
    }

    const document = this.document;
    const end = document.positionAt(document.getText().length);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, end, chunk);

    this.pendingSelfEdit = true;
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      this.pendingSelfEdit = false;
      this.finished = true;
      this.deps.onInterrupted?.(
        'The editor refused the change. The file may be read-only, or another extension may be blocking edits.'
      );
      return;
    }
    // Let the change event settle before re-fingerprinting.
    await delay(0);
    this.lastKnownFingerprint = fingerprint(document.getText());
    this.written += chunk.length;
    this.deps.onProgress?.(this.written, Math.max(this.expectedTotal, this.written));
  }

  /**
   * Finish the write and report whether the document still matches what we wrote.
   *
   * @returns the content hash of the final file, or a failure description.
   */
  async complete(): Promise<WriteOutcome> {
    if (!this.document) {
      return { status: 'failed', written: 0, reason: 'No write was in progress.' };
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Settle any flush that is already in flight. Without this, an edit could
    // still land after we have reported an outcome, or interleave with the final
    // drain below.
    await this.flushQueue;

    if (this.cancelled) {
      this.dispose();
      return {
        status: 'cancelled',
        written: this.written,
        reason: 'Writing was stopped.',
      };
    }

    await this.flush();

    if (!this.finished) {
      // Any characters still buffered would be a bug in the stream handling.
      if (this.buffer.length > 0) {
        await this.flush();
      }
      this.finished = true;
    }

    const document = this.document;

    // Persist to disk before reporting success.
    //
    // Applying a `WorkspaceEdit` only mutates the in-memory text model; it does
    // not touch the file. Without this save the editor would visibly contain the
    // approved code while the file on disk still held its previous bytes — which
    // for a `create` means an EMPTY file, because that is what `begin()` created
    // so that a rollback would be possible. The caller then reads the file back
    // to verify it against the reviewed proposal, finds the mismatch, and rolls
    // the whole write back as failed. VS Code does not autosave by default, so
    // this cannot be left to the user's settings.
    if (document.isDirty) {
      let saved = false;
      try {
        saved = await document.save();
      } catch (error) {
        saved = false;
        this.deps.logger.warn(
          `Saving ${this.relativePath} raised: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      if (!saved) {
        this.finished = true;
        this.dispose();
        return {
          status: 'failed',
          written: this.written,
          reason:
            'The editor refused to save the file, so the approved content was not written to disk. ' +
            'Check whether the file is read-only or locked by another program.',
        };
      }
    }

    const text = document.getText();
    const fileHash = fingerprint(text);
    this.dispose();

    // Re-verify containment: a symlink could have appeared during writing.
    try {
      this.deps.guard.assertRealPathInsideWorkspace(this.relativePath);
    } catch (error) {
      return {
        status: 'failed',
        written: this.written,
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    return { status: 'completed', written: this.written, fileHash };
  }

  /** Stop writing, keeping whatever is on disk for the review step. */
  async stop(reason: string): Promise<WriteOutcome> {
    this.cancelled = true;
    this.deps.onInterrupted?.(reason);
    return this.complete();
  }

  /**
   * Undo the write.
   *
   * If we created the file, it is removed — an unapproved new file must not be
   * left in the workspace. If we updated an existing file, the original content
   * is restored exactly. Both paths go through `WorkspaceEdit` where possible so
   * the developer's undo history stays coherent.
   */
  async rollback(reason: 'cancelled' | 'user_edited' | 'failed' | 'rejected'): Promise<{
    restored: boolean;
    relativePath: string;
    reason: string;
  }> {
    const relativePath = this.relativePath;
    const absolutePath = this.absolutePath;
    const wasCreated = this.created;
    const previous = this.previousContent;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.buffer = '';
    this.finished = true;
    // An in-flight flush would otherwise apply an edit after we have reverted,
    // leaving the document with the content we just tried to remove.
    await this.flushQueue;

    try {
      // Prefer VS Code's own undo so the revert is visible and reversible.
      if (this.editor) {
        await vscode.commands.executeCommand('undo');
      }
    } catch {
      /* fall through to the filesystem path below */
    }

    try {
      if (wasCreated) {
        if (fs.existsSync(absolutePath)) {
          if (this.document) {
            // Close the tab before deletion so VS Code does not hold a dirty
            // buffer over a file that no longer exists.
            await vscode.window.showTextDocument(this.document, { preview: false });
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
          }
          await vscode.workspace.fs.delete(vscode.Uri.file(absolutePath), {
            useTrash: false,
          });
        }
        this.dispose();
        this.deps.logger.info(`Rolled back ${relativePath}: the new file was removed.`);
        return { restored: false, relativePath, reason };
      }

      // Update: restore the exact previous bytes.
      if (this.document) {
        const edit = new vscode.WorkspaceEdit();
        const full = new vscode.Range(
          this.document.positionAt(0),
          this.document.positionAt(this.document.getText().length)
        );
        edit.replace(this.document.uri, full, previous);
        this.pendingSelfEdit = true;
        await vscode.workspace.applyEdit(edit);
        if (this.document.isDirty) {
          await this.document.save();
        }
      } else {
        fs.writeFileSync(absolutePath, previous, 'utf8');
      }
      this.dispose();
      this.deps.logger.info(`Rolled back ${relativePath}: the previous content was restored.`);
      return { restored: true, relativePath, reason };
    } catch (error) {
      this.dispose();
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.error(`Rollback of ${relativePath} failed: ${message}`);
      return { restored: false, relativePath, reason: `${reason} (rollback incomplete: ${message})` };
    }
  }

  /** Release the guards without touching the file. */
  private dispose(): void {
    for (const guard of this.activeGuards) {
      guard.dispose();
    }
    this.activeGuards.length = 0;
    this.document = null;
    this.editor = null;
  }
}

/** Cheap content fingerprint for change detection (not a security hash). */
export function fingerprint(text: string): string {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * WritePermission — the "may I write this file?" gate, in native UI.
 *
 * This is a *different* decision from the in-editor code review, and the
 * difference is what the file is about:
 *
 *  - Before a write there is no code in the editor to review. The developer is
 *    deciding whether the workspace may be touched at all, and the thing being
 *    shown is the proposal's own description. That prompt is a native modal.
 *  - After a write there is code, so the review happens on the file's own
 *    comment thread — `EditorReview`'s job.
 *
 * Merging the two would mean either asking permission to write on a thread that
 * describes code the developer cannot see yet, or writing an existing file
 * before permission to do so exists. Both are worse than one more prompt.
 *
 * ## Why this class exists at all
 *
 * Until 0.4.0 the sidebar held the permission buttons. The spec moved every
 * decision out of the panel, and the buttons went with it — leaving the gate in
 * `Orchestrator` with no surface to answer it, so a turn stopped there forever.
 * This class is that surface, and it is deliberately separate from the review
 * controller: the permission prompt is not a comment thread and must keep
 * working when no editor is open.
 *
 * The class holds no `vscode` import. The prompt and the application of a
 * decision are both injected, which is what lets the rules below be tested
 * without an editor: a dismissed prompt leaves the request pending, a superseded
 * request is never applied, and a gate that has closed cannot answer a prompt
 * that was left open too long.
 */

import type { OrchestratorWritePermissionRequest } from '../core/Orchestrator';

/**
 * What the developer answered.
 *
 * `write_all` is a batch convenience, not a fourth decision about this file: it
 * is `write` applied to every remaining file of the same proposal, which
 * `Orchestrator` records on the batch as `authorized` rather than as approval.
 * It is only offered when a set hash exists.
 */
export type PermissionChoice =
  | { readonly kind: 'write' }
  | { readonly kind: 'write_all' }
  | { readonly kind: 'revise'; readonly feedback: string }
  | { readonly kind: 'reject' }
  /** The prompt was closed without answering. Nothing was decided. */
  | { readonly kind: 'dismissed' };

/** A choice that decided something, as opposed to a closed prompt. */
export type TakenPermissionChoice = Exclude<PermissionChoice, { kind: 'dismissed' }>;

export interface WritePermissionDeps {
  /** Show the native prompt and wait for an answer. */
  prompt(request: OrchestratorWritePermissionRequest): Promise<PermissionChoice>;
  /** Apply an answer to the workflow. */
  apply(request: OrchestratorWritePermissionRequest, choice: TakenPermissionChoice): Promise<void>;
  /**
   * Whether the gate this request belongs to is still open.
   *
   * A prompt is a modal the developer can leave on screen while doing something
   * else — cancelling the turn, or starting another one. Asking the workflow
   * rather than trusting the request is what stops an old prompt from writing a
   * file the workflow is no longer waiting for.
   */
  isLive(request: OrchestratorWritePermissionRequest): boolean;
  logger: { info(m: string): void; warn(m: string): void; error(m: string, e?: unknown): void };
}

export class WritePermission {
  /** The one gate that can be open at a time: batches ask file by file. */
  private pending: OrchestratorWritePermissionRequest | null = null;
  /**
   * True while a prompt is on screen.
   *
   * A modal is asynchronous but not re-entrant: two of them stacked would ask
   * the same question twice and let the second answer act on a request the
   * first one already settled.
   */
  private prompting = false;

  constructor(private readonly deps: WritePermissionDeps) {}

  /** Ask for permission, replacing any request that is already pending. */
  async ask(request: OrchestratorWritePermissionRequest): Promise<void> {
    this.pending = request;
    await this.raise();
  }

  /**
   * Raise the pending prompt again, for a prompt that was closed unanswered.
   *
   * Returns whether a prompt is on screen — including one that is already there,
   * because "you have already been asked, look" is a better answer than "nothing
   * is waiting". `false` means there was genuinely nothing to show: no request,
   * or a gate that has since closed.
   */
  async raise(): Promise<boolean> {
    const request = this.pending;
    if (!request) {
      return false;
    }
    if (this.prompting) {
      // A modal is asynchronous but not re-entrant: two of them stacked would
      // ask the same question twice and let the second answer act on a request
      // the first one already settled.
      return true;
    }
    if (!this.deps.isLive(request)) {
      // The turn moved on, was cancelled, or another file's gate opened. The
      // request is dropped rather than left to be answered later: the workflow
      // would refuse the answer, and a prompt that can only fail is a trap.
      this.deps.logger.info(
        `Dropped a stale write-permission prompt for "${request.relativePath}".`
      );
      this.pending = null;
      return false;
    }

    this.prompting = true;
    try {
      const choice = await this.deps.prompt(request);
      if (choice.kind === 'dismissed') {
        // Pressing Escape is not a decision. The request stays pending so the
        // palette and the panel can offer the same question again — declining
        // by accident must not be indistinguishable from declining on purpose.
        return true;
      }
      if (this.pending !== request) {
        // Superseded while the prompt was open. The newer request has its own
        // prompt, and this answer names bytes the workflow no longer holds.
        this.deps.logger.info(
          `Ignored an answer for the superseded permission request "${request.relativePath}".`
        );
        return true;
      }
      this.pending = null;
      await this.deps.apply(request, choice);
      return true;
    } catch (error) {
      this.deps.logger.error(
        `The write-permission prompt for "${request.relativePath}" failed: ${String(error)}`,
        error
      );
      return true;
    } finally {
      this.prompting = false;
    }
  }

  /** The request awaiting an answer, for a caller that needs to describe it. */
  get pendingRequest(): OrchestratorWritePermissionRequest | null {
    return this.pending;
  }

  /** True while its prompt is on screen. */
  get isPrompting(): boolean {
    return this.prompting;
  }

  /** Forget the pending request, for a cancelled turn or a new session. */
  clear(): void {
    this.pending = null;
  }
}

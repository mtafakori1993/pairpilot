/**
 * EditorReview — the in-editor review surface for a written file.
 *
 * This is where the spec's central requirement lives: **code review happens in
 * the editor that holds the code**. Not in the sidebar, not in a separate review
 * panel, not in a preview. Three native surfaces, each doing one job:
 *
 *  - a **comment thread** anchored to the top of the written file, holding the
 *    explanation the proposal gave and the three decision buttons. It is a real
 *    comment, so it scrolls with the code, survives tab switching, and sits on
 *    the file it is about;
 *  - a **modal**, anchored to that same editor, for the decision itself — because
 *    a thread button is a single click and the decision deserves a press that
 *    says which file it applies to;
 *  - a **decoration** on the written range while the review is open, so a file
 *    that is being reviewed is visibly distinguishable from one that is not.
 *
 * Everything here is keyed by document URI and held in `ReviewSessions`, so two
 * open files never share a decision. The controller renders; it never decides
 * whether a decision is *allowed* — that is `ReviewSession.submit`, which is
 * pure and unit-tested.
 */

import * as vscode from 'vscode';
import {
  REFUSAL_MESSAGES,
  ReviewSession,
  reviewQuestion,
  type ReviewDecision,
  type ReviewSubmitResult,
} from './ReviewSession';
import { ReviewSessions, type ReviewCloseReason } from './ReviewSessions';

/** What the controller asks its host to do with a decision. */
export interface EditorReviewActions {
  /**
   * Apply a decision to the workflow.
   *
   * Called only after `ReviewSession.submit` has accepted it, so the workflow
   * never has to re-check the hash or the fingerprint — and can trust that a
   * decision reaching it is one that was permitted.
   */
  decide(session: ReviewSession, outcome: ReviewSubmitResult & { ok: true }): void | Promise<void>;
  logger: { info(m: string): void; warn(m: string): void; error(m: string, e?: unknown): void };
}

/**
 * What the workflow asks the editor to review.
 *
 * Deliberately the same shape the Orchestrator publishes, restated here so the
 * editor layer does not import from the workflow. The fingerprint is absent: it
 * is captured from the document by this class, because only it has the document.
 */
export interface EditorReviewRequest {
  readonly sessionId: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly operation: 'create' | 'update';
  readonly description: string;
  readonly rationale: string | null;
  readonly contentHash: string;
  readonly binding: {
    readonly proposalId?: string;
    readonly proposalVersion?: number;
    readonly fileId?: string;
  };
  readonly documentLine: number;
  readonly position: { readonly index: number; readonly total: number } | null;
}

/** A comment thread plus the pieces needed to dispose it. */
interface OpenThread {
  thread: vscode.CommentThread;
  decoration: vscode.TextEditorDecorationType;
}

export class EditorReview implements vscode.Disposable {
  private readonly sessions = new ReviewSessions();
  private readonly threads = new Map<string, OpenThread>();
  private readonly controller: vscode.CommentController;
  private readonly closeListener: { dispose(): void };
  private disposed = false;

  constructor(private readonly actions: EditorReviewActions) {
    this.controller = vscode.comments.createCommentController('pairpilot.review', 'PairPilot Review');
    // The thread accepts a typed reply as free-form feedback. It is not a fourth
    // decision: a reply becomes "request changes" only when the developer also
    // presses the button, which is what keeps a stray comment from rewriting a
    // file.
    this.controller.options = { prompt: 'Add feedback for this file (optional)' };

    this.closeListener = this.sessions.onDidClose((event) => {
      this.disposeThread(event.documentUri);
      if (event.reason === 'stale' || event.reason === 'cancelled') {
        this.disposeModalFor(event.sessionId);
      }
    });
  }

  /** All live sessions, for a caller that needs to inspect them. */
  get reviewSessions(): ReviewSessions {
    return this.sessions;
  }

  /**
   * Open a review for one file, anchored to the real document.
   *
   * The document is opened and revealed *first*: a comment thread created for a
   * document nobody is looking at is created but invisible, which looks like
   * failure. Revealing first also gives the decoration a real editor to attach
   * to.
   */
  async openReview(request: EditorReviewRequest): Promise<void> {
    if (this.disposed) {
      return;
    }

    // Opened first so the fingerprint describes the bytes that are actually on
    // screen, not a re-read that could race a save.
    const uri = vscode.Uri.file(request.absolutePath);
    let editor: vscode.TextEditor;
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      editor = await vscode.window.showTextDocument(document, {
        preview: false,
        // Focus, unlike the write: the developer's next act is to read this
        // file and decide, so stealing focus is now correct rather than rude.
        preserveFocus: false,
      });
    } catch (error) {
      this.actions.logger.warn(
        `Could not open "${request.relativePath}" to review it: ${String(error)}`
      );
      return;
    }

    const session = new ReviewSession({
      sessionId: request.sessionId,
      documentUri: uri.toString(),
      relativePath: request.relativePath,
      operation: request.operation,
      description: request.description,
      rationale: request.rationale,
      contentHash: request.contentHash,
      binding: request.binding,
      documentFingerprint: this.fingerprint(editor.document),
      documentLine: request.documentLine,
      position: request.position,
    });

    const { replaced } = this.sessions.open(session.init);
    if (replaced) {
      // `ReviewSessions` has already emitted the close event; the loop inside
      // `disposeThread` is not idempotent, so this is belt and braces only.
      this.disposeThread(replaced.documentUri);
    }

    const anchor = this.anchorRange(editor.document, session.init.documentLine);
    const thread = this.controller.createCommentThread(uri, anchor, [
      this.reviewComment(session),
    ]);
    thread.canReply = true;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    // The context value is what the menu contributions select on. It carries the
    // session id so a button press names the exact review it belongs to, even
    // when two threads are on screen.
    thread.contextValue = `pairpilot.review:${session.sessionId}`;

    const decoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.infoForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Full,
      light: { backgroundColor: 'rgba(100, 160, 255, 0.08)' },
      dark: { backgroundColor: 'rgba(100, 160, 255, 0.08)' },
    });
    editor.setDecorations(decoration, [anchor]);

    this.threads.set(session.documentUri, { thread, decoration });
  }

  /**
   * Take a decision from a thread button or the modal.
   *
   * This is the only path a decision may travel, and it does three things in
   * order: refuse an unknown or closed session, ask the session itself whether
   * the decision is permitted, and only then apply it. A refusal is reported
   * with the session's own reason rather than a generic failure.
   */
  async decide(sessionId: string, decision: string, feedback: string): Promise<void> {
    const session = this.sessions.findById(sessionId);
    if (!session) {
      void vscode.window.showWarningMessage(
        'PairPilot: that review is no longer open. Nothing was changed.'
      );
      return;
    }

    const document = this.findDocument(session.documentUri);
    const currentFingerprint = document ? this.fingerprint(document) : session.init.documentFingerprint;

    const result = session.submit(decision, { feedback, currentFingerprint });
    if (!result.ok) {
      void vscode.window.showWarningMessage(`PairPilot: ${REFUSAL_MESSAGES[result.reason]}`);
      if (result.reason === 'document_changed') {
        // The session cannot approve bytes that have drifted, so it is retired
        // rather than left on screen inviting the same refusal again.
        this.sessions.invalidate(session.documentUri);
      }
      return;
    }

    this.sessions.close(session.documentUri, 'decided');
    try {
      await this.actions.decide(session, result);
    } catch (error) {
      this.actions.logger.error(`Applying a review decision failed: ${String(error)}`, error);
      void vscode.window.showErrorMessage(
        `PairPilot: the decision was recorded but could not be applied. ${String(error)}`
      );
    }
  }

  /** The review open for a document, if any. */
  find(documentUri: string): ReviewSession | null {
    return this.sessions.find(documentUri);
  }

  /** The review with this id, if any — for a command that holds only the id. */
  findById(sessionId: string): ReviewSession | null {
    return this.sessions.findById(sessionId);
  }

  /** Reviews still awaiting a decision, for the "Review …" command. */
  awaiting(): ReviewSession[] {
    return this.sessions.awaiting();
  }

  /** Close every review, for cancel and shutdown. */
  closeAll(reason: ReviewCloseReason): void {
    this.sessions.closeAll(reason);
    for (const uri of [...this.threads.keys()]) {
      this.disposeThread(uri);
    }
  }

  /**
   * Offer the decision as a native prompt, for callers that are not a click.
   *
   * Used by the `pairpilot.reviewFile` command and by the thread's "Review…"
   * menu item. Three buttons, and Cancel is a real fourth outcome — pressing
   * Escape must not approve anything.
   */
  async askDecision(session: ReviewSession): Promise<void> {
    const APPROVE = 'Approve';
    const REJECT = 'Reject';
    const CHANGES = 'Request changes…';

    const choice = await vscode.window.showInformationMessage(
      `PairPilot: ${reviewQuestion(session)}`,
      { modal: true, detail: session.init.rationale ?? session.init.description },
      APPROVE,
      CHANGES,
      REJECT
    );

    if (choice === APPROVE) {
      await this.decide(session.sessionId, 'approve', '');
      return;
    }
    if (choice === REJECT) {
      await this.decide(session.sessionId, 'reject', '');
      return;
    }
    if (choice !== CHANGES) {
      return;
    }

    const feedback = await vscode.window.showInputBox({
      title: `PairPilot: Changes for ${session.relativePath}`,
      prompt: 'What should the code do instead?',
      placeHolder: 'e.g. use a prepared statement instead of string concatenation',
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.trim().length === 0 ? 'Describe the change you want before requesting it.' : undefined,
    });
    if (feedback === undefined) {
      return;
    }
    await this.decide(session.sessionId, 'request_changes', feedback);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.sessions.closeAll('disposed');
    for (const uri of [...this.threads.keys()]) {
      this.disposeThread(uri);
    }
    this.closeListener.dispose();
    this.controller.dispose();
  }

  /* ---------------------------------------------------------------------- */
  /* Rendering                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * The comment body: what the file is, what it does, and what a decision does.
   *
   * Written as markdown so the file name and the action can be emphasised, and
   * marked untrusted so nothing in a proposal's own explanation can become a
   * command link.
   */
  private reviewComment(session: ReviewSession): vscode.Comment {
    const view = session.view();
    const body = new vscode.MarkdownString();
    body.isTrusted = false;
    body.supportHtml = false;

    body.appendMarkdown(
      `**${view.operation === 'create' ? 'New file' : 'Rewritten file'}: \`${view.relativePath}\`**`
    );
    if (view.position && view.position.total > 1) {
      body.appendMarkdown(` — file ${view.position.index} of ${view.position.total}`);
    }
    body.appendMarkdown('\n\n');
    body.appendText(view.description);

    if (view.rationale !== null && view.rationale.trim().length > 0) {
      body.appendMarkdown('\n\n');
      body.appendMarkdown('_Why:_ ');
      body.appendText(view.rationale.trim());
    }

    body.appendMarkdown(
      '\n\n**Approve** keeps it. **Request changes** describes a correction and PairPilot rewrites this file. ' +
        '**Reject** takes the unapproved code back off disk.'
    );

    return {
      body,
      mode: vscode.CommentMode.Preview,
      author: { name: 'PairPilot' },
    };
  }

  /** The anchored range: the top of the written region, never an empty file. */
  private anchorRange(document: vscode.TextDocument, line: number): vscode.Range {
    const last = Math.max(document.lineCount - 1, 0);
    const target = Math.min(Math.max(line, 0), last);
    return document.lineAt(target).range;
  }

  /** Find the live document for a review, without opening a second copy. */
  private findDocument(documentUri: string): vscode.TextDocument | null {
    const match = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === documentUri
    );
    return match ?? null;
  }

  /**
   * A fingerprint of the document as it stands.
   *
   * The same shape as `LiveWriter.fingerprint`: a cheap content identity, not a
   * security primitive. It is compared to the one captured at open, so what it
   * must do is change when any byte changes — which a hash of the text does.
   */
  private fingerprint(document: vscode.TextDocument): string {
    const text = document.getText();
    // cyrb53, inlined: no dependency, and the review fingerprint never leaves
    // this process.
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      h1 = Math.imul(h1 ^ code, 2654435761);
      h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return `${(h2 >>> 0).toString(16)}${(h1 >>> 0).toString(16)}:${text.length}`;
  }

  /* ---------------------------------------------------------------------- */
  /* Teardown                                                               */
  /* ---------------------------------------------------------------------- */

  private disposeThread(documentUri: string): void {
    const open = this.threads.get(documentUri);
    if (!open) {
      return;
    }
    this.threads.delete(documentUri);
    try {
      open.thread.dispose();
    } catch {
      // A thread whose document was closed is already gone; there is nothing to
      // report and nothing to retry.
    }
    open.decoration.dispose();
  }

  /** Modals are opened with `showInformationMessage`, so nothing to dispose. */
  private disposeModalFor(_sessionId: string): void {
    // Kept as an explicit no-op seam: the modal is a native prompt that the
    // developer dismisses, and VS Code closes it when its session ends. This is
    // where a future custom modal would be torn down.
  }
}

/** Re-exported so callers do not import from two modules for one action. */
export type { ReviewDecision };

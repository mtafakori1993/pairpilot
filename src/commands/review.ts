/**
 * Review commands — the buttons on an in-editor review thread, and the actions
 * offered from the palette.
 *
 * These are deliberately not on the sidebar. A review decision belongs to the
 * file it is about, and the Command Palette entry exists for keyboard-first use
 * and for a review whose thread has scrolled out of view — it finds the review
 * and asks the same question, in the same editor.
 *
 * The `comments/commentThread/context` handlers receive an argument from the
 * menu system, and a menu argument is untrusted input in exactly the way a
 * Webview message is: any extension can fire a command. So every one of them
 * begins by resolving the *session*, never by trusting an id to name something
 * live, and the decision is then re-checked by `ReviewSession.submit` before it
 * can reach the workflow.
 */

import * as vscode from 'vscode';
import { describeError } from '../core/errors';
import type { EditorReview } from '../review/EditorReview';
import type { ReviewSession } from '../review/ReviewSession';
import type { WritePermission } from '../review/WritePermission';

export interface ReviewCommandDeps {
  review: EditorReview;
  /**
   * The pre-write permission prompt, when there is one.
   *
   * Optional so the review commands stay registrable on their own — a caller
   * that has no workflow to ask about a write has nothing to re-raise.
   */
  permission?: Pick<WritePermission, 'raise'>;
  logger: { info(m: string): void; warn(m: string): void; error(m: string, e?: unknown): void };
}

export function registerReviewCommands(
  context: vscode.ExtensionContext,
  deps: ReviewCommandDeps
): void {
  const register = (id: string, handler: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await handler(...args);
        } catch (error) {
          deps.logger.error(`Command "${id}" failed: ${describeError(error)}`, error);
          void vscode.window.showErrorMessage(`PairPilot: ${describeError(error)}`);
        }
      })
    );
  };

  /**
   * The session a thread command is about.
   *
   * Two sources, in order: the comment that was clicked (which carries the
   * thread's own context value), and — when the command came from the palette —
   * the review for whatever file is in the active editor. Nothing is guessed: if
   * neither names a live review, the command says so and does nothing.
   */
  const sessionFor = (arg: unknown): ReviewSession | null => {
    const sessionId = sessionIdFromArg(arg);
    if (sessionId !== null) {
      // Always resolved from the live registry: a forged or stale id finds
      // nothing, which is the only safe reading of a menu argument.
      return deps.review.findById(sessionId);
    }
    const active = vscode.window.activeTextEditor;
    if (!active) {
      return null;
    }
    return deps.review.find(active.document.uri.toString());
  };

  const decideWith = async (
    arg: unknown,
    decision: 'approve' | 'reject',
    verb: string
  ): Promise<void> => {
    const session = sessionFor(arg);
    if (!session) {
      void vscode.window.showInformationMessage(
        'PairPilot: there is no review open for this file.'
      );
      return;
    }
    // Confirmed, because a thread button is one click and this decision either
    // keeps the file or takes it off disk.
    const CONFIRM = decision === 'approve' ? 'Approve' : 'Reject';
    const answer = await vscode.window.showWarningMessage(
      `PairPilot: ${verb} \`${session.relativePath}\`?`,
      { modal: true, detail: session.init.description },
      CONFIRM
    );
    if (answer !== CONFIRM) {
      return;
    }
    await deps.review.decide(session.sessionId, decision, '');
  };

  register('pairpilot.approveReview', async (arg: unknown) => {
    await decideWith(arg, 'approve', 'Approve this file as written');
  });

  register('pairpilot.rejectReview', async (arg: unknown) => {
    await decideWith(arg, 'reject', 'Reject this file and remove the unapproved code');
  });

  register('pairpilot.requestChangesReview', async (arg: unknown) => {
    const session = sessionFor(arg);
    if (!session) {
      void vscode.window.showInformationMessage(
        'PairPilot: there is no review open for this file.'
      );
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
    await deps.review.decide(session.sessionId, 'request_changes', feedback);
  });

  /** The thread's title action: show the full review prompt for its file. */
  register('pairpilot.openReviewThread', async (arg: unknown) => {
    const session = sessionFor(arg);
    if (!session) {
      return;
    }
    await revealThread(session);
    await deps.review.askDecision(session);
  });

  /**
   * Ask for a decision on whatever review is waiting.
   *
   * With one review open it goes straight to it; with several, the palette asks
   * which file — an arbitrary pick would be the extension deciding which file to
   * approve, which is exactly what the review exists to prevent.
   */
  register('pairpilot.reviewWaitingFile', async () => {
    const waiting = deps.review.awaiting();
    if (waiting.length === 0) {
      // Before a write there is no review to find — the decision waiting is the
      // permission to write at all, and it is raised rather than reported. This
      // is the case that used to say "no file is waiting" while the workflow sat
      // at the gate, which left the turn stuck with no way to answer it.
      if (deps.permission && (await deps.permission.raise())) {
        return;
      }
      void vscode.window.showInformationMessage(
        'PairPilot: nothing is waiting for a decision right now. A written file opens its review in the editor.'
      );
      return;
    }
    if (waiting.length === 1) {
      const only = waiting[0]!;
      await revealThread(only);
      await deps.review.askDecision(only);
      return;
    }

    const picked = await vscode.window.showQuickPick(
      waiting.map((session) => ({
        label: session.relativePath,
        description:
          session.init.position === null
            ? session.init.description
            : `file ${session.init.position.index} of ${session.init.position.total}`,
        session,
      })),
      { title: 'PairPilot: Review a written file', placeHolder: 'Which file do you want to review?' }
    );
    if (!picked) {
      return;
    }
    await revealThread(picked.session);
    await deps.review.askDecision(picked.session);
  });

  /** Bring a review's file and thread into view without deciding anything. */
  async function revealThread(session: ReviewSession): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.parse(session.documentUri)
      );
      await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    } catch (error) {
      deps.logger.warn(`Could not reveal "${session.relativePath}": ${describeError(error)}`);
    }
  }
}

/**
 * Extract a session id from a comment-thread menu argument.
 *
 * The menu passes the `CommentReply`/`Comment` the click landed on. Its thread's
 * `contextValue` is the only field this reads, and it is used purely as a
 * *lookup key*: the caller resolves it against the live registry, so a forged
 * value can only ever fail to find anything.
 */
export function sessionIdFromArg(arg: unknown): string | null {
  if (typeof arg !== 'object' || arg === null) {
    return null;
  }
  const candidate = arg as {
    thread?: { contextValue?: unknown };
    parent?: { thread?: { contextValue?: unknown } };
  };
  const contextValue = candidate.thread?.contextValue ?? candidate.parent?.thread?.contextValue;
  if (typeof contextValue !== 'string') {
    return null;
  }
  const PREFIX = 'pairpilot.review:';
  return contextValue.startsWith(PREFIX) ? contextValue.slice(PREFIX.length) : null;
}

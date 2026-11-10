/**
 * WebviewMessageRouter — the only door into the Extension Host from the panel.
 *
 * Two-stage defence, and the order matters:
 *
 *   1. `MessageValidator` checks the *shape* of the message and drops anything
 *      malformed, oversized, or containing prototype-pollution keys.
 *   2. This router checks the *legality* of the action against the state machine
 *      before invoking the Orchestrator.
 *
 * Stage 2 is the one that matters for spec section 11 ("never let Webview
 * messages directly bypass approval rules"). Approval messages are not part of
 * `WebviewRequest` at all any more — a decision comes from the editor, through
 * the review commands — so there is no approval for this router to legalise or
 * to be tricked into legalising. What is left is discussion, navigation and
 * cancellation, all of which are re-checked against the state machine.
 */

import * as vscode from 'vscode';
import { MessageValidator } from '../security/MessageValidator';
import { describeError } from '../core/errors';
import type { Orchestrator } from '../core/Orchestrator';
import { PairPilotState, type WebviewRequest } from '../types';


export interface RouterDeps {
  orchestrator: Orchestrator;
  validator: MessageValidator;
  logger: { info(m: string): void; warn(m: string): void; error(m: string, e?: unknown): void };
  /** Called when the panel says it is ready; the provider replies with state. */
  onReady(): void;
  /** Session ids currently known, for `loadSession`/`deleteSession` validation. */
  knownSessionIds(): ReadonlySet<string>;
  deleteSession(sessionId: string): void;
  openFile(relativePath: string): Promise<void>;
  addActiveEditorContext(): Promise<void>;
  revealOutput(): void;
  newSession(): void;
  /**
   * Focus the editor review that is waiting, if there is one.
   *
   * The panel can only ask for this; what happens is the editor's business.
   */
  revealReview(): Promise<void>;
}

export class WebviewMessageRouter {
  constructor(private readonly deps: RouterDeps) {}

  /** Handle one raw message from the Webview. Never throws. */
  async handle(raw: unknown): Promise<void> {
    const result = this.deps.validator.tryValidate(raw, {
      knownSessionIds: this.deps.knownSessionIds(),
    });
    if (!result.ok) {
      // A rejected message is a security event, not a user error, so it is
      // logged loudly even though the UI is told nothing.
      this.deps.logger.warn(`Rejected a Webview message: ${result.error}`);
      return;
    }
    const message = result.value;

    try {
      await this.dispatch(message);
    } catch (error) {
      // A thrown error from a legal action is surfaced to the developer; it is
      // not swallowed, because a silent failure in an approval flow is unsafe.
      this.deps.logger.error(`Webview action "${message.type}" failed: ${describeError(error)}`);
      void vscode.window.showErrorMessage(`PairPilot: ${describeError(error)}`);
    }
  }

  /**
   * Refuse an action that is not legal in the current state.
   *
   * The message names the state it needs, so the developer is told what to do
   * rather than being silently ignored.
   */
  private requireState(
    current: PairPilotState,
    ...args: [...PairPilotState[], string]
  ): void {
    const description = args[args.length - 1] as string;
    const allowed = args.slice(0, -1) as PairPilotState[];
    if (!allowed.includes(current)) {
      this.deps.logger.warn(
        `Refused "${description}" while in ${current}; expected one of ${allowed.join(', ')}.`
      );
      void vscode.window.showWarningMessage(
        `PairPilot cannot ${description} right now (current state: ${current}).`
      );
    }
  }

  private async dispatch(message: WebviewRequest): Promise<void> {
    const orchestrator = this.deps.orchestrator;

    switch (message.type) {
      case 'ready':
        this.deps.onReady();
        return;

      case 'submitTask':
        await orchestrator.submitTask(message.text);
        return;

      case 'cancel':
        await orchestrator.cancel();
        return;

      case 'pauseWrite':
        // Served only while a file is actually going into the editor. Anywhere
        // else there is no stream to hold.
        this.requireState(
          orchestrator.machine.state,
          PairPilotState.CREATING_FILE,
          PairPilotState.WRITING_CODE,
          'pause the write'
        );
        orchestrator.pauseWrite();
        return;

      case 'resumeWrite':
        orchestrator.resumeWrite();
        return;

      case 'requestChangesDuringWrite':
        // Refused once the file is on disk: at that point the review's own
        // "Request changes" is the honest one, and it works on a file the
        // developer can read in full.
        this.requireState(
          orchestrator.machine.state,
          PairPilotState.CREATING_FILE,
          PairPilotState.WRITING_CODE,
          'request changes to the file being written'
        );
        await orchestrator.requestChangesWhileWriting(message.feedback);
        return;

      case 'openReviewInEditor':
        // Brings the editor's own review to the front. A *navigation* request:
        // with no decision type in `WebviewRequest`, there is nothing this
        // message could do to a file.
        await this.deps.revealReview();
        return;

      case 'continueRoadmap':
        // The host's own offer is what gets started — see `WebviewRequest`. The
        // workflow refuses when a turn is in flight, so this cannot interleave.
        await orchestrator.continueRoadmap();
        return;

      case 'acceptRecommendation':
        orchestrator.acceptRecommendation();
        return;

      case 'dismissRecommendation':
        orchestrator.dismissRecommendation();
        return;

      case 'newSession':
        this.deps.newSession();
        return;

      case 'loadSession':
        orchestrator.loadSession(message.sessionId);
        return;

      case 'deleteSession':
        this.deps.deleteSession(message.sessionId);
        return;

      case 'openFile':
        await this.deps.openFile(message.relativePath);
        return;

      case 'addActiveEditorContext':
        await this.deps.addActiveEditorContext();
        return;

      case 'removeContext':
        orchestrator.removePinnedContext(message.relativePath);
        return;

      case 'revealOutput':
        this.deps.revealOutput();
        return;

      case 'chooseModel':
        // Navigation only: it opens the same QuickPick the palette does, and
        // the level configured is chosen in the prompt rather than sent up.
        await vscode.commands.executeCommand('pairpilot.selectModel');
        return;

      default: {
        // Exhaustiveness check: adding a message type without handling it here
        // becomes a compile error rather than a silent no-op.
        const never: never = message;
        this.deps.logger.warn(`Unhandled Webview message: ${JSON.stringify(never)}`);
        return;
      }
    }
  }

}

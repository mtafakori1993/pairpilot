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
 * messages directly bypass approval rules"). An `approveCode` message that
 * arrives while the machine is in `WRITING_CODE` is refused here, no matter how
 * well-formed it is. The router never trusts that the UI only sends sensible
 * messages.
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

  private async dispatch(message: WebviewRequest): Promise<void> {
    const orchestrator = this.deps.orchestrator;
    const state = orchestrator.machine.state;

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

      case 'approveFileCreation':
        // Legal only while awaiting permission for the path.
        this.requireState(state, PairPilotState.WAITING_FILE_APPROVAL, 'approve file creation');
        await orchestrator.approveFileCreation(message.contentHash);
        return;

      case 'rejectFileCreation':
        this.requireState(state, PairPilotState.WAITING_FILE_APPROVAL, 'decline file creation');
        orchestrator.rejectFileCreation(message.contentHash);
        return;

      case 'approveCode':
        this.requireState(
          state,
          PairPilotState.WAITING_CODE_APPROVAL,
          PairPilotState.REVIEWING,
          'approve code'
        );
        await orchestrator.approveCode(message.contentHash);
        return;

      case 'rejectCode':
        this.requireState(
          state,
          PairPilotState.WAITING_CODE_APPROVAL,
          PairPilotState.REVIEWING,
          'reject code'
        );
        await orchestrator.rejectCode(message.contentHash);
        return;

      case 'requestChanges':
        this.requireState(
          state,
          PairPilotState.WAITING_CODE_APPROVAL,
          PairPilotState.REVIEWING,
          'request changes'
        );
        await orchestrator.requestChanges(message.contentHash, message.feedback);
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

      default: {
        // Exhaustiveness check: adding a message type without handling it here
        // becomes a compile error rather than a silent no-op.
        const never: never = message;
        this.deps.logger.warn(`Unhandled Webview message: ${JSON.stringify(never)}`);
        return;
      }
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
        `PairPilot cannot ${description} right now (current state: ${current}). If the panel looks out of date, reopen the PairPilot sidebar.`
      );
      throw new Error(`Action "${description}" is not permitted in state ${current}.`);
    }
  }
}

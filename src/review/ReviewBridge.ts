/**
 * ReviewBridge — the one place an in-editor decision reaches the workflow.
 *
 * The editor surface (`EditorReview`) knows how to show a review and how to
 * refuse a stale decision. The Orchestrator knows how to apply one, with its own
 * content-hash verification and its own batch bookkeeping. This class is the
 * seam between them, and it exists so that neither side has to know the other's
 * shape:
 *
 *  - it builds the `OrchestratorReviewRequest` a written file produces,
 *  - it turns an accepted `ReviewOutcome` into the matching Orchestrator call,
 *  - and it translates the Orchestrator's decision refusal — which speaks in
 *    prose, through `this.error` — back into a notification.
 *
 * It deliberately performs **no** verification of its own. A decision that
 * arrives here has already passed `ReviewSession.submit`'s hash and fingerprint
 * checks, and the Orchestrator re-checks the content hash against its live
 * `ApprovalManager` anyway. A third copy of that logic would be a third place
 * for it to be wrong.
 */

import * as vscode from 'vscode';
import type { Orchestrator, OrchestratorReviewRequest } from '../core/Orchestrator';
import type { ReviewDecision, ReviewOutcome } from './ReviewSession';
import type { Logger } from '../types';

/** The fingerprint the review captures, shared with `LiveWriter`'s shape. */
export interface ReviewBinding {
  readonly sessionId: string;
  readonly documentUri: string;
  readonly request: OrchestratorReviewRequest;
}

export class ReviewBridge {
  /** The review request each live session was opened from, keyed by session id. */
  private readonly bySession = new Map<string, OrchestratorReviewRequest>();

  constructor(
    private readonly deps: {
      orchestrator(): Orchestrator | null;
      logger: Logger;
    }
  ) {}

  /** Remember what a session was opened for, so its decision can be routed. */
  remember(request: OrchestratorReviewRequest): void {
    this.bySession.set(request.sessionId, request);
  }

  /** The decision, applied to the workflow it belongs to. */
  async apply(outcome: ReviewOutcome): Promise<void> {
    const orchestrator = this.deps.orchestrator();
    if (!orchestrator) {
      void vscode.window.showWarningMessage(
        'PairPilot: the workflow is no longer running, so that decision was not applied.'
      );
      return;
    }

    const request = this.bySession.get(outcome.sessionId);
    this.bySession.delete(outcome.sessionId);
    if (!request) {
      this.deps.logger.warn(
        `A review decision arrived for an unknown session (${outcome.sessionId}); it was ignored.`
      );
      return;
    }

    const binding = request.binding;
    const hasBinding =
      binding.proposalId !== undefined ||
      binding.proposalVersion !== undefined ||
      binding.fileId !== undefined;

    switch (outcome.decision) {
      case 'approve':
        await orchestrator.approveCode(outcome.contentHash, hasBinding ? { ...binding } : undefined);
        return;
      case 'reject':
        await orchestrator.rejectCode(outcome.contentHash, hasBinding ? { ...binding } : undefined);
        return;
      case 'request_changes':
        await orchestrator.requestChanges(
          outcome.contentHash,
          outcome.feedback,
          hasBinding ? { ...binding } : undefined
        );
        return;
    }
  }

  /**
   * Report a decision the Orchestrator refused.
   *
   * The workflow sets `error` rather than throwing, so the caller learns the
   * decision did not land only by reading it. This makes that visible instead of
   * leaving the developer with a document that looks approved and a batch that
   * does not agree.
   */
  reportRefusal(orchestrator: Orchestrator, decision: ReviewDecision): void {
    const reason = orchestrator.errorValue;
    orchestrator.clearError();
    void vscode.window.showWarningMessage(
      `PairPilot: the ${decision === 'request_changes' ? 'revision request' : decision} was not applied. ${
        reason ?? 'The proposal is no longer awaiting that decision.'
      }`
    );
  }

  /** Drop a session's record, for a review that was closed without deciding. */
  forget(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  forgetAll(): void {
    this.bySession.clear();
  }
}

/**
 * ApprovalManager — binds every decision to the exact content that was reviewed.
 *
 * Spec section 9 requires that approval is "associated with the exact content
 * hash" and that "the AI must not modify an approved file without a new explicit
 * approval".
 *
 * The mechanism: a decision is only accepted when the hash the developer's UI
 * sent matches the hash of the proposal currently live in this session. If they
 * differ, the proposal changed after the developer looked at it, and the
 * decision is refused rather than applied.
 *
 * There is also a one-shot rule. An approval is consumed when it is used, so a
 * replayed or duplicated message cannot authorise a second write.
 */

import { ApprovalMismatchError } from '../core/errors';
import type { ApprovalDecision, ProposalRecord, ValidatedProposal } from '../types';

export interface DecisionRecord {
  decision: ApprovalDecision;
  contentHash: string;
  relativePath: string;
  at: number;
  /** Set for `request_changes`. */
  feedback?: string;
  /**
   * File content hash captured at approval time, when the approval was applied
   * to a written file. Lets us detect a later external edit.
   */
  approvedFileHash?: string;
}

export class ApprovalManager {
  /** The proposal currently awaiting a decision, if any. */
  private pending: ValidatedProposal | null = null;
  /** Hashes that have already been decided, to block replays. */
  private readonly decided = new Set<string>();
  private readonly history: DecisionRecord[] = [];

  /** Register a proposal as awaiting a decision. Replaces any previous pending. */
  setPending(proposal: ValidatedProposal): void {
    this.pending = proposal;
  }

  getPending(): ValidatedProposal | null {
    return this.pending;
  }

  /** Hash of the proposal awaiting a decision, for the UI to echo back. */
  getPendingHash(): string | null {
    return this.pending?.contentHash ?? null;
  }

  clearPending(): void {
    this.pending = null;
  }

  /**
   * Validate a decision coming from the UI.
   *
   * @throws ApprovalMismatchError when the hash does not match the live
   *   proposal, or the proposal has already been decided.
   */
  verify(contentHash: string): ValidatedProposal {
    if (!this.pending) {
      throw new ApprovalMismatchError(
        'There is no proposal awaiting your decision. It may have been replaced by a newer request.'
      );
    }
    if (this.pending.contentHash !== contentHash) {
      throw new ApprovalMismatchError(
        'This decision does not match the proposal you were shown. The proposal changed since it was displayed, so your decision was not applied. Please review the current version.'
      );
    }
    if (this.decided.has(contentHash)) {
      throw new ApprovalMismatchError(
        'This proposal has already been decided. A decision cannot be applied twice.'
      );
    }
    return this.pending;
  }

  /**
   * Record a decision and consume the pending proposal.
   *
   * `approvedFileHash` is supplied for approvals applied to a written file, so a
   * later external modification can be detected.
   */
  record(
    decision: ApprovalDecision,
    proposal: ValidatedProposal,
    options: { feedback?: string; approvedFileHash?: string } = {}
  ): DecisionRecord {
    const record: DecisionRecord = {
      decision,
      contentHash: proposal.contentHash,
      relativePath: proposal.relativePath,
      at: Date.now(),
      ...(options.feedback !== undefined ? { feedback: options.feedback } : {}),
      ...(options.approvedFileHash !== undefined
        ? { approvedFileHash: options.approvedFileHash }
        : {}),
    };
    this.history.push(record);
    this.decided.add(proposal.contentHash);
    this.pending = null;
    return record;
  }

  isDecided(contentHash: string): boolean {
    return this.decided.has(contentHash);
  }

  getHistory(): readonly DecisionRecord[] {
    return this.history;
  }

  /**
   * Look up the approval covering a file, so that a modification to an approved
   * file can be refused unless a new approval exists (spec section 9).
   */
  findApprovalFor(relativePath: string): DecisionRecord | undefined {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const record = this.history[i];
      if (record?.relativePath === relativePath && record.decision === 'approve') {
        return record;
      }
    }
    return undefined;
  }

  /** True when a file has been approved and its content has since changed. */
  hasDrifted(relativePath: string, currentFileHash: string): boolean {
    const approval = this.findApprovalFor(relativePath);
    if (!approval?.approvedFileHash) {
      return false;
    }
    return approval.approvedFileHash !== currentFileHash;
  }

  reset(): void {
    this.pending = null;
    this.decided.clear();
    this.history.length = 0;
  }
}

/** Build the UI-facing record from a validated proposal. */
export function toProposalRecord(proposal: ValidatedProposal): ProposalRecord {
  const { proposal: source } = proposal;
  return {
    description: source.description,
    relativePath: proposal.relativePath,
    operation: source.operation,
    contentHash: proposal.contentHash,
    dependencies: source.dependencies,
    blocks: source.blocks,
    ...(source.rationale !== undefined ? { rationale: source.rationale } : {}),
    ...(source.responsibilities !== undefined ? { responsibilities: source.responsibilities } : {}),
    ...(source.potentialProblems !== undefined ? { potentialProblems: source.potentialProblems } : {}),
    ...(source.nextStep !== undefined ? { nextStep: source.nextStep } : {}),
  };
}

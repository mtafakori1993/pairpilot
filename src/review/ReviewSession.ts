/**
 * ReviewSession — one file's in-editor review, and the rules it obeys.
 *
 * The review of a written file happens **in the editor that holds the file**:
 * an inline comment thread anchored to the code, and a native modal that asks
 * for the decision. Nothing about a review lives in the PairPilot sidebar.
 *
 * This module is the part of that machinery with no `vscode` in it: the state a
 * session holds, and the rules a decision must satisfy. Keeping it here rather
 * than in the comment controller is what makes the rules testable at all — an
 * editor host is needed to *show* a thread, but not to prove that a decision on
 * bytes that have since changed is refused.
 *
 * Four rules are load-bearing, and each is enforced here rather than trusted
 * to the caller:
 *
 *  1. **A decision names exact bytes.** `contentHash` is the hash of the
 *     proposal the developer was shown. A decision whose hash does not match
 *     the live proposal is refused, not applied. This is the same binding
 *     `ApprovalManager` uses; the session only adds the file-level provenance.
 *  2. **Document drift is visible.** The host fingerprints the document when
 *     the session opens and again at the moment of the decision. A difference
 *     means the developer edited the file, or something else did, after the
 *     code was written — and an approval given then would be an approval of
 *     something nobody reviewed. It is reported so the decision can be refused
 *     with an accurate reason.
 *  3. **A session is one-shot.** Deciding closes it. A duplicate, replayed or
 *     late decision finds a closed session and is refused rather than acting a
 *     second time on a file that is no longer under review.
 *  4. **Sessions never mix.** Each is keyed by the canonical URI of its file,
 *     so a decision for `index.php` cannot reach `create.php` even though both
 *     threads may be on screen at once.
 *
 * Sessions are pure values plus a small state machine, so a caller can reason
 * about one without holding a controller.
 */

/** The three decisions a review offers. */
export const REVIEW_DECISIONS = ['approve', 'request_changes', 'reject'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** Everything a session is opened with, all of it host-supplied. */
export interface ReviewSessionInit {
  /** Stable identity, used by the comment thread's context value. */
  readonly sessionId: string;
  /**
   * The canonical `uri.toString()` of the file being reviewed.
   *
   * Canonical *and* a string: a `vscode.Uri` compares by identity, and two URIs
   * for one file — which is what a reload produces — would otherwise open two
   * sessions over one file.
   */
  readonly documentUri: string;
  /** Workspace-relative path, as the proposal named it. */
  readonly relativePath: string;
  /** `create` or `update`, for the wording of the prompt. */
  readonly operation: 'create' | 'update';
  /** One sentence about what the code does, from the proposal itself. */
  readonly description: string;
  /** The proposal's own explanation, shown in the thread and the modal. */
  readonly rationale: string | null;
  /** Hash of the reviewed bytes. A decision must echo it back. */
  readonly contentHash: string;
  /** The proposal this session is reviewing, for the host's freshness checks. */
  readonly binding: {
    readonly proposalId?: string;
    readonly proposalVersion?: number;
    readonly fileId?: string;
  };
  /** Fingerprint of the document at the moment the session opened. */
  readonly documentFingerprint: string;
  /** Where to anchor the thread, in zero-based line numbers, inclusive. */
  readonly documentLine: number;
  /** How many files are in this review's batch, for "file 2 of 5" wording. */
  readonly position: { readonly index: number; readonly total: number } | null;
}

/** A decision that has been taken, with everything needed to audit it. */
export interface ReviewOutcome {
  readonly sessionId: string;
  readonly documentUri: string;
  readonly relativePath: string;
  readonly decision: ReviewDecision;
  /** The hash the decision was bound to. */
  readonly contentHash: string;
  /** The developer's words, for `request_changes`; may be empty. */
  readonly feedback: string;
  /** Document fingerprint when the decision was taken. */
  readonly documentFingerprint: string;
  readonly at: number;
}

/**
 * Why a decision was refused.
 *
 * Each is a named condition rather than a sentence, so the controller can choose
 * accurate wording for each and a test can assert on the case rather than on
 * prose.
 */
export type ReviewRefusal =
  /** The session has already been decided. */
  | 'already_decided'
  /** The hash did not match the reviewed content. */
  | 'stale_content'
  /** The file changed after it was written. */
  | 'document_changed'
  /** The decision is not one of the three. */
  | 'unknown_decision'
  /** `request_changes` arrived without feedback. */
  | 'feedback_required';

export type ReviewSubmitResult =
  | { ok: true; outcome: ReviewOutcome }
  | { ok: false; reason: ReviewRefusal };

/**
 * The image a session holds on screen.
 *
 * Returned by `view()` so the controller renders from one description rather
 * than reading six fields in an order it invents itself.
 */
export interface ReviewSessionView {
  readonly sessionId: string;
  readonly relativePath: string;
  readonly operation: 'create' | 'update';
  readonly description: string;
  readonly rationale: string | null;
  readonly contentHash: string;
  readonly documentLine: number;
  readonly position: { readonly index: number; readonly total: number } | null;
  readonly decided: boolean;
  /** The decision taken, or null while the session is open. */
  readonly decision: ReviewDecision | null;
}

export class ReviewSession {
  private decision: ReviewDecision | null = null;
  private outcome: ReviewOutcome | null = null;

  constructor(readonly init: ReviewSessionInit) {
    if (init.contentHash.length === 0) {
      throw new Error('A review session needs the hash of the content it reviews.');
    }
    if (init.documentUri.length === 0) {
      throw new Error('A review session needs the document it is anchored to.');
    }
  }

  get sessionId(): string {
    return this.init.sessionId;
  }

  get documentUri(): string {
    return this.init.documentUri;
  }

  get relativePath(): string {
    return this.init.relativePath;
  }

  get contentHash(): string {
    return this.init.contentHash;
  }

  get isDecided(): boolean {
    return this.decision !== null;
  }

  get takenDecision(): ReviewDecision | null {
    return this.decision;
  }

  get result(): ReviewOutcome | null {
    return this.outcome;
  }

  /**
   * Take a decision, if every rule permits it.
   *
   * `currentFingerprint` is what the document holds *now*. It is compared
   * against the fingerprint captured at open, which is the only honest way to
   * tell "the code I reviewed" from "the code that happens to be at that path
   * now" — a distinction the approval hash alone cannot make once the developer
   * has edited the file by hand.
   *
   * `liveContentHash`, when supplied, is the host's own hash of the proposal
   * currently awaiting review. A mismatch means the session is looking at an
   * older revision, which is a stale decision even though the bytes in the
   * document may look unchanged.
   */
  submit(
    decision: string,
    options: {
      feedback?: string;
      currentFingerprint: string;
      liveContentHash?: string;
      now?: number;
    }
  ): ReviewSubmitResult {
    if (this.decision !== null) {
      return { ok: false, reason: 'already_decided' };
    }
    if (!isReviewDecision(decision)) {
      return { ok: false, reason: 'unknown_decision' };
    }

    const feedback = (options.feedback ?? '').trim();
    if (decision === 'request_changes' && feedback.length === 0) {
      return { ok: false, reason: 'feedback_required' };
    }

    if (options.liveContentHash !== undefined && options.liveContentHash !== this.contentHash) {
      return { ok: false, reason: 'stale_content' };
    }

    // Approval and revision both act on the file as reviewed. A document that
    // moved since then means the decision would apply to bytes nobody saw, so
    // it is refused rather than "applied anyway with a warning" — the warning
    // is how a developer ends up approving something they never read.
    //
    // Rejection is deliberately exempt. A developer who rejects has said the
    // code must come back off disk, and whatever else they typed into the file
    // in the meantime is theirs to keep; refusing the rejection would trap
    // unapproved content in their workspace.
    if (decision !== 'reject' && options.currentFingerprint !== this.init.documentFingerprint) {
      return { ok: false, reason: 'document_changed' };
    }

    this.decision = decision;
    this.outcome = {
      sessionId: this.init.sessionId,
      documentUri: this.init.documentUri,
      relativePath: this.init.relativePath,
      decision,
      contentHash: this.init.contentHash,
      feedback,
      documentFingerprint: options.currentFingerprint,
      at: options.now ?? Date.now(),
    };
    return { ok: true, outcome: this.outcome };
  }

  /** What the controller renders. Safe to describe in a comment thread. */
  view(): ReviewSessionView {
    return {
      sessionId: this.init.sessionId,
      relativePath: this.init.relativePath,
      operation: this.init.operation,
      description: this.init.description,
      rationale: this.init.rationale,
      contentHash: this.init.contentHash,
      documentLine: this.init.documentLine,
      position: this.init.position,
      decided: this.decision !== null,
      decision: this.decision,
    };
  }
}

/** Narrow an untrusted string from a command argument or a reply box. */
export function isReviewDecision(value: unknown): value is ReviewDecision {
  return typeof value === 'string' && (REVIEW_DECISIONS as readonly string[]).includes(value);
}

/**
 * The sentence the review modal leads with.
 *
 * Written here rather than in the controller so that the wording is a pure
 * function of the session — which is what lets a test pin the promise the modal
 * makes ("Approve keeps it, Reject removes it") without an editor host.
 */
export function reviewQuestion(session: ReviewSession): string {
  const lead =
    session.init.operation === 'create'
      ? `PairPilot created ${session.relativePath} and wrote the proposed code into it.`
      : `PairPilot rewrote ${session.relativePath} with the proposed code.`;

  const position =
    session.init.position && session.init.position.total > 1
      ? ` (file ${session.init.position.index} of ${session.init.position.total})`
      : '';

  return `${lead}${position} Does the code do what you asked?`;
}

/**
 * The decision prompt, in the words the approval flow has always used.
 *
 * The three buttons say what the *outcome* is — the file is kept, rewritten, or
 * removed — because "request changes" alone does not tell a developer that the
 * unapproved content leaves their workspace while the revision is written.
 */
export const DECISION_PROMPTS = {
  approve: 'Approve',
  reject: 'Reject',
  request_changes: 'Request changes…',
} as const satisfies Readonly<Record<ReviewDecision, string>>;

/**
 * The "request changes" outcome, returned by the modal helper.
 *
 * A feedback box is not shown for a rejection. Rejecting is a complete decision
 * on its own — the code comes off disk — and demanding a reason before allowing
 * it would be making the safe choice the harder one.
 */
export const FEEDBACK_PROMPT = 'What should the code do instead?';

/** The failure sentence for each refusal, ready for a notification. */
export const REFUSAL_MESSAGES: Readonly<Record<ReviewRefusal, string>> = {
  already_decided:
    'That review has already been decided. PairPilot did not apply the decision a second time.',
  stale_content:
    'This decision was made against an earlier version of the code, so it was not applied. Review the current version and decide again.',
  document_changed:
    'The file changed after PairPilot wrote it, so the decision would apply to code you have not reviewed. PairPilot left the file as it is — reload it or request changes instead.',
  unknown_decision: 'PairPilot did not understand that decision.',
  feedback_required:
    'Describe what the code should do instead before requesting changes.',
};

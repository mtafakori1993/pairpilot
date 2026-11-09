/**
 * Typed errors for PairPilot.
 *
 * Every failure that crosses a module boundary is one of these, so callers can
 * distinguish "the developer said no" from "the runtime broke" without string
 * matching.
 */

export class PairPilotError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = 'PairPilotError';
  }
}

/** A filesystem path was rejected by the PathGuard. */
export class PathRejectedError extends PairPilotError {
  constructor(
    message: string,
    readonly attemptedPath: string
  ) {
    super(message, 'PATH_REJECTED');
    this.name = 'PathRejectedError';
  }
}

/** AI output could not be parsed or did not satisfy the proposal schema. */
export class ProposalInvalidError extends PairPilotError {
  constructor(
    message: string,
    readonly issues: string[]
  ) {
    super(message, 'PROPOSAL_INVALID');
    this.name = 'ProposalInvalidError';
  }
}

/** An approval was attempted against content that no longer matches. */
export class ApprovalMismatchError extends PairPilotError {
  constructor(message: string) {
    super(message, 'APPROVAL_MISMATCH');
    this.name = 'ApprovalMismatchError';
  }
}

/** A Webview message was malformed, unknown, or not permitted in this state. */
export class MessageRejectedError extends PairPilotError {
  constructor(message: string) {
    super(message, 'MESSAGE_REJECTED');
    this.name = 'MessageRejectedError';
  }
}

/** The Claude Code runtime is missing, failed to start, or exited badly. */
export class RuntimeError extends PairPilotError {
  constructor(message: string) {
    super(message, 'RUNTIME_ERROR');
    this.name = 'RuntimeError';
  }
}

/** The developer cancelled the operation. */
export class CancelledError extends PairPilotError {
  constructor(message = 'Operation cancelled by the developer.') {
    super(message, 'CANCELLED');
    this.name = 'CancelledError';
  }
}

/** The developer declined a permission prompt. */
export class DeclinedError extends PairPilotError {
  constructor(message = 'The developer declined this action.') {
    super(message, 'DECLINED');
    this.name = 'DeclinedError';
  }
}

/** Extract a display string from an unknown thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof PairPilotError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

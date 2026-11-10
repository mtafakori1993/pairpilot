/**
 * ReviewSessions — the set of live reviews, keyed by file.
 *
 * One review per file, one file per review. That is the whole point of the key:
 * with seven files written by one proposal, the developer may have seven tabs
 * open and two review threads visible at once, and a decision must always reach
 * the file it was made in. Keying by the canonical URI string makes that
 * structural rather than a promise about the UI.
 *
 * A second review of the *same* file replaces the first — a revision is the
 * normal way that happens — and the replaced session is reported to the caller
 * by id so its thread can be closed. Replacing silently would leave a thread
 * pointing at a proposal that no longer exists, which a developer would
 * reasonably read as "still awaiting my decision".
 */

import { ReviewSession, type ReviewDecision, type ReviewSessionInit } from './ReviewSession';

/** Why a session went away. */
export type ReviewCloseReason =
  /** The developer decided it. */
  | 'decided'
  /** A newer review of the same file replaced it. */
  | 'replaced'
  /** The turn was cancelled, or the write rolled back. */
  | 'cancelled'
  /** The extension is shutting down. */
  | 'disposed'
  /** The decision was refused as stale, and the session is no longer valid. */
  | 'stale';

export interface ReviewClosedEvent {
  readonly sessionId: string;
  readonly documentUri: string;
  readonly reason: ReviewCloseReason;
  readonly decision: ReviewDecision | null;
}

export class ReviewSessions {
  private readonly byUri = new Map<string, ReviewSession>();
  private readonly closeListeners = new Set<(event: ReviewClosedEvent) => void>();

  /** Open a review, replacing any review of the same document. */
  open(init: ReviewSessionInit): { session: ReviewSession; replaced: ReviewSession | null } {
    const existing = this.byUri.get(init.documentUri) ?? null;
    const session = new ReviewSession(init);
    this.byUri.set(init.documentUri, session);

    if (existing) {
      this.emit({
        sessionId: existing.sessionId,
        documentUri: existing.documentUri,
        reason: 'replaced',
        decision: existing.takenDecision,
      });
    }
    return { session, replaced: existing };
  }

  /** The review for a document, if one is open. */
  find(documentUri: string): ReviewSession | null {
    return this.byUri.get(documentUri) ?? null;
  }

  /** The review with this id, if any. Linear, and over at most a handful. */
  findById(sessionId: string): ReviewSession | null {
    for (const session of this.byUri.values()) {
      if (session.sessionId === sessionId) {
        return session;
      }
    }
    return null;
  }

  all(): ReviewSession[] {
    return [...this.byUri.values()];
  }

  /** Reviews still awaiting a decision. */
  awaiting(): ReviewSession[] {
    return this.all().filter((session) => !session.isDecided);
  }

  get size(): number {
    return this.byUri.size;
  }

  /**
   * Close a review and forget it.
   *
   * Returns the closed session so the caller can dispose its thread, or null
   * when nothing was open for that document.
   */
  close(documentUri: string, reason: ReviewCloseReason): ReviewSession | null {
    const session = this.byUri.get(documentUri);
    if (!session) {
      return null;
    }
    this.byUri.delete(documentUri);
    this.emit({
      sessionId: session.sessionId,
      documentUri,
      reason,
      decision: session.takenDecision,
    });
    return session;
  }

  /** Close by identity, for callers holding an id rather than a URI. */
  closeById(sessionId: string, reason: ReviewCloseReason): ReviewSession | null {
    const session = this.findById(sessionId);
    if (!session) {
      return null;
    }
    return this.close(session.documentUri, reason);
  }

  /**
   * Close every review.
   *
   * Used by cancel and dispose. A decision arriving after this finds nothing and
   * is refused by the caller — which is correct, because the file it was about
   * was rolled back.
   */
  closeAll(reason: ReviewCloseReason): ReviewSession[] {
    const sessions = this.all();
    this.byUri.clear();
    for (const session of sessions) {
      this.emit({
        sessionId: session.sessionId,
        documentUri: session.documentUri,
        reason,
        decision: session.takenDecision,
      });
    }
    return sessions;
  }

  /**
   * Note that a session's document drifted out from under it.
   *
   * The session stays open — the developer can still reject — but this closes
   * the *approval* path for it, which is what stops a stale decision from being
   * retried later. Emitted as a close so exactly one thread cleanup runs.
   */
  invalidate(documentUri: string): ReviewSession | null {
    return this.close(documentUri, 'stale');
  }

  onDidClose(listener: (event: ReviewClosedEvent) => void): { dispose(): void } {
    this.closeListeners.add(listener);
    return { dispose: () => void this.closeListeners.delete(listener) };
  }

  private emit(event: ReviewClosedEvent): void {
    for (const listener of this.closeListeners) {
      try {
        listener(event);
      } catch {
        // A listener that throws must not prevent the remaining ones — a
        // cleanup failure in one thread is not a reason to leak the others.
      }
    }
  }
}

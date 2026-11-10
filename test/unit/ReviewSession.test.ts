/**
 * ReviewSession — the rules an in-editor decision must satisfy.
 *
 * These tests exist because the rules are the security story of the feature.
 * The comment thread is the visible half; this is the half that decides whether
 * an approval acts on the bytes the developer actually read. If a stale
 * decision, a replayed one, or a decision made after a hand edit were applied,
 * the review would be decoration.
 */

import { describe, expect, it } from 'vitest';
import {
  DECISION_PROMPTS,
  REFUSAL_MESSAGES,
  ReviewSession,
  REVIEW_DECISIONS,
  isReviewDecision,
  reviewQuestion,
  type ReviewSessionInit,
} from '../../src/review/ReviewSession';
import { ReviewSessions } from '../../src/review/ReviewSessions';

const HASH = 'a'.repeat(64);

function init(overrides: Partial<ReviewSessionInit> = {}): ReviewSessionInit {
  return {
    sessionId: 'session-1',
    documentUri: 'file:///workspace/index.php',
    relativePath: 'index.php',
    operation: 'create',
    description: 'Renders the landing page.',
    rationale: 'It reads the template and echoes it.',
    contentHash: HASH,
    binding: { proposalId: 'p1', proposalVersion: 1, fileId: 'f1' },
    documentFingerprint: 'fp-1',
    documentLine: 0,
    position: { index: 1, total: 3 },
    ...overrides,
  };
}

describe('ReviewSession decisions', () => {
  it('takes an approval bound to the reviewed content', () => {
    const session = new ReviewSession(init());
    const result = session.submit('approve', { currentFingerprint: 'fp-1', now: 1000 });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.outcome.decision).toBe('approve');
    expect(result.outcome.contentHash).toBe(HASH);
    expect(result.outcome.documentUri).toBe('file:///workspace/index.php');
    expect(result.outcome.at).toBe(1000);
    expect(session.isDecided).toBe(true);
  });

  it('refuses a second decision on the same session', () => {
    const session = new ReviewSession(init());
    session.submit('approve', { currentFingerprint: 'fp-1' });

    const second = session.submit('reject', { currentFingerprint: 'fp-1' });
    expect(second).toEqual({ ok: false, reason: 'already_decided' });
    // The first decision still stands — the second did not overwrite it.
    expect(session.takenDecision).toBe('approve');
  });

  it('refuses a decision that is not one of the three', () => {
    const session = new ReviewSession(init());
    expect(session.submit('LGTM', { currentFingerprint: 'fp-1' })).toEqual({
      ok: false,
      reason: 'unknown_decision',
    });
    expect(session.isDecided).toBe(false);
  });

  it('requires feedback before requesting changes', () => {
    const session = new ReviewSession(init());
    expect(
      session.submit('request_changes', { currentFingerprint: 'fp-1', feedback: '   ' })
    ).toEqual({ ok: false, reason: 'feedback_required' });
    expect(session.isDecided).toBe(false);

    const withFeedback = session.submit('request_changes', {
      currentFingerprint: 'fp-1',
      feedback: 'Use a prepared statement.',
    });
    expect(withFeedback.ok).toBe(true);
    if (withFeedback.ok) {
      expect(withFeedback.outcome.feedback).toBe('Use a prepared statement.');
    }
  });

  it('does not require feedback to reject, because rejecting is complete on its own', () => {
    const session = new ReviewSession(init());
    const result = session.submit('reject', { currentFingerprint: 'fp-1' });
    expect(result.ok).toBe(true);
  });

  it('refuses a decision bound to a hash the session does not carry', () => {
    const session = new ReviewSession(init());
    const result = session.submit('approve', {
      currentFingerprint: 'fp-1',
      liveContentHash: 'b'.repeat(64),
    });
    expect(result).toEqual({ ok: false, reason: 'stale_content' });
    expect(session.isDecided).toBe(false);
  });

  it('accepts a decision whose hash matches the live proposal', () => {
    const session = new ReviewSession(init());
    const result = session.submit('approve', {
      currentFingerprint: 'fp-1',
      liveContentHash: HASH,
    });
    expect(result.ok).toBe(true);
  });

  it('refuses an approval after the document was edited by hand', () => {
    const session = new ReviewSession(init());
    const result = session.submit('approve', { currentFingerprint: 'fp-edited' });
    expect(result).toEqual({ ok: false, reason: 'document_changed' });
    expect(session.isDecided).toBe(false);
  });

  it('refuses a change request after a hand edit too, since the revision would target the wrong bytes', () => {
    const session = new ReviewSession(init());
    const result = session.submit('request_changes', {
      currentFingerprint: 'fp-edited',
      feedback: 'Rename this.',
    });
    expect(result).toEqual({ ok: false, reason: 'document_changed' });
  });

  it('still allows a rejection after a hand edit, so unapproved code cannot be trapped in the workspace', () => {
    const session = new ReviewSession(init());
    const result = session.submit('reject', { currentFingerprint: 'fp-edited' });
    expect(result.ok).toBe(true);
  });

  it('rejects a session with no content hash rather than approving nothing', () => {
    expect(() => new ReviewSession(init({ contentHash: '' }))).toThrow(/hash/);
  });

  it('rejects a session with no document to anchor to', () => {
    expect(() => new ReviewSession(init({ documentUri: '' }))).toThrow(/document/);
  });
});

describe('ReviewSession view', () => {
  it('describes itself without exposing anything a thread could not show', () => {
    const session = new ReviewSession(init({ operation: 'update' }));
    const view = session.view();

    expect(view.relativePath).toBe('index.php');
    expect(view.operation).toBe('update');
    expect(view.position).toEqual({ index: 1, total: 3 });
    expect(view.decided).toBe(false);
    expect(view.decision).toBeNull();
  });

  it('reports the decision once one is taken', () => {
    const session = new ReviewSession(init());
    session.submit('reject', { currentFingerprint: 'fp-1' });
    expect(session.view().decided).toBe(true);
    expect(session.view().decision).toBe('reject');
  });
});

describe('ReviewSession wording', () => {
  it('says what happened to the file, and how many files are in the batch', () => {
    const created = new ReviewSession(init());
    expect(reviewQuestion(created)).toContain('created index.php');
    expect(reviewQuestion(created)).toContain('file 1 of 3');

    const updated = new ReviewSession(init({ operation: 'update', position: null }));
    expect(reviewQuestion(updated)).toContain('rewrote index.php');
    expect(reviewQuestion(updated)).not.toContain('file 1 of');
  });

  it('names all three decisions and their outcome-facing labels', () => {
    expect(REVIEW_DECISIONS).toEqual(['approve', 'request_changes', 'reject']);
    expect(DECISION_PROMPTS.approve).toBe('Approve');
    expect(DECISION_PROMPTS.reject).toBe('Reject');
    expect(DECISION_PROMPTS.request_changes).toContain('Request changes');
  });

  it('explains every refusal in a sentence a developer can act on', () => {
    for (const reason of [
      'already_decided',
      'stale_content',
      'document_changed',
      'unknown_decision',
      'feedback_required',
    ] as const) {
      expect(REFUSAL_MESSAGES[reason].length).toBeGreaterThan(20);
    }
  });

  it('narrows an untrusted value to a decision', () => {
    expect(isReviewDecision('approve')).toBe(true);
    expect(isReviewDecision('reject')).toBe(true);
    expect(isReviewDecision('request_changes')).toBe(true);
    expect(isReviewDecision('APPROVE')).toBe(false);
    expect(isReviewDecision(null)).toBe(false);
    expect(isReviewDecision({ decision: 'approve' })).toBe(false);
  });
});

describe('ReviewSessions registry', () => {
  it('keeps one session per file, so a decision reaches the file it was made in', () => {
    const sessions = new ReviewSessions();
    sessions.open(init());
    sessions.open(
      init({
        sessionId: 'session-2',
        documentUri: 'file:///workspace/create.php',
        relativePath: 'create.php',
      })
    );

    expect(sessions.size).toBe(2);
    expect(sessions.find('file:///workspace/index.php')?.relativePath).toBe('index.php');
    expect(sessions.find('file:///workspace/create.php')?.relativePath).toBe('create.php');
    expect(sessions.find('file:///workspace/missing.php')).toBeNull();
  });

  it('reports the replaced session when a revision reopens the same file', () => {
    const sessions = new ReviewSessions();
    const closed: string[] = [];
    sessions.onDidClose((event) => closed.push(`${event.reason}:${event.sessionId}`));

    sessions.open(init());
    const result = sessions.open(init({ sessionId: 'session-2', contentHash: 'b'.repeat(64) }));

    expect(result.replaced?.sessionId).toBe('session-1');
    expect(result.session.sessionId).toBe('session-2');
    expect(closed).toEqual(['replaced:session-1']);
    expect(sessions.size).toBe(1);
  });

  it('lists only the sessions still awaiting a decision', () => {
    const sessions = new ReviewSessions();
    const first = sessions.open(init()).session;
    sessions.open(
      init({ sessionId: 'session-2', documentUri: 'file:///workspace/other.php' })
    );
    first.submit('approve', { currentFingerprint: 'fp-1' });

    expect(sessions.awaiting().map((session) => session.sessionId)).toEqual(['session-2']);
    expect(sessions.all()).toHaveLength(2);
  });

  it('closes by URI and by id, and forgets the session', () => {
    const sessions = new ReviewSessions();
    sessions.open(init());
    sessions.open(init({ sessionId: 'session-2', documentUri: 'file:///workspace/b.php' }));

    expect(sessions.close('file:///workspace/index.php', 'decided')?.sessionId).toBe('session-1');
    expect(sessions.findById('session-1')).toBeNull();
    expect(sessions.closeById('session-2', 'cancelled')?.sessionId).toBe('session-2');
    expect(sessions.size).toBe(0);
    expect(sessions.closeById('never-opened', 'decided')).toBeNull();
  });

  it('closes everything on cancel, and says what each session had decided', () => {
    const sessions = new ReviewSessions();
    const decided = sessions.open(init()).session;
    sessions.open(init({ sessionId: 'session-2', documentUri: 'file:///workspace/b.php' }));
    decided.submit('approve', { currentFingerprint: 'fp-1' });

    const events: Array<{ id: string; decision: string | null }> = [];
    sessions.onDidClose((event) => events.push({ id: event.sessionId, decision: event.decision }));

    const closed = sessions.closeAll('cancelled');
    expect(closed).toHaveLength(2);
    expect(sessions.size).toBe(0);
    expect(events).toEqual([
      { id: 'session-1', decision: 'approve' },
      { id: 'session-2', decision: null },
    ]);
  });

  it('marks a drifted document stale and closes its approval path', () => {
    const sessions = new ReviewSessions();
    sessions.open(init());
    const reasons: string[] = [];
    sessions.onDidClose((event) => reasons.push(event.reason));

    sessions.invalidate('file:///workspace/index.php');
    expect(sessions.find('file:///workspace/index.php')).toBeNull();
    expect(reasons).toEqual(['stale']);
  });

  it('survives a throwing listener rather than leaking the sessions after it', () => {
    const sessions = new ReviewSessions();
    const seen: string[] = [];
    sessions.onDidClose(() => {
      throw new Error('listener failed');
    });
    sessions.onDidClose((event) => seen.push(event.sessionId));
    sessions.open(init()).session;
    sessions.closeAll('disposed');

    expect(seen).toEqual(['session-1']);
    expect(sessions.size).toBe(0);
  });

  it('stops notifying a disposed listener', () => {
    const sessions = new ReviewSessions();
    const seen: string[] = [];
    const listener = sessions.onDidClose((event) => seen.push(event.reason));
    listener.dispose();

    sessions.open(init());
    sessions.closeAll('decided');
    expect(seen).toEqual([]);
  });
});

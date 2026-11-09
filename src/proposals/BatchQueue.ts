/**
 * BatchQueue — the durable record of one multi-file proposal in flight.
 *
 * ## Why this exists
 *
 * A multi-file proposal is not seven independent proposals that happen to
 * arrive together. It is one decision the developer made once ("write all seven
 * files") that is then carried out seven times. The 0.2.x code modelled it as a
 * bare array plus a cursor, which was enough to *write* the files but not enough
 * to *survive* them: revising file 3 or rejecting it called
 * `discardRemainingChanges()`, which emptied the array, and files 4-7 vanished
 * with no record that they had ever been promised.
 *
 * This class is that record. It answers, at any moment:
 *
 *   - which files were authorised, completed, failed or are still pending,
 *   - where each file is in its own review cycle,
 *   - which file is being written right now, so two writers can never target
 *     the same path,
 *   - which proposal version a file's content came from, so a decision made
 *     against stale content is refused rather than applied.
 *
 * ## Identity
 *
 * Every file carries a `fileId` derived from the proposal id and its own path.
 * It is deterministic, so the same file in the same proposal always has the same
 * id across a Webview reload or a host restart within the session, and it cannot
 * be confused with a sibling's.
 *
 * ## Version
 *
 * `proposalVersion` counts how many times this batch's *content* has changed —
 * the original staging, plus one for each revision the developer asked for. A
 * decision echoes the version it was shown; if the batch has moved on, the
 * decision is refused and the developer is asked to look again. That is the
 * rule that stops a "yes" from being applied to code the developer never read.
 */

import * as crypto from 'node:crypto';
import type { ValidatedChange, ValidatedChangeSet } from '../types';

/** Where one file is in the write → review cycle. */
export type BatchFileStatus =
  /** Promised, not yet written. */
  | 'pending'
  /** Covered by a batch authorisation; will be written without a further path gate. */
  | 'authorized'
  /** Being streamed into the editor right now. */
  | 'writing'
  /** Written, awaiting the developer's per-file decision. */
  | 'completed'
  /** Written and kept. */
  | 'approved'
  /** Could not be written; the rest of the batch is unaffected. */
  | 'failed'
  /** The developer asked for a revision; the file is being regenerated. */
  | 'revision'
  /** The developer rejected the written content; the file was rolled back. */
  | 'rejected';

export interface BatchFileEntry {
  /** Stable within the batch: derived from the proposal id and the path. */
  readonly fileId: string;
  readonly relativePath: string;
  /**
   * Mutable: a revision replaces the file that will be written, and a create
   * can legitimately become an update if the developer created the file
   * themselves while the proposal sat awaiting a decision.
   */
  operation: 'create' | 'update';
  /** The approval binding for the content currently held for this file. */
  contentHash: string;
  status: BatchFileStatus;
  /** Why the file is in a non-happy state, when there is something to say. */
  note?: string;
  /** How many times this file has been written, revised or retried. */
  attempts: number;
  /** The validated change itself, so a retry never needs to re-derive content. */
  change: ValidatedChange;
}

/** The read-only projection the Webview is given. */
export interface BatchView {
  batchId: string;
  proposalId: string;
  proposalVersion: number;
  total: number;
  authorized: number;
  completed: number;
  pending: number;
  failed: number;
  files: {
    fileId: string;
    file: string;
    operation: string;
    status: BatchFileStatus;
    note?: string;
  }[];
}

/** A decision's claim about which version of which file it approves. */
export interface DecisionBinding {
  /** The proposal the developer was looking at. */
  proposalId?: string;
  proposalVersion?: number;
  /** The individual file, when the decision is about one file. */
  fileId?: string;
}

/** Raised when a decision does not match the batch as it now stands. */
export class StaleBatchDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleBatchDecisionError';
  }
}

/**
 * Derive a stable, collision-resistant id for one file of one proposal.
 *
 * Truncated to 16 hex characters: this is an identifier, not a security token,
 * and the value it must be unique against is a handful of sibling paths.
 */
function deriveFileId(proposalId: string, relativePath: string): string {
  return crypto
    .createHash('sha256')
    .update(`${proposalId}\u0000${relativePath}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

export class BatchQueue {
  private readonly entries: BatchFileEntry[] = [];
  private readonly byFileId = new Map<string, BatchFileEntry>();
  private readonly byPath = new Map<string, BatchFileEntry>();
  /**
   * Paths currently being written.
   *
   * The whole point of the batch is that files are reviewed independently, which
   * makes it possible for two review sessions to try to write the same path at
   * once — one as an original, one as a revision. The lock is per path and is
   * taken for the duration of a single write, never held across a review.
   */
  private readonly writing = new Set<string>();

  private constructor(
    readonly batchId: string,
    readonly proposalId: string,
    private version: number,
    changes: readonly ValidatedChange[]
  ) {
    for (const change of changes) {
      this.addEntry(change);
    }
  }

  /**
   * Create a batch from a freshly validated change set.
   *
   * @param proposalId Identifies the proposal content; derived from the set hash
   *   so that a re-stage of identical content is recognisably the same proposal.
   * @param version The proposal version this batch starts at.
   */
  static create(set: ValidatedChangeSet, version = 1): BatchQueue {
    return new BatchQueue(`batch:${set.changeSetHash.slice(0, 16)}`, set.changeSetHash, version, set.changes);
  }

  private addEntry(change: ValidatedChange): BatchFileEntry {
    const entry: BatchFileEntry = {
      fileId: deriveFileId(this.proposalId, change.relativePath),
      relativePath: change.relativePath,
      operation: change.change.operation === 'update' ? 'update' : 'create',
      contentHash: change.contentHash,
      status: 'pending',
      attempts: 0,
      change,
    };
    this.entries.push(entry);
    this.byFileId.set(entry.fileId, entry);
    this.byPath.set(entry.relativePath, entry);
    return entry;
  }

  get proposalVersion(): number {
    return this.version;
  }

  /** Every entry, in write order. */
  all(): readonly BatchFileEntry[] {
    return this.entries;
  }

  get size(): number {
    return this.entries.length;
  }

  byId(fileId: string): BatchFileEntry | undefined {
    return this.byFileId.get(fileId);
  }

  /** Look a file up by the id the developer's decision referenced. */
  requireById(fileId: string): BatchFileEntry {
    const entry = this.byFileId.get(fileId);
    if (!entry) {
      throw new StaleBatchDecisionError(
        'That file is not part of the proposal you were shown. It may have been replaced by a newer request.'
      );
    }
    return entry;
  }

  byRelativePath(relativePath: string): BatchFileEntry | undefined {
    return this.byPath.get(relativePath);
  }

  /** Entries still to be written, in order, whether or not they are authorised. */
  pendingEntries(): readonly BatchFileEntry[] {
    return this.entries.filter(
      (entry) => entry.status === 'pending' || entry.status === 'authorized'
    );
  }

  /**
   * The next file that has not been written yet, if any.
   *
   * "Not written yet" covers both `pending` and `authorized`. Missing the
   * authorized state here would make a fully authorised batch look finished the
   * moment it started: the six files the developer had just approved for writing
   * would be reported as nothing left to do, and the batch would settle having
   * written one file of seven.
   */
  nextPending(): BatchFileEntry | undefined {
    return this.entries.find(
      (entry) => entry.status === 'pending' || entry.status === 'authorized'
    );
  }

  /**
   * The next file that is written and still awaiting a decision, if any.
   *
   * Used when one review session finishes and the batch needs to hand the
   * developer the next thing that actually wants their attention.
   */
  nextAwaitingReview(): BatchFileEntry | undefined {
    return this.entries.find((entry) => entry.status === 'completed');
  }

  /** Authorise every file that is still pending. Returns what was authorised. */
  authorizeRemaining(): readonly BatchFileEntry[] {
    const authorised: BatchFileEntry[] = [];
    for (const entry of this.entries) {
      if (entry.status === 'pending') {
        entry.status = 'authorized';
        authorised.push(entry);
      }
    }
    return authorised;
  }

  /** True when the whole batch was authorised in one decision. */
  get hasAuthorisation(): boolean {
    return this.entries.some(
      (entry) => entry.status === 'authorized' || entry.status === 'writing'
    );
  }

  /**
   * Claim the write lock for a path.
   *
   * @returns false when a write to that path is already in flight, which is the
   *   one case where two review sessions must not both proceed.
   */
  claimWrite(relativePath: string): boolean {
    if (this.writing.has(relativePath)) {
      return false;
    }
    this.writing.add(relativePath);
    return true;
  }

  releaseWrite(relativePath: string): void {
    this.writing.delete(relativePath);
  }

  isWriting(relativePath: string): boolean {
    return this.writing.has(relativePath);
  }

  markWriting(relativePath: string): void {
    const entry = this.byPath.get(relativePath);
    if (entry) {
      entry.status = 'writing';
      entry.attempts += 1;
    }
  }

  markCompleted(relativePath: string): void {
    const entry = this.byPath.get(relativePath);
    if (entry) {
      entry.status = 'completed';
    }
  }

  markApproved(relativePath: string): void {
    const entry = this.byPath.get(relativePath);
    if (entry) {
      entry.status = 'approved';
      entry.note = undefined;
    }
  }

  /**
   * Record a failure for one file.
   *
   * The batch deliberately keeps going: spec section 6 requires that a failed
   * file does not corrupt or cancel the others, so the failure is recorded
   * against this path and the remaining files stay exactly as they were.
   */
  markFailed(relativePath: string, note: string): void {
    const entry = this.byPath.get(relativePath);
    if (entry) {
      entry.status = 'failed';
      entry.note = note;
    }
  }

  markRevision(relativePath: string): void {
    const entry = this.byPath.get(relativePath);
    if (entry) {
      entry.status = 'revision';
    }
  }

  markRejected(relativePath: string, note?: string): void {
    const entry = this.byPath.get(relativePath);
    if (entry) {
      entry.status = 'rejected';
      entry.note = note;
    }
  }

  /**
   * Swap in regenerated content for one file and move the batch to a new version.
   *
   * This is the operation that makes a revision safe. The regenerated file
   * replaces its own entry — content, hash and handle — while every sibling is
   * left untouched, so revising `index.php` cannot disturb `create.php`. The
   * version bump is what invalidates any decision the developer made against the
   * previous content.
   */
  revise(relativePath: string, change: ValidatedChange): { fileId: string; version: number } {
    const existing = this.byPath.get(relativePath);
    if (!existing) {
      throw new StaleBatchDecisionError(
        `"${relativePath}" is not part of the proposal in progress, so its revision could not be applied.`
      );
    }
    this.replace(existing, change);
    this.version += 1;
    return { fileId: existing.fileId, version: this.version };
  }

  /**
   * Apply a whole revision reply to this batch.
   *
   * A revision is not a new proposal. It is the developer saying "this file
   * again" about one file of a proposal they already decided on, and the other
   * files in that proposal are still exactly as they were — written, awaiting
   * review, or not yet reached. Staging the reply as a fresh batch is what used
   * to throw the rest of the proposal away: seven files approved, one revised,
   * six gone.
   *
   * Every file the reply mentions that this batch already holds is replaced in
   * place, keeping its `fileId` so a decision about it still resolves. A file the
   * reply introduces is added. A file the reply does not mention is left alone,
   * which is the point.
   *
   * The version advances once for the whole merge, not once per file, because a
   * decision was made against one version of the batch and it is that version
   * which has now moved on.
   */
  mergeRevision(
    set: ValidatedChangeSet,
    revisingPath: string
  ): { revised: readonly string[]; added: readonly string[]; version: number } {
    if (!this.byPath.has(revisingPath)) {
      throw new StaleBatchDecisionError(
        `"${revisingPath}" is not part of the proposal in progress, so its revision could not be applied.`
      );
    }

    const revised: string[] = [];
    const added: string[] = [];
    for (const change of set.changes) {
      const existing = this.byPath.get(change.relativePath);
      if (existing) {
        this.replace(existing, change);
        revised.push(change.relativePath);
      } else {
        this.addEntry(change);
        added.push(change.relativePath);
      }
    }
    this.version += 1;
    return { revised, added, version: this.version };
  }

  /** Put new content behind an existing entry, resetting it for another write. */
  private replace(entry: BatchFileEntry, change: ValidatedChange): void {
    entry.change = change;
    entry.contentHash = change.contentHash;
    entry.operation = change.change.operation === 'update' ? 'update' : 'create';
    entry.status = 'pending';
    entry.note = undefined;
  }

  /**
   * Check a decision's claim about the batch, and refuse it when stale.
   *
   * An unspecified field is not checked, so a caller that only knows the hash
   * still works; but anything the Webview *does* state must be true, because a
   * stated-but-wrong identity is exactly the signature of a decision applied to
   * content the developer never saw.
   */
  assertFresh(binding: DecisionBinding | undefined, relativePath?: string): void {
    if (!binding) {
      return;
    }
    if (binding.proposalId !== undefined && binding.proposalId !== this.proposalId) {
      throw new StaleBatchDecisionError(
        'This decision belongs to a different proposal than the one in progress, so it was not applied.'
      );
    }
    if (binding.proposalVersion !== undefined && binding.proposalVersion !== this.version) {
      throw new StaleBatchDecisionError(
        `This proposal changed after you looked at it (it is now version ${this.version}), so your decision was not applied. Please review the current version.`
      );
    }
    if (binding.fileId !== undefined) {
      const entry = this.requireById(binding.fileId);
      if (relativePath !== undefined && entry.relativePath !== relativePath) {
        throw new StaleBatchDecisionError(
          'This decision names a different file than the one it would apply to, so it was not applied.'
        );
      }
    }
  }

  /**
   * How many files are in each state, for the panel's progress line.
   *
   * The counts are deliberately about *the developer's view* rather than a
   * one-to-one map of the status enum:
   *
   *  - `pending` is "still to be written", which includes files that have been
   *    authorised for writing but have not been reached yet. From the
   *    developer's seat those are files still to come, and calling them
   *    "completed" would overstate what the batch has done.
   *  - `authorized` is "the write has been agreed", so it counts authorised,
   *    in-flight and already-written files — everything past the permission gate.
   *  - `completed` is "written, and possibly already kept".
   */
  counts(): {
    total: number;
    authorized: number;
    completed: number;
    pending: number;
    failed: number;
    approved: number;
  } {
    const of = (...statuses: BatchFileStatus[]): number =>
      this.entries.filter((entry) => statuses.includes(entry.status)).length;
    return {
      total: this.entries.length,
      authorized: of('authorized', 'writing', 'completed', 'approved'),
      completed: of('completed', 'approved'),
      pending: of('pending', 'authorized', 'writing'),
      failed: of('failed'),
      approved: of('approved'),
    };
  }

  /** True when nothing is left to write and nothing is awaiting a decision. */
  isSettled(): boolean {
    return !this.entries.some(
      (entry) => entry.status === 'pending' || entry.status === 'authorized' || entry.status === 'writing' || entry.status === 'completed'
    );
  }

  /** The projection sent to the Webview. Never includes file content. */
  view(): BatchView {
    const counts = this.counts();
    return {
      batchId: this.batchId,
      proposalId: this.proposalId,
      proposalVersion: this.version,
      total: counts.total,
      authorized: counts.authorized,
      completed: counts.completed,
      pending: counts.pending,
      failed: counts.failed,
      files: this.entries.map((entry) => ({
        fileId: entry.fileId,
        file: entry.relativePath,
        operation: entry.operation,
        status: entry.status,
        ...(entry.note !== undefined ? { note: entry.note } : {}),
      })),
    };
  }
}

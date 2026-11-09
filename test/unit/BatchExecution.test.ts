/**
 * The multi-file batch: seven files, seven independent reviews.
 *
 * ## What went wrong, and what these tests pin
 *
 * The report was that seven files were approved and then the files "went
 * missing". Two separate things were true:
 *
 *  1. The panel's *context* list — the workspace files sent to the model — was
 *     empty and said so under the proposal, which read as "your files are gone".
 *     It was never about the proposal. (Rendered in `main.js`; the wording is
 *     what changed, and it is not a condition a unit test can add much to.)
 *  2. More seriously, the code really did throw files away: revising or
 *     rejecting one file called `discardRemainingChanges()`, which emptied the
 *     queue, so the promise made about the other six evaporated.
 *
 * These tests are about the second one, and about the guarantees the batch has
 * to keep for a seven-file proposal to be safe at all:
 *
 *   - all seven contents survive parsing and storage,
 *   - a batch authorisation covers all seven,
 *   - a decision cannot be applied to a changed proposal version,
 *   - missing content is caught before anything is written, never replaced by an
 *     empty file,
 *   - one file's outcome leaves the other six alone,
 *   - a failed file does not corrupt its siblings,
 *   - approval-to-write and approval-of-the-code stay separate,
 *   - the batch survives a panel reload,
 *   - two sessions on two files stay isolated, and one path cannot be written twice.
 *
 * The batch record itself is exercised directly, because that is where the
 * guarantee lives; the whole-turn behaviour is in `OrchestratorTurn.test.ts`.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BatchQueue,
  StaleBatchDecisionError,
  type BatchFileStatus,
} from '../../src/proposals/BatchQueue';
import { ProposalValidator } from '../../src/proposals/ProposalValidator';
import { PathGuard } from '../../src/security/PathGuard';
import { PAIRPILOT_PROTOCOL_VERSION } from '../../src/protocol/types';
import type { CodeProposalMessage, ProposalChange } from '../../src/protocol/types';

/**
 * A real, empty temporary workspace.
 *
 * Real because the validator stats the target path: every change here is a
 * `create` of a file that does not exist, and a fixture that could not tell
 * "absent" from "unreadable" would not be testing the same thing the extension
 * does.
 */
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pairpilot-batch-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const SEVEN_FILES = [
  'index.php',
  'create.php',
  'list.php',
  'edit.php',
  'delete.php',
  'db.php',
  'helpers.php',
] as const;

/** Seven `create` changes, each with content that identifies it. */
function sevenChanges(): ProposalChange[] {
  return SEVEN_FILES.map((file, index) => ({
    id: `change-${index + 1}`,
    file,
    operation: 'create',
    description: `File ${index + 1}.`,
    content: `<?php\n\n// ${file}\nfunction handler_${index}(): void {}\n`,
    dependencies: [],
    risk: 'low',
  }));
}

function messageWith(changes: ProposalChange[]): CodeProposalMessage {
  return {
    protocol_version: PAIRPILOT_PROTOCOL_VERSION,
    type: 'code_proposal',
    message: 'Seven files.',
    task: { title: 'User management', description: 'Seven PHP files.' },
    changes,
  } as CodeProposalMessage;
}

/** Validate a seven-file proposal into a change set. */
function sevenFileSet() {
  const guard = new PathGuard(root);
  const validator = new ProposalValidator(guard);
  return validator.validateChangeSet(messageWith(sevenChanges()));
}

describe('all seven files survive parsing and storage', () => {
  it('keeps every file, in order, with its own content', () => {
    const set = sevenFileSet();

    expect(set.changes).toHaveLength(7);
    expect(set.changes.map((change) => change.relativePath)).toEqual([...SEVEN_FILES]);

    // Every content string is the one that was sent, and each is distinct — a
    // parser that collapsed files together would still have produced seven
    // entries, so distinctness is the assertion that matters.
    const contents = set.changes.map((change) => change.assembledCode);
    expect(new Set(contents).size).toBe(7);
    for (const [index, change] of set.changes.entries()) {
      expect(change.assembledCode).toContain(`handler_${index}()`);
    }
  });

  it('gives every file a distinct approval hash', () => {
    const set = sevenFileSet();
    const hashes = set.changes.map((change) => change.contentHash);
    expect(new Set(hashes).size).toBe(7);
    for (const hash of hashes) {
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('carries every content into the batch record unchanged', () => {
    const set = sevenFileSet();
    const batch = BatchQueue.create(set);

    expect(batch.size).toBe(7);
    for (const entry of batch.all()) {
      expect(entry.change.assembledCode.trim().length).toBeGreaterThan(0);
      expect(entry.change.assembledCode).toContain(entry.relativePath.replace('.php', ''));
    }
  });
});

describe('batch authorisation', () => {
  it('resolves all seven files and leaves none unauthorised', () => {
    const batch = BatchQueue.create(sevenFileSet());

    expect(batch.pendingEntries()).toHaveLength(7);
    const authorised = batch.authorizeRemaining();

    expect(authorised).toHaveLength(7);
    expect(batch.counts().authorized).toBe(7);
    for (const entry of batch.all()) {
      expect(entry.status).toBe('authorized');
    }
    // All seven are still *to be written* — authorising is not writing, and the
    // batch must still know it has seven files of work in front of it. This is
    // the distinction the panel's "N to go" line depends on.
    expect(batch.pendingEntries()).toHaveLength(7);
    expect(batch.counts().pending).toBe(7);
    expect(batch.counts().completed).toBe(0);
  });

  it('is permission to write, not approval of the code', () => {
    const batch = BatchQueue.create(sevenFileSet());
    batch.authorizeRemaining();

    // Authorising the batch must not mark anything as reviewed or approved:
    // every file still has its own review ahead of it.
    const counts = batch.counts();
    expect(counts.approved).toBe(0);
    expect(counts.completed).toBe(0);
    for (const entry of batch.all()) {
      expect(entry.status).not.toBe('approved');
      expect(entry.status).not.toBe('completed');
    }
  });
});

describe('a decision cannot authorise a changed proposal', () => {
  it('refuses a decision naming a superseded version', () => {
    const batch = BatchQueue.create(sevenFileSet());
    const binding = {
      proposalId: batch.proposalId,
      proposalVersion: batch.proposalVersion,
      fileId: batch.all()[0]!.fileId,
    };

    // A decision made against the version on screen is accepted.
    expect(() => batch.assertFresh(binding)).not.toThrow();

    // The proposal is revised: the file the developer was looking at is
    // regenerated and the version advances.
    const revised = sevenFileSet().changes[0]!;
    batch.revise('index.php', { ...revised, contentHash: 'a'.repeat(64) });

    // The same decision is now stale, and is refused rather than applied.
    expect(() => batch.assertFresh(binding)).toThrow(StaleBatchDecisionError);
    expect(() => batch.assertFresh(binding)).toThrow(/version/i);
  });

  it('refuses a decision naming a different proposal', () => {
    const batch = BatchQueue.create(sevenFileSet());
    expect(() =>
      batch.assertFresh({ proposalId: 'something-else', proposalVersion: batch.proposalVersion })
    ).toThrow(StaleBatchDecisionError);
  });

  it('refuses a decision naming a file that is not in the batch', () => {
    const batch = BatchQueue.create(sevenFileSet());
    expect(() => batch.assertFresh({ fileId: 'deadbeefdeadbeef' })).toThrow(StaleBatchDecisionError);
  });

  it('refuses a decision whose file does not match the path it would apply to', () => {
    const batch = BatchQueue.create(sevenFileSet());
    const indexFile = batch.all()[0]!;
    expect(() => batch.assertFresh({ fileId: indexFile.fileId }, 'create.php')).toThrow(
      StaleBatchDecisionError
    );
  });

  it('accepts a decision that claims nothing — absence is not a false claim', () => {
    const batch = BatchQueue.create(sevenFileSet());
    expect(() => batch.assertFresh(undefined)).not.toThrow();
    expect(() => batch.assertFresh({})).not.toThrow();
  });
});

describe('missing content is detected, never substituted', () => {
  it('has no empty content anywhere in a validated batch', () => {
    // The validator rejects empty content outright, so a batch can only hold
    // writable content. This is the property that makes "never create an empty
    // file" enforceable rather than aspirational.
    const batch = BatchQueue.create(sevenFileSet());
    for (const entry of batch.all()) {
      expect(entry.change.assembledCode.trim()).not.toBe('');
    }
  });

  it('discards the whole proposal rather than accepting one empty file', () => {
    const guard = new PathGuard(root);
    const validator = new ProposalValidator(guard);
    const changes = sevenChanges();
    changes[4] = { ...changes[4]!, content: '   ' };

    // The set is refused; it is not applied with file 5 quietly empty.
    expect(() => validator.validateChangeSet(messageWith(changes))).toThrow();
  });
});

describe('one file does not disturb the others', () => {
  it('keeps the siblings exactly as they were when one is approved', () => {
    const batch = BatchQueue.create(sevenFileSet());
    batch.authorizeRemaining();
    const before = batch.all().map((entry) => ({ path: entry.relativePath, hash: entry.contentHash }));

    batch.markCompleted('index.php');
    batch.markApproved('index.php');

    expect(batch.byRelativePath('index.php')!.status).toBe('approved');
    // Every sibling is untouched, content and hash included.
    for (const record of before.slice(1)) {
      const entry = batch.byRelativePath(record.path)!;
      expect(entry.contentHash).toBe(record.hash);
      expect(entry.status).toBe('authorized');
    }
  });

  it('keeps the remaining files when one is rejected', () => {
    const batch = BatchQueue.create(sevenFileSet());
    batch.authorizeRemaining();
    batch.markCompleted('edit.php');
    batch.markRejected('edit.php', 'wrong approach');

    expect(batch.byRelativePath('edit.php')!.status).toBe('rejected');
    // The other six are still there, still authorised, still pending their own
    // review — the promise the old code broke.
    const others = batch.all().filter((entry) => entry.relativePath !== 'edit.php');
    expect(others).toHaveLength(6);
    for (const entry of others) {
      expect(entry.status).toBe('authorized');
    }
    expect(batch.counts().total).toBe(7);
  });

  it('replaces only the revised file, and bumps the version', () => {
    const batch = BatchQueue.create(sevenFileSet());
    batch.authorizeRemaining();
    const versionBefore = batch.proposalVersion;
    const untouched = batch.all().filter((entry) => entry.relativePath !== 'list.php');
    const untouchedHashes = untouched.map((entry) => entry.contentHash);

    const regenerated = sevenFileSet().changes[2]!;
    const result = batch.revise('list.php', {
      ...regenerated,
      contentHash: 'b'.repeat(64),
      assembledCode: '<?php\n// revised\n',
    });

    expect(result.version).toBe(versionBefore + 1);
    expect(batch.byRelativePath('list.php')!.contentHash).toBe('b'.repeat(64));
    expect(batch.byRelativePath('list.php')!.status).toBe('pending');
    // Every sibling's content hash is exactly what it was.
    const untouchedAfter = batch
      .all()
      .filter((entry) => entry.relativePath !== 'list.php')
      .map((entry) => entry.contentHash);
    expect(untouchedAfter).toEqual(untouchedHashes);
  });
});

describe('a failed file does not corrupt its siblings', () => {
  it('records the failure against one path and leaves the rest intact', () => {
    const batch = BatchQueue.create(sevenFileSet());
    batch.authorizeRemaining();
    batch.markCompleted('index.php');

    batch.markFailed('db.php', 'the editor refused to save the file');

    expect(batch.byRelativePath('db.php')!.status).toBe('failed');
    expect(batch.byRelativePath('db.php')!.note).toMatch(/refused to save/);
    expect(batch.counts().failed).toBe(1);
    // index.php is still written and awaiting review; the other five are still
    // to come. A failure is not a cancellation.
    expect(batch.byRelativePath('index.php')!.status).toBe('completed');
    expect(batch.pendingEntries()).toHaveLength(5);
  });

  it('still has a next file to write after a failure', () => {
    const batch = BatchQueue.create(sevenFileSet());
    batch.authorizeRemaining();
    batch.markFailed('helpers.php', 'path outside the workspace');

    expect(batch.nextPending()?.relativePath).toBe('index.php');
  });

  it('reports the batch as settled only when nothing is left', () => {
    const batch = BatchQueue.create(sevenFileSet());
    batch.authorizeRemaining();
    expect(batch.isSettled()).toBe(false);

    for (const entry of batch.all()) {
      batch.markCompleted(entry.relativePath);
      batch.markApproved(entry.relativePath);
    }
    expect(batch.isSettled()).toBe(true);
  });
});

describe('the batch survives a panel reload', () => {
  it('reports the same seven files from the host record alone', () => {
    const batch = BatchQueue.create(sevenFileSet());
    batch.authorizeRemaining();
    batch.markCompleted('index.php');
    batch.markApproved('index.php');
    batch.markCompleted('create.php');

    // This is everything the panel is sent. Nothing here is remembered by the
    // panel, so a reload re-renders identically.
    const view = batch.view();

    expect(view.total).toBe(7);
    expect(view.completed).toBe(2);
    expect(view.pending).toBe(5);
    expect(view.files).toHaveLength(7);
    expect(view.files.map((file) => file.file)).toEqual([...SEVEN_FILES]);
    expect(view.files[0]!.status).toBe('approved');
    expect(view.files[1]!.status).toBe('completed');
    expect(view.files[2]!.status).toBe('authorized');
  });

  it('never sends file content to the panel', () => {
    const batch = BatchQueue.create(sevenFileSet());
    const serialised = JSON.stringify(batch.view());

    // The code reaches the developer through the editor, not the snapshot. A
    // batch view that carried content would also be a new place for it to leak.
    expect(serialised).not.toContain('handler_');
    expect(serialised).not.toContain('<?php');
  });

  it('keeps file ids stable across views', () => {
    const batch = BatchQueue.create(sevenFileSet());
    const first = batch.view().files.map((file) => file.fileId);
    const second = batch.view().files.map((file) => file.fileId);

    expect(second).toEqual(first);
    // Stable, and unique per file.
    expect(new Set(first).size).toBe(7);
  });
});

describe('concurrent review sessions stay isolated', () => {
  it('locks one path at a time and refuses a second writer', () => {
    const batch = BatchQueue.create(sevenFileSet());

    expect(batch.claimWrite('index.php')).toBe(true);
    // A revision session trying to write the same file must not interleave.
    expect(batch.claimWrite('index.php')).toBe(false);
    expect(batch.isWriting('index.php')).toBe(true);

    batch.releaseWrite('index.php');
    expect(batch.claimWrite('index.php')).toBe(true);
  });

  it('lets two different files be written at once', () => {
    const batch = BatchQueue.create(sevenFileSet());

    // "Request a revision for index.php while reviewing create.php" must be
    // possible: the lock is per path, not per batch.
    expect(batch.claimWrite('index.php')).toBe(true);
    expect(batch.claimWrite('create.php')).toBe(true);
    expect(batch.isWriting('index.php')).toBe(true);
    expect(batch.isWriting('create.php')).toBe(true);
  });

  it('keeps a revision to one file out of another file’s status', () => {
    const batch = BatchQueue.create(sevenFileSet());
    batch.authorizeRemaining();
    batch.markCompleted('create.php');

    batch.markRevision('index.php');

    expect(batch.byRelativePath('index.php')!.status).toBe('revision');
    // create.php is still written and awaiting its own review: the two sessions
    // do not share a state.
    expect(batch.byRelativePath('create.php')!.status).toBe('completed');
  });

  it('reports the next file awaiting review independently of write order', () => {
    const batch = BatchQueue.create(sevenFileSet());
    batch.authorizeRemaining();
    // Two in flight, reviewed out of order.
    batch.markCompleted('delete.php');
    batch.markCompleted('helpers.php');
    batch.markApproved('helpers.php');

    // delete.php was written first and is the one still wanting attention.
    expect(batch.nextAwaitingReview()?.relativePath).toBe('delete.php');
  });
});

describe('a revision merges into the batch instead of replacing it', () => {
  it('replaces only the revised file and leaves the other six exactly as they were', () => {
    const batch = BatchQueue.create(sevenFileSet());
    batch.authorizeRemaining();
    // Three files written and one of them already kept, so the batch holds a
    // mixture of states a revision must not disturb.
    batch.markCompleted('index.php');
    batch.markApproved('index.php');
    batch.markCompleted('create.php');
    const untouchedBefore = batch
      .all()
      .filter((entry) => entry.relativePath !== 'list.php')
      .map((entry) => ({
        path: entry.relativePath,
        hash: entry.contentHash,
        status: entry.status,
        fileId: entry.fileId,
      }));

    // The reply to a revision of `list.php`: the model answers with that one
    // file, which is what makes staging the reply as a fresh batch so damaging.
    const regenerated = sevenFileSet().changes[2]!;
    const replySet = {
      ...sevenFileSet(),
      changes: [
        {
          ...regenerated,
          contentHash: 'c'.repeat(64),
          assembledCode: '<?php\n// revised list.php\n',
        },
      ],
    };

    const merged = batch.mergeRevision(replySet, 'list.php');

    expect(merged.revised).toEqual(['list.php']);
    expect(merged.added).toEqual([]);
    expect(batch.byRelativePath('list.php')!.contentHash).toBe('c'.repeat(64));
    expect(batch.byRelativePath('list.php')!.status).toBe('pending');

    // Every sibling keeps its path, hash, state and identity. Note that this
    // includes files written, files approved and files still to come: a revision
    // is about one file and the others are none of its business.
    const untouchedAfter = batch
      .all()
      .filter((entry) => entry.relativePath !== 'list.php')
      .map((entry) => ({
        path: entry.relativePath,
        hash: entry.contentHash,
        status: entry.status,
        fileId: entry.fileId,
      }));
    expect(untouchedAfter).toEqual(untouchedBefore);
    expect(batch.counts().total).toBe(7);
  });

  it('advances the version once for the whole merge', () => {
    const batch = BatchQueue.create(sevenFileSet());
    const before = batch.proposalVersion;

    // A reply that regenerates two files is still one revision the developer
    // asked for, so it moves the batch on by one version — not two.
    const set = sevenFileSet();
    const merged = batch.mergeRevision(
      { ...set, changes: [set.changes[0]!, set.changes[1]!] },
      'index.php'
    );

    expect(merged.revised).toHaveLength(2);
    expect(merged.version).toBe(before + 1);
    expect(batch.proposalVersion).toBe(before + 1);
  });

  it('adds a file the revision introduced rather than losing it', () => {
    const batch = BatchQueue.create(sevenFileSet());
    const set = sevenFileSet();
    const extra = {
      ...set.changes[0]!,
      relativePath: 'src/extra.php',
      change: { ...set.changes[0]!.change, file: 'src/extra.php' },
      contentHash: 'd'.repeat(64),
    };

    const merged = batch.mergeRevision({ ...set, changes: [set.changes[0]!, extra] }, 'index.php');

    expect(merged.added).toEqual(['src/extra.php']);
    expect(batch.size).toBe(8);
    // And the new file starts where every file starts: awaiting its own write.
    expect(batch.byRelativePath('src/extra.php')!.status).toBe('pending');
    expect(batch.pendingEntries()).toHaveLength(8);
  });

  it('refuses a revision of a file that is not in the batch', () => {
    const batch = BatchQueue.create(sevenFileSet());

    // Nothing is merged, because there is nothing to merge into: this is the
    // signature of a revision aimed at a proposal that has already been replaced.
    expect(() => batch.mergeRevision(sevenFileSet(), 'src/never-proposed.php')).toThrow(
      StaleBatchDecisionError
    );
    expect(batch.size).toBe(7);
    expect(batch.proposalVersion).toBe(1);
  });

  it('leaves the batch able to report every file after a merge', () => {
    const batch = BatchQueue.create(sevenFileSet());
    batch.authorizeRemaining();
    batch.markCompleted('index.php');
    batch.markFailed('db.php', 'the editor refused to save the file');

    const set = sevenFileSet();
    batch.mergeRevision({ ...set, changes: [set.changes[2]!] }, 'list.php');

    const view = batch.view();
    expect(view.total).toBe(7);
    // The three states that existed before the merge are all still there.
    expect(view.files.find((file) => file.file === 'index.php')!.status).toBe('completed');
    expect(view.files.find((file) => file.file === 'db.php')!.status).toBe('failed');
    expect(view.files.find((file) => file.file === 'list.php')!.status).toBe('pending');
  });
});

describe('the file id is derived, not invented', () => {
  it('is stable for the same proposal and path, and differs across paths', () => {
    const a = BatchQueue.create(sevenFileSet());
    const b = BatchQueue.create(sevenFileSet());

    // Same content, same set hash, therefore the same proposal identity and the
    // same ids — which is what lets a decision survive a panel reload.
    expect(b.view().files.map((file) => file.fileId)).toEqual(
      a.view().files.map((file) => file.fileId)
    );
  });

  it('marks a file writing only when it is claimed', () => {
    const batch = BatchQueue.create(sevenFileSet());
    const entry = batch.all()[0]!;
    expect(entry.attempts).toBe(0);

    batch.markWriting(entry.relativePath);

    expect(entry.status satisfies BatchFileStatus).toBe('writing');
    expect(entry.attempts).toBe(1);
  });
});

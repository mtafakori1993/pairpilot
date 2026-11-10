/**
 * RevisionScope — the rules that decide whether a revision still applies.
 *
 * ## Why this is tested on its own
 *
 * The revision pipeline is where "it worked when I tried it" is least trustworthy.
 * A revision is requested about a file that exists in someone's editor, and the
 * model then spends seconds — sometimes minutes — thinking. The developer does
 * not sit still during that window. Everything that makes a revision *safe* is a
 * comparison between what the file held when the request went out and what it
 * holds when the reply comes back, and those comparisons are pure functions of a
 * few strings.
 *
 * Testing them here means the interesting cases — the file edited mid-revision,
 * the file deleted, the file that appeared, the batch that moved on — are all
 * reachable without an editor, a workspace or a provider. The alternative is
 * reaching them through a full turn, where each case costs a scripted reply and
 * the failure mode being tested is buried under staging and validation.
 */

import { describe, expect, it } from 'vitest';
import {
  differsFromReviewed,
  revisionStillApplies,
  sameContent,
  type RevisionObservation,
  type RevisionScope,
} from '../../src/proposals/RevisionScope';

function scope(overrides: Partial<RevisionScope> = {}): RevisionScope {
  return {
    relativePath: 'src/User.php',
    absolutePath: '/tmp/ws/src/User.php',
    reviewedContent: '<?php\n\nfinal class User {}\n',
    reviewedHash: 'a'.repeat(64),
    onDiskAtRequest: '<?php\n\nfinal class User {}\n',
    batchVersion: 2,
    feedback: 'make the class final',
    ...overrides,
  };
}

function now(overrides: Partial<RevisionObservation> = {}): RevisionObservation {
  return {
    onDisk: '<?php\n\nfinal class User {}\n',
    batchVersion: 2,
    ...overrides,
  };
}

describe('a revision that still applies', () => {
  it('is not stale when the file is exactly as it was', () => {
    expect(revisionStillApplies(scope(), now())).toEqual({ stale: false });
  });

  it('is not stale when only the line endings differ', () => {
    // A rollback that wrote `\n` into a file checked out with CRLF, or an editor
    // that normalised on save, changes the string and not the code. Refusing here
    // would stop the workflow on a difference nobody made.
    const result = revisionStillApplies(
      scope({ onDiskAtRequest: '<?php\r\n\r\nfinal class User {}\r\n' }),
      now({ onDisk: '<?php\n\nfinal class User {}\n' })
    );
    expect(result.stale).toBe(false);
  });

  it('is not stale when the file did not exist and still does not', () => {
    // The normal state for revising a `create` whose write was taken back off
    // disk: there is no file to compare, and that is not a change.
    const result = revisionStillApplies(
      scope({ onDiskAtRequest: null }),
      now({ onDisk: null })
    );
    expect(result.stale).toBe(false);
  });

  it('is not stale when there is no batch to have moved on', () => {
    const result = revisionStillApplies(
      scope({ batchVersion: null }),
      now({ batchVersion: null })
    );
    expect(result.stale).toBe(false);
  });
});

describe('a revision that has gone stale', () => {
  it('is stale when the developer edited the file while the model was thinking', () => {
    const result = revisionStillApplies(
      scope(),
      now({ onDisk: '<?php\n\nfinal class User { public function __construct() {} }\n' })
    );
    expect(result.stale).toBe(true);
    if (result.stale) {
      // The message has to say the developer's work survived, because that is the
      // fact they cannot recover by re-reading the code.
      expect(result.reason).toMatch(/edited/i);
      expect(result.reason).toMatch(/kept/i);
      expect(result.reason).toContain('src/User.php');
    }
  });

  it('is stale when the file appeared where there was none', () => {
    const result = revisionStillApplies(
      scope({ onDiskAtRequest: null }),
      now({ onDisk: '<?php\n\nfinal class User {}\n' })
    );
    expect(result.stale).toBe(true);
    if (result.stale) {
      expect(result.reason).toMatch(/now exists/i);
    }
  });

  it('is stale when the file was deleted under the revision', () => {
    const result = revisionStillApplies(scope(), now({ onDisk: null }));
    expect(result.stale).toBe(true);
    if (result.stale) {
      expect(result.reason).toMatch(/no longer on disk/i);
    }
  });

  it('is stale when the batch moved to a new version', () => {
    // A decision — or a revision — made against version 2 says nothing about
    // version 3. Applying it would replace bytes the developer never saw.
    const result = revisionStillApplies(scope({ batchVersion: 2 }), now({ batchVersion: 3 }));
    expect(result.stale).toBe(true);
    if (result.stale) {
      expect(result.reason).toMatch(/version 3/);
      expect(result.reason).toMatch(/version 2/);
    }
  });

  it('reports the batch version before the file content', () => {
    // Both are true; the version is the one that explains the other. A developer
    // told "the file was edited" when the real cause is a newer proposal would go
    // looking for edits that are not there.
    const result = revisionStillApplies(
      scope({ batchVersion: 1, onDiskAtRequest: 'a' }),
      now({ batchVersion: 4, onDisk: 'b' })
    );
    expect(result.stale).toBe(true);
    if (result.stale) {
      expect(result.reason).toMatch(/version 4/);
    }
  });
});

describe('sameContent', () => {
  it('treats two absent files as the same', () => {
    expect(sameContent(null, null)).toBe(true);
  });

  it('treats a file and its absence as different', () => {
    expect(sameContent(null, '')).toBe(false);
    expect(sameContent('', null)).toBe(false);
  });

  it('treats an empty file and an absent one as different', () => {
    // An empty file is a file. A revision that created one where nothing was
    // would still be a write the developer did not ask for.
    expect(sameContent('', null)).toBe(false);
  });

  it('compares content exactly apart from line endings', () => {
    expect(sameContent('a\nb\n', 'a\nb\n')).toBe(true);
    expect(sameContent('a\nb\n', 'a\r\nb\r\n')).toBe(true);
    expect(sameContent('a\nb\n', 'a\nb\n ')).toBe(false);
  });
});

describe('detecting an edit made before the revision was asked for', () => {
  it('is false when the file still matches the reviewed code', () => {
    expect(differsFromReviewed(scope(), scope().reviewedContent)).toBe(false);
  });

  it('is true when the developer changed the file by hand', () => {
    expect(differsFromReviewed(scope(), '<?php\n\n// mine now\n')).toBe(true);
  });

  it('is false when there is no file to compare', () => {
    // Nothing was edited. A missing file is a fact about the write, not about
    // the developer's hands, and reporting it as an edit would have the model
    // "keeping" changes that do not exist.
    expect(differsFromReviewed(scope({ onDiskAtRequest: null }), null)).toBe(false);
  });
});

/**
 * RevisionScope — what a revision was asked for, and whether it still applies.
 *
 * ## Why this is its own thing
 *
 * The initial proposal pipeline and the revision pipeline are not the same
 * pipeline, and treating them as one is what produced the reported failure in
 * two different places:
 *
 *  - The revision turn had no correction loop, so the first summary-shaped reply
 *    ended it with the missing-`changes` contract error, and
 *  - the revision prompt was given only the *approved* content, with no notion
 *    of what the file actually holds now and no record of which review version
 *    the developer was looking at when they asked.
 *
 * A revision is an operation on a file that exists in someone's editor. That
 * makes two facts load-bearing, and neither is available from the proposal
 * alone:
 *
 *  1. **What the file held when the revision was asked for.** The model thinks
 *     for a while — seconds to minutes. Anything the developer types in that
 *     window is theirs, and a revised file written over it destroys work with no
 *     undo. Recording the on-disk state at request time is what makes that
 *     detectable rather than invisible.
 *  2. **Which review version the request belongs to.** A batch advances a version
 *     every time its content changes. A revision asked for against version 1 and
 *     applied against version 3 would replace bytes the developer never saw.
 *
 * ## Why the comparison lives here rather than in the Orchestrator
 *
 * It is a pure function of four strings and a number, so it is worth testing
 * without an editor, a workspace or a provider — and the revision path is
 * precisely where "we tested the happy path" is not good enough. The
 * Orchestrator supplies the observations; this decides.
 *
 * ## The base content, and why it is not the on-disk content
 *
 * `reviewedContent` is the code the developer read and said "not like that"
 * about. It is the thing being revised, and for a `create` whose write was
 * rolled back it is the *only* copy of that code anywhere — the file is gone
 * from disk. `onDiskAtRequest` is what is actually at the path, which for an
 * `update` reviewed before writing is the pre-existing file, not the proposal.
 * Both are sent to the model, labelled, because a model shown only one of them
 * either regenerates an unrelated implementation or rewrites a file it has not
 * read.
 */

/**
 * A revision in flight: which file, what is being revised, and what the path
 * held when the developer asked for it.
 *
 * Captured once, at the moment of the request — after any rollback, so
 * `onDiskAtRequest` is the state the revised write is expected to replace.
 */
export interface RevisionScope {
  /** Workspace-relative, POSIX-separated. The only path a revision may touch. */
  readonly relativePath: string;
  /** Absolute path, for observing the file rather than trusting the path. */
  readonly absolutePath: string;
  /** The content the developer reviewed and asked to change. */
  readonly reviewedContent: string;
  /** The approval hash that content was held under, for the prompt's audit line. */
  readonly reviewedHash: string;
  /**
   * What the path held when the revision was requested, after any rollback.
   *
   * `null` means there was no file, which is the normal state for a revision of
   * a `create` whose write has been taken back off disk.
   */
  readonly onDiskAtRequest: string | null;
  /** The batch's version at request time, or `null` when there is no batch. */
  readonly batchVersion: number | null;
  /** The developer's own words, kept so the prompt and the diagnostics agree. */
  readonly feedback: string;
}

/** What the path and the batch look like *now*, observed by the caller. */
export interface RevisionObservation {
  /** Current content of the target path, or `null` when there is no file. */
  readonly onDisk: string | null;
  /** The batch's current version, or `null` when there is no batch. */
  readonly batchVersion: number | null;
}

/** The answer to "does this revision still describe the file in front of us?". */
export type RevisionStaleness =
  | { readonly stale: false }
  | { readonly stale: true; readonly reason: string };

/**
 * Line endings are not a change.
 *
 * The same bytes checked out on Windows, restored by a rollback that wrote `\n`,
 * or held in an editor document that normalised to `\r\n`, differ as strings and
 * are identical as code. Comparing them raw would refuse a revision every time
 * the developer's editor touched the file's line endings on save — a refusal
 * that is wrong, and one that stops the workflow with no way past it.
 */
export function sameContent(a: string | null, b: string | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return normalise(a) === normalise(b);
}

function normalise(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

/**
 * Has the revision gone stale since it was requested?
 *
 * Four ways it can, each with its own sentence, because "the revision could not
 * be applied" tells the developer nothing about what to do next:
 *
 *  - the file was **edited** while the model was thinking — their work is kept,
 *    the revision is refused,
 *  - the file **appeared** (they created it themselves, or another tool did),
 *  - the file **disappeared** (deleted, renamed, checked out over),
 *  - the batch **moved on** — a newer proposal or revision is in flight.
 *
 * All four are refusals rather than warnings. A revision carries complete file
 * content that is written verbatim, so applying it over an edit is not a
 * degraded success; it is the loss of whatever the developer typed.
 */
export function revisionStillApplies(
  scope: RevisionScope,
  now: RevisionObservation
): RevisionStaleness {
  if (
    scope.batchVersion !== null &&
    now.batchVersion !== null &&
    scope.batchVersion !== now.batchVersion
  ) {
    return {
      stale: true,
      reason:
        `The proposal in progress changed (it is now version ${now.batchVersion}, and this revision ` +
        `was asked for against version ${scope.batchVersion}), so the revised content was not applied. ` +
        'Review the current version and ask again.',
    };
  }

  if (scope.onDiskAtRequest === null && now.onDisk !== null) {
    return {
      stale: true,
      reason:
        `"${scope.relativePath}" now exists on disk, and it did not when you asked for the revision, ` +
        'so the revised content was not written. Re-read the file and ask again if it still needs changing.',
    };
  }

  if (scope.onDiskAtRequest !== null && now.onDisk === null) {
    return {
      stale: true,
      reason:
        `"${scope.relativePath}" is no longer on disk. It was removed after you asked for the revision, ` +
        'so the revised content was not written.',
    };
  }

  if (!sameContent(scope.onDiskAtRequest, now.onDisk)) {
    return {
      stale: true,
      reason:
        `"${scope.relativePath}" was edited after you asked for the revision, so the revised content was ` +
        'not applied — your edits were kept. Ask again once the file says what you want it to say.',
    };
  }

  return { stale: false };
}

/**
 * Did the developer change the reviewed file themselves before asking?
 *
 * A different question from staleness, and one the *model* needs answered rather
 * than the workflow: a developer who hand-edited a written file and then asked
 * for a change is asking about the file as it now stands, and a model told only
 * about the reviewed version would revise code that is no longer there.
 */
export function differsFromReviewed(
  scope: RevisionScope,
  currentOnDisk: string | null
): boolean {
  if (currentOnDisk === null) {
    return false;
  }
  return !sameContent(scope.reviewedContent, currentOnDisk);
}

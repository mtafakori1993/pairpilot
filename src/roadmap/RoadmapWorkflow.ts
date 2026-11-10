/**
 * RoadmapWorkflow — the roadmap as the Orchestrator sees it.
 *
 * The Orchestrator offers two hooks (`describeForPrompt` and `advance`) and must
 * not know anything else about roadmaps: it has no workspace root, no editor and
 * no way to ask the developer a question. This adapter supplies all three.
 *
 * The one decision that lives here rather than in the pure `RoadmapContinuation`
 * is the **verification question**. The continuation refuses to write `done`
 * unless verification has passed, but it cannot know whether it has; only the
 * developer can say. So the adapter asks — and asks *only* when the answer
 * changes the roadmap. Prompting after every file would make the one prompt that
 * writes `done` into wallpaper.
 *
 * The prompt is injected rather than imported, so the sequencing above is
 * testable without an editor. `extension.ts` supplies the real modal.
 */

import type { RoadmapDeps } from '../core/Orchestrator';
import type { Continuation, RoadmapContinuation } from './RoadmapContinuation';
import type { RoadmapStore, RoadmapReadResult } from './RoadmapStore';
import type { Logger } from '../types';

/**
 * Paths approved since this extension started.
 *
 * Deliberately a record of *this session*: a fresh window starting a task that
 * is already `in_progress` in the file will ask for its first file again, which
 * is the safe direction to be wrong in. Reading the file's own statuses instead
 * would let a hand-written `in_progress` be mistaken for "these files are done".
 */
export class ApprovedLedger {
  private readonly approved = new Set<string>();

  add(relativePath: string): void {
    this.approved.add(normalise(relativePath));
  }

  has(relativePath: string): boolean {
    return this.approved.has(normalise(relativePath));
  }

  all(): string[] {
    return [...this.approved];
  }

  clear(): void {
    this.approved.clear();
  }
}

function normalise(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim();
}

export class RoadmapWorkflow implements RoadmapDeps {
  constructor(
    private readonly deps: {
      store: RoadmapStore;
      continuation: RoadmapContinuation;
      ledger: ApprovedLedger;
      logger: Logger;
      /**
       * Ask the developer whether a task's work passed its checks.
       *
       * Returns false for "not yet", Escape, and dismissal alike: an unanswered
       * question must never complete work.
       */
      confirmVerified(taskId: string): Promise<boolean>;
      /** Told when a roadmap file is found or changes, so UI can refresh. */
      onChanged?(): void;
    }
  ) {}

  /** The roadmap text the coding prompt carries, or `null` with no roadmap. */
  async describeForPrompt(): Promise<string | null> {
    return this.deps.continuation.describeForPrompt();
  }

  async advance(input: {
    relativePath: string;
    approvedPaths: readonly string[];
  }): Promise<Continuation> {
    // Every approval is recorded here rather than trusted from the caller, so a
    // file written before the roadmap was read is still counted.
    this.deps.ledger.add(input.relativePath);
    const approvedPaths = dedupe([...input.approvedPaths, ...this.deps.ledger.all()]);

    // First pass: record the approval without claiming anything was verified.
    // It moves the task to `in_progress`, or — when this was the task's last
    // file — comes back saying verification is what is missing.
    const first = await this.deps.continuation.afterApproval({
      relativePath: input.relativePath,
      approvedPaths,
      verified: false,
    });

    if (first.kind !== 'awaiting_verification') {
      this.announce(first);
      return first;
    }

    // Only now, when the answer actually changes the roadmap, is the developer
    // asked. Asking after every file would be noise and would train them to
    // dismiss the one prompt that writes `done`.
    if (!(await this.deps.confirmVerified(first.taskId))) {
      return first;
    }

    const confirmed = await this.deps.continuation.afterApproval({
      relativePath: input.relativePath,
      approvedPaths,
      verified: true,
    });
    this.announce(confirmed);
    return confirmed;
  }

  /** Let the UI refresh when the roadmap moved. */
  private announce(result: Continuation): void {
    if (result.kind === 'next_file' || result.kind === 'next_task' || result.kind === 'complete') {
      this.deps.onChanged?.();
    }
  }

  /** Read-only view of the roadmap, for a status line or a command. */
  async read(): Promise<RoadmapReadResult> {
    return this.deps.store.read();
  }
}

function dedupe(paths: readonly string[]): string[] {
  return [...new Set(paths.map(normalise))];
}

/**
 * RoadmapContinuation — what happens after a file is approved.
 *
 * The spec's loop is narrow and worth holding to exactly:
 *
 *     approve a file  →  update its roadmap task  →  find the next eligible task
 *                     →  open that task's next file in the editor  →  review again
 *
 * Two rules make it honest, and both are enforced here rather than suggested in
 * a prompt:
 *
 *  - **`done` is written only when the task is actually finished.** A task owns
 *    one or more files; approving the first of them does not complete it. So the
 *    status moves to `in_progress` on the first approval and to `done` only when
 *    every file the task owns has been approved *and* verification has passed.
 *    An approved-but-untested task stays `in_progress`, which is the difference
 *    between a roadmap that records what happened and one that flatters it.
 *  - **A task is only "next" when its dependencies are `done`.** That is decided
 *    by `nextTask` over the parsed file, never by a counter — so a hand-edited
 *    roadmap takes effect without restarting anything.
 *
 * This class is stateless. The set of approved paths is the caller's, because
 * the caller (the batch) is what knows which files actually landed; keeping a
 * second copy here would give the two a chance to disagree. What this class adds
 * is the *interpretation*: which file is next, whether the task is finished, and
 * whether writing `done` is justified yet.
 *
 * It performs no writes itself. It asks `RoadmapStore` (which goes through a real
 * `WorkspaceEdit`) and reports a *plan* for the caller to act on, so the whole of
 * the decision is testable without an editor.
 */

import {
  activeTask,
  isComplete,
  taskOwning,
  type Roadmap,
  type RoadmapProblem,
  type RoadmapStatus,
  type RoadmapTask,
} from './Roadmap';
import type { RoadmapStore } from './RoadmapStore';
import type { Logger } from '../types';

/** What the continuation decided should happen next. */
export type Continuation =
  /** Another file belongs to the same task and should be opened next. */
  | {
      kind: 'next_file';
      taskId: string;
      relativePath: string;
      /** True when the task's status moved as a result of this decision. */
      statusChanged: boolean;
    }
  /**
   * Every file of the task is written, but verification has not passed, so the
   * task stays `in_progress`. There is deliberately no file to open: the next
   * step is a check, not a write.
   */
  | { kind: 'awaiting_verification'; taskId: string }
  /** The task is finished and verified; there is another task to start. */
  | {
      kind: 'next_task';
      taskId: string;
      relativePath: string;
      completedTaskId: string;
    }
  /** Every task is done. */
  | { kind: 'complete'; approvedCount: number }
  /** The approved file belongs to no task, so there is nothing to advance. */
  | { kind: 'unlisted'; relativePath: string }
  /** There is no roadmap to follow. */
  | { kind: 'no_roadmap' }
  /** The roadmap exists but could not be read, understood, or updated. */
  | { kind: 'blocked'; reason: string };

export interface ContinuationInput {
  /** The file just approved. */
  relativePath: string;
  /**
   * Every path approved so far, across all tasks, *including* the one just
   * approved. This is what makes "the task is finished" a fact rather than an
   * assumption: the class never infers it from a counter of its own.
   */
  approvedPaths: readonly string[];
  /**
   * Whether verification for this task has passed.
   *
   * Verification is not this module's business — it is the project's tests, a
   * typecheck, or the developer's own word. What this module enforces is that
   * `done` is never written without it.
   */
  verified: boolean;
}

export class RoadmapContinuation {
  constructor(
    private readonly deps: {
      store: RoadmapStore;
      logger: Logger;
    }
  ) {}

  /**
   * Record that a file was approved, and say what should happen next.
   *
   * The only side effect is the one status write, and it happens only when the
   * status genuinely needs to move.
   */
  async afterApproval(input: ContinuationInput): Promise<Continuation> {
    const read = await this.deps.store.read();
    if (read.status === 'missing') {
      return { kind: 'no_roadmap' };
    }
    if (read.status === 'unreadable') {
      return { kind: 'blocked', reason: read.reason };
    }
    if (read.roadmap.problems.length > 0 && read.roadmap.tasks.length === 0) {
      return {
        kind: 'blocked',
        reason: read.roadmap.problems.map((problem) => problem.message).join(' '),
      };
    }

    const roadmap = read.roadmap;
    const task = taskOwning(roadmap, input.relativePath);
    if (!task) {
      // A file written outside the plan. That is an ordinary thing to do, so it
      // is not an error — there is simply nothing in the roadmap to advance.
      return { kind: 'unlisted', relativePath: input.relativePath };
    }

    const approved = new Set(input.approvedPaths.map(normalise));
    approved.add(normalise(input.relativePath));

    const remainingFiles = task.files.map(normalise).filter((file) => !approved.has(file));
    const finished = remainingFiles.length === 0;

    // `verified` gates `done`; nothing else does. A task whose files are all
    // written but untested is in progress, however complete it looks.
    const targetStatus: RoadmapStatus = finished && input.verified ? 'done' : 'in_progress';
    let statusChanged = false;

    if (task.status !== targetStatus) {
      const written = await this.deps.store.setStatus(read.relativePath, task.id, targetStatus);
      if (!written) {
        // The roadmap is the record of what happened; a status that silently
        // failed to move makes every later decision wrong. Stop here rather than
        // hand back a next file the file on disk does not justify.
        return {
          kind: 'blocked',
          reason: `The roadmap could not be updated to mark "${task.id}" ${targetStatus}.`,
        };
      }
      statusChanged = true;
    }

    if (!finished) {
      return {
        kind: 'next_file',
        taskId: task.id,
        relativePath: remainingFiles[0]!,
        statusChanged,
      };
    }

    if (!input.verified) {
      // Every file is written and nothing is checked. Say so plainly: the next
      // step is verification, not another file, and the task does not get to be
      // `done` on the strength of an approval.
      this.deps.logger.info(
        `Task "${task.id}" is fully written but not verified; it stays in progress.`
      );
      return { kind: 'awaiting_verification', taskId: task.id };
    }

    // The task is done. Re-read so the selection sees the status just written
    // rather than the copy that still calls this task `in_progress`.
    const refreshed = await this.deps.store.read();
    if (refreshed.status === 'missing') {
      return { kind: 'blocked', reason: 'The roadmap disappeared while its status was written.' };
    }
    if (refreshed.status === 'unreadable') {
      return { kind: 'blocked', reason: refreshed.reason };
    }

    if (isComplete(refreshed.roadmap)) {
      return { kind: 'complete', approvedCount: approved.size };
    }

    const next = activeTask(refreshed.roadmap);
    if (!next) {
      return {
        kind: 'blocked',
        reason:
          'No task is available: every remaining task is waiting on a dependency that is not done.',
      };
    }
    if (next.id === task.id) {
      // We just marked this task done and it is still the active one, which can
      // only mean the file did not change the way we think it did.
      return {
        kind: 'blocked',
        reason: `"${task.id}" is still active after being marked done; the roadmap may have been edited.`,
      };
    }

    const firstFile = next.files[0];
    if (!firstFile) {
      return { kind: 'blocked', reason: `Task "${next.id}" lists no files to open.` };
    }
    return {
      kind: 'next_task',
      taskId: next.id,
      relativePath: firstFile,
      completedTaskId: task.id,
    };
  }

  /** The task the workflow should be working on, if a roadmap says. */
  async current(): Promise<{ taskId: string; relativePath: string | null } | null> {
    const read = await this.deps.store.read();
    if (read.status !== 'found') {
      return null;
    }
    const task = activeTask(read.roadmap);
    return task ? { taskId: task.id, relativePath: task.files[0] ?? null } : null;
  }

  /**
   * The roadmap as the workflow's prompt should see it.
   *
   * `null` when there is no roadmap, which lets the caller leave the prompt
   * exactly as it was rather than adding a paragraph about a file that is not
   * there.
   */
  async describeForPrompt(): Promise<string | null> {
    const read = await this.deps.store.read();
    if (read.status === 'missing') {
      return null;
    }
    if (read.status === 'unreadable') {
      return `The roadmap could not be read (${read.reason}). Work from the developer's instructions instead.`;
    }
    return renderForPrompt(read.roadmap, read.relativePath);
  }
}

/* -------------------------------------------------------------------------- */
/* Prompt rendering                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The roadmap, as text for the model.
 *
 * Written to be read by a model rather than by a person: file order is explicit,
 * the active task is marked, and blocked tasks say which dependency they wait on.
 * The whole roadmap is included because "what next" is the one question it is
 * there to answer, and a model given half of it will invent the other half.
 */
export function renderForPrompt(
  roadmap: Roadmap,
  relativePath: string,
  problems: readonly RoadmapProblem[] = roadmap.problems
): string {
  const lines: string[] = [`Roadmap (${relativePath}):`];
  const active = activeTask(roadmap);

  for (const task of roadmap.tasks) {
    const marker = active && task.id === active.id ? '  ← current task' : '';
    lines.push(`- ${task.id} [${task.status}] ${task.title}${marker}`);
    lines.push(`  files, in order: ${task.files.join(', ')}`);
    if (task.dependsOn.length > 0) {
      lines.push(`  depends on: ${task.dependsOn.join(', ')}`);
    }
    const note = firstLine(task.notes);
    if (note !== null) {
      lines.push(`  notes: ${note}`);
    }
  }

  if (problems.length > 0) {
    lines.push('');
    lines.push('Problems in this roadmap, which the work must not work around:');
    for (const problem of problems) {
      lines.push(`- ${problem.where}: ${problem.message}`);
    }
  }

  lines.push('');
  lines.push(
    'Work on exactly one file at a time, in the order above. Write the whole of that one file, with its explanation comments, and nothing else: do not start the next file in the same reply.'
  );

  return lines.join('\n');
}

function firstLine(text: string): string | null {
  const line = text.split('\n').find((entry) => entry.trim().length > 0)?.trim() ?? '';
  return line.length > 0 ? line : null;
}

function normalise(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim();
}

/** Re-exported so a caller can type a task without importing two modules. */
export type { RoadmapTask };

/**
 * ROADMAP.md — the file that says what to build next, and in what order.
 *
 * PairPilot writes one file at a time and the developer approves each one, so
 * something has to remember which file is next and why. That is this file, and
 * the shape of it is a deliberate constraint on what the workflow can do:
 *
 *  - **A task lists the files it owns.** Those are exactly the files PairPilot
 *    opens in the editor, and a path outside the workspace is refused wherever
 *    the task is read.
 *  - **A task lists the tasks it depends on.** The next task is the first
 *    `todo` task whose dependencies are all `done` — so progression is a
 *    property of the file, not of a cursor somebody has to advance by hand.
 *  - **Statuses are the ones the protocol already uses** (`todo`, `in_progress`,
 *    `done`). Reusing that vocabulary is what lets a `task_update` message and
 *    the roadmap file agree without a translation table.
 *  - **`done` is only written after verification.** The planner that writes
 *    this task's status is told, in so many words, that a task becomes `done`
 *    when its checks have passed and not when its file was approved. An
 *    approved file that has not been tested is `in_progress`.
 *
 * The parser is tolerant by design. A roadmap is hand-written before PairPilot
 * ever sees it, and refusing to move because one task has a typo would be the
 * wrong failure: the parser collects per-task problems and the selector simply
 * never offers a task whose declaration it could not read in full. Nothing is
 * guessed at — a malformed dependency is reported, not ignored.
 *
 * This module is deliberately import-free, so the whole of the selection logic
 * is testable without an editor.
 */

/** The only statuses a roadmap task may carry. */
export const ROADMAP_STATUSES = ['todo', 'in_progress', 'done'] as const;
export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number];

/** One task, as the file declares it. */
export interface RoadmapTask {
  /** Stable identity, from the `### id` heading and normalised to kebab-case. */
  readonly id: string;
  /** The heading's human-readable text, after the id. */
  readonly title: string;
  readonly status: RoadmapStatus;
  /** Workspace-relative paths this task owns, in the order it writes them. */
  readonly files: readonly string[];
  /** Tasks that must be `done` before this one may start. */
  readonly dependsOn: readonly string[];
  /** What the task is for, from the prose under the heading. */
  readonly notes: string;
}

/** A declaration the parser could not read, and what it would have been. */
export interface RoadmapProblem {
  /** A task id, or the line number when the heading itself was unreadable. */
  readonly where: string;
  readonly message: string;
}

export interface Roadmap {
  /** Tasks in file order, so "next" reads in the order the developer wrote. */
  readonly tasks: readonly RoadmapTask[];
  readonly problems: readonly RoadmapProblem[];
}

/** The statuses a task may be moved *out of*, and to, by the workflow. */
export interface TransitionRequest {
  readonly taskId: string;
  readonly to: RoadmapStatus;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Parse a roadmap document.
 *
 * The grammar is small on purpose — it has to be writable by a person:
 *
 *     ## <phase, ignored>
 *     ### task-id — Human title
 *     - status: todo
 *     - files: src/db.php, src/User.php
 *     - depends-on: schema
 *     Prose in any form becomes the task's notes.
 *
 * A `###` heading starts a task; everything after it until the next `###` or
 * `##` belongs to it. `- status:` may be omitted, and means `todo`: a task
 * somebody has written down has not been started.
 */
export function parseRoadmap(markdown: string): Roadmap {
  const lines = markdown.split(/\r?\n/);
  const tasks: RoadmapTask[] = [];
  const problems: RoadmapProblem[] = [];

  let current: MutableTask | null = null;
  /** Line the current task's heading was on, for problems reported after it. */
  let currentLine = 0;

  const finish = (): void => {
    if (!current) {
      return;
    }
    const task = completeTask(current, problems);
    if (task) {
      tasks.push(task);
    } else {
      problems.push({
        where: current.id || `line ${currentLine}`,
        message: 'This task declares no files, so it offers nothing PairPilot could open.',
      });
    }
    current = null;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const lineNumber = index + 1;

    if (/^###\s+/.test(line)) {
      finish();
      const heading = line.replace(/^###\s+/, '').trim();
      const { id, title } = splitHeading(heading);
      current = {
        id: normaliseId(id),
        title: title.length > 0 ? title : id,
        status: 'todo',
        files: [],
        dependsOn: [],
        notes: [],
      };
      currentLine = lineNumber;
      if (current.id.length === 0) {
        problems.push({
          where: `line ${lineNumber}`,
          message: `The heading "${heading}" has no task id, so dependencies cannot name it.`,
        });
      }
      continue;
    }

    if (/^##\s+/.test(line) && !line.startsWith('###')) {
      // A new phase ends the task above it. Phases are headings only; they
      // carry no semantics here, and nothing downstream looks for them.
      finish();
      continue;
    }

    if (!current) {
      continue;
    }

    const field = /^\s*[-*]\s*(status|files|depends-on|depends on|dependsOn)\s*:\s*(.*)$/i.exec(line);
    if (field) {
      const name = field[1]?.toLowerCase() ?? '';
      const value = field[2]?.trim() ?? '';
      if (name === 'status') {
        const status = readStatus(value);
        if (status === null) {
          problems.push({
            where: current.id || `line ${lineNumber}`,
            message: `"${value}" is not a status this workflow understands (${ROADMAP_STATUSES.join(', ')}).`,
          });
        } else {
          current.status = status;
        }
      } else if (name === 'files') {
        current.files.push(...splitList(value));
      } else {
        current.dependsOn.push(...splitList(value));
      }
      continue;
    }

    const prose = line.trim();
    if (prose.length > 0) {
      current.notes.push(prose);
    }
  }
  finish();

  // Cross-task checks, after every heading is known. Doing these per-task would
  // need the whole file, and reporting "depends on a task that does not exist"
  // is the single most useful thing this parser can say: it is the mistake that
  // makes a roadmap never progress, and it is invisible on the page.
  const known = new Set(tasks.map((task) => task.id));
  const checked: RoadmapTask[] = [];
  for (const task of tasks) {
    const missing = task.dependsOn.filter((dependency) => !known.has(dependency));
    if (missing.length > 0) {
      problems.push({
        where: task.id,
        message: `Depends on ${missing.map((id) => `"${id}"`).join(', ')}, which is not a task in this roadmap. This task will never become available.`,
      });
      // Kept, but the selector refuses it anyway because its dependencies can
      // never be done. Keeping it means the problem is visible alongside the
      // task rather than the task silently vanishing from the file.
    }
    checked.push(task);
  }

  if (tasks.length === 0) {
    problems.push({
      where: 'roadmap',
      message: 'No tasks were found. Tasks are `### task-id — Title` headings.',
    });
  }

  return { tasks: checked, problems };
}

interface MutableTask {
  id: string;
  title: string;
  status: RoadmapStatus;
  files: string[];
  dependsOn: string[];
  notes: string[];
}

function completeTask(task: MutableTask, problems: RoadmapProblem[]): RoadmapTask | null {
  // Paths are accepted as written and validated for containment by the caller:
  // this module has no workspace root to check against, and inventing one would
  // make the parser's answer depend on where it was run.
  const files = task.files
    .map((file) => file.trim())
    .filter((file) => file.length > 0)
    .map(stripBackticks);

  if (files.length === 0) {
    return null;
  }
  if (task.id.length === 0) {
    return null;
  }
  void problems;

  return {
    id: task.id,
    title: task.title,
    status: task.status,
    files,
    dependsOn: [...new Set(task.dependsOn.map((id) => normaliseId(stripBackticks(id))))].filter(
      (id) => id.length > 0
    ),
    notes: task.notes.join('\n'),
  };
}

/** `task-id — Title`, `task-id - Title`, `task-id: Title`, or a bare id. */
function splitHeading(heading: string): { id: string; title: string } {
  const split = /^([^\s—–:-]+)\s*(?:[—–:-]\s*(.*))?$/.exec(heading);
  if (!split) {
    return { id: heading, title: heading };
  }
  const id = split[1] ?? heading;
  const title = (split[2] ?? '').trim();
  return { id, title };
}

/** Lower-case kebab-case, so `Schema` and `schema` are one task. */
export function normaliseId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function readStatus(value: string): RoadmapStatus | null {
  // Strip only *wrapping* emphasis, never inner characters: an earlier version
  // removed every underscore, which turned the canonical `in_progress` into
  // `inprogress` and quietly reset every started task to `todo`.
  const normalised = value
    .trim()
    .toLowerCase()
    .replace(/^[`*_]+|[`*_]+$/g, '')
    .trim();
  if ((ROADMAP_STATUSES as readonly string[]).includes(normalised)) {
    return normalised as RoadmapStatus;
  }
  // The spellings people reach for when writing the file by hand.
  if (
    normalised === 'in-progress' ||
    normalised === 'in progress' ||
    normalised === 'inprogress' ||
    normalised === 'started'
  ) {
    return 'in_progress';
  }
  if (normalised === 'complete' || normalised === 'completed') {
    return 'done';
  }
  return null;
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function stripBackticks(value: string): string {
  return value.replace(/^`|`$/g, '').trim();
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Why a particular task is not the next one.
 *
 * Named cases, so the roadmap's own report can say "schema is not done yet"
 * rather than leaving the developer to compare two headings by eye.
 */
export type TaskAvailability =
  | { available: true }
  | { available: false; reason: 'done' | 'in_progress' | 'blocked' | 'unknown_dependency'; detail: string };

/** Whether one task may be started now. */
export function availability(task: RoadmapTask, roadmap: Roadmap): TaskAvailability {
  if (task.status === 'done') {
    return { available: false, reason: 'done', detail: 'Already done.' };
  }
  if (task.status === 'in_progress') {
    return {
      available: false,
      reason: 'in_progress',
      detail: 'Marked in progress; finish it before starting another.',
    };
  }
  const byId = new Map(roadmap.tasks.map((entry) => [entry.id, entry]));
  for (const dependency of task.dependsOn) {
    const target = byId.get(dependency);
    if (!target) {
      return {
        available: false,
        reason: 'unknown_dependency',
        detail: `Depends on "${dependency}", which is not in the roadmap.`,
      };
    }
    if (target.status !== 'done') {
      return {
        available: false,
        reason: 'blocked',
        detail: `Waiting for "${dependency}" (${target.status}).`,
      };
    }
  }
  return { available: true };
}

/**
 * The next task to work on, in file order.
 *
 * File order rather than a topological one: the roadmap's order is the
 * developer's stated preference, the dependencies are the constraint, and when
 * both are satisfied early-but-equal the earlier task should win. A topological
 * sort would silently reorder a roadmap that was already in a sensible order.
 *
 * A task already `in_progress` is returned by `currentTask` rather than here, so
 * "start the next one" can never skip past work that was begun.
 */
export function nextTask(roadmap: Roadmap): RoadmapTask | null {
  for (const task of roadmap.tasks) {
    const state = availability(task, roadmap);
    if (state.available) {
      return task;
    }
  }
  return null;
}

/** The task already begun, if there is one. */
export function currentTask(roadmap: Roadmap): RoadmapTask | null {
  return roadmap.tasks.find((task) => task.status === 'in_progress') ?? null;
}

/**
 * What the workflow should work on: the begun task, else the next available one.
 *
 * One function for both, because two callers choosing differently is exactly how
 * a task gets started twice.
 */
export function activeTask(roadmap: Roadmap): RoadmapTask | null {
  return currentTask(roadmap) ?? nextTask(roadmap);
}

/** True when every task is done. */
export function isComplete(roadmap: Roadmap): boolean {
  return roadmap.tasks.length > 0 && roadmap.tasks.every((task) => task.status === 'done');
}

/**
 * The task one file belongs to, if any.
 *
 * Used when the developer opens a file by hand: the review continuation needs
 * to know whether that file is part of the plan in flight.
 */
export function taskOwning(roadmap: Roadmap, relativePath: string): RoadmapTask | null {
  const target = normalisePath(relativePath);
  return (
    roadmap.tasks.find((task) => task.files.some((file) => normalisePath(file) === target)) ?? null
  );
}

function normalisePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim();
}

/* -------------------------------------------------------------------------- */
/* The file's own shape                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The status marker a task's `- status:` line carries.
 *
 * The planner edits the file by replacing this line, so the exact spelling is
 * part of the contract between the parser and the writer.
 */
export function statusLine(status: RoadmapStatus): string {
  return `- status: ${status}`;
}

/** The heading text for a task, matching what `parseRoadmap` accepts. */
export function headingFor(task: RoadmapTask): string {
  return task.title && task.title !== task.id ? `### ${task.id} — ${task.title}` : `### ${task.id}`;
}

/**
 * The file's text with one task's status changed.
 *
 * A pure string edit, so the change is reviewable as a diff in the editor like
 * any other — the alternative, parsing and re-serialising the document, would
 * reformat the developer's prose every time a status moved.
 *
 * Returns `null` when the task cannot be found, rather than writing a file that
 * looks updated and is not.
 */
export function withStatus(markdown: string, taskId: string, status: RoadmapStatus): string | null {
  const target = normaliseId(taskId);
  const lines = markdown.split(/\r?\n/);
  let inTarget = false;
  let headingSeen = false;
  let statusWritten = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';

    if (/^###\s+/.test(line)) {
      const heading = splitHeading(line.replace(/^###\s+/, '').trim());
      inTarget = normaliseId(heading.id) === target;
      headingSeen = headingSeen || inTarget;
      continue;
    }
    if (/^##\s+/.test(line) && !line.startsWith('###')) {
      inTarget = false;
      continue;
    }
    if (!inTarget) {
      continue;
    }

    if (/^\s*[-*]\s*status\s*:/i.test(line)) {
      const indent = (line.match(/^\s*/) ?? [''])[0];
      lines[index] = `${indent}${statusLine(status)}`;
      statusWritten = true;
    }
  }

  if (!headingSeen) {
    return null;
  }
  if (!statusWritten) {
    // The task had no status line: insert one directly under its heading, so
    // the file gains the status rather than silently keeping the old meaning.
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? '';
      if (/^###\s+/.test(line)) {
        const heading = splitHeading(line.replace(/^###\s+/, '').trim());
        if (normaliseId(heading.id) === target) {
          lines.splice(index + 1, 0, statusLine(status));
          break;
        }
      }
    }
  }
  return lines.join('\n');
}

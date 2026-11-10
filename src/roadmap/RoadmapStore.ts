/**
 * RoadmapStore — the roadmap document on disk, read and edited through real
 * `WorkspaceEdit`s.
 *
 * The rules of the approval flow apply to this file exactly as they apply to
 * any other: it lives inside the workspace or it is refused, it is never
 * written without a `WorkspaceEdit` (so Ctrl+Z works and the change is a diff
 * like any other), and a write never touches a task's text apart from the one
 * `status:` line it moves.
 *
 * Two deliberate narrowing choices:
 *
 *  - **A status change re-reads the file first.** The document may have been
 *    edited in the editor since the planner read it. Editing the on-disk text
 *    from a stale read would revert whatever the developer typed in between,
 *    which is the "overwrite unrelated user changes" failure in miniature.
 *  - **A missing roadmap is not an error.** A project that has not planned yet
 *    has no file, and PairPilot says so rather than creating one: writing a
 *    roadmap the developer did not ask for is the same class of mistake as
 *    writing code they did not approve.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { describeError } from '../core/errors';
import { parseRoadmap, withStatus, type Roadmap, type RoadmapStatus } from './Roadmap';
import type { PathGuard } from '../security/PathGuard';
import type { Logger } from '../types';

/** Where a roadmap is looked for, in order. */
export const ROADMAP_CANDIDATES = ['ROADMAP.md', 'docs/ROADMAP.md', '.pairpilot/ROADMAP.md'] as const;

export interface RoadmapSnapshot {
  /** Workspace-relative path of the roadmap, once one was found. */
  readonly relativePath: string;
  readonly roadmap: Roadmap;
}

export type RoadmapReadResult =
  | ({ status: 'found' } & RoadmapSnapshot)
  | { status: 'missing'; searched: readonly string[] }
  | { status: 'unreadable'; relativePath: string; reason: string };

export class RoadmapStore {
  constructor(
    private readonly deps: {
      guard(): PathGuard | null;
      workspaceRoot(): string | null;
      logger: Logger;
      /** Lets the workspace picker reopened when a roadmap is found later. */
      onChanged?(): void;
    }
  ) {}

  /**
   * Locate and read the roadmap.
   *
   * Every candidate is checked through the `PathGuard` before it is read, so a
   * symlinked `ROADMAP.md` pointing outside the workspace cannot turn this into
   * a read of an arbitrary file.
   */
  async read(): Promise<RoadmapReadResult> {
    const root = this.deps.workspaceRoot();
    const guard = this.deps.guard();
    if (!root || !guard) {
      return { status: 'unreadable', relativePath: '', reason: 'No workspace folder is open.' };
    }

    const searched: string[] = [];
    for (const candidate of ROADMAP_CANDIDATES) {
      searched.push(candidate);
      const absolute = path.join(root, candidate);
      if (!fs.existsSync(absolute)) {
        continue;
      }
      try {
        // A roadmap is an ordinary project file; a *sensitive* verdict here
        // (somebody named it `.env`) is still refused for reading, because this
        // is a convenience read rather than a developer-approved one.
        const assessment = guard.assess(candidate);
        if (assessment.verdict !== 'allow') {
          return {
            status: 'unreadable',
            relativePath: candidate,
            reason: assessment.reason,
          };
        }
        const text = fs.readFileSync(absolute, 'utf8');
        return { status: 'found', relativePath: candidate, roadmap: parseRoadmap(text) };
      } catch (error) {
        return {
          status: 'unreadable',
          relativePath: candidate,
          reason: describeError(error),
        };
      }
    }

    return { status: 'missing', searched };
  }

  /**
   * Move one task's status, writing the file as an editor edit.
   *
   * Returns whether anything was written. Every refusal is a logged, named
   * reason: the caller is a planner, and "the status did not move" with no
   * explanation is indistinguishable from a bug.
   */
  async setStatus(relativePath: string, taskId: string, status: RoadmapStatus): Promise<boolean> {
    const root = this.deps.workspaceRoot();
    const guard = this.deps.guard();
    if (!root || !guard) {
      this.deps.logger.warn('Cannot update the roadmap: no workspace folder is open.');
      return false;
    }

    let document: vscode.TextDocument;
    try {
      const assessment = guard.resolveForWrite(relativePath);
      if (assessment.verdict !== 'allow') {
        this.deps.logger.warn(`The roadmap at "${relativePath}" is not writable: ${assessment.reason}`);
        return false;
      }
      document = await vscode.workspace.openTextDocument(vscode.Uri.file(assessment.absolutePath));
    } catch (error) {
      this.deps.logger.warn(
        `Could not open the roadmap "${relativePath}" for update: ${describeError(error)}`
      );
      return false;
    }

    // Read the document it will be written from, not the copy on disk: the two
    // differ exactly when the developer has unsaved edits, and this edit must
    // sit on top of theirs rather than replace them.
    const current = document.getText();
    const updated = withStatus(current, taskId, status);
    if (updated === null) {
      this.deps.logger.warn(`The roadmap has no task "${taskId}", so its status was not changed.`);
      return false;
    }
    if (updated === current) {
      return true;
    }

    const edit = new vscode.WorkspaceEdit();
    const full = new vscode.Range(document.positionAt(0), document.positionAt(current.length));
    edit.replace(document.uri, full, updated);

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      this.deps.logger.warn(`The editor refused the roadmap update to "${relativePath}".`);
      return false;
    }
    if (document.isDirty) {
      await document.save();
    }
    this.deps.logger.info(`Roadmap: ${taskId} is now ${status}.`);
    this.deps.onChanged?.();
    return true;
  }

  /** True when the path is the roadmap the workflow would use. */
  static isRoadmapPath(relativePath: string): boolean {
    const normalised = relativePath.replace(/\\/g, '/').toLowerCase();
    return (ROADMAP_CANDIDATES as readonly string[]).some(
      (candidate) => candidate.toLowerCase() === normalised
    ) || normalised.endsWith('/roadmap.md');
  }
}

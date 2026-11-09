/**
 * WorkspaceContext — assembles the minimum relevant context for one AI request.
 *
 * Spec section 6: inspect the workspace, support reading selected files and the
 * active editor, and never send the whole workspace automatically. Spec section
 * 12 adds: avoid sending duplicate context; prefer summaries over full history.
 *
 * This module owns the *policy* of what to include; `FileReader` owns the
 * mechanics of reading it and `PathGuard` owns the security verdicts. The
 * context built here is deliberately bounded in three independent ways — file
 * count, per-file bytes, and total characters — because any single limit can be
 * defeated by an unusual workspace.
 *
 * The AI cannot read files itself (tool use is disabled so it cannot write
 * files either), so everything the model knows about the project arrives through
 * this module. That makes the budget here the real context window.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { FileReader } from './FileReader';
import { PathGuard, EXCLUDED_DIR_NAMES, toPosix } from '../security/PathGuard';

export interface ContextBudget {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalChars: number;
  treeDepth: number;
  includeTree: boolean;
}

export interface ContextFile {
  relativePath: string;
  content: string;
  truncated: boolean;
  sensitive: boolean;
}

export interface AssembledContext {
  files: ContextFile[];
  treeSummary: string | undefined;
  activeFile: string | undefined;
  /** Files whose content was skipped, with the reason, for the UI. */
  skipped: { relativePath: string; reason: string }[];
  /** True when the budget stopped us including more files. */
  budgetExhausted: boolean;
}

export interface WorkspaceContextDeps {
  logger: { info(m: string): void; warn(m: string): void; error(m: string, e?: unknown): void };
  /** Called when a sensitive file needs a decision; resolves to approval. */
  requestSensitiveApproval(relativePath: string, reason: string): Promise<boolean>;
}

export class WorkspaceContext {
  private readonly guard: PathGuard;
  private readonly reader: FileReader;

  constructor(
    private readonly root: string,
    guardOptions: { allowSensitiveFiles: boolean },
    private readonly deps: WorkspaceContextDeps
  ) {
    this.guard = new PathGuard(root, guardOptions);
    this.reader = new FileReader(this.guard);
  }

  get pathGuard(): PathGuard {
    return this.guard;
  }

  get workspaceRoot(): string {
    return this.root;
  }

  /** Display name of the open project. */
  get projectName(): string {
    return path.basename(this.root) || this.root;
  }

  /**
   * Assemble context for one request.
   *
   * @param pinned  Workspace-relative paths the developer explicitly added.
   * @param budget  Limits from configuration.
   */
  async assemble(pinned: string[], budget: ContextBudget): Promise<AssembledContext> {
    const result: AssembledContext = {
      files: [],
      treeSummary: undefined,
      activeFile: undefined,
      skipped: [],
      budgetExhausted: false,
    };

    if (budget.includeTree) {
      result.treeSummary = await this.buildTreeSummary(budget.treeDepth);
    }

    const activeFile = this.getActiveEditorPath();
    if (activeFile) {
      result.activeFile = activeFile;
    }

    // De-duplicate, and let the active editor win its slot first because it is
    // the file the developer is looking at.
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const candidate of [activeFile, ...pinned]) {
      if (!candidate) {
        continue;
      }
      const key = candidate;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      ordered.push(candidate);
    }

    let totalChars = 0;

    for (const relativePath of ordered) {
      if (result.files.length >= budget.maxFiles) {
        result.budgetExhausted = true;
        result.skipped.push({
          relativePath,
          reason: `Context file limit reached (${budget.maxFiles}).`,
        });
        continue;
      }

      const assessment = this.reader.assess(relativePath);
      let approvedSensitive = false;

      if (assessment.verdict === 'blocked' || assessment.verdict === 'excluded') {
        result.skipped.push({ relativePath, reason: assessment.reason });
        continue;
      }

      if (assessment.verdict === 'sensitive') {
        // Spec section 6: ask before accessing excluded/sensitive files.
        approvedSensitive = await this.deps.requestSensitiveApproval(
          relativePath,
          assessment.reason
        );
        if (!approvedSensitive) {
          result.skipped.push({
            relativePath,
            reason: 'You did not approve reading this sensitive file.',
          });
          continue;
        }
      }

      const outcome = this.reader.read(relativePath, {
        maxBytes: budget.maxFileBytes,
        approvedSensitive,
      });

      if (!outcome.ok) {
        result.skipped.push({ relativePath, reason: outcome.reason });
        continue;
      }

      // Enforce the total-character budget with headroom for the wrapping
      // markdown, so the final prompt cannot exceed the intended size.
      const remaining = budget.maxTotalChars - totalChars;
      if (remaining <= 200) {
        result.budgetExhausted = true;
        result.skipped.push({
          relativePath,
          reason: `Total context budget of ${budget.maxTotalChars} characters is exhausted.`,
        });
        continue;
      }
      let content = outcome.value.content;
      let truncated = outcome.value.truncated;
      if (content.length > remaining) {
        content = `${content.slice(0, remaining)}\n\n/* ... PairPilot truncated this file to fit the context budget ... */`;
        truncated = true;
        result.budgetExhausted = true;
      }
      totalChars += content.length;

      result.files.push({
        relativePath: outcome.value.relativePath,
        content,
        truncated,
        sensitive: approvedSensitive,
      });
    }

    return result;
  }

  /**
   * The active editor's workspace-relative path, or undefined when the active
   * editor is outside the workspace, is a diff view, or is untitled.
   */
  getActiveEditorPath(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }
    return this.toRelative(editor.document.uri);
  }

  /** Convert a Uri to a workspace-relative POSIX path, or undefined if outside. */
  toRelative(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    const relative = path.relative(this.root, uri.fsPath);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      return undefined;
    }
    return toPosix(relative);
  }

  /**
   * A shallow, names-only tree summary.
   *
   * Names only — never contents. This gives the model the project's shape for a
   * few hundred tokens instead of hundreds of kilobytes.
   */
  async buildTreeSummary(depth: number): Promise<string | undefined> {
    if (depth <= 0) {
      return undefined;
    }
    const excludeGlob = `**/{${EXCLUDED_DIR_NAMES.join(',')}}/**`;
    let uris: vscode.Uri[];
    try {
      uris = await vscode.workspace.findFiles('**/*', excludeGlob, 4000);
    } catch (error) {
      this.deps.logger.warn(
        `Could not build the workspace tree: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return undefined;
    }

    const lines: string[] = [];
    let omitted = 0;

    for (const uri of uris) {
      const relative = this.toRelative(uri);
      if (!relative) {
        continue;
      }
      const segments = relative.split('/');
      if (segments.length > depth) {
        continue;
      }
      // Hide sensitive and blocked files from the tree entirely, so the model
      // cannot even learn that a `.env` exists.
      const verdict = this.guard.assess(relative).verdict;
      if (verdict !== 'allow') {
        omitted++;
        continue;
      }
      lines.push(relative);
      if (lines.length >= 400) {
        omitted += uris.length - lines.length;
        break;
      }
    }

    if (lines.length === 0) {
      return undefined;
    }
    lines.sort();
    const suffix =
      omitted > 0 ? `\n... and ${omitted} more files not shown (depth limit ${depth})` : '';
    return `${lines.join('\n')}${suffix}`;
  }

  /**
   * Resolve a set of candidate paths the developer picked, reporting which were
   * refused and why. Used by the "Add file to context" flow.
   */
  classifyCandidates(candidates: string[]): {
    accepted: string[];
    rejected: { relativePath: string; reason: string; approvable: boolean }[];
  } {
    const accepted: string[] = [];
    const rejected: { relativePath: string; reason: string; approvable: boolean }[] = [];
    for (const candidate of candidates) {
      const assessment = this.reader.assess(candidate);
      if (assessment.verdict === 'blocked' || assessment.verdict === 'excluded') {
        rejected.push({
          relativePath: assessment.relativePath,
          reason: assessment.reason,
          approvable: false,
        });
      } else {
        accepted.push(assessment.relativePath);
      }
    }
    return { accepted, rejected };
  }
}

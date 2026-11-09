/**
 * DiffManager — shows an update proposal as a real diff before it is applied.
 *
 * Spec section 8 describes progressive writing for a new file. An `update` is a
 * different risk: writing directly into a file that already has content can
 * destroy work, and the developer can only judge the change if they can see it
 * against the original.
 *
 * So updates take the safe route: nothing on disk changes until the developer
 * has seen a diff and approved it. The candidate content is offered to VS Code's
 * diff editor using a virtual document, which means no temporary file is written
 * anywhere — not into the workspace, not into the OS temp directory.
 */

import * as vscode from 'vscode';
import type { PathGuard } from '../security/PathGuard';
import type { Logger } from '../types';

const SCHEME = 'pairpilot-proposal';

export interface DiffPreviewResult {
  /** True when the developer accepted the change. */
  accepted: boolean;
  reason?: string;
}

export class DiffManager {
  /** Backing store for the virtual documents shown in the diff editor. */
  private readonly contents = new Map<string, string>();

  constructor(
    /**
     * Resolver for the current PathGuard. A resolver rather than a value, because
     * the developer can change workspace folders while the window is open and a
     * captured guard would then validate paths against the wrong root.
     */
    private readonly resolveGuard: () => PathGuard | null,
    private readonly logger: Logger
  ) {}

  /** The current guard, or a thrown error explaining why there is none. */
  private requireGuard(): PathGuard {
    const guard = this.resolveGuard();
    if (!guard) {
      throw new Error('PairPilot needs an open local folder to do that.');
    }
    return guard;
  }

  /**
   * Register the virtual document provider.
   *
   * Must be called during activation and the returned disposable pushed onto
   * `context.subscriptions`.
   */
  register(): vscode.Disposable {
    const provider: vscode.TextDocumentContentProvider = {
      provideTextDocumentContent: (uri: vscode.Uri): string => {
        return this.contents.get(uri.toString()) ?? '';
      },
    };
    return vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider);
  }

  /**
   * Show the proposed content against the current file.
   *
   * @param parallelUri Optional explicit document to diff against. Defaults to
   *   the file on disk at `relativePath`.
   */
  async showDiff(
    relativePath: string,
    proposedContent: string,
    options: { title?: string; baseContent?: string } = {}
  ): Promise<void> {
    const assessment = this.requireGuard().assess(relativePath);
    const originalUri = vscode.Uri.file(assessment.absolutePath);

    // The proposed side is a virtual document, so the diff is readable without
    // writing anything to disk.
    const proposedUri = vscode.Uri.from({
      scheme: SCHEME,
      path: `/${relativePath}`,
      query: `t=${Date.now()}`,
    });
    this.contents.set(proposedUri.toString(), proposedContent);

    const title = options.title ?? `PairPilot proposal: ${relativePath}`;
    await vscode.commands.executeCommand('vscode.diff', originalUri, proposedUri, title, {
      preview: false,
    });
  }

  /**
   * Show the diff and ask for a decision.
   *
   * Returns whether the developer accepted. The decision is intentionally made
   * *on top of the diff* so it cannot be given without the change being visible.
   */
  async confirmDiff(
    relativePath: string,
    proposedContent: string,
    summary: string
  ): Promise<DiffPreviewResult> {
    await this.showDiff(relativePath, proposedContent);

    const APPLY = 'Apply change';
    const CANCEL = 'Cancel';
    const choice = await vscode.window.showInformationMessage(
      `Apply the proposed change to ${relativePath}? ${summary}`,
      { modal: true },
      APPLY,
      CANCEL
    );
    if (choice !== APPLY) {
      return { accepted: false, reason: 'The developer did not apply the change.' };
    }
    return { accepted: true };
  }

  /**
   * Write approved content to disk inside a `WorkspaceEdit`, so it lands on the
   * developer's undo stack like any other edit.
   */
  async applyApprovedContent(relativePath: string, content: string): Promise<string> {
    // Re-verify through symlinks at the last possible moment.
    const assessment = this.requireGuard().assertRealPathInsideWorkspace(relativePath);
    const uri = vscode.Uri.file(assessment.absolutePath);

    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch (error) {
      throw new Error(
        `Could not open "${relativePath}" to apply the change: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    const edit = new vscode.WorkspaceEdit();
    const full = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length)
    );
    edit.replace(uri, full, content);

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      throw new Error(
        `The editor refused the change to "${relativePath}". The file may be read-only.`
      );
    }
    await document.save();
    this.logger.info(`Applied an approved change to ${relativePath}.`);
    return document.getText();
  }

  /** Release the virtual content for a path once it is no longer needed. */
  release(relativePath: string): void {
    for (const key of [...this.contents.keys()]) {
      if (key.includes(relativePath)) {
        this.contents.delete(key);
      }
    }
  }

  dispose(): void {
    this.contents.clear();
  }
}

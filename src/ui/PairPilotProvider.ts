/**
 * PairPilotProvider — renders the sidebar Webview and pushes state into it.
 *
 * Security properties this class is responsible for:
 *
 *  - A strict CSP with a per-load nonce, so nothing in the panel can execute
 *    remotely or inline. AI output containing markup or a `javascript:` URL
 *    therefore cannot run.
 *  - `localResourceRoots` is restricted to the extension's own `media` folder,
 *    so the panel cannot read arbitrary files from disk through a crafted URI.
 *  - Only two asset URIs are ever exposed. No workspace path and no credential
 *    is passed into the panel.
 *  - `retainContextWhenHidden` is false: the panel is re-rendered from the
 *    snapshot on every reveal, which means the UI can never hold a stale copy of
 *    an approval and act on it.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { toProposalRecord } from '../proposals/ApprovalManager';
import type { Orchestrator } from '../core/Orchestrator';
import type { SessionStore } from '../storage/SessionStore';
import type { ClaudeCodeRuntime } from '../runtime/ClaudeCodeRuntime';
import type { WorkspaceContext } from '../context/WorkspaceContext';
import {
  PairPilotState,
  type HostMessage,
  type WebviewStateSnapshot,
} from '../types';

export class PairPilotProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'pairpilot.sidebarView';

  private view: vscode.WebviewView | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: {
      orchestrator: Orchestrator;
      store: SessionStore;
      runtime: ClaudeCodeRuntime;
      workspace: WorkspaceContext | (() => WorkspaceContext | null);
      logger: { info(m: string): void; warn(m: string): void; error(m: string, e?: unknown): void };
      onMessage(raw: unknown): void | Promise<void>;
    }
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      // Only the extension's own media directory is reachable from the panel.
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };

    view.webview.html = this.buildHtml(view.webview);

    view.webview.onDidReceiveMessage((raw) => {
      void this.deps.onMessage(raw);
    });

    view.onDidDispose(() => {
      this.view = null;
    });

    // Push an initial snapshot so the panel is never blank.
    this.refresh();
  }

  /** Push a fresh snapshot to the panel, if it is open. */
  refresh(): void {
    if (!this.view) {
      return;
    }
    try {
      const snapshot = this.buildSnapshot();
      this.post({ type: 'state', snapshot });
    } catch (error) {
      this.deps.logger.error('Could not build the PairPilot UI snapshot.', error);
    }
  }

  postTextDelta(text: string): void {
    this.post({ type: 'textDelta', text });
  }

  postCodeDelta(blockIndex: number, text: string): void {
    this.post({ type: 'codeDelta', blockIndex, text });
  }

  postWritingProgress(written: number, total: number, relativePath: string): void {
    this.post({ type: 'writingProgress', written, total, relativePath });
  }

  /** Focus the panel if it is open. */
  async reveal(): Promise<void> {
    if (this.view) {
      this.view.show?.(true);
      return;
    }
    await vscode.commands.executeCommand(`${PairPilotProvider.viewType}.focus`);
  }

  get isOpen(): boolean {
    return this.view !== null;
  }

  /* ---------------------------------------------------------------------- */

  private post(message: HostMessage): void {
    if (!this.view) {
      return;
    }
    // `postMessage` resolves to false when the panel is gone; that is not an
    // error worth surfacing, since the state is rebuilt on next reveal.
    void this.view.webview.postMessage(message);
  }

  /** Assemble everything the panel renders. */
  buildSnapshot(): WebviewStateSnapshot {
    const orchestrator = this.deps.orchestrator;
    const session = this.deps.store.getActive();
    const workspace = this.resolveWorkspace();

    const pending = orchestrator.approvals.getPending();
    const activeProposal = orchestrator.activeProposalValue ?? (pending ? toProposalRecord(pending) : null);

    const state = orchestrator.machine.state;

    return {
      state,
      projectName: workspace ? workspace.projectName : 'No folder',
      workspaceName: workspace ? workspace.workspaceRoot : '',
      runtime: this.deps.runtime.getStatus(),
      sessionId: session?.id ?? null,
      runtimeSessionId: session?.runtimeSessionId ?? null,
      messages: session?.messages ?? [],
      streamingText: orchestrator.streamingTextValue,
      streamingCode: orchestrator.streamingCodeValue,
      isStreaming: orchestrator.isStreaming,
      currentTask: orchestrator.currentTaskValue,
      currentStep: orchestrator.currentStepValue,
      pendingApproval:
        state === PairPilotState.WAITING_FILE_APPROVAL ||
        state === PairPilotState.WAITING_CODE_APPROVAL,
      pendingFilePath: orchestrator.pendingFilePathValue,
      pendingFileOperation: orchestrator.pendingFileOperationValue,
      activeProposal,
      usage: session?.usage ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: null,
        available: false,
      },
      pinnedContext: orchestrator.pinnedContextValue,
      lastContextFiles: orchestrator.lastContextFilesValue,
      recommendation: orchestrator.recommendationValue,
      sessions: this.deps.store.list(),
      error: orchestrator.errorValue,
      notice: orchestrator.noticeValue,
    };
  }

  private resolveWorkspace(): WorkspaceContext | null {
    const candidate = this.deps.workspace;
    return typeof candidate === 'function' ? candidate() : candidate;
  }

  /**
   * Build the panel HTML.
   *
   * The asset files are read from `media/` (populated by the build step) and
   * referenced through `asWebviewUri`, which is the only way the CSP will allow
   * them.
   */
  private buildHtml(webview: vscode.Webview): string {
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    const nonce = crypto.randomBytes(16).toString('base64');

    const templatePath = vscode.Uri.joinPath(mediaRoot, 'index.html');
    let html = readTemplate(templatePath);

    if (html === null) {
      return this.buildMissingAssetsHtml(nonce);
    }

    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'style.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.js'));

    // Simple, non-regex replacement: the placeholders are unique and fixed.
    return html
      .split('{{cspSource}}').join(webview.cspSource)
      .split('{{nonce}}').join(nonce)
      .split('{{styleUri}}').join(styleUri.toString())
      .split('{{scriptUri}}').join(scriptUri.toString());
  }

  /** Shown if the build step did not copy the Webview assets. */
  private buildMissingAssetsHtml(nonce: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';" />
<title>PairPilot</title>
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; line-height: 1.5; }
code { font-family: var(--vscode-editor-font-family); }
</style>
</head>
<body>
<h3>PairPilot assets are missing</h3>
<p>The Webview files were not copied into <code>media/</code>. Run the build:</p>
<p><code>npm run compile</code></p>
<p>If you are running from source, reload the window afterwards.</p>
</body>
</html>`;
  }
}

/** Read a template, returning null when it is absent rather than throwing. */
function readTemplate(uri: vscode.Uri): string | null {
  try {
    return fs.readFileSync(uri.fsPath, 'utf8');
  } catch {
    return null;
  }
}

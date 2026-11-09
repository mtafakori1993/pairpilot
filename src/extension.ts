/**
 * PairPilot extension entry point.
 *
 * Activation order is deliberate:
 *
 *   1. Create the output channel first, so every later step can log.
 *   2. Detect the runtime and start building the workspace context.
 *   3. Construct the storage, orchestrator and UI, then register the view
 *      provider and commands.
 *
 * The workspace context is held in a mutable box rather than a constant, because
 * the developer can change folders while the window is open. Every consumer reads
 * it through a getter, so the panel and the orchestrator always see the current
 * project instead of a stale root — which would be a path-containment bug.
 */

import * as vscode from 'vscode';
import { Orchestrator, type OrchestratorConfig } from './core/Orchestrator';
import { ClaudeCodeRuntime } from './runtime/ClaudeCodeRuntime';
import { WorkspaceContext } from './context/WorkspaceContext';
import { SessionStore } from './storage/SessionStore';
import { DiffManager } from './editor/DiffManager';
import { MessageValidator } from './security/MessageValidator';
import { PairPilotProvider } from './ui/PairPilotProvider';
import { WebviewMessageRouter } from './ui/WebviewMessageRouter';
import { registerCommands } from './commands';

/** Mutable holder so a folder change is picked up without re-activating. */
class WorkspaceHolder {
  private context: WorkspaceContext | null = null;

  constructor(private readonly logger: { info(m: string): void; warn(m: string): void; error(m: string, e?: unknown): void }) {}

  /** Rebuild the context from the current workspace folder. */
  refresh(): WorkspaceContext | null {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.context = null;
      return null;
    }
    // Only `file:` folders can be guarded by path containment.
    if (folder.uri.scheme !== 'file') {
      this.context = null;
      this.logger.warn(
        `PairPilot does not support the "${folder.uri.scheme}" scheme. Open a local folder instead.`
      );
      return null;
    }

    try {
      this.context = new WorkspaceContext(
        folder.uri.fsPath,
        { allowSensitiveFiles: readConfiguration().allowSensitiveFileContext },
        {
          logger: this.logger,
          requestSensitiveApproval: (relativePath, reason) =>
            requestSensitiveFileApproval(relativePath, reason),
        }
      );
      return this.context;
    } catch (error) {
      this.context = null;
      this.logger.error('Could not initialise the workspace context.', error);
      return null;
    }
  }

  get(): WorkspaceContext | null {
    return this.context ?? this.refresh();
  }
}

/** The only place configuration is read, so the shape stays consistent. */
function readConfiguration(): {
  bare: boolean;
  timeoutMs: number;
  extraArgs: string[];
  maxFiles: number;
  maxFileBytes: number;
  maxTotalChars: number;
  treeDepth: number;
  includeTree: boolean;
  requireSensitiveApproval: boolean;
  allowSensitiveFileContext: boolean;
  advisorEnabled: boolean;
  advisorUseAI: boolean;
  maxSessions: number;
  claudePath: string;
} {
  const config = vscode.workspace.getConfiguration('pairpilot');
  return {
    claudePath: config.get<string>('runtime.claudePath', ''),
    bare: config.get<boolean>('runtime.useBareMode', true),
    timeoutMs: Math.max(10_000, config.get<number>('runtime.timeoutMs', 300_000)),
    extraArgs: config.get<string[]>('runtime.extraArgs', []),
    maxFiles: config.get<number>('context.maxFiles', 12),
    maxFileBytes: config.get<number>('context.maxFileBytes', 65_536),
    maxTotalChars: config.get<number>('context.maxTotalChars', 120_000),
    treeDepth: config.get<number>('context.treeDepth', 3),
    includeTree: config.get<boolean>('context.includeTree', true),
    requireSensitiveApproval: config.get<boolean>('safety.requireSensitiveFileApproval', true),
    allowSensitiveFileContext: config.get<boolean>('safety.allowSensitiveFileContext', false),
    advisorEnabled: config.get<boolean>('advisor.enabled', true),
    advisorUseAI: config.get<boolean>('advisor.useAI', true),
    maxSessions: config.get<number>('session.maxHistory', 50),
  };
}

function toOrchestratorConfig(): OrchestratorConfig {
  const config = readConfiguration();
  return {
    bare: config.bare,
    timeoutMs: config.timeoutMs,
    extraArgs: config.extraArgs,
    budget: {
      maxFiles: config.maxFiles,
      maxFileBytes: config.maxFileBytes,
      maxTotalChars: config.maxTotalChars,
      treeDepth: config.treeDepth,
      includeTree: config.includeTree,
    },
    requireSensitiveApproval: config.requireSensitiveApproval,
    allowSensitiveFileContext: config.allowSensitiveFileContext,
    advisorEnabled: config.advisorEnabled,
    advisorUseAI: config.advisorUseAI,
  };
}

/** Ask before reading a sensitive file. Refuses when the feature is disabled. */
async function requestSensitiveFileApproval(
  relativePath: string,
  reason: string
): Promise<boolean> {
  const config = readConfiguration();
  if (!config.allowSensitiveFileContext) {
    void vscode.window.showWarningMessage(
      `PairPilot skipped "${relativePath}": ${reason} Enable "pairpilot.safety.allowSensitiveFileContext" to be asked about sensitive files.`
    );
    return false;
  }

  const ALLOW = 'Send to the AI';
  const SKIP = 'Skip this file';
  const choice = await vscode.window.showWarningMessage(
    `Send "${relativePath}" to the AI as context? ${reason}`,
    { modal: true },
    ALLOW,
    SKIP
  );
  return choice === ALLOW;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('PairPilot');
  context.subscriptions.push(output);

  const logger = {
    info: (message: string): void => output.appendLine(`[info] ${message}`),
    warn: (message: string): void => output.appendLine(`[warn] ${message}`),
    error: (message: string, error?: unknown): void => {
      output.appendLine(`[error] ${message}`);
      if (error instanceof Error && error.stack) {
        output.appendLine(error.stack);
      } else if (error !== undefined) {
        output.appendLine(String(error));
      }
    },
    diagnostic: (message: string): void => output.appendLine(`[runtime] ${message}`),
  };

  output.appendLine('PairPilot activating.');

  // A wake-up notice when the workspace is not trusted: the extension drives a
  // process and writes files, so an untrusted workspace is a real risk.
  if (!vscode.workspace.isTrusted) {
    logger.warn('The workspace is not trusted. PairPilot will refuse to write files.');
  }

  const config = readConfiguration();
  const workspaceHolder = new WorkspaceHolder(logger);
  const workspace = workspaceHolder.refresh();

  const runtime = new ClaudeCodeRuntime(() => readConfiguration().claudePath, logger);
  const store = new SessionStore(
    context.workspaceState,
    logger,
    { maxSessions: config.maxSessions }
  );
  await store.load();

  // The diff provider serves the proposed side of an update from memory, so an
  // update can be reviewed before anything is written.
  const diff = new DiffManager(() => workspaceHolder.get()?.pathGuard ?? null, logger);
  context.subscriptions.push(diff.register());

  let provider: PairPilotProvider;

  const orchestrator = new Orchestrator({
    context,
    logger,
    runtime,
    // Late-bound: the orchestrator must see the *current* workspace context.
    get workspace() {
      return workspaceHolder.get() as WorkspaceContext;
    },
    store,
    diff,
    notify: () => provider.refresh(),
    notifyCodeDelta: (blockIndex, text) => provider.postCodeDelta(blockIndex, text),
    notifyTextDelta: (text) => provider.postTextDelta(text),
    notifyWritingProgress: (written, total, relativePath) =>
      provider.postWritingProgress(written, total, relativePath),
    readConfig: toOrchestratorConfig,
  });

  provider = new PairPilotProvider(context.extensionUri, {
    orchestrator,
    store,
    runtime,
    workspace: () => workspaceHolder.get(),
    logger,
    onMessage: (raw) => router.handle(raw),
  });

  const validator = new MessageValidator();

  const router = new WebviewMessageRouter({
    orchestrator,
    validator,
    logger,
    onReady: () => provider.refresh(),
    knownSessionIds: () => store.knownIds(),
    deleteSession: (sessionId) => {
      if (!store.delete(sessionId)) {
        void vscode.window.showWarningMessage('That session no longer exists.');
        return;
      }
      if (!store.getActive() && provider.isOpen) {
        orchestrator.newSession();
      }
      provider.refresh();
    },
    openFile: async (relativePath) => {
      await vscode.commands.executeCommand('pairpilot.openRelativeFile', relativePath);
    },
    addActiveEditorContext: async () => {
      const current = workspaceHolder.get();
      if (!current) {
        void vscode.window.showWarningMessage('PairPilot needs an open folder.');
        return;
      }
      const relative = current.getActiveEditorPath();
      if (!relative) {
        void vscode.window.showInformationMessage(
          'The active editor is not a file inside this workspace.'
        );
        return;
      }
      const result = orchestrator.addPinnedContext(relative);
      if (!result.ok) {
        void vscode.window.showWarningMessage(result.reason ?? 'That file cannot be used.');
        return;
      }
      orchestrator.setNotice(`Added ${relative} to the context for your next request.`);
    },
    revealOutput: () => output.show(true),
    newSession: () => {
      if (orchestrator.machine.isBusy()) {
        void vscode.window.showWarningMessage(
          'Cancel the current task before starting a new session.'
        );
        return;
      }
      orchestrator.newSession();
    },
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PairPilotProvider.viewType, provider, {
      // A fresh render on reveal keeps the panel from ever showing a stale
      // approval that could then be acted on.
      webviewOptions: { retainContextWhenHidden: false },
    })
  );

  registerCommands(context, {
    orchestrator,
    store,
    provider,
    logger,
    getWorkspace: () => workspaceHolder.get(),
    checkRuntime: async () => {
      const status = await runtime.detect();
      if (status.available) {
        void vscode.window.showInformationMessage(
          `${status.message}${status.executablePath ? ` (${status.executablePath})` : ''}`
        );
      } else {
        void vscode.window.showWarningMessage(status.message);
      }
      provider.refresh();
    },
  });

  // React to configuration and workspace changes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('pairpilot')) {
        logger.info('PairPilot configuration changed.');
        workspaceHolder.refresh();
        provider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      logger.info('Workspace folders changed; rebuilding the workspace context.');
      workspaceHolder.refresh();
      provider.refresh();
    })
  );

  context.subscriptions.push(
    runtime.onDidChangeStatus(() => provider.refresh())
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(() => {
      // Only the session list and context panel need refreshing on edits, and
      // only when the panel is actually open.
      if (provider.isOpen) {
        provider.refresh();
      }
    })
  );

  context.subscriptions.push({
    dispose: () => {
      void orchestrator.dispose();
    },
  });

  // Detect the runtime without blocking activation; the panel shows "Detecting…"
  // until it resolves.
  void runtime.detect().then((status) => {
    if (!status.available) {
      logger.warn(status.message);
    }
    provider.refresh();
  });

  if (!workspace) {
    logger.warn(
      'No local workspace folder is open. PairPilot needs a folder on disk to read context and write files.'
    );
  }

  logger.info(`PairPilot activated (VS Code ${vscode.version}, Node ${process.version}).`);
}

export function deactivate(): void {
  // Orchestrator disposal is registered as a subscription and runs on shutdown,
  // which rolls back any write that was still open.
}

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
import { ClaudeCodeProvider } from './providers/ClaudeCodeProvider';
import { ProviderRegistry } from './providers/ProviderRegistry';
import { WorkspaceContext } from './context/WorkspaceContext';
import { SessionStore } from './storage/SessionStore';
import { DiffManager } from './editor/DiffManager';
import { MessageValidator } from './security/MessageValidator';
import { PairPilotProvider } from './ui/PairPilotProvider';
import { WebviewMessageRouter } from './ui/WebviewMessageRouter';
import { ManagementController } from './ui/ManagementController';
import {
  catalogNotice,
  selectionClearedNotice,
  selectionSetNotice,
} from './ui/PanelNotices';
import { ProviderManagementProvider } from './ui/ProviderManagementProvider';
import { CostDashboardProvider } from './ui/CostDashboardProvider';
import { registerCommands } from './commands';
import { registerManagementCommands } from './commands/management';
import type { ProviderRequest } from './ui/ProviderMessages';

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
    timeoutMs: config.timeoutMs,
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

  // The Claude Code CLI is one backend among potentially several. Everything
  // downstream — the Orchestrator, the UI — talks to the registry instead, so a
  // second backend is additive rather than a second copy of the workflow.
  const claudeCode = new ClaudeCodeProvider({
    runtime,
    logger,
    // Read lazily, exactly as `ClaudeCodeRuntime` reads its configured path: a
    // settings change must apply to the next turn without re-activating.
    cliOptions: () => {
      const current = readConfiguration();
      return { bare: current.bare, extraArgs: current.extraArgs };
    },
  });
  const providers = new ProviderRegistry();
  providers.register(claudeCode);
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
  let management: ManagementController;

  const orchestrator = new Orchestrator({
    context,
    logger,
    // The Orchestrator names a role, never a provider or a model: which provider
    // serves the turn, and which model it runs on, are `AIOrchestrator`'s
    // business. That is what keeps a second backend additive.
    get ai() {
      return management.ai;
    },
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
    runtimeStatus: () => providers.activeRuntimeStatus(),
    workspace: () => workspaceHolder.get(),
    logger,
    onMessage: (raw) => router.handle(raw),
  });

  /* ---------------------------------------------------------------------- */
  /* AI providers, models and cost                                          */
  /* ---------------------------------------------------------------------- */

  // Held in `let` bindings because the two panels and the controller refer to
  // each other: the controller tells the panels to re-render, and a panel's
  // message is handled by the controller.
  let providersView: ProviderManagementProvider | null = null;
  let costView: CostDashboardProvider | null = null;

  const refreshPanels = (): void => {
    providersView?.refresh();
    costView?.refresh();
    provider.refresh();
  };

  management = new ManagementController({
    context,
    providers,
    logger,
    workspaceRoot: () => workspaceHolder.get()?.workspaceRoot ?? null,
    sessionId: () => store.getActive()?.id ?? null,
    onStateChanged: refreshPanels,
  });

  // Registers the OpenRouter provider and restores the cached catalogue and
  // selections. Makes no network call of its own.
  await management.init();

  providersView = new ProviderManagementProvider(context.extensionUri, {
    builder: management.viewBuilder,
    logger,
    handle: (request) => handleProviderRequest(request),
  });

  costView = new CostDashboardProvider(context.extensionUri, {
    buildView: (rangeDays) => management.buildCostView(rangeDays),
    onClearHistory: () => management.clearUsageHistory(),
    logger,
  });

  /**
   * Act on a validated request from the management panel.
   *
   * The panel has already checked the shape of everything here and handled the
   * messages that concern only its own presentation; what arrives is a request
   * to change state, and each branch either performs it or explains why not.
   */
  async function handleProviderRequest(request: ProviderRequest): Promise<void> {
    // Cleared first, so a sentence can never outlive the action it described.
    // A branch that has something true to report sets one below; the rest leave
    // the panel silent rather than repeating what its own state already shows.
    providersView?.setNotice(null);

    switch (request.type) {
      case 'ready': {
        // The first thing that touches the network, and only because the
        // developer opened this screen. Both calls are no-ops when the catalogue
        // is fresh and the connection was confirmed moments ago.
        const refreshed = await management.refreshCatalogIfDue();
        await management.ensureConnectionChecked();
        // Only a failure is worth reporting here. An automatic refresh that
        // worked changes nothing the developer was looking at, but one that
        // failed explains why the prices on screen are from a previous session.
        if (refreshed !== null && refreshed.status === 'failed') {
          providersView?.setNotice(catalogNotice(refreshed));
        }
        refreshPanels();
        return;
      }

      case 'setApiKey':
        // The prompt, the toast and the card's own auth state all report this;
        // a fourth telling in the panel would be noise.
        await management.promptForApiKey();
        refreshPanels();
        return;

      case 'clearApiKey':
        // The panel asks for confirmation before sending this.
        await management.disconnect({ confirm: false });
        refreshPanels();
        return;

      case 'testConnection':
        await management.testConnection({ announce: true });
        refreshPanels();
        return;

      case 'refreshCatalog': {
        // Announced in the panel rather than in a toast: this request came from
        // the panel, which can take thirty seconds to answer and says nothing at
        // all on screen when it fails.
        const outcome = await management.refreshCatalog({ announce: false });
        providersView?.setNotice(catalogNotice(outcome));
        refreshPanels();
        return;
      }

      case 'selectProvider': {
        await vscode.workspace
          .getConfiguration('pairpilot')
          .update('providers.activeProvider', request.providerId, vscode.ConfigurationTarget.Global);
        management.onConfigurationChanged();
        refreshPanels();
        return;
      }

      case 'setProviderEnabled': {
        if (request.providerId !== 'openrouter') {
          return;
        }
        await vscode.workspace
          .getConfiguration('pairpilot')
          .update('providers.openrouter.enabled', request.enabled, vscode.ConfigurationTarget.Global);
        management.onConfigurationChanged();
        refreshPanels();
        return;
      }

      case 'toggleFavorite':
        await management.catalog.toggleFavorite(request.modelId);
        refreshPanels();
        return;

      case 'selectModel': {
        const written = await management.setSelection(
          request.level,
          request.key,
          request.modelId
        );
        // Announced only when a selection was actually written. `setSelection`
        // refuses a model the catalogue does not carry, and saying "now in use"
        // about a refusal would be the panel lying about its own state.
        if (written) {
          providersView?.setNotice(
            selectionSetNotice(
              management.catalog.get(request.modelId)?.name ?? request.modelId,
              request.level,
              request.key
            )
          );
        }
        refreshPanels();
        return;
      }

      case 'clearSelection': {
        const cleared = await management.setSelection(request.level, request.key, null);
        if (cleared) {
          providersView?.setNotice(selectionClearedNotice(request.level, request.key));
        }
        refreshPanels();
        return;
      }

      case 'applyAdvice': {
        const applied = await management.setSelection('role', request.roleId, request.modelId);
        if (applied) {
          providersView?.setNotice(
            selectionSetNotice(
              management.catalog.get(request.modelId)?.name ?? request.modelId,
              'role',
              request.roleId
            )
          );
        }
        refreshPanels();
        return;
      }

      default:
        // Every other type is handled by the panel itself and never reaches here.
        logger.warn(`PairPilot received an unhandled management request: ${request.type}`);
        return;
    }
  }

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ProviderManagementProvider.viewType,
      providersView,
      { webviewOptions: { retainContextWhenHidden: false } }
    ),
    vscode.window.registerWebviewViewProvider(CostDashboardProvider.viewType, costView, {
      webviewOptions: { retainContextWhenHidden: false },
    })
  );

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
      // A deterministic re-check of the active backend: for the CLI that means
      // probing for the executable, for a remote provider it will mean
      // validating the connection. Either way the developer asked for this.
      const status = await providers.active().detect();
      const suffix = status.executablePath ? ` (${status.executablePath})` : '';
      if (status.available) {
        void vscode.window.showInformationMessage(`${status.message}${suffix}`);
      } else {
        void vscode.window.showWarningMessage(status.message);
      }
      provider.refresh();
    },
  });

  registerManagementCommands(context, {
    management,
    providersView,
    costView,
    logger,
  });

  // React to configuration and workspace changes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('pairpilot')) {
        logger.info('PairPilot configuration changed.');
        workspaceHolder.refresh();
        // Which provider is active, the base URL and the budget are all settings
        // that must apply to the next turn without a reload.
        management.onConfigurationChanged();
        refreshPanels();
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
    providers.onDidChangeStatus(() => provider.refresh())
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
      management.dispose();
    },
  });

  // Probe the local runtime without blocking activation; the panel shows
  // "Detecting…" until it resolves.
  //
  // Only the CLI is probed here. A remote provider's check is an HTTP request,
  // and PairPilot does not put one on the wire until the developer opens the
  // management view or asks for a test — activation is not consent to that.
  void (async () => {
    if (providers.activeProviderId !== 'claude-code') {
      return;
    }
    const status = await providers.active().detect();
    if (!status.available) {
      logger.warn(status.message);
    }
    provider.refresh();
  })();

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

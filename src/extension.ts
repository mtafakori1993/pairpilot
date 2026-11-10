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
import { CostDashboardProvider } from './ui/CostDashboardProvider';
import { ConfigStatusBar } from './config/ConfigStatusBar';
import { EditorReview } from './review/EditorReview';
import { ReviewBridge } from './review/ReviewBridge';
import { WritePermission, type PermissionChoice } from './review/WritePermission';
import { PairPilotState } from './types';
import { RoadmapContinuation } from './roadmap/RoadmapContinuation';
import { RoadmapStore } from './roadmap/RoadmapStore';
import { ApprovedLedger, RoadmapWorkflow } from './roadmap/RoadmapWorkflow';
import { registerCommands } from './commands';
import { registerManagementCommands } from './commands/management';
import { registerReviewCommands } from './commands/review';

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

/**
 * Whether a review request carried any proposal identity.
 *
 * The Orchestrator's freshness check treats "no binding at all" and "a binding"
 * differently, so an empty object must be sent as `undefined` rather than as a
 * binding that matches nothing.
 */
function hasDecisionBinding(
  binding: { proposalId?: string; proposalVersion?: number; fileId?: string }
): boolean {
  return (
    binding.proposalId !== undefined ||
    binding.proposalVersion !== undefined ||
    binding.fileId !== undefined
  );
}

/**
 * Report a permission answer the workflow refused.
 *
 * Refusals are recorded on `error` rather than thrown, because every decision
 * path returns normally. Reading it here is what turns "the modal went away and
 * nothing happened" into a sentence naming the reason — usually that the
 * proposal changed while the prompt was open.
 */
function reportPermissionRefusal(orchestrator: Orchestrator): void {
  const reason = orchestrator.errorValue;
  if (reason === null) {
    return;
  }
  orchestrator.clearError();
  void vscode.window.showWarningMessage(
    `PairPilot: that answer was not applied. ${reason}`
  );
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

  // The bridge holds the review surface's link back into the workflow. It is
  // declared before both so the hook can close over them; neither exists yet at
  // construction time, which is why the accessors are functions. A holder object
  // rather than a `let`, because TypeScript narrows a captured `let` that is
  // still `null` to `never` inside the closure.
  const reviewHolder: { current: EditorReview | null } = { current: null };

  const reviewBridge = new ReviewBridge({
    orchestrator: () => orchestrator,
    logger,
  });

  /**
   * The pre-write permission prompt.
   *
   * The decision that was lost when the sidebar's buttons were removed with the
   * rest of the panel's authority: a proposal reaches `WAITING_FILE_APPROVAL`
   * before anything is written, and this is what answers it. It is a native
   * modal rather than an editor thread because at this point there is no code in
   * the editor to review — the question is whether the workspace may be touched
   * at all, and the file may not exist yet.
   *
   * Every answer goes back through the Orchestrator, which re-verifies it
   * against the live proposal. A stale or forged answer is refused there, so
   * nothing below decides whether a write is allowed.
   */
  const writePermission = new WritePermission({
    prompt: async (request): Promise<PermissionChoice> => {
      const WRITE = 'Write it';
      const REJECT = 'Reject';
      const CHANGES = 'Request changes…';
      const total = request.position?.total ?? 1;
      const WRITE_ALL = `Write all ${total} files…`;

      const verb = request.operation === 'create' ? 'create' : 'rewrite';
      const position =
        request.position && total > 1
          ? ` (file ${request.position.index} of ${total})`
          : '';
      const detail = [request.description, request.rationale ?? '']
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .join('\n\n');

      // Only a set of several files offers the batch answer, and it is a
      // separate press rather than a default: authorising five writes at once
      // should never be what Return does by accident.
      const buttons = request.setHash !== null ? [WRITE, WRITE_ALL, CHANGES, REJECT] : [WRITE, CHANGES, REJECT];

      const answer = await vscode.window.showInformationMessage(
        `PairPilot wants to ${verb} \`${request.relativePath}\`${position}. Nothing has been written yet.`,
        { modal: true, ...(detail.length > 0 ? { detail } : {}) },
        ...buttons
      );

      if (answer === WRITE) {
        return { kind: 'write' };
      }
      if (answer === WRITE_ALL) {
        return { kind: 'write_all' };
      }
      if (answer === REJECT) {
        return { kind: 'reject' };
      }
      if (answer !== CHANGES) {
        return { kind: 'dismissed' };
      }

      const feedback = await vscode.window.showInputBox({
        title: `PairPilot: Changes for ${request.relativePath}`,
        prompt: 'What should the code do instead?',
        placeHolder: 'e.g. use a prepared statement instead of string concatenation',
        ignoreFocusOut: true,
        validateInput: (value) =>
          value.trim().length === 0 ? 'Describe the change you want before requesting it.' : undefined,
      });
      if (feedback === undefined) {
        return { kind: 'dismissed' };
      }
      return { kind: 'revise', feedback };
    },
    apply: async (request, choice) => {
      const binding = hasDecisionBinding(request.binding) ? { ...request.binding } : undefined;
      // A refusal is recorded on `error`, and an earlier one must not be
      // attributed to this answer — so the slate is cleared first, not after.
      orchestrator.clearError();
      switch (choice.kind) {
        case 'write':
          await orchestrator.approveFileCreation(request.contentHash, binding);
          reportPermissionRefusal(orchestrator);
          return;
        case 'write_all':
          // The set hash authorises every remaining file. The workflow records
          // that on the batch as permission to write — each file is still shown
          // for review as it is written.
          await orchestrator.approveFileCreation(request.setHash ?? request.contentHash, binding);
          reportPermissionRefusal(orchestrator);
          return;
        case 'reject':
          orchestrator.rejectFileCreation(request.contentHash, binding);
          reportPermissionRefusal(orchestrator);
          return;
        case 'revise':
          await orchestrator.requestChangesBeforeWrite(request.contentHash, choice.feedback, binding);
          // A revision turn reports its own failure. The gate only reports when
          // it never moved — which is the one case that means "not applied".
          if (orchestrator.machine.is(PairPilotState.WAITING_FILE_APPROVAL)) {
            reportPermissionRefusal(orchestrator);
          }
          return;
      }
    },
    // Asked of the workflow, not remembered here: a cancelled turn or another
    // file's gate makes an old prompt stale, and a prompt that can only be
    // refused should not be shown at all.
    isLive: () => orchestrator.machine.is(PairPilotState.WAITING_FILE_APPROVAL),
    logger,
  });

  // The roadmap is read from the workspace on each turn rather than captured
  // once, so a file the developer edits while PairPilot runs takes effect on the
  // next file instead of after a window reload.
  const roadmapStore = new RoadmapStore({
    guard: () => workspaceHolder.get()?.pathGuard ?? null,
    workspaceRoot: () => workspaceHolder.get()?.workspaceRoot ?? null,
    logger,
  });
  const roadmapWorkflow = new RoadmapWorkflow({
    store: roadmapStore,
    continuation: new RoadmapContinuation({ store: roadmapStore, logger }),
    ledger: new ApprovedLedger(),
    logger,
    /**
     * Ask whether the work passed its checks, in a modal.
     *
     * A modal rather than a toast: this writes `done` into the project's plan,
     * and a notification that disappears is not consent. Escape and dismissal
     * both return false, so an unanswered question never completes a task.
     */
    confirmVerified: async (taskId) => {
      const CONFIRMED = 'Yes, it passed';
      const answer = await vscode.window.showInformationMessage(
        `PairPilot: has the work for "${taskId}" been verified?`,
        {
          modal: true,
          detail:
            'Its roadmap task is marked done only when its checks have passed. Otherwise it stays in progress, and no next task is started.',
        },
        CONFIRMED,
        'Not yet'
      );
      return answer === CONFIRMED;
    },
    onChanged: () => provider?.refresh(),
  });

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
    notifyTextDelta: (text) => provider.postTextDelta(text),
    notifyWritingProgress: (written, total, relativePath) =>
      provider.postWritingProgress(written, total, relativePath),
    openReview: async (request) => {
      const surface = reviewHolder.current;
      if (!surface) {
        return;
      }
      // Recorded before the thread opens, so a decision can never arrive for a
      // review the bridge has not heard of.
      reviewBridge.remember(request);
      await surface.openReview(request);
    },
    // Asked before anything is written. The answer comes back through the same
    // decision methods a thread button uses, so the prompt has no authority of
    // its own.
    askWritePermission: async (request) => {
      await writePermission.ask(request);
    },
    roadmap: roadmapWorkflow,
    readConfig: toOrchestratorConfig,
  });

  // The in-editor review surface. Its `decide` is the only path from a thread
  // button or the native prompt into the workflow.
  reviewHolder.current = new EditorReview({
    decide: async (_session, result) => {
      await reviewBridge.apply(result.outcome);
      if (orchestrator.errorValue !== null) {
        reviewBridge.reportRefusal(orchestrator, result.outcome.decision);
      }
    },
    logger,
  });
  context.subscriptions.push(reviewHolder.current);

  registerReviewCommands(context, {
    review: reviewHolder.current,
    permission: writePermission,
    logger,
  });

  provider = new PairPilotProvider(context.extensionUri, {
    orchestrator,
    store,
    runtimeStatus: () => providers.activeRuntimeStatus(),
    /**
     * The provider and model a coding turn would use right now.
     *
     * Resolved through the same selection service the workflow uses, so the
     * panel cannot say "automatic" while a stored role selection is in force.
     */
    modelConfig: () => {
      const providerId = management.currentProviderId();
      const provider = management.providersForPicker().find((entry) => entry.id === providerId);
      const resolved = management.resolveFor({
        roleId: 'coding',
        projectPath: management.workspaceRootPath(),
      });
      const modelLabel =
        resolved.modelId === null
          ? 'automatic'
          : (management.catalog.get(resolved.modelId)?.name ?? resolved.modelId);
      return { providerLabel: provider?.label ?? providerId, modelLabel };
    },
    workspace: () => workspaceHolder.get(),
    logger,
    onMessage: (raw) => router.handle(raw),
  });

  /* ---------------------------------------------------------------------- */
  /* AI providers, models and cost                                          */
  /* ---------------------------------------------------------------------- */

  // Held in a `let` binding because the cost panel and the controller refer to
  // each other: the controller tells the panel to re-render, and the panel's
  // actions are handled by the controller.
  let costView: CostDashboardProvider | null = null;

  // Created before the controller so the very first state change can repaint
  // it; it reads only through the controller, never the other way round.
  let statusBar: ConfigStatusBar | null = null;

  const refreshPanels = (): void => {
    costView?.refresh();
    provider.refresh();
    statusBar?.refresh();
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

  // The status bar is the sidebar's replacement for "which provider, which
  // model": always visible, one click from the native selection flow.
  statusBar = new ConfigStatusBar(management);
  context.subscriptions.push(statusBar);

  costView = new CostDashboardProvider(context.extensionUri, {
    buildView: (rangeDays) => management.buildCostView(rangeDays),
    onClearHistory: () => management.clearUsageHistory(),
    logger,
  });

  context.subscriptions.push(
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
    revealReview: async () => {
      await vscode.commands.executeCommand('pairpilot.reviewWaitingFile');
    },
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
    costView,
    refreshStatusBar: () => statusBar?.refresh(),
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

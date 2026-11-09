/**
 * ManagementController — everything behind the two management panels.
 *
 * This is the composition root for the provider and model subsystem, and it is
 * deliberately the only place that holds all of these at once:
 *
 *   SecretManager · FetchTransport · OpenRouterClient · OpenRouterProvider
 *   ModelRegistry · ModelSelectionService · ModelAdvisor · UsageTracker
 *
 * It exists so `extension.ts` stays a wiring file rather than becoming the place
 * where a credential is read and an HTTP client is built. Two consequences worth
 * naming:
 *
 *  - **The API key is read in exactly one place** — the `apiKey` closure handed
 *    to `OpenRouterClient`, which fetches it per request. Nothing caches it,
 *    nothing logs it, and the only value derived from it that leaves this class
 *    is the mask `SecretManager.summary()` produced.
 *  - **Every panel message is validated before it arrives here.** The Webview
 *    providers parse and bounds-check; this class then resolves any model id
 *    against the catalogue rather than storing a name it was handed.
 */

import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { AIOrchestrator } from '../orchestration/AIOrchestrator';
import { FetchTransport } from '../providers/HttpTransport';
import { OPENROUTER_DEFAULT_BASE_URL, OpenRouterClient } from '../providers/OpenRouterClient';
import {
  OPENROUTER_PROVIDER_DESCRIPTION,
  OpenRouterProvider,
} from '../providers/OpenRouterProvider';
import {
  CLAUDE_CODE_PROVIDER_ID,
  CLAUDE_CODE_PROVIDER_LABEL,
} from '../providers/ClaudeCodeProvider';
import { ProviderRegistry } from '../providers/ProviderRegistry';
import { ModelAdvisor } from '../models/ModelAdvisor';
import { ModelRegistry } from '../models/ModelRegistry';
import { ModelSelectionService } from '../models/ModelSelectionService';
import { UsageTracker } from '../pricing/UsageTracker';
import {
  SecretManager,
  looksLikeOpenRouterKey,
  maskSecret,
  type KeySummary,
} from '../security/SecretManager';
import type { AIProviderStatus, ProviderId } from '../types/provider';
import type { AccountInfo, ModelTaskId, SelectionLevel } from '../types/providerConfig';
import type { Logger } from '../types';
import {
  ProviderViewBuilder,
  type OpenRouterLiveState,
  type ProviderDescriptor,
} from './ProviderViewBuilder';
import { buildCostView as assembleCostView, type CostView } from './CostViewBuilder';
import { DEFAULT_COST_RANGE_DAYS } from './CostDashboardProvider';

/** Provider settings, read in one place so their defaults cannot drift. */
export interface ProviderSettings {
  activeProvider: ProviderId;
  openRouterEnabled: boolean;
  openRouterBaseUrl: string;
  maxOutputTokens: number;
  catalogRefreshHours: number;
  budgetUsd: number;
  historyLimit: number;
}

/**
 * Read the provider and cost settings.
 *
 * The defaults live in `package.json` as well, and these are the same values.
 * They are repeated here because a setting that has never been written is read
 * through these defaults, and a mismatch between the two would show one value in
 * the Settings UI and apply another.
 */
export function readProviderSettings(): ProviderSettings {
  const config = vscode.workspace.getConfiguration('pairpilot');
  const active = config.get<string>('providers.activeProvider', 'claude-code');

  return {
    // Existing users see no change on upgrade: the CLI stays active until
    // somebody chooses otherwise.
    activeProvider: active === 'openrouter' ? 'openrouter' : 'claude-code',
    openRouterEnabled: config.get<boolean>('providers.openrouter.enabled', true),
    openRouterBaseUrl: normaliseBaseUrl(
      config.get<string>('providers.openrouter.baseUrl', OPENROUTER_DEFAULT_BASE_URL)
    ),
    maxOutputTokens: Math.max(0, config.get<number>('providers.openrouter.maxOutputTokens', 0)),
    catalogRefreshHours: Math.max(0, config.get<number>('providers.catalogRefreshHours', 12)),
    budgetUsd: Math.max(0, config.get<number>('cost.budgetUsd', 0)),
    historyLimit: Math.max(50, config.get<number>('cost.historyLimit', 500)),
  };
}

/**
 * What a catalogue refresh did.
 *
 * Returned rather than inferred from the catalogue afterwards, because the
 * caller's next job is to say what happened — and "the refresh failed" and "a
 * refresh was already running" leave the catalogue looking identical.
 */
export type CatalogRefreshOutcome =
  | { status: 'refreshed'; count: number }
  | { status: 'failed'; error: string; count: number }
  | { status: 'skipped' };

export interface ManagementControllerDeps {
  context: vscode.ExtensionContext;
  providers: ProviderRegistry;
  logger: Logger & { diagnostic?(message: string): void };
  workspaceRoot(): string | null;
  sessionId(): string | null;
  /** Called when provider or model state changed, so the sidebar can refresh. */
  onStateChanged(): void;
}

export class ManagementController {
  readonly secrets: SecretManager;
  readonly transport: FetchTransport;
  readonly openRouter: OpenRouterProvider;
  readonly catalog: ModelRegistry;
  readonly selection: ModelSelectionService;
  readonly advisor: ModelAdvisor;
  readonly usage: UsageTracker;
  readonly ai: AIOrchestrator;
  readonly viewBuilder: ProviderViewBuilder;

  /** Cached so a panel render never awaits a secret read. */
  private keySummaryValue: KeySummary = { present: false, masked: null, prefixWarning: null };
  private lastCatalogError: string | null = null;

  constructor(private readonly deps: ManagementControllerDeps) {
    const settings = readProviderSettings();

    this.secrets = new SecretManager(deps.context.secrets);
    this.transport = new FetchTransport();

    this.openRouter = new OpenRouterProvider({
      secrets: this.secrets,
      createClient: () =>
        new OpenRouterClient({
          transport: this.transport,
          // Read on every request, so replacing the key applies to the very next
          // turn with no reload and no long-lived copy in memory.
          apiKey: () => this.secrets.get('openrouter'),
          baseUrl: readProviderSettings().openRouterBaseUrl,
          appTitle: 'PairPilot',
        }),
      transportAvailable: () =>
        this.transport.available
          ? { available: true }
          : { available: false, reason: this.transport.unavailableReason },
      lookupModel: (modelId) => this.catalog.get(modelId),
      isEnabled: () => readProviderSettings().openRouterEnabled,
      // The model the next coding turn would use, which is the same value the
      // Orchestrator resolves — one source of truth, not a second default.
      defaultModel: () =>
        this.selection.resolve({ roleId: 'coding', projectPath: deps.workspaceRoot() }).modelId,
      maxOutputTokens: () => readProviderSettings().maxOutputTokens,
      logger: deps.logger,
    });

    this.catalog = new ModelRegistry({
      fetchModels: (signal) => this.openRouterClient().listModels(signal ?? new AbortController().signal),
      storage: deps.context.globalState,
      logger: deps.logger,
    });

    this.selection = new ModelSelectionService(deps.context.globalState);
    this.advisor = new ModelAdvisor({ list: () => this.catalog.list() });
    this.usage = new UsageTracker({
      storage: deps.context.globalState,
      capacity: settings.historyLimit,
      newId: () => crypto.randomUUID(),
      logger: deps.logger,
    });

    this.ai = new AIOrchestrator({
      providers: deps.providers,
      selection: this.selection,
      catalog: this.catalog,
      usage: this.usage,
      logger: deps.logger,
      workspaceRoot: deps.workspaceRoot,
      sessionId: deps.sessionId,
      budgetUsd: () => readProviderSettings().budgetUsd,
      onBudgetExceeded: (spent, limit) => {
        void vscode.window.showWarningMessage(
          `PairPilot: this session has passed the $${limit.toFixed(2)} budget you set (about $${spent.toFixed(2)} so far). Requests are not blocked — raise or clear "pairpilot.cost.budgetUsd" to stop seeing this.`
        );
      },
    });

    this.viewBuilder = new ProviderViewBuilder({
      descriptors: () => this.descriptors(),
      statusOf: (providerId) => this.statusOf(providerId),
      openRouterState: () => this.openRouterState(),
      keySummary: () => this.keySummaryValue,
      activeProviderId: () => this.activeProviderId(),
      catalog: this.catalog,
      selection: this.selection,
      advisor: this.advisor,
      catalogError: () => this.lastCatalogError,
      projectPath: deps.workspaceRoot,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Restore cached state and register the OpenRouter provider.
   *
   * Deliberately performs no network call. Nothing reaches out until the
   * developer opens the management view or runs a command, which is the least
   * surprising behaviour for an extension that was merely installed.
   */
  async init(): Promise<void> {
    this.catalog.load();
    this.selection.load();
    this.usage.load();
    await this.refreshKeySummary();

    const settings = readProviderSettings();
    this.deps.providers.register(this.openRouter);
    this.applyActiveProvider(settings.activeProvider);

    this.deps.logger.info(
      `AI providers ready. Active: ${this.activeProviderId()}. Model catalogue: ${this.catalog.count()} models cached.`
    );
  }

  /** Re-read settings and apply anything that changed. */
  onConfigurationChanged(): void {
    this.applyActiveProvider(readProviderSettings().activeProvider);
    this.openRouter.refresh();
  }

  private applyActiveProvider(id: ProviderId): void {
    if (id === this.activeProviderId()) {
      return;
    }
    if (!this.deps.providers.select(id)) {
      // The provider is configured but not registered — only possible for a
      // provider this build does not have, which the UI shows as unavailable.
      this.deps.logger.warn(`PairPilot could not activate the "${id}" provider.`);
    }
  }

  private activeProviderId(): ProviderId {
    return this.deps.providers.activeProviderId ?? CLAUDE_CODE_PROVIDER_ID;
  }

  dispose(): void {
    this.deps.providers.dispose();
  }

  /* ---------------------------------------------------------------------- */
  /* Key management                                                         */
  /* ---------------------------------------------------------------------- */

  /** Re-read the key summary. The only value read out of the secret store here. */
  async refreshKeySummary(): Promise<void> {
    this.keySummaryValue = await this.secrets.summary('openrouter');
  }

  get keySummary(): KeySummary {
    return this.keySummaryValue;
  }

  /**
   * Prompt for an API key and store it.
   *
   * The prompt is a password field so the value is not rendered on screen or
   * captured in a screenshot, and the field is not pre-filled with the existing
   * key — replacing a key means pasting a new one, never editing a visible copy
   * of the old.
   */
  async promptForApiKey(): Promise<void> {
    const hadKey = this.keySummaryValue.present;

    const value = await vscode.window.showInputBox({
      title: hadKey ? 'Replace the OpenRouter API key' : 'Set the OpenRouter API key',
      prompt: hadKey
        ? 'Paste the new key. It replaces the stored one; the old key is deleted and cannot be recovered.'
        : 'Paste your OpenRouter API key. Create one at https://openrouter.ai/keys',
      placeHolder: 'sk-or-…',
      password: true,
      ignoreFocusOut: true,
      validateInput: (input) => {
        const trimmed = input.trim();
        if (trimmed.length === 0) {
          return hadKey ? null : 'Paste a key, or press Escape to cancel.';
        }
        if (trimmed.length < 8) {
          return 'That is too short to be an API key.';
        }
        return null;
      },
    });

    if (value === undefined) {
      return;
    }
    const secret = value.trim();
    if (secret.length === 0) {
      // An empty submission on the replace path means "cancel", not "delete".
      // Deleting a credential is a separate, confirmed action.
      return;
    }

    await this.secrets.set('openrouter', secret);
    await this.refreshKeySummary();

    // A prefix mismatch is a warning, never a refusal: the real verdict comes
    // from the provider, and a tool that rejects a valid key over a literal is
    // worse than one that tries it.
    if (!looksLikeOpenRouterKey(secret)) {
      this.deps.logger.warn('The stored OpenRouter key does not match the documented "sk-or-" prefix.');
    }

    this.openRouter.markKeyStored();
    this.deps.logger.info('An OpenRouter API key was stored in SecretStorage.');
    this.deps.onStateChanged();

    // Validate immediately: storing a key the provider will reject and saying
    // nothing would leave the developer to discover it at their next request.
    await this.testConnection({ announce: true });
  }

  /** Validate the stored key against the provider and report the outcome. */
  async testConnection(options: { announce: boolean }): Promise<void> {
    await this.refreshKeySummary();

    if (!this.keySummaryValue.present) {
      if (options.announce) {
        const choice = await vscode.window.showWarningMessage(
          'No OpenRouter API key is stored yet. Create one at https://openrouter.ai/keys',
          'Open the key page',
          'Dismiss'
        );
        if (choice === 'Open the key page') {
          await vscode.env.openExternal(vscode.Uri.parse('https://openrouter.ai/keys'));
        }
      }
      this.deps.onStateChanged();
      return;
    }

    this.openRouter.markConnecting();
    this.deps.onStateChanged();

    // Never throws: `detect()` turns every failure into a displayable state.
    const status = await this.openRouter.detect();
    this.deps.onStateChanged();

    if (!options.announce) {
      return;
    }
    if (status.available) {
      const usageUsd = this.openRouter.snapshotState().account?.usageUsd ?? null;
      const detail = usageUsd === null ? '' : ` Account usage so far: $${usageUsd.toFixed(2)}.`;
      void vscode.window.showInformationMessage(`OpenRouter accepted the stored key.${detail}`);
    } else {
      void vscode.window.showWarningMessage(status.message);
    }
  }

  /**
   * Test the connection unless it was successfully checked very recently.
   *
   * The management view is re-created every time it is revealed (PairPilot does
   * not retain Webview context, so a stale approval can never be acted on), and
   * a connection test is a real HTTP request. Re-checking a connection that was
   * confirmed a moment ago would put a request on the wire every time the
   * developer glances at the panel.
   */
  async ensureConnectionChecked(maxAgeMs = 5 * 60_000): Promise<void> {
    if (!this.keySummaryValue.present) {
      return;
    }
    const state = this.openRouter.snapshotState();
    if (
      state.connectionState === 'connected' &&
      state.lastConnectedAt !== null &&
      Date.now() - state.lastConnectedAt < maxAgeMs
    ) {
      return;
    }
    await this.testConnection({ announce: false });
  }

  /**
   * Remove the stored key.
   *
   * `confirm` is true only when the request came from a place with no
   * confirmation of its own — the command palette. The panel asks first, so
   * asking twice would be noise.
   */
  async disconnect(options: { confirm: boolean }): Promise<void> {
    if (!this.keySummaryValue.present) {
      void vscode.window.showInformationMessage('No OpenRouter API key is stored.');
      return;
    }

    if (options.confirm) {
      const REMOVE = 'Remove the key';
      const choice = await vscode.window.showWarningMessage(
        'Remove the stored OpenRouter API key? PairPilot cannot recover it, and you would need to paste it again to use OpenRouter.',
        { modal: true },
        REMOVE
      );
      if (choice !== REMOVE) {
        return;
      }
    }

    await this.secrets.delete('openrouter');
    await this.refreshKeySummary();
    this.openRouter.markKeyCleared();
    // Never the key, and never a fragment of it: only the fact that it is gone.
    this.deps.logger.info('The stored OpenRouter API key was removed.');
    this.deps.onStateChanged();
    void vscode.window.showInformationMessage('The OpenRouter API key was removed.');
  }

  /* ---------------------------------------------------------------------- */
  /* Catalogue                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Fetch the model catalogue.
   *
   * Public endpoint, so this works before a key is set — which matters, because
   * choosing a model is part of deciding whether to configure a provider at all.
   */
  async refreshCatalog(options: { announce: boolean }): Promise<CatalogRefreshOutcome> {
    if (this.catalog.isRefreshing) {
      return { status: 'skipped' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    try {
      const result = await this.catalog.refresh(controller.signal);
      this.lastCatalogError = result.ok ? null : result.error;

      if (result.ok) {
        this.deps.logger.info(`Loaded ${result.count} models from the OpenRouter catalogue.`);
        await this.dropDanglingSelections();
        return { status: 'refreshed', count: result.count };
      }

      this.deps.logger.warn(`The model catalogue could not be refreshed: ${result.error}`);
      if (options.announce) {
        void vscode.window.showWarningMessage(
          `PairPilot could not refresh the model catalogue. ${result.error}` +
            (this.catalog.count() > 0
              ? ' The models already loaded are still available and are marked as out of date.'
              : '')
        );
      }
      return {
        status: 'failed',
        error: result.error ?? 'The catalogue refresh failed without reporting a reason.',
        // The models still on hand, which the caller reports alongside the
        // failure so a stale catalogue does not read as an empty one.
        count: this.catalog.count(),
      };
    } finally {
      clearTimeout(timer);
      this.deps.onStateChanged();
    }
  }

  /** Refresh now when the configured interval has elapsed. */
  async refreshCatalogIfDue(): Promise<CatalogRefreshOutcome | null> {
    if (!this.catalog.isRefreshDue(readProviderSettings().catalogRefreshHours)) {
      return null;
    }
    return this.refreshCatalog({ announce: false });
  }

  /**
   * Clear selections pointing at models the catalogue no longer has.
   *
   * Left in place they would fail at the *next turn* with a provider-side
   * "unknown model" error, which is far harder to trace back to a catalogue
   * change than a selection that was tidied up when the change happened.
   */
  private async dropDanglingSelections(): Promise<void> {
    const known = new Set(this.catalog.list().map((model) => model.id));
    for (const modelId of this.selection.danglingModelIds(known)) {
      const removed = await this.selection.forgetModel(modelId);
      if (removed > 0) {
        this.deps.logger.warn(
          `"${modelId}" is no longer in the model catalogue, so it was cleared from ${removed} selection${removed === 1 ? '' : 's'}.`
        );
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Selections                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Write a model selection at one level. `null` clears that level.
   *
   * Returns whether anything was written, so a caller that reports the outcome
   * can say so truthfully: a selection naming a model the catalogue does not
   * have is refused, and a panel that announced it anyway would be describing a
   * change that never happened.
   *
   * Selecting a model does **not** add it to "Recently used". That list is fed
   * by turns that actually ran (see `AIOrchestrator.record`), and marking a
   * selection here would make the heading untrue — a model chosen and never
   * tried would outrank one that had just written code.
   */
  async setSelection(
    level: SelectionLevel,
    key: string | null,
    modelId: string | null
  ): Promise<boolean> {
    // A selection naming a model the catalogue does not have would fail at the
    // next turn, so it is refused here where the cause is still obvious.
    if (modelId !== null && this.catalog.get(modelId) === null) {
      void vscode.window.showWarningMessage(
        `"${modelId}" is not in the model catalogue, so it was not selected. Refresh the catalogue and try again.`
      );
      return false;
    }

    switch (level) {
      case 'global':
        await this.selection.setGlobal(modelId);
        break;
      case 'project':
        if (key === null) {
          return false;
        }
        await this.selection.setProject(key, modelId);
        break;
      case 'role':
        if (key === null) {
          return false;
        }
        await this.selection.setRole(key as ModelTaskId, modelId);
        break;
      case 'task':
        if (key === null) {
          return false;
        }
        await this.selection.setTask(key, modelId);
        break;
    }

    this.deps.onStateChanged();
    return true;
  }

  /* ---------------------------------------------------------------------- */
  /* Views                                                                  */
  /* ---------------------------------------------------------------------- */

  buildCostView(rangeDays: number = DEFAULT_COST_RANGE_DAYS): CostView {
    const projectPath = this.deps.workspaceRoot();
    return assembleCostView({
      snapshot: {
        totals: this.usage.totals(),
        sessionTotals: this.usage.sessionTotals(this.deps.sessionId()),
        byModel: this.usage.byModel(),
        byProvider: this.usage.byProvider(),
        byRole: this.usage.byRole(),
        history: this.usage.history(),
        recent: this.usage.recent(50),
        budget: this.usage.budget(
          readProviderSettings().budgetUsd,
          this.deps.sessionId(),
          projectPath
        ),
        historyTruncated: this.usage.historyTruncated,
        retained: this.usage.retained,
        capacity: this.usage.capacityLimit,
      },
      projectTotals: projectPath === null ? null : this.usage.projectTotals(projectPath),
      budgetUsd: readProviderSettings().budgetUsd,
      rangeDays,
      projectPath,
    });
  }

  async clearUsageHistory(): Promise<void> {
    const CLEAR = 'Erase the history';
    const choice = await vscode.window.showWarningMessage(
      'Erase PairPilot’s recorded usage history? The local record of requests, tokens and costs is deleted. Nothing at OpenRouter changes.',
      { modal: true },
      CLEAR
    );
    if (choice !== CLEAR) {
      return;
    }
    await this.usage.clear();
    this.deps.onStateChanged();
    void vscode.window.showInformationMessage('PairPilot’s usage history was erased.');
  }

  /* ---------------------------------------------------------------------- */
  /* View-builder inputs                                                    */
  /* ---------------------------------------------------------------------- */

  private descriptors(): ProviderDescriptor[] {
    const settings = readProviderSettings();
    const claudeStatus = this.statusOf(CLAUDE_CODE_PROVIDER_ID);

    return [
      {
        id: CLAUDE_CODE_PROVIDER_ID,
        label: CLAUDE_CODE_PROVIDER_LABEL,
        description:
          'The local Claude Code CLI. It signs in on its own, so PairPilot stores no credential for it, and it chooses its own model.',
        baseUrl: claudeStatus?.executablePath ?? 'Local process — no base URL',
        // The CLI provider is always on: switching it off would leave a machine
        // with no working backend at all.
        enabled: true,
        selectable: true,
        runtimeAvailable: claudeStatus?.available ?? false,
      },
      {
        id: 'openrouter',
        label: 'OpenRouter',
        description: OPENROUTER_PROVIDER_DESCRIPTION,
        baseUrl: settings.openRouterBaseUrl,
        enabled: settings.openRouterEnabled,
        selectable: true,
        runtimeAvailable: this.transport.available,
      },
    ];
  }

  private statusOf(providerId: ProviderId): AIProviderStatus | null {
    const provider = this.deps.providers.list().find((entry) => entry.id === providerId);
    return provider ? provider.getStatus() : null;
  }

  private openRouterState(): OpenRouterLiveState | null {
    const registered = this.deps.providers.list().some((entry) => entry.id === 'openrouter');
    if (!registered) {
      return null;
    }
    const state = this.openRouter.snapshotState();
    return {
      authState: state.authState,
      connectionState: state.connectionState,
      authenticated: state.authenticated,
      account: toAccountInfo(state.account),
      lastConnectedAt: state.lastConnectedAt,
      lastConnectionError: state.lastConnectionError,
      busy: state.busy,
    };
  }

  private openRouterClient(): OpenRouterClient {
    return new OpenRouterClient({
      transport: this.transport,
      apiKey: () => this.secrets.get('openrouter'),
      baseUrl: readProviderSettings().openRouterBaseUrl,
      appTitle: 'PairPilot',
    });
  }
}

/* -------------------------------------------------------------------------- */

/**
 * Map the provider's account snapshot into the UI's shape.
 *
 * The key's own label is masked *again* here. OpenRouter already returns it
 * masked, but it is still derived from the credential, so it passes through the
 * same local masker as everything else rather than being trusted because a
 * remote service said it was safe.
 */
function toAccountInfo(account: {
  keyLabel: string | null;
  usageUsd: number | null;
  limitUsd: number | null;
  limitRemainingUsd: number | null;
  limitReset: string | null;
  isFreeTier: boolean | null;
  fetchedAt: number;
} | null): AccountInfo | null {
  if (account === null) {
    return null;
  }
  return {
    keyLabelMasked: account.keyLabel === null ? null : maskSecret(account.keyLabel),
    usageUsd: account.usageUsd,
    limitUsd: account.limitUsd,
    limitRemainingUsd: account.limitRemainingUsd,
    limitReset: account.limitReset,
    isFreeTier: account.isFreeTier,
    fetchedAt: account.fetchedAt,
  };
}

/** A base URL, with a trailing slash removed so path joins stay predictable. */
function normaliseBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return OPENROUTER_DEFAULT_BASE_URL;
  }
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

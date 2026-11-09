/**
 * AIOrchestrator — the one place a turn is started.
 *
 * `Orchestrator` owns the lifecycle: the state machine, approvals, live writing
 * and rollback. This class owns the *dispatch*: which model a given piece of
 * work runs on, starting the turn on the active provider, and writing down what
 * it cost.
 *
 * The split matters because cost recording has to happen exactly once per turn,
 * at a point where the token counts and the model id are both in hand. Scattering
 * that across the three call sites inside `Orchestrator` would make it possible
 * for a new call site to forget, and a silently missing row in a cost dashboard
 * is worse than no dashboard.
 *
 * Deliberately free of any `vscode` import, like the rest of the domain layer:
 * the budget warning is delivered through a callback the extension wires to a UI
 * message, so this class stays testable in plain Node.
 */

import { RuntimeError } from '../core/errors';
import { computeCost, snapshotPricing } from '../pricing/CostCalculator';
import type { UsageTracker } from '../pricing/UsageTracker';
import type { ProviderRegistry } from '../providers/ProviderRegistry';
import type { ModelRegistry } from '../models/ModelRegistry';
import type { ModelSelectionService } from '../models/ModelSelectionService';
import type { AITurnHandle, AITurnRequest } from '../types/provider';
import type { Logger, SessionStreamCallbacks, TurnResult } from '../types';
import type { ModelTaskId, ResolvedModel } from '../types/providerConfig';

export interface AIOrchestratorDeps {
  providers: ProviderRegistry;
  selection: ModelSelectionService;
  catalog: ModelRegistry;
  usage: UsageTracker;
  logger: Logger;
  /** The current workspace root, used for the project selection level and costs. */
  workspaceRoot(): string | null;
  /** The active session id, so per-session totals are meaningful. */
  sessionId(): string | null;
  /** Budget ceiling in USD. `0` disables the warning entirely. */
  budgetUsd(): number;
  /**
   * Called when spend first crosses the budget in this session.
   *
   * A notification, never a gate: PairPilot does not block a request on a
   * spending limit unless the developer has explicitly asked it to, and this
   * callback is where the extension decides how to say so.
   */
  onBudgetExceeded?(spentUsd: number, limitUsd: number): void;
  now?(): number;
  newId?(): string;
}

export interface StartTurnOptions {
  /** The workflow making the request: `coding`, `code-review`, and so on. */
  role: ModelTaskId;
  /** A per-task override id, consulted before the role. */
  taskId?: string | null;
  prompt: string;
  cwd: string;
  resumeSessionId?: string;
  history?: readonly { readonly role: 'user' | 'assistant'; readonly text: string }[];
  timeoutMs: number;
  scanCode: boolean;
  callbacks: SessionStreamCallbacks;
  /** The developer's request text, stored with the cost record. */
  taskLabel?: string | null;
}

export class AIOrchestrator {
  /** Guards against repeating the budget warning on every subsequent turn. */
  private budgetWarned = false;

  constructor(private readonly deps: AIOrchestratorDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** The model a piece of work will run on, and why. */
  resolveModel(role: ModelTaskId, taskId?: string | null): ResolvedModel {
    return this.deps.selection.resolve({
      roleId: role,
      taskId: taskId ?? null,
      projectPath: this.deps.workspaceRoot(),
    });
  }

  /**
   * The model id to send, or null when the provider's own default applies.
   *
   * A local CLI selects its own model, so naming one here would be meaningless —
   * and ignored — for the CLI. Only a remote provider takes the selection. The
   * management UI states this, so a developer who sets a model while the CLI is
   * active is not misled into thinking it applies.
   */
  private modelForTurn(role: ModelTaskId, taskId?: string | null): string | null {
    if (!this.activeProviderIsRemote()) {
      return null;
    }
    return this.resolveModel(role, taskId).modelId;
  }

  /** True when the active provider talks to a service rather than a local CLI. */
  private activeProviderIsRemote(): boolean {
    const provider = this.deps.providers.tryActive();
    return provider !== null && provider.id !== 'claude-code';
  }

  /** Whether the active provider reports itself usable right now. */
  isActiveAvailable(): boolean {
    return this.deps.providers.isActiveAvailable();
  }

  /**
   * Start a turn and record what it cost.
   *
   * The returned handle is the provider's, with only `result` wrapped — so
   * `cancel()` and `isRunning` keep their exact semantics and the Orchestrator's
   * existing cancellation logic needs no change.
   */
  startTurn(options: StartTurnOptions): AITurnHandle {
    const provider = this.deps.providers.active();
    // Throws with the provider's own actionable message before any state moves.
    provider.requireAvailable();

    const model = this.modelForTurn(options.role, options.taskId);
    const startedAt = this.now();

    const request: AITurnRequest = {
      prompt: options.prompt,
      cwd: options.cwd,
      ...(model !== null ? { model } : {}),
      ...(options.resumeSessionId !== undefined ? { resumeSessionId: options.resumeSessionId } : {}),
      // Only a stateless provider needs the history. Sending it to one that
      // resumes a server-side thread would bill the developer for the same
      // conversation twice.
      ...(this.activeProviderIsRemote() && options.history !== undefined && options.history.length > 0
        ? { history: options.history }
        : {}),
      timeoutMs: options.timeoutMs,
      scanCode: options.scanCode,
      callbacks: options.callbacks,
      logger: this.deps.logger,
    };

    const handle = provider.startTurn(request);
    const durationMs = (): number => this.now() - startedAt;

    const result = handle.result.then(
      async (turn) => {
        await this.record(provider.id, model, options, turn, durationMs());
        return turn;
      },
      async (error: unknown) => {
        // A turn that threw produced no usage and no text, so there is nothing
        // to bill and nothing to record. Recording a zero-cost row would inflate
        // the request count with a call that never completed.
        throw error;
      }
    );

    return {
      result,
      cancel: () => handle.cancel(),
      get isRunning(): boolean {
        return handle.isRunning;
      },
    };
  }

  /**
   * Write the usage record for a completed turn.
   *
   * A turn is recorded when the provider reported usage *or* it produced text.
   * The second case matters: a stream that dies after emitting half an answer
   * was still billed, and omitting it would understate spend.
   */
  private async record(
    providerId: 'claude-code' | 'openrouter',
    requestedModel: string | null,
    options: StartTurnOptions,
    turn: TurnResult,
    durationMs: number
  ): Promise<void> {
    const usage = turn.usage;
    const reportedModel = usage.model ?? requestedModel;

    if (!usage.available && turn.text.length === 0) {
      return;
    }

    // The catalogue entry does double duty here: its prices price the turn, and
    // its *existence* is what makes "recently used" mean anything. A model the
    // catalogue does not carry — the CLI's own, for instance — is not one the
    // Model Explorer could offer back, so a recent pick is only recorded for a
    // model the Explorer could actually show.
    const entry = reportedModel === null ? null : this.deps.catalog.get(reportedModel);
    const pricing = entry?.pricing ?? null;
    const at = this.now();

    const cost = computeCost({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cacheReadTokens,
      reportedCostUsd: usage.costUsd,
      pricing,
      modelId: reportedModel,
    });

    try {
      await this.deps.usage.record({
        providerId,
        modelId: reportedModel,
        role: options.role,
        task: options.taskLabel ?? null,
        sessionId: this.deps.sessionId(),
        projectPath: this.deps.workspaceRoot(),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cacheReadTokens,
        reasoningTokens: usage.reasoningTokens ?? 0,
        durationMs,
        usageAvailable: usage.available,
        cost,
        pricing: snapshotPricing(reportedModel, pricing, at),
        generationId: turn.generationId ?? null,
        at,
      });

      // A completed turn on a catalogue model is what "recently used" records.
      // Only reached once the usage row is written, so the quick-pick list and
      // the cost history always agree about which models have done work.
      if (entry !== null && reportedModel !== null) {
        try {
          await this.deps.catalog.markUsed(reportedModel);
        } catch (error) {
          // Caught separately from the usage row, which is already written:
          // reporting this as "could not record usage" would be untrue.
          this.deps.logger.warn(
            `PairPilot could not update its recently-used models: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    } catch (error) {
      // A cost record is bookkeeping. Failing to write one must never surface as
      // a failed turn when the code was already written and approved.
      this.deps.logger.warn(
        `PairPilot could not record usage for this request: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    this.checkBudget();
  }

  /**
   * Warn once per session when spend crosses the configured ceiling.
   *
   * Advisory. Nothing here prevents a request, which is the behaviour the
   * developer opted into by leaving the limit at its default.
   */
  private checkBudget(): void {
    if (this.budgetWarned) {
      return;
    }
    const limit = this.deps.budgetUsd();
    if (!Number.isFinite(limit) || limit <= 0) {
      return;
    }

    const state = this.deps.usage.budget(limit, this.deps.sessionId(), this.deps.workspaceRoot());
    if (!state.exceeded) {
      return;
    }

    this.budgetWarned = true;
    this.deps.onBudgetExceeded?.(state.sessionUsd ?? 0, limit);
  }

  /** Forget the once-per-session budget warning, for a freshly started session. */
  resetBudgetWarning(): void {
    this.budgetWarned = false;
  }

  /** The active provider, for callers that need its status rather than a turn. */
  requireProvider(): void {
    const provider = this.deps.providers.active();
    if (!provider.getStatus().available) {
      throw new RuntimeError(provider.getStatus().message);
    }
  }
}

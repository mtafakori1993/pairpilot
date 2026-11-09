/**
 * OpenRouterProvider — OpenRouter behind the same `AIProvider` interface the
 * Claude Code CLI implements.
 *
 * The Orchestrator, the state machine and the approval workflow are untouched by
 * this class: a turn arrives as an `AITurnRequest` and its text streams back
 * through `onTextDelta`, exactly as the CLI's does. The existing JSON stream
 * scanner, live writer and hash-bound approval all keep working, because they
 * were already transport-independent.
 *
 * Four behaviours here are deliberate and worth knowing before changing them.
 *
 *  **A turn without a selected model is refused, not defaulted.** PairPilot
 *  never silently picks a model — the spec is explicit, and it is also the right
 *  engineering call: a silently-substituted model changes what a request costs
 *  without the developer agreeing to it. The refusal carries the fix.
 *
 *  **A cancellation is not a failure.** `cancel()` produces a normal turn result
 *  with `cancelled: true`. Reporting it as an error would send the Orchestrator
 *  down its failure path and mark a session failed because the developer pressed
 *  stop.
 *
 *  **The token cap is opt-in.** No cap is sent unless the developer sets one,
 *  because a cap PairPilot invented could truncate a file mid-write.
 *
 *  **The key is fetched per request, never cached in a field.** Replacing the
 *  key therefore takes effect on the very next turn, with no reload — and there
 *  is no long-lived copy of the credential sitting in memory for a heap dump or
 *  a crash report to pick up.
 */

import { RuntimeError } from '../core/errors';
import type { AIProvider, AIProviderStatus, AITurnHandle, AITurnRequest } from '../types/provider';
import type { Logger, TokenUsage, TurnResult } from '../types';
import type { ModelMetadata } from '../types/model';
import type { AuthState, ConnectionState } from '../types/providerConfig';
import { SecretManager } from '../security/SecretManager';
import {
  OpenRouterClient,
  OpenRouterError,
  type ChatRequest,
  type OpenRouterKeyInfo,
  type StreamUsage,
} from './OpenRouterClient';

export const OPENROUTER_PROVIDER_ID = 'openrouter' as const;
export const OPENROUTER_PROVIDER_LABEL = 'OpenRouter';
export const OPENROUTER_PROVIDER_DESCRIPTION =
  'Any model OpenRouter serves — Anthropic, OpenAI, Google, Meta and others — through one API key.';

/** Account figures plus when they were read. */
export interface AccountSnapshot extends OpenRouterKeyInfo {
  fetchedAt: number;
}

export interface OpenRouterProviderDeps {
  secrets: SecretManager;
  /** Built per call so a settings change applies without re-activating. */
  createClient(): OpenRouterClient;
  transportAvailable(): { available: boolean; reason?: string };
  /**
   * Look up catalogue metadata for a model id.
   *
   * Used only to choose which output-cap parameter a model accepts; a model that
   * is not in the catalogue simply gets no cap.
   */
  lookupModel?(modelId: string): ModelMetadata | null;
  /** Whether this provider is currently switched on. */
  isEnabled(): boolean;
  /** The model to use when the request does not name one. */
  defaultModel(): string | null;
  /** Output cap in tokens. `0` means "send no cap". */
  maxOutputTokens(): number;
  logger: Logger;
  now?(): number;
}

export class OpenRouterProvider implements AIProvider {
  readonly id = OPENROUTER_PROVIDER_ID;
  readonly label = OPENROUTER_PROVIDER_LABEL;

  private readonly listeners = new Set<(status: AIProviderStatus) => void>();

  private authState: AuthState = 'unconfigured';
  private connectionState: ConnectionState = 'unknown';
  private account: AccountSnapshot | null = null;
  private lastConnectedAt: number | null = null;
  private lastConnectionError: string | null = null;
  private authenticated: boolean | null = null;
  private busy = false;

  constructor(private readonly deps: OpenRouterProviderDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /* ---------------------------------------------------------------------- */
  /* Status                                                                 */
  /* ---------------------------------------------------------------------- */

  getStatus(): AIProviderStatus {
    return {
      id: OPENROUTER_PROVIDER_ID,
      label: OPENROUTER_PROVIDER_LABEL,
      available: this.blocker() === null,
      message: this.statusMessage(),
      // `version` and `executablePath` are omitted entirely: there is no CLI
      // here, and filling them with a placeholder would make a remote provider
      // look like a local one to any consumer that checks them.
      ...(this.connectionState === 'connecting' ? { pending: true } : {}),
    };
  }

  /** Why a turn cannot run, or null when it can. */
  private blocker(): string | null {
    const transport = this.deps.transportAvailable();
    if (!transport.available) {
      return (
        transport.reason ??
        'This VS Code build cannot make outbound HTTPS requests, which OpenRouter needs.'
      );
    }
    if (!this.deps.isEnabled()) {
      return 'OpenRouter is switched off. Turn it on in AI Providers & Models.';
    }
    if (this.authState === 'unconfigured') {
      return 'No OpenRouter API key is stored. Run "PairPilot: Set or Replace Provider API Key", or get one at https://openrouter.ai/keys.';
    }
    if (this.authState === 'invalid') {
      return `OpenRouter rejected the stored API key. ${this.lastConnectionError ?? 'Replace it with "PairPilot: Set or Replace Provider API Key".'}`;
    }
    if (this.deps.defaultModel() === null) {
      return 'No OpenRouter model is selected. Choose one in AI Providers & Models.';
    }
    return null;
  }

  private statusMessage(): string {
    const blocker = this.blocker();
    if (blocker !== null) {
      return blocker;
    }
    const model = this.deps.defaultModel();
    if (this.connectionState === 'connecting') {
      return `Checking the OpenRouter connection…`;
    }
    if (this.lastConnectedAt === null) {
      return `Ready. Key stored, model ${model}. The connection has not been tested yet.`;
    }
    return `Connected to OpenRouter. Model ${model}.`;
  }

  async detect(): Promise<AIProviderStatus> {
    const keySummary = await this.deps.secrets.summary(OPENROUTER_PROVIDER_ID);
    if (!keySummary.present) {
      // Clearing the stored key must be reflected immediately, including in a
      // session where the key was just removed.
      this.authState = 'unconfigured';
      this.connectionState = 'unknown';
      this.authenticated = null;
      this.account = null;
      this.lastConnectedAt = null;
      this.lastConnectionError = null;
      this.emit();
      return this.getStatus();
    }

    const transport = this.deps.transportAvailable();
    if (!transport.available) {
      this.authState = 'stored';
      this.connectionState = 'error';
      this.lastConnectionError = transport.reason ?? 'Outbound HTTPS is unavailable.';
      this.emit();
      return this.getStatus();
    }

    this.connectionState = 'connecting';
    this.emit();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);

    try {
      const info = await this.deps.createClient().getKey(controller.signal);
      this.authState = 'valid';
      this.connectionState = 'connected';
      this.authenticated = true;
      this.account = { ...info, fetchedAt: this.now() };
      this.lastConnectedAt = this.now();
      this.lastConnectionError = null;
    } catch (error) {
      this.connectionState = 'error';
      this.lastConnectionError = describeFailure(error);
      // Only an authentication failure marks the key itself as bad. A timeout or
      // a 502 says nothing about the key, and flagging it as invalid would send
      // the developer off to regenerate a perfectly good credential.
      this.authState =
        error instanceof OpenRouterError && error.kind === 'auth' ? 'invalid' : 'stored';
      this.authenticated = false;
    } finally {
      clearTimeout(timer);
      this.emit();
    }

    return this.getStatus();
  }

  requireAvailable(): void {
    const blocker = this.blocker();
    if (blocker !== null) {
      throw new RuntimeError(blocker);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Turn                                                                   */
  /* ---------------------------------------------------------------------- */

  startTurn(request: AITurnRequest): AITurnHandle {
    // Fail before the Orchestrator changes state, so a misconfiguration cannot
    // leave a session wedged half-way through a turn.
    this.requireAvailable();

    const model = request.model ?? this.deps.defaultModel();
    if (model === null) {
      // Unreachable via `requireAvailable`, but this method may be called
      // directly and must not silently proceed with no model.
      throw new RuntimeError('No OpenRouter model is selected. Choose one in AI Providers & Models.');
    }

    const controller = new AbortController();
    const state = { cancelled: false, timedOut: false };

    const timer = setTimeout(() => {
      state.timedOut = true;
      controller.abort();
    }, request.timeoutMs);

    const promise = this.runTurn(request, model, controller, state).finally(() => {
      clearTimeout(timer);
    });

    return {
      result: promise,
      cancel: () => {
        state.cancelled = true;
        controller.abort();
      },
      get isRunning() {
        return !controller.signal.aborted;
      },
    };
  }

  private async runTurn(
    request: AITurnRequest,
    model: string,
    controller: AbortController,
    state: { cancelled: boolean; timedOut: boolean }
  ): Promise<TurnResult> {
    const startedAt = this.now();
    let text = '';
    let usage: StreamUsage | null = null;
    let generationId: string | null = null;
    let finishReason: string | null = null;

    this.busy = true;
    this.emit();

    try {
      for await (const event of this.deps
        .createClient()
        .chat(this.buildChatRequest(request, model), controller.signal)) {
        switch (event.kind) {
          case 'meta':
            generationId = event.generationId;
            break;
          case 'text':
            text += event.text;
            request.callbacks.onTextDelta(event.text);
            break;
          case 'reasoning':
            request.callbacks.onThinking?.(event.text);
            break;
          case 'usage':
            usage = event.usage;
            break;
          case 'finish':
            finishReason = event.reason;
            break;
        }
      }
    } catch (error) {
      if (state.cancelled) {
        return this.cancelledResult(text, usage, model, startedAt, generationId, request);
      }
      // A timeout aborts the signal, so the transport reports it as a
      // cancellation. The flag distinguishes the two.
      const runtimeError =
        state.timedOut
          ? new RuntimeError(
              `OpenRouter did not finish within ${Math.round(request.timeoutMs / 1000)}s. Raise "pairpilot.runtime.timeoutMs", or choose a faster model.`
            )
          : toRuntimeError(error);

      if (text.length > 0) {
        // Partial output is already streaming into the developer's editor, so it
        // is handed back rather than discarded; the Orchestrator decides what to
        // do with a failed turn that produced content.
        return {
          text,
          usage: toTokenUsage(usage, model),
          isError: true,
          errorMessage: runtimeError.message,
          cancelled: false,
          ...(generationId !== null ? { generationId } : {}),
        };
      }
      throw runtimeError;
    } finally {
      this.busy = false;
      this.emit();
    }

    if (state.cancelled) {
      return this.cancelledResult(text, usage, model, startedAt, generationId, request);
    }

    // A reasoning model that spends its whole budget thinking returns an empty
    // message with `finish_reason: "length"`. That is a real and confusing
    // outcome, so it is named rather than reported as an empty success.
    if (text.length === 0 && finishReason === 'length') {
      return {
        text: '',
        usage: toTokenUsage(usage, model),
        isError: true,
        errorMessage:
          'OpenRouter returned no text because the model used its entire output budget on reasoning. Set "pairpilot.providers.openrouter.maxOutputTokens" higher, or choose a model without a reasoning budget.',
        cancelled: false,
        ...(generationId !== null ? { generationId } : {}),
      };
    }

    return {
      text,
      usage: toTokenUsage(usage, model),
      isError: false,
      cancelled: false,
      // No session id is returned: OpenRouter has no server-side thread to
      // resume, which is why `history` is sent with each request instead.
      ...(generationId !== null ? { generationId } : {}),
    };
  }

  private cancelledResult(
    text: string,
    usage: StreamUsage | null,
    model: string,
    _startedAt: number,
    generationId: string | null,
    request: AITurnRequest
  ): TurnResult {
    request.callbacks.onDiagnostic?.('The OpenRouter request was cancelled.');
    return {
      text,
      usage: toTokenUsage(usage, model),
      isError: false,
      cancelled: true,
      ...(generationId !== null ? { generationId } : {}),
    };
  }

  private buildChatRequest(request: AITurnRequest, model: string): ChatRequest {
    return {
      model,
      ...(request.history !== undefined && request.history.length > 0
        ? { history: request.history }
        : {}),
      prompt: request.prompt,
      tokenCap: this.resolveTokenCap(model),
    };
  }

  /**
   * Which output-cap parameter, if any, this request should carry.
   *
   * `max_completion_tokens` is the documented current name and `max_tokens` the
   * deprecated one, and they share a budget — but a model that advertises only
   * one of the two can reject the other. The catalogue's own
   * `supported_parameters` list settles it, which is the only reason this method
   * needs the model metadata at all.
   */
  private resolveTokenCap(modelId: string): ChatRequest['tokenCap'] {
    const requested = this.deps.maxOutputTokens();
    if (!Number.isFinite(requested) || requested <= 0) {
      // No cap was asked for. The provider's own default applies, and PairPilot
      // has not silently imposed a limit that could truncate a file.
      return null;
    }

    const parameters = this.deps.lookupModel?.(modelId)?.capabilities.supportedParameters ?? [];
    if (parameters.includes('max_tokens') && !parameters.includes('max_completion_tokens')) {
      return { parameter: 'max_tokens', value: Math.trunc(requested) };
    }
    // `max_completion_tokens` is the documented spelling, so it is the default
    // when the catalogue does not say otherwise.
    return { parameter: 'max_completion_tokens', value: Math.trunc(requested) };
  }

  /* ---------------------------------------------------------------------- */
  /* Container plumbing                                                     */
  /* ---------------------------------------------------------------------- */

  onDidChangeStatus(listener: (status: AIProviderStatus) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  dispose(): void {
    this.listeners.clear();
  }

  private emit(): void {
    const status = this.getStatus();
    for (const listener of this.listeners) {
      listener(status);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* State for the management UI                                            */
  /* ---------------------------------------------------------------------- */

  /** Mark the connection as being re-tested, so the UI can show progress. */
  markConnecting(): void {
    this.connectionState = 'connecting';
    this.emit();
  }

  /** Record that a key was stored, without claiming it has been verified. */
  markKeyStored(): void {
    this.authState = 'stored';
    this.connectionState = 'unknown';
    this.authenticated = null;
    this.lastConnectionError = null;
    this.emit();
  }

  /** Record that the key was removed. */
  markKeyCleared(): void {
    this.authState = 'unconfigured';
    this.connectionState = 'unknown';
    this.authenticated = null;
    this.account = null;
    this.lastConnectedAt = null;
    this.lastConnectionError = null;
    this.emit();
  }

  /** Notify listeners after something outside this class changed the config. */
  refresh(): void {
    this.emit();
  }

  snapshotState(): {
    authState: AuthState;
    connectionState: ConnectionState;
    authenticated: boolean | null;
    account: AccountSnapshot | null;
    lastConnectedAt: number | null;
    lastConnectionError: string | null;
    busy: boolean;
  } {
    return {
      authState: this.authState,
      connectionState: this.connectionState,
      authenticated: this.authenticated,
      account: this.account,
      lastConnectedAt: this.lastConnectedAt,
      lastConnectionError: this.lastConnectionError,
      busy: this.busy,
    };
  }
}

/* -------------------------------------------------------------------------- */

/**
 * Map OpenRouter's usage block onto PairPilot's shared `TokenUsage`.
 *
 * `available` is false when the provider sent no usage block at all, which is
 * what makes the cost dashboard able to say "usage unavailable" instead of
 * showing a row of zeroes that reads as a free request.
 */
export function toTokenUsage(usage: StreamUsage | null, model: string): TokenUsage {
  if (usage === null) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: null,
      available: false,
      model,
      reasoningTokens: 0,
    };
  }

  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cachedTokens,
    cacheCreationTokens: usage.cacheWriteTokens,
    // The provider's own figure, carried through untouched. Computing a cost
    // here would blur reported and estimated, which the dashboard keeps apart.
    costUsd: usage.reportedCostUsd,
    available: true,
    model,
    reasoningTokens: usage.reasoningTokens,
  };
}

/** Present a client failure as the `RuntimeError` callers already handle. */
export function toRuntimeError(error: unknown): RuntimeError {
  if (error instanceof RuntimeError) {
    return error;
  }
  if (error instanceof OpenRouterError) {
    return new RuntimeError(error.message);
  }
  return new RuntimeError(error instanceof Error ? error.message : String(error));
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

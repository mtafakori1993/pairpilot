/**
 * ClaudeCodeProvider — the existing CLI runtime, expressed through `AIProvider`.
 *
 * This class is a pure adapter. It owns no protocol logic: NDJSON parsing,
 * cancellation and usage extraction all stay in `ClaudeSession`, where they are
 * already verified against the real CLI. The value of the class is entirely in
 * what it removes — the Orchestrator stops knowing that a CLI exists.
 *
 * The CLI-specific knobs (`--bare`, extra arguments) are read *here* rather than
 * passed down from the Orchestrator, because they are meaningless to any other
 * provider. `ClaudeCodeRuntime` already takes its configured path as a thunk for
 * the same reason: a settings change must apply without re-activating.
 */

import { ClaudeSession, type ClaudeSessionOptions } from '../runtime/ClaudeSession';
import type { Logger, RuntimeStatus, TurnResult } from '../types';
import type { AIProvider, AIProviderStatus, AITurnHandle, AITurnRequest } from './AIProvider';

export const CLAUDE_CODE_PROVIDER_ID = 'claude-code' as const;

export const CLAUDE_CODE_PROVIDER_LABEL = 'Claude Code';

/** The part of `ClaudeCodeRuntime` this adapter depends on. */
export interface ClaudeRuntimeLike {
  getStatus(): RuntimeStatus;
  detect(): Promise<RuntimeStatus>;
  requireExecutable(): string;
  onDidChangeStatus(listener: (status: RuntimeStatus) => void): { dispose(): void };
}

/** The part of `ClaudeSession` this adapter depends on. */
export interface ClaudeSessionLike {
  run(): Promise<TurnResult>;
  cancel(): void;
  readonly isRunning: boolean;
}

export interface ClaudeCodeProviderDeps {
  runtime: ClaudeRuntimeLike;
  logger: Logger;
  /** CLI options, read lazily so a settings change applies to the next turn. */
  cliOptions(): { bare: boolean; extraArgs: readonly string[] };
  /**
   * Test seam. Defaults to the real `ClaudeSession`, which spawns a process; the
   * unit tests substitute a fake so the suite never shells out.
   */
  createSession?(options: ClaudeSessionOptions): ClaudeSessionLike;
}

export class ClaudeCodeProvider implements AIProvider {
  readonly id = CLAUDE_CODE_PROVIDER_ID;
  readonly label = CLAUDE_CODE_PROVIDER_LABEL;

  private readonly listeners = new Set<(status: AIProviderStatus) => void>();
  private readonly runtimeSubscription: { dispose(): void };

  constructor(private readonly deps: ClaudeCodeProviderDeps) {
    // Re-publish runtime status changes in provider terms, so that consumers
    // only ever have to understand one vocabulary.
    this.runtimeSubscription = deps.runtime.onDidChangeStatus(() => this.emit());
  }

  getStatus(): AIProviderStatus {
    return toProviderStatus(this.deps.runtime.getStatus());
  }

  async detect(): Promise<AIProviderStatus> {
    // `detect()` on the runtime never throws; a missing CLI is a normal state.
    return toProviderStatus(await this.deps.runtime.detect());
  }

  requireAvailable(): void {
    // `requireExecutable` already throws a `RuntimeError` carrying the runtime's
    // own actionable message. Re-wrapping it would only lose detail.
    this.deps.runtime.requireExecutable();
  }

  startTurn(request: AITurnRequest): AITurnHandle {
    // Fail here rather than inside the session, so that a missing CLI surfaces
    // before the Orchestrator has changed state.
    const executablePath = this.deps.runtime.requireExecutable();
    const { bare, extraArgs } = this.deps.cliOptions();

    const options: ClaudeSessionOptions = {
      executablePath,
      cwd: request.cwd,
      prompt: request.prompt,
      ...(request.resumeSessionId !== undefined
        ? { resumeSessionId: request.resumeSessionId }
        : {}),
      bare,
      // Copied, so a later mutation of the settings array cannot alter a turn
      // that has already started.
      extraArgs: [...extraArgs],
      timeoutMs: request.timeoutMs,
      scanCode: request.scanCode,
      callbacks: request.callbacks,
      ...(request.logger !== undefined ? { logger: request.logger } : {}),
    };

    const session = this.deps.createSession
      ? this.deps.createSession(options)
      : new ClaudeSession(options);

    return {
      result: session.run(),
      cancel: () => session.cancel(),
      get isRunning(): boolean {
        return session.isRunning;
      },
    };
  }

  onDidChangeStatus(listener: (status: AIProviderStatus) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  dispose(): void {
    this.runtimeSubscription.dispose();
    this.listeners.clear();
  }

  private emit(): void {
    const status = this.getStatus();
    for (const listener of this.listeners) {
      listener(status);
    }
  }
}

/** Map the CLI runtime's status onto the provider-neutral shape. */
export function toProviderStatus(status: RuntimeStatus): AIProviderStatus {
  return {
    id: CLAUDE_CODE_PROVIDER_ID,
    label: CLAUDE_CODE_PROVIDER_LABEL,
    available: status.available,
    message: status.message,
    // Each optional field is omitted rather than defaulted, so the UI can tell
    // "not reported" apart from "reported as empty".
    ...(status.version !== undefined ? { version: status.version } : {}),
    ...(status.executablePath !== undefined ? { executablePath: status.executablePath } : {}),
    ...(status.pending !== undefined ? { pending: status.pending } : {}),
  };
}

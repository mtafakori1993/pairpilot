/**
 * Provider-abstraction types.
 *
 * PairPilot began by driving exactly one backend — the Claude Code CLI — through
 * a concrete class that the Orchestrator imported directly. These types put an
 * interface at that seam, so a second provider can be added without the
 * Orchestrator, the state machine or the approval workflow learning about it.
 *
 * Deliberately free of any `vscode` import, like the rest of `types/`, so the
 * contract and its implementations are unit-testable in plain Node.
 */

import type { Logger, SessionStreamCallbacks, TurnResult } from './index';

/** Identifier of a selectable AI backend. */
export type ProviderId = 'claude-code' | 'openrouter';

/**
 * A provider's current usability, in provider-neutral terms.
 *
 * `message` is always safe to display and must never contain a credential.
 */
export interface AIProviderStatus {
  readonly id: ProviderId;
  /** Human-readable name, e.g. "Claude Code". */
  readonly label: string;
  readonly available: boolean;
  /** Explanation shown to the developer, whether available or not. */
  readonly message: string;
  /** Reported version, when the provider can determine one. Never invented. */
  readonly version?: string;
  /**
   * A local executable path, for providers that drive a process.
   * Remote providers leave this unset rather than putting something else here.
   */
  readonly executablePath?: string;
  /** True while a `detect()` has not settled yet. */
  readonly pending?: boolean;
}

/**
 * One turn's worth of work, described without reference to any transport.
 *
 * Note what is absent: no CLI flags, no model name, no credentials. Those are
 * provider business, and a request that carried them would leak one provider's
 * vocabulary into every other.
 */
export interface AITurnRequest {
  /** The full prompt. Sent out-of-band (stdin or request body), never in `argv`. */
  readonly prompt: string;
  /** Directory the work relates to: the workspace root. */
  readonly cwd: string;
  /**
   * The model this turn should run on, resolved by `ModelSelectionService`.
   *
   * Absent means "whatever the provider defaults to" — which is the correct
   * meaning for a local CLI that has its own notion of a default, and must stay
   * distinguishable from "the user explicitly chose the default model".
   */
  readonly model?: string;
  /** Opaque continuation token from an earlier turn, when the provider supports it. */
  readonly resumeSessionId?: string;
  /**
   * Recent conversation, for providers that cannot resume a session.
   *
   * A stateless HTTP provider has no server-side thread to continue, so a
   * follow-up question would otherwise arrive with no memory of the previous
   * turn. Providers that *can* resume ignore this — passing both would duplicate
   * the history and waste tokens.
   */
  readonly history?: readonly { readonly role: 'user' | 'assistant'; readonly text: string }[];
  readonly timeoutMs: number;
  /** Ask for incremental `blocks[].code` extraction, for live writing. */
  readonly scanCode: boolean;
  readonly callbacks: SessionStreamCallbacks;
  readonly logger?: Pick<Logger, 'warn' | 'diagnostic'>;
}

/** A turn in flight. */
export interface AITurnHandle {
  /** Settles when the turn ends, however it ends. */
  readonly result: Promise<TurnResult>;
  /** Abort the turn. Safe to call repeatedly, and after it has settled. */
  cancel(): void;
  readonly isRunning: boolean;
}

/**
 * An AI backend.
 *
 * Implementations must not import `vscode`. Everything here is host-agnostic, and
 * keeping it that way is what lets a provider be tested without an editor, and
 * without a network.
 */
export interface AIProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** Last known status. Cheap: never performs I/O. */
  getStatus(): AIProviderStatus;
  /**
   * Establish current availability, doing whatever check this provider needs —
   * probing for an executable, validating a key. Never throws: an unavailable
   * provider is a normal, displayable state.
   */
  detect(): Promise<AIProviderStatus>;
  /**
   * Throw a `RuntimeError` with an actionable message when the provider cannot
   * run a turn right now. Callers use this to fail before changing state.
   */
  requireAvailable(): void;
  /** Start one turn. */
  startTurn(request: AITurnRequest): AITurnHandle;
  onDidChangeStatus(listener: (status: AIProviderStatus) => void): { dispose(): void };
  dispose?(): void;
}

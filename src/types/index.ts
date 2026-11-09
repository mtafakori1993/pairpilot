/**
 * Shared type definitions for PairPilot.
 *
 * This module is deliberately dependency-free (no `vscode` import) so that every
 * other module — including pure-unit tests — can depend on it.
 */

import type { CodeProposalMessage, ProposalChange } from '../protocol/types';

/* -------------------------------------------------------------------------- */
/* State machine                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The PairPilot lifecycle. The Extension Host owns this; the Webview only
 * renders it (see `docs` in Orchestrator).
 *
 * Note on ordering: spec step 8 asks for "ask permission to create the file"
 * *before* the file exists. `WAITING_FILE_APPROVAL` therefore means "nothing has
 * been written yet". The file is created empty only once that gate is passed, so
 * a rejection at this point leaves the workspace untouched.
 */
export enum PairPilotState {
  IDLE = 'IDLE',
  ANALYZING = 'ANALYZING',
  PROPOSING = 'PROPOSING',
  WAITING_FILE_APPROVAL = 'WAITING_FILE_APPROVAL',
  CREATING_FILE = 'CREATING_FILE',
  WRITING_CODE = 'WRITING_CODE',
  REVIEWING = 'REVIEWING',
  WAITING_CODE_APPROVAL = 'WAITING_CODE_APPROVAL',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  REQUESTING_CHANGES = 'REQUESTING_CHANGES',
  ANALYZING_NEXT_STEP = 'ANALYZING_NEXT_STEP',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

/** Terminal states accept no further automatic progress. */
export const TERMINAL_STATES: readonly PairPilotState[] = [
  PairPilotState.APPROVED,
  PairPilotState.REJECTED,
  PairPilotState.COMPLETED,
  PairPilotState.FAILED,
  PairPilotState.CANCELLED,
];

/**
 * The only legal state transitions. Anything not listed here is rejected by
 * `StateMachine.transition`, which makes illegal flows (for example approving a
 * proposal that was never written) impossible rather than merely discouraged.
 */
export const STATE_TRANSITIONS: Readonly<Record<PairPilotState, readonly PairPilotState[]>> = {
  [PairPilotState.IDLE]: [
    PairPilotState.ANALYZING,
    PairPilotState.FAILED,
    PairPilotState.CANCELLED,
  ],
  [PairPilotState.ANALYZING]: [
    PairPilotState.PROPOSING,
    PairPilotState.REJECTED,
    PairPilotState.FAILED,
    PairPilotState.CANCELLED,
  ],
  [PairPilotState.PROPOSING]: [
    PairPilotState.WAITING_FILE_APPROVAL,
    // A reply that carried words and no change ends the turn here. Without this
    // edge a conversational answer left the machine parked in PROPOSING — busy,
    // so the composer stayed locked and the developer could not ask anything
    // else. Answering is a completion, not a rejection.
    PairPilotState.COMPLETED,
    PairPilotState.REJECTED,
    PairPilotState.FAILED,
    PairPilotState.CANCELLED,
  ],
  [PairPilotState.WAITING_FILE_APPROVAL]: [
    PairPilotState.CREATING_FILE,
    PairPilotState.REJECTED,
    PairPilotState.CANCELLED,
    PairPilotState.FAILED,
  ],
  [PairPilotState.CREATING_FILE]: [
    PairPilotState.WRITING_CODE,
    PairPilotState.FAILED,
    PairPilotState.CANCELLED,
  ],
  [PairPilotState.WRITING_CODE]: [
    PairPilotState.REVIEWING,
    PairPilotState.WAITING_CODE_APPROVAL,
    PairPilotState.FAILED,
    PairPilotState.CANCELLED,
  ],
  [PairPilotState.REVIEWING]: [
    PairPilotState.WAITING_CODE_APPROVAL,
    PairPilotState.FAILED,
    PairPilotState.CANCELLED,
  ],
  [PairPilotState.WAITING_CODE_APPROVAL]: [
    PairPilotState.APPROVED,
    PairPilotState.REJECTED,
    PairPilotState.REQUESTING_CHANGES,
    PairPilotState.CANCELLED,
    PairPilotState.FAILED,
  ],
  [PairPilotState.APPROVED]: [
    PairPilotState.ANALYZING_NEXT_STEP,
    PairPilotState.COMPLETED,
    // A multi-file proposal is applied one file at a time. Approving the code of
    // one file therefore leads straight back to the *file* permission gate for
    // the next, which is the only transition that makes a change set possible
    // without inventing a second approval mechanism alongside the first.
    PairPilotState.WAITING_FILE_APPROVAL,
  ],
  [PairPilotState.REQUESTING_CHANGES]: [
    PairPilotState.ANALYZING,
    PairPilotState.PROPOSING,
    PairPilotState.REJECTED,
    PairPilotState.FAILED,
    PairPilotState.CANCELLED,
  ],
  [PairPilotState.ANALYZING_NEXT_STEP]: [
    PairPilotState.COMPLETED,
    PairPilotState.FAILED,
    PairPilotState.CANCELLED,
  ],
  // Terminal states may only be reset into a fresh turn.
  [PairPilotState.REJECTED]: [PairPilotState.IDLE, PairPilotState.ANALYZING],
  [PairPilotState.COMPLETED]: [PairPilotState.IDLE, PairPilotState.ANALYZING],
  [PairPilotState.FAILED]: [PairPilotState.IDLE, PairPilotState.ANALYZING],
  [PairPilotState.CANCELLED]: [PairPilotState.IDLE, PairPilotState.ANALYZING],
};

/* -------------------------------------------------------------------------- */
/* Proposals                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Supported operations. `delete` is intentionally absent from this union and
 * from the validator: deletion cannot be expressed, let alone executed.
 */
export type OperationType = 'create' | 'update';

export const OPERATION_TYPES: readonly OperationType[] = ['create', 'update'];

export interface ProposalBlock {
  /** Stable identifier used by the approval hash and the review UI. */
  id: string;
  /** Free-form kind, e.g. `class`, `function`, `import`, `config`. */
  type: string;
  description: string;
  code: string;
  language?: string;
}

export interface NextStepSuggestion {
  title: string;
  reason: string;
  /** Files this step is expected to touch, if the AI named any. */
  files?: string[];
  /** Whether the step is required for the current code to work. */
  required?: boolean;
}

/** The raw, untrusted shape returned by the AI. */
export interface CodeProposal {
  type: 'code_proposal';
  filePath: string;
  operation: OperationType;
  description: string;
  /** "Why this implementation was chosen" — shown in the review panel. */
  rationale?: string;
  /** Important methods/responsibilities — shown in the review panel. */
  responsibilities?: string[];
  dependencies: string[];
  /** Known risks / edge cases the developer should weigh. */
  potentialProblems?: string[];
  blocks: ProposalBlock[];
  nextStep?: NextStepSuggestion;
}

/**
 * A proposal that has passed validation. `absolutePath` is guaranteed to be
 * inside the workspace root, and `contentHash` binds an approval to the exact
 * bytes that were reviewed.
 */
export interface ValidatedProposal {
  proposal: CodeProposal;
  /** Workspace-relative, POSIX-separated path. */
  relativePath: string;
  /** Absolute path, verified to resolve inside the workspace root. */
  absolutePath: string;
  /**
   * SHA-256 over the operation, the path AND every block's code.
   *
   * Hashing the path as well as the code is deliberate: if only the code were
   * hashed, an attacker (or a compromised model) could swap the target file
   * after approval and keep the hash valid.
   */
  contentHash: string;
  /** Concatenated code, ready to write. */
  assembledCode: string;
  /** Non-fatal issues found during validation. */
  warnings: string[];
}

/** Actions the developer can take on a written proposal. */
export type ApprovalDecision = 'approve' | 'reject' | 'request_changes';

/* -------------------------------------------------------------------------- */
/* Multi-file change sets                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One validated file change.
 *
 * The same guarantees as `ValidatedProposal` — a path inside the workspace, a
 * hash binding the approval to the exact bytes — but for a single member of a
 * multi-file proposal. `ValidatedProposal` remains the per-file shape the
 * writer, the approval manager and the review panel consume; this is the shape
 * the *set* is validated into.
 */
export interface ValidatedChange {
  /** The canonical change, with its `file` normalised to the relative path. */
  change: ProposalChange;
  /** Workspace-relative, POSIX-separated path. */
  relativePath: string;
  /** Absolute path, verified to resolve inside the workspace root. */
  absolutePath: string;
  /** SHA-256 over operation, path and content — the approval binding. */
  contentHash: string;
  /** Content ready to write, with exactly one trailing newline. */
  assembledCode: string;
  /** Non-fatal issues found while validating this change. */
  warnings: string[];
  /**
   * The change's position in the message as the AI sent it.
   *
   * Validation may reorder changes into dependency order, and the stream
   * scanner indexes live code by the *sent* position. Keeping both lets the
   * writer replay the real streamed characters for a change it has moved.
   */
  sourceIndex: number;
}

/**
 * A validated proposal, in dependency order.
 *
 * `changes` is already sorted so that a file is written after everything it
 * declares a dependency on; the model's own order is preserved among
 * independent changes.
 */
export interface ValidatedChangeSet {
  /** The canonical message the set came from. */
  envelope: CodeProposalMessage;
  /** Changes in execution order. */
  changes: ValidatedChange[];
  /** Non-fatal issues found across the set. */
  warnings: string[];
  /** Hash over the ordered per-file hashes, for a group approval. */
  changeSetHash: string;
}

/* -------------------------------------------------------------------------- */
/* Runtime                                                                    */
/* -------------------------------------------------------------------------- */

export interface RuntimeStatus {
  available: boolean;
  /** Resolved executable path, when found. */
  executablePath?: string;
  /** Reported CLI version, when it could be determined. */
  version?: string;
  /** Human-readable explanation when `available` is false. */
  message: string;
  /** True when detection has not completed yet. */
  pending?: boolean;
}

/** Normalised token/cost accounting for one turn or a whole session. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Null when the runtime reported no cost. Never guessed. */
  costUsd: number | null;
  /** False when the runtime supplied no usage data at all. */
  available: boolean;
  model?: string;
  /**
   * Reasoning tokens, when the provider separates them.
   *
   * Carried for the cost record: on a reasoning model these are billed as
   * output, and a cost table that omitted them would understate the total.
   */
  reasoningTokens?: number;
}

export function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: null,
    available: false,
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const bothCostsKnown = a.costUsd !== null && b.costUsd !== null;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    costUsd: bothCostsKnown ? (a.costUsd as number) + (b.costUsd as number) : null,
    available: a.available || b.available,
    model: b.model ?? a.model,
  };
}

/** Events emitted by a single Claude Code turn. */
export interface SessionStreamCallbacks {
  /** Incremental assistant text (real `text_delta` chunks). */
  onTextDelta(delta: string): void;
  /** Incremental `blocks[].code` content, extracted structurally. */
  onCodeDelta(blockIndex: number, delta: string): void;
  /** A completed top-level field such as `filePath`. */
  onField?(name: string, value: string): void;
  /** Assistant reasoning, when the runtime emits it. */
  onThinking?(delta: string): void;
  /** A non-fatal diagnostic from the CLI (usually stderr). */
  onDiagnostic?(line: string): void;
}

export interface TurnResult {
  /** Full assistant text for the turn, as streamed. */
  text: string;
  usage: TokenUsage;
  /** Session id reported by the runtime, for later `--resume`. */
  sessionId?: string;
  /** True when the process exited non-zero or the CLI reported an error. */
  isError: boolean;
  /** Populated when `isError` is true. */
  errorMessage?: string;
  /** True when the turn was ended by `cancel()`. */
  cancelled: boolean;
  /**
   * The provider's own identifier for this generation, when it issues one.
   *
   * Stored on the usage record so a figure in the cost dashboard can be checked
   * against the provider's own reporting of the same request.
   */
  generationId?: string;
}

/* -------------------------------------------------------------------------- */
/* Providers                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The provider contract lives in its own module to keep this file readable, and
 * is re-exported here so that every existing `from '../types'` import keeps
 * working unchanged — including the ones that predate the abstraction.
 */
export type {
  AIProvider,
  AIProviderStatus,
  AITurnHandle,
  AITurnRequest,
  ProviderId,
} from './provider';

/* -------------------------------------------------------------------------- */
/* Models, providers and cost                                                 */
/* -------------------------------------------------------------------------- */

/**
 * As with the provider contract above, these live in their own modules and are
 * re-exported here so that consumers have exactly one import site.
 */export type {
  ModelCapabilities,
  ModelCatalog,
  ModelInputModality,
  ModelMetadata,
  ModelOutputModality,
  ModelPricing,
  ModelQuery,
  ModelQuickFilter,
  ModelSortKey,
} from './model';
export {
  MODEL_INPUT_MODALITIES,
  MODEL_OUTPUT_MODALITIES,
  MODEL_QUICK_FILTERS,
  MODEL_SORT_KEYS,
  emptyCapabilities,
  emptyPricing,
} from './model';

export type {
  AccountInfo,
  AuthState,
  CatalogState,
  ConnectionState,
  ModelAdvice,
  ModelAdviceReason,
  ModelRecommendation,
  ModelRoleDescriptor,
  ModelSelection,
  ModelTaskId,
  ProviderView,
  ResolvedModel,
  SelectionLevel,
} from './providerConfig';
export { MODEL_ROLES, MODEL_TASK_IDS } from './providerConfig';

export type {
  BudgetState,
  CostBreakdown,
  CostSnapshot,
  CostSource,
  PricingSnapshot,
  UsageDayBucket,
  UsageGroup,
  UsageRecord,
  UsageTotals,
} from './usage';
export { emptyTotals, unavailableCost } from './usage';

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  timestamp: number;
  /** Set for assistant turns that produced usage data. */
  usage?: TokenUsage;
  /** Marks streaming placeholders that were never completed. */
  incomplete?: boolean;
}

/** Everything about a proposal that the UI needs to render the review panel. */
export interface ProposalRecord {
  description: string;
  relativePath: string;
  operation: OperationType;
  contentHash: string;
  rationale?: string;
  responsibilities?: string[];
  dependencies: string[];
  potentialProblems?: string[];
  nextStep?: NextStepSuggestion;
  blocks: ProposalBlock[];
}

export interface SessionRecord {
  id: string;
  /** Claude Code session id, used for `--resume`. */
  runtimeSessionId?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  usage: TokenUsage;
  /** Proposals awaiting, or having received, a decision. */
  proposals: ProposalRecord[];
  /** Conflicts recorded when a write was rolled back. */
  rolledBackWrites?: RolledBackWrite[];
}

export interface RolledBackWrite {
  relativePath: string;
  reason: 'cancelled' | 'user_edited' | 'failed' | 'rejected';
  at: number;
  /** True when the file existed before and was restored rather than deleted. */
  restored: boolean;
}

/* -------------------------------------------------------------------------- */
/* Engineering Advisor                                                        */
/* -------------------------------------------------------------------------- */

export interface AdvisorRecommendation {
  title: string;
  reason: string;
  /** Concrete responsibilities the recommended file should have. */
  responsibilities: string[];
  /** Files the recommendation relates to. */
  files: string[];
  /** True when the current code will not work until this is done. */
  required: boolean;
  /** Whether this came from the AI runtime or local static analysis. */
  source: 'ai' | 'local';
}

/* -------------------------------------------------------------------------- */
/* Webview protocol                                                           */
/* -------------------------------------------------------------------------- */

/** Messages sent from the Webview to the Extension Host. */
export type WebviewRequest =
  | { type: 'ready' }
  | { type: 'submitTask'; text: string }
  | { type: 'cancel' }
  | { type: 'approveFileCreation'; contentHash: string }
  | { type: 'rejectFileCreation'; contentHash: string }
  | { type: 'approveCode'; contentHash: string }
  | { type: 'rejectCode'; contentHash: string }
  | { type: 'requestChanges'; contentHash: string; feedback: string }
  | { type: 'acceptRecommendation' }
  | { type: 'dismissRecommendation' }
  | { type: 'newSession' }
  | { type: 'loadSession'; sessionId: string }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'openFile'; relativePath: string }
  | { type: 'addActiveEditorContext' }
  | { type: 'removeContext'; relativePath: string }
  | { type: 'revealOutput' };

/** Snapshot of everything the Webview renders. */
export interface WebviewStateSnapshot {
  state: PairPilotState;
  projectName: string;
  workspaceName: string;
  runtime: RuntimeStatus;
  sessionId: string | null;
  runtimeSessionId: string | null;
  messages: ChatMessage[];
  /** Live assistant text for the turn in progress. */
  streamingText: string;
  /** Live code being extracted from the stream, keyed by block index. */
  streamingCode: string[];
  isStreaming: boolean;
  currentTask: string | null;
  currentStep: string | null;
  pendingApproval: boolean;
  /** Set while `WAITING_FILE_APPROVAL` — the path awaiting permission. */
  pendingFilePath: string | null;
  pendingFileOperation: OperationType | null;
  /** Set while a proposal is written and awaiting a code decision. */
  activeProposal: ProposalRecord | null;
  /**
   * How far through a multi-file set the turn is, or null for a single file.
   *
   * The panel needs this to say "change 2 of 5" and to offer approving the whole
   * set at once, which is only meaningful when there is more than one.
   */
  changeProgress: { index: number; total: number; setId: string } | null;
  /** Every file the proposal intends to write, in the order it will write them. */
  changePlan: { file: string; operation: string; description: string; risk: string }[];
  /**
   * Which kind of work the session is doing, and why.
   *
   * Owned by the extension host and sent down like any other state, never held
   * in the Webview: a panel that decided its own mode could offer an approval
   * button for work the host would refuse, and the mode is precisely the thing
   * that must not be negotiable from the UI.
   */
  workflowMode: { id: string; label: string; summary: string; reason: string };
  usage: TokenUsage;
  /** Explicit context the developer pinned for the next request. */
  pinnedContext: string[];
  /** Files included in the most recent request, for transparency. */
  lastContextFiles: ContextFileSummary[];
  recommendation: AdvisorRecommendation | null;
  sessions: SessionSummary[];
  error: string | null;
  notice: string | null;
}

export interface ContextFileSummary {
  relativePath: string;
  bytes: number;
  truncated: boolean;
  /** True when the developer approved a sensitive file for this request. */
  sensitive: boolean;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  proposalCount: number;
}

/** Messages sent from the Extension Host to the Webview. */
export type HostMessage =
  | { type: 'state'; snapshot: WebviewStateSnapshot }
  | { type: 'textDelta'; text: string }
  | { type: 'codeDelta'; blockIndex: number; text: string }
  | { type: 'writingProgress'; written: number; total: number; relativePath: string }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; message: string };

/* -------------------------------------------------------------------------- */
/* Response protocol                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The canonical AI response contract lives in `src/protocol/`, and is
 * re-exported here so that the domain layer has one import site for types.
 *
 * Only types and constants are re-exported: the runtime pieces (`parseProtocol`,
 * `validateProtocolMessage`) stay in `src/protocol/`, so this module keeps its
 * "no side effects, no logic" character.
 */
export type {
  AdaptationKind,
  ChangeOperation,
  ChangeRisk,
  ChatResponseMessage,
  ClarificationRequestMessage,
  CodeProposalMessage,
  CodeReviewMessage,
  EngineeringAdviceMessage,
  ErrorMessage,
  ExecutableOperation,
  ProposalChange,
  ProposalNextStep,
  ProposalSummary,
  ProposalTask,
  ProtocolEnvelopeBase,
  ProtocolIssue,
  ProtocolIssueCode,
  ProtocolMessage,
  ProtocolMessageType,
  ProjectAnalysisMessage,
  ProjectPlanMessage,
  ReservedOperation,
  TaskStatus,
  TaskUpdateMessage,
} from '../protocol/types';
export {
  ALL_OPERATIONS,
  CHANGE_RISKS,
  EXECUTABLE_OPERATIONS,
  PAIRPILOT_PROTOCOL_VERSION,
  PROTOCOL_MESSAGE_TYPES,
  RESERVED_OPERATIONS,
  SUPPORTED_PROTOCOL_VERSIONS,
  TASK_STATUSES,
} from '../protocol/types';

/* -------------------------------------------------------------------------- */
/* Misc                                                                       */
/* -------------------------------------------------------------------------- */

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
  /** Raw CLI diagnostics, surfaced in the Output channel only. */
  diagnostic(message: string): void;
}

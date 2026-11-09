/**
 * The canonical PairPilot response contract.
 *
 * ## Why this module exists
 *
 * The first release of PairPilot asked the model for a *flat, single-file*
 * shape — `{ type, filePath, operation, blocks[] }` — and recognised a reply as
 * a proposal only when `Array.isArray(reply.blocks)` was true. Models, quite
 * reasonably, answered with the shape the surrounding ecosystem uses for a
 * multi-file change:
 *
 *     { "type": "code_proposal",
 *       "proposal": { "message": "...", "changes": [ { "file": ..., "content": ... } ] } }
 *
 * That reply parses as valid JSON, so the parser reported "Found valid JSON,
 * but it is not a code_proposal object" — a message that blames the model for a
 * mismatch PairPilot created. It also meant a single logical task could never
 * produce more than one file, which is the ordinary case for real work.
 *
 * This module fixes the cause rather than the message. There is now exactly one
 * versioned contract, it is multi-file by construction, and it carries a
 * `type` that says what kind of answer it is — so a greeting is never mistaken
 * for a proposal and a proposal is never rejected for having the wrong depth.
 *
 * ## The rules this module enforces by construction
 *
 *  - **One contract.** There is no second, nested schema to disagree with the
 *    first. Older shapes are *adapted* into this one on arrival (see
 *    `adapt.ts`), never carried alongside it.
 *  - **Nothing executable is trusted.** Every field here is data the model
 *    authored. Validation (see `schema.ts`) and workspace path checks happen
 *    before anything is written.
 *  - **Deletion is not representable.** There is no `delete` operation in the
 *    executable set, so no prompt, parser or validator path can produce one.
 *
 * This file is deliberately import-free so that it can be depended on from the
 * pure-domain layer without pulling in `vscode` or the rest of the extension.
 */

/**
 * The contract version carried on every envelope.
 *
 * Bump the minor part when a new *optional* field or message type is added;
 * bump the major part only when an existing field changes meaning, because a
 * major bump is what makes PairPilot refuse to guess at an unfamiliar reply.
 */
export const PAIRPILOT_PROTOCOL_VERSION = '1.0';

/** The `protocol_version` values this build understands. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [PAIRPILOT_PROTOCOL_VERSION];

/**
 * The version assumed when a reply omits one.
 *
 * A named constant rather than `SUPPORTED_PROTOCOL_VERSIONS[0]` so that an
 * absent version is always a `string`, never `string | undefined` — the contract
 * says every parsed message carries a version, and the type should say so too.
 */
export const DEFAULT_PROTOCOL_VERSION = PAIRPILOT_PROTOCOL_VERSION;

/* -------------------------------------------------------------------------- */
/* Message types                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every kind of answer the model may give.
 *
 * The list is closed on purpose. A reply whose `type` is not one of these is a
 * protocol failure with a clear diagnostic, not something to be reinterpreted —
 * silently coercing an unknown type into a proposal is how a chat answer ends
 * up as a file write.
 */
export const PROTOCOL_MESSAGE_TYPES = [
  /** Ordinary conversation. Carries no changes and must never write a file. */
  'chat_response',
  /** A structured read of an existing project. */
  'project_analysis',
  /** A product/technical plan or roadmap. */
  'project_plan',
  /**
   * Collaborative architecture discussion: components, responsibilities,
   * dependencies, alternatives, open questions.
   *
   * Distinct from `project_plan` because the two are not interchangeable. A plan
   * is a sequence of work; an architecture discussion is a *conversation* about
   * shape, and it ends with the developer being asked to agree — not with a list
   * of tasks. A model asked to "discuss the architecture, do not write code"
   * needs a type it can answer with that is neither a plan nor a proposal.
   * Without one it reached for `code_proposal`, because that was the only type
   * the prompt described as "the thing you produce".
   */
  'architecture_discussion',
  /** One or more file changes awaiting review. */
  'code_proposal',
  /** A review of code that already exists. */
  'code_review',
  /** A recommendation for the next engineering step. */
  'engineering_advice',
  /** A question the model needs answered before it can proceed. */
  'clarification_request',
  /** A change in the status of a tracked task. */
  'task_update',
  /** A structured failure report from the model. */
  'error',
] as const;

export type ProtocolMessageType = (typeof PROTOCOL_MESSAGE_TYPES)[number];

/** The types that are allowed to carry file changes. */
export const CHANGE_BEARING_TYPES: readonly ProtocolMessageType[] = ['code_proposal'];

/* -------------------------------------------------------------------------- */
/* Envelope                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Fields every message carries.
 *
 * `protocol_version` is optional *in the parsed value* but is filled in during
 * adaptation, so downstream code can always read it. It is optional in the
 * canonical type because PairPilot must still accept a model that omits it —
 * refusing a perfectly good proposal over a missing version string would be the
 * same class of mistake as the original bug.
 */
export interface ProtocolEnvelopeBase {
  protocol_version: string;
  type: ProtocolMessageType;
  /**
   * The human-readable answer. For a proposal this is the implementation
   * explanation; for chat it is the reply itself.
   */
  message: string;
}

/* -------------------------------------------------------------------------- */
/* Changes                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Operations PairPilot can actually perform.
 *
 * Kept deliberately short. An operation is only listed here when the extension
 * has a real implementation for it, because advertising one it cannot do is how
 * a review panel ends up offering a button that does nothing.
 */
export const EXECUTABLE_OPERATIONS = ['create', 'update'] as const;
export type ExecutableOperation = (typeof EXECUTABLE_OPERATIONS)[number];

/**
 * Operations the *contract* reserves but this build does not execute.
 *
 * They are recognised so that a model which emits `patch` receives an accurate
 * diagnostic — "PairPilot 1.0 can apply create and update; re-send this change
 * as a full-content update" — instead of a generic "unsupported operation".
 * They are never silently dropped: dropping a valid change without saying so is
 * exactly the failure mode this contract exists to prevent.
 */
export const RESERVED_OPERATIONS = [
  'patch',
  'add_block',
  'modify_method',
  'add_interface',
  'add_tests',
  'update_docs',
  'delete',
] as const;
export type ReservedOperation = (typeof RESERVED_OPERATIONS)[number];

export type ChangeOperation = ExecutableOperation | ReservedOperation;

export const ALL_OPERATIONS: readonly string[] = [...EXECUTABLE_OPERATIONS, ...RESERVED_OPERATIONS];

/** How much care a change deserves during review. */
export const CHANGE_RISKS = ['low', 'medium', 'high'] as const;
export type ChangeRisk = (typeof CHANGE_RISKS)[number];

/**
 * One file change inside a proposal.
 *
 * `content` is always the *complete* final file content for `create`, and the
 * complete replacement content for `update`. There is no partial-patch variant
 * in this build, so the content that was reviewed is byte-for-byte the content
 * that is written — which is what makes the approval hash meaningful.
 */
export interface ProposalChange {
  /** Stable identity, used by the review UI and the approval hash. */
  id: string;
  /** Workspace-relative, POSIX-separated path. Never absolute, never `..`. */
  file: string;
  operation: ChangeOperation;
  /** Best-effort language id, for the review panel's syntax highlighting. */
  language?: string;
  /** One sentence: what this change does. */
  description: string;
  /** The complete file content. */
  content: string;
  /**
   * Paths (workspace-relative) or packages this change depends on.
   *
   * Used to order execution so a file is written after the things it imports,
   * and to report a missing dependency before anything is written.
   */
  dependencies: string[];
  risk: ChangeRisk;
  /** Why this file was written this way, shown in the review panel. */
  rationale?: string;
  /** What the file is responsible for. */
  responsibilities?: string[];
  /** Risks the reviewer should weigh. */
  potentialProblems?: string[];
}

/** Counts shown at the top of the review panel. */
export interface ProposalSummary {
  files_to_create: number;
  files_to_update: number;
  files_to_delete: number;
}

/** Task statuses, mirroring the task board vocabulary. */
export const TASK_STATUSES = [
  'backlog',
  'planned',
  'ready',
  'in_progress',
  'waiting_for_review',
  'approved',
  'completed',
  'blocked',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** The task a proposal is fulfilling. */
export interface ProposalTask {
  title: string;
  description?: string;
  status?: TaskStatus;
}

/** A recommendation for what to do next. */
export interface ProposalNextStep {
  title: string;
  reason: string;
  responsibilities?: string[];
  files?: string[];
  required?: boolean;
  priority?: 'required' | 'recommended' | 'optional';
}

/* -------------------------------------------------------------------------- */
/* Per-type messages                                                          */
/* -------------------------------------------------------------------------- */

/** Ordinary conversation. Never carries changes. */
export interface ChatResponseMessage extends ProtocolEnvelopeBase {
  type: 'chat_response';
  /** Topics the model believes are worth a follow-up, if any. */
  suggestions?: string[];
}

/** A structured read of a project. */
export interface ProjectAnalysisMessage extends ProtocolEnvelopeBase {
  type: 'project_analysis';
  analysis: {
    /** Detected technologies, in the model's own words. */
    stack: string[];
    /** Notable directories or files. */
    structure: string[];
    /** Conventions observed in the existing code. */
    conventions: string[];
    /** What is missing or unclear. */
    gaps: string[];
  };
}

/** A plan: product, technical, or both. */
export interface ProjectPlanMessage extends ProtocolEnvelopeBase {
  type: 'project_plan';
  plan: {
    phases: {
      name: string;
      goal: string;
      tasks: string[];
    }[];
    /** Open questions blocking the plan. */
    questions?: string[];
    risks?: string[];
  };
}

/**
 * A collaborative architecture discussion.
 *
 * Deliberately free of anything executable: there is no path, no operation and
 * no file content here, so a reply of this type cannot be mistaken for work to
 * apply — not by the parser, not by the review panel, and not by a future caller
 * that forgets to check the mode. A directory tree the model sketches while
 * discussing structure has nowhere to live in this shape, which is what stops a
 * conversation about folders from turning into a request to create them.
 */
export interface ArchitectureDiscussionMessage extends ProtocolEnvelopeBase {
  type: 'architecture_discussion';
  /** Requirements the model has understood so far, restated in its own words. */
  requirements?: string[];
  architecture?: {
    /** Named parts of the design. Names and purposes only — never code. */
    components?: { name: string; responsibility: string }[];
    /** Which component depends on which, and why. */
    dependencies?: string[];
    /** Designs that were considered and set aside, with the reason. */
    alternatives?: string[];
  };
  /** Questions the developer should answer before the design is settled. */
  questions?: string[];
  /** The single next topic to settle. Not a task list, not a file. */
  nextStep?: string;
}

/** One or more file changes. The only change-bearing type. */
export interface CodeProposalMessage extends ProtocolEnvelopeBase {
  type: 'code_proposal';
  task?: ProposalTask;
  changes: ProposalChange[];
  summary?: ProposalSummary;
  nextStep?: ProposalNextStep;
}

/** A review of code that already exists. */
export interface CodeReviewMessage extends ProtocolEnvelopeBase {
  type: 'code_review';
  review: {
    verdict: 'pass' | 'concerns' | 'block';
    findings: {
      severity: 'info' | 'warning' | 'error';
      title: string;
      detail: string;
      file?: string;
    }[];
    security?: string[];
    performance?: string[];
    tests?: string[];
  };
}

/** A recommendation for the next engineering step. */
export interface EngineeringAdviceMessage extends ProtocolEnvelopeBase {
  type: 'engineering_advice';
  advice: {
    title: string;
    reason: string;
    responsibilities?: string[];
    files?: string[];
    required?: boolean;
    priority?: 'required' | 'recommended' | 'optional';
  };
}

/** A question that must be answered before work can continue. */
export interface ClarificationRequestMessage extends ProtocolEnvelopeBase {
  type: 'clarification_request';
  clarification: {
    question: string;
    /** Suggested answers, so the developer can reply with one click. */
    options?: string[];
  };
}

/** A status change on a tracked task. */
export interface TaskUpdateMessage extends ProtocolEnvelopeBase {
  type: 'task_update';
  task: {
    title: string;
    status: TaskStatus;
    description?: string;
    notes?: string[];
  };
}

/** A structured failure report. */
export interface ErrorMessage extends ProtocolEnvelopeBase {
  type: 'error';
  error: {
    /** A short machine-readable code, when the model supplies one. */
    code?: string;
    /** What went wrong, beyond `message`. */
    detail?: string;
  };
}

/** The union of every canonical message. */
export type ProtocolMessage =
  | ChatResponseMessage
  | ProjectAnalysisMessage
  | ProjectPlanMessage
  | ArchitectureDiscussionMessage
  | CodeProposalMessage
  | CodeReviewMessage
  | EngineeringAdviceMessage
  | ClarificationRequestMessage
  | TaskUpdateMessage
  | ErrorMessage;

/** Narrow to the change-bearing member. */
export function isCodeProposal(message: ProtocolMessage): message is CodeProposalMessage {
  return message.type === 'code_proposal';
}

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                */
/* -------------------------------------------------------------------------- */

/**
 * How a reply was brought into the canonical shape.
 *
 * Recorded so that a report of "the model keeps answering oddly" can be
 * answered with evidence — which shape arrived, and what was done with it —
 * rather than a guess.
 */
export const ADAPTATION_KINDS = [
  /** Already canonical (possibly after key normalisation). */
  'canonical',
  /** The 0.1.x flat, single-file shape: `filePath` + `blocks[]`. */
  'legacy_flat',
  /** `{ proposal: { changes: [...] } }` — the shape that broke 0.1.x. */
  'nested_proposal',
  /** A root-level `changes[]` array. */
  'flat_changes',
  /** A single change object with no envelope at all. */
  'bare_change',
  /** Nothing JSON-shaped was found; the text was treated as prose. */
  'prose',
] as const;

export type AdaptationKind = (typeof ADAPTATION_KINDS)[number];

/** One thing that is wrong with a candidate reply. */
export interface ProtocolIssue {
  /**
   * Where the problem is, in a form the developer can act on: a JSON pointer
   * (`/changes/2/content`) rather than an internal field index.
   */
  path: string;
  /** What is wrong, stated so it can be fixed without reading the source. */
  message: string;
  /** Stable code, so tests and the retry policy can match precisely. */
  code: ProtocolIssueCode;
}

export const PROTOCOL_ISSUE_CODES = [
  'not_json',
  'not_an_object',
  'missing_field',
  'wrong_type',
  'empty_value',
  'unknown_message_type',
  'unknown_operation',
  'reserved_operation',
  'unsupported_version',
  'too_many_changes',
  'too_large',
  'duplicate_change',
  'invalid_value',
  /**
   * The message was well-formed but is not allowed in the session's current
   * workflow mode. Distinct from `unknown_message_type`, which means PairPilot
   * does not understand the type at all — this one means it understands it
   * perfectly and is declining to act on it, which is a different thing to tell
   * the developer.
   */
  'mode_refusal',
] as const;

export type ProtocolIssueCode = (typeof PROTOCOL_ISSUE_CODES)[number];

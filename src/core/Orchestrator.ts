/**
 * Orchestrator — the authority for a PairPilot turn.
 *
 * Every path that could modify the workspace passes through this class, and
 * every transition is validated by `StateMachine`. The Webview is incapable of
 * causing a write: it can only send a *request*, and this class decides whether
 * the request is legal in the current state. That is what makes spec section 9's
 * "the AI must not modify an approved file without a new explicit approval" a
 * structural property rather than a promise.
 *
 * ## The turn, end to end
 *
 *     IDLE
 *       -> ANALYZING              assemble context; decide what to ask for
 *       -> PROPOSING              request a reply, and read it as a contract
 *       -> WAITING_FILE_APPROVAL  ask permission to write change 1 of N
 *       -> CREATING_FILE          create the empty file / read the original
 *       -> WRITING_CODE           stream real deltas into the real editor
 *       -> REVIEWING              open the review panel for this file
 *       -> WAITING_CODE_APPROVAL  wait for approve / reject / request changes
 *       -> APPROVED               record the decision
 *          ├─ more changes?  -> WAITING_FILE_APPROVAL for the next one
 *          └─ set finished   -> ANALYZING_NEXT_STEP -> COMPLETED
 *
 * ## What changed from 0.1.x, and why
 *
 * A turn no longer *demands* a proposal. It asks for a reply and interprets
 * whatever comes back: a proposal becomes a review queue, a plan or an analysis
 * becomes a message, a recommendation becomes the advisor's suggestion, and a
 * question becomes a question. That is what stops "Hi" from being reported as a
 * protocol failure.
 *
 * A proposal is no longer one file. It is a change set, validated as a unit and
 * then applied in dependency order, one file at a time, through the same
 * permission → write → review machinery a single file has always used. Nothing
 * here bypasses an approval; a change set simply repeats the gate per file.
 *
 * Cancellation is legal from every non-terminal state, and always rolls back an
 * in-progress write so a half-written file is never left behind.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { StateMachine } from './StateMachine';
import { EngineeringAdvisor, type AdvisorInput } from './EngineeringAdvisor';
import { CancelledError, DeclinedError, describeError } from './errors';
import type { AIOrchestrator } from '../orchestration/AIOrchestrator';
import type { ModelTaskId } from '../types/providerConfig';
import {
  buildAdvisorPrompt,
  buildCorrectionPrompt,
  buildProposalPrompt,
  summariseContext,
  type TurnPromptInput,
} from '../runtime/prompts';
import { interpretTurn, renderMessage } from '../proposals/TurnInterpreter';
import { ProposalValidator, toValidatedProposal } from '../proposals/ProposalValidator';
import { ApprovalManager, toProposalRecord } from '../proposals/ApprovalManager';
import { BatchQueue, type BatchFileEntry } from '../proposals/BatchQueue';
import { LiveWriter } from '../editor/LiveWriter';
import type { DiffManager } from '../editor/DiffManager';
import type { WorkspaceContext, ContextBudget } from '../context/WorkspaceContext';
import type { SessionStore } from '../storage/SessionStore';
import { ProtocolDiagnostics, redactSecrets } from '../protocol/diagnostics';
import { expectedTypeHint } from '../protocol/classify';
import {
  WORKFLOW_MODE_META,
  classifyIntention,
  nextMode,
  policyFor,
  refusedProposalReason,
  type TurnIntention,
  type WorkflowMode,
  type WorkflowPolicy,
} from '../protocol/mode';
import { describeProtocolFailure, type ProtocolParseFailure } from '../protocol/parse';
import type { CodeProposalMessage, ProtocolIssue } from '../protocol/types';
import {
  PairPilotState,
  type AdvisorRecommendation,
  type AITurnHandle,
  type BatchViewSnapshot,
  type ChatMessage,
  type ContextFileSummary,
  type DecisionBindingFields,
  type Logger,
  type ProposalRecord,
  type TokenUsage,
  type TurnResult,
  type ValidatedChange,
  type ValidatedChangeSet,
  type ValidatedProposal,
} from '../types';

/** The identity half of a decision, as it arrives from the panel. */
type DecisionBindingInput = DecisionBindingFields | undefined;

export interface OrchestratorDeps {
  context: vscode.ExtensionContext;
  logger: Logger;
  /**
   * The model-aware dispatcher.
   *
   * The Orchestrator no longer starts a turn itself: it asks for one, and this
   * resolves the model, starts it on the active provider, and writes the cost
   * record. That keeps every turn — proposal, revision, retry and advisor —
   * accounted for in one place rather than three.
   */
  ai: AIOrchestrator;
  workspace: WorkspaceContext;
  store: SessionStore;
  diff: DiffManager;
  /** Broadcast a state change to the UI. */
  notify(): void;
  /** Stream a code delta to the UI for the live preview. */
  notifyCodeDelta(blockIndex: number, text: string): void;
  /** Stream assistant text to the UI. */
  notifyTextDelta(text: string): void;
  notifyWritingProgress(written: number, total: number, relativePath: string): void;
  readConfig(): OrchestratorConfig;
}

export interface OrchestratorConfig {
  timeoutMs: number;
  budget: ContextBudget;
  requireSensitiveApproval: boolean;
  allowSensitiveFileContext: boolean;
  advisorEnabled: boolean;
  advisorUseAI: boolean;
}

/**
 * How many prior messages are offered to a provider that cannot resume a
 * session.
 *
 * Enough for a follow-up to make sense, few enough that a long session does not
 * make every subsequent request progressively more expensive — which is exactly
 * the failure mode of replaying a whole transcript.
 */
const HISTORY_MESSAGES = 12;

/**
 * How many times an invalid reply is re-requested before giving up.
 *
 * Two, not more. Each attempt is a billed request, and a model that has failed
 * twice with the exact field-level complaint in front of it is very unlikely to
 * succeed on a third — whereas a developer who is paying for the retries is very
 * likely to notice. The ceiling is the cost control spec 1.3 asks for.
 */
const MAX_PROTOCOL_RETRIES = 2;

export class Orchestrator {
  readonly machine = new StateMachine();
  readonly approvals = new ApprovalManager();

  private readonly validator: ProposalValidator;
  private readonly advisor: EngineeringAdvisor;
  /** Recent replies, redacted and bounded, for the diagnostics report. */
  private readonly protocol = new ProtocolDiagnostics();

  private session: AITurnHandle | null = null;
  private writer: LiveWriter | null = null;
  private activeTurnId = 0;

  /** Live state surfaced to the UI. */
  private streamingText = '';
  private streamingCode: string[] = [];
  private currentTask: string | null = null;
  private currentStep: string | null = null;
  private pendingFilePath: string | null = null;
  private pendingFileOperation: 'create' | 'update' | null = null;
  private activeProposal: ProposalRecord | null = null;
  private recommendation: AdvisorRecommendation | null = null;
  private pinnedContext = new Set<string>();
  private lastContextFiles: ContextFileSummary[] = [];
  private lastAssembled: Awaited<ReturnType<WorkspaceContext['assemble']>> | null = null;
  private error: string | null = null;
  private notice: string | null = null;

  /* --- the change set currently being applied ---------------------------- */

  private changeSet: ValidatedChangeSet | null = null;
  private changeQueue: ValidatedChange[] = [];
  private changeCursor = 0;
  /** True once the developer approved every remaining file in one action. */
  private approvedWholeSet = false;
  /** Files written by the set in progress, so a failure can undo all of them. */
  private appliedThisSet: { relativePath: string; operation: 'create' | 'update' }[] = [];

  /**
   * The durable record of the batch in flight.
   *
   * `changeQueue` remains the ordered list of content the writer consumes, but
   * it is no longer the *record* of what the developer authorised: that is this.
   * The distinction matters because the queue's lifetime is "until the next
   * thing happens", while a batch's must be "until every file has been dealt
   * with" — a revision to one file must not erase the promise made about the
   * other six.
   */
  private batch: BatchQueue | null = null;

  /**
   * The file a revision turn is being run for, if any.
   *
   * It is what tells `stageProposal` that the proposal about to arrive is a
   * *revision of one file* rather than a fresh set of files. Without it the only
   * thing the staging code can do is treat the reply as a new proposal — which
   * is how revising one file used to discard the rest of the batch.
   */
  private revisingPath: string | null = null;

  /**
   * The file currently being streamed into the editor, if any.
   *
   * Held so that "stop, I want this different" can be answered *during* a write:
   * the partial content has to be taken back off disk, and the proposal it came
   * from is the one the revision is about.
   */
  private writingProposal: ValidatedProposal | null = null;

  /** True while the developer has paused the stream into the editor. */
  private writePaused = false;

  /* --- which kind of work this session is doing -------------------------- */

  /**
   * The workflow mode, owned here rather than in the Webview.
   *
   * Started at `discovery` because that is the honest default: a session that
   * has just opened knows nothing about what the developer wants, and assuming
   * "coding" is what made a planning request produce a proposal. It is *session*
   * state, not turn state, so it survives from one turn to the next and is what
   * lets "yes, that design is right" move the session along.
   */
  private mode: WorkflowMode = 'discovery';
  /** Why the mode is what it is, so it can be shown rather than assumed. */
  private modeReason = 'A new session starts by finding out what you want to build.';
  /** The classification for the turn in flight, used by the pre-write gate. */
  private turnIntention: TurnIntention | null = null;

  /** Pre-write content, so an `update` can be restored after the writer is gone. */
  private readonly previousContentByPath = new Map<string, string>();

  constructor(private readonly deps: OrchestratorDeps) {
    this.validator = new ProposalValidator(deps.workspace.pathGuard);
    this.advisor = new EngineeringAdvisor({
      workspaceRoot: deps.workspace.workspaceRoot,
      logger: deps.logger,
    });
    this.machine.onDidChange(() => this.deps.notify());
  }

  /* ---------------------------------------------------------------------- */
  /* Read-only accessors used by the UI provider                            */
  /* ---------------------------------------------------------------------- */

  get streamingTextValue(): string {
    return this.streamingText;
  }

  get streamingCodeValue(): string[] {
    return this.streamingCode;
  }

  get currentTaskValue(): string | null {
    return this.currentTask;
  }

  get currentStepValue(): string | null {
    return this.currentStep;
  }

  get pendingFilePathValue(): string | null {
    return this.pendingFilePath;
  }

  get pendingFileOperationValue(): 'create' | 'update' | null {
    return this.pendingFileOperation;
  }

  get activeProposalValue(): ProposalRecord | null {
    return this.activeProposal;
  }

  get recommendationValue(): AdvisorRecommendation | null {
    return this.recommendation;
  }

  get pinnedContextValue(): string[] {
    return [...this.pinnedContext];
  }

  get lastContextFilesValue(): ContextFileSummary[] {
    return this.lastContextFiles;
  }

  get errorValue(): string | null {
    return this.error;
  }

  get noticeValue(): string | null {
    return this.notice;
  }

  get isStreaming(): boolean {
    return this.session !== null && this.machine.isBusy();
  }

  /** How far through a multi-file set the turn is. `null` when not applying one. */
  get changeProgressValue(): { index: number; total: number; setId: string } | null {
    if (this.changeQueue.length === 0) {
      return null;
    }
    return {
      index: this.changeCursor + 1,
      total: this.changeQueue.length,
      setId: this.changeSet?.changeSetHash ?? '',
    };
  }

  /**
   * The batch in flight, as the panel sees it.
   *
   * Read straight from the host's own record, so a panel that reloads — or one
   * that never received an earlier write — renders the same picture rather than
   * an empty one. Nothing here is derived from the Webview.
   */
  get batchView(): BatchViewSnapshot | null {
    return this.batch ? this.batch.view() : null;
  }

  /** True while the developer has held the stream into the editor. */
  get writePausedValue(): boolean {
    return this.writePaused;
  }

  /** The file currently being streamed into the editor, or null. */
  get writingFileValue(): string | null {
    return this.writingProposal?.relativePath ?? null;
  }

  /**
   * The identity the panel should echo back with its next decision.
   *
   * Derived from the file currently under the gate or the review, paired with
   * the batch's current version, so a decision made against a superseded version
   * is refused rather than applied.
   */
  get reviewBindingValue(): { proposalId: string; proposalVersion: number; fileId: string } | null {
    if (!this.batch) {
      return null;
    }
    const path = this.approvals.getPending()?.relativePath ?? this.pendingFilePath;
    if (!path) {
      return null;
    }
    const entry = this.batch.byRelativePath(path);
    if (!entry) {
      return null;
    }
    return {
      proposalId: this.batch.proposalId,
      proposalVersion: this.batch.proposalVersion,
      fileId: entry.fileId,
    };
  }

  /** The mode the session is in, for the panel and for the prompt. */
  get workflowModeValue(): WorkflowMode {
    return this.mode;
  }

  /** The mode as something to show: a label and one line of explanation. */
  get workflowModeView(): { id: WorkflowMode; label: string; summary: string; reason: string } {
    const meta = WORKFLOW_MODE_META[this.mode];
    return { id: meta.id, label: meta.label, summary: meta.summary, reason: this.modeReason };
  }

  /** True when the current mode refuses code proposals. */
  get isPlanningMode(): boolean {
    return !policyFor(this.mode).allowsProposals;
  }

  /** The plan for the whole set, for the review panel. */
  get changeSetPlanValue(): { file: string; operation: string; description: string; risk: string }[] {
    return this.changeQueue.map((change) => ({
      file: change.relativePath,
      operation: change.change.operation,
      description: change.change.description,
      risk: change.change.risk,
    }));
  }

  /**
   * The redacted record of recent replies.
   *
   * Exposed so a "show diagnostics" affordance, or a bug report, can quote what
   * the model actually said without the extension ever having needed to persist
   * it.
   */
  get protocolDiagnostics(): ProtocolDiagnostics {
    return this.protocol;
  }

  /* ---------------------------------------------------------------------- */
  /* Entry points                                                           */
  /* ---------------------------------------------------------------------- */

  /** Start a fresh session. Refuses while a turn is in flight. */
  newSession(): void {
    this.assertIdleish('start a new session');
    this.resetTurnState();
    this.resetMode('A new session starts by finding out what you want to build.');
    this.deps.store.create();
    this.machine.tryTransition(PairPilotState.IDLE, 'new session');
    this.deps.notify();
  }

  /** Restore a previous session from storage. */
  loadSession(sessionId: string): boolean {
    this.assertIdleish('load a session');
    const record = this.deps.store.setActive(sessionId);
    if (!record) {
      this.error = 'That session could not be found.';
      this.deps.notify();
      return false;
    }
    this.resetTurnState();
    // A resumed session starts in Discovery rather than in whatever mode the
    // previous process ended in: the mode is not persisted, and guessing that a
    // restored conversation is still authorised to write would be the wrong
    // guess to make on the developer's behalf. Saying so plainly is the honest
    // version — one sentence, and they are one turn from where they were.
    this.resetMode('A resumed session starts in Discovery. Say what you want to build, or say you want the code written.');
    this.notice = `Resumed session "${record.title}". Runtime context is preserved where available. The session is back in Discovery, so tell PairPilot what you want before code is written.`;
    this.machine.tryTransition(PairPilotState.IDLE, 'session loaded');
    this.deps.notify();
    return true;
  }

  setNotice(notice: string | null): void {
    this.notice = notice;
    this.deps.notify();
  }

  clearError(): void {
    this.error = null;
  }

  /** Pin a path for future requests, after validating it. */
  addPinnedContext(relativePath: string): { ok: boolean; reason?: string } {
    const assessment = this.deps.workspace.pathGuard.assess(relativePath);
    if (assessment.verdict === 'blocked' || assessment.verdict === 'excluded') {
      return { ok: false, reason: assessment.reason };
    }
    this.pinnedContext.add(assessment.relativePath);
    this.deps.notify();
    return { ok: true };
  }

  removePinnedContext(relativePath: string): void {
    this.pinnedContext.delete(relativePath);
    this.deps.notify();
  }

  /**
   * Handle a developer instruction.
   *
   * This is the only way a turn starts, and it is only legal from a settled
   * state — so a second task cannot be submitted while one is being reviewed.
   */
  async submitTask(task: string): Promise<void> {
    if (this.machine.isBusy()) {
      this.error = 'PairPilot is already working on a task. Cancel it before starting another.';
      this.deps.notify();
      return;
    }
    if (this.machine.isAwaitingHuman()) {
      this.error = 'Resolve the current review first: approve, reject, or request changes.';
      this.deps.notify();
      return;
    }

    // Return to a clean slate before starting, whatever terminal state we are in.
    if (this.machine.state !== PairPilotState.IDLE) {
      if (!this.machine.tryTransition(PairPilotState.IDLE, 'starting a new turn')) {
        this.error = `Cannot start a task from ${this.machine.state}.`;
        this.deps.notify();
        return;
      }
    }

    this.error = null;
    this.notice = null;
    this.recommendation = null;
    this.activeProposal = null;
    this.currentTask = task;
    this.resetChangeSet();
    this.approvals.clearPending();

    const turnId = ++this.activeTurnId;
    const store = this.deps.store.getOrCreateActive();

    this.appendMessage(store.id, {
      id: crypto.randomUUID(),
      role: 'user',
      text: task,
      timestamp: Date.now(),
    });

    try {
      await this.runTurn(task, turnId);
    } catch (error) {
      this.handleTurnFailure(error, turnId);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* The turn                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Ask the AI for a reply, read it as a contract, and act on what it decided.
   *
   * The retry loop is the heart of spec 1.3's "retry with a corrective prompt
   * when a response is invalid". It is deliberately narrow: only a reply that
   * was *valid JSON of the wrong shape* is re-requested, because that is the
   * only failure a better prompt can fix. Prose is not a schema failure — the
   * model chose to answer in words, and re-asking would bill the developer for
   * the same answer.
   */
  private async runTurn(task: string, turnId: number): Promise<void> {
    const config = this.deps.readConfig();
    // Fail before any state changes if the backend cannot run at all, so a
    // missing runtime never leaves the machine in a half-entered state.
    this.deps.ai.requireProvider();

    this.machine.transition(PairPilotState.ANALYZING, 'assembling context');
    this.currentStep = 'Reading workspace context';
    this.streamingText = '';
    this.streamingCode = [];
    this.deps.notify();

    const assembled = await this.deps.workspace.assemble([...this.pinnedContext], config.budget);
    this.lastAssembled = assembled;
    this.lastContextFiles = summariseContext(assembled.files);
    if (assembled.skipped.length > 0) {
      this.deps.logger.info(
        `Context skipped: ${assembled.skipped
          .map((entry) => `${entry.relativePath} (${entry.reason})`)
          .join('; ')}`
      );
    }
    this.assertCurrentTurn(turnId);

    // --- which kind of work is this? --------------------------------------
    //
    // Decided from the instruction, the recent conversation and the mode the
    // session is already in — and moved *before* the request goes out, because
    // the answer has to be asked for in the right shape. A planning turn that
    // asks the model for a code proposal is a planning turn that will get one.
    const record = this.deps.store.getOrCreateActive();
    const intention = classifyIntention({
      task,
      previousMode: this.mode,
      recentTurns: this.buildTurnHistory(),
    });
    this.turnIntention = intention.intention;
    const previousMode = this.mode;
    this.mode = nextMode(previousMode, intention.intention);
    if (this.mode !== previousMode) {
      this.modeReason = intention.reason;
      this.notice =
        this.mode === 'coding'
          ? `${WORKFLOW_MODE_META[this.mode].summary} (${intention.reason})`
          : `${WORKFLOW_MODE_META[this.mode].label}: ${WORKFLOW_MODE_META[this.mode].summary}`;
    }
    const policy = policyFor(this.mode);
    this.deps.logger.info(
      `Turn intention: ${intention.intention} → mode ${this.mode}${
        intention.explicit ? ' (explicitly stated)' : ''
      }. ${intention.reason}`
    );

    const turnShape = intention.intention === 'general_chat' ? 'conversational' : 'engineering';
    const typeHint = `${buildPolicyHint(policy, turnShape)}\n\n${expectedTypeHint(
      turnShape,
      policy.allowsProposals
    )}`;

    let correction: string | undefined;
    /** The most recent schema failure, kept so the final error is the real one. */
    let lastFailure: ProtocolParseFailure | null = null;

    for (let attempt = 0; attempt <= MAX_PROTOCOL_RETRIES; attempt++) {
      // Only the first attempt moves the machine. A retry is a second request
      // from the same state, and the machine refuses self-transitions on purpose
      // (they are how a duplicate event re-runs side effects), so re-asking must
      // not go through it. Asking for the transition anyway threw here, which is
      // why a corrected retry never reached the model.
      if (attempt === 0) {
        this.machine.transition(PairPilotState.PROPOSING, 'requesting a reply');
      }
      this.currentStep =
        attempt === 0
          ? this.turnIntention === null || policy.allowsProposals
            ? 'Waiting for the AI to respond'
            : `Waiting for the AI (${WORKFLOW_MODE_META[policy.mode].label.toLowerCase()})`
          : `Correcting the AI's reply (attempt ${attempt + 1})`;
      this.deps.notify();

      const prompt = buildProposalPrompt({
        ...this.promptContext(assembled, task),
        typeHint,
        ...(correction !== undefined ? { correction } : {}),
      });

      const result = await this.runRuntimeTurn({
        role: 'coding',
        taskLabel: task,
        prompt,
        resumeSessionId: this.deps.store.getRuntimeSessionId(record.id),
        timeoutMs: config.timeoutMs,
        // Live code extraction is a *coding* affordance: it drives the streamed
        // preview and the writer's incremental feed. In a planning mode nothing
        // will be written, so scanning for file content would only waste work and
        // risk showing the developer half a file they are not being offered.
        scanCode: policy.allowsProposals,
        turnId,
      });
      this.assertCurrentTurn(turnId);

      if (result.cancelled) {
        throw new CancelledError();
      }
      if (result.sessionId) {
        this.deps.store.setRuntimeSessionId(record.id, result.sessionId);
      }
      // Recorded on every attempt: each one was a real, billed request.
      this.recordUsage(record.id, result.usage, result.isError);

      if (result.isError) {
        throw new Error(result.errorMessage ?? 'The AI runtime reported an error.');
      }

      const interpretation = interpretTurn(result.text);
      this.protocol.record({
        ok: interpretation.kind !== 'failure',
        adaptation: interpretation.kind === 'failure' ? 'prose' : interpretation.adaptation,
        raw: interpretation.kind === 'failure' ? interpretation.failure.raw : result.text,
        sessionId: record.id,
        modelId: result.usage.model,
        ...(interpretation.kind === 'failure'
          ? { issues: interpretation.failure.issues, failureKind: interpretation.failure.kind }
          : { notes: interpretation.notes, messageType: interpretation.message.type }),
      });

      switch (interpretation.kind) {
        case 'proposal': {
          // The mode gate. This runs *before* validation and long before any
          // approval intersects a file: a planning turn that produced a proposal
          // is refused here, which is the single choke point every path into a
          // write goes through, whatever the model decided to send.
          if (!policy.allowsProposals) {
            this.protocol.record({
              ok: false,
              adaptation: interpretation.adaptation,
              raw: result.text,
              messageType: 'code_proposal',
              issues: [
                {
                  path: '/type',
                  code: 'mode_refusal',
                  message: `A code_proposal is not allowed while the session is in ${WORKFLOW_MODE_META[this.mode].label}.`,
                },
              ],
              sessionId: record.id,
              modelId: result.usage.model,
            });
            // Shown, then refused. The developer can read what the model wanted
            // to build — it is often a useful sketch of the design — but nothing
            // is staged, nothing is written, and no file is created.
            this.appendAssistant(record.id, renderProposalSummary(interpretation.message), result.usage);
            this.error = refusedProposalReason(this.mode);
            this.notice = `Nothing was written. In ${WORKFLOW_MODE_META[this.mode].label}, PairPilot discusses the design rather than creating files.`;
            this.currentStep = null;
            this.machine.tryTransition(PairPilotState.REJECTED, 'a proposal is not allowed in this mode');
            this.machine.tryTransition(PairPilotState.IDLE, 'turn finished');
            this.deps.notify();
            return;
          }

          const staged = this.stageProposal(interpretation.message, interpretation.notes, record.id);
          if (staged.ok) {
            return;
          }
          // The reply was structurally valid but not applicable — an "update"
          // for a file that does not exist, say. The model can fix that, and it
          // is cheap to let it: this is the same corrective channel as a schema
          // failure, with the validator's own wording.
          lastFailure = {
            ok: false,
            kind: 'schema',
            reason: 'The proposal could not be applied to this workspace.',
            issues: staged.issues,
            raw: result.text,
          };
          if (attempt < MAX_PROTOCOL_RETRIES && stageRetryable(staged.issues)) {
            correction = buildCorrectionPrompt(staged.issues);
            continue;
          }
          this.failTurn(lastFailure);
          return;
        }

        case 'narrative':
        case 'advice':
        case 'question': {
          if (interpretation.kind === 'advice') {
            this.recommendation = {
              title: interpretation.message.advice.title,
              reason: interpretation.message.advice.reason,
              responsibilities: interpretation.message.advice.responsibilities ?? [],
              files: interpretation.message.advice.files ?? [],
              required: interpretation.message.advice.required ?? false,
              source: 'ai',
            };
          }
          // Prefer the model's own prose for `message` and the structured
          // rendering for everything else, so an answer that says something
          // useful is never replaced by a summary of itself.
          const body = renderMessage(interpretation.message);
          this.appendAssistant(record.id, body, result.usage);
          if (interpretation.adaptation === 'prose') {
            // Shown, not applied. Saying so is what keeps "the model answered in
            // words" from being read as "PairPilot built me the file".
            this.notice =
              'The AI answered in plain text rather than proposing a change, so nothing was written. Ask again naming the file you want if you meant to build something.';
          }
          this.currentStep = null;
          this.settleAfterNarrative();
          return;
        }

        case 'failure': {
          lastFailure = interpretation.failure;
          if (interpretation.retryable && attempt < MAX_PROTOCOL_RETRIES) {
            correction = buildCorrectionPrompt(interpretation.failure.issues);
            continue;
          }
          this.failTurn(lastFailure);
          return;
        }
      }
    }

    // Only reachable if the loop exhausted its attempts, which the branches
    // above already handle; kept as a typed fallback rather than a throw.
    if (lastFailure) {
      this.failTurn(lastFailure);
    }
  }

  /** Build the per-turn prompt sections that do not change between attempts. */
  private promptContext(
    assembled: Awaited<ReturnType<WorkspaceContext['assemble']>>,
    task: string
  ): TurnPromptInput {
    return {
      task,
      ...(assembled.activeFile !== undefined ? { activeFile: assembled.activeFile } : {}),
      ...(assembled.treeSummary !== undefined ? { treeSummary: assembled.treeSummary } : {}),
      contextFiles: assembled.files.map((file) => ({
        relativePath: file.relativePath,
        content: file.content,
        truncated: file.truncated,
      })),
      pinnedContext: [...this.pinnedContext],
    };
  }

  /**
   * Validate a proposal and, if it holds up, put it in front of the developer.
   *
   * Returns the issues instead of throwing, because a proposal that cannot be
   * applied is a *retryable* condition, not an error the developer has to
   * resolve.
   */
  private stageProposal(
    message: CodeProposalMessage,
    notes: string[],
    sessionId: string
  ): { ok: true } | { ok: false; issues: ProtocolIssue[] } {
    let set: ValidatedChangeSet;
    try {
      set = this.validator.validateChangeSet(message);
    } catch (error) {
      const issues = issuesFromError(error);
      this.deps.logger.warn(`Proposal rejected: ${describeError(error)}`);
      return { ok: false, issues };
    }

    if (set.warnings.length > 0) {
      this.deps.logger.warn(`Proposal warnings: ${set.warnings.join(' | ')}`);
    }
    for (const note of notes) {
      this.deps.logger.info(`Protocol: ${note}`);
    }

    // A revision of a file inside a proposal that is still in flight is merged
    // into the batch, not staged as a new proposal.
    //
    // The batch is the developer's decision about a set of files, and revising
    // one of them does not unmake that decision. Rebuilding the batch from the
    // reply is what used to discard the other files: seven approved, one
    // revised, six gone. So the reply is merged — the file it regenerated
    // replaces its own entry, anything new is added, and every file it did not
    // mention is left exactly as it was, still written or still waiting to be.
    const revising = this.revisingPath;
    if (this.batch && revising && this.batch.byRelativePath(revising)) {
      const batch = this.batch;
      const merged = batch.mergeRevision(set, revising);
      this.revisingPath = null;
      this.deps.logger.info(
        `Revision merged into ${batch.batchId}: ${merged.revised.length} file(s) replaced, ` +
          `${merged.added.length} added, now at version ${merged.version}.`
      );

      // The transcript keeps the revised explanation, so the developer can read
      // what changed and why alongside the code in the editor.
      this.appendAssistant(sessionId, renderMessage(message), undefined);

      // Point the cursor at what the batch says is next, so the file gate asks
      // about the revised file rather than about whichever file the old cursor
      // happened to be on.
      this.syncCursorToBatch();
      this.enterFileApproval();
      return { ok: true };
    }

    this.changeSet = set;
    this.changeQueue = set.changes;
    this.changeCursor = 0;
    this.approvedWholeSet = false;
    this.appliedThisSet = [];

    // The batch record starts here, at version 1, and outlives any single
    // file's write. It is created from the *validated* set, so every entry
    // already carries content the validator has accepted as non-empty — the
    // batch can only ever hold files that are safe to write.
    this.batch = BatchQueue.create(set);

    // The proposal itself becomes the assistant's turn in the transcript, so the
    // developer can read the explanation alongside the changes it describes.
    this.appendAssistant(sessionId, renderMessage(message), undefined);

    this.enterFileApproval();
    return { ok: true };
  }

  /**
   * Rebuild the file-approval queue from the batch, and aim it at what is next.
   *
   * The queue and the batch describe the same files from two directions: the
   * batch is the durable record, the queue is the ordered list the approval gate
   * reads. A revision rewrites the batch without rewriting the queue, so after a
   * merge the two would disagree — the gate would ask about a file that is no
   * longer pending, or skip one that still is. Rebuilding the queue from the
   * batch keeps them one thing described twice rather than two things that have
   * to be kept in step by hand.
   */
  private syncCursorToBatch(): void {
    if (!this.batch) {
      return;
    }
    const ordered = this.batch.all().map((entry) => entry.change);
    this.changeQueue = ordered;
    const next = this.batch.pendingEntries()[0] ?? this.batch.nextAwaitingReview();
    const index = next
      ? ordered.findIndex((change) => change.relativePath === next.relativePath)
      : -1;
    this.changeCursor = index >= 0 ? index : ordered.length;
  }

  /** Assemble context and ask the AI for a next-step recommendation. */
  private async runAdvisorTurn(turnId: number, input: AdvisorInput): Promise<void> {
    const config = this.deps.readConfig();
    if (!config.advisorEnabled) {
      this.recommendation = null;
      this.deps.notify();
      return;
    }

    this.machine.transition(PairPilotState.ANALYZING_NEXT_STEP, 'engineering advisor');
    this.currentStep = 'Analysing the next engineering step';
    this.deps.notify();

    const localAdvice = this.advisor.analyseLocally(input);

    if (config.advisorUseAI && this.deps.ai.isActiveAvailable()) {
      try {
        // The advisor is optional: a provider that cannot run costs us only the
        // AI path, because the local analysis below is already a valid answer.
        this.deps.ai.requireProvider();
        const record = this.deps.store.getOrCreateActive();
        const prompt = buildAdvisorPrompt({
          relativePath: input.relativePath,
          code: input.code.slice(0, 60_000),
          dependencies: input.dependencies,
          existingPaths: input.existingPaths,
        });

        const result = await this.runRuntimeTurn({
          // The advisor is a review of written code, so it resolves through the
          // `code-review` role rather than the coding one.
          role: 'code-review',
          taskLabel: `Review ${input.relativePath}`,
          prompt,
          resumeSessionId: this.deps.store.getRuntimeSessionId(record.id),
          timeoutMs: config.timeoutMs,
          scanCode: false,
          turnId,
        });
        this.assertCurrentTurn(turnId);
        this.recordUsage(record.id, result.usage, result.isError);

        if (!result.cancelled && !result.isError) {
          const interpretation = interpretTurn(result.text);
          this.protocol.record({
            ok: interpretation.kind !== 'failure',
            adaptation: interpretation.kind === 'failure' ? 'prose' : interpretation.adaptation,
            raw: interpretation.kind === 'failure' ? interpretation.failure.raw : result.text,
            sessionId: record.id,
            ...(interpretation.kind === 'failure'
              ? { issues: interpretation.failure.issues, failureKind: interpretation.failure.kind }
              : { notes: interpretation.notes, messageType: interpretation.message.type }),
          });

          // The advisor's contract asks for `engineering_advice`. A model that
          // answers with something else is not wrong — the local analysis below
          // is always available — but a reply that *is* a recommendation is used.
          const advice =
            interpretation.kind === 'advice'
              ? interpretation.message.advice
              : interpretation.kind !== 'failure' && interpretation.message.type === 'engineering_advice'
                ? interpretation.message.advice
                : null;

          if (advice) {
            this.recommendation = {
              title: advice.title,
              reason: advice.reason,
              responsibilities: advice.responsibilities ?? [],
              files: advice.files ?? [],
              required: advice.required ?? false,
              source: 'ai',
            };
            this.currentStep = null;
            this.deps.notify();
            return;
          }
          this.deps.logger.warn(
            'The advisor reply was not a recommendation; falling back to local analysis.'
          );
        }
      } catch (error) {
        if (error instanceof CancelledError) {
          throw error;
        }
        this.deps.logger.warn(
          `The advisor turn failed (${describeError(error)}); falling back to local analysis.`
        );
      }
    }

    this.recommendation = localAdvice;
    this.currentStep = null;
    this.deps.notify();
  }

  /**
   * Start a turn on the active provider, wiring its stream into the writer and
   * the UI.
   *
   * Deliberately knows nothing about which backend is in use. The provider owns
   * its own transport, flags and credentials, and reports its output through the
   * same `SessionStreamCallbacks` that every backend can produce — which is why
   * live code extraction, approvals and rollback work unchanged on a new one.
   */
  private runRuntimeTurn(options: {
    prompt: string;
    resumeSessionId: string | undefined;
    timeoutMs: number;
    scanCode: boolean;
    turnId: number;
    role: ModelTaskId;
    taskLabel?: string | null;
  }): Promise<TurnResult> {
    const handle = this.deps.ai.startTurn({
      role: options.role,
      ...(options.taskLabel !== undefined ? { taskLabel: options.taskLabel } : {}),
      prompt: options.prompt,
      cwd: this.deps.workspace.workspaceRoot,
      ...(options.resumeSessionId !== undefined
        ? { resumeSessionId: options.resumeSessionId }
        : {}),
      // Only a stateless provider reads this; one that can resume a server-side
      // thread ignores it rather than being sent its own history twice.
      history: this.buildTurnHistory(),
      timeoutMs: options.timeoutMs,
      scanCode: options.scanCode,
      callbacks: {
        onTextDelta: (delta) => {
          if (options.turnId !== this.activeTurnId) {
            return;
          }
          this.streamingText += delta;
          this.deps.notifyTextDelta(delta);
        },
        onCodeDelta: (blockIndex, delta) => {
          if (options.turnId !== this.activeTurnId) {
            return;
          }
          // Live preview in the Webview.
          this.streamingCode[blockIndex] = (this.streamingCode[blockIndex] ?? '') + delta;
          this.deps.notifyCodeDelta(blockIndex, delta);
          // And, when a write is open, straight into the real editor.
          this.writer?.push(delta);
        },
        onField: (name, value) => {
          if (options.turnId !== this.activeTurnId) {
            return;
          }
          // The scanner reports a change's file as `changes[2].file`, so the
          // match is on the field name's tail rather than on a bare `file`.
          if (!value) {
            return;
          }
          if (name === 'filePath' || name.endsWith('.file') || name.endsWith('.filePath')) {
            this.currentStep = `Proposing ${value}`;
          }
        },
        onDiagnostic: (line) => this.deps.logger.diagnostic(redactSecrets(line)),
      },
    });

    this.session = handle;
    return handle.result.finally(() => {
      if (this.session === handle) {
        this.session = null;
      }
    });
  }

  /**
   * Prior conversation, for a provider that cannot resume a session.
   *
   * Bounded to the last few turns: the point is continuity for a follow-up
   * question, not replaying an entire session into every request. The message
   * carrying the current request is skipped, because the prompt already contains
   * it in full and sending it twice would bill the developer for the duplicate.
   */
  private buildTurnHistory(): { role: 'user' | 'assistant'; text: string }[] {
    const session = this.deps.store.getActive();
    if (!session) {
      return [];
    }

    const currentTask = this.currentTask;
    const history: { role: 'user' | 'assistant'; text: string }[] = [];

    for (const message of session.messages) {
      if (message.role === 'system' || message.incomplete) {
        continue;
      }
      const text = message.text?.trim();
      if (!text || text.length === 0) {
        continue;
      }
      // Skip the message that produced this very turn.
      if (currentTask !== null && text === currentTask.trim()) {
        continue;
      }
      history.push({ role: message.role, text });
    }

    return history.slice(-HISTORY_MESSAGES);
  }

  /* ---------------------------------------------------------------------- */
  /* The file-permission gate and the write                                 */
  /* ---------------------------------------------------------------------- */

  /** The change the developer is being asked about right now. */
  private currentChange(): ValidatedChange | null {
    return this.changeQueue[this.changeCursor] ?? null;
  }

  /**
   * Put the current change in front of the developer for *permission to write*.
   *
   * Nothing has been written at this point, so declining leaves the workspace
   * exactly as it was.
   */
  private enterFileApproval(): void {
    const change = this.currentChange();
    if (!change) {
      this.finishChangeSet();
      return;
    }

    this.approvals.setPending(toValidatedProposal(change, this.changeSet?.envelope));
    this.machine.transition(PairPilotState.WAITING_FILE_APPROVAL, 'awaiting file permission');
    this.pendingFilePath = change.relativePath;
    this.pendingFileOperation = change.change.operation === 'update' ? 'update' : 'create';

    const position =
      this.changeQueue.length > 1
        ? ` (change ${this.changeCursor + 1} of ${this.changeQueue.length})`
        : '';
    const verb = this.pendingFileOperation === 'create' ? 'create' : 'update';
    this.currentStep = `Waiting for your permission to ${verb} ${change.relativePath}${position}`;
    this.deps.notify();
  }

  /**
   * The developer permitted the file to be created or updated.
   *
   * Accepts either the current change's own hash — "this file" — or the hash of
   * the whole set — "this file and every remaining one". Both are verified
   * against live state, so a stale UI can authorise neither.
   *
   * A batch authorisation is *permission to write*, nothing more. It is recorded
   * on the batch as `authorized` for every remaining file; each of those files
   * still gets its own review afterwards, which is a separate decision the
   * developer has not made yet.
   */
  async approveFileCreation(contentHash: string, binding?: DecisionBindingInput): Promise<void> {
    if (!this.machine.is(PairPilotState.WAITING_FILE_APPROVAL)) {
      this.error = 'There is no pending file request to approve.';
      this.deps.notify();
      return;
    }

    const change = this.currentChange();
    const isWholeSet =
      this.changeSet !== null &&
      this.changeSet.changeSetHash === contentHash &&
      this.changeQueue.length > 1;

    // A decision that names a proposal version must name the current one. This
    // runs before the hash check so that a panel showing a superseded version is
    // told *that*, rather than being left to guess from a hash mismatch.
    try {
      this.batch?.assertFresh(binding, change?.relativePath);
    } catch (error) {
      this.error = describeError(error);
      this.deps.notify();
      return;
    }

    let proposal: ValidatedProposal;
    try {
      proposal = this.approvals.verify(isWholeSet && change ? change.contentHash : contentHash);
    } catch (error) {
      this.error = describeError(error);
      this.deps.notify();
      return;
    }

    this.approvedWholeSet = isWholeSet;
    const turnId = this.activeTurnId;

    if (isWholeSet && this.changeQueue.length > 1) {
      // Record the authorisation against every remaining file before writing the
      // first one, so the batch can report what was promised even if the first
      // write fails.
      this.batch?.authorizeRemaining();
      this.notice = `You approved writing all ${this.changeQueue.length} files. Each file is still shown for review as it is written.`;
    }

    await this.applyChange(proposal, turnId);
  }

  /**
   * Write one validated change into the real editor.
   *
   * The whole of the 0.1.x single-file write path, lifted into a method so that
   * a change set can run it once per file rather than duplicating it.
   */
  private async applyChange(proposal: ValidatedProposal, turnId: number): Promise<void> {
    const config = this.deps.readConfig();

    // Every precondition is checked *before* the editor is touched, so a file
    // can never be created empty and then left that way because the content
    // turned out to be missing further down. The failure names the stage.
    const preflight = this.preflightWrite(proposal);
    if (!preflight.ok) {
      this.recordBatchFailure(proposal.relativePath, preflight.reason);
      this.error = preflight.reason;
      this.deps.logger.warn(`Refused to write ${proposal.relativePath}: ${preflight.reason}`);
      // The batch keeps its other files; only this one is marked failed.
      await this.advanceAfterFile(proposal.relativePath, turnId, { failed: true });
      return;
    }

    // One writer per path. Two review sessions — an original and a revision —
    // must never stream into the same file at once, because their edits would
    // interleave into corrupt output.
    if (this.batch && !this.batch.claimWrite(proposal.relativePath)) {
      const reason = `"${proposal.relativePath}" is already being written by another review session, so this write waited rather than interleaving with it.`;
      this.error = reason;
      this.deps.logger.warn(reason);
      this.deps.notify();
      return;
    }

    try {
      this.batch?.markWriting(proposal.relativePath);
      this.machine.transition(PairPilotState.CREATING_FILE, 'permission granted');
      this.currentStep = `Preparing ${proposal.relativePath}`;
      this.deps.notify();

      const writer = new LiveWriter({
        guard: this.deps.workspace.pathGuard,
        logger: this.deps.logger,
        onProgress: (written, total) => {
          if (turnId !== this.activeTurnId) {
            return;
          }
          this.deps.notifyWritingProgress(written, total, proposal.relativePath);
        },
        onInterrupted: (reason) => {
          if (turnId !== this.activeTurnId) {
            return;
          }
          this.notice = reason;
          this.deps.notify();
        },
      });
      this.writer = writer;
      // Remember which proposal is being streamed, so "stop, I want this
      // different" can be answered while the file is still being written: the
      // partial content is on disk and has to be taken back, and the revision is
      // about this proposal.
      this.writingProposal = proposal;
      this.writePaused = false;

      // A sensitive target needs a separate, explicit confirmation.
      const assessment = this.deps.workspace.pathGuard.assess(proposal.relativePath);
      const needsSensitiveConfirmation =
        assessment.verdict === 'sensitive' && config.requireSensitiveApproval;
      if (needsSensitiveConfirmation) {
        const confirmed = await this.confirmSensitiveWrite(proposal.relativePath, assessment.reason);
        this.assertCurrentTurn(turnId);
        if (!confirmed) {
          throw new DeclinedError('You declined to write to this sensitive file.');
        }
      }

      const begun = await writer.begin(proposal.relativePath, proposal.proposal.operation, {
        approvedCreate: true,
        expectedTotal: proposal.assembledCode.length,
      });
      this.assertCurrentTurn(turnId);

      // Remember what the file held before this write. Without this an `update`
      // that is later rejected cannot be restored, because the writer that knew
      // the original content is gone by then.
      this.rememberPreviousContent(proposal.relativePath, begun.previousContent);

      this.machine.transition(PairPilotState.WRITING_CODE, 'writing into the editor');
      this.currentStep = `Writing ${proposal.relativePath}`;
      this.deps.notify();

      this.pushReviewedContent(proposal);

      const outcome = await writer.complete();
      this.assertCurrentTurn(turnId);

      if (outcome.status !== 'completed') {
        await this.finishWithRollback(writer, proposal, outcome.reason, outcome.status);
        return;
      }

      // Verify the file on disk matches the reviewed content exactly. If it does
      // not, the write was disturbed and we must not present it as reviewable.
      const onDisk = this.readFileQuietly(proposal.absolutePath);
      if (onDisk === null) {
        await this.finishWithRollback(
          writer,
          proposal,
          'The written file could not be read back for verification.',
          'failed'
        );
        return;
      }
      if (normaliseNewlines(onDisk) !== normaliseNewlines(proposal.assembledCode)) {
        await this.finishWithRollback(
          writer,
          proposal,
          'The file on disk does not match the reviewed content, so the write was rolled back.',
          'failed'
        );
        return;
      }

      // --- success: move to review -----------------------------------------
      this.appliedThisSet.push({
        relativePath: proposal.relativePath,
        operation: proposal.proposal.operation,
      });
      this.batch?.markCompleted(proposal.relativePath);
      this.activeProposal = toProposalRecord(proposal);
      this.deps.store.addProposal(this.deps.store.getOrCreateActive().id, this.activeProposal);
      this.pendingFilePath = null;
      this.pendingFileOperation = null;

      // The write lock is released here, not when the review finishes: the file
      // is on disk and stable, and holding the lock through a review the
      // developer might leave open for an hour would block a revision to it.
      this.batch?.releaseWrite(proposal.relativePath);
      this.writingProposal = null;
      this.writePaused = false;

      this.machine.transition(PairPilotState.REVIEWING, 'write complete');
      this.currentStep = `Reviewing ${proposal.relativePath}${this.positionSuffix()}`;
      this.deps.notify();

      this.machine.transition(PairPilotState.WAITING_CODE_APPROVAL, 'awaiting review');
      this.deps.notify();

      // Open the file so the code is visible in the real editor, not just the
      // Webview (spec section 8).
      await this.revealInEditor(proposal.absolutePath);
    } catch (error) {
      this.batch?.releaseWrite(proposal.relativePath);
      this.writingProposal = null;
      this.writePaused = false;
      if (this.writer) {
        await this.writer.rollback('failed');
        this.writer = null;
      }
      this.handleTurnFailure(error, turnId);
    }
  }

  /**
   * Every check that must pass before a write may begin.
   *
   * Spec section 4 lists these as preconditions for writing; they are gathered
   * here rather than scattered through the write so that the answer to "why was
   * this file not written?" is one function. A failure names the file and the
   * stage, because "something went wrong" is not actionable. Nothing here ever
   * substitutes placeholder content for content that is missing.
   */
  private preflightWrite(proposal: ValidatedProposal): { ok: true } | { ok: false; reason: string } {
    const entry = this.batch?.byRelativePath(proposal.relativePath);

    // 1. The proposal must still exist in our own record.
    if (this.batch && !entry) {
      return {
        ok: false,
        reason: `"${proposal.relativePath}" is no longer part of the proposal in progress, so it was not written.`,
      };
    }

    // 2. Content must be present and non-empty. The validator already refuses an
    // empty change, so reaching this means something upstream lost the bytes —
    // which is exactly the condition that must fail loudly rather than create an
    // empty file.
    if (typeof proposal.assembledCode !== 'string' || proposal.assembledCode.trim().length === 0) {
      return {
        ok: false,
        reason: `The proposed content for "${proposal.relativePath}" is missing or empty, so no file was created. This is a defect in how the proposal was carried, not something you did.`,
      };
    }

    // 3. The path must still resolve inside the workspace. A symlink could have
    // appeared since validation, so this is re-asserted at write time.
    try {
      this.deps.workspace.pathGuard.assertRealPathInsideWorkspace(proposal.relativePath);
    } catch (error) {
      return {
        ok: false,
        reason: `"${proposal.relativePath}" no longer resolves inside the workspace, so it was not written: ${describeError(error)}`,
      };
    }

    // 4. The content hash must match the approval binding, when the batch holds
    // one. A mismatch means the content moved after the developer approved it.
    if (entry && entry.contentHash !== proposal.contentHash) {
      return {
        ok: false,
        reason: `The content for "${proposal.relativePath}" changed after you approved it, so the write was refused. Review the current version.`,
      };
    }

    // 5. A required approval must exist and still be current.
    if (this.approvals.getPending() === null && this.approvedWholeSet === false && !this.batch) {
      return {
        ok: false,
        reason: `There is no approval covering "${proposal.relativePath}", so it was not written.`,
      };
    }

    return { ok: true };
  }

  /** Note a file's failure on the batch without disturbing its siblings. */
  private recordBatchFailure(relativePath: string, reason: string): void {
    this.batch?.markFailed(relativePath, reason);
    this.batch?.releaseWrite(relativePath);
  }

  /**
   * Feed the reviewed bytes to the open writer.
   *
   * Where the stream scanner captured this change's content live, that is
   * replayed so the editor shows the real characters arriving; the reviewed
   * content is then used to top up anything the scan missed. For a change the
   * validator reordered, or one whose deltas never arrived, the reviewed content
   * is pushed directly — the bytes are identical either way, because the scanner
   * and the validator both read the same JSON.
   */
  private pushReviewedContent(proposal: ValidatedProposal): void {
    const writer = this.writer;
    if (!writer) {
      return;
    }
    const streamed = this.streamingCodeFor(proposal.relativePath);

    // The reviewed content is the authority for *what* the file should contain.
    // The live scan exists only so the developer can watch the characters
    // arrive; it is never allowed to decide the bytes.
    //
    // An earlier version compared lengths and pushed the streamed text whenever
    // it was no longer than the reviewed content. Equal length does not mean
    // equal text: a scanner that captured a sibling's content of the same length
    // would have had its bytes written. The check is now on the bytes
    // themselves, and anything that is not a prefix of the reviewed content is
    // discarded in favour of it.
    if (streamed.length > 0 && streamed.length <= proposal.assembledCode.length) {
      const prefix = proposal.assembledCode.slice(0, streamed.length);
      if (streamed === prefix) {
        writer.push(streamed);
        if (streamed.length < proposal.assembledCode.length) {
          // The scan ended early; the reviewed content supplies the remainder.
          writer.push(proposal.assembledCode.slice(streamed.length));
        }
        return;
      }
      // Not a prefix: the scan captured something else. Say so, because a
      // scanner that mis-attributes content is a bug worth seeing in the log
      // rather than a silent fallback.
      this.deps.logger.warn(
        `Live stream content for ${proposal.relativePath} did not match the reviewed content; writing the reviewed content instead.`
      );
    }

    writer.push(proposal.assembledCode);
  }

  /** The live-scanned content for a change, if the scanner captured any. */
  private streamingCodeFor(relativePath: string): string {
    const change = this.changeQueue.find((entry) => entry.relativePath === relativePath);
    if (!change) {
      return '';
    }
    return this.streamingCode[change.sourceIndex] ?? '';
  }

  /** " (change 2 of 5)", or empty for a single-file proposal. */
  private positionSuffix(): string {
    return this.changeQueue.length > 1
      ? ` (change ${this.changeCursor + 1} of ${this.changeQueue.length})`
      : '';
  }

  /** The developer declined the file creation/update. Nothing was written. */
  rejectFileCreation(contentHash: string, binding?: DecisionBindingInput): void {
    if (!this.machine.is(PairPilotState.WAITING_FILE_APPROVAL)) {
      this.error = 'There is no pending file request to reject.';
      this.deps.notify();
      return;
    }
    let proposal: ValidatedProposal;
    try {
      this.batch?.assertFresh(binding, this.approvals.getPending()?.relativePath);
      proposal = this.approvals.verify(contentHash) ?? this.requirePending();
    } catch (error) {
      this.error = describeError(error);
      this.deps.notify();
      return;
    }

    this.approvals.record('reject', proposal);
    this.discardRemainingChanges();
    this.machine.transition(PairPilotState.REJECTED, 'file creation declined');
    this.machine.tryTransition(PairPilotState.IDLE, 'turn finished');
    this.pendingFilePath = null;
    this.pendingFileOperation = null;
    this.currentStep = null;
    this.notice = this.changeQueue.length > 1
      ? `You declined to write ${proposal.relativePath}. No further files from this proposal were written.`
      : `You declined to write ${proposal.relativePath}. No file was created or modified.`;
    this.deps.notify();
  }

  /** The developer approved the written code. */
  async approveCode(contentHash: string, binding?: DecisionBindingInput): Promise<void> {
    if (!this.machine.is(PairPilotState.WAITING_CODE_APPROVAL, PairPilotState.REVIEWING)) {
      this.error = 'There is nothing awaiting approval.';
      this.deps.notify();
      return;
    }
    let proposal: ValidatedProposal;
    try {
      this.batch?.assertFresh(binding, this.approvals.getPending()?.relativePath);
      proposal = this.approvals.verify(contentHash);
    } catch (error) {
      this.error = describeError(error);
      this.deps.notify();
      return;
    }

    const fileHash = this.hashFileQuietly(proposal.absolutePath);
    this.approvals.record('approve', proposal, {
      ...(fileHash ? { approvedFileHash: fileHash } : {}),
    });

    this.machine.transition(PairPilotState.APPROVED, 'code approved');
    this.currentStep = null;
    this.notice = `${proposal.relativePath} is approved and kept.`;
    this.batch?.markApproved(proposal.relativePath);
    this.deps.notify();

    await this.advanceAfterFile(proposal.relativePath, this.activeTurnId, {});
  }

  /**
   * Hand the turn on to the next file of the batch, or settle it if this was the
   * last one.
   *
   * This is the single place the batch advances, and it is deliberately driven
   * by the *batch's* own record rather than by a cursor into the queue. Every
   * sibling file stays exactly where it was: approving, failing or revising one
   * file moves only that file's entry, so the seven files of a proposal remain
   * seven independent reviews rather than one that collapses when the first
   * decision is made.
   *
   * @param options.failed Set when the file just processed could not be written.
   *   A failed file does not stop the batch — spec section 6 — it just does not
   *   become the file under review.
   */
  private async advanceAfterFile(
    relativePath: string,
    turnId: number,
    options: { failed?: boolean }
  ): Promise<void> {
    const batch = this.batch;
    const failed = options.failed === true;

    if (failed) {
      // The file is already marked failed on the batch by `recordBatchFailure`.
      // Say which file and that the rest are unaffected, because "3 of 7 were
      // written" is the fact the developer needs, not silence.
      const remaining = batch
        ? batch.all().filter((entry) => entry.status === 'pending' || entry.status === 'authorized')
            .length
        : 0;
      this.deps.logger.warn(
        `Batch ${batch?.batchId ?? '(none)'}: ${relativePath} failed; ${remaining} file(s) still to write.`
      );
    }

    // No batch (a single-file proposal, or one already settled): behave exactly
    // as the pre-batch code did.
    if (!batch) {
      if (this.changeCursor < this.changeQueue.length - 1) {
        this.changeCursor += 1;
        this.enterFileApproval();
        return;
      }
      await this.afterSetApproved(this.requireReviewed(relativePath));
      return;
    }

    // Any file still awaiting a decision keeps the developer where they are;
    // the panel decides which review session to show.
    const awaiting = batch.nextAwaitingReview();
    if (awaiting && awaiting.relativePath !== relativePath) {
      this.deps.logger.info(
        `Batch ${batch.batchId}: ${awaiting.relativePath} is awaiting review; ${relativePath} stays in its own session.`
      );
    }

    // Move the cursor so the queue's notion of "current" matches the batch, for
    // the single-file code paths and the status line that still read it.
    const nextIndex = this.changeQueue.findIndex(
      (change) => change.relativePath === (batch.nextPending()?.relativePath ?? '')
    );
    if (nextIndex >= 0) {
      this.changeCursor = nextIndex;
    }

    const next = batch.nextPending();

    // Nothing left to write. If something is still under review, the turn has
    // not finished — the developer is mid-review and the batch stays open.
    if (!next) {
      if (batch.nextAwaitingReview()) {
        this.currentStep = null;
        this.deps.notify();
        return;
      }
      this.reportBatchOutcome();
      await this.afterSetApproved(this.requireReviewed(relativePath));
      return;
    }

    const nextProposal = this.proposalForEntry(next);

    if (this.approvedWholeSet || next.status === 'authorized') {
      // Permission for the remaining files is already held, so the path gate is
      // satisfied and the write proceeds. The *review* gate is not skipped:
      // every written file is still shown afterwards.
      this.approvals.setPending(nextProposal);
      this.machine.transition(PairPilotState.WAITING_FILE_APPROVAL, 'pre-approved by the set');
      this.deps.notify();
      await this.applyChange(nextProposal, turnId);
      return;
    }

    // Not authorised: ask about this file, exactly as the first one was asked
    // about. The batch remains open behind the gate.
    this.approvals.setPending(nextProposal);
    this.enterFileApproval();
  }

  /**
   * Summarise what the batch actually did, once none of it is left to do.
   *
   * A batch that wrote six of seven files must not report as a plain success.
   * The counts come from the batch's own record, so this is the real filesystem
   * outcome rather than a restatement of what was intended.
   */
  private reportBatchOutcome(): void {
    const batch = this.batch;
    if (!batch) {
      return;
    }
    const counts = batch.counts();
    if (counts.failed === 0) {
      return;
    }
    const failedFiles = batch
      .all()
      .filter((entry) => entry.status === 'failed')
      .map((entry) => entry.relativePath);
    this.notice = `${counts.completed} of ${counts.total} files were written. These could not be written: ${failedFiles.join(', ')}. The rest of the proposal is unaffected.`;
  }

  /** Reconstruct the per-file proposal for a batch entry. */
  private proposalForEntry(entry: BatchFileEntry): ValidatedProposal {
    return toValidatedProposal(entry.change, this.changeSet?.envelope);
  }

  /**
   * The validated proposal for a path that has just been reviewed.
   *
   * Falls back to the batch entry, then to the pending approval, so a caller
   * that has already consumed the pending decision still gets the file it means
   * rather than a null that would settle the turn early.
   */
  private requireReviewed(relativePath: string): ValidatedProposal {
    const entry = this.batch?.byRelativePath(relativePath);
    if (entry) {
      return this.proposalForEntry(entry);
    }
    const pending = this.approvals.getPending();
    if (pending && pending.relativePath === relativePath) {
      return pending;
    }
    const change = this.changeQueue.find((item) => item.relativePath === relativePath);
    if (change) {
      return toValidatedProposal(change, this.changeSet?.envelope);
    }
    // Should be unreachable; throwing beats settling a turn against the wrong file.
    throw new Error(`No validated proposal is held for "${relativePath}".`);
  }

  /**
   * The last change of a set has been approved: run the advisor and settle.
   *
   * Split out because it is also the single-file path, and because the state
   * machine's APPROVED → ANALYZING_NEXT_STEP → COMPLETED sequence should read
   * the same whether one file or ten were written.
   */
  private async afterSetApproved(proposal: ValidatedProposal): Promise<void> {
    const turnId = ++this.activeTurnId;
    try {
      const code = this.readFileQuietly(proposal.absolutePath) ?? proposal.assembledCode;
      await this.runAdvisorTurn(turnId, {
        relativePath: proposal.relativePath,
        code,
        dependencies: proposal.proposal.dependencies,
        existingPaths: await this.listWorkspacePaths(),
      });
      this.assertCurrentTurn(turnId);
      this.machine.transition(PairPilotState.COMPLETED, 'advisor finished');
      this.resetChangeSet();
      this.deps.notify();
    } catch (error) {
      if (error instanceof CancelledError) {
        this.handleTurnFailure(error, turnId);
        return;
      }
      // Advisor failure is not a failure of the approval.
      this.deps.logger.warn(`The engineering advisor failed: ${describeError(error)}`);
      this.machine.tryTransition(PairPilotState.COMPLETED, 'advisor unavailable');
      this.resetChangeSet();
      this.deps.notify();
    }
  }

  /** The developer rejected the written code. The file is rolled back. */
  async rejectCode(contentHash: string, binding?: DecisionBindingInput): Promise<void> {
    if (!this.machine.is(PairPilotState.WAITING_CODE_APPROVAL, PairPilotState.REVIEWING)) {
      this.error = 'There is nothing awaiting rejection.';
      this.deps.notify();
      return;
    }
    let proposal: ValidatedProposal;
    try {
      this.batch?.assertFresh(binding, this.approvals.getPending()?.relativePath);
      proposal = this.approvals.verify(contentHash);
    } catch (error) {
      this.error = describeError(error);
      this.deps.notify();
      return;
    }

    this.approvals.record('reject', proposal);
    this.machine.transition(PairPilotState.REJECTED, 'code rejected');

    // Rejected code must not remain in the workspace.
    const rollback = await this.rollbackWrittenFile(proposal, 'rejected');
    this.activeProposal = null;
    this.recommendation = null;
    this.streamingCode = [];
    this.batch?.markRejected(proposal.relativePath);

    const base = rollback.restored
      ? `Rejected. ${proposal.relativePath} was restored to its previous content.`
      : `Rejected. ${proposal.relativePath} was removed, because PairPilot created it.`;

    // Rejecting one file is a decision about that file. The rest of the batch is
    // untouched and still listed, so the developer can carry on with the files
    // they have not yet judged. Only when there is nothing left does the turn end.
    const stillToCome = this.batch
      ? this.batch.all().filter((entry) => entry.status === 'pending' || entry.status === 'authorized').length
      : this.changeQueue.length - this.changeCursor - 1;

    if (this.batch && stillToCome > 0) {
      this.notice = `${base} The other ${stillToCome} file${stillToCome === 1 ? '' : 's'} in this proposal are still waiting.`;
      this.currentStep = null;
      this.machine.tryTransition(PairPilotState.IDLE, 'ready for the next file');
      this.deps.notify();
      await this.advanceAfterFile(proposal.relativePath, this.activeTurnId, {});
      return;
    }

    this.machine.tryTransition(PairPilotState.IDLE, 'turn finished');
    this.notice =
      stillToCome > 0
        ? `${base} The ${stillToCome} remaining file${stillToCome === 1 ? '' : 's'} in this proposal were not written.`
        : base;
    this.deps.notify();
    this.discardRemainingChanges();
  }

  /** The developer asked for a revised proposal. */
  async requestChanges(
    contentHash: string,
    feedback: string,
    binding?: DecisionBindingInput
  ): Promise<void> {
    if (!this.machine.is(PairPilotState.WAITING_CODE_APPROVAL, PairPilotState.REVIEWING)) {
      this.error = 'There is nothing to revise.';
      this.deps.notify();
      return;
    }
    let proposal: ValidatedProposal;
    try {
      this.batch?.assertFresh(binding, this.approvals.getPending()?.relativePath);
      proposal = this.approvals.verify(contentHash);
    } catch (error) {
      this.error = describeError(error);
      this.deps.notify();
      return;
    }

    this.approvals.record('request_changes', proposal, { feedback });
    this.machine.transition(PairPilotState.REQUESTING_CHANGES, 'changes requested');

    // Roll the file back before asking for a revision, so the workspace holds no
    // unapproved content while the AI thinks.
    await this.rollbackWrittenFile(proposal, 'cancelled');
    this.activeProposal = null;

    // A revision is scoped to the file it was asked about. The batch keeps every
    // sibling exactly as it is, which is what lets the developer revise
    // `index.php` while `create.php` still sits written and unreviewed.
    this.batch?.markRevision(proposal.relativePath);

    // Tells `stageProposal` that the reply about to arrive revises one file of
    // the batch in flight, so it is merged into that batch instead of replacing
    // it.
    this.revisingPath = proposal.relativePath;

    const turnId = ++this.activeTurnId;
    this.deps.notify();
    try {
      await this.retryWithFeedback(proposal, feedback, turnId);
    } catch (error) {
      this.handleTurnFailure(error, turnId);
    }
  }

  /** Re-run the turn with the developer's feedback attached. */
  private async retryWithFeedback(
    previous: ValidatedProposal,
    feedback: string,
    turnId: number
  ): Promise<void> {
    const config = this.deps.readConfig();
    this.deps.ai.requireProvider();
    const record = this.deps.store.getOrCreateActive();

    this.machine.transition(PairPilotState.ANALYZING, 'revising the proposal');
    this.currentStep = 'Revising the proposal';
    this.streamingText = '';
    this.streamingCode = [];
    this.deps.notify();

    const assembled =
      this.lastAssembled ?? (await this.deps.workspace.assemble([...this.pinnedContext], config.budget));
    const task = this.currentTask ?? 'Revise the previous proposal.';
    const prompt = buildProposalPrompt({
      ...this.promptContext(assembled, task),
      typeHint: expectedTypeHint('engineering'),
      feedback,
      previousProposal: {
        filePath: previous.relativePath,
        operation: previous.proposal.operation,
        code: previous.assembledCode,
      },
    });

    this.machine.transition(PairPilotState.PROPOSING, 'requesting a revision');
    this.deps.notify();

    const result = await this.runRuntimeTurn({
      // A revision is still coding work, so it resolves through the same role as
      // the original proposal.
      role: 'coding',
      taskLabel: this.currentTask,
      prompt,
      resumeSessionId: this.deps.store.getRuntimeSessionId(record.id),
      timeoutMs: config.timeoutMs,
      scanCode: true,
      turnId,
    });
    this.assertCurrentTurn(turnId);

    if (result.cancelled) {
      throw new CancelledError();
    }
    if (result.sessionId) {
      this.deps.store.setRuntimeSessionId(record.id, result.sessionId);
    }
    this.recordUsage(record.id, result.usage, result.isError);

    if (result.isError) {
      throw new Error(result.errorMessage ?? 'The AI runtime reported an error.');
    }

    const interpretation = interpretTurn(result.text);
    this.protocol.record({
      ok: interpretation.kind !== 'failure',
      adaptation: interpretation.kind === 'failure' ? 'prose' : interpretation.adaptation,
      raw: interpretation.kind === 'failure' ? interpretation.failure.raw : result.text,
      sessionId: record.id,
      ...(interpretation.kind === 'failure'
        ? { issues: interpretation.failure.issues, failureKind: interpretation.failure.kind }
        : { notes: interpretation.notes, messageType: interpretation.message.type }),
    });

    if (interpretation.kind === 'failure') {
      this.failTurn(interpretation.failure);
      return;
    }
    if (interpretation.kind !== 'proposal') {
      this.appendAssistant(record.id, renderMessage(interpretation.message), result.usage);
      this.machine.tryTransition(PairPilotState.REJECTED, 'the revision was not a proposal');
      this.machine.tryTransition(PairPilotState.IDLE, 'turn finished');
      this.notice =
        'The AI answered with words rather than a new proposal, so nothing was written. Its reply is above.';
      this.currentStep = null;
      this.deps.notify();
      return;
    }

    const staged = this.stageProposal(interpretation.message, interpretation.notes, record.id);
    if (!staged.ok) {
      this.failTurn({
        ok: false,
        kind: 'schema',
        reason: 'The revised proposal could not be applied to this workspace.',
        issues: staged.issues,
        raw: result.text,
      });
    }
  }

  acceptRecommendation(): void {
    if (!this.recommendation) {
      return;
    }
    const suggestion = this.recommendation;
    // Seed the composer instead of acting: spec section 10 says the developer
    // accepts the recommendation, and nothing executes automatically.
    this.currentTask = suggestion.title;
    this.notice =
      'Recommendation accepted. Describe how you would like to proceed, or send the suggested title as-is.';
    this.deps.notify();
  }

  dismissRecommendation(): void {
    this.recommendation = null;
    this.deps.notify();
  }

  /** Cancel whatever is in flight, rolling back any partial write. */
  async cancel(): Promise<void> {
    this.activeTurnId++;
    const wasWriting = this.writer !== null;

    if (this.session) {
      this.session.cancel();
      this.session = null;
    }

    if (this.writer) {
      const writer = this.writer;
      this.writer = null;
      await writer.rollback('cancelled');
      this.notice = 'Cancelled. Any partially written file was rolled back.';
    } else {
      this.notice = 'Cancelled.';
    }

    // Settle the machine, from wherever it was.
    if (!this.machine.is(PairPilotState.IDLE)) {
      if (this.machine.canTransition(PairPilotState.CANCELLED)) {
        this.machine.transition(PairPilotState.CANCELLED, 'cancelled by the developer');
      }
      if (this.machine.canTransition(PairPilotState.IDLE)) {
        this.machine.transition(PairPilotState.IDLE, 'ready');
      }
    }

    this.resetChangeSet();
    this.pendingFilePath = null;
    this.pendingFileOperation = null;
    this.activeProposal = null;
    this.streamingText = '';
    this.streamingCode = [];
    this.currentStep = null;
    this.approvals.clearPending();
    void wasWriting;
    this.deps.notify();
  }

  /* ---------------------------------------------------------------------- */
  /* Interrupting a write                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Hold the stream where it is, so the developer can read what has arrived.
   *
   * The characters keep coming from the model — they are not ours to stop — but
   * nothing further is put into the editor until resume. The alternative, a
   * write that cannot be paused, forces the developer to choose between watching
   * a file they have already decided is wrong and cancelling work that may be
   * nearly right.
   *
   * The document already written is left exactly as it is: pausing is not an
   * undo, and the developer asked to look, not to undo.
   */
  pauseWrite(): void {
    if (!this.writer || !this.writer.isWriting) {
      return;
    }
    if (this.writePaused) {
      return;
    }
    this.writer.pause();
    this.writePaused = true;
    this.notice = 'Paused. The rest of the file will be written when you resume.';
    this.deps.notify();
  }

  /** Carry on writing from where the pause left off. */
  resumeWrite(): void {
    if (!this.writer || !this.writePaused) {
      return;
    }
    this.writer.resume();
    this.writePaused = false;
    this.notice = 'Resumed.';
    this.deps.notify();
  }

  /**
   * "Not like that" — asked while the file is still being written.
   *
   * This is the mid-stream counterpart of `requestChanges`. It stops the turn,
   * takes the partial content back off disk, and sends the developer's feedback
   * for a revision of *this* file. The batch is deliberately left standing: the
   * other files in the proposal are none of this file's business, and a
   * developer who interrupts one of seven must still find the other six where
   * they left them.
   */
  async requestChangesWhileWriting(feedback: string): Promise<void> {
    const proposal = this.writingProposal;
    const writing = this.machine.is(PairPilotState.CREATING_FILE, PairPilotState.WRITING_CODE);

    if (!proposal || !writing) {
      this.error = 'No file is being written, so there is nothing to change yet.';
      this.deps.notify();
      return;
    }

    // Stop the turn first. Anything the runtime sends from here on belongs to a
    // turn nobody is listening to, and `activeTurnId` is what makes that true.
    this.activeTurnId += 1;
    this.session?.cancel();
    this.session = null;

    // Take the partial file back off disk before asking for a revision: the
    // developer has said the content is wrong, so leaving half of it in the
    // workspace while the AI thinks would be leaving unapproved code behind.
    const writer = this.writer;
    this.writer = null;
    this.writingProposal = null;
    this.writePaused = false;
    if (writer) {
      await writer.rollback('cancelled');
    }
    this.approvals.clearPending();
    this.pendingFilePath = null;
    this.pendingFileOperation = null;

    this.approvals.record('request_changes', proposal, { feedback });
    this.batch?.markRevision(proposal.relativePath);
    this.revisingPath = proposal.relativePath;

    if (this.machine.canTransition(PairPilotState.CANCELLED)) {
      this.machine.transition(PairPilotState.CANCELLED, 'changes requested during the write');
    }

    const turnId = this.activeTurnId;
    this.deps.notify();
    try {
      await this.retryWithFeedback(proposal, feedback, turnId);
    } catch (error) {
      this.handleTurnFailure(error, turnId);
    }
  }

  /** Explicitly discard an unapproved write that is still on disk. */
  async revertLastWrite(): Promise<void> {
    const pending = this.approvals.getPending();
    if (!pending) {
      vscode.window.showInformationMessage('PairPilot has no unapproved write to revert.');
      return;
    }
    const result = await this.rollbackWrittenFile(pending, 'cancelled');
    this.approvals.clearPending();
    this.activeProposal = null;
    this.pendingFilePath = null;
    this.pendingFileOperation = null;
    this.resetChangeSet();
    if (!this.machine.is(PairPilotState.IDLE)) {
      this.machine.tryTransition(PairPilotState.CANCELLED, 'write reverted');
      this.machine.tryTransition(PairPilotState.IDLE, 'ready');
    }
    this.deps.notify();
    vscode.window.showInformationMessage(
      result.restored
        ? `Restored ${result.relativePath} to its previous content.`
        : `Removed ${result.relativePath}.`
    );
  }

  /** Release everything on deactivate. */
  async dispose(): Promise<void> {
    this.activeTurnId++;
    this.session?.cancel();
    this.session = null;
    // A write left open at shutdown would strand a file; roll it back.
    if (this.writer) {
      await this.writer.rollback('cancelled');
      this.writer = null;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Change-set bookkeeping                                                 */
  /* ---------------------------------------------------------------------- */

  /** Nothing left to apply: settle and hand control back. */
  private finishChangeSet(): void {
    this.resetChangeSet();
    this.currentStep = null;
    this.machine.tryTransition(PairPilotState.COMPLETED, 'change set finished');
    this.machine.tryTransition(PairPilotState.IDLE, 'ready');
    this.deps.notify();
  }

  /** Forget the set in progress without undoing anything already approved. */
  private discardRemainingChanges(): void {
    this.changeSet = null;
    this.changeQueue = [];
    this.changeCursor = 0;
    this.approvedWholeSet = false;
    this.appliedThisSet = [];
    // The batch record goes with it. Leaving it behind would let `batchView`
    // keep reporting a batch whose files no longer exist anywhere, and a later
    // decision could be checked for freshness against content that is gone.
    this.batch = null;
    // A revision and a write belong to the batch they were about. Once the batch
    // is gone neither can be resumed, and leaving `revisingPath` set would make
    // the *next* proposal look like a revision of a batch that no longer exists.
    this.revisingPath = null;
    this.writingProposal = null;
    this.writePaused = false;
  }

  private resetChangeSet(): void {
    this.discardRemainingChanges();
    this.streamingCode = [];
  }

  /** Clear everything a finished turn leaves behind. */
  private resetTurnState(): void {
    this.roadmapGenerated = false;
    this.approvals.reset();
    this.pinnedContext.clear();
    this.lastContextFiles = [];
    this.streamingText = '';
    this.streamingCode = [];
    this.activeProposal = null;
    this.recommendation = null;
    this.error = null;
    this.notice = null;
    this.currentTask = null;
    this.currentStep = null;
    this.pendingFilePath = null;
    this.pendingFileOperation = null;
    this.turnIntention = null;
    this.resetChangeSet();
  }

  /**
   * Return the session to its starting mode.
   *
   * Called only where the session itself restarts — a new session, or loading a
   * different one. Deliberately *not* part of `resetTurnState`: the mode is the
   * whole session's context, and clearing it between turns would put the
   * developer back in Discovery every time they answered a question.
   */
  private resetMode(reason: string): void {
    this.mode = 'discovery';
    this.modeReason = reason;
  }

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                */
  /* ---------------------------------------------------------------------- */

  /** A reply that carried words rather than a change: the turn is over. */
  private settleAfterNarrative(): void {
    this.machine.tryTransition(PairPilotState.COMPLETED, 'answered');
    this.machine.tryTransition(PairPilotState.IDLE, 'ready');
    this.deps.notify();
  }

  /** Report a proposal that could not be read or applied, and settle. */
  private failTurn(failure: ProtocolParseFailure): void {
    this.machine.tryTransition(PairPilotState.REJECTED, 'no usable proposal in the reply');
    this.machine.tryTransition(PairPilotState.IDLE, 'turn finished');
    // The rendered form, not just `reason`: the reason is one generic line, and
    // the developer's next move depends on the field-level detail underneath it
    // ("/changes/2/content — each change must carry the complete file content").
    // Reporting the reason alone is how the original bug read as an accusation
    // with nothing actionable in it.
    this.error = describeProtocolFailure(failure);
    this.currentStep = null;
    this.deps.notify();
  }

  private requirePending(): ValidatedProposal {
    const pending = this.approvals.getPending();
    if (!pending) {
      throw new Error('There is no proposal awaiting your decision.');
    }
    return pending;
  }

  private async finishWithRollback(
    writer: LiveWriter,
    proposal: ValidatedProposal,
    reason: string,
    status: 'cancelled' | 'conflict' | 'failed'
  ): Promise<void> {
    const rollback = await writer.rollback(
      status === 'conflict' ? 'user_edited' : status === 'cancelled' ? 'cancelled' : 'failed'
    );
    this.writer = null;
    this.approvals.clearPending();
    this.activeProposal = null;
    this.streamingCode = [];
    this.pendingFilePath = null;
    this.pendingFileOperation = null;
    this.currentStep = null;

    // A change set fails as a unit: leaving files 1 and 2 on disk while file 3
    // could not be written would leave a half-built module behind, which is the
    // exact state the approval flow exists to prevent.
    await this.undoAppliedChanges();

    if (!this.machine.is(PairPilotState.IDLE) && !this.machine.isTerminal()) {
      this.machine.tryTransition(PairPilotState.FAILED, 'write interrupted');
      this.machine.tryTransition(PairPilotState.IDLE, 'ready');
    }

    const record = this.deps.store.getActive();
    if (record) {
      this.deps.store.recordRollback(record.id, {
        relativePath: proposal.relativePath,
        reason: status === 'conflict' ? 'user_edited' : status === 'cancelled' ? 'cancelled' : 'failed',
        at: Date.now(),
        restored: rollback.restored,
      });
    }

    this.discardRemainingChanges();
    this.error = rollback.restored
      ? `${reason} ${proposal.relativePath} was restored to its previous content.`
      : `${reason} ${proposal.relativePath} was removed.`;
    this.deps.notify();
  }

  /**
   * Undo every file this change set has already written.
   *
   * Used only when the set fails part-way through. Files the developer has
   * already *approved* are not in this list, because approval removes them from
   * the set's provisional state.
   */
  private async undoAppliedChanges(): Promise<void> {
    const applied = [...this.appliedThisSet].reverse();
    this.appliedThisSet = [];
    for (const entry of applied) {
      const absolute = joinPath(this.deps.workspace.workspaceRoot, entry.relativePath);
      if (!fs.existsSync(absolute)) {
        continue;
      }
      if (entry.operation === 'update') {
        const previous = this.previousContentByPath.get(entry.relativePath);
        if (previous === undefined) {
          this.deps.logger.warn(
            `Cannot restore ${entry.relativePath}: its previous content is no longer available.`
          );
          continue;
        }
        try {
          fs.writeFileSync(absolute, previous, 'utf8');
        } catch (error) {
          this.deps.logger.error(`Failed to restore ${entry.relativePath}: ${describeError(error)}`);
        }
        continue;
      }
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(absolute), { useTrash: false });
      } catch (error) {
        this.deps.logger.error(`Failed to remove ${entry.relativePath}: ${describeError(error)}`);
      }
    }
  }

  /** Roll back a file that a proposal previously wrote, if it is still present. */
  private async rollbackWrittenFile(
    proposal: ValidatedProposal,
    reason: 'cancelled' | 'user_edited' | 'failed' | 'rejected'
  ): Promise<{ restored: boolean; relativePath: string; reason: string }> {
    const exists = fs.existsSync(proposal.absolutePath);
    if (!exists) {
      return { restored: false, relativePath: proposal.relativePath, reason };
    }

    // An `update` is reverted by restoring its pre-write content, which the
    // writer captured before it touched the file and which is remembered for the
    // lifetime of the set. Creating a file needs the file removed instead:
    // leaving an unapproved new file behind is exactly the silent modification
    // the spec forbids.
    if (proposal.proposal.operation === 'update') {
      const previous = this.previousContentByPath.get(proposal.relativePath);
      if (previous === undefined) {
        this.deps.logger.warn(
          `Cannot restore ${proposal.relativePath}: the previous content is no longer available.`
        );
        this.deps.store.getActive();
        return {
          restored: false,
          relativePath: proposal.relativePath,
          reason: `${reason} (previous content unavailable)`,
        };
      }
      try {
        fs.writeFileSync(proposal.absolutePath, previous, 'utf8');
        return { restored: true, relativePath: proposal.relativePath, reason };
      } catch (error) {
        this.deps.logger.error(`Failed to restore ${proposal.relativePath}: ${describeError(error)}`);
        return { restored: false, relativePath: proposal.relativePath, reason };
      }
    }

    try {
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.uri.fsPath === proposal.absolutePath) {
          await vscode.window.showTextDocument(editor.document, { preview: false });
          await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }
      }
      await vscode.workspace.fs.delete(vscode.Uri.file(proposal.absolutePath), { useTrash: false });
      return { restored: false, relativePath: proposal.relativePath, reason };
    } catch (error) {
      this.deps.logger.error(`Failed to remove ${proposal.relativePath}: ${describeError(error)}`);
      return { restored: false, relativePath: proposal.relativePath, reason };
    }
  }

  /** Remember pre-write content so an `update` can be reverted later. */
  rememberPreviousContent(relativePath: string, content: string): void {
    this.previousContentByPath.set(relativePath, content);
  }

  private async revealInEditor(absolutePath: string): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
      await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
    } catch (error) {
      this.deps.logger.warn(`Could not open the written file in the editor: ${describeError(error)}`);
    }
  }

  private async confirmSensitiveWrite(relativePath: string, reason: string): Promise<boolean> {
    const WRITE = 'Write to this file';
    const CANCEL = 'Cancel';
    const choice = await vscode.window.showWarningMessage(
      `PairPilot is about to write to "${relativePath}". ${reason}`,
      { modal: true },
      WRITE,
      CANCEL
    );
    return choice === WRITE;
  }

  private async listWorkspacePaths(): Promise<string[]> {
    try {
      const uris = await vscode.workspace.findFiles(
        '**/*',
        '**/{node_modules,.git,dist,build,out,vendor}/**',
        3000
      );
      const paths: string[] = [];
      for (const uri of uris) {
        const relative = this.deps.workspace.toRelative(uri);
        if (relative) {
          paths.push(relative);
        }
      }
      return paths;
    } catch {
      return [];
    }
  }

  private readFileQuietly(absolutePath: string): string | null {
    try {
      return fs.readFileSync(absolutePath, 'utf8');
    } catch {
      return null;
    }
  }

  private hashFileQuietly(absolutePath: string): string | null {
    const content = this.readFileQuietly(absolutePath);
    if (content === null) {
      return null;
    }
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  /**
   * Write down what a request cost.
   *
   * Separate from `appendAssistant` on purpose: a retried attempt is billed but
   * produces no message, and conflating the two would either lose the cost or
   * put a rejected reply into the transcript.
   */
  private recordUsage(sessionId: string, usage: TokenUsage, isError: boolean): void {
    if (usage.available) {
      this.deps.store.addUsage(sessionId, usage);
    }
    void isError;
  }

  /** Append the assistant's answer to the session transcript. */
  private appendAssistant(sessionId: string, text: string, usage: TokenUsage | undefined): void {
    const body = text.trim().length > 0 ? text : '(the AI returned no readable text)';
    this.appendMessage(sessionId, {
      id: crypto.randomUUID(),
      role: 'assistant',
      text: body,
      timestamp: Date.now(),
      ...(usage && usage.available ? { usage } : {}),
    });
  }

  private appendMessage(sessionId: string, message: ChatMessage): void {
    this.deps.store.appendMessage(sessionId, message);
  }

  private assertCurrentTurn(turnId: number): void {
    if (turnId !== this.activeTurnId) {
      throw new CancelledError('The operation was superseded by a newer request.');
    }
  }

  /** Refuse to start something new while a turn is in flight. */
  private assertIdleish(action: string): void {
    if (this.machine.isBusy()) {
      throw new Error(`Cannot ${action} while PairPilot is working. Cancel it first.`);
    }
  }

  private handleTurnFailure(error: unknown, turnId: number): void {
    if (turnId !== this.activeTurnId) {
      return;
    }
    const cancelled = error instanceof CancelledError;
    const declined = error instanceof DeclinedError;

    this.streamingText = '';
    this.streamingCode = [];
    this.pendingFilePath = null;
    this.pendingFileOperation = null;
    this.currentStep = null;

    if (!this.machine.is(PairPilotState.IDLE)) {
      if (this.machine.canTransition(PairPilotState.CANCELLED) && (cancelled || declined)) {
        this.machine.transition(PairPilotState.CANCELLED, describeError(error));
      } else if (this.machine.canTransition(PairPilotState.FAILED)) {
        this.machine.transition(PairPilotState.FAILED, describeError(error));
      }
      this.machine.tryTransition(PairPilotState.IDLE, 'ready');
    }

    if (cancelled) {
      this.notice = describeError(error);
      this.error = null;
    } else {
      this.error = describeError(error);
    }
    this.discardRemainingChanges();
    this.approvals.clearPending();
    this.deps.notify();
  }
}

/* -------------------------------------------------------------------------- */
/* Module-level helpers                                                       */
/* -------------------------------------------------------------------------- */

/** Normalise line endings so a CRLF conversion is not mistaken for tampering. */
export function normaliseNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

/** Absolute path helper kept local to avoid a `path` import cycle in tests. */
export function joinPath(root: string, relative: string): string {
  return path.join(root, ...relative.split('/'));
}

/**
 * Turn a thrown validation error into protocol issues.
 *
 * The validator reports in plain sentences, which is what the developer should
 * read; the retry prompt wants the same sentences, so they are carried across
 * unchanged rather than being re-derived.
 */
/**
 * A refused proposal, rendered for the transcript.
 *
 * The developer gets to see what the model wanted to build — a proposal offered
 * during a design conversation is often a useful concrete sketch — without any
 * of it being staged for approval. Only the plan is shown: the file list, the
 * operations and the model's own explanation. The file *contents* are left out,
 * because showing them is what makes a refusal look like a half-applied write.
 */
function renderProposalSummary(message: CodeProposalMessage): string {
  const lines = [message.message, ''];
  if (message.changes.length > 0) {
    lines.push('Refused — this was proposed but not applied:');
    for (const change of message.changes) {
      lines.push(`  • ${change.operation} ${change.file} — ${change.description}`);
    }
  }
  return lines.join('\n').trimEnd();
}

/**
 * The mode's own instructions, placed above the general type list.
 *
 * The mode hint is not a disclaimer bolted onto the prompt — it is the positive
 * description of what this turn is. A prompt that only forbids ("do not write
 * code") gives the model nothing to aim at, and models answer that kind of
 * instruction by finding a technically-compliant way to write code anyway.
 */
function buildPolicyHint(
  policy: WorkflowPolicy,
  intent: 'conversational' | 'engineering'
): string {
  return [
    `## Current workflow mode: ${WORKFLOW_MODE_META[policy.mode].label}`,
    WORKFLOW_MODE_META[policy.mode].summary,
    '',
    policy.hint(intent),
    policy.allowsProposals
      ? ''
      : `You may answer with any of: ${policy.allowedTypes.join(', ')}.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function issuesFromError(error: unknown): ProtocolIssue[] {
  const issues = (error as { issues?: unknown }).issues;
  if (Array.isArray(issues)) {
    return issues
      .filter((issue): issue is string => typeof issue === 'string')
      .map((message) => ({ path: '', message, code: 'invalid_value' as const }));
  }
  return [{ path: '', message: describeError(error), code: 'invalid_value' as const }];
}

/**
 * Is a workspace-level validation failure worth re-asking the model about?
 *
 * Only for the failures a different reply can fix. A path outside the workspace,
 * a `..` segment or a sensitive target are policy refusals: the model cannot
 * talk PairPilot out of them, and re-asking would spend a request to be told the
 * same thing again.
 */
function stageRetryable(issues: readonly ProtocolIssue[]): boolean {
  if (issues.length === 0) {
    return false;
  }
  const policyCodes: readonly string[] = ['missing_field', 'empty_value', 'wrong_type'];
  void policyCodes;
  const unfixable = /(outside the workspace|"\.\." segment|looks sensitive|absolute path|build output|dependency directory)/i;
  return !issues.some((issue) => unfixable.test(issue.message));
}

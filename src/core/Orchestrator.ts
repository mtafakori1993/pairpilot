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
 * The turn, end to end:
 *
 *   IDLE
 *     -> ANALYZING            assemble context; start the CLI
 *     -> PROPOSING            parse and validate the proposal
 *     -> WAITING_FILE_APPROVAL  ask permission to create/update the target
 *     -> CREATING_FILE        create the empty file / read the original
 *     -> WRITING_CODE         stream real deltas into the real editor
 *     -> REVIEWING            open the review panel
 *     -> WAITING_CODE_APPROVAL  wait for approve / reject / request changes
 *     -> APPROVED             record the decision
 *     -> ANALYZING_NEXT_STEP  advisor
 *     -> COMPLETED
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
import { ClaudeSession } from '../runtime/ClaudeSession';
import type { ClaudeCodeRuntime } from '../runtime/ClaudeCodeRuntime';
import { buildAdvisorPrompt, buildProposalPrompt, summariseContext } from '../runtime/prompts';
import { ProposalParser } from '../proposals/ProposalParser';
import { ProposalValidator } from '../proposals/ProposalValidator';
import { ApprovalManager, toProposalRecord } from '../proposals/ApprovalManager';
import { LiveWriter } from '../editor/LiveWriter';
import type { DiffManager } from '../editor/DiffManager';
import type { WorkspaceContext, ContextBudget } from '../context/WorkspaceContext';
import type { SessionStore } from '../storage/SessionStore';
import {
  PairPilotState,
  type AdvisorRecommendation,
  type ChatMessage,
  type ContextFileSummary,
  type Logger,
  type ProposalRecord,
  type TokenUsage,
  type ValidatedProposal,
} from '../types';

export interface OrchestratorDeps {
  context: vscode.ExtensionContext;
  logger: Logger;
  runtime: ClaudeCodeRuntime;
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
  bare: boolean;
  timeoutMs: number;
  extraArgs: string[];
  budget: ContextBudget;
  requireSensitiveApproval: boolean;
  allowSensitiveFileContext: boolean;
  advisorEnabled: boolean;
  advisorUseAI: boolean;
}

export class Orchestrator {
  readonly machine = new StateMachine();
  readonly approvals = new ApprovalManager();

  private readonly parser = new ProposalParser();
  private validator: ProposalValidator;
  private readonly advisor: EngineeringAdvisor;

  private session: ClaudeSession | null = null;
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

  /* ---------------------------------------------------------------------- */
  /* Entry points                                                           */
  /* ---------------------------------------------------------------------- */

  /** Start a fresh session. Refuses while a turn is in flight. */
  newSession(): void {
    this.assertIdleish('start a new session');
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
    this.approvals.reset();
    this.activeProposal = null;
    this.recommendation = null;
    this.streamingText = '';
    this.streamingCode = [];
    this.error = null;
    this.notice = `Resumed session "${record.title}". Runtime context is preserved where available.`;
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
      this.error =
        'Resolve the current review first: approve, reject, or request changes.';
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
      await this.runProposalTurn(task, turnId);
    } catch (error) {
      this.handleTurnFailure(error, turnId);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* The turn                                                              */
  /* ---------------------------------------------------------------------- */

  private async runProposalTurn(task: string, turnId: number): Promise<void> {
    const config = this.deps.readConfig();
    const executable = this.deps.runtime.requireExecutable();

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
        `Context skipped: ${assembled.skipped.map((entry) => `${entry.relativePath} (${entry.reason})`).join('; ')}`
      );
    }
    this.assertCurrentTurn(turnId);

    const prompt = buildProposalPrompt({
      task,
      ...(assembled.activeFile !== undefined ? { activeFile: assembled.activeFile } : {}),
      ...(assembled.treeSummary !== undefined ? { treeSummary: assembled.treeSummary } : {}),
      contextFiles: assembled.files.map((file) => ({
        relativePath: file.relativePath,
        content: file.content,
        truncated: file.truncated,
      })),
      pinnedContext: [...this.pinnedContext],
    });

    const record = this.deps.store.getOrCreateActive();

    this.machine.transition(PairPilotState.PROPOSING, 'requesting a proposal');
    this.currentStep = 'Waiting for the AI to propose code';
    this.deps.notify();

    const result = await this.runRuntimeTurn({
      executable,
      prompt,
      resumeSessionId: this.deps.store.getRuntimeSessionId(record.id),
      config,
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
    this.recordUsage(record.id, result.usage, result.text, result.isError);

    if (result.isError) {
      throw new Error(result.errorMessage ?? 'The AI runtime reported an error.');
    }

    // --- parse and validate ------------------------------------------------
    this.currentStep = 'Validating the proposal';
    this.deps.notify();

    const parsed = this.parser.parse(result.text);
    if (!parsed.ok) {
      // Not an error the developer must fix: the model simply answered in prose.
      this.machine.transition(PairPilotState.REJECTED, 'no proposal in the response');
      this.machine.tryTransition(PairPilotState.IDLE, 'turn finished');
      this.error =
        `${parsed.reason} PairPilot did not write anything. Try rephrasing the task to ask for a specific file.`;
      this.currentStep = null;
      this.deps.notify();
      return;
    }

    let validated: ValidatedProposal;
    try {
      validated = this.validator.validate(parsed.proposal);
    } catch (error) {
      this.machine.transition(PairPilotState.REJECTED, 'validation failed');
      this.machine.tryTransition(PairPilotState.IDLE, 'turn finished');
      this.error = describeError(error);
      if (error instanceof Error && 'issues' in error) {
        const issues = (error as { issues?: string[] }).issues;
        if (Array.isArray(issues) && issues.length > 0) {
          this.error = `${describeError(error)}\n\n${issues.map((issue) => `• ${issue}`).join('\n')}`;
        }
      }
      this.currentStep = null;
      this.deps.notify();
      return;
    }

    if (validated.warnings.length > 0) {
      this.deps.logger.warn(`Proposal warnings: ${validated.warnings.join(' | ')}`);
    }

    // --- permission to create/update ---------------------------------------
    this.approvals.setPending(validated);
    this.machine.transition(PairPilotState.WAITING_FILE_APPROVAL, 'awaiting file permission');
    this.pendingFilePath = validated.relativePath;
    this.pendingFileOperation = validated.proposal.operation;
    this.currentStep =
      validated.proposal.operation === 'create'
        ? `Waiting for your permission to create ${validated.relativePath}`
        : `Waiting for your permission to update ${validated.relativePath}`;
    this.deps.notify();
    // The turn now pauses in WAITING_FILE_APPROVAL until the developer decides.
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

    if (config.advisorUseAI && this.deps.runtime.getStatus().available) {
      try {
        const executable = this.deps.runtime.requireExecutable();
        const record = this.deps.store.getOrCreateActive();
        const prompt = buildAdvisorPrompt({
          relativePath: input.relativePath,
          code: input.code.slice(0, 60_000),
          dependencies: input.dependencies,
          existingPaths: input.existingPaths,
        });

        const result = await this.runRuntimeTurn({
          executable,
          prompt,
          resumeSessionId: this.deps.store.getRuntimeSessionId(record.id),
          config,
          scanCode: false,
          turnId,
        });
        this.assertCurrentTurn(turnId);
        this.recordUsage(record.id, result.usage, result.text, result.isError);

        if (!result.cancelled && !result.isError) {
          const parsed = this.advisor.parseAdvisorReply(result.text, input);
          if (parsed) {
            this.recommendation = parsed;
            this.currentStep = null;
            this.deps.notify();
            return;
          }
          this.deps.logger.warn(
            'The advisor reply could not be parsed; falling back to local analysis.'
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

  /** Start a runtime process and wire its stream into the writer and the UI. */
  private runRuntimeTurn(options: {
    executable: string;
    prompt: string;
    resumeSessionId: string | undefined;
    config: OrchestratorConfig;
    scanCode: boolean;
    turnId: number;
  }) {
    const session = new ClaudeSession({
      executablePath: options.executable,
      cwd: this.deps.workspace.workspaceRoot,
      prompt: options.prompt,
      ...(options.resumeSessionId !== undefined
        ? { resumeSessionId: options.resumeSessionId }
        : {}),
      bare: options.config.bare,
      extraArgs: options.config.extraArgs,
      timeoutMs: options.config.timeoutMs,
      scanCode: options.scanCode,
      logger: this.deps.logger,
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
          if (name === 'filePath' && value) {
            this.currentStep = `Proposing ${value}`;
          }
        },
        onDiagnostic: (line) => this.deps.logger.diagnostic(line),
      },
    });

    this.session = session;
    return session.run().finally(() => {
      if (this.session === session) {
        this.session = null;
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Developer decisions                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * The developer permitted the file to be created or updated.
   *
   * Only legal in `WAITING_FILE_APPROVAL`. The hash is verified first, so a
   * stale UI cannot authorise a different proposal.
   */
  async approveFileCreation(contentHash: string): Promise<void> {
    if (!this.machine.is(PairPilotState.WAITING_FILE_APPROVAL)) {
      this.error = 'There is no pending file request to approve.';
      this.deps.notify();
      return;
    }

    let proposal: ValidatedProposal;
    try {
      proposal = this.approvals.verify(contentHash);
    } catch (error) {
      this.error = describeError(error);
      this.deps.notify();
      return;
    }

    const config = this.deps.readConfig();
    const turnId = this.activeTurnId;

    try {
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

      await writer.begin(proposal.relativePath, proposal.proposal.operation, {
        approvedCreate: true,
        expectedTotal: proposal.assembledCode.length,
      });
      this.assertCurrentTurn(turnId);

      this.machine.transition(PairPilotState.WRITING_CODE, 'writing into the editor');
      this.currentStep = `Writing ${proposal.relativePath}`;
      this.deps.notify();

      // The stream may already have delivered every code delta while we were
      // waiting for permission. In that case, write the validated content now:
      // it is the same bytes that the scanner decoded, and it is what was hashed.
      const alreadyStreamed = this.streamingCode.join('');
      if (alreadyStreamed.length === 0) {
        // No deltas arrived (for example the runtime buffered the whole reply),
        // so play the real validated content through the same path.
        for (const block of proposal.proposal.blocks) {
          writer.push(block.code);
          if (proposal.proposal.blocks.indexOf(block) < proposal.proposal.blocks.length - 1) {
            writer.push('\n');
          }
        }
      } else if (alreadyStreamed.length < proposal.assembledCode.length) {
        // Some deltas were missed (a truncated scan). Top up with the remainder
        // of the validated content, which is the reviewed authority.
        const remainder = proposal.assembledCode.slice(alreadyStreamed.length);
        writer.push(remainder);
      }

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
      this.activeProposal = toProposalRecord(proposal);
      this.deps.store.addProposal(this.deps.store.getOrCreateActive().id, this.activeProposal);
      this.pendingFilePath = null;
      this.pendingFileOperation = null;

      this.machine.transition(PairPilotState.REVIEWING, 'write complete');
      this.currentStep = `Reviewing ${proposal.relativePath}`;
      this.deps.notify();

      this.machine.transition(PairPilotState.WAITING_CODE_APPROVAL, 'awaiting review');
      this.deps.notify();

      // Open the file so the code is visible in the real editor, not just the
      // Webview (spec section 8).
      await this.revealInEditor(proposal.absolutePath);
    } catch (error) {
      if (this.writer) {
        await this.writer.rollback('failed');
        this.writer = null;
      }
      this.handleTurnFailure(error, turnId);
    }
  }

  /** The developer declined the file creation/update. Nothing was written. */
  rejectFileCreation(contentHash: string): void {
    if (!this.machine.is(PairPilotState.WAITING_FILE_APPROVAL)) {
      this.error = 'There is no pending file request to reject.';
      this.deps.notify();
      return;
    }
    let proposal: ValidatedProposal;
    try {
      proposal = this.approvals.verify(contentHash);
    } catch (error) {
      this.error = describeError(error);
      this.deps.notify();
      return;
    }

    this.approvals.record('reject', proposal);
    this.machine.transition(PairPilotState.REJECTED, 'file creation declined');
    this.machine.tryTransition(PairPilotState.IDLE, 'turn finished');
    this.pendingFilePath = null;
    this.pendingFileOperation = null;
    this.currentStep = null;
    this.notice = `You declined to write ${proposal.relativePath}. No file was created or modified.`;
    this.deps.notify();
  }

  /** The developer approved the written code. */
  async approveCode(contentHash: string): Promise<void> {
    if (!this.machine.is(PairPilotState.WAITING_CODE_APPROVAL, PairPilotState.REVIEWING)) {
      this.error = 'There is nothing awaiting approval.';
      this.deps.notify();
      return;
    }
    let proposal: ValidatedProposal;
    try {
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
    this.deps.notify();

    // Engineering Advisor (spec section 10).
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
      this.deps.notify();
    } catch (error) {
      if (error instanceof CancelledError) {
        this.handleTurnFailure(error, turnId);
        return;
      }
      // Advisor failure is not a failure of the approval.
      this.deps.logger.warn(`The engineering advisor failed: ${describeError(error)}`);
      this.machine.tryTransition(PairPilotState.COMPLETED, 'advisor unavailable');
      this.deps.notify();
    }
  }

  /** The developer rejected the written code. The file is rolled back. */
  async rejectCode(contentHash: string): Promise<void> {
    if (!this.machine.is(PairPilotState.WAITING_CODE_APPROVAL, PairPilotState.REVIEWING)) {
      this.error = 'There is nothing awaiting rejection.';
      this.deps.notify();
      return;
    }
    let proposal: ValidatedProposal;
    try {
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
    this.machine.tryTransition(PairPilotState.IDLE, 'turn finished');
    this.notice = rollback.restored
      ? `Rejected. ${proposal.relativePath} was restored to its previous content.`
      : `Rejected. ${proposal.relativePath} was removed, because PairPilot created it.`;
    this.deps.notify();
  }

  /** The developer asked for a revised proposal. */
  async requestChanges(contentHash: string, feedback: string): Promise<void> {
    if (!this.machine.is(PairPilotState.WAITING_CODE_APPROVAL, PairPilotState.REVIEWING)) {
      this.error = 'There is nothing to revise.';
      this.deps.notify();
      return;
    }
    let proposal: ValidatedProposal;
    try {
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

    const turnId = ++this.activeTurnId;
    this.deps.notify();
    try {
      await this.retryWithFeedback(proposal, feedback, turnId);
    } catch (error) {
      if (error instanceof CancelledError) {
        this.handleTurnFailure(error, turnId);
        return;
      }
      this.handleTurnFailure(error, turnId);
    }
  }

  /** Re-run the proposal turn with the developer's feedback attached. */
  private async retryWithFeedback(
    previous: ValidatedProposal,
    feedback: string,
    turnId: number
  ): Promise<void> {
    const config = this.deps.readConfig();
    const executable = this.deps.runtime.requireExecutable();
    const record = this.deps.store.getOrCreateActive();

    this.machine.transition(PairPilotState.ANALYZING, 'revising the proposal');
    this.currentStep = 'Revising the proposal';
    this.streamingText = '';
    this.streamingCode = [];
    this.deps.notify();

    const assembled = this.lastAssembled ?? (await this.deps.workspace.assemble([...this.pinnedContext], config.budget));
    const prompt = buildProposalPrompt({
      task: this.currentTask ?? 'Revise the previous proposal.',
      ...(assembled.activeFile !== undefined ? { activeFile: assembled.activeFile } : {}),
      ...(assembled.treeSummary !== undefined ? { treeSummary: assembled.treeSummary } : {}),
      contextFiles: assembled.files.map((file) => ({
        relativePath: file.relativePath,
        content: file.content,
        truncated: file.truncated,
      })),
      pinnedContext: [...this.pinnedContext],
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
      executable,
      prompt,
      resumeSessionId: this.deps.store.getRuntimeSessionId(record.id),
      config,
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
    this.recordUsage(record.id, result.usage, result.text, result.isError);

    if (result.isError) {
      throw new Error(result.errorMessage ?? 'The AI runtime reported an error.');
    }

    const parsed = this.parser.parse(result.text);
    if (!parsed.ok) {
      this.machine.transition(PairPilotState.REJECTED, 'revision was not a proposal');
      this.machine.tryTransition(PairPilotState.IDLE, 'turn finished');
      this.error = `${parsed.reason} Nothing was written.`;
      this.currentStep = null;
      this.deps.notify();
      return;
    }

    let validated: ValidatedProposal;
    try {
      validated = this.validator.validate(parsed.proposal);
    } catch (error) {
      this.machine.transition(PairPilotState.REJECTED, 'revision failed validation');
      this.machine.tryTransition(PairPilotState.IDLE, 'turn finished');
      this.error = describeError(error);
      this.currentStep = null;
      this.deps.notify();
      return;
    }

    this.approvals.setPending(validated);
    this.machine.transition(PairPilotState.WAITING_FILE_APPROVAL, 'awaiting file permission');
    this.pendingFilePath = validated.relativePath;
    this.pendingFileOperation = validated.proposal.operation;
    this.currentStep = `Waiting for your permission to write ${validated.relativePath}`;
    this.deps.notify();
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
      const transitions: PairPilotState[] = [];
      if (this.machine.canTransition(PairPilotState.CANCELLED)) {
        this.machine.transition(PairPilotState.CANCELLED, 'cancelled by the developer');
      }
      if (this.machine.canTransition(PairPilotState.IDLE)) {
        this.machine.transition(PairPilotState.IDLE, 'ready');
      }
      void transitions;
    }

    this.pendingFilePath = null;
    this.pendingFileOperation = null;
    this.activeProposal = null;
    this.streamingText = '';
    this.streamingCode = [];
    this.currentStep = null;
    this.approvals.clearPending();
    if (wasWriting) {
      this.deps.notify();
    } else {
      this.deps.notify();
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
  /* Helpers                                                                */
  /* ---------------------------------------------------------------------- */

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

    this.error = rollback.restored
      ? `${reason} ${proposal.relativePath} was restored to its previous content.`
      : `${reason} ${proposal.relativePath} was removed.`;
    this.deps.notify();
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

    // An `update` can be reverted by restoring the pre-write content, but that
    // content is only known to the LiveWriter that performed it. Since the
    // writer is gone by now, use the approval record's decision: an update that
    // was rejected is restored from git-less backup only if we still have it.
    // We do not: so for updates we refuse to guess and leave the file, telling
    // the developer exactly what happened.
    if (proposal.proposal.operation === 'update') {
      const previous = this.previousContentByPath.get(proposal.relativePath);
      if (previous === undefined) {
        this.deps.logger.warn(
          `Cannot restore ${proposal.relativePath}: the previous content is no longer available.`
        );
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
        this.deps.logger.error(
          `Failed to restore ${proposal.relativePath}: ${describeError(error)}`
        );
        return { restored: false, relativePath: proposal.relativePath, reason };
      }
    }

    // A created file must be removed: leaving unapproved new files behind is
    // exactly the silent modification the spec forbids.
    try {
      const uri = vscode.Uri.file(proposal.absolutePath);
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.uri.fsPath === proposal.absolutePath) {
          await vscode.window.showTextDocument(editor.document, { preview: false });
          await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }
      }
      await vscode.workspace.fs.delete(uri, { useTrash: false });
      return { restored: false, relativePath: proposal.relativePath, reason };
    } catch (error) {
      this.deps.logger.error(
        `Failed to remove ${proposal.relativePath}: ${describeError(error)}`
      );
      return { restored: false, relativePath: proposal.relativePath, reason };
    }
  }

  /** Remember pre-write content so an `update` can be reverted later. */
  private readonly previousContentByPath = new Map<string, string>();

  /** Called by `approveFileCreation` via the writer result for update rollback. */
  rememberPreviousContent(relativePath: string, content: string): void {
    this.previousContentByPath.set(relativePath, content);
  }

  private async revealInEditor(absolutePath: string): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
      await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
    } catch (error) {
      this.deps.logger.warn(
        `Could not open the written file in the editor: ${describeError(error)}`
      );
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
      const uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,dist,build,out,vendor}/**', 3000);
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

  private recordUsage(
    sessionId: string,
    usage: TokenUsage,
    assistantText: string,
    isError: boolean
  ): void {
    if (usage.available) {
      this.deps.store.addUsage(sessionId, usage);
    }
    const text =
      assistantText.trim().length > 0
        ? assistantText
        : isError
          ? '(the runtime reported an error)'
          : '(no content)';
    this.appendMessage(sessionId, {
      id: crypto.randomUUID(),
      role: 'assistant',
      text,
      timestamp: Date.now(),
      ...(usage.available ? { usage } : {}),
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
    this.approvals.clearPending();
    this.deps.notify();
  }
}

/** Normalise line endings so a CRLF conversion is not mistaken for tampering. */
export function normaliseNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

/** Absolute path helper kept local to avoid a `path` import cycle in tests. */
export function joinPath(root: string, relative: string): string {
  return path.join(root, ...relative.split('/'));
}

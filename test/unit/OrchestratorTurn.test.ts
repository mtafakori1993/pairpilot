/**
 * Orchestrator turn tests — the reported failure, replayed.
 *
 * ## What this pins
 *
 * The bug report was a *turn* failure, not a parser failure:
 *
 *     Found valid JSON, but it is not a code_proposal object.
 *     PairPilot did not write anything. Try rephrasing the task to ask for a
 *     specific file.
 *
 * Two things had to be true for that message to appear: the parser refused the
 * nested `proposal.changes[]` reply, and the turn demanded a proposal for every
 * instruction — so "Hi" took the same path. Both are now tested here, where the
 * whole turn runs, because a test of the parser alone would not have caught the
 * second one.
 *
 * ## Scope, honestly
 *
 * These tests stop at the point where the developer is asked for permission to
 * write. Everything up to and including the change set being validated, ordered,
 * queued and put in front of the developer is real code running for real. The
 * write itself — `LiveWriter`, `WorkspaceEdit`, the editor — is not exercised
 * here, because it needs an editor host; it is covered by the VS Code
 * integration suite instead. Nothing in this file claims a file was written.
 *
 * `vscode` is mocked down to the two things context assembly genuinely needs —
 * "is there an active editor" and "list the workspace files". Everything else a
 * write would need is absent, so a test that accidentally reached the editor
 * would fail loudly rather than pass against a fake.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('vscode', () => ({
  window: { activeTextEditor: undefined },
  workspace: { findFiles: async () => [] },
  Uri: { file: (fsPath: string) => ({ scheme: 'file', fsPath }) },
}));

import { Orchestrator, type OrchestratorConfig, type OrchestratorDeps, type OrchestratorWritePermissionRequest } from '../../src/core/Orchestrator';
import { SessionStore } from '../../src/storage/SessionStore';
import { WorkspaceContext } from '../../src/context/WorkspaceContext';
import { PAIRPILOT_PROTOCOL_VERSION } from '../../src/protocol/types';
import { PairPilotState, emptyUsage, type Logger, type TurnResult } from '../../src/types';
import type { AIOrchestrator } from '../../src/orchestration/AIOrchestrator';
import type { AITurnHandle, AITurnRequest } from '../../src/types/provider';

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

/** Collects log lines so a test can assert what was reported, and how loudly. */
class RecordingLogger implements Logger {
  readonly infos: string[] = [];
  readonly warns: string[] = [];
  readonly errors: string[] = [];

  info(message: string): void {
    this.infos.push(message);
  }
  warn(message: string): void {
    this.warns.push(message);
  }
  error(message: string): void {
    this.errors.push(message);
  }
  diagnostic(): void {}
}

/** An in-memory `vscode.Memento`. */
class FakeMemento {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string, fallback: T): T {
    return this.values.has(key) ? (this.values.get(key) as T) : fallback;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
  keys(): readonly string[] {
    return [...this.values.keys()];
  }
}

/**
 * A provider stand-in that replays a scripted reply, one per turn.
 *
 * Deliberately records the prompts it was given: the corrective-retry test needs
 * to know that the *second* attempt carried the validator's own complaint, not
 * just that a second attempt happened.
 */
class ScriptedAI {
  readonly prompts: string[] = [];
  readonly requests: AITurnRequest[] = [];
  private readonly replies: string[];
  private index = 0;
  /**
   * Run just before a reply is handed back, given the attempt's index.
   *
   * The one thing a scripted reply cannot do on its own is simulate the real
   * world moving while the model thinks — which is exactly the window a revision
   * goes stale in. A test that needs the developer to edit the file mid-revision
   * installs this, and the edit lands between the request and the answer.
   */
  beforeReply: ((prompt: string, attempt: number) => void) | null = null;

  constructor(...replies: string[]) {
    this.replies = replies;
  }

  requireProvider(): void {}
  isActiveAvailable(): boolean {
    return true;
  }

  startTurn(request: AITurnRequest): AITurnHandle {
    this.requests.push(request);
    this.prompts.push(request.prompt);
    const attempt = this.index;
    const text = this.replies[Math.min(this.index, this.replies.length - 1)] ?? '';
    this.index += 1;

    this.beforeReply?.(request.prompt, attempt);

    let cancelled = false;
    const result: Promise<TurnResult> = Promise.resolve({
      text,
      usage: emptyUsage(),
      isError: false,
      cancelled,
    });

    return {
      result,
      isRunning: false,
      cancel: () => {
        cancelled = true;
      },
    };
  }

  /** How many turns were actually started. */
  get turnCount(): number {
    return this.index;
  }
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

let root: string;
let logger: RecordingLogger;
let store: SessionStore;
let workspace: WorkspaceContext;

const CONFIG: OrchestratorConfig = {
  timeoutMs: 5_000,
  budget: { maxFiles: 8, maxFileBytes: 200_000, maxTotalChars: 400_000, treeDepth: 3, includeTree: true },
  requireSensitiveApproval: true,
  allowSensitiveFileContext: false,
  advisorEnabled: false,
  advisorUseAI: false,
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pairpilot-turn-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'existing.ts'), 'export const existing = true;\n');

  logger = new RecordingLogger();
  store = new SessionStore(new FakeMemento() as never, logger);
  workspace = new WorkspaceContext(root, { allowSensitiveFiles: false }, {
    logger,
    requestSensitiveApproval: async () => false,
  });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makeOrchestrator(
  ai: ScriptedAI,
  roadmap?: OrchestratorDeps['roadmap'],
  askWritePermission?: OrchestratorDeps['askWritePermission']
): Orchestrator {
  const deps: OrchestratorDeps = {
    context: {} as never,
    logger,
    ai: ai as unknown as AIOrchestrator,
    workspace,
    store,
    diff: {} as never,
    notify: () => {},
    notifyTextDelta: () => {},
    notifyWritingProgress: () => {},
    ...(roadmap ? { roadmap } : {}),
    ...(askWritePermission ? { askWritePermission } : {}),
    readConfig: () => CONFIG,
  };
  return new Orchestrator(deps);
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** The reply that produced the bug report: a good proposal, nested one level. */
const REPORTED_REPLY = JSON.stringify({
  type: 'code_proposal',
  message: 'Here is the User class you asked for.',
  proposal: {
    filePath: 'src/User.php',
    operation: 'create',
    description: 'A PHP user entity',
    dependencies: [],
    blocks: [{ id: 'b1', type: 'code', description: '', code: '<?php\n\nfinal class User {}\n' }],
  },
});

/** The canonical two-file reply the prompt now asks for. */
const MULTI_FILE_REPLY = JSON.stringify({
  protocol_version: PAIRPILOT_PROTOCOL_VERSION,
  type: 'code_proposal',
  message: 'A user module backed by SQLite.',
  task: { title: 'User module', description: 'Entity and repository.' },
  changes: [
    {
      id: 'change_001',
      file: 'src/Domain/User.php',
      operation: 'create',
      description: 'The User entity.',
      content: '<?php\n\nfinal class User {}\n',
      dependencies: [],
      risk: 'low',
    },
    {
      id: 'change_002',
      file: 'src/Infrastructure/UserRepository.php',
      operation: 'create',
      description: 'SQLite-backed repository.',
      content: '<?php\n\nfinal class UserRepository {}\n',
      dependencies: ['src/Domain/User.php'],
      risk: 'medium',
    },
  ],
});

/* -------------------------------------------------------------------------- */
/* Scenario A: a greeting is a greeting                                       */
/* -------------------------------------------------------------------------- */

describe('a conversational turn', () => {
  it('answers "Hi" without reporting a protocol failure', async () => {
    const ai = new ScriptedAI(
      JSON.stringify({ type: 'chat_response', message: 'Hello! What would you like to build?' })
    );
    const orchestrator = makeOrchestrator(ai);

    await orchestrator.submitTask('Hi');

    expect(orchestrator.errorValue).toBeNull();
    expect(orchestrator.machine.state).toBe(PairPilotState.IDLE);
  });

  it('puts the answer in the transcript', async () => {
    const ai = new ScriptedAI(
      JSON.stringify({ type: 'chat_response', message: 'Hello! What would you like to build?' })
    );
    const orchestrator = makeOrchestrator(ai);
    await orchestrator.submitTask('Hi');

    const session = store.getActive()!;
    const assistant = session.messages.filter((message) => message.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.text).toBe('Hello! What would you like to build?');
  });

  it('hints conversation rather than a proposal', async () => {
    const ai = new ScriptedAI(JSON.stringify({ type: 'chat_response', message: 'Hello!' }));
    const orchestrator = makeOrchestrator(ai);
    await orchestrator.submitTask('Hi');

    expect(ai.prompts[0]).toMatch(/conversational/i);
  });

  it('does not treat prose as a schema failure worth retrying', async () => {
    // A model that answers in words has chosen a valid answer. Re-asking would
    // bill the developer for the same reply, so the turn settles instead.
    const ai = new ScriptedAI('Sure — a user service usually needs a repository behind it.');
    const orchestrator = makeOrchestrator(ai);

    await orchestrator.submitTask('Tell me about user services');

    expect(ai.turnCount).toBe(1);
    expect(orchestrator.errorValue).toBeNull();
    expect(store.getActive()!.messages.some((message) => message.role === 'assistant')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Scenario B: the reported failure                                           */
/* -------------------------------------------------------------------------- */

describe('the reported failure', () => {
  it('stages the nested proposal instead of refusing it', async () => {
    const ai = new ScriptedAI(REPORTED_REPLY);
    const orchestrator = makeOrchestrator(ai);

    await orchestrator.submitTask('Create a PHP User class');

    expect(orchestrator.errorValue).toBeNull();
    expect(orchestrator.machine.state).toBe(PairPilotState.WAITING_FILE_APPROVAL);
    expect(orchestrator.pendingFilePathValue).toBe('src/User.php');
    expect(orchestrator.pendingFileOperationValue).toBe('create');
  });

  it('never says "not a code_proposal object"', async () => {
    const ai = new ScriptedAI(REPORTED_REPLY);
    const orchestrator = makeOrchestrator(ai);
    await orchestrator.submitTask('Create a PHP User class');

    expect(orchestrator.errorValue ?? '').not.toMatch(/not a code_proposal/i);
    expect(orchestrator.noticeValue ?? '').not.toMatch(/rephras/i);
  });

  it('records the adaptation it had to perform', async () => {
    const ai = new ScriptedAI(REPORTED_REPLY);
    const orchestrator = makeOrchestrator(ai);
    await orchestrator.submitTask('Create a PHP User class');

    const entry = orchestrator.protocolDiagnostics.recent()[0]!;
    expect(entry.ok).toBe(true);
    expect(entry.adaptation).toBe('nested_proposal');
  });

  it('shows the proposal in the transcript so the developer can read it', async () => {
    const ai = new ScriptedAI(REPORTED_REPLY);
    const orchestrator = makeOrchestrator(ai);
    await orchestrator.submitTask('Create a PHP User class');

    const assistant = store.getActive()!.messages.filter((message) => message.role === 'assistant');
    expect(assistant.some((message) => message.text.includes('src/User.php'))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Scenario H: a planning request never becomes a proposal                    */
/* -------------------------------------------------------------------------- */

/**
 * The second bug report, replayed end to end.
 *
 * The developer asked for requirements and architecture, explicitly said not to
 * write code, and got back "The AI proposed a change without describing it."
 * The classifier and the policy are unit-tested in `WorkflowMode.test.ts`; what
 * this block adds is the part only a whole turn can show — that a proposal which
 * *does* arrive in a planning mode reaches neither the approval gate nor the
 * disk, and that the developer is told why.
 */
describe('a planning request', () => {
  const PLANNING_TASK =
    'I want to build a simple PHP and SQLite user management system. Features: create, list, ' +
    'retrieve, update and delete users. Use PDO. No framework. Do not write code yet. ' +
    'First discuss requirements and architecture.';

  it('enters a planning mode rather than asking for a proposal', async () => {
    const ai = new ScriptedAI(
      JSON.stringify({
        protocol_version: PAIRPILOT_PROTOCOL_VERSION,
        type: 'architecture_discussion',
        message: 'Let us settle the requirements first.',
        requirements: ['Create, list, retrieve, update and delete users.', 'PDO, no framework.'],
        questions: ['Should deleting a user be a hard delete or a soft delete?'],
        nextStep: 'Decide on delete semantics.',
      })
    );
    const orchestrator = makeOrchestrator(ai);

    await orchestrator.submitTask(PLANNING_TASK);

    expect(orchestrator.workflowModeValue).toBe('discovery');
    expect(orchestrator.isPlanningMode).toBe(true);
    expect(orchestrator.errorValue).toBeNull();
    expect(orchestrator.machine.state).toBe(PairPilotState.IDLE);
  });

  it('asks the model for a discussion, not for a code proposal', async () => {
    const ai = new ScriptedAI(JSON.stringify({ type: 'chat_response', message: 'Understood.' }));
    const orchestrator = makeOrchestrator(ai);

    await orchestrator.submitTask(PLANNING_TASK);

    // The prompt is where the bug actually lived: it asked for a code_proposal
    // on every engineering turn, so the model supplied one.
    expect(ai.prompts[0]).toMatch(/DISCOVERY/);
    expect(ai.prompts[0]).toMatch(/Do not produce a "code_proposal"/);
  });

  it('refuses a proposal that arrives anyway, and writes nothing', async () => {
    // A model that ignores the mode and sends a change set regardless. This is
    // the exact shape that produced "The AI proposed a change without
    // describing it." — a bare change with no prose.
    const ai = new ScriptedAI(
      JSON.stringify({
        type: 'code_proposal',
        changes: [
          {
            id: 'change_001',
            file: 'src/Domain/User.php',
            operation: 'create',
            description: 'The User entity.',
            content: '<?php\n\nfinal class User {}\n',
            dependencies: [],
            risk: 'low',
          },
        ],
      })
    );
    const orchestrator = makeOrchestrator(ai);

    await orchestrator.submitTask(PLANNING_TASK);

    // Not staged, not queued, not awaiting approval.
    expect(orchestrator.machine.state).toBe(PairPilotState.IDLE);
    expect(orchestrator.pendingFilePathValue).toBeNull();
    expect(orchestrator.changeProgressValue).toBeNull();
    expect(orchestrator.changeSetPlanValue).toEqual([]);
    expect(fs.existsSync(path.join(root, 'src', 'Domain'))).toBe(false);

    // And the developer is told what happened and how to move on.
    expect(orchestrator.errorValue).toMatch(/Discovery/i);
    expect(orchestrator.errorValue).toMatch(/did not apply/i);
    expect(orchestrator.noticeValue).not.toMatch(/rephras/i);
  });

  it('still shows the developer what the model sketched', async () => {
    const ai = new ScriptedAI(
      JSON.stringify({
        type: 'code_proposal',
        message: 'Here is a first cut.',
        changes: [
          {
            id: 'change_001',
            file: 'src/Domain/User.php',
            operation: 'create',
            description: 'The User entity.',
            content: '<?php\n\nfinal class User {}\n',
            dependencies: [],
            risk: 'low',
          },
        ],
      })
    );
    const orchestrator = makeOrchestrator(ai);
    await orchestrator.submitTask(PLANNING_TASK);

    const assistant = store.getActive()!.messages.filter((message) => message.role === 'assistant');
    const text = assistant.map((message) => message.text).join('\n');
    expect(text).toContain('src/Domain/User.php');
    expect(text).toMatch(/Refused|not applied/i);
    // The file *contents* are deliberately withheld: showing them is what makes
    // a refusal read as a half-applied write.
    expect(text).not.toContain('final class User');
  });

  it('does not retry a policy refusal — the model cannot talk its way out of it', async () => {
    const ai = new ScriptedAI(
      JSON.stringify({
        type: 'code_proposal',
        changes: [
          {
            id: 'change_001',
            file: 'src/a.ts',
            operation: 'create',
            description: 'A file.',
            content: 'export const a = 1;\n',
            dependencies: [],
            risk: 'low',
          },
        ],
      })
    );
    const orchestrator = makeOrchestrator(ai);

    await orchestrator.submitTask(PLANNING_TASK);

    // One request, one refusal. Re-asking would bill the developer to be told
    // the same thing, because the mode is not something the model can change.
    expect(ai.turnCount).toBe(1);
    expect(orchestrator.workflowModeValue).toBe('discovery');
  });

  it('moves to Coding only when the developer says to write the code', async () => {
    const ai = new ScriptedAI(
      JSON.stringify({ type: 'chat_response', message: 'Understood.' }),
      JSON.stringify({ type: 'chat_response', message: 'Agreed.' }),
      JSON.stringify({ type: 'chat_response', message: 'Then let us build it.' })
    );
    const orchestrator = makeOrchestrator(ai);

    await orchestrator.submitTask(PLANNING_TASK);
    expect(orchestrator.workflowModeValue).toBe('discovery');

    await orchestrator.submitTask('Soft delete, and the email should be unique.');
    expect(orchestrator.workflowModeValue).toBe('discovery');

    // An explicit authorisation is what crosses the boundary — and it is a
    // separate instruction, never a side effect of agreeing with a design.
    await orchestrator.submitTask('Go ahead and implement it.');
    expect(orchestrator.workflowModeValue).toBe('coding');
    expect(orchestrator.isPlanningMode).toBe(false);
    expect(ai.prompts[2]).not.toMatch(/Do not produce a "code_proposal"/);
  });

  it('does not let architecture approval authorise code', async () => {
    const ai = new ScriptedAI(
      JSON.stringify({ type: 'chat_response', message: 'Here is the design.' }),
      JSON.stringify({ type: 'chat_response', message: 'Thank you.' })
    );
    const orchestrator = makeOrchestrator(ai);

    // Move into the design conversation the way a planning session would…
    await orchestrator.submitTask(PLANNING_TASK);
    await orchestrator.submitTask('Now propose an architecture for this.');
    expect(orchestrator.workflowModeValue).toBe('architecture');
    expect(orchestrator.isPlanningMode).toBe(true);

    // …then agree with it. Approval settles the design; it is not an
    // instruction to write, so the session may not end up able to write.
    await orchestrator.submitTask('That architecture looks good, let us go with it.');
    expect(orchestrator.isPlanningMode).toBe(true);
    expect(orchestrator.workflowModeValue).toBe('implementation');
  });
});

/* -------------------------------------------------------------------------- */
/* Scenario C: a multi-file change set                                        */
/* -------------------------------------------------------------------------- */

describe('a multi-file change set', () => {
  it('queues both files and asks about the first', async () => {
    const ai = new ScriptedAI(MULTI_FILE_REPLY);
    const orchestrator = makeOrchestrator(ai);

    await orchestrator.submitTask('Create a user module with SQLite persistence');

    expect(orchestrator.errorValue).toBeNull();
    expect(orchestrator.machine.state).toBe(PairPilotState.WAITING_FILE_APPROVAL);
    expect(orchestrator.pendingFilePathValue).toBe('src/Domain/User.php');
  });

  it('reports how far through the set the turn is', async () => {
    const ai = new ScriptedAI(MULTI_FILE_REPLY);
    const orchestrator = makeOrchestrator(ai);
    await orchestrator.submitTask('Create a user module');

    const progress = orchestrator.changeProgressValue;
    expect(progress).not.toBeNull();
    expect(progress!.index).toBe(1);
    expect(progress!.total).toBe(2);
    expect(progress!.setId).toMatch(/^[a-f0-9]{64}$/);
  });

  it('shows the whole plan, in write order, before anything is written', async () => {
    const ai = new ScriptedAI(MULTI_FILE_REPLY);
    const orchestrator = makeOrchestrator(ai);
    await orchestrator.submitTask('Create a user module');

    expect(orchestrator.changeSetPlanValue.map((entry) => entry.file)).toEqual([
      'src/Domain/User.php',
      'src/Infrastructure/UserRepository.php',
    ]);
  });

  it('writes nothing while it is asking for permission', async () => {
    const ai = new ScriptedAI(MULTI_FILE_REPLY);
    const orchestrator = makeOrchestrator(ai);
    await orchestrator.submitTask('Create a user module');

    expect(fs.existsSync(path.join(root, 'src', 'Domain', 'User.php'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'src', 'Infrastructure'))).toBe(false);
  });

  it('opens the file gate with a live hash for each of the two decisions', async () => {
    const ai = new ScriptedAI(MULTI_FILE_REPLY);
    const orchestrator = makeOrchestrator(ai);
    await orchestrator.submitTask('Create a user module');

    // Two handles, both 64-hex, both computed from content the host is holding
    // right now: the current change's own hash, which the gate verifies against,
    // and the set's hash, which the panel's "allow all N remaining files" echoes
    // back. They must not be the same value — one authorises a file, the other a
    // set — and a stale panel can present neither.
    const pending = orchestrator.approvals.getPendingHash();
    const setId = orchestrator.changeProgressValue!.setId;
    expect(pending).toMatch(/^[a-f0-9]{64}$/);
    expect(setId).toMatch(/^[a-f0-9]{64}$/);
    expect(pending).not.toBe(setId);

    // Verification itself, without the write: the pending hash is the one live
    // decision this gate accepts. Driving the write would need an editor host,
    // which this file deliberately does not fake.
    expect(orchestrator.approvals.verify(pending!).relativePath).toBe('src/Domain/User.php');
  });
});

/* -------------------------------------------------------------------------- */
/* Protocol failures, retry and reporting                                     */
/* -------------------------------------------------------------------------- */

describe('an invalid reply', () => {
  it('retries once with the validator’s own complaint', async () => {
    const broken = JSON.stringify({
      type: 'code_proposal',
      message: 'Done.',
      changes: [{ file: 'src/a.ts', operation: 'create', description: 'A file' }],
    });
    const ai = new ScriptedAI(broken, MULTI_FILE_REPLY);
    const orchestrator = makeOrchestrator(ai);

    await orchestrator.submitTask('Create a user module');

    expect(ai.turnCount).toBe(2);
    // The correction must name the field, not say "try again".
    expect(ai.prompts[1]).toMatch(/content/i);
    // And it must say what to send instead. A complaint without the expected
    // shape is how a retry comes back with a different field misnamed.
    expect(ai.prompts[1]).toContain('"changes"');
    expect(ai.prompts[1]).toContain('"file"');
    expect(ai.prompts[1]).toContain('"operation"');
    expect(ai.prompts[1]).toContain('"content"');
    expect(orchestrator.errorValue).toBeNull();
    expect(orchestrator.machine.state).toBe(PairPilotState.WAITING_FILE_APPROVAL);
  });

  it('answers a valid reply of another type rather than demanding a proposal', async () => {
    // The developer asked for implementation, so the turn asked for a proposal.
    // The model answered with a question instead. That is a reply, not a broken
    // contract, and it is handled by the handler for the type it declared.
    const ai = new ScriptedAI(
      JSON.stringify({
        type: 'clarification_request',
        message: 'Before I write this: which database?',
        clarification: { question: 'Which database?', options: ['SQLite', 'Postgres'] },
      })
    );
    const orchestrator = makeOrchestrator(ai);

    await orchestrator.submitTask('Create a user module');

    expect(ai.turnCount).toBe(1);
    expect(orchestrator.errorValue).toBeNull();
    expect(orchestrator.approvals.getPending()).toBeNull();
    expect(fs.existsSync(path.join(root, 'src', 'Domain'))).toBe(false);
  });

  it('stages a proposal whose path arrived under another name', async () => {
    // The reported failure, end to end. The path is present; only its spelling
    // differs. Refusing this cost the developer the whole turn, and the repair
    // is a rename the parser can perform without guessing at anything.
    const renamed = JSON.stringify({
      protocol_version: PAIRPILOT_PROTOCOL_VERSION,
      type: 'code_proposal',
      message: 'A user module.',
      changes: [
        {
          fileName: 'src/Domain/User.php',
          operation: 'create',
          description: 'The User entity.',
          content: '<?php\n\nfinal class User {}\n',
        },
      ],
    });
    const ai = new ScriptedAI(renamed);
    const orchestrator = makeOrchestrator(ai);

    await orchestrator.submitTask('Create a user module');

    expect(ai.turnCount).toBe(1);
    expect(orchestrator.errorValue).toBeNull();
    expect(orchestrator.changeSetPlanValue.map((entry) => entry.file)).toEqual([
      'src/Domain/User.php',
    ]);
    // Staged, still not written: renaming a key is not authorisation.
    expect(fs.existsSync(path.join(root, 'src', 'Domain', 'User.php'))).toBe(false);
  });

  it('writes nothing at all when the reply never passes validation', async () => {
    const broken = JSON.stringify({
      type: 'code_proposal',
      message: 'Done.',
      changes: [{ file: 'src/Domain/User.php', operation: 'create', description: 'No content' }],
    });
    const ai = new ScriptedAI(broken, broken, broken, broken);
    const orchestrator = makeOrchestrator(ai);

    await orchestrator.submitTask('Create a user module');

    expect(orchestrator.errorValue).not.toBeNull();
    // Nothing reached the filesystem, and no placeholder was created to stand in
    // for the content that never arrived.
    expect(fs.readdirSync(path.join(root, 'src'))).toEqual(['existing.ts']);
    expect(fs.existsSync(path.join(root, 'src', 'Domain'))).toBe(false);
    expect(orchestrator.batchView).toBeNull();
  });

  it('gives up after the retry budget rather than looping', async () => {
    const broken = JSON.stringify({ type: 'code_proposal', message: 'Done.', changes: [] });
    const ai = new ScriptedAI(broken, broken, broken, broken, broken);
    const orchestrator = makeOrchestrator(ai);

    await orchestrator.submitTask('Create a user module');

    // Two retries beyond the first attempt: bounded, so a model that cannot
    // produce a valid reply cannot spend the developer's budget indefinitely.
    expect(ai.turnCount).toBe(3);
    expect(orchestrator.errorValue).not.toBeNull();
    expect(orchestrator.machine.state).toBe(PairPilotState.IDLE);
  });

  it('reports the offending field in the failure', async () => {
    const broken = JSON.stringify({ type: 'code_proposal', message: 'Done.', changes: [] });
    const ai = new ScriptedAI(broken, broken, broken);
    const orchestrator = makeOrchestrator(ai);

    await orchestrator.submitTask('Create a user module');

    expect(orchestrator.errorValue).toMatch(/changes/i);
  });

  it('does not retry a refusal the model cannot talk its way out of', async () => {
    // A path outside the workspace is a policy refusal. Re-asking would spend a
    // request to be told the same thing.
    const escaping = JSON.stringify({
      type: 'code_proposal',
      message: 'Done.',
      changes: [{ file: '../outside.ts', operation: 'create', description: 'Escape', content: 'x\n' }],
    });
    const ai = new ScriptedAI(escaping);
    const orchestrator = makeOrchestrator(ai);

    await orchestrator.submitTask('Create a file outside the project');

    expect(ai.turnCount).toBe(1);
    expect(orchestrator.errorValue).toMatch(/\.\.|outside/i);
    expect(orchestrator.machine.state).toBe(PairPilotState.IDLE);
  });

  it('redacts a key that appears in a rejected reply', async () => {
    const ai = new ScriptedAI(
      'I could not do that. My key is sk-or-v1-abcdef0123456789abcdef0123456789 by the way.'
    );
    const orchestrator = makeOrchestrator(ai);
    await orchestrator.submitTask('Do something impossible');

    const entry = orchestrator.protocolDiagnostics.recent()[0]!;
    expect(entry.raw).not.toContain('abcdef0123456789abcdef0123456789');
  });

  it('keeps no raw reply for a conversational turn in the error surface', async () => {
    const ai = new ScriptedAI(JSON.stringify({ type: 'chat_response', message: 'Hello!' }));
    const orchestrator = makeOrchestrator(ai);
    await orchestrator.submitTask('Hi');

    expect(orchestrator.errorValue).toBeNull();
    expect(logger.errors).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Refusals that must not depend on the model                                 */
/* -------------------------------------------------------------------------- */

describe('guards that do not rely on the model behaving', () => {
  it('refuses a second task while one is awaiting a decision', async () => {
    const ai = new ScriptedAI(MULTI_FILE_REPLY);
    const orchestrator = makeOrchestrator(ai);
    await orchestrator.submitTask('Create a user module');

    await orchestrator.submitTask('And another thing');

    expect(orchestrator.errorValue).toMatch(/resolve the current review/i);
    // The first turn is untouched: no second request was sent.
    expect(ai.turnCount).toBe(1);
    expect(orchestrator.pendingFilePathValue).toBe('src/Domain/User.php');
  });

  it('refuses an approval that does not match the live proposal', async () => {
    const ai = new ScriptedAI(MULTI_FILE_REPLY);
    const orchestrator = makeOrchestrator(ai);
    await orchestrator.submitTask('Create a user module');

    await orchestrator.approveFileCreation('f'.repeat(64));

    expect(orchestrator.errorValue).toMatch(/does not match|stale|mismatch/i);
    expect(fs.existsSync(path.join(root, 'src', 'Domain', 'User.php'))).toBe(false);
  });

  it('refuses an approval when there is nothing pending', async () => {
    const ai = new ScriptedAI();
    const orchestrator = makeOrchestrator(ai);

    await orchestrator.approveFileCreation('a'.repeat(64));

    expect(orchestrator.errorValue).toMatch(/no pending file request/i);
  });

  it('declining the file gate writes nothing and abandons the whole set', async () => {
    const ai = new ScriptedAI(MULTI_FILE_REPLY);
    const orchestrator = makeOrchestrator(ai);
    await orchestrator.submitTask('Create a user module');

    const hash = orchestrator.approvals.getPendingHash()!;
    orchestrator.rejectFileCreation(hash);

    expect(fs.existsSync(path.join(root, 'src', 'Domain', 'User.php'))).toBe(false);
    expect(orchestrator.noticeValue).toMatch(/no further files|not written|declined/i);
    expect(orchestrator.machine.state).toBe(PairPilotState.IDLE);
    expect(orchestrator.changeProgressValue).toBeNull();
  });

  it('lets the developer pin a file only if the path guard allows it', async () => {
    const orchestrator = makeOrchestrator(new ScriptedAI());

    expect(orchestrator.addPinnedContext('src/existing.ts').ok).toBe(true);
    expect(orchestrator.pinnedContextValue).toContain('src/existing.ts');

    const refused = orchestrator.addPinnedContext('../outside.ts');
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBeTruthy();
    expect(orchestrator.pinnedContextValue).not.toContain('../outside.ts');
  });
});

/* -------------------------------------------------------------------------- */
/* The batch, seen from the turn                                              */
/* -------------------------------------------------------------------------- */

/**
 * These run the real turn up to the point where a write would begin, and inspect
 * the batch the host is now keeping.
 *
 * The write itself still needs an editor host, so what is asserted here is the
 * record the write will be driven from: that the batch exists, holds all the
 * files with their content, is sent to the panel, and — the reported bug — that
 * the panel's *context* list is a different thing from the batch and is not a
 * statement about the proposal.
 */
describe('the batch behind a multi-file proposal', () => {
  it('records every file with its content when the proposal is staged', async () => {
    const ai = new ScriptedAI(MULTI_FILE_REPLY);
    const orchestrator = makeOrchestrator(ai);
    await orchestrator.submitTask('Create a user module');

    const batch = orchestrator.batchView;
    expect(batch).not.toBeNull();
    expect(batch!.total).toBe(2);
    expect(batch!.files.map((file) => file.file)).toEqual([
      'src/Domain/User.php',
      'src/Infrastructure/UserRepository.php',
    ]);
    // Both start as work still to be done.
    expect(batch!.files.every((file) => file.status === 'pending')).toBe(true);
    expect(batch!.pending).toBe(2);
  });

  it('gives the panel a stable identity to echo back with a decision', async () => {
    const ai = new ScriptedAI(MULTI_FILE_REPLY);
    const orchestrator = makeOrchestrator(ai);
    await orchestrator.submitTask('Create a user module');

    const binding = orchestrator.reviewBindingValue;
    expect(binding).not.toBeNull();
    expect(binding!.proposalId).toMatch(/^[a-f0-9]{64}$/);
    expect(binding!.proposalVersion).toBe(1);
    expect(binding!.fileId).toMatch(/^[a-f0-9]{16}$/);

    // The binding names the file the developer is actually being asked about.
    const batch = orchestrator.batchView!;
    const first = batch.files.find((file) => file.fileId === binding!.fileId);
    expect(first!.file).toBe('src/Domain/User.php');
  });

  it('refuses a decision that claims a superseded proposal version', async () => {
    const ai = new ScriptedAI(MULTI_FILE_REPLY);
    const orchestrator = makeOrchestrator(ai);
    await orchestrator.submitTask('Create a user module');

    await orchestrator.approveFileCreation(
      orchestrator.approvals.getPendingHash()!,
      { proposalVersion: 99 }
    );

    // Refused, and — the important part — nothing was written or staged off the
    // back of a decision about content the developer never saw.
    expect(orchestrator.errorValue).toMatch(/changed after you looked|version/i);
    expect(fs.existsSync(path.join(root, 'src', 'Domain', 'User.php'))).toBe(false);
  });

  it('refuses a decision that names a file from a different proposal', async () => {
    const ai = new ScriptedAI(MULTI_FILE_REPLY);
    const orchestrator = makeOrchestrator(ai);
    await orchestrator.submitTask('Create a user module');

    await orchestrator.approveFileCreation(orchestrator.approvals.getPendingHash()!, {
      fileId: '0000000000000000',
    });

    expect(orchestrator.errorValue).toMatch(/not part of the proposal/i);
    expect(fs.existsSync(path.join(root, 'src', 'Domain', 'User.php'))).toBe(false);
  });

  it('accepts a decision that claims the version actually on screen', async () => {
    const ai = new ScriptedAI(MULTI_FILE_REPLY);
    const orchestrator = makeOrchestrator(ai);
    await orchestrator.submitTask('Create a user module');

    const binding = orchestrator.reviewBindingValue!;
    // The binding is accepted — the write then proceeds to the part this file
    // cannot fake, which is fine: what is asserted is that the *binding* did not
    // cause a refusal.
    await orchestrator.approveFileCreation(orchestrator.approvals.getPendingHash()!, binding);

    expect(orchestrator.errorValue ?? '').not.toMatch(/changed after you looked|not part of/i);
  });

  it('keeps the context list and the batch as separate things', async () => {
    const ai = new ScriptedAI(MULTI_FILE_REPLY);
    const orchestrator = makeOrchestrator(ai);
    await orchestrator.submitTask('Create a user module');

    // The reported confusion: an empty *context* list sitting under a proposal.
    // It is empty because no workspace files were sent, which says nothing about
    // whether the proposal is intact — and here the batch proves it is.
    expect(orchestrator.lastContextFilesValue).toEqual([]);
    expect(orchestrator.batchView!.total).toBe(2);
  });

  it('scopes a revision to one file without disturbing the batch', async () => {
    const ai = new ScriptedAI(MULTI_FILE_REPLY);
    const orchestrator = makeOrchestrator(ai);
    await orchestrator.submitTask('Create a user module');

    const batch = orchestrator.batchView!;
    const before = batch.files.map((file) => ({ file: file.file, fileId: file.fileId }));

    // A revision is asked for while the file gate is open: it is refused,
    // because there is nothing written to revise yet — and critically the batch
    // is left completely intact rather than torn down by the refusal.
    await orchestrator.requestChanges('0'.repeat(64), 'use a different approach');

    const after = orchestrator.batchView!;
    expect(after.files.map((file) => ({ file: file.file, fileId: file.fileId }))).toEqual(before);
    expect(after.total).toBe(2);
    expect(after.proposalVersion).toBe(1);
  });

  it('forgets the batch when the proposal is declined', async () => {
    const ai = new ScriptedAI(MULTI_FILE_REPLY);
    const orchestrator = makeOrchestrator(ai);
    await orchestrator.submitTask('Create a user module');
    expect(orchestrator.batchView).not.toBeNull();

    orchestrator.rejectFileCreation(orchestrator.approvals.getPendingHash()!);

    // Declining the gate abandons the set, so the batch goes with it — otherwise
    // the panel would keep listing files nobody is going to write.
    expect(orchestrator.batchView).toBeNull();
    expect(orchestrator.changeProgressValue).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Interrupting a write                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The mid-stream controls.
 *
 * The streaming itself needs a real editor, so it is covered by the VS Code
 * suite. What is testable here is the other half of the contract: that these
 * messages are refused when there is no write to interrupt, because a pause that
 * silently "succeeds" against nothing leaves the panel showing a Pause button
 * that lies about what the host is doing.
 */
describe('holding a write', () => {
  it('starts with nothing paused and no file being written', async () => {
    const orchestrator = makeOrchestrator(new ScriptedAI(MULTI_FILE_REPLY));
    await orchestrator.submitTask('Create a user module');

    // Sitting at the permission gate is not writing: nothing has been opened in
    // the editor yet, so there is no stream to hold.
    expect(orchestrator.writePausedValue).toBe(false);
    expect(orchestrator.writingFileValue).toBeNull();
  });

  it('does nothing when there is no write to pause', async () => {
    const orchestrator = makeOrchestrator(new ScriptedAI(MULTI_FILE_REPLY));
    await orchestrator.submitTask('Create a user module');

    orchestrator.pauseWrite();

    // No writer, so no pause, and — the part that matters — no claim that the
    // stream is being held.
    expect(orchestrator.writePausedValue).toBe(false);
    expect(orchestrator.noticeValue ?? '').not.toMatch(/paused/i);
  });

  it('does nothing when there is no pause to resume', async () => {
    const orchestrator = makeOrchestrator(new ScriptedAI(MULTI_FILE_REPLY));
    await orchestrator.submitTask('Create a user module');

    orchestrator.resumeWrite();

    expect(orchestrator.writePausedValue).toBe(false);
    expect(orchestrator.errorValue).toBeNull();
  });

  it('refuses a mid-write revision when no file is being written', async () => {
    const orchestrator = makeOrchestrator(new ScriptedAI(MULTI_FILE_REPLY));
    await orchestrator.submitTask('Create a user module');

    await orchestrator.requestChangesWhileWriting('use a different approach');

    // A revision while nothing is streaming has no file to take back off disk,
    // so it is refused with an explanation rather than silently spending a turn.
    expect(orchestrator.errorValue).toMatch(/nothing to change/i);
    // And the batch is untouched: nothing was written, so nothing is under
    // revision.
    expect(orchestrator.batchView!.proposalVersion).toBe(1);
    expect(orchestrator.batchView!.files.every((file) => file.status === 'pending')).toBe(true);
  });
});


/* -------------------------------------------------------------------------- */
/* Scenario: the roadmap in the prompt                                        */
/* -------------------------------------------------------------------------- */

describe('the roadmap in a coding turn', () => {
  it('carries the roadmap into the prompt', async () => {
    const ai = new ScriptedAI(MULTI_FILE_REPLY);
    const roadmap: OrchestratorDeps['roadmap'] = {
      describeForPrompt: async () => 'Roadmap (ROADMAP.md):\n- models [todo] Domain models',
      advance: async () => ({ kind: 'no_roadmap' }),
    };
    const orchestrator = makeOrchestrator(ai, roadmap);

    await orchestrator.submitTask('Create a user module');

    expect(ai.prompts[0]).toContain('Roadmap (ROADMAP.md):');
    expect(ai.prompts[0]).toContain('Follow this roadmap.');
  });

  it('runs the turn without one when there is no roadmap', async () => {
    const ai = new ScriptedAI(MULTI_FILE_REPLY);
    const roadmap: OrchestratorDeps['roadmap'] = {
      describeForPrompt: async () => null,
      advance: async () => ({ kind: 'no_roadmap' }),
    };
    const orchestrator = makeOrchestrator(ai, roadmap);

    await orchestrator.submitTask('Create a user module');

    expect(ai.prompts[0]).not.toContain('Follow this roadmap.');
    expect(orchestrator.errorValue).toBeNull();
  });

  it('does not fail the turn when the roadmap cannot be read', async () => {
    // The developer asked for a file, not for a report on their markdown. A
    // broken roadmap must not become a broken workflow.
    const ai = new ScriptedAI(REPORTED_REPLY);
    const roadmap: OrchestratorDeps['roadmap'] = {
      describeForPrompt: async () => {
        throw new Error('permission denied');
      },
      advance: async () => ({ kind: 'no_roadmap' }),
    };
    const orchestrator = makeOrchestrator(ai, roadmap);

    await orchestrator.submitTask('Create a PHP User class');

    expect(orchestrator.errorValue).toBeNull();
    expect(orchestrator.machine.state).toBe(PairPilotState.WAITING_FILE_APPROVAL);
    expect(logger.warns.some((line) => line.includes('roadmap could not be read'))).toBe(true);
  });

  it('does not touch the roadmap while the provenance of the turn is unsettled', async () => {
    // A proposed-but-unwritten file advances nothing: the roadmap records what
    // was kept, so an offer made before a decision would be a lie.
    let advances = 0;
    const ai = new ScriptedAI(MULTI_FILE_REPLY);
    const roadmap: OrchestratorDeps['roadmap'] = {
      describeForPrompt: async () => null,
      advance: async () => {
        advances += 1;
        return { kind: 'no_roadmap' };
      },
    };
    const orchestrator = makeOrchestrator(ai, roadmap);

    await orchestrator.submitTask('Create a user module');

    expect(advances).toBe(0);
    expect(orchestrator.offeredRoadmapFile).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Scenario I: the gate is answerable                                         */
/* -------------------------------------------------------------------------- */

/**
 * The 0.4.0 dead end, replayed.
 *
 * The sidebar's permission buttons were removed with the rest of the panel's
 * authority, and nothing took their place — so a proposal reached
 * `WAITING_FILE_APPROVAL` and stayed there. The panel said "the prompt is in the
 * editor", the palette answered "no file is waiting", and the turn could not be
 * completed at all.
 *
 * What is pinned here is that the workflow *asks*, with everything an answer
 * needs: the path, the operation, the content hash the answer must echo, the set
 * hash when a batch is in flight — and that answering "changes" revises the
 * proposal without ever touching the disk.
 */
describe('the pre-write permission gate', () => {
  /** A revision of the reported proposal, for the "request changes" path. */
  const REVISED_REPLY = JSON.stringify({
    protocol_version: PAIRPILOT_PROTOCOL_VERSION,
    type: 'code_proposal',
    message: 'Tightened the class.',
    changes: [
      {
        id: 'change_001',
        file: 'src/User.php',
        operation: 'create',
        description: 'A final PHP user entity',
        content: '<?php\n\nfinal class User\n{\n    public function __construct(public readonly string $name) {}\n}\n',
        dependencies: [],
        risk: 'low',
      },
    ],
  });

  it('asks before writing, and nothing is on disk while it asks', async () => {
    const requests: OrchestratorWritePermissionRequest[] = [];
    const ai = new ScriptedAI(REPORTED_REPLY);
    const orchestrator = makeOrchestrator(ai, undefined, (request) => {
      requests.push(request);
    });

    await orchestrator.submitTask('Create a PHP User class');

    expect(requests).toHaveLength(1);
    expect(requests[0]!.relativePath).toBe('src/User.php');
    expect(requests[0]!.operation).toBe('create');
    // The binding a decision must echo back, so a prompt left open across a
    // revision cannot authorise the earlier content.
    expect(requests[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(requests[0]!.setHash).toBeNull();
    expect(fs.existsSync(path.join(root, 'src', 'User.php'))).toBe(false);
    expect(orchestrator.machine.state).toBe(PairPilotState.WAITING_FILE_APPROVAL);
  });

  it('offers the set hash and position when more than one file is waiting', async () => {
    const requests: OrchestratorWritePermissionRequest[] = [];
    const ai = new ScriptedAI(MULTI_FILE_REPLY);
    const orchestrator = makeOrchestrator(ai, undefined, (request) => {
      requests.push(request);
    });

    await orchestrator.submitTask('Create a user module');

    expect(requests).toHaveLength(1);
    expect(requests[0]!.position).toEqual({ index: 1, total: 2 });
    expect(requests[0]!.setHash).toMatch(/^[0-9a-f]{64}$/);
    expect(requests[0]!.setHash).not.toBe(requests[0]!.contentHash);
  });

  it('revises without writing when changes are requested at the gate', async () => {
    const requests: OrchestratorWritePermissionRequest[] = [];
    const ai = new ScriptedAI(REPORTED_REPLY, REVISED_REPLY);
    const orchestrator = makeOrchestrator(ai, undefined, (request) => {
      requests.push(request);
    });

    await orchestrator.submitTask('Create a PHP User class');
    const first = requests[0]!;

    await orchestrator.requestChangesBeforeWrite(first.contentHash, 'make the class final');

    // The revision was requested from the model and staged back at the gate.
    expect(ai.turnCount).toBe(2);
    expect(ai.prompts[1]).toContain('make the class final');
    expect(requests).toHaveLength(2);
    expect(requests[1]!.relativePath).toBe('src/User.php');
    expect(requests[1]!.contentHash).not.toBe(first.contentHash);
    expect(orchestrator.machine.state).toBe(PairPilotState.WAITING_FILE_APPROVAL);
    // Nothing was written on the way through: the gate is before the writer.
    expect(fs.existsSync(path.join(root, 'src', 'User.php'))).toBe(false);
  });

  it('refuses a revision request made against an earlier version', async () => {
    // A prompt left open across a revision could still name the old hash. It
    // must be refused rather than revising bytes the developer no longer sees.
    const ai = new ScriptedAI(REPORTED_REPLY);
    const orchestrator = makeOrchestrator(ai);

    await orchestrator.submitTask('Create a PHP User class');
    const turnsBefore = ai.turnCount;

    await orchestrator.requestChangesBeforeWrite('0'.repeat(64), 'try again');

    expect(ai.turnCount).toBe(turnsBefore);
    expect(orchestrator.errorValue).toMatch(/changed|version|approval/i);
    expect(orchestrator.machine.state).toBe(PairPilotState.WAITING_FILE_APPROVAL);
  });

  it('writes nothing when the developer declines at the gate', async () => {
    const requests: OrchestratorWritePermissionRequest[] = [];
    const ai = new ScriptedAI(REPORTED_REPLY);
    const orchestrator = makeOrchestrator(ai, undefined, (request) => {
      requests.push(request);
    });

    await orchestrator.submitTask('Create a PHP User class');
    orchestrator.rejectFileCreation(requests[0]!.contentHash);

    expect(orchestrator.machine.state).toBe(PairPilotState.IDLE);
    expect(orchestrator.pendingFilePathValue).toBeNull();
    expect(fs.existsSync(path.join(root, 'src', 'User.php'))).toBe(false);
    expect(orchestrator.noticeValue).toMatch(/declined/i);
  });

  it('does not ask at all when there is no UI to ask with', async () => {
    // The hook is optional so the workflow stays constructible in a host with no
    // prompts. It must not crash, and the gate must still hold.
    const ai = new ScriptedAI(REPORTED_REPLY);
    const orchestrator = makeOrchestrator(ai);

    await orchestrator.submitTask('Create a PHP User class');

    expect(orchestrator.errorValue).toBeNull();
    expect(orchestrator.machine.state).toBe(PairPilotState.WAITING_FILE_APPROVAL);
    expect(fs.existsSync(path.join(root, 'src', 'User.php'))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The reported interaction, replayed turn by turn                           */
/*                                                                            */
/* "make simple x.html for test agent" produced the summary line and then the */
/* contract error. Three of the four reply shapes a model plausibly answers   */
/* with — nested payload beside an empty root array, a single-object changes  */
/* value, a bare change spelling its operation in "type" — were refused as    */
/* though the code were absent, and the prompt offered a type menu where the  */
/* instruction needed a demand. These tests run the whole turn: classification, */
/* prompt, parse, adaptation, validation and staging, and stop where the      */
/* existing suite stops — at the permission gate, with the file verified NOT   */
/* written and the queue holding the real content.                            */
/* -------------------------------------------------------------------------- */

describe('make simple x.html for test agent', () => {
  const FULL_HTML =
    '<!DOCTYPE html>\n<html>\n<head><meta charset="utf-8"><title>Agent test</title></head>\n<body><h1>Test agent page</h1></body>\n</html>\n';
  const change = {
    file: 'x.html',
    operation: 'create',
    description: 'A simple page the test agent loads.',
    content: FULL_HTML,
  };

  it('stages the real content when the model nests it beside an empty root changes array', async () => {
    // The exact shape of the reported failure: the model echoed its summary at
    // the root with `changes: []`, then delivered the actual file under
    // `proposal`. The old lift gate saw the root array — empty — and refused,
    // with the file content one key away.
    const reply = JSON.stringify({
      protocol_version: PAIRPILOT_PROTOCOL_VERSION,
      type: 'code_proposal',
      message: 'Creates a simple x.html page for the test agent to load and verify.',
      changes: [],
      proposal: { changes: [change] },
    });
    const ai = new ScriptedAI(reply);
    const orchestrator = makeOrchestrator(ai);

    await orchestrator.submitTask('make simple x.html for test agent');

    expect(orchestrator.errorValue).toBeNull();
    expect(orchestrator.machine.state).toBe(PairPilotState.WAITING_FILE_APPROVAL);
    expect(orchestrator.changeSetPlanValue.map((entry) => entry.file)).toEqual(['x.html']);
    // The queue holds the reviewed bytes, not the summary.
    expect(orchestrator.pendingFilePathValue).toBe('x.html');
    expect(fs.existsSync(path.join(root, 'x.html'))).toBe(false);
  });

  it('recovers the real proposal after a summary-shaped reply, within the retry budget', async () => {
    // The model's first answer narrates instead of proposing. The turn retries
    // with the validator's own complaint, and the second answer carries the
    // file. The correction prompt must have asked for exactly that.
    const summary = JSON.stringify({
      type: 'code_proposal',
      message: 'Creates a simple x.html page for the test agent to load and verify.',
    });
    const proposal = JSON.stringify({
      type: 'code_proposal',
      message: 'Creating the page.',
      changes: [change],
    });
    const ai = new ScriptedAI(summary, proposal);
    const orchestrator = makeOrchestrator(ai);

    await orchestrator.submitTask('make simple x.html for test agent');

    expect(ai.turnCount).toBe(2);
    expect(ai.prompts[1]).toContain('"changes"');
    expect(ai.prompts[1]).toContain('"content"');
    expect(orchestrator.errorValue).toBeNull();
    expect(orchestrator.changeSetPlanValue.map((entry) => entry.file)).toEqual(['x.html']);
    expect(fs.existsSync(path.join(root, 'x.html'))).toBe(false);
  });

  it('asks for the proposal outright rather than offering a type menu', async () => {
    // In Coding mode an unambiguous build instruction must tell the model to
    // answer with a code_proposal carrying complete content. The generic list
    // invites "here is a description" as an answer, which is the reported bug.
    const ai = new ScriptedAI(
      JSON.stringify({ type: 'chat_response', message: 'Sure, I can make that.' })
    );
    const orchestrator = makeOrchestrator(ai);

    await orchestrator.submitTask('make simple x.html for test agent');

    expect(ai.prompts[0]).toContain('Answer with a "code_proposal"');
    expect(ai.prompts[0]).toContain('complete final file');
  });

  it('demands a proposal only where the mode allows one', async () => {
    // A planning request must not carry the demand: the mode gate would refuse
    // the proposal anyway, and a prompt that demands one thing and forbids
    // another is two rules and no way to choose.
    const ai = new ScriptedAI(
      JSON.stringify({ type: 'chat_response', message: 'We are still designing.' })
    );
    const orchestrator = makeOrchestrator(ai);

    await orchestrator.submitTask('Discuss the design for a test page first. Do not write code yet.');

    expect(ai.prompts[0]).not.toContain('Answer with a "code_proposal"');
    expect(ai.prompts[0]).toContain('Do not produce a "code_proposal"');
  });
});

/* -------------------------------------------------------------------------- */
/* The revision turn that failed the contract                                */
/*                                                                            */
/* The reported failure came back after the first fix: a "request changes"   */
/* decision routes through `retryWithFeedback`, which made exactly one request */
/* with the generic type menu and had no correction loop. The first           */
/* summary-shaped reply ended the revision with the contract error. These      */
/* tests pin the whole revision path: the demand hint, the bounded retry, and */
/* that the developer's feedback survives into the corrected proposal.        */
/* -------------------------------------------------------------------------- */

describe('a revision whose reply misses the contract', () => {
  /** The summary-shaped reply that broke the revision. */
  const SUMMARY_ONLY = JSON.stringify({
    protocol_version: PAIRPILOT_PROTOCOL_VERSION,
    type: 'code_proposal',
    message: 'Tightened the User class as requested.',
  });

  it('corrects a summary-shaped revision and stages the real content', async () => {
    const requests: OrchestratorWritePermissionRequest[] = [];
    const revised = JSON.stringify({
      protocol_version: PAIRPILOT_PROTOCOL_VERSION,
      type: 'code_proposal',
      message: 'Tightened the class.',
      changes: [
        {
          file: 'src/User.php',
          operation: 'create',
          description: 'A final PHP user entity',
          content: '<?php\n\nfinal class User {}\n',
        },
      ],
    });
    const ai = new ScriptedAI(REPORTED_REPLY, SUMMARY_ONLY, revised);
    const orchestrator = makeOrchestrator(ai, undefined, (request) => {
      requests.push(request);
    });

    await orchestrator.submitTask('Create a PHP User class');
    const first = requests[0]!;
    await orchestrator.requestChangesBeforeWrite(first.contentHash, 'make the class final');

    // One revision request plus one corrective retry: bounded, not looping.
    expect(ai.turnCount).toBe(3);
    // The revision prompt demands the proposal outright rather than offering
    // the type menu, and the correction names the missing field.
    expect(ai.prompts[1]).toContain('Answer with a "code_proposal"');
    expect(ai.prompts[2]).toContain('"changes"');
    expect(ai.prompts[2]).toContain('"content"');
    // The feedback survived into the corrected proposal.
    expect(ai.prompts[1]).toContain('make the class final');
    // The corrected proposal is staged at the gate, not written.
    expect(requests[1]!.relativePath).toBe('src/User.php');
    expect(orchestrator.machine.state).toBe(PairPilotState.WAITING_FILE_APPROVAL);
    expect(fs.existsSync(path.join(root, 'src', 'User.php'))).toBe(false);
  });

  it('fails the revision after the retry budget, writing nothing', async () => {
    const requests: OrchestratorWritePermissionRequest[] = [];
    const ai = new ScriptedAI(REPORTED_REPLY, SUMMARY_ONLY, SUMMARY_ONLY, SUMMARY_ONLY);
    const orchestrator = makeOrchestrator(ai, undefined, (request) => {
      requests.push(request);
    });

    await orchestrator.submitTask('Create a PHP User class');
    const first = requests[0]!;
    await orchestrator.requestChangesBeforeWrite(first.contentHash, 'make the class final');

    // The revision attempt plus two corrective retries, then a stop: the same
    // bound the primary turn honours.
    expect(ai.turnCount).toBe(4);
    expect(orchestrator.errorValue).toMatch(/changes/i);
    expect(orchestrator.machine.state).toBe(PairPilotState.IDLE);
    expect(fs.existsSync(path.join(root, 'src', 'User.php'))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The revision contract                                                      */
/*                                                                            */
/* A revision is not "the first proposal again". It is a targeted change to   */
/* one file that already exists, and the twelve cases the bug report named     */
/* are grouped here by which half of that sentence they pin: what the prompt   */
/* is told, which replies are accepted as revisions, and what is allowed to    */
/* reach the workspace.                                                       */
/* -------------------------------------------------------------------------- */

describe('the revision contract', () => {
  /**
   * A valid revision reply for one file.
   *
   * `operation` is a parameter because a revision's operation follows the
   * filesystem, not the original proposal: the same content is a `create` when
   * the path is empty and an `update` when something is already there, and the
   * validator refuses the wrong one outright.
   */
  function revisionReply(
    content = '<?php\n\nfinal class User\n{\n    public function __construct(public readonly string $name) {}\n}\n',
    operation: 'create' | 'update' = 'create'
  ): string {
    return JSON.stringify({
      protocol_version: PAIRPILOT_PROTOCOL_VERSION,
      type: 'code_proposal',
      message: 'Tightened the class.',
      changes: [
        {
          file: 'src/User.php',
          operation,
          description: 'A final PHP user entity',
          content,
        },
      ],
    });
  }

  /** Stage the reported proposal and open its permission gate. */
  async function atGate(ai: ScriptedAI): Promise<{
    orchestrator: Orchestrator;
    requests: OrchestratorWritePermissionRequest[];
  }> {
    const requests: OrchestratorWritePermissionRequest[] = [];
    const orchestrator = makeOrchestrator(ai, undefined, (request) => {
      requests.push(request);
    });
    await orchestrator.submitTask('Create a PHP User class');
    return { orchestrator, requests };
  }

  /** The file before the proposal: something is already at the path. */
  const PRE_EXISTING = '<?php\n\n// pre-existing\nfinal class User {}\n';

  /** What the proposal says the file should become. */
  const PROPOSED = '<?php\n\nfinal class User\n{\n    // proposed\n}\n';

  /** What the model sends back when the developer asks for a change. */
  const REVISED_BY_MODEL = '<?php\n\nfinal class User\n{\n    // revised\n}\n';

  /**
   * A proposal that *updates* a file already on disk.
   *
   * The tests about what a revision is told need a path that holds something
   * before the proposal, because that is the only way the current content and the
   * reviewed content can differ. A `create` cannot be used for it: the validator
   * refuses a create over an existing file — correctly — and the turn ends before
   * there is anything to revise.
   */
  function updateReply(content: string): string {
    return JSON.stringify({
      protocol_version: PAIRPILOT_PROTOCOL_VERSION,
      type: 'code_proposal',
      message: 'Rewrote the User class.',
      changes: [
        {
          file: 'src/User.php',
          operation: 'update',
          description: 'The User entity.',
          content,
        },
      ],
    });
  }

  /** A one-change proposal for an arbitrary path, for batch revisions. */
  function oneFileReply(file: string, content: string, operation: 'create' | 'update' = 'create'): string {
    return JSON.stringify({
      protocol_version: PAIRPILOT_PROTOCOL_VERSION,
      type: 'code_proposal',
      message: `Revised ${file}.`,
      changes: [{ file, operation, description: `The revised ${file}.`, content }],
    });
  }

  /** Stage an update of an existing file and open its permission gate. */
  async function atGateOverExisting(
    ai: ScriptedAI,
    onDisk: string = PRE_EXISTING
  ): Promise<{ orchestrator: Orchestrator; requests: OrchestratorWritePermissionRequest[] }> {
    fs.writeFileSync(path.join(root, 'src', 'User.php'), onDisk, 'utf8');
    const requests: OrchestratorWritePermissionRequest[] = [];
    const orchestrator = makeOrchestrator(ai, undefined, (request) => {
      requests.push(request);
    });
    await orchestrator.submitTask('Create a PHP User class');
    return { orchestrator, requests };
  }

  it('applies a revision that carries valid changes', async () => {
    const ai = new ScriptedAI(REPORTED_REPLY, revisionReply());
    const { orchestrator, requests } = await atGate(ai);

    await orchestrator.requestChangesBeforeWrite(requests[0]!.contentHash, 'make the class final');

    expect(orchestrator.errorValue).toBeNull();
    expect(orchestrator.machine.state).toBe(PairPilotState.WAITING_FILE_APPROVAL);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.relativePath).toBe('src/User.php');
    // A new binding: the developer is being asked about different bytes.
    expect(requests[1]!.contentHash).not.toBe(requests[0]!.contentHash);
    expect(fs.existsSync(path.join(root, 'src', 'User.php'))).toBe(false);
  });

  it('refuses a revision reply with no changes array at all', async () => {
    const summary = JSON.stringify({
      protocol_version: PAIRPILOT_PROTOCOL_VERSION,
      type: 'code_proposal',
      message: 'Tightened the class as requested.',
    });
    const ai = new ScriptedAI(REPORTED_REPLY, summary, summary, summary);
    const { orchestrator, requests } = await atGate(ai);

    await orchestrator.requestChangesBeforeWrite(requests[0]!.contentHash, 'make the class final');

    expect(orchestrator.errorValue).toMatch(/non-empty "changes"/);
    expect(orchestrator.machine.state).toBe(PairPilotState.IDLE);
    expect(fs.existsSync(path.join(root, 'src', 'User.php'))).toBe(false);
  });

  it('refuses a revision reply whose changes array is empty', async () => {
    const empty = JSON.stringify({
      protocol_version: PAIRPILOT_PROTOCOL_VERSION,
      type: 'code_proposal',
      message: 'Nothing needed changing.',
      changes: [],
    });
    const ai = new ScriptedAI(REPORTED_REPLY, empty, empty, empty);
    const { orchestrator, requests } = await atGate(ai);

    await orchestrator.requestChangesBeforeWrite(requests[0]!.contentHash, 'make the class final');

    expect(orchestrator.errorValue).toMatch(/changes/i);
    expect(orchestrator.machine.state).toBe(PairPilotState.IDLE);
    expect(fs.existsSync(path.join(root, 'src', 'User.php'))).toBe(false);
  });

  it('shows a chat_response as an answer rather than applying it as a revision', async () => {
    // A model that answers in words has answered. The turn must end with the
    // developer reading it — not with the contract error, and not with a write.
    const chat = JSON.stringify({
      protocol_version: PAIRPILOT_PROTOCOL_VERSION,
      type: 'chat_response',
      message: 'That class is already final, so there is nothing to change.',
    });
    const ai = new ScriptedAI(REPORTED_REPLY, chat);
    const { orchestrator, requests } = await atGate(ai);

    await orchestrator.requestChangesBeforeWrite(requests[0]!.contentHash, 'make the class final');

    expect(ai.turnCount).toBe(2);
    expect(orchestrator.errorValue).toBeNull();
    expect(orchestrator.noticeValue).toMatch(/chat_response/);
    expect(orchestrator.machine.state).toBe(PairPilotState.IDLE);
    const session = store.getActive()!;
    expect(
      session.messages.some((message) => message.text.includes('already final'))
    ).toBe(true);
    expect(fs.existsSync(path.join(root, 'src', 'User.php'))).toBe(false);
  });

  it('shows a clarification_request rather than treating it as a failed revision', async () => {
    // The model is entitled to ask. A revision that ends in a question has not
    // failed — it is waiting on the developer, and saying "the contract was not
    // met" would be wrong about which side is being waited on.
    const question = JSON.stringify({
      protocol_version: PAIRPILOT_PROTOCOL_VERSION,
      type: 'clarification_request',
      message: 'Which visibility should the constructor have?',
      clarification: { question: 'Public or private constructor?', options: ['public', 'private'] },
    });
    const ai = new ScriptedAI(REPORTED_REPLY, question);
    const { orchestrator, requests } = await atGate(ai);

    await orchestrator.requestChangesBeforeWrite(requests[0]!.contentHash, 'make the class final');

    expect(orchestrator.errorValue).toBeNull();
    expect(orchestrator.machine.state).toBe(PairPilotState.IDLE);
    expect(
      store.getActive()!.messages.some((message) => message.text.includes('Public or private'))
    ).toBe(true);
    expect(fs.existsSync(path.join(root, 'src', 'User.php'))).toBe(false);
  });

  it('normalises a nested revision reply into the canonical contract', async () => {
    // The same shape the original bug was reported against, on the revision
    // path: the payload one level down under `proposal`.
    const nested = JSON.stringify({
      protocol_version: PAIRPILOT_PROTOCOL_VERSION,
      type: 'code_proposal',
      message: 'Tightened the class.',
      proposal: {
        changes: [
          {
            file: 'src/User.php',
            operation: 'create',
            description: 'A final PHP user entity',
            content: '<?php\n\nfinal class User {}\n',
          },
        ],
      },
    });
    const ai = new ScriptedAI(REPORTED_REPLY, nested);
    const { orchestrator, requests } = await atGate(ai);

    await orchestrator.requestChangesBeforeWrite(requests[0]!.contentHash, 'make the class final');

    expect(orchestrator.errorValue).toBeNull();
    expect(orchestrator.protocolDiagnostics.recent()[1]!.adaptation).toBe('nested_proposal');
    expect(orchestrator.machine.state).toBe(PairPilotState.WAITING_FILE_APPROVAL);
    expect(requests[1]!.relativePath).toBe('src/User.php');
  });

  it('carries the developer’s feedback verbatim into the revision prompt', async () => {
    const ai = new ScriptedAI(REPORTED_REPLY, revisionReply());
    const { orchestrator, requests } = await atGate(ai);

    await orchestrator.requestChangesBeforeWrite(
      requests[0]!.contentHash,
      'Make the constructor private and add a getName() method.'
    );

    const prompt = ai.prompts[1]!;
    expect(prompt).toContain('Make the constructor private and add a getName() method.');
    // Labelled as the instruction, not as one more piece of context.
    expect(prompt).toMatch(/feedback — this is the instruction to satisfy/);
  });

  it('carries the current on-disk content and the previous approved hash', async () => {
    // The gap the reported failure left open: the prompt used to carry the
    // *approved* code and nothing else, so the model revised its memory of a file
    // rather than the file the developer is looking at. Here the path holds a
    // developer's own edit before the revision is asked for — the state a
    // revision prompt has to describe correctly, and the one the old prompt
    // could not see at all.
    const HAND_EDITED = '<?php\n\n// edited by hand\nfinal class User {}\n';
    const ai = new ScriptedAI(updateReply(PROPOSED), revisionReply(HAND_EDITED + '\n', 'update'));
    const { orchestrator, requests } = await atGateOverExisting(ai);

    await orchestrator.requestChangesBeforeWrite(requests[0]!.contentHash, 'add a name property');

    const prompt = ai.prompts[1]!;
    // The file's real content, exactly as it is now.
    expect(prompt).toContain('// pre-existing');
    expect(prompt).toMatch(/Current content of src\/User\.php/);
    // And the code as reviewed, so the model can tell the two apart.
    expect(prompt).toContain('// proposed');
    expect(prompt).toMatch(/the version you reviewed/i);
    // The hash the approved content is held under, for the audit trail.
    expect(prompt).toContain(requests[0]!.contentHash);
    expect(prompt).toMatch(/content hash/i);
    // The model is told the two differ, so it does not "restore" what it proposed.
    expect(prompt).toMatch(/edited .* since reviewing/i);
  });

  it('refuses a revision whose file was edited while the model was thinking', async () => {
    // The acceptance case the bug report names: the developer keeps typing after
    // asking for a change. Their edits are the ones that survive.
    //
    // The edit lands *during* the revision turn — between the prompt going out
    // and the reply coming back — which is the only window in which a revision
    // can go stale without the review layer catching it first. (An edit made
    // before the request is already refused at the review gate, by the document
    // fingerprint, so this is the window that was genuinely unguarded.)
    //
    // The reply itself is exactly what the prompt asked for — a complete file for
    // the path under revision. That is what makes this a test of the staleness
    // rule rather than of the parser: nothing about the reply is wrong, and the
    // revised bytes are simply no longer the right answer to the file on disk.
    const ai = new ScriptedAI(updateReply(PROPOSED), updateReply(REVISED_BY_MODEL));
    const { orchestrator, requests } = await atGateOverExisting(ai);
    const typedMeanwhile = '<?php\n\n// typed during the revision\nfinal class User {}\n';
    ai.beforeReply = (_prompt, attempt) => {
      if (attempt === 1) {
        fs.writeFileSync(path.join(root, 'src', 'User.php'), typedMeanwhile, 'utf8');
      }
    };

    await orchestrator.requestChangesBeforeWrite(requests[0]!.contentHash, 'make the class final');

    expect(orchestrator.errorValue).toMatch(/edited after you asked/i);
    expect(orchestrator.noticeValue).toMatch(/exactly as you left it/i);
    expect(orchestrator.machine.state).toBe(PairPilotState.IDLE);
    // No second permission prompt: the stale reply never reached the gate.
    expect(requests).toHaveLength(1);
    // And the developer's own bytes are still on disk, untouched.
    expect(fs.readFileSync(path.join(root, 'src', 'User.php'), 'utf8')).toBe(typedMeanwhile);
  });

  it('refuses a revision reply that proposes a different file', async () => {
    // A reply that satisfies the generic shape by proposing some other file is
    // not the revision that was asked for, however well-formed it is.
    const elsewhere = JSON.stringify({
      protocol_version: PAIRPILOT_PROTOCOL_VERSION,
      type: 'code_proposal',
      message: 'Here is a repository instead.',
      changes: [
        {
          file: 'src/UserRepository.php',
          operation: 'create',
          description: 'A repository.',
          content: '<?php\n\nfinal class UserRepository {}\n',
        },
      ],
    });
    const ai = new ScriptedAI(REPORTED_REPLY, elsewhere, elsewhere, elsewhere);
    const { orchestrator, requests } = await atGate(ai);

    await orchestrator.requestChangesBeforeWrite(requests[0]!.contentHash, 'make the class final');

    expect(orchestrator.errorValue).toMatch(/src\/User\.php/);
    // Corrected rather than accepted: the retry says which file it must be.
    expect(ai.turnCount).toBe(4);
    expect(ai.prompts[2]).toContain('src/User.php');
    expect(fs.existsSync(path.join(root, 'src', 'UserRepository.php'))).toBe(false);
    // The file being revised is untouched and the batch has no new member.
    expect(fs.existsSync(path.join(root, 'src', 'User.php'))).toBe(false);
    expect(orchestrator.batchView!.total).toBe(1);
  });

  it('never applies a failed revision over the original file', async () => {
    // The strongest form of the guarantee: a file that exists, a revision that
    // never validates, and byte-for-byte proof it is unchanged afterwards.
    //
    // One summary-shaped reply is enough: `ScriptedAI` repeats its last reply
    // once the script runs out, so every attempt — the request and both
    // corrections — answers with the same invalid shape.
    const ai = new ScriptedAI(
      updateReply(PROPOSED),
      JSON.stringify({
        protocol_version: PAIRPILOT_PROTOCOL_VERSION,
        type: 'code_proposal',
        message: 'I would make it final.',
      })
    );
    const { orchestrator, requests } = await atGateOverExisting(ai);

    await orchestrator.requestChangesBeforeWrite(requests[0]!.contentHash, 'make the class final');

    expect(orchestrator.errorValue).toMatch(/non-empty "changes"/);
    expect(orchestrator.noticeValue).toMatch(/unchanged/i);
    expect(fs.readFileSync(path.join(root, 'src', 'User.php'), 'utf8')).toBe(PRE_EXISTING);
    expect(orchestrator.machine.state).toBe(PairPilotState.IDLE);
  });

  it('revises one file of a batch without disturbing the review of another', async () => {
    // The batch is why a revision has to be scoped at all. The developer reviews
    // a set file by file, so asking for a change to the first must not rewrite
    // the second out from under the review it is still waiting for.
    //
    // What is asserted here is the wiring: that a revision asked for at the gate
    // of a multi-file set is merged into the batch as a revision of *its own*
    // entry, rather than being re-staged as a fresh proposal of one file. The
    // content half of the guarantee — that every sibling keeps its hash and its
    // bytes — belongs to the merge itself, and is pinned there
    // (`BatchExecution.test.ts`, "replaces only the revised file and leaves the
    // other six exactly as they were"). This test exists because passing the
    // right reply to the right merge is a separate thing from the merge being
    // right.
    const ENTITY = 'src/Domain/User.php';
    const REPOSITORY = 'src/Infrastructure/UserRepository.php';
    const REVISED_ENTITY =
      '<?php\n\nfinal class User\n{\n    public function __construct(public readonly string $name) {}\n}\n';

    const ai = new ScriptedAI(MULTI_FILE_REPLY, oneFileReply(ENTITY, REVISED_ENTITY));
    const orchestrator = makeOrchestrator(ai);
    await orchestrator.submitTask('Create a user module');

    const before = orchestrator.batchView!;
    expect(before.files.map((file) => file.file)).toEqual([ENTITY, REPOSITORY]);
    const repositoryBefore = before.files.find((file) => file.file === REPOSITORY)!;

    await orchestrator.requestChangesBeforeWrite(
      orchestrator.approvals.getPendingHash()!,
      'give the User a name'
    );

    // One request, one reply: the revision was satisfied on the first turn. A
    // revision that quietly re-staged the whole set would show up here as a
    // second prompt, because staging the reply as a new proposal is exactly what
    // would leave the sibling's review behind.
    expect(ai.turnCount).toBe(2);
    expect(orchestrator.errorValue).toBeNull();

    const after = orchestrator.batchView!;
    expect(after.total).toBe(2);
    expect(after.files.map((file) => file.file)).toEqual([ENTITY, REPOSITORY]);
    expect(after.files.map((file) => file.fileId)).toEqual(before.files.map((file) => file.fileId));

    // The sibling is exactly as it was: same file, same identity, same
    // operation, still waiting for its own decision.
    expect(after.files.find((file) => file.file === REPOSITORY)).toEqual(repositoryBefore);

    // And the revised content went to the file under revision, not to the set.
    const pending = orchestrator.approvals.getPending()!;
    expect(pending.relativePath).toBe(ENTITY);
    expect(pending.assembledCode).toBe(REVISED_ENTITY);
  });
});

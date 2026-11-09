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

import { Orchestrator, type OrchestratorConfig, type OrchestratorDeps } from '../../src/core/Orchestrator';
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
    const text = this.replies[Math.min(this.index, this.replies.length - 1)] ?? '';
    this.index += 1;

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

function makeOrchestrator(ai: ScriptedAI): Orchestrator {
  const deps: OrchestratorDeps = {
    context: {} as never,
    logger,
    ai: ai as unknown as AIOrchestrator,
    workspace,
    store,
    diff: {} as never,
    notify: () => {},
    notifyCodeDelta: () => {},
    notifyTextDelta: () => {},
    notifyWritingProgress: () => {},
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
    expect(orchestrator.errorValue).toBeNull();
    expect(orchestrator.machine.state).toBe(PairPilotState.WAITING_FILE_APPROVAL);
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

/**
 * WritePermission tests — the gate that must be answerable, and nothing more.
 *
 * The gate these cover is the one that broke in 0.4.0: a proposal reached
 * `WAITING_FILE_APPROVAL`, the sidebar buttons that used to answer it were
 * removed with the rest of the panel's authority, and nothing replaced them. The
 * workflow waited at a state with no surface. What is asserted here is the
 * surface's own contract, with an injected prompt so no editor is involved:
 *
 *  - an answer is applied exactly once,
 *  - a dismissed prompt decides nothing and can be raised again,
 *  - a prompt whose request was superseded applies nothing,
 *  - a gate that has closed drops its request instead of offering a question
 *    the workflow can only refuse.
 *
 * Authority is not tested here because it does not live here: the class never
 * checks a hash. `Orchestrator` re-verifies every answer, which is why these
 * tests can hand it plain strings.
 */

import { describe, expect, it } from 'vitest';
import {
  WritePermission,
  type PermissionChoice,
  type TakenPermissionChoice,
} from '../../src/review/WritePermission';
import type { OrchestratorWritePermissionRequest } from '../../src/core/Orchestrator';
import type { Logger } from '../../src/types';

function request(overrides: Partial<OrchestratorWritePermissionRequest> = {}): OrchestratorWritePermissionRequest {
  return {
    sessionId: 'permission:1:src/a.ts:0123456789ab',
    relativePath: 'src/a.ts',
    absolutePath: '/workspace/src/a.ts',
    operation: 'create',
    description: 'A file.',
    rationale: null,
    contentHash: 'a'.repeat(64),
    setHash: null,
    position: null,
    binding: { proposalId: 'b'.repeat(64), proposalVersion: 1, fileId: 'c'.repeat(16) },
    ...overrides,
  };
}

class SilentLogger implements Logger {
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

interface Harness {
  permission: WritePermission;
  promptCalls: OrchestratorWritePermissionRequest[];
  applied: Array<{ request: OrchestratorWritePermissionRequest; choice: TakenPermissionChoice }>;
  logger: SilentLogger;
}

function makeHarness(options: {
  answer?: PermissionChoice | (() => Promise<PermissionChoice>);
  live?: boolean | ((request: OrchestratorWritePermissionRequest) => boolean);
} = {}): Harness {
  const promptCalls: OrchestratorWritePermissionRequest[] = [];
  const applied: Array<{ request: OrchestratorWritePermissionRequest; choice: TakenPermissionChoice }> = [];
  const logger = new SilentLogger();

  const live = options.live ?? true;
  const answer = options.answer ?? { kind: 'write' };

  const permission = new WritePermission({
    prompt: async (incoming) => {
      promptCalls.push(incoming);
      return typeof answer === 'function' ? answer() : answer;
    },
    apply: async (incoming, choice) => {
      applied.push({ request: incoming, choice });
    },
    isLive: (incoming) => (typeof live === 'function' ? live(incoming) : live),
    logger,
  });

  return { permission, promptCalls, applied, logger };
}

describe('WritePermission: applying an answer', () => {
  it('passes the choice to the workflow and clears the request', async () => {
    const harness = makeHarness({ answer: { kind: 'write' } });
    const incoming = request();

    await harness.permission.ask(incoming);

    expect(harness.promptCalls).toEqual([incoming]);
    expect(harness.applied).toHaveLength(1);
    expect(harness.applied[0]!.choice.kind).toBe('write');
    expect(harness.permission.pendingRequest).toBeNull();
  });

  it('carries revision feedback through unchanged', async () => {
    const harness = makeHarness({ answer: { kind: 'revise', feedback: 'use a factory' } });

    await harness.permission.ask(request());

    expect(harness.applied[0]!.choice).toEqual({ kind: 'revise', feedback: 'use a factory' });
  });

  it('reports an error in the applied answer rather than swallowing it', async () => {
    const harness = makeHarness();
    const incoming = request();
    // A workflow refusal is recorded on the orchestrator; the prompt layer must
    // not turn it into a success.
    const failing = new WritePermission({
      prompt: async () => ({ kind: 'write' }),
      apply: async () => {
        throw new Error('the proposal changed');
      },
      isLive: () => true,
      logger: harness.logger,
    });

    await failing.ask(incoming);

    expect(harness.logger.errors.join(' ')).toMatch(/proposal changed/);
  });
});

describe('WritePermission: a prompt that was closed', () => {
  it('decides nothing and leaves the request pending', async () => {
    const harness = makeHarness({ answer: { kind: 'dismissed' } });

    await harness.permission.ask(request());

    expect(harness.applied).toHaveLength(0);
    expect(harness.permission.pendingRequest?.relativePath).toBe('src/a.ts');
  });

  it('can be raised again, so Escape is not the same as declining', async () => {
    let answer: PermissionChoice = { kind: 'dismissed' };
    const harness = makeHarness({ answer: () => Promise.resolve(answer) });

    await harness.permission.ask(request());
    expect(harness.applied).toHaveLength(0);

    answer = { kind: 'reject' };
    expect(await harness.permission.raise()).toBe(true);
    expect(harness.promptCalls).toHaveLength(2);
    expect(harness.applied[0]!.choice.kind).toBe('reject');
    expect(harness.permission.pendingRequest).toBeNull();
  });

  it('reports nothing to raise when no request is pending', async () => {
    const harness = makeHarness();
    expect(await harness.permission.raise()).toBe(false);
    expect(harness.promptCalls).toHaveLength(0);
  });
});

describe('WritePermission: a gate that is no longer open', () => {
  it('drops the request instead of asking a question the workflow would refuse', async () => {
    const harness = makeHarness({ live: false });

    await harness.permission.ask(request());

    expect(harness.promptCalls).toHaveLength(0);
    expect(harness.permission.pendingRequest).toBeNull();
    expect(harness.logger.infos.join(' ')).toMatch(/stale write-permission prompt/i);
  });

  it('checks liveness again on a re-raise', async () => {
    let live = true;
    const harness = makeHarness({ answer: { kind: 'dismissed' }, live: () => live });

    await harness.permission.ask(request());
    expect(harness.promptCalls).toHaveLength(1);

    live = false;
    expect(await harness.permission.raise()).toBe(false);
    expect(harness.promptCalls).toHaveLength(1);
    expect(harness.permission.pendingRequest).toBeNull();
  });
});

describe('WritePermission: one prompt at a time', () => {
  it('never stacks a second modal over the first', async () => {
    let release: (choice: PermissionChoice) => void = () => {};
    const harness = makeHarness({
      answer: () =>
        new Promise<PermissionChoice>((resolve) => {
          release = resolve;
        }),
    });

    const first = harness.permission.ask(request());
    // A second request arrives while the first prompt is on screen. Nothing new
    // is opened, but the caller is told a prompt is there rather than "nothing
    // is waiting".
    expect(await harness.permission.raise()).toBe(true);

    release({ kind: 'write' });
    await first;

    expect(harness.promptCalls).toHaveLength(1);
    expect(harness.applied).toHaveLength(1);
  });

  it('ignores an answer for a request that was superseded while its prompt was open', async () => {
    let release: (choice: PermissionChoice) => void = () => {};
    const harness = makeHarness({
      answer: () =>
        new Promise<PermissionChoice>((resolve) => {
          release = resolve;
        }),
    });

    const first = request({ relativePath: 'src/first.ts', contentHash: '1'.repeat(64) });
    const second = request({ relativePath: 'src/second.ts', contentHash: '2'.repeat(64) });

    const pendingFirst = harness.permission.ask(first);
    harness.permission.clear();
    const pendingSecond = harness.permission.ask(second);

    release({ kind: 'write' });
    await Promise.all([pendingFirst, pendingSecond]);

    // The first answer named bytes the workflow no longer holds, so nothing was
    // applied for it; the second request is the one still pending.
    expect(harness.applied).toHaveLength(0);
    expect(harness.permission.pendingRequest?.relativePath).toBe('src/second.ts');
  });
});

describe('WritePermission: clear', () => {
  it('forgets the pending request without deciding anything', async () => {
    const harness = makeHarness({ answer: { kind: 'dismissed' } });
    await harness.permission.ask(request());

    harness.permission.clear();

    expect(harness.permission.pendingRequest).toBeNull();
    expect(await harness.permission.raise()).toBe(false);
  });

  it('is idempotent', () => {
    const harness = makeHarness();
    harness.permission.clear();
    harness.permission.clear();
    expect(harness.permission.pendingRequest).toBeNull();
  });
});

/* A compile-time guard: the choice type must stay closed. */
const _exhaustive: PermissionChoice[] = [
  { kind: 'write' },
  { kind: 'write_all' },
  { kind: 'revise', feedback: 'x' },
  { kind: 'reject' },
  { kind: 'dismissed' },
];
void _exhaustive;

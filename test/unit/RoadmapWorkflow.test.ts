/**
 * RoadmapWorkflow — when the developer is asked whether work is verified.
 *
 * The rule being tested is a sequencing one: the verification prompt writes
 * `done` into a project file, so it must appear exactly when that answer is the
 * only thing standing between an approved task and a finished one — and never
 * otherwise. A prompt after every file is noise; a missing prompt silently
 * freezes the roadmap.
 *
 * The roadmap half of this is already proved by `RoadmapContinuation.test.ts`.
 * What is proved here is the adapter: that it records approvals it was not told
 * about, and that it asks at the right moment and obeys the answer.
 */

import { describe, expect, it, vi } from 'vitest';
import { parseRoadmap, withStatus, type RoadmapStatus } from '../../src/roadmap/Roadmap';
import { RoadmapContinuation } from '../../src/roadmap/RoadmapContinuation';
import { ApprovedLedger, RoadmapWorkflow } from '../../src/roadmap/RoadmapWorkflow';
import type { RoadmapReadResult, RoadmapStore } from '../../src/roadmap/RoadmapStore';
import type { Logger } from '../../src/types';

const ROADMAP = `# Roadmap

### models — Domain models
- files: src/User.php, src/Order.php

### repo — Repositories
- files: src/UserRepository.php
- depends-on: models
`;

function silentLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    diagnostic: () => undefined,
  };
}

function memoryStore(initial: string) {
  const state = { text: initial, writes: [] as Array<{ taskId: string; status: RoadmapStatus }> };
  const store = {
    read: async (): Promise<RoadmapReadResult> => ({
      status: 'found',
      relativePath: 'ROADMAP.md',
      roadmap: parseRoadmap(state.text),
    }),
    setStatus: async (_path: string, taskId: string, status: RoadmapStatus): Promise<boolean> => {
      const updated = withStatus(state.text, taskId, status);
      if (updated === null) {
        return false;
      }
      state.text = updated;
      state.writes.push({ taskId, status });
      return true;
    },
  } as unknown as RoadmapStore;
  return { store, state };
}

function setup(options: { verified?: boolean; initial?: string } = {}) {
  const memory = memoryStore(options.initial ?? ROADMAP);
  const confirmVerified = vi.fn(async () => options.verified ?? false);
  const workflow = new RoadmapWorkflow({
    store: memory.store,
    continuation: new RoadmapContinuation({ store: memory.store, logger: silentLogger() }),
    ledger: new ApprovedLedger(),
    logger: silentLogger(),
    confirmVerified,
  });
  return { workflow, confirmVerified, state: memory.state };
}

describe('advance', () => {
  it('asks nothing while a task still has files to write', async () => {
    const { workflow, confirmVerified } = setup();
    const result = await workflow.advance({
      relativePath: 'src/User.php',
      approvedPaths: ['src/User.php'],
    });

    expect(result).toMatchObject({ kind: 'next_file', relativePath: 'src/Order.php' });
    // No question, because the answer could not change anything: the task has
    // another file either way.
    expect(confirmVerified).not.toHaveBeenCalled();
  });

  it('asks once the task is fully written, and stops when the answer is no', async () => {
    const { workflow, confirmVerified, state } = setup({ verified: false });
    const result = await workflow.advance({
      relativePath: 'src/Order.php',
      approvedPaths: ['src/User.php', 'src/Order.php'],
    });

    expect(confirmVerified).toHaveBeenCalledTimes(1);
    expect(confirmVerified).toHaveBeenCalledWith('models');
    expect(result).toEqual({ kind: 'awaiting_verification', taskId: 'models' });
    expect(state.writes.every((write) => write.status !== 'done')).toBe(true);
  });

  it('marks the task done and offers the next one when the answer is yes', async () => {
    const { workflow, state } = setup({ verified: true });
    const result = await workflow.advance({
      relativePath: 'src/Order.php',
      approvedPaths: ['src/User.php', 'src/Order.php'],
    });

    expect(result).toMatchObject({
      kind: 'next_task',
      taskId: 'repo',
      relativePath: 'src/UserRepository.php',
    });
    expect(parseRoadmap(state.text).tasks[0]?.status).toBe('done');
  });

  it('records an approval the caller did not pass, so a rollover does not lose it', async () => {
    // The batch is rewound between windows; the ledger is what remembers that
    // `src/User.php` already landed. Without it, approving `src/Order.php`
    // alone would look like the first file of the task.
    const { workflow } = setup({ verified: true });
    await workflow.advance({ relativePath: 'src/User.php', approvedPaths: [] });
    const result = await workflow.advance({
      relativePath: 'src/Order.php',
      approvedPaths: ['src/Order.php'],
    });
    expect(result).toMatchObject({ kind: 'next_task', taskId: 'repo' });
  });

  it('treats a path written two ways as one file', async () => {
    const { workflow } = setup({ verified: true });
    await workflow.advance({ relativePath: './src\\User.php', approvedPaths: [] });
    const result = await workflow.advance({
      relativePath: 'src/Order.php',
      approvedPaths: [],
    });
    expect(result).toMatchObject({ kind: 'next_task' });
  });

  it('does not prompt for a file outside the roadmap', async () => {
    const { workflow, confirmVerified } = setup();
    const result = await workflow.advance({ relativePath: 'src/Scratch.php', approvedPaths: [] });
    expect(result).toEqual({ kind: 'unlisted', relativePath: 'src/Scratch.php' });
    expect(confirmVerified).not.toHaveBeenCalled();
  });
});

describe('ApprovedLedger', () => {
  it('folds separators and a leading ./, and clears on demand', () => {
    const ledger = new ApprovedLedger();
    ledger.add('./src\\User.php');
    expect(ledger.has('src/User.php')).toBe(true);
    expect(ledger.all()).toEqual(['src/User.php']);
    ledger.clear();
    expect(ledger.all()).toEqual([]);
  });
});

describe('describeForPrompt', () => {
  it('renders the roadmap, and nothing when there is none', async () => {
    const { workflow } = setup();
    const text = await workflow.describeForPrompt();
    expect(text).toContain('models');
    expect(text).toContain('Work on exactly one file at a time');

    const missing = {
      read: async (): Promise<RoadmapReadResult> => ({ status: 'missing', searched: [] }),
      setStatus: async () => false,
    } as unknown as RoadmapStore;
    const withNoRoadmap = new RoadmapWorkflow({
      store: missing,
      continuation: new RoadmapContinuation({ store: missing, logger: silentLogger() }),
      ledger: new ApprovedLedger(),
      logger: silentLogger(),
      confirmVerified: async () => false,
    });
    expect(await withNoRoadmap.describeForPrompt()).toBeNull();
  });
});

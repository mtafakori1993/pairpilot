/**
 * RoadmapContinuation — the loop the spec asks for, proved without an editor.
 *
 * The interesting behaviour is not "it returns a path". It is the two refusals
 * that keep the roadmap honest:
 *
 *  - a task with several files is not `done` when its first file lands, and
 *  - no task is `done` on an approval alone — verification has to have passed.
 *
 * Both are asserted here as outcomes of the public method, against a store
 * double that holds real roadmap text and applies the same `withStatus` edit the
 * real `WorkspaceEdit` applies. That is what makes the fixture unable to drift
 * from the file the workflow actually writes.
 */

import { describe, expect, it } from 'vitest';
import { parseRoadmap, withStatus, type RoadmapStatus } from '../../src/roadmap/Roadmap';
import { RoadmapContinuation, renderForPrompt } from '../../src/roadmap/RoadmapContinuation';
import type { RoadmapReadResult, RoadmapStore } from '../../src/roadmap/RoadmapStore';
import type { Logger } from '../../src/types';

const ROADMAP = `# Roadmap

## Phase 1

### schema — Create the schema
- status: done
- files: src/db.php

### models — Domain models
- files: src/User.php, src/Order.php
- depends-on: schema

### repo — Repositories
- status: todo
- files: src/UserRepository.php
- depends-on: models

### index — Landing page
- status: todo
- files: index.php
- depends-on: repo
`;

function silentLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    diagnostic: () => undefined,
  };
}

/**
 * A store over a mutable string.
 *
 * `writes` records every status change in order, which is how "done was never
 * written on approval alone" becomes an assertion rather than a comment.
 */
function memoryStore(initial: string, options: { failWrites?: boolean } = {}) {
  const state = { text: initial, writes: [] as Array<{ taskId: string; status: RoadmapStatus }> };

  const store: RoadmapStore = {
    read: async (): Promise<RoadmapReadResult> => ({
      status: 'found',
      relativePath: 'ROADMAP.md',
      roadmap: parseRoadmap(state.text),
    }),
    setStatus: async (
      _relativePath: string,
      taskId: string,
      status: RoadmapStatus
    ): Promise<boolean> => {
      if (options.failWrites) {
        return false;
      }
      const updated = withStatus(state.text, taskId, status);
      if (updated === null) {
        return false;
      }
      state.text = updated;
      state.writes.push({ taskId, status });
      return true;
    },
    // Only `read` and `setStatus` are reached by the continuation.
  } as unknown as RoadmapStore;

  return { store, state };
}

function continuationWith(text: string, failWrites = false) {
  const memory = memoryStore(text, { failWrites });
  const continuation = new RoadmapContinuation({
    store: memory.store,
    logger: silentLogger(),
  });
  return { continuation, state: memory.state };
}

/** The status a task currently carries, read back through the real parser. */
function statusOf(state: { text: string }, taskId: string): RoadmapStatus | undefined {
  return parseRoadmap(state.text).tasks.find((task) => task.id === taskId)?.status;
}

describe('afterApproval — advancing within a task', () => {
  it('opens the next file of the same task instead of calling it done', async () => {
    const { continuation, state } = continuationWith(ROADMAP);

    const result = await continuation.afterApproval({
      relativePath: 'src/User.php',
      approvedPaths: ['src/User.php'],
      verified: false,
    });

    expect(result).toMatchObject({
      kind: 'next_file',
      taskId: 'models',
      relativePath: 'src/Order.php',
    });
    // The first of two files does not finish the task, and the status says so.
    expect(statusOf(state, 'models')).toBe('in_progress');
  });

  it('asks again for the file still outstanding, describing this approval as a no-op', async () => {
    // Approval of a file does not itself advance the set; the caller supplies
    // it. So the answer depends on what the caller has recorded, and nothing
    // else — which is the property that lets a revision re-approve safely.
    const { continuation, state } = continuationWith(ROADMAP);
    const first = await continuation.afterApproval({
      relativePath: 'src/User.php',
      approvedPaths: ['src/User.php'],
      verified: false,
    });
    const again = await continuation.afterApproval({
      relativePath: 'src/User.php',
      approvedPaths: ['src/User.php'],
      verified: false,
    });
    expect(again).toMatchObject({ kind: 'next_file', relativePath: 'src/Order.php' });
    // The second answer reports that nothing further moved.
    expect(first).toMatchObject({ kind: 'next_file', statusChanged: true });
    expect(again).toMatchObject({ kind: 'next_file', statusChanged: false });
    expect(state.writes).toHaveLength(1);
  });

  it('accepts a path written the other way round', async () => {
    const { continuation } = continuationWith(ROADMAP);
    const result = await continuation.afterApproval({
      relativePath: './src\\User.php',
      approvedPaths: [],
      verified: false,
    });
    expect(result).toMatchObject({ kind: 'next_file', relativePath: 'src/Order.php' });
  });

  it('does not write a status that already matches', async () => {
    const { continuation, state } = continuationWith(ROADMAP);
    await continuation.afterApproval({
      relativePath: 'src/User.php',
      approvedPaths: ['src/User.php'],
      verified: false,
    });
    // A second approval of the second file, with the task already in progress,
    // must not produce a redundant write.
    state.writes.length = 0;
    await continuation.afterApproval({
      relativePath: 'src/Order.php',
      approvedPaths: ['src/User.php', 'src/Order.php'],
      verified: false,
    });
    expect(state.writes).toEqual([]);
  });
});

describe('afterApproval — finishing a task', () => {
  it('refuses to mark a finished task done when nothing was verified', async () => {
    const { continuation, state } = continuationWith(ROADMAP);
    const result = await continuation.afterApproval({
      relativePath: 'src/Order.php',
      approvedPaths: ['src/User.php', 'src/Order.php'],
      verified: false,
    });

    expect(result).toEqual({ kind: 'awaiting_verification', taskId: 'models' });
    // This is the whole point: approved is not done.
    expect(statusOf(state, 'models')).toBe('in_progress');
    expect(state.writes.some((write) => write.status === 'done')).toBe(false);
  });

  it('marks the task done and starts the dependent task once verified', async () => {
    const { continuation, state } = continuationWith(ROADMAP);
    const result = await continuation.afterApproval({
      relativePath: 'src/Order.php',
      approvedPaths: ['src/User.php', 'src/Order.php'],
      verified: true,
    });

    expect(result).toEqual({
      kind: 'next_task',
      taskId: 'repo',
      relativePath: 'src/UserRepository.php',
      completedTaskId: 'models',
    });
    expect(statusOf(state, 'models')).toBe('done');
  });

  it('never skips a task whose dependency is not done', async () => {
    const { continuation } = continuationWith(ROADMAP);
    await continuation.afterApproval({
      relativePath: 'src/Order.php',
      approvedPaths: ['src/User.php', 'src/Order.php'],
      verified: true,
    });
    // `repo` is now active. `index` depends on it and must not be offered.
    const result = await continuation.afterApproval({
      relativePath: 'src/UserRepository.php',
      approvedPaths: ['src/UserRepository.php'],
      verified: true,
    });
    expect(result).toMatchObject({ kind: 'next_task', taskId: 'index' });
  });

  it('reports completion when the last task is verified', async () => {
    // A one-file roadmap, so the test is about the end of the file rather than
    // about which dependent task happens to follow.
    const { continuation } = continuationWith(
      '### only — The only file\n- status: in_progress\n- files: index.php\n'
    );
    const result = await continuation.afterApproval({
      relativePath: 'index.php',
      approvedPaths: ['index.php'],
      verified: true,
    });
    expect(result).toMatchObject({ kind: 'complete' });
  });

  it('walks the rest of the roadmap from one task to the next', async () => {
    const { continuation } = continuationWith(ROADMAP);

    // Finish `models` — its two files, then verification.
    await continuation.afterApproval({
      relativePath: 'src/User.php',
      approvedPaths: ['src/User.php'],
      verified: false,
    });
    const modelsDone = await continuation.afterApproval({
      relativePath: 'src/Order.php',
      approvedPaths: ['src/User.php', 'src/Order.php'],
      verified: true,
    });
    expect(modelsDone).toMatchObject({ kind: 'next_task', taskId: 'repo' });

    // `repo` is one file, so one verified approval finishes it.
    const repoDone = await continuation.afterApproval({
      relativePath: 'src/UserRepository.php',
      approvedPaths: ['src/UserRepository.php'],
      verified: true,
    });
    expect(repoDone).toMatchObject({ kind: 'next_task', taskId: 'index' });

    const last = await continuation.afterApproval({
      relativePath: 'index.php',
      approvedPaths: ['index.php'],
      verified: true,
    });
    expect(last).toMatchObject({ kind: 'complete' });
  });
});

describe('afterApproval — refusals', () => {
  it('says a file outside the plan advances nothing, rather than inventing a next step', async () => {
    const { continuation, state } = continuationWith(ROADMAP);
    const result = await continuation.afterApproval({
      relativePath: 'src/Scratch.php',
      approvedPaths: ['src/Scratch.php'],
      verified: true,
    });
    expect(result).toEqual({ kind: 'unlisted', relativePath: 'src/Scratch.php' });
    expect(state.writes).toEqual([]);
  });

  it('stops when the roadmap could not be updated', async () => {
    const { continuation } = continuationWith(ROADMAP, true);
    const result = await continuation.afterApproval({
      relativePath: 'src/User.php',
      approvedPaths: ['src/User.php'],
      verified: false,
    });
    // Handing back `src/Order.php` here would be a promise the file on disk
    // does not keep.
    expect(result).toMatchObject({ kind: 'blocked' });
    if (result.kind === 'blocked') {
      expect(result.reason).toContain('models');
    }
  });

  it('reports a roadmap it cannot parse at all', async () => {
    const { continuation } = continuationWith('# Roadmap\n\nNo tasks here.\n');
    expect(await continuation.afterApproval({
      relativePath: 'a.php',
      approvedPaths: [],
      verified: true,
    })).toMatchObject({ kind: 'blocked' });
  });

  it('reports the absence of a roadmap as absence, not as an error', async () => {
    const store = {
      read: async (): Promise<RoadmapReadResult> => ({ status: 'missing', searched: ['ROADMAP.md'] }),
      setStatus: async () => false,
    } as unknown as RoadmapStore;
    const continuation = new RoadmapContinuation({ store, logger: silentLogger() });

    expect(
      await continuation.afterApproval({ relativePath: 'a.php', approvedPaths: [], verified: true })
    ).toEqual({ kind: 'no_roadmap' });
  });
});

describe('current', () => {
  it('names the begun task, else the next available one', async () => {
    const { continuation } = continuationWith(ROADMAP);
    // `models` is `todo` but available, since `schema` is done.
    expect(await continuation.current()).toEqual({
      taskId: 'models',
      relativePath: 'src/User.php',
    });
  });

  it('is null without a roadmap', async () => {
    const store = {
      read: async (): Promise<RoadmapReadResult> => ({ status: 'missing', searched: [] }),
      setStatus: async () => false,
    } as unknown as RoadmapStore;
    const continuation = new RoadmapContinuation({ store, logger: silentLogger() });
    expect(await continuation.current()).toBeNull();
  });
});

describe('renderForPrompt', () => {
  it('marks the current task and states the order of its files', () => {
    const text = renderForPrompt(parseRoadmap(ROADMAP), 'ROADMAP.md');
    expect(text).toContain('Roadmap (ROADMAP.md):');
    expect(text).toContain('- models [todo] Domain models  ← current task');
    expect(text).toContain('files, in order: src/User.php, src/Order.php');
    expect(text).toContain('depends on: schema');
    expect(text).toContain('Work on exactly one file at a time');
  });

  it('includes a problem, so the model does not work around it blind', () => {
    const roadmap = parseRoadmap('### a — A\n- files: a.php\n- depends-on: ghost\n');
    expect(renderForPrompt(roadmap, 'ROADMAP.md')).toContain('ghost');
  });

  it('omits the notes line for a task with no prose', () => {
    const text = renderForPrompt(parseRoadmap('### a — A\n- files: a.php\n'), 'r.md');
    expect(text).not.toContain('notes:');
  });
});

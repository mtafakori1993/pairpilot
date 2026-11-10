/**
 * ROADMAP.md — parsing, dependency order, and the status edit.
 *
 * The roadmap is what makes "write one file, approve it, open the next" a
 * property of the project rather than a cursor in memory. So the tests here are
 * about the two ways that can go wrong: a task becoming available too early
 * (an ugly dependency mistake, silently skipped work), and a status edit
 * rewriting a file the developer hand-wrote.
 */

import { describe, expect, it } from 'vitest';
import {
  ROADMAP_STATUSES,
  activeTask,
  availability,
  currentTask,
  headingFor,
  isComplete,
  nextTask,
  normaliseId,
  parseRoadmap,
  statusLine,
  taskOwning,
  withStatus,
} from '../../src/roadmap/Roadmap';

const ROADMAP = `# Roadmap

Intro prose that is nobody's task.

## Phase 1 — Data layer

### schema — Create the schema
- status: done
- files: src/db.php

Defines the tables.

### models — Domain models
- status: todo
- files: \`src/User.php\`, src/Order.php
- depends-on: schema

One class per table.

### repo — Repositories
- status: todo
- files: src/UserRepository.php
- depends-on: models

## Phase 2 — Web

### index — Landing page
- status: todo
- files: index.php
- depends-on: repo
`;

describe('parseRoadmap', () => {
  it('reads every task in file order', () => {
    const roadmap = parseRoadmap(ROADMAP);
    expect(roadmap.problems).toEqual([]);
    expect(roadmap.tasks.map((task) => task.id)).toEqual(['schema', 'models', 'repo', 'index']);
    expect(roadmap.tasks.map((task) => task.status)).toEqual(['done', 'todo', 'todo', 'todo']);
  });

  it('reads a task title from the heading, and its files from the list', () => {
    const models = parseRoadmap(ROADMAP).tasks[1]!;
    expect(models.title).toBe('Domain models');
    expect(models.files).toEqual(['src/User.php', 'src/Order.php']);
    expect(models.dependsOn).toEqual(['schema']);
    expect(models.notes).toBe('One class per table.');
  });

  it('treats a task with no status line as not started', () => {
    const roadmap = parseRoadmap('### lonely — Just an idea\n- files: a.php\n');
    expect(roadmap.tasks[0]?.status).toBe('todo');
  });

  it('accepts the spellings people actually write by hand', () => {
    const roadmap = parseRoadmap(
      '### a — A\n- status: in-progress\n- files: a.php\n\n### b — B\n- status: completed\n- files: b.php\n'
    );
    expect(roadmap.tasks.map((task) => task.status)).toEqual(['in_progress', 'done']);
  });

  it('reports a status it does not understand rather than guessing one', () => {
    const roadmap = parseRoadmap('### a — A\n- status: almost\n- files: a.php\n');
    expect(roadmap.problems[0]?.message).toContain('almost');
    expect(roadmap.tasks[0]?.status).toBe('todo');
  });

  it('reports a dependency on a task that does not exist', () => {
    const roadmap = parseRoadmap('### a — A\n- files: a.php\n- depends-on: ghost\n');
    expect(roadmap.problems.some((problem) => problem.message.includes('ghost'))).toBe(true);
  });

  it('drops a task that declares no files, and says why', () => {
    const roadmap = parseRoadmap('### empty — Nothing to write\n- status: todo\n');
    expect(roadmap.tasks).toHaveLength(0);
    expect(roadmap.problems.some((problem) => problem.message.includes('no files'))).toBe(true);
  });

  it('reports an empty roadmap instead of returning silence', () => {
    const roadmap = parseRoadmap('# Just a heading\n\nSome prose.\n');
    expect(roadmap.tasks).toEqual([]);
    expect(roadmap.problems).toHaveLength(1);
  });

  it('ends a task at the next phase heading', () => {
    const roadmap = parseRoadmap(
      '### a — A\n- files: a.php\n\n## Next phase\n\n### b — B\n- files: b.php\n- depends-on: a\n'
    );
    expect(roadmap.tasks[1]?.dependsOn).toEqual(['a']);
    expect(roadmap.tasks[1]?.notes).toBe('');
  });
});

describe('normaliseId', () => {
  it('folds the spellings of one task into one id', () => {
    expect(normaliseId('Schema')).toBe('schema');
    expect(normaliseId('`schema`')).toBe('schema');
    expect(normaliseId('  Data  Layer ')).toBe('data-layer');
  });
});

describe('availability and progression', () => {
  it('offers the first task whose dependencies are done', () => {
    expect(nextTask(parseRoadmap(ROADMAP))?.id).toBe('models');
  });

  it('never offers a task with an unfinished dependency', () => {
    const roadmap = parseRoadmap(ROADMAP);
    const index = roadmap.tasks.find((task) => task.id === 'index')!;
    const state = availability(index, roadmap);
    expect(state.available).toBe(false);
    if (!state.available) {
      expect(state.reason).toBe('blocked');
      expect(state.detail).toContain('repo');
    }
  });

  it('does not offer a task already in progress as the next one', () => {
    // Written with the same helper the workflow uses, so the fixture cannot
    // drift from what a real in-progress task looks like on disk.
    const roadmap = parseRoadmap(withStatus(ROADMAP, 'models', 'in_progress')!);
    // `nextTask` starts nothing new while a file is half-done...
    expect(nextTask(roadmap)).toBeNull();
    // ...and `activeTask` reports the begun task, so nothing is skipped.
    expect(currentTask(roadmap)?.id).toBe('models');
    expect(activeTask(roadmap)?.id).toBe('models');
  });

  it('walks the whole roadmap when each task finishes in order', () => {
    let text = ROADMAP;
    const order: string[] = [];

    // A generous bound: the walk must terminate, and a broken parser would
    // otherwise hang the suite rather than fail it.
    for (let step = 0; step < 10; step++) {
      const task = activeTask(parseRoadmap(text));
      if (!task) {
        break;
      }
      order.push(task.id);
      const next = withStatus(text, task.id, 'done');
      expect(next).not.toBeNull();
      text = next!;
    }

    expect(order).toEqual(['models', 'repo', 'index']);
    expect(isComplete(parseRoadmap(text))).toBe(true);
  });

  it('reports a task that depends on one missing from the file as never available', () => {
    const roadmap = parseRoadmap('### a — A\n- files: a.php\n- depends-on: ghost\n');
    const task = roadmap.tasks[0]!;
    const state = availability(task, roadmap);
    expect(state.available).toBe(false);
    if (!state.available) {
      expect(state.reason).toBe('unknown_dependency');
    }
    expect(nextTask(roadmap)).toBeNull();
  });

  it('is not complete until every task is done', () => {
    expect(isComplete(parseRoadmap(ROADMAP))).toBe(false);
    expect(isComplete(parseRoadmap('### a — A\n- files: a.php\n'))).toBe(false);
    expect(isComplete(parseRoadmap('### a — A\n- status: done\n- files: a.php\n'))).toBe(true);
  });
});

describe('taskOwning', () => {
  it('finds the task that owns a path, ignoring separators and a leading ./', () => {
    const roadmap = parseRoadmap(ROADMAP);
    expect(taskOwning(roadmap, 'src/Order.php')?.id).toBe('models');
    expect(taskOwning(roadmap, './index.php')?.id).toBe('index');
    expect(taskOwning(roadmap, 'src\\User.php')?.id).toBe('models');
    expect(taskOwning(roadmap, 'unrelated.php')).toBeNull();
  });
});

describe('withStatus', () => {
  it('changes only the status line of the named task', () => {
    const updated = withStatus(ROADMAP, 'models', 'done');
    expect(updated).not.toBeNull();
    expect(updated).toContain('### models — Domain models\n- status: done');
    // Every other status is untouched.
    expect(updated!.match(/- status: todo/g)).toHaveLength(2);
    expect(updated).toContain('### schema — Create the schema\n- status: done');
  });

  it('keeps the developer prose byte for byte', () => {
    const updated = withStatus(ROADMAP, 'repo', 'in_progress');
    expect(updated).toContain('Defines the tables.');
    expect(updated).toContain('One class per table.');
    expect(updated).toContain('Intro prose that is nobody\'s task.');
  });

  it('inserts a status line when the task had none', () => {
    const updated = withStatus('### a — A\n- files: a.php\n', 'a', 'in_progress');
    expect(updated).toBe('### a — A\n- status: in_progress\n- files: a.php\n');
  });

  it('preserves the indentation of an indented status line', () => {
    const updated = withStatus('### a — A\n  - status: todo\n  - files: a.php\n', 'a', 'done');
    expect(updated).toContain('  - status: done');
  });

  it('returns null for a task that is not in the file, rather than writing a lie', () => {
    expect(withStatus(ROADMAP, 'nonexistent', 'done')).toBeNull();
  });

  it('is idempotent once the status already matches', () => {
    const once = withStatus(ROADMAP, 'models', 'done');
    const twice = withStatus(once!, 'models', 'done');
    expect(twice).toBe(once);
  });

  it('round-trips through the parser', () => {
    const updated = withStatus(ROADMAP, 'models', 'done');
    const repos = withStatus(updated!, 'repo', 'in_progress');
    const roadmap = parseRoadmap(repos!);
    expect(roadmap.tasks.find((task) => task.id === 'models')?.status).toBe('done');
    expect(roadmap.tasks.find((task) => task.id === 'repo')?.status).toBe('in_progress');
    // `repo` is in progress, so `index` must still be blocked.
    expect(nextTask(roadmap)).toBeNull();
    expect(activeTask(roadmap)?.id).toBe('repo');
  });
});

describe('file shape helpers', () => {
  it('writes a status line the parser reads back', () => {
    for (const status of ROADMAP_STATUSES) {
      expect(statusLine(status)).toBe(`- status: ${status}`);
      const roadmap = parseRoadmap(`### t — T\n${statusLine(status)}\n- files: t.php\n`);
      expect(roadmap.tasks[0]?.status).toBe(status);
    }
  });

  it('writes a heading the parser reads back', () => {
    const task = { id: 'models', title: 'Domain models', status: 'todo' as const, files: ['a.php'], dependsOn: [], notes: '' };
    const roadmap = parseRoadmap(`${headingFor(task)}\n- files: a.php\n`);
    expect(roadmap.tasks[0]).toMatchObject({ id: 'models', title: 'Domain models' });
  });
});


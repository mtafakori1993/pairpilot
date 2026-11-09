/**
 * Model selection inheritance (spec section 13).
 *
 * The resolution order is Per-task → Role → Project → Global → provider default.
 * Two properties matter beyond the order itself.
 *
 * **A cleared level falls through rather than failing.** Deleting a role's model
 * must not leave the next turn with no model, and must not resurrect a stale
 * value; it must reveal the level beneath it, and the result says which level
 * answered so the UI can show where the choice came from.
 *
 * **Nothing here switches a model on its own.** Setting a selection writes a
 * preference for the *next* turn. There is no side effect on any other level,
 * and no call in this file reaches a provider.
 */

import { describe, expect, it } from 'vitest';
import {
  ModelSelectionService,
  type SelectionStorageLike,
} from '../../src/models/ModelSelectionService';

class FakeStorage implements SelectionStorageLike {
  readonly values = new Map<string, unknown>();

  get<T>(key: string, defaultValue: T): T {
    return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

function service(): { selection: ModelSelectionService; storage: FakeStorage } {
  const storage = new FakeStorage();
  const selection = new ModelSelectionService(storage);
  selection.load();
  return { selection, storage };
}

describe('resolve: inheritance', () => {
  it('reports the provider default when nothing is configured', () => {
    const { selection } = service();
    expect(selection.resolve()).toEqual({
      modelId: null,
      level: null,
      sourceLabel: 'Provider default',
      isProviderDefault: true,
    });
  });

  it('walks task → role → project → global', async () => {
    const { selection } = service();
    await selection.setGlobal('g/model');
    await selection.setProject('/repo', 'p/model');
    await selection.setRole('coding', 'r/model');
    await selection.setTask('coding', 't/model');

    const options = { taskId: 'coding', roleId: 'coding' as const, projectPath: '/repo' };
    expect(selection.resolve(options).modelId).toBe('t/model');
    expect(selection.resolve(options).level).toBe('task');

    await selection.setTask('coding', null);
    expect(selection.resolve(options).modelId).toBe('r/model');
    expect(selection.resolve(options).level).toBe('role');

    await selection.setRole('coding', null);
    expect(selection.resolve(options).modelId).toBe('p/model');
    expect(selection.resolve(options).level).toBe('project');

    await selection.setProject('/repo', null);
    expect(selection.resolve(options).modelId).toBe('g/model');
    expect(selection.resolve(options).level).toBe('global');
  });

  it('skips a level that does not apply, rather than treating it as empty', async () => {
    // No workspace open, no task in play: the global default still answers.
    const { selection } = service();
    await selection.setGlobal('g/model');
    expect(selection.resolve({ roleId: 'coding' }).modelId).toBe('g/model');
    expect(selection.resolve({}).modelId).toBe('g/model');
  });

  it('does not use a project entry for a different folder', async () => {
    const { selection } = service();
    await selection.setProject('/repo-a', 'a/model');
    const resolved = selection.resolve({ projectPath: '/repo-b' });
    expect(resolved.modelId).toBeNull();
    expect(resolved.isProviderDefault).toBe(true);
  });

  it('does not use one role\'s model for another', async () => {
    const { selection } = service();
    await selection.setRole('coding', 'c/model');
    expect(selection.resolve({ roleId: 'documentation' }).modelId).toBeNull();
    expect(selection.resolve({ roleId: 'coding' }).modelId).toBe('c/model');
  });

  it('labels where the choice came from, for every level', async () => {
    const { selection } = service();
    await selection.setGlobal('g/model');
    expect(selection.resolve().sourceLabel).toBe('Global default');

    await selection.setProject('/repo', 'p/model');
    expect(selection.resolve({ projectPath: '/repo' }).sourceLabel).toBe('Project');

    // Roles are labelled in prose for display, not by their raw id.
    await selection.setRole('code-review', 'r/model');
    expect(selection.resolve({ roleId: 'code-review' }).sourceLabel).toBe('Role: Code Review');

    await selection.setTask('coding', 't/model');
    expect(selection.resolve({ taskId: 'coding' }).sourceLabel).toBe('Task: coding');
  });

  it('never reports isProviderDefault when a level answered', async () => {
    const { selection } = service();
    await selection.setGlobal('g/model');
    expect(selection.resolve().isProviderDefault).toBe(false);
  });
});

describe('writes', () => {
  it('sets one level without touching the others', async () => {
    const { selection } = service();
    await selection.setGlobal('g/model');
    await selection.setRole('coding', 'r/model');

    const snapshot = selection.snapshot();
    expect(snapshot.global).toBe('g/model');
    expect(snapshot.roles['coding']).toBe('r/model');
    expect(snapshot.projects).toEqual({});
    expect(snapshot.tasks).toEqual({});
  });

  it('persists across a reload', async () => {
    const { selection, storage } = service();
    await selection.setGlobal('g/model');
    await selection.setProject('/repo', 'p/model');
    await selection.setRole('coding', 'r/model');
    await selection.setTask('coding', 't/model');

    const reloaded = new ModelSelectionService(storage);
    reloaded.load();
    expect(reloaded.snapshot()).toMatchObject({
      global: 'g/model',
      projects: { '/repo': 'p/model' },
      roles: { coding: 'r/model' },
      tasks: { coding: 't/model' },
    });
  });

  it('forgets every reference to a model that left the catalogue', async () => {
    // A dangling id would fail at the provider long after the catalogue changed,
    // which is far harder to trace back to its cause.
    const { selection } = service();
    await selection.setGlobal('gone/model');
    await selection.setProject('/repo', 'gone/model');
    await selection.setRole('coding', 'gone/model');
    await selection.setTask('coding', 'gone/model');
    await selection.setRole('documentation', 'kept/model');

    const removed = await selection.forgetModel('gone/model');

    expect(removed).toBe(4);
    expect(selection.snapshot()).toMatchObject({
      global: null,
      projects: {},
      roles: { documentation: 'kept/model' },
      tasks: {},
    });
    expect(selection.resolve({ roleId: 'documentation' }).modelId).toBe('kept/model');
  });

  it('reports nothing removed when the model was not referenced', async () => {
    const { selection } = service();
    await selection.setGlobal('kept/model');
    expect(await selection.forgetModel('other/model')).toBe(0);
    expect(selection.snapshot().global).toBe('kept/model');
  });

  it('lists every referenced id, without duplicates', async () => {
    const { selection } = service();
    await selection.setGlobal('shared/model');
    await selection.setProject('/repo', 'shared/model');
    await selection.setRole('coding', 'other/model');
    expect(new Set(selection.referencedModelIds())).toEqual(
      new Set(['shared/model', 'other/model'])
    );
  });
});

describe('snapshot and rolesWithConsumers', () => {
  it('reports which roles a workflow actually reads', () => {
    const { selection } = service();
    const snapshot = selection.snapshot();
    // PairPilot has no Planning or Coding Studio screens: only the roles a
    // workflow consumes are listed, and the UI says so rather than implying a
    // screen exists.
    expect(Array.isArray(snapshot.rolesWithConsumers)).toBe(true);
    for (const roleId of snapshot.rolesWithConsumers) {
      expect(typeof roleId).toBe('string');
    }
  });

  it('returns copies, so a caller cannot mutate the service by accident', async () => {
    const { selection } = service();
    await selection.setRole('coding', 'r/model');
    const snapshot = selection.snapshot();
    snapshot.roles['coding'] = 'mutated';
    expect(selection.snapshot().roles['coding']).toBe('r/model');
  });
});

describe('selectionAt', () => {
  it('reads one level directly', async () => {
    const { selection } = service();
    await selection.setRole('coding', 'r/model');
    expect(selection.selectionAt('role', 'coding')).toMatchObject({
      modelId: 'r/model',
      level: 'role',
      key: 'coding',
    });
  });

  it('returns null for a level that holds nothing', async () => {
    const { selection } = service();
    expect(selection.selectionAt('global')).toBeNull();
    expect(selection.selectionAt('project', '/repo')).toBeNull();
    expect(selection.selectionAt('role', 'coding')).toBeNull();
  });
});

describe('load: untrusted storage', () => {
  it('ignores state that is not the right shape', () => {
    const storage = new FakeStorage();
    storage.values.set('pairpilot.models.selection.v1', 'nonsense');
    const selection = new ModelSelectionService(storage);
    selection.load();
    expect(selection.resolve().isProviderDefault).toBe(true);
  });

  it('ignores a role map whose values are not strings', () => {
    const storage = new FakeStorage();
    storage.values.set('pairpilot.models.selection.v1', {
      global: 42,
      roles: { coding: 7 },
      projects: 'nope',
      tasks: null,
    });
    const selection = new ModelSelectionService(storage);
    selection.load();
    expect(selection.snapshot()).toEqual({
      global: null,
      projects: {},
      roles: {},
      tasks: {},
      rolesWithConsumers: selection.snapshot().rolesWithConsumers,
    });
  });
});

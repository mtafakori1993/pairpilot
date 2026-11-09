/**
 * Catalogue caching and refresh policy (spec section 10).
 *
 * The behaviour worth pinning down is what happens when a refresh *fails*. The
 * tempting implementation replaces the catalogue with whatever came back, or
 * with nothing; either would leave the Explorer empty and the Model Advisor with
 * no candidates, long after a transient network blip. So the tests below check
 * that a failure keeps the models already held and marks them stale, and that an
 * empty or unreadable response is treated as a failure rather than as a
 * catalogue of zero models.
 */

import { describe, expect, it } from 'vitest';
import { ModelRegistry, type CatalogStorageLike } from '../../src/models/ModelRegistry';
import type { ModelCatalog } from '../../src/types/model';

/** An in-memory `vscode.Memento`. */
class FakeStorage implements CatalogStorageLike {
  readonly values = new Map<string, unknown>();
  writes = 0;

  get<T>(key: string, defaultValue: T): T {
    return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.writes += 1;
    this.values.set(key, value);
  }
}

function entry(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id,
    context_length: 100_000,
    pricing: { prompt: '0.000001', completion: '0.000002' },
    supported_parameters: ['tools'],
    ...overrides,
  };
}

function registry(
  options: {
    storage?: FakeStorage;
    fetchModels?: () => Promise<unknown[]>;
    now?: () => number;
    capacity?: number;
    recentLimit?: number;
    logger?: { warn(message: string): void };
  } = {}
): { registry: ModelRegistry; storage: FakeStorage; warnings: string[] } {
  const storage = options.storage ?? new FakeStorage();
  const warnings: string[] = [];
  const instance = new ModelRegistry({
    storage,
    fetchModels: options.fetchModels ?? (async () => [entry('a/one'), entry('b/two')]),
    now: options.now,
    recentLimit: options.recentLimit,
    logger: options.logger ?? { warn: (message) => warnings.push(message) },
  });
  return { registry: instance, storage, warnings };
}

describe('refresh', () => {
  it('normalises, stores and reports the count', async () => {
    const { registry: models, storage } = registry();
    const result = await models.refresh();

    expect(result).toEqual({ ok: true, error: null, count: 2 });
    expect(models.count()).toBe(2);
    expect(models.get('a/one')?.name).toBe('a/one');
    expect(storage.values.has('pairpilot.models.catalog.v1')).toBe(true);
  });

  it('skips a malformed entry without losing the rest of the batch', async () => {
    const { registry: models, warnings } = registry({
      fetchModels: async () => [entry('a/one'), { name: 'no id' }, 'nonsense', entry('b/two')],
    });

    const result = await models.refresh();

    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(models.count()).toBe(2);
    expect(warnings).toEqual([]);
  });

  it('treats an empty list as a failure rather than wiping the catalogue', async () => {
    const now = 1_000_000;
    const { registry: models } = registry({ now: () => now });
    await models.refresh();
    expect(models.count()).toBe(2);

    const empty = registry({ now: () => now, fetchModels: async () => [] });
    const result = await empty.registry.refresh();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('empty model list');
    expect(empty.registry.count()).toBe(0);
  });

  it('keeps the previous catalogue and marks it stale when a refresh fails', async () => {
    const storage = new FakeStorage();
    const { registry: models } = registry({ storage });
    await models.refresh();
    expect(models.getCatalog()?.stale).toBe(false);

    const failing = new ModelRegistry({
      storage,
      fetchModels: async () => {
        throw new Error('socket hang up');
      },
    });
    failing.load();
    expect(failing.count()).toBe(2);

    const result = await failing.refresh();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('socket hang up');
    // The models the developer already had are still there, and the failure is
    // recorded on the catalogue so the UI can say it is out of date.
    expect(failing.count()).toBe(2);
    expect(failing.getCatalog()?.stale).toBe(true);
    expect(failing.getCatalog()?.refreshError).toContain('socket hang up');
  });

  it('reports a second concurrent refresh rather than running two', async () => {
    // Held in an object rather than a `let`: TypeScript narrows a top-level
    // `let` by its initializer and cannot see the assignment made inside the
    // promise executor, so `release?.()` would be flagged as calling `null`.
    const gate: { release: (() => void) | null } = { release: null };
    const opened = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const { registry: models } = registry({
      fetchModels: async () => {
        await opened;
        return [entry('a/one')];
      },
    });

    const first = models.refresh();
    const second = await models.refresh();

    expect(second.ok).toBe(false);
    expect(second.error).toContain('already running');
    expect(models.isRefreshing).toBe(true);

    gate.release?.();
    expect((await first).ok).toBe(true);
    expect(models.isRefreshing).toBe(false);
  });

  it('bounds how many models it will store', async () => {
    const many = Array.from({ length: 2_500 }, (_, index) => entry(`v/m${index}`));
    const { registry: models } = registry({ fetchModels: async () => many });
    const result = await models.refresh();
    expect(result.count).toBe(2_000);
  });
});

describe('isRefreshDue', () => {
  it('is due when nothing has been fetched', () => {
    expect(registry().registry.isRefreshDue(12)).toBe(true);
  });

  it('is not due while the cache is fresh', async () => {
    let now = 1_000_000;
    const { registry: models } = registry({ now: () => now });
    await models.refresh();

    expect(models.isRefreshDue(12)).toBe(false);
    now += 11 * 3_600_000;
    expect(models.isRefreshDue(12)).toBe(false);
    now += 2 * 3_600_000;
    expect(models.isRefreshDue(12)).toBe(true);
  });

  it('never refreshes automatically when the interval is zero', async () => {
    // "Every zero hours" would mean continuously; the intended reading of 0 is
    // "only when I ask".
    const { registry: models } = registry();
    expect(models.isRefreshDue(0)).toBe(false);
    await models.refresh();
    expect(models.isRefreshDue(0)).toBe(false);
  });
});

describe('favorites', () => {
  it('toggles and persists across a reload', async () => {
    const storage = new FakeStorage();
    const { registry: models } = registry({ storage });
    await models.refresh();

    expect(await models.toggleFavorite('a/one')).toBe(true);
    expect(models.isFavorite('a/one')).toBe(true);
    expect(await models.toggleFavorite('a/one')).toBe(false);
    expect(models.isFavorite('a/one')).toBe(false);

    await models.toggleFavorite('b/two');
    const reloaded = new ModelRegistry({
      storage,
      fetchModels: async () => [],
    });
    reloaded.load();
    expect(reloaded.isFavorite('b/two')).toBe(true);
    expect(reloaded.favoritesList().map((m) => m.id)).toEqual(['b/two']);
  });

  it('returns favourites in catalogue order', async () => {
    const { registry: models } = registry();
    await models.refresh();
    await models.toggleFavorite('b/two');
    await models.toggleFavorite('a/one');
    expect(models.favoritesList().map((m) => m.id)).toEqual(['a/one', 'b/two']);
  });

  it('keeps the star when its model leaves the catalogue, without inventing a row', async () => {
    // The star survives so a returning model is still starred, but there is no
    // model to render, so `favoritesList` must not produce a placeholder.
    const { registry: models } = registry();
    await models.refresh();
    await models.toggleFavorite('a/one');
    expect(models.favoritesList()).toHaveLength(1);

    const replaced = registry({ fetchModels: async () => [entry('b/two')] });
    expect(replaced.registry.favoritesList()).toEqual([]);
    expect(replaced.registry.favoritesSet().has('a/one')).toBe(false);
  });
});

describe('recently used', () => {
  it('keeps most-recent-first and moves a repeat to the front', async () => {
    const { registry: models } = registry();
    await models.refresh();

    await models.markUsed('a/one');
    await models.markUsed('b/two');
    await models.markUsed('a/one');

    expect(models.recentIds()).toEqual(['a/one', 'b/two']);
  });

  it('bounds the list and persists it', async () => {
    const storage = new FakeStorage();
    const { registry: models } = registry({ storage, recentLimit: 2 });
    await models.refresh();

    await models.markUsed('a/one');
    await models.markUsed('b/two');
    await models.markUsed('c/three');

    expect(models.recentIds()).toEqual(['c/three', 'b/two']);

    const reloaded = new ModelRegistry({ storage, fetchModels: async () => [], recentLimit: 2 });
    reloaded.load();
    expect(reloaded.recentIds()).toEqual(['c/three', 'b/two']);
  });
});

describe('load', () => {
  it('restores a stored catalogue without touching the network', () => {
    const storage = new FakeStorage();
    let fetched = 0;
    const catalog: ModelCatalog = {
      providerId: 'openrouter',
      fetchedAt: 1,
      stale: false,
      refreshError: null,
      models: [
        {
          id: 'a/one',
          canonicalSlug: null,
          name: 'One',
          developer: 'a',
          description: null,
          contextLength: 1_000,
          maxOutputTokens: null,
          created: null,
          pricing: {
            promptPerToken: 0.000001,
            completionPerToken: null,
            cacheReadPerToken: null,
            cacheWritePerToken: null,
            requestUsd: null,
            imageUsd: null,
            isFree: false,
          },
          capabilities: {
            inputModalities: [],
            outputModalities: [],
            toolCalling: false,
            structuredOutput: false,
            reasoning: false,
            supportedParameters: [],
          },
          unknownFields: [],
          capturedAt: 1,
        },
      ],
    };
    storage.values.set('pairpilot.models.catalog.v1', catalog);

    const models = new ModelRegistry({
      storage,
      fetchModels: async () => {
        fetched += 1;
        return [];
      },
    });
    models.load();

    expect(models.count()).toBe(1);
    expect(fetched).toBe(0);
  });

  it('ignores a stored catalogue that is not the right shape', () => {
    const storage = new FakeStorage();
    storage.values.set('pairpilot.models.catalog.v1', { nonsense: true });
    const models = new ModelRegistry({ storage, fetchModels: async () => [] });
    models.load();
    expect(models.getCatalog()).toBeNull();
    expect(models.list()).toEqual([]);
  });

  it('ignores a stored catalogue whose entries are not models', () => {
    const storage = new FakeStorage();
    storage.values.set('pairpilot.models.catalog.v1', {
      providerId: 'openrouter',
      fetchedAt: 1,
      stale: false,
      refreshError: null,
      models: [{ id: 42 }],
    });
    const models = new ModelRegistry({ storage, fetchModels: async () => [] });
    models.load();
    expect(models.getCatalog()).toBeNull();
  });
});

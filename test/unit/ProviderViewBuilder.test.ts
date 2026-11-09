/**
 * Provider, Model Explorer and Model Details snapshots (spec sections 6, 10, 11, 12b, 13).
 *
 * This builder is where every figure on the screen is formatted, so it is where
 * the "never render an unknown as a number" rule is actually enforced. The tests
 * that matter most are the ones a developer would notice as a lie:
 *
 *   - an unpriced model showing "Not provided" on both price columns, and `—`
 *     for an unknown context window, rather than `$0.00` or `0`;
 *   - a page that reports how many models it is *not* showing, so a filtered
 *     list cannot look as though the rest were lost;
 *   - a provider card whose only key-derived field is a mask.
 */

import { describe, expect, it } from 'vitest';
import {
  MODEL_PAGE_SIZE,
  ProviderViewBuilder,
  type OpenRouterLiveState,
  type ProviderDescriptor,
  type ProviderViewBuilderDeps,
} from '../../src/ui/ProviderViewBuilder';
import { ModelRegistry, type CatalogStorageLike } from '../../src/models/ModelRegistry';
import { ModelSelectionService, type SelectionStorageLike } from '../../src/models/ModelSelectionService';
import { ModelAdvisor } from '../../src/models/ModelAdvisor';
import { defaultModelQuery } from '../../src/models/ModelSearch';
import { emptyPricing, type ModelMetadata } from '../../src/types/model';
import type { AIProviderStatus, ProviderId } from '../../src/types/provider';
import type { ModelTaskId } from '../../src/types/providerConfig';

class FakeStorage implements CatalogStorageLike, SelectionStorageLike {
  readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

const NOW = new Date(2026, 4, 10, 12, 0, 0).getTime();

function model(id: string, overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    id,
    canonicalSlug: null,
    name: id,
    developer: id.split('/')[0] ?? null,
    description: 'A model.',
    contextLength: 200_000,
    maxOutputTokens: 32_000,
    created: 1_750_000_000,
    pricing: { ...emptyPricing(), promptPerToken: 0.000003, completionPerToken: 0.000015 },
    capabilities: {
      inputModalities: ['text'],
      outputModalities: ['text'],
      toolCalling: true,
      structuredOutput: true,
      reasoning: false,
      supportedParameters: ['tools'],
    },
    unknownFields: [],
    capturedAt: NOW,
    ...overrides,
  };
}

const DESCRIPTORS: ProviderDescriptor[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    description: 'The locally installed CLI.',
    baseUrl: '',
    enabled: true,
    selectable: true,
    runtimeAvailable: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'Any model OpenRouter serves.',
    baseUrl: 'https://openrouter.ai/api/v1',
    enabled: true,
    selectable: true,
    runtimeAvailable: true,
  },
];

function openRouterState(overrides: Partial<OpenRouterLiveState> = {}): OpenRouterLiveState {
  return {
    authState: 'valid',
    connectionState: 'connected',
    authenticated: true,
    account: null,
    lastConnectedAt: NOW - 60_000,
    lastConnectionError: null,
    busy: false,
    ...overrides,
  };
}

interface HarnessOptions {
  models?: ModelMetadata[];
  favorites?: string[];
  selectedRole?: { role: ModelTaskId; modelId: string };
  selectedGlobal?: string;
  selectedProject?: { path: string; modelId: string };
  catalogError?: string | null;
  keySummary?: { present: boolean; masked: string | null; prefixWarning: string | null };
  openRouter?: OpenRouterLiveState | null;
  statuses?: Partial<Record<ProviderId, AIProviderStatus | null>>;
  projectPath?: string | null;
}

async function harness(options: HarnessOptions = {}) {
  const storage = new FakeStorage();
  const catalog = new ModelRegistry({
    storage,
    now: () => NOW,
    fetchModels: async () => [],
  });
  await catalog.refresh();

  const catalogStorage = new FakeStorage();
  const registry = new ModelRegistry({
    storage: catalogStorage,
    now: () => NOW,
    fetchModels: async () => [],
  });
  // Seed the catalogue directly, so the tests do not have to go through the
  // normaliser to get exactly the models they assert on.
  catalogStorage.values.set('pairpilot.models.catalog.v1', {
    providerId: 'openrouter',
    fetchedAt: NOW,
    stale: false,
    refreshError: null,
    models: options.models ?? [model('vendor/one'), model('vendor/two')],
  });
  registry.load();
  for (const id of options.favorites ?? []) {
    await registry.toggleFavorite(id);
  }

  const selectionStorage = new FakeStorage();
  const selection = new ModelSelectionService(selectionStorage);
  selection.load();
  if (options.selectedGlobal !== undefined) {
    await selection.setGlobal(options.selectedGlobal);
  }
  if (options.selectedRole !== undefined) {
    await selection.setRole(options.selectedRole.role, options.selectedRole.modelId);
  }
  if (options.selectedProject !== undefined) {
    await selection.setProject(options.selectedProject.path, options.selectedProject.modelId);
  }

  const deps: ProviderViewBuilderDeps = {
    descriptors: () => DESCRIPTORS,
    statusOf: (id) =>
      options.statuses && id in options.statuses
        ? (options.statuses[id] ?? null)
        : {
            id,
            label: id,
            available: true,
            message: 'Ready.',
          },
    openRouterState: () =>
      options.openRouter === undefined ? openRouterState() : options.openRouter,
    keySummary: () =>
      options.keySummary ?? { present: true, masked: 'sk-or-…cdef', prefixWarning: null },
    activeProviderId: () => 'claude-code',
    catalog: registry,
    selection,
    advisor: new ModelAdvisor({ list: () => registry.list() }),
    catalogError: () => options.catalogError ?? null,
    projectPath: () => options.projectPath ?? null,
    now: () => NOW,
  };

  return { builder: new ProviderViewBuilder(deps), registry, selection };
}

function state(overrides: Partial<Parameters<ProviderViewBuilder['build']>[0]> = {}) {
  return {
    query: defaultModelQuery(),
    offset: 0,
    detailsModelId: null,
    adviceTaskId: null,
    notice: null,
    ...overrides,
  };
}

describe('provider cards', () => {
  it('reports both providers, with the active one marked', async () => {
    const { builder } = await harness();
    const snapshot = builder.build(state());

    expect(snapshot.providers.map((entry) => entry.id)).toEqual(['claude-code', 'openrouter']);
    expect(snapshot.activeProviderId).toBe('claude-code');
    expect(snapshot.providers.filter((entry) => entry.isActive)).toHaveLength(1);
  });

  it('exposes no key-derived field other than the mask', async () => {
    // The only thing about a key that may reach a Webview is `maskedKey`, and it
    // comes from `SecretManager.summary()`, which cannot contain a usable key.
    const { builder } = await harness();
    const openrouter = builder.build(state()).providers.find((entry) => entry.id === 'openrouter');

    const serialised = JSON.stringify(openrouter);
    expect(serialised).toContain('sk-or-…cdef');
    expect(serialised).not.toContain('sk-or-v1-');
    // No field name anywhere suggests a raw key.
    expect(Object.keys(openrouter ?? {})).not.toContain('apiKey');
    expect(Object.keys(openrouter ?? {})).not.toContain('key');
  });

  it('reports a missing key as a setup state, not as an error', async () => {
    const { builder } = await harness({
      keySummary: { present: false, masked: null, prefixWarning: null },
      openRouter: openRouterState({
        authState: 'unconfigured',
        connectionState: 'unknown',
        authenticated: null,
      }),
    });

    const openrouter = builder.build(state()).providers.find((entry) => entry.id === 'openrouter');
    expect(openrouter?.authState).toBe('unconfigured');
    expect(openrouter?.maskedKey).toBeNull();
    expect(openrouter?.controls.apiKey).toBe(true);
  });

  it('offers key and catalogue controls only for the remote provider', async () => {
    const { builder } = await harness();
    const [local, remote] = builder.build(state()).providers;

    // There is no key to manage for a CLI, and offering the button would imply
    // there were one.
    expect(local?.controls).toEqual({ apiKey: false, catalog: false, disable: false });
    expect(remote?.controls).toEqual({ apiKey: true, catalog: true, disable: true });
  });

  it('survives an unregistered provider without inventing availability', async () => {
    const { builder } = await harness({
      statuses: { openrouter: null },
      openRouter: null,
      keySummary: { present: false, masked: null, prefixWarning: null },
    });

    const openrouter = builder.build(state()).providers.find((entry) => entry.id === 'openrouter');
    expect(openrouter).toBeDefined();
    // No status means "not available", never "probably fine".
    expect(openrouter?.available).toBe(false);
    expect(openrouter?.statusMessage).toContain('not registered');
    // With no live state the card falls back to what is known locally: there is
    // no key, so there is nothing to authenticate with.
    expect(openrouter?.authState).toBe('unconfigured');
    expect(openrouter?.connectionState).toBe('unknown');
    expect(openrouter?.busy).toBe(false);
  });

  it('derives the auth state from the stored key when no live state has arrived', async () => {
    const { builder } = await harness({ openRouter: null });
    const openrouter = builder.build(state()).providers.find((entry) => entry.id === 'openrouter');
    // A key is stored and nothing has contradicted it yet, so the card says
    // "stored" rather than claiming a connection it has not tested.
    expect(openrouter?.authState).toBe('stored');
    expect(openrouter?.connectionState).toBe('unknown');
  });

  it('names the catalogue size on the provider that has one', async () => {
    const { builder } = await harness();
    const [local, remote] = builder.build(state()).providers;

    expect(remote?.catalogModelCountLabel).toBe('2 models');
    // A CLI has no catalogue, so there is no figure to show for one.
    expect(local?.catalogModelCountLabel).toBeNull();
  });
});

describe('the account figures', () => {
  const account = {
    keyLabelMasked: 'sk-or-…cdef',
    usageUsd: 3.75,
    limitUsd: 10,
    limitRemainingUsd: 6.25,
    limitReset: 'monthly',
    isFreeTier: false,
    fetchedAt: NOW - 240_000,
  };

  it('is absent until the provider reports account figures', async () => {
    const { builder } = await harness({ openRouter: openRouterState({ account: null }) });
    const openrouter = builder.build(state()).providers.find((entry) => entry.id === 'openrouter');
    expect(openrouter?.account).toBeNull();
  });

  it('formats every figure, so the panel never turns a number into money', async () => {
    const { builder } = await harness({ openRouter: openRouterState({ account }) });
    const view = builder.build(state()).providers.find((entry) => entry.id === 'openrouter')?.account;

    expect(view?.keyLabel).toBe('sk-or-…cdef');
    expect(view?.usageLabel).toBe('$3.75');
    expect(view?.limitLabel).toBe('$10.00');
    expect(view?.limitRemainingLabel).toBe('$6.25');
    expect(view?.limitReset).toBe('monthly');
    expect(view?.planLabel).toBe('Paid tier');
    expect(view?.fetchedAtLabel).toBe('4 minutes ago');
  });

  it('says an unreported usage figure is unavailable rather than $0.00', async () => {
    // The failure this guards: a key nobody has measured reads as a key that has
    // spent nothing.
    const { builder } = await harness({
      openRouter: openRouterState({ account: { ...account, usageUsd: null } }),
    });
    const view = builder.build(state()).providers.find((entry) => entry.id === 'openrouter')?.account;
    expect(view?.usageLabel).toBe('Unavailable');
  });

  it('omits the limit lines for a key that has no limit, rather than calling them unavailable', async () => {
    // No limit is the normal case. "Limit: Unavailable" would describe a key
    // without a cap as a fact nobody knows.
    const { builder } = await harness({
      openRouter: openRouterState({
        account: { ...account, limitUsd: null, limitRemainingUsd: null },
      }),
    });
    const view = builder.build(state()).providers.find((entry) => entry.id === 'openrouter')?.account;

    expect(view?.limitLabel).toBeNull();
    expect(view?.limitRemainingLabel).toBeNull();
    // The usage figure is unaffected: it was reported.
    expect(view?.usageLabel).toBe('$3.75');
  });

  it('reports a free-tier key as such, and unknown when the provider is silent', async () => {
    const free = await harness({
      openRouter: openRouterState({ account: { ...account, isFreeTier: true } }),
    });
    expect(
      free.builder.build(state()).providers.find((entry) => entry.id === 'openrouter')?.account
        ?.planLabel
    ).toBe('Free tier');

    const silent = await harness({
      openRouter: openRouterState({ account: { ...account, isFreeTier: null } }),
    });
    expect(
      silent.builder.build(state()).providers.find((entry) => entry.id === 'openrouter')?.account
        ?.planLabel
    ).toBeNull();
  });
});

describe('catalogue summary', () => {
  it('reports the count, the age and any error', async () => {
    const { builder } = await harness({ catalogError: 'socket hang up' });
    const summary = builder.build(state()).catalog;

    expect(summary.count).toBe(2);
    // Formatted here, because the panel performs no arithmetic and no
    // formatting: it is given the string and places it.
    expect(summary.countLabel).toBe('2');
    expect(summary.fetchedAt).toBe(NOW);
    expect(summary.error).toBe('socket hang up');
    expect(summary.ageLabel.length).toBeGreaterThan(0);
  });

  it('groups thousands in the count, so a large catalogue stays readable', async () => {
    const many = Array.from({ length: 1_200 }, (_, index) => model(`v/m${index}`));
    const { builder } = await harness({ models: many });
    expect(builder.build(state()).catalog.countLabel).toBe('1,200');
  });

  it('reports an empty catalogue as its own state', async () => {
    const { builder } = await harness({ models: [] });
    const summary = builder.build(state()).catalog;
    expect(summary.count).toBe(0);
    expect(summary.state).toBeTruthy();
  });
});

describe('the model table', () => {
  it('formats an unpriced model as absent, not as free', async () => {
    // The single most misleading thing this view could do is show `$0.00` for a
    // model whose price nobody published.
    const { builder } = await harness({
      models: [model('vendor/unpriced', { pricing: emptyPricing(), contextLength: null, maxOutputTokens: null })],
    });

    const row = builder.build(state()).models[0];
    expect(row?.inputPriceLabel).toBe('Not provided');
    expect(row?.outputPriceLabel).toBe('Not provided');
    expect(row?.contextLabel).toBe('—');
    expect(row?.maxOutputLabel).toBe('—');
    expect(row?.isFree).toBe(false);
  });

  it('formats a genuinely free model as free', async () => {
    const { builder } = await harness({
      models: [
        model('vendor/free', {
          pricing: { ...emptyPricing(), promptPerToken: 0, completionPerToken: 0, isFree: true },
        }),
      ],
    });
    expect(builder.build(state()).models[0]?.inputPriceLabel).toBe('Free');
  });

  it('converts per-token prices to per-million for display', async () => {
    // Per-million is the convention developers read; the conversion happens
    // here and nowhere else in the display path.
    const { builder } = await harness({
      models: [model('vendor/one', { pricing: { ...emptyPricing(), promptPerToken: 0.000003 } })],
    });
    expect(builder.build(state()).models[0]?.inputPriceLabel).toBe('$3.00/M');
  });

  it('marks favourites and selected models', async () => {
    const { builder } = await harness({
      models: [model('vendor/one'), model('vendor/two')],
      favorites: ['vendor/one'],
      selectedRole: { role: 'coding', modelId: 'vendor/two' },
    });

    const rows = builder.build(state()).models;
    expect(rows.find((row) => row.id === 'vendor/one')?.isFavorite).toBe(true);
    expect(rows.find((row) => row.id === 'vendor/two')?.isSelected).toBe(true);
    expect(rows.find((row) => row.id === 'vendor/one')?.isSelected).toBe(false);
  });

  it('shows only declared capabilities as chips', async () => {
    const { builder } = await harness({
      models: [
        model('vendor/full', {
          capabilities: {
            inputModalities: ['text', 'image', 'audio'],
            outputModalities: ['text'],
            toolCalling: true,
            structuredOutput: true,
            reasoning: true,
            supportedParameters: [],
          },
        }),
        model('vendor/plain', {
          capabilities: {
            inputModalities: ['text'],
            outputModalities: ['text'],
            toolCalling: false,
            structuredOutput: false,
            reasoning: false,
            supportedParameters: [],
          },
        }),
      ],
    });

    const rows = builder.build(state()).models;
    expect(rows.find((row) => row.id === 'vendor/full')?.capabilityChips).toEqual([
      'Tools',
      'Structured output',
      'Reasoning',
      'Vision',
      'Audio',
    ]);
    // An absent chip means "not declared", which is why the details view spells
    // the flags out in full.
    expect(rows.find((row) => row.id === 'vendor/plain')?.capabilityChips).toEqual([]);
  });
});

describe('paging', () => {
  function many(count: number): ModelMetadata[] {
    return Array.from({ length: count }, (_, index) =>
      model(`vendor/m${String(index).padStart(3, '0')}`)
    );
  }

  it('serves one page and reports the rest', async () => {
    const total = MODEL_PAGE_SIZE + 25;
    const { builder } = await harness({ models: many(total) });
    const snapshot = builder.build(state());

    expect(snapshot.models).toHaveLength(MODEL_PAGE_SIZE);
    expect(snapshot.totalModels).toBe(total);
    expect(snapshot.matchingModels).toBe(total);
    expect(snapshot.page.hasMore).toBe(true);
    expect(snapshot.page.firstOrdinal).toBe(1);
    expect(snapshot.page.lastOrdinal).toBe(MODEL_PAGE_SIZE);
  });

  it('serves the next page and then stops', async () => {
    const { builder } = await harness({ models: many(MODEL_PAGE_SIZE + 1) });
    const second = builder.build(state({ offset: MODEL_PAGE_SIZE }));

    expect(second.models).toHaveLength(1);
    expect(second.page.hasMore).toBe(false);
    expect(second.page.firstOrdinal).toBe(MODEL_PAGE_SIZE + 1);
  });

  it('falls back to the first page when the list shrinks under it', async () => {
    // Usually a filter change: an offset past the end would render an empty
    // table with no way back.
    const { builder } = await harness({ models: many(3) });
    const snapshot = builder.build(state({ offset: 900 }));

    expect(snapshot.page.offset).toBe(0);
    expect(snapshot.models).toHaveLength(3);
  });

  it('reports an empty page as ordinals 0, so the count reads sensibly', async () => {
    const { builder } = await harness({ models: [] });
    const snapshot = builder.build(state());
    expect(snapshot.page.firstOrdinal).toBe(0);
    expect(snapshot.page.lastOrdinal).toBe(0);
    expect(snapshot.page.hasMore).toBe(false);
  });
});

describe('filters and sorts', () => {
  it('offers every filter with its published rule, and marks the active ones', async () => {
    const { builder } = await harness();
    const snapshot = builder.build(state({ query: { ...defaultModelQuery(), quickFilters: ['vision'] } }));

    const vision = snapshot.filters.find((entry) => entry.id === 'vision');
    expect(vision?.active).toBe(true);
    expect(vision?.label).toBe('Vision');
    // The rule is shown next to the control, so the developer can see what it
    // actually selects rather than trusting the label.
    expect(vision?.rule).toContain('image');
    expect(snapshot.filters.filter((entry) => entry.active)).toHaveLength(1);
  });

  it('offers no speed filter', async () => {
    const { builder } = await harness();
    const ids = builder.build(state()).filters.map((entry) => entry.id);
    expect(ids).not.toContain('fast');
    expect(ids).toContain('large-context');
    expect(ids).toContain('tool-calling');
  });

  it('offers every sort key with a readable label', async () => {
    const { builder } = await harness();
    const sorts = builder.build(state()).sorts;
    expect(sorts.map((entry) => entry.id)).toEqual([
      'name',
      'input-cost',
      'output-cost',
      'context',
      'provider',
      'newest',
    ]);
    for (const entry of sorts) {
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it('narrows the rows and reports how many matched', async () => {
    const { builder } = await harness({
      models: [model('vendor/one'), model('vendor/two')],
    });
    const snapshot = builder.build(state({ query: { ...defaultModelQuery(), search: 'two' } }));
    expect(snapshot.models.map((row) => row.id)).toEqual(['vendor/two']);
    // The count is of matches, not of the catalogue.
    expect(snapshot.matchingModels).toBe(1);
    expect(snapshot.totalModels).toBe(2);
  });
});

describe('favourites and recently used', () => {
  it('lists favourites in catalogue order and recently used most-recent-first', async () => {
    const { builder, registry } = await harness({
      models: [model('vendor/one'), model('vendor/two'), model('vendor/three')],
      favorites: ['vendor/three'],
    });
    await registry.markUsed('vendor/two');
    await registry.markUsed('vendor/one');

    const snapshot = builder.build(state());
    expect(snapshot.favorites.map((row) => row.id)).toEqual(['vendor/three']);
    expect(snapshot.recent.map((row) => row.id)).toEqual(['vendor/one', 'vendor/two']);
  });

  it('drops a recent id whose model left the catalogue', async () => {
    // There is nothing to show for it, and a placeholder row would be a fiction.
    const { builder, registry } = await harness({ models: [model('vendor/one')] });
    await registry.markUsed('vendor/gone');
    await registry.markUsed('vendor/one');
    expect(builder.build(state()).recent.map((row) => row.id)).toEqual(['vendor/one']);
  });
});

describe('model details', () => {
  it('is absent until a model is chosen', async () => {
    const { builder } = await harness();
    expect(builder.build(state()).details).toBeNull();
  });

  it('carries every price the catalogue published, per million', async () => {
    const { builder } = await harness({
      models: [
        model('vendor/one', {
          pricing: {
            promptPerToken: 0.000003,
            completionPerToken: 0.000015,
            cacheReadPerToken: 0.0000003,
            cacheWritePerToken: 0.00000375,
            requestUsd: null,
            imageUsd: null,
            isFree: false,
          },
        }),
      ],
    });

    const details = builder.build(state({ detailsModelId: 'vendor/one' })).details;
    const prices = Object.fromEntries(
      (details?.pricingRows ?? []).map((row) => [row.label, row.value])
    );

    expect(prices['Input']).toBe('$3.00/M');
    expect(prices['Output']).toBe('$15.00/M');
    expect(prices['Cached input (read)']).toBe('$0.300/M');
    expect(prices['Cache write']).toBe('$3.75/M');
    // A price the catalogue did not publish is stated as absent.
    expect(prices['Per request']).toBe('Not provided');
    expect(prices['Per input image']).toBe('Not provided');
  });

  it('names the catalogue fields that were missing', async () => {
    const { builder } = await harness({
      models: [model('vendor/one', { unknownFields: ['pricing', 'release date'] })],
    });
    const details = builder.build(state({ detailsModelId: 'vendor/one' })).details;
    expect(details?.unknownFields).toEqual(['pricing', 'release date']);
    expect(details?.createdLabel).toBeTruthy();
  });

  it('says where the model is selected, at every level', async () => {
    const { builder } = await harness({
      models: [model('vendor/one')],
      selectedGlobal: 'vendor/one',
      selectedRole: { role: 'coding', modelId: 'vendor/one' },
    });

    const details = builder.build(state({ detailsModelId: 'vendor/one' })).details;
    expect(details?.selectedAt).toContain('Global default');
    expect(details?.selectedAt).toContain('Coding');
  });

  it('answers "why should I use this model?" only when a task is chosen', async () => {
    const { builder } = await harness({ models: [model('vendor/one')] });

    const without = builder.build(state({ detailsModelId: 'vendor/one' })).details;
    expect(without?.explanation).toBeNull();

    const withTask = builder
      .build(state({ detailsModelId: 'vendor/one', adviceTaskId: 'coding' }))
      .details;
    expect(withTask?.explanation?.taskId).toBe('coding');
    expect(withTask?.explanation?.disclaimer.length).toBeGreaterThan(0);
    expect(withTask?.explanation?.recommendation).not.toBeNull();
    // The same formatted score the advisor card shows, so the two cannot
    // disagree about what this model scored.
    expect(withTask?.explanation?.recommendation?.scoreLabel).toMatch(/^\d+% fit$/);
  });

  it('names the project level among the places a model is selected', async () => {
    const { builder } = await harness({
      models: [model('vendor/one')],
      projectPath: '/repo',
      selectedProject: { path: '/repo', modelId: 'vendor/one' },
    });

    const details = builder.build(state({ detailsModelId: 'vendor/one' })).details;
    expect(details?.selectedAt).toContain('This project');
  });

  it('closes the details pane when the model vanishes from the catalogue', async () => {
    // Usually a refresh underneath the open panel. An empty shell would be
    // worse than closing.
    const { builder } = await harness({ models: [model('vendor/one')] });
    const snapshot = builder.build(state({ detailsModelId: 'vendor/absent' }));
    expect(snapshot.details).toBeNull();
  });

  it('carries the capture time, so stale prices are visible', async () => {
    const { builder } = await harness({ models: [model('vendor/one')] });
    const details = builder.build(state({ detailsModelId: 'vendor/one' })).details;
    expect(details?.capturedAt).toBe(NOW);
  });
});

describe('selection summary', () => {
  it('lists the global level plus every role, with the consumers that read them', async () => {
    const { builder } = await harness();
    const levels = builder.build(state()).selection.levels;

    expect(levels[0]?.level).toBe('global');
    expect(levels[0]?.label).toBe('Global default');
    expect(levels.filter((level) => level.level === 'role').length).toBeGreaterThan(0);
  });

  it('states plainly when no workflow reads a stored role', async () => {
    // PairPilot has no Planning or Coding Studio screens, so a role with no
    // consumer is a stored preference rather than a setting in force.
    const { builder } = await harness();
    const levels = builder.build(state()).selection.levels;

    for (const level of levels.filter((entry) => entry.level === 'role' && entry.consumerLabel === null)) {
      expect(level.note).toContain('No PairPilot workflow reads this role yet');
    }
    for (const level of levels.filter((entry) => entry.level === 'role' && entry.consumerLabel !== null)) {
      expect(level.note).not.toContain('No PairPilot workflow reads this role yet');
    }
  });

  it('reports which model the next coding turn will use, and where it came from', async () => {
    const { builder } = await harness({
      models: [model('vendor/one')],
      selectedRole: { role: 'coding', modelId: 'vendor/one' },
    });

    const resolved = builder.build(state()).selection.resolved;
    expect(resolved.modelId).toBe('vendor/one');
    expect(resolved.modelName).toBe('vendor/one');
    expect(resolved.isProviderDefault).toBe(false);
  });

  it('reports the provider default when nothing is selected anywhere', async () => {
    const { builder } = await harness();
    const resolved = builder.build(state()).selection.resolved;
    expect(resolved.modelId).toBeNull();
    expect(resolved.isProviderDefault).toBe(true);
    // It does not name a model PairPilot did not choose.
    expect(resolved.modelName).toBeNull();
  });

  it('flags a selection pointing at a model the catalogue no longer has', async () => {
    const { builder } = await harness({
      models: [model('vendor/one')],
      selectedGlobal: 'vendor/removed',
    });

    const dangling = builder.build(state()).selection.dangling;
    expect(dangling).toEqual([{ modelId: 'vendor/removed', where: 'Global default' }]);
  });

  it('shows the project level only when a folder is open', async () => {
    // A "this project" row with no workspace behind it would invite a selection
    // that could never resolve.
    const closed = await harness({ models: [model('vendor/one')] });
    expect(closed.builder.build(state()).selection.levels.map((level) => level.level)).not.toContain(
      'project'
    );

    const open = await harness({
      models: [model('vendor/one')],
      projectPath: '/repo',
      selectedProject: { path: '/repo', modelId: 'vendor/one' },
    });
    const levels = open.builder.build(state()).selection.levels;
    const project = levels.find((level) => level.level === 'project');

    expect(levels.map((level) => level.level).slice(0, 2)).toEqual(['global', 'project']);
    expect(project?.key).toBe('/repo');
    expect(project?.modelId).toBe('vendor/one');
    expect(project?.modelName).toBe('vendor/one');
    expect(project?.note).toContain('this workspace');
  });

  it('flags a project selection whose model has left the catalogue', async () => {
    const { builder } = await harness({
      models: [model('vendor/one')],
      projectPath: '/repo',
      selectedProject: { path: '/repo', modelId: 'vendor/gone' },
    });

    expect(builder.build(state()).selection.dangling).toEqual([
      { modelId: 'vendor/gone', where: 'This project' },
    ]);
  });

  it('resolves a coding turn through the project level when no role overrides it', async () => {
    const { builder } = await harness({
      models: [model('vendor/one')],
      projectPath: '/repo',
      selectedProject: { path: '/repo', modelId: 'vendor/one' },
    });

    const resolved = builder.build(state()).selection.resolved;
    expect(resolved.modelId).toBe('vendor/one');
    expect(resolved.sourceLabel).toBe('Project');
    expect(resolved.isProviderDefault).toBe(false);
  });
});

describe('advice', () => {
  it('is absent until a task is chosen, and lists every task as an option', async () => {
    const { builder } = await harness();
    const snapshot = builder.build(state());

    expect(snapshot.advice).toBeNull();
    expect(snapshot.adviceTasks.map((task) => task.id)).toContain('coding');
    expect(snapshot.adviceTasks.map((task) => task.id)).toContain('large-repo-analysis');
    for (const task of snapshot.adviceTasks) {
      expect(task.label.length).toBeGreaterThan(0);
    }
  });

  it('recommends for the chosen task, with the disclaimer attached', async () => {
    const { builder } = await harness({ models: [model('vendor/one'), model('vendor/two')] });
    const advice = builder.build(state({ adviceTaskId: 'coding' })).advice;

    expect(advice?.taskId).toBe('coding');
    expect(advice?.recommendations.length).toBeGreaterThan(0);
    expect(advice?.disclaimer).toContain('no benchmark');
  });

  it('formats each score on the Host side, as a fit rather than a grade', async () => {
    // The panel has no way to turn the number into a percentage, which is what
    // stops a bare "94%" appearing beside a model name with no qualifier.
    const { builder } = await harness({ models: [model('vendor/one'), model('vendor/two')] });
    const advice = builder.build(state({ adviceTaskId: 'coding' })).advice;

    for (const recommendation of advice?.recommendations ?? []) {
      expect(recommendation.scoreLabel).toMatch(/^\d+% fit$/);
      expect(recommendation.score).toBeGreaterThanOrEqual(0);
      expect(recommendation.score).toBeLessThanOrEqual(1);
    }
  });
});

describe('the notice', () => {
  it('is passed through unchanged, and absent when there is none', async () => {
    const { builder } = await harness();
    expect(builder.build(state()).notice).toBeNull();

    const notice = { level: 'warning' as const, text: 'The catalogue is stale.' };
    expect(builder.build(state({ notice })).notice).toEqual(notice);
  });
});

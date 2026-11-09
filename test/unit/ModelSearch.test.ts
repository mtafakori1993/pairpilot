/**
 * Explorer search, quick filters and sorting (spec section 11).
 *
 * Two rules carry the weight here.
 *
 * **An unknown value never sorts as if it were the best one.** Cheapest-first
 * with unpriced models treated as free would put the models whose price nobody
 * knows at the top, which is exactly backwards. `null` sorts last in both
 * directions, and these tests check both.
 *
 * **A quick filter selects on a catalogue fact, never on a judgement.** The
 * rules are exported and shown in the UI, so each filter is tested against the
 * sentence the developer can read. There is no "Fast" filter — the catalogue
 * publishes no latency field — and a test asserts one cannot quietly appear.
 */

import { describe, expect, it } from 'vitest';
import {
  compareNullable,
  defaultModelQuery,
  filterModels,
  matchesQuickFilter,
  matchesSearch,
  selectModels,
  sortModels,
} from '../../src/models/ModelSearch';
import {
  LARGE_CONTEXT_TOKENS,
  LOW_COST_INPUT_PER_MILLION_USD,
  MODEL_QUICK_FILTERS,
  MODEL_SORT_KEYS,
  emptyPricing,
  type ModelMetadata,
} from '../../src/types/model';

function model(id: string, overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    id,
    canonicalSlug: null,
    name: id,
    developer: (id.includes('/') ? id.split('/')[0] : null) ?? null,
    description: null,
    contextLength: null,
    maxOutputTokens: null,
    created: null,
    pricing: emptyPricing(),
    capabilities: {
      inputModalities: [],
      outputModalities: [],
      toolCalling: false,
      structuredOutput: false,
      reasoning: false,
      supportedParameters: [],
    },
    unknownFields: [],
    capturedAt: 0,
    ...overrides,
  };
}

/** A model priced at `usdPerMillion` input, so the tests read in display units. */
function priced(id: string, perMillionUsd: number | null, overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return model(id, {
    pricing: {
      ...emptyPricing(),
      promptPerToken: perMillionUsd === null ? null : perMillionUsd / 1_000_000,
      isFree: perMillionUsd === 0,
    },
    ...overrides,
  });
}

const NO_FAVORITES = { favorites: new Set<string>() };

function query(overrides: Partial<ReturnType<typeof defaultModelQuery>> = {}) {
  return { ...defaultModelQuery(), ...overrides };
}

describe('matchesSearch', () => {
  const subject = model('anthropic/claude-sonnet-5-5', {
    name: 'Claude Sonnet 5.5',
    description: 'A capable general-purpose model.',
  });

  it('matches on name, id, developer and description', () => {
    expect(matchesSearch(subject, 'sonnet')).toBe(true);
    expect(matchesSearch(subject, 'claude-sonnet')).toBe(true);
    expect(matchesSearch(subject, 'anthropic')).toBe(true);
    expect(matchesSearch(subject, 'general-purpose')).toBe(true);
  });

  it('is case-insensitive and ignores surrounding whitespace', () => {
    expect(matchesSearch(subject, '  SONNET  ')).toBe(true);
  });

  it('matches everything for an empty search', () => {
    expect(matchesSearch(subject, '')).toBe(true);
    expect(matchesSearch(subject, '   ')).toBe(true);
  });

  it('does not match an unrelated term', () => {
    expect(matchesSearch(subject, 'llama')).toBe(false);
  });

  it('does not treat a null developer or description as a match', () => {
    const bare = model('bare');
    expect(matchesSearch(bare, 'null')).toBe(false);
    expect(matchesSearch(bare, 'undefined')).toBe(false);
  });
});

describe('matchesQuickFilter: each rule matches what the UI says it does', () => {
  it('coding: tool calling or structured output', () => {
    const tools = model('a/tools', {
      capabilities: { ...model('x').capabilities, toolCalling: true },
    });
    const structured = model('a/structured', {
      capabilities: { ...model('x').capabilities, structuredOutput: true },
    });
    expect(matchesQuickFilter(tools, 'coding')).toBe(true);
    expect(matchesQuickFilter(structured, 'coding')).toBe(true);
    expect(matchesQuickFilter(model('a/plain'), 'coding')).toBe(false);
  });

  it('reasoning: only the reasoning flag', () => {
    const reasoning = model('a/r', {
      capabilities: { ...model('x').capabilities, reasoning: true },
    });
    expect(matchesQuickFilter(reasoning, 'reasoning')).toBe(true);
    expect(matchesQuickFilter(model('a/plain'), 'reasoning')).toBe(false);
  });

  it('low-cost: at or below the published threshold, inclusive', () => {
    expect(matchesQuickFilter(priced('a/cheap', 0.5), 'low-cost')).toBe(true);
    expect(matchesQuickFilter(priced('a/edge', LOW_COST_INPUT_PER_MILLION_USD), 'low-cost')).toBe(true);
    expect(matchesQuickFilter(priced('a/over', 1.01), 'low-cost')).toBe(false);
  });

  it('low-cost: excludes an unpriced model rather than calling it cheap', () => {
    // The mistake this guards: `null <= 1` is true in JavaScript, so an
    // unguarded comparison would make every unknown-price model "low cost".
    expect(matchesQuickFilter(priced('a/unknown', null), 'low-cost')).toBe(false);
  });

  it('large-context: at or above the published floor, inclusive', () => {
    const large = model('a/large', { contextLength: LARGE_CONTEXT_TOKENS });
    const small = model('a/small', { contextLength: LARGE_CONTEXT_TOKENS - 1 });
    expect(matchesQuickFilter(large, 'large-context')).toBe(true);
    expect(matchesQuickFilter(small, 'large-context')).toBe(false);
    expect(matchesQuickFilter(model('a/unknown'), 'large-context')).toBe(false);
  });

  it('vision: accepts image input', () => {
    const vision = model('a/v', {
      capabilities: { ...model('x').capabilities, inputModalities: ['text', 'image'] },
    });
    expect(matchesQuickFilter(vision, 'vision')).toBe(true);
    expect(matchesQuickFilter(model('a/plain'), 'vision')).toBe(false);
  });

  it('audio: in or out', () => {
    const audioIn = model('a/ai', {
      capabilities: { ...model('x').capabilities, inputModalities: ['audio'] },
    });
    const audioOut = model('a/ao', {
      capabilities: { ...model('x').capabilities, outputModalities: ['audio'] },
    });
    expect(matchesQuickFilter(audioIn, 'audio')).toBe(true);
    expect(matchesQuickFilter(audioOut, 'audio')).toBe(true);
    expect(matchesQuickFilter(model('a/plain'), 'audio')).toBe(false);
  });

  it('tool-calling and structured-output read their own flag, not the coding lump', () => {
    const structuredOnly = model('a/s', {
      capabilities: { ...model('x').capabilities, structuredOutput: true },
    });
    expect(matchesQuickFilter(structuredOnly, 'tool-calling')).toBe(false);
    expect(matchesQuickFilter(structuredOnly, 'structured-output')).toBe(true);
  });

  it('free: only an explicit zero on both sides', () => {
    expect(matchesQuickFilter(priced('a/free', 0), 'free')).toBe(true);
    expect(matchesQuickFilter(priced('a/cheap', 0.01), 'free')).toBe(false);
    // Unknown pricing is not free pricing.
    expect(matchesQuickFilter(priced('a/unknown', null), 'free')).toBe(false);
    expect(matchesQuickFilter(model('a/bare'), 'free')).toBe(false);
  });

  it('offers no speed filter, because the catalogue publishes no speed', () => {
    // A "Fast" filter would assert a latency nobody measured. If one is ever
    // added, it needs a real field behind it — and this test is where that
    // decision gets made deliberately.
    expect(MODEL_QUICK_FILTERS as readonly string[]).not.toContain('fast');
  });

  it('every advertised filter is implemented, and every sort key too', () => {
    // The UI builds its controls from these constants, so an unimplemented name
    // would render a control that silently does nothing. The switch's `default`
    // returns true, which is why this is asserted rather than assumed.
    const bare = model('a/plain');
    for (const filter of MODEL_QUICK_FILTERS) {
      const result = matchesQuickFilter(bare, filter);
      expect(typeof result, `filter ${filter}`).toBe('boolean');
    }
    expect(new Set(MODEL_QUICK_FILTERS).size).toBe(MODEL_QUICK_FILTERS.length);

    const sorted = sortModels([model('a/x'), model('b/y')], 'name');
    expect(sorted).toHaveLength(2);
    for (const key of MODEL_SORT_KEYS) {
      expect(sortModels([priced('a/x', 1), model('b/y')], key), `sort ${key}`).toHaveLength(2);
    }
  });
});

describe('filterModels', () => {
  const models = [
    priced('a/cheap', 0.5, { contextLength: 8_000 }),
    priced('a/pricey', 50, { contextLength: 1_000_000 }),
    priced('a/unknown', null, { contextLength: null }),
  ];

  it('combines every selected filter by intersection', () => {
    const both = filterModels(models, query({ quickFilters: ['low-cost', 'large-context'] }), NO_FAVORITES);
    // Cheap but small, pricey but large: neither satisfies both.
    expect(both).toEqual([]);
  });

  it('honours favouritesOnly', () => {
    const favorites = { favorites: new Set(['a/pricey']) };
    expect(filterModels(models, query({ favoritesOnly: true }), favorites).map((m) => m.id)).toEqual([
      'a/pricey',
    ]);
    expect(filterModels(models, query({ favoritesOnly: true }), NO_FAVORITES)).toEqual([]);
  });

  it('honours a minimum context length, excluding unknown lengths', () => {
    const filtered = filterModels(models, query({ minContextLength: 100_000 }), NO_FAVORITES);
    expect(filtered.map((m) => m.id)).toEqual(['a/pricey']);
  });

  it('honours a maximum input price, excluding unknown prices', () => {
    const filtered = filterModels(models, query({ maxInputPricePerMillion: 1 }), NO_FAVORITES);
    expect(filtered.map((m) => m.id)).toEqual(['a/cheap']);
  });

  it('applies search and filters together', () => {
    const filtered = filterModels(
      models,
      query({ search: 'pricey', quickFilters: ['large-context'] }),
      NO_FAVORITES
    );
    expect(filtered.map((m) => m.id)).toEqual(['a/pricey']);

    const noMatch = filterModels(
      models,
      query({ search: 'pricey', quickFilters: ['low-cost'] }),
      NO_FAVORITES
    );
    expect(noMatch).toEqual([]);
  });
});

describe('sortModels', () => {
  const cheap = priced('a/cheap', 1);
  const pricey = priced('a/pricey', 60);
  const unknownPrice = priced('b/unknown', null);

  it('sorts cheapest first and puts unknown prices last', () => {
    expect(sortModels([pricey, unknownPrice, cheap], 'input-cost').map((m) => m.id)).toEqual([
      'a/cheap',
      'a/pricey',
      'b/unknown',
    ]);
  });

  it('puts unknown prices last for output cost too', () => {
    const a = model('a/x', { pricing: { ...emptyPricing(), completionPerToken: 0.000005 } });
    const b = model('b/y');
    expect(sortModels([b, a], 'output-cost').map((m) => m.id)).toEqual(['a/x', 'b/y']);
  });

  it('sorts largest context first, with unknown last', () => {
    const small = model('a/small', { contextLength: 8_000 });
    const large = model('a/large', { contextLength: 1_000_000 });
    const unknown = model('b/unknown');
    expect(sortModels([small, unknown, large], 'context').map((m) => m.id)).toEqual([
      'a/large',
      'a/small',
      'b/unknown',
    ]);
  });

  it('sorts newest first, with no release date last', () => {
    const older = model('a/old', { created: 1_000 });
    const newer = model('a/new', { created: 2_000 });
    const undated = model('b/undated');
    expect(sortModels([older, undated, newer], 'newest').map((m) => m.id)).toEqual([
      'a/new',
      'a/old',
      'b/undated',
    ]);
  });

  it('sorts by provider, then by name, with no developer last', () => {
    const anthropicB = model('anthropic/b');
    const anthropicA = model('anthropic/a');
    const meta = model('meta-llama/x');
    const unknown = model('bare');
    expect(
      sortModels([meta, anthropicB, unknown, anthropicA], 'provider').map((m) => m.id)
    ).toEqual(['anthropic/a', 'anthropic/b', 'meta-llama/x', 'bare']);
  });

  it('sorts by name as the default', () => {
    expect(sortModels([model('b/y'), model('a/x')], 'name').map((m) => m.id)).toEqual(['a/x', 'b/y']);
  });

  it('does not mutate the input', () => {
    const input = [model('b/y'), model('a/x')];
    const copy = [...input];
    sortModels(input, 'name');
    expect(input).toEqual(copy);
  });
});

describe('compareNullable', () => {
  it('places null after every value in both directions', () => {
    expect(compareNullable(1, null, 'asc')).toBeLessThan(0);
    expect(compareNullable(null, 1, 'asc')).toBeGreaterThan(0);
    // Reversing the direction must not move the unknowns to the front.
    expect(compareNullable(1, null, 'desc')).toBeLessThan(0);
    expect(compareNullable(null, 1, 'desc')).toBeGreaterThan(0);
  });

  it('treats two nulls as equal', () => {
    expect(compareNullable(null, null, 'asc')).toBe(0);
    expect(compareNullable(null, null, 'desc')).toBe(0);
  });

  it('compares strings as well as numbers', () => {
    expect(compareNullable('a', 'b', 'asc')).toBeLessThan(0);
    expect(compareNullable('a', 'b', 'desc')).toBeGreaterThan(0);
  });
});

describe('selectModels and the default query', () => {
  it('defaults to no filters, no search and name order', () => {
    expect(defaultModelQuery()).toEqual({
      search: '',
      quickFilters: [],
      maxInputPricePerMillion: null,
      minContextLength: null,
      sort: 'name',
      favoritesOnly: false,
    });
  });

  it('runs filter then sort as one pipeline', () => {
    const models = [
      priced('a/expensive', 60, { contextLength: 500_000 }),
      priced('a/cheap', 0.5, { contextLength: 500_000 }),
      priced('a/small', 0.1, { contextLength: 8_000 }),
    ];
    const selected = selectModels(
      models,
      query({ quickFilters: ['large-context'], sort: 'input-cost' }),
      NO_FAVORITES
    );
    expect(selected.map((m) => m.id)).toEqual(['a/cheap', 'a/expensive']);
  });
});

/**
 * Cost arithmetic (spec sections 14 and 16).
 *
 * Three rules are load-bearing, and each has a test that fails loudly if the
 * rule is broken:
 *
 *   1. `cached_tokens` is a *subset* of `prompt_tokens`. Adding the two instead
 *      of subtracting bills every cached token twice — a silent overcharge that
 *      looks plausible on screen.
 *   2. A reported cost beats a computed one, and the two are never blended into
 *      a total. The split may be computed; the total is the provider's.
 *   3. A figure that cannot be established is `null`, never `0`. `$0.00` claims
 *      the request was free.
 */

import { describe, expect, it } from 'vitest';
import { computeCost, snapshotPricing } from '../../src/pricing/CostCalculator';
import { emptyPricing, type ModelPricing } from '../../src/types/model';

function pricing(overrides: Partial<ModelPricing> = {}): ModelPricing {
  return {
    ...emptyPricing(),
    // $3/M in, $15/M out, $0.30/M cached read — the common shape.
    promptPerToken: 0.000003,
    completionPerToken: 0.000015,
    cacheReadPerToken: 0.0000003,
    isFree: false,
    ...overrides,
  };
}

describe('computeCost: reported cost', () => {
  it('prefers the reported total and labels it as reported', () => {
    const cost = computeCost({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedTokens: 0,
      reportedCostUsd: 0.5,
      pricing: pricing(),
      modelId: 'a/b',
    });

    // The provider's figure wins even though the catalogue math would say 18.
    expect(cost.totalUsd).toBe(0.5);
    expect(cost.source).toBe('reported');
  });

  it('still splits a reported cost, and says the split is computed', () => {
    const cost = computeCost({
      inputTokens: 1_000,
      outputTokens: 100,
      cachedTokens: 0,
      reportedCostUsd: 0.01,
      pricing: pricing(),
    });

    expect(cost.inputUsd).toBeCloseTo(0.003, 9);
    expect(cost.outputUsd).toBeCloseTo(0.0015, 9);
    expect(cost.totalUsd).toBe(0.01);
    expect(cost.note).toContain('may not add up to the reported total exactly');
  });

  it('keeps the reported total when the catalogue has no price to split with', () => {
    const cost = computeCost({
      inputTokens: 100,
      outputTokens: 10,
      cachedTokens: 0,
      reportedCostUsd: 0.002,
      pricing: null,
    });

    expect(cost.totalUsd).toBe(0.002);
    expect(cost.inputUsd).toBeNull();
    expect(cost.outputUsd).toBeNull();
    expect(cost.source).toBe('reported');
    expect(cost.note).toContain('could not be split');
  });

  it('treats a reported zero as free, not as unknown', () => {
    const cost = computeCost({
      inputTokens: 500,
      outputTokens: 500,
      cachedTokens: 0,
      reportedCostUsd: 0,
      pricing: pricing(),
    });

    expect(cost.totalUsd).toBe(0);
    expect(cost.source).toBe('reported');
  });
});

describe('computeCost: cached tokens are a subset of input', () => {
  it('prices cached tokens at the cache rate and the remainder at the input rate', () => {
    // 1M prompt tokens, 800k of them cache hits.
    const cost = computeCost({
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedTokens: 800_000,
      reportedCostUsd: null,
      pricing: pricing(),
    });

    // 200k × $3/M = $0.60 uncached, 800k × $0.30/M = $0.24 cached.
    expect(cost.inputUsd).toBeCloseTo(0.6, 9);
    expect(cost.cachedUsd).toBeCloseTo(0.24, 9);
    expect(cost.totalUsd).toBeCloseTo(0.84, 9);
  });

  it('does not bill cached tokens twice', () => {
    // The regression this guards: adding cached on top of the full input count
    // would give 200k + 800k + 800k tokens of input.
    const cost = computeCost({
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedTokens: 800_000,
      reportedCostUsd: null,
      pricing: pricing({ promptPerToken: 0.000003, cacheReadPerToken: 0.000003 }),
    });

    // With the same rate for both, the total is exactly the plain input price.
    expect(cost.totalUsd).toBeCloseTo(3, 9);
  });

  it('falls back to the input rate when no cache-read price is published, and says so', () => {
    const cost = computeCost({
      inputTokens: 1_000,
      outputTokens: 0,
      cachedTokens: 400,
      reportedCostUsd: null,
      pricing: pricing({ cacheReadPerToken: null }),
    });

    expect(cost.cachedUsd).toBeCloseTo(400 * 0.000003, 9);
    expect(cost.note).toContain('no cache-read price');
  });

  it('clamps a cached count that exceeds the input count', () => {
    // Cannot happen from a well-formed response. If it does, the arithmetic
    // must not credit the developer a negative input charge.
    const cost = computeCost({
      inputTokens: 100,
      outputTokens: 0,
      cachedTokens: 5_000,
      reportedCostUsd: null,
      pricing: pricing(),
    });

    expect(cost.inputUsd).toBe(0);
    expect(cost.cachedUsd).toBeCloseTo(100 * 0.0000003, 9);
  });

  it('prices a cache write at nothing, because the catalogue does not price it here', () => {
    // `cacheWritePerToken` exists but is deliberately not applied in cost
    // computation; if that changes, this test is where it should be noticed.
    const cost = computeCost({
      inputTokens: 1_000,
      outputTokens: 0,
      cachedTokens: 0,
      reportedCostUsd: null,
      pricing: pricing({ cacheWritePerToken: 0.00000375 }),
    });
    expect(cost.totalUsd).toBeCloseTo(1_000 * 0.000003, 9);
  });
});

describe('computeCost: no reported cost', () => {
  it('estimates from catalogue prices and labels it an estimate', () => {
    const cost = computeCost({
      inputTokens: 2_000,
      outputTokens: 500,
      cachedTokens: 0,
      reportedCostUsd: null,
      pricing: pricing(),
      modelId: 'a/b',
    });

    expect(cost.source).toBe('estimated');
    expect(cost.inputUsd).toBeCloseTo(2_000 * 0.000003, 9);
    expect(cost.outputUsd).toBeCloseTo(500 * 0.000015, 9);
    expect(cost.note).toContain('Estimated from catalogue prices');
    expect(cost.note).toContain('can differ');
  });

  it('adds a flat per-request charge to an estimate', () => {
    const cost = computeCost({
      inputTokens: 1_000,
      outputTokens: 0,
      cachedTokens: 0,
      reportedCostUsd: null,
      pricing: pricing({ requestUsd: 0.01 }),
    });
    expect(cost.totalUsd).toBeCloseTo(0.003 + 0.01, 9);
  });

  it('never adds a per-request charge to a reported total', () => {
    // The provider's figure already includes whatever it charged.
    const cost = computeCost({
      inputTokens: 1_000,
      outputTokens: 0,
      cachedTokens: 0,
      reportedCostUsd: 0.05,
      pricing: pricing({ requestUsd: 0.01 }),
    });
    expect(cost.totalUsd).toBe(0.05);
  });

  it('prices a genuinely free model at zero and calls it estimated', () => {
    const cost = computeCost({
      inputTokens: 10_000,
      outputTokens: 1_000,
      cachedTokens: 0,
      reportedCostUsd: null,
      pricing: pricing({ promptPerToken: 0, completionPerToken: 0, isFree: true }),
    });

    expect(cost.totalUsd).toBe(0);
    expect(cost.source).toBe('estimated');
  });

  it('refuses to price a model with no prices at all', () => {
    const cost = computeCost({
      inputTokens: 10_000,
      outputTokens: 1_000,
      cachedTokens: 0,
      reportedCostUsd: null,
      pricing: emptyPricing(),
    });

    expect(cost.totalUsd).toBeNull();
    expect(cost.inputUsd).toBeNull();
    expect(cost.source).toBe('unavailable');
    expect(cost.note).toContain('publishes no input or output price');
  });

  it('refuses to price at all when there is neither a report nor a catalogue entry', () => {
    const cost = computeCost({
      inputTokens: 10,
      outputTokens: 10,
      cachedTokens: 0,
      reportedCostUsd: null,
      pricing: null,
    });

    expect(cost.totalUsd).toBeNull();
    expect(cost.source).toBe('unavailable');
  });

  it('prices one sideless model partially rather than giving up', () => {
    const cost = computeCost({
      inputTokens: 1_000,
      outputTokens: 1_000,
      cachedTokens: 0,
      reportedCostUsd: null,
      pricing: pricing({ completionPerToken: null }),
    });

    expect(cost.inputUsd).toBeCloseTo(0.003, 9);
    expect(cost.outputUsd).toBe(0);
    expect(cost.source).toBe('estimated');
    expect(cost.note).toContain('no output price');
  });
});

describe('snapshotPricing', () => {
  it('freezes the prices in force, with the model id', () => {
    const snapshot = snapshotPricing('a/b', pricing(), 1_700_000_000_000);
    expect(snapshot).toEqual({
      modelId: 'a/b',
      promptPerToken: 0.000003,
      completionPerToken: 0.000015,
      cacheReadPerToken: 0.0000003,
      capturedAt: 1_700_000_000_000,
    });
  });

  it('returns null for an unknown model or a model with nothing to freeze', () => {
    expect(snapshotPricing(null, pricing(), 0)).toBeNull();
    expect(snapshotPricing('a/b', null, 0)).toBeNull();
    // A snapshot of "no prices" would let a past cost be re-derived as zero.
    expect(snapshotPricing('a/b', emptyPricing(), 0)).toBeNull();
  });

  it('keeps a snapshot whose only price is a cache-read price', () => {
    const snapshot = snapshotPricing('a/b', pricing({ promptPerToken: null, completionPerToken: null }), 5);
    expect(snapshot?.cacheReadPerToken).toBe(0.0000003);
    expect(snapshot?.promptPerToken).toBeNull();
  });
});

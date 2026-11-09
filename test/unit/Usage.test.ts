/**
 * Usage extraction and session-store accumulation tests (spec section 12).
 *
 * The rule under test: token counts are reported exactly as the runtime supplied
 * them, and "unavailable" is a first-class answer. Inventing numbers would be
 * worse than showing nothing, because the developer would trust them.
 */

import { describe, expect, it } from 'vitest';
import { extractUsage } from '../../src/runtime/ClaudeSession';
import { accumulate } from '../../src/storage/SessionStore';
import { addUsage, emptyUsage, type TokenUsage } from '../../src/types';

describe('extractUsage: real CLI result shapes', () => {
  it('reads the full usage object the CLI actually reports', () => {
    // Modelled on real output from `claude -p --output-format json`.
    const usage = extractUsage({
      type: 'result',
      subtype: 'success',
      is_error: false,
      total_cost_usd: 0.05562,
      usage: {
        input_tokens: 11040,
        output_tokens: 4,
        cache_read_input_tokens: 640,
        cache_creation_input_tokens: 0,
      },
      modelUsage: { 'deepseek/deepseek-v4.1-flash': { inputTokens: 11040 } },
    } as never);

    expect(usage.available).toBe(true);
    expect(usage.inputTokens).toBe(11040);
    expect(usage.outputTokens).toBe(4);
    expect(usage.cacheReadTokens).toBe(640);
    expect(usage.cacheCreationTokens).toBe(0);
    expect(usage.costUsd).toBeCloseTo(0.05562, 6);
    expect(usage.model).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('reports unavailable when the runtime supplied no usage', () => {
    const usage = extractUsage({ type: 'result' } as never);
    expect(usage.available).toBe(false);
    expect(usage.inputTokens).toBe(0);
    expect(usage.costUsd).toBeNull();
  });

  it('reports unavailable when usage is present but all zero', () => {
    // All-zero counters mean the runtime did not actually measure anything, so
    // claiming "0 tokens" would be a fabrication.
    const usage = extractUsage({
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    } as never);
    expect(usage.available).toBe(false);
  });

  it('leaves cost null when the runtime reported none', () => {
    const usage = extractUsage({ usage: { input_tokens: 10, output_tokens: 5 } } as never);
    expect(usage.available).toBe(true);
    expect(usage.costUsd).toBeNull();
  });

  it('keeps a genuine zero cost as zero rather than null', () => {
    const usage = extractUsage({
      total_cost_usd: 0,
      usage: { input_tokens: 10, output_tokens: 5 },
    } as never);
    expect(usage.costUsd).toBe(0);
  });

  it('ignores negative and non-numeric counters', () => {
    const usage = extractUsage({
      usage: { input_tokens: -5, output_tokens: 'many', cache_read_input_tokens: NaN },
    } as never);
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    expect(usage.cacheReadTokens).toBe(0);
    expect(usage.available).toBe(false);
  });

  it('omits the model when modelUsage is empty', () => {
    const usage = extractUsage({
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {},
    } as never);
    expect(usage.model).toBeUndefined();
  });
});

describe('accumulate and addUsage: session totals', () => {
  const a: TokenUsage = {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 5,
    cacheCreationTokens: 1,
    costUsd: 0.01,
    available: true,
    model: 'm1',
  };
  const b: TokenUsage = {
    inputTokens: 200,
    outputTokens: 40,
    cacheReadTokens: 10,
    cacheCreationTokens: 2,
    costUsd: 0.02,
    available: true,
    model: 'm1',
  };

  it('sums every counter', () => {
    const total = accumulate(a, b);
    expect(total.inputTokens).toBe(300);
    expect(total.outputTokens).toBe(60);
    expect(total.cacheReadTokens).toBe(15);
    expect(total.cacheCreationTokens).toBe(3);
    expect(total.costUsd).toBeCloseTo(0.03, 6);
  });

  it('keeps cost null when either side is unknown', () => {
    // A partial sum presented as a total would understate real spend.
    const unknown: TokenUsage = { ...b, costUsd: null };
    expect(accumulate(a, unknown).costUsd).toBeNull();
    expect(accumulate(unknown, a).costUsd).toBeNull();
  });

  it('stays available if either side was available', () => {
    expect(accumulate(a, emptyUsage()).available).toBe(true);
    expect(accumulate(emptyUsage(), a).available).toBe(true);
  });

  it('is unavailable only when both sides are', () => {
    expect(accumulate(emptyUsage(), emptyUsage()).available).toBe(false);
  });

  it('carries the model forward', () => {
    expect(accumulate(emptyUsage(), a).model).toBe('m1');
  });

  it('addUsage agrees with accumulate', () => {
    expect(addUsage(a, b)).toEqual(accumulate(a, b));
  });

  it('accumulating from empty yields the same figures', () => {
    const total = accumulate(emptyUsage(), a);
    expect(total.inputTokens).toBe(a.inputTokens);
    expect(total.outputTokens).toBe(a.outputTokens);
  });
});

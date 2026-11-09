/**
 * SSE framing and usage extraction (spec sections 9 and 10).
 *
 * This is the layer where a real bug is quiet rather than loud: a chunk boundary
 * that falls mid-line produces a frame that parses as valid JSON for a *different*
 * object, or a frame that is silently dropped. So the tests below are mostly
 * about boundaries — splits at every position of a frame, CRLF, a trailing line
 * with no newline, keep-alives, and the `[DONE]` sentinel.
 *
 * `readUsage` is tested for the property the whole cost feature rests on: an
 * absent figure stays absent. `null`, never `0`.
 */

import { describe, expect, it } from 'vitest';
import { interpretSseLine, parseSse, type SseEvent } from '../../src/providers/HttpTransport';
import { parseRetryAfter, readUsage, retryDelayMs, OpenRouterError } from '../../src/providers/OpenRouterClient';

/** Feed a list of chunks through the parser and collect every event. */
async function collect(chunks: readonly string[]): Promise<SseEvent[]> {
  async function* source(): AsyncGenerator<string> {
    for (const chunk of chunks) {
      yield chunk;
    }
  }
  const events: SseEvent[] = [];
  for await (const event of parseSse(source())) {
    events.push(event);
  }
  return events;
}

describe('interpretSseLine', () => {
  it('reads a data frame', () => {
    expect(interpretSseLine('data: {"a":1}')).toEqual({ kind: 'data', payload: '{"a":1}' });
  });

  it('reads the sentinel as done', () => {
    expect(interpretSseLine('data: [DONE]')).toEqual({ kind: 'done' });
  });

  it('tolerates CRLF', () => {
    expect(interpretSseLine('data: {"a":1}\r')).toEqual({ kind: 'data', payload: '{"a":1}' });
    expect(interpretSseLine('data: [DONE]\r')).toEqual({ kind: 'done' });
  });

  it('ignores blank lines, comments and non-data fields', () => {
    expect(interpretSseLine('')).toBeNull();
    expect(interpretSseLine('\r')).toBeNull();
    // OpenRouter's own keep-alive while a model is still thinking.
    expect(interpretSseLine(': OPENROUTER PROCESSING')).toBeNull();
    expect(interpretSseLine('event: message')).toBeNull();
    expect(interpretSseLine('id: 42')).toBeNull();
    expect(interpretSseLine('retry: 1000')).toBeNull();
  });

  it('ignores a data field with no payload', () => {
    expect(interpretSseLine('data:')).toBeNull();
    expect(interpretSseLine('data:   ')).toBeNull();
  });

  it('keeps the payload verbatim apart from surrounding whitespace', () => {
    // The space after `data:` is the SSE field separator, not part of the JSON.
    expect(interpretSseLine('data:{"a":1}')).toEqual({ kind: 'data', payload: '{"a":1}' });
    expect(interpretSseLine('data:   {"a":1}   ')).toEqual({ kind: 'data', payload: '{"a":1}' });
  });
});

describe('parseSse: chunk boundaries', () => {
  it('reassembles a frame split at every possible position', async () => {
    const frame = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n';
    for (let split = 0; split <= frame.length; split += 1) {
      const events = await collect([frame.slice(0, split), frame.slice(split)]);
      expect(events, `split at ${split}`).toEqual([
        { kind: 'data', payload: '{"choices":[{"delta":{"content":"hi"}}]}' },
      ]);
    }
  });

  it('reassembles the sentinel split across a boundary', async () => {
    // `[DONE]` spanning two chunks is the case a naive `includes('[DONE]')`
    // check on each chunk would miss.
    const events = await collect(['data: [DO', 'NE]\n']);
    expect(events).toEqual([{ kind: 'done' }]);
  });

  it('reads several frames from one chunk', async () => {
    const events = await collect(['data: {"n":1}\ndata: {"n":2}\n']);
    expect(events).toEqual([
      { kind: 'data', payload: '{"n":1}' },
      { kind: 'data', payload: '{"n":2}' },
    ]);
  });

  it('reads a final frame with no trailing newline', async () => {
    const events = await collect(['data: {"n":1}']);
    expect(events).toEqual([{ kind: 'data', payload: '{"n":1}' }]);
  });

  it('stops at the sentinel and never parses what follows', async () => {
    // Content after `[DONE]` is either garbage or a second, unrelated stream;
    // either way the caller expects the parser to stop consuming.
    const events = await collect(['data: {"n":1}\ndata: [DONE]\ndata: {"n":2}\n']);
    expect(events).toEqual([{ kind: 'data', payload: '{"n":1}' }, { kind: 'done' }]);
  });

  it('emits nothing for a stream of blank lines and keep-alives', async () => {
    expect(await collect(['\n\n: OPENROUTER PROCESSING\n\n'])).toEqual([]);
  });

  it('emits a trailing unterminated line, leaving the JSON check to the caller', async () => {
    // A final frame with no trailing newline is ordinary SSE, so the parser
    // cannot tell "the stream ended cleanly" from "the stream was cut off" — it
    // emits the line either way. A truncated frame then fails to parse at the
    // client, which skips it rather than aborting a paid stream over one bad
    // frame. The distinction is asserted here so neither half drifts.
    const events = await collect(['data: {"n":1}\n', 'data: {"half']);
    expect(events).toEqual([
      { kind: 'data', payload: '{"n":1}' },
      { kind: 'data', payload: '{"half' },
    ]);
    expect(() => JSON.parse('{"half')).toThrow();
  });
});

describe('readUsage', () => {
  it('reads the documented usage block', () => {
    const usage = readUsage({
      prompt_tokens: 1_000,
      completion_tokens: 250,
      total_tokens: 1_250,
      cost: 0.0123,
      prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 40 },
    });

    expect(usage).not.toBeNull();
    expect(usage?.inputTokens).toBe(1_000);
    expect(usage?.outputTokens).toBe(250);
    expect(usage?.cachedTokens).toBe(800);
    expect(usage?.reasoningTokens).toBe(40);
    expect(usage?.reportedCostUsd).toBe(0.0123);
  });

  it('reports a cost of exactly zero as zero, not as unknown', () => {
    // A genuinely free model reports `cost: 0`. That is a fact, and it must not
    // be collapsed into "unknown" — the two say opposite things.
    const usage = readUsage({ prompt_tokens: 10, completion_tokens: 5, cost: 0 });
    expect(usage?.reportedCostUsd).toBe(0);
  });

  it('leaves an absent cost as null rather than inventing zero', () => {
    const usage = readUsage({ prompt_tokens: 10, completion_tokens: 5 });
    expect(usage?.reportedCostUsd).toBeNull();
  });

  it('defaults token details that the model did not report to zero', () => {
    // These are counts of a thing that did not happen, not unknown figures:
    // a model with no cache support cached nothing.
    const usage = readUsage({ prompt_tokens: 10, completion_tokens: 5, cost: 0 });
    expect(usage?.cachedTokens).toBe(0);
    expect(usage?.cacheWriteTokens).toBe(0);
    expect(usage?.reasoningTokens).toBe(0);
  });

  it('returns null when there is no usage block at all', () => {
    expect(readUsage(undefined)).toBeNull();
    expect(readUsage(null)).toBeNull();
    expect(readUsage('nope')).toBeNull();
    expect(readUsage([])).toBeNull();
  });

  it('survives a malformed details block', () => {
    const usage = readUsage({ prompt_tokens: 5, prompt_tokens_details: 'nope' });
    expect(usage?.cachedTokens).toBe(0);
  });
});

describe('parseRetryAfter', () => {
  it('reads plain seconds', () => {
    expect(parseRetryAfter('2')).toBe(2);
    expect(parseRetryAfter(' 30 ')).toBe(30);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('caps an absurd wait rather than honouring it', () => {
    expect(parseRetryAfter('99999')).toBe(300);
  });

  it('reads an HTTP date', () => {
    const at = new Date(Date.now() + 10_000).toUTCString();
    const seconds = parseRetryAfter(at);
    expect(seconds).not.toBeNull();
    expect(seconds as number).toBeGreaterThan(0);
    expect(seconds as number).toBeLessThanOrEqual(11);
  });

  it('returns null for a missing or unreadable header', () => {
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter('-5')).toBeNull();
  });
});

describe('retryDelayMs', () => {
  it('honours Retry-After exactly rather than backing off past it', () => {
    const error = new OpenRouterError('slow down', 'rate-limit', 429, 7);
    expect(retryDelayMs(error, 1, () => 0)).toBe(7_000);
  });

  it('backs off exponentially with jitter when the server said nothing', () => {
    const error = new OpenRouterError('boom', 'server', 500);
    // attempt 1 → 500ms, + jitter in [0, 500)
    expect(retryDelayMs(error, 1, () => 0)).toBe(500);
    expect(retryDelayMs(error, 1, () => 0.5)).toBe(750);
    expect(retryDelayMs(error, 3, () => 0)).toBe(2_000);
  });

  it('never backs off past the ceiling', () => {
    const error = new OpenRouterError('boom', 'server', 500);
    expect(retryDelayMs(error, 20, () => 1)).toBe(8_000);
  });
});

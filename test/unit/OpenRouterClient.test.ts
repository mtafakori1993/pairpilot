/**
 * OpenRouter client behaviour against a fake transport (spec sections 8 and 9).
 *
 * There is no network and no key here: the transport is a stub, so every
 * response — including the awkward ones — is written down in the test. That is
 * the only way to exercise the cases that matter, because the interesting
 * failures are the ones a live service will not produce on request: an error
 * riding in-band on a committed 200 stream, a 404 on one endpoint but not
 * another, a server that echoes the API key back in its error text.
 *
 * The redaction test is the one to keep passing. If it ever regresses, a
 * credential reaches the output channel.
 */

import { describe, expect, it } from 'vitest';
import {
  OpenRouterClient,
  OpenRouterError,
  isRetryable,
  redactSecret,
  type ChatStreamEvent,
} from '../../src/providers/OpenRouterClient';
import type {
  HttpRequestSpec,
  HttpResult,
  HttpStreamResult,
  HttpTransport,
} from '../../src/providers/HttpTransport';

const KEY = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): HttpResult {
  return { status, headers, text: typeof body === 'string' ? body : JSON.stringify(body) };
}

function stream(status: number, chunks: readonly string[], headers: Record<string, string> = {}): HttpStreamResult {
  return {
    status,
    headers,
    chunks: (async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    })(),
  };
}

/** A transport that answers from a script and records what it was asked. */
class ScriptedTransport implements HttpTransport {
  readonly available = true;
  readonly requests: HttpRequestSpec[] = [];

  constructor(
    private readonly script: {
      request?(spec: HttpRequestSpec): HttpResult | Promise<HttpResult>;
      stream?(spec: HttpRequestSpec): HttpStreamResult | Promise<HttpStreamResult>;
    }
  ) {}

  async request(spec: HttpRequestSpec): Promise<HttpResult> {
    this.requests.push(spec);
    if (!this.script.request) {
      throw new Error('this test did not script a request()');
    }
    return this.script.request(spec);
  }

  async stream(spec: HttpRequestSpec): Promise<HttpStreamResult> {
    this.requests.push(spec);
    if (!this.script.stream) {
      throw new Error('this test did not script a stream()');
    }
    return this.script.stream(spec);
  }
}

function clientWith(
  transport: HttpTransport,
  overrides: { apiKey?: () => Promise<string | undefined>; sleep?: (ms: number, signal: AbortSignal) => Promise<void> } = {}
): OpenRouterClient {
  return new OpenRouterClient({
    transport,
    apiKey: overrides.apiKey ?? (async () => KEY),
    baseUrl: 'https://openrouter.ai/api/v1',
    // Keeps a retry from actually waiting; the delays are asserted directly.
    sleep: overrides.sleep ?? (async () => undefined),
    random: () => 0,
  });
}

function bodyOf(spec: HttpRequestSpec): Record<string, unknown> {
  return JSON.parse(spec.body ?? '{}') as Record<string, unknown>;
}

async function drain(iterator: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of iterator) {
    events.push(event);
  }
  return events;
}

/** One text frame, in the exact shape the wire uses. */
function textFrame(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n`;
}

const USAGE_FRAME = `data: ${JSON.stringify({
  choices: [{ delta: {}, finish_reason: 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.001, prompt_tokens_details: { cached_tokens: 40 } },
})}\n`;

describe('listModels', () => {
  it('returns the data array and sends no Authorization header', async () => {
    const transport = new ScriptedTransport({
      request: () => jsonResponse(200, { data: [{ id: 'a/b' }, { id: 'c/d' }] }),
    });

    const models = await clientWith(transport).listModels(new AbortController().signal);

    expect(models).toHaveLength(2);
    expect(transport.requests[0]?.url).toBe('https://openrouter.ai/api/v1/models');
    // The catalogue endpoint is public. Sending the key would leak a credential
    // to a request that does not need it.
    expect(transport.requests[0]?.headers['Authorization']).toBeUndefined();
  });

  it('refuses a response with no data array rather than reporting zero models', async () => {
    // "No models" and "an unreadable response" are different problems, and an
    // empty model list would silently disable the whole Explorer.
    const transport = new ScriptedTransport({ request: () => jsonResponse(200, { models: [] }) });
    await expect(clientWith(transport).listModels(new AbortController().signal)).rejects.toThrow(
      /no "data" array/
    );
  });

  it('classifies a 429 as retryable and a 401 as not', async () => {
    const limited = new ScriptedTransport({
      request: () => jsonResponse(429, { error: { message: 'slow down' } }),
    });
    await expect(
      clientWith(limited).listModels(new AbortController().signal)
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(OpenRouterError);
      expect((error as OpenRouterError).kind).toBe('rate-limit');
      expect(isRetryable(error)).toBe(true);
      return true;
    });

    const denied = new ScriptedTransport({
      request: () => jsonResponse(401, { error: { message: 'no' } }),
    });
    await expect(
      clientWith(denied).listModels(new AbortController().signal)
    ).rejects.toSatisfy((error: unknown) => {
      expect((error as OpenRouterError).kind).toBe('auth');
      // Retrying a rejected key bills nothing and never succeeds.
      expect(isRetryable(error)).toBe(false);
      return true;
    });
  });
});

describe('getKey', () => {
  it('reads the documented account fields', async () => {
    const transport = new ScriptedTransport({
      request: () =>
        jsonResponse(200, {
          data: {
            label: 'pairpilot',
            usage: 1.25,
            limit: 10,
            limit_remaining: 8.75,
            limit_reset: 'monthly',
            is_free_tier: false,
          },
        }),
    });

    const info = await clientWith(transport).getKey(new AbortController().signal);

    expect(info).toEqual({
      keyLabel: 'pairpilot',
      usageUsd: 1.25,
      limitUsd: 10,
      limitRemainingUsd: 8.75,
      limitReset: 'monthly',
      isFreeTier: false,
    });
    expect(transport.requests[0]?.url).toBe('https://openrouter.ai/api/v1/key');
    expect(transport.requests[0]?.headers['Authorization']).toBe(`Bearer ${KEY}`);
  });

  it('falls back to the older /auth/key path on a 404', async () => {
    const transport = new ScriptedTransport({
      request: (spec) =>
        spec.url.endsWith('/auth/key')
          ? jsonResponse(200, { data: { label: 'legacy' } })
          : jsonResponse(404, { error: { message: 'not found' } }),
    });

    const info = await clientWith(transport).getKey(new AbortController().signal);

    expect(info.keyLabel).toBe('legacy');
    expect(transport.requests.map((r) => r.url)).toEqual([
      'https://openrouter.ai/api/v1/key',
      'https://openrouter.ai/api/v1/auth/key',
    ]);
  });

  it('leaves absent account figures as null', async () => {
    const transport = new ScriptedTransport({ request: () => jsonResponse(200, { data: {} }) });
    const info = await clientWith(transport).getKey(new AbortController().signal);
    expect(info.usageUsd).toBeNull();
    expect(info.limitUsd).toBeNull();
    expect(info.isFreeTier).toBeNull();
  });

  it('reports a missing key as an auth error before going to the network', async () => {
    const transport = new ScriptedTransport({ request: () => jsonResponse(200, { data: {} }) });
    const client = clientWith(transport, { apiKey: async () => undefined });

    await expect(client.getKey(new AbortController().signal)).rejects.toThrow(/No OpenRouter API key/);
    expect(transport.requests).toHaveLength(0);
  });
});

describe('chat', () => {
  it('streams meta, text, usage and finish in order', async () => {
    const transport = new ScriptedTransport({
      stream: () =>
        stream(
          200,
          [
            textFrame('Hello'),
            textFrame(' world'),
            USAGE_FRAME,
            'data: [DONE]\n',
          ],
          { 'x-generation-id': 'gen-123' }
        ),
    });

    const events = await drain(
      clientWith(transport).chat({ model: 'a/b', prompt: 'hi' }, new AbortController().signal)
    );

    expect(events[0]).toEqual({ kind: 'meta', generationId: 'gen-123' });
    expect(events.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text)).toEqual([
      'Hello',
      ' world',
    ]);
    const usage = events.find((e) => e.kind === 'usage');
    expect(usage).toEqual({
      kind: 'usage',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 40,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        reportedCostUsd: 0.001,
      },
    });
    // `finish_reason` and `usage` ride in the same final chunk, so the finish
    // event is emitted before the usage event it accompanies. Asserting the
    // order keeps a future reordering from quietly changing what the provider
    // sees last.
    expect(events.map((e) => e.kind)).toEqual(['meta', 'text', 'text', 'finish', 'usage']);
    expect(events[3]).toEqual({ kind: 'finish', reason: 'stop' });
  });

  it('reads reasoning from reasoning_details and from a bare reasoning string', async () => {
    const transport = new ScriptedTransport({
      stream: () =>
        stream(200, [
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_details: [{ type: 'text', text: 'think' }, { type: 'text', text: 'ing' }] } }] })}\n`,
          // Not documented, but some compatible deployments send it.
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'more' } }] })}\n`,
          'data: [DONE]\n',
        ]),
    });

    const events = await drain(
      clientWith(transport).chat({ model: 'a/b', prompt: 'hi' }, new AbortController().signal)
    );

    expect(events.filter((e) => e.kind === 'reasoning').map((e) => (e as { text: string }).text)).toEqual([
      'thinking',
      'more',
    ]);
  });

  it('sends the prompt with prior turns ahead of it', async () => {
    const transport = new ScriptedTransport({ stream: () => stream(200, ['data: [DONE]\n']) });
    await drain(
      clientWith(transport).chat(
        {
          model: 'a/b',
          prompt: 'second',
          history: [
            { role: 'user', text: 'first' },
            { role: 'assistant', text: 'reply' },
          ],
        },
        new AbortController().signal
      )
    );

    expect(bodyOf(transport.requests[0] as HttpRequestSpec)).toEqual({
      model: 'a/b',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
      stream: true,
    });
  });

  it('uses the token-cap parameter it was given, and sends none when given null', async () => {
    const transport = new ScriptedTransport({ stream: () => stream(200, ['data: [DONE]\n']) });
    const client = clientWith(transport);

    await drain(
      client.chat(
        { model: 'a/b', prompt: 'hi', tokenCap: { parameter: 'max_completion_tokens', value: 4_096 } },
        new AbortController().signal
      )
    );
    expect(bodyOf(transport.requests[0] as HttpRequestSpec)['max_completion_tokens']).toBe(4_096);
    expect(bodyOf(transport.requests[0] as HttpRequestSpec)['max_tokens']).toBeUndefined();

    await drain(
      client.chat({ model: 'a/b', prompt: 'hi', tokenCap: null }, new AbortController().signal)
    );
    const second = bodyOf(transport.requests[1] as HttpRequestSpec);
    expect(second['max_tokens']).toBeUndefined();
    expect(second['max_completion_tokens']).toBeUndefined();
  });

  it('ignores a malformed frame and keeps streaming', async () => {
    const transport = new ScriptedTransport({
      stream: () => stream(200, [textFrame('a'), 'data: {"half\n', textFrame('b'), 'data: [DONE]\n']),
    });

    const events = await drain(
      clientWith(transport).chat({ model: 'a/b', prompt: 'hi' }, new AbortController().signal)
    );

    expect(events.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text)).toEqual(['a', 'b']);
  });

  it('raises an in-band error that rides on a committed 200 stream', async () => {
    // This is the failure a status-code check cannot catch: HTTP already said
    // 200 before the upstream provider failed.
    const transport = new ScriptedTransport({
      stream: () =>
        stream(200, [
          textFrame('partial'),
          `data: ${JSON.stringify({
            error: { code: 402, message: 'Insufficient credits', metadata: { error_type: 'insufficient_credits' } },
          })}\n`,
        ]),
    });

    await expect(
      drain(clientWith(transport).chat({ model: 'a/b', prompt: 'hi' }, new AbortController().signal))
    ).rejects.toSatisfy((error: unknown) => {
      const typed = error as OpenRouterError;
      expect(typed).toBeInstanceOf(OpenRouterError);
      expect(typed.kind).toBe('payment');
      expect(typed.status).toBe(402);
      expect(typed.errorType).toBe('insufficient_credits');
      return true;
    });
  });

  it('raises a stream error when the connection closes with nothing at all', async () => {
    const transport = new ScriptedTransport({ stream: () => stream(200, []) });
    await expect(
      drain(clientWith(transport).chat({ model: 'a/b', prompt: 'hi' }, new AbortController().signal))
    ).rejects.toThrow(/closed the connection before sending any content/);
  });

  it('accepts content without a terminator rather than calling it a failure', async () => {
    // A truncated answer fails later, in the proposal parser, which explains the
    // symptom far better than a generic stream error would.
    const transport = new ScriptedTransport({ stream: () => stream(200, [textFrame('cut off')]) });
    const events = await drain(
      clientWith(transport).chat({ model: 'a/b', prompt: 'hi' }, new AbortController().signal)
    );
    expect(events.filter((e) => e.kind === 'text')).toHaveLength(1);
  });

  it('reports a pre-commit HTTP error from the response body', async () => {
    const transport = new ScriptedTransport({
      stream: () =>
        stream(400, [
          JSON.stringify({ error: { message: 'model not found', metadata: { error_type: 'invalid_request' } } }),
        ]),
    });

    await expect(
      drain(clientWith(transport).chat({ model: 'a/b', prompt: 'hi' }, new AbortController().signal))
    ).rejects.toSatisfy((error: unknown) => {
      expect((error as OpenRouterError).kind).toBe('bad-request');
      expect((error as OpenRouterError).errorType).toBe('invalid_request');
      expect((error as Error).message).toContain('model not found');
      return true;
    });
  });
});

describe('chat retries', () => {
  it('retries a 429 before anything is emitted', async () => {
    let attempt = 0;
    const waits: number[] = [];
    const transport = new ScriptedTransport({
      stream: () => {
        attempt += 1;
        return attempt === 1
          ? stream(429, [JSON.stringify({ error: { message: 'slow down' } })], { 'retry-after': '3' })
          : stream(200, [textFrame('ok'), 'data: [DONE]\n']);
      },
    });

    const events = await drain(
      clientWith(transport, {
        sleep: async (ms) => {
          waits.push(ms);
        },
      }).chat({ model: 'a/b', prompt: 'hi' }, new AbortController().signal)
    );

    expect(attempt).toBe(2);
    // The server's own Retry-After is honoured, not second-guessed.
    expect(waits).toEqual([3_000]);
    expect(events.filter((e) => e.kind === 'text')).toHaveLength(1);
  });

  it('never retries once text has been emitted', async () => {
    // A retry after the first token would re-bill the whole prompt and produce a
    // second, interleaved answer.
    let attempt = 0;
    const transport = new ScriptedTransport({
      stream: () => {
        attempt += 1;
        return attempt === 1
          ? stream(200, [textFrame('partial'), `data: ${JSON.stringify({ error: { code: 500, message: 'upstream died' } })}\n`])
          : stream(200, [textFrame('second answer'), 'data: [DONE]\n']);
      },
    });

    await expect(
      drain(clientWith(transport).chat({ model: 'a/b', prompt: 'hi' }, new AbortController().signal))
    ).rejects.toBeInstanceOf(OpenRouterError);
    expect(attempt).toBe(1);
  });

  it('gives up after three attempts', async () => {
    let attempt = 0;
    const transport = new ScriptedTransport({
      stream: () => {
        attempt += 1;
        return stream(503, [JSON.stringify({ error: { message: 'unavailable' } })]);
      },
    });

    await expect(
      drain(clientWith(transport).chat({ model: 'a/b', prompt: 'hi' }, new AbortController().signal))
    ).rejects.toSatisfy((error: unknown) => (error as OpenRouterError).kind === 'server');
    expect(attempt).toBe(3);
  });

  it('does not retry a bad request', async () => {
    let attempt = 0;
    const transport = new ScriptedTransport({
      stream: () => {
        attempt += 1;
        return stream(400, [JSON.stringify({ error: { message: 'nope' } })]);
      },
    });

    await expect(
      drain(clientWith(transport).chat({ model: 'a/b', prompt: 'hi' }, new AbortController().signal))
    ).rejects.toBeInstanceOf(OpenRouterError);
    expect(attempt).toBe(1);
  });
});

describe('cancellation', () => {
  it('reports an aborted stream as cancelled rather than as a network failure', async () => {
    const controller = new AbortController();
    const transport: HttpTransport = {
      available: true,
      request: async () => jsonResponse(200, {}),
      stream: async () => ({
        status: 200,
        headers: {},
        chunks: (async function* () {
          yield textFrame('a');
          // What an aborted fetch looks like from the caller's side: the
          // rejection is generic, and only the signal says why.
          controller.abort();
          throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
        })(),
      }),
    };

    await expect(
      drain(clientWith(transport).chat({ model: 'a/b', prompt: 'hi' }, controller.signal))
    ).rejects.toSatisfy((error: unknown) => {
      expect((error as OpenRouterError).kind).toBe('cancelled');
      return true;
    });
  });
});

describe('credential redaction', () => {
  it('never puts the key in an error message a server echoed it into', async () => {
    const transport = new ScriptedTransport({
      request: () =>
        jsonResponse(401, {
          error: { message: `The API key ${KEY} was rejected.` },
        }),
    });

    // The client only remembers a key it has actually sent, so make one
    // authenticated call first — the same order the app produces.
    const client = clientWith(transport);
    await client.getKey(new AbortController().signal).catch(() => undefined);

    const error = await client.getKey(new AbortController().signal).catch((e: unknown) => e);
    const message = (error as Error).message;

    expect(message).not.toContain(KEY);
    expect(message).toContain('rejected');
  });

  it('redacts every occurrence, not just the first', () => {
    const text = `first ${KEY} then ${KEY} again`;
    const redacted = redactSecret(text, KEY);
    expect(redacted).not.toContain(KEY);
    expect(redacted.match(/sk-or-v1/g)).toBeNull();
  });

  it('leaves text alone when no key is in hand', () => {
    expect(redactSecret('a message', undefined)).toBe('a message');
    // A very short "secret" would shred unrelated text, so it is not replaced.
    expect(redactSecret('abcdefgh', 'abc')).toBe('abcdefgh');
  });

  it('masks a key down to a recognisable prefix and suffix', async () => {
    const transport = new ScriptedTransport({
      request: () => jsonResponse(401, { error: { message: `bad key ${KEY}` } }),
    });
    const client = clientWith(transport);
    await client.getKey(new AbortController().signal).catch(() => undefined);
    const error = await client.getKey(new AbortController().signal).catch((e: unknown) => e);
    // A short head and tail only: enough to recognise which key it is, not
    // enough to reconstruct it.
    expect((error as Error).message).toContain('sk-or-…6789');
    expect((error as Error).message).not.toContain(KEY);
  });
});

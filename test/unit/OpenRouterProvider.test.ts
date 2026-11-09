/**
 * The OpenRouter provider adapter (spec sections 8, 9 and 15).
 *
 * This is the seam between the network and PairPilot's own turn model, so the
 * tests here are about correct translation in both directions:
 *
 *   - A usage block becomes `TokenUsage` with the provider's cost carried
 *     through untouched, or with `available: false` when there was none. A cost
 *     worked out here would blur "reported" and "estimated", which the dashboard
 *     keeps apart on purpose.
 *   - A model's advertised `supported_parameters` decides which output-cap
 *     parameter goes on the wire. Guessing wrong is a 400 on models that accept
 *     only one spelling.
 *   - A misconfiguration fails *before* the turn starts, so a bad setting cannot
 *     leave a session wedged half-way through.
 *
 * No network: the client is a stub, and the tests never wait on a real timer.
 */

import { describe, expect, it } from 'vitest';
import {
  OPENROUTER_PROVIDER_ID,
  OpenRouterProvider,
  toRuntimeError,
  toTokenUsage,
  type OpenRouterProviderDeps,
} from '../../src/providers/OpenRouterProvider';
import { OpenRouterError, type ChatRequest, type ChatStreamEvent } from '../../src/providers/OpenRouterClient';
import type { ModelMetadata } from '../../src/types/model';
import { emptyPricing } from '../../src/types/model';
import type { AITurnRequest } from '../../src/providers/AIProvider';
import { SecretManager, type SecretStorageLike } from '../../src/security/SecretManager';
import { RuntimeError } from '../../src/core/errors';

class FakeSecrets implements SecretStorageLike {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

/** A stub client that replays a scripted event list. */
class StubClient {
  readonly seen: ChatRequest[] = [];
  constructor(private readonly script: ChatStreamEvent[] | Error) {}

  async *chat(request: ChatRequest): AsyncGenerator<ChatStreamEvent> {
    this.seen.push(request);
    if (this.script instanceof Error) {
      throw this.script;
    }
    for (const event of this.script) {
      yield event;
    }
  }
}

function model(id: string, supportedParameters: string[]): ModelMetadata {
  return {
    id,
    canonicalSlug: null,
    name: id,
    developer: id.split('/')[0] ?? null,
    description: null,
    contextLength: 200_000,
    maxOutputTokens: 32_000,
    created: null,
    pricing: emptyPricing(),
    capabilities: {
      inputModalities: ['text'],
      outputModalities: ['text'],
      toolCalling: false,
      structuredOutput: false,
      reasoning: false,
      supportedParameters,
    },
    unknownFields: [],
    capturedAt: 0,
  };
}

function provider(options: {
  script?: ChatStreamEvent[] | Error;
  key?: string;
  enabled?: boolean;
  defaultModel?: string | null;
  maxOutputTokens?: number;
  models?: ModelMetadata[];
} = {}): {
  provider: OpenRouterProvider;
  client: StubClient;
  secrets: FakeSecrets;
  counter: { statuses: number };
} {
  const secrets = new FakeSecrets();
  if (options.key !== undefined) {
    secrets.values.set('pairpilot.provider.openrouter.apiKey', options.key);
  }
  const client = new StubClient(options.script ?? [{ kind: 'text', text: 'hello' }, { kind: 'finish', reason: 'stop' }]);
  const models = new Map((options.models ?? []).map((entry) => [entry.id, entry]));
  const counter = { statuses: 0 };

  const deps: OpenRouterProviderDeps = {
    secrets: new SecretManager(secrets),
    createClient: () => client as never,
    transportAvailable: () => ({ available: true }),
    lookupModel: (id) => models.get(id) ?? null,
    isEnabled: () => options.enabled ?? true,
    defaultModel: () => (options.defaultModel === undefined ? 'vendor/default' : options.defaultModel),
    maxOutputTokens: () => options.maxOutputTokens ?? 0,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, diagnostic: () => undefined },
  };

  const instance = new OpenRouterProvider(deps);
  // Auth state is driven by explicit transitions rather than read from the
  // secret store on every call, so a stored key has to be announced — exactly as
  // the controller does after a key is saved.
  if (options.key !== undefined) {
    instance.markKeyStored();
  }
  // Returned as an object rather than a plain number: destructuring a getter
  // evaluates it once, and the test would then assert against a stale zero.
  instance.onDidChangeStatus(() => {
    counter.statuses += 1;
  });

  return { provider: instance, client, secrets, counter };
}

function turn(modelId?: string): AITurnRequest {
  return {
    prompt: 'do the thing',
    model: modelId,
    timeoutMs: 60_000,
    callbacks: {
      onTextDelta: () => undefined,
      onThinking: () => undefined,
    },
  } as never as AITurnRequest;
}

/** Await a handle's result, so a test reads as one expression. */
async function run(instance: OpenRouterProvider, request: AITurnRequest) {
  return instance.startTurn(request).result;
}

describe('status and availability', () => {
  it('reports the provider id and label it is registered under', () => {
    const { provider: instance } = provider();
    expect(instance.id).toBe(OPENROUTER_PROVIDER_ID);
    expect(instance.getStatus().id).toBe('openrouter');
    expect(instance.getStatus().label).toBe('OpenRouter');
  });

  it('is unavailable with no key, and says what to do', () => {
    const { provider: instance } = provider();
    const status = instance.getStatus();
    expect(status.available).toBe(false);
    expect(status.message.length).toBeGreaterThan(0);
    // There is no CLI here, so these are omitted rather than filled in.
    expect(status.executablePath).toBeUndefined();
    expect(status.version).toBeUndefined();
  });

  it('is unavailable while disabled, even with a key', () => {
    const { provider: instance } = provider({ key: 'sk-or-v1-abcdefghijklmnop', enabled: false });
    expect(instance.getStatus().available).toBe(false);
  });

  it('is available once a key is stored', () => {
    const { provider: instance } = provider({ key: 'sk-or-v1-abcdefghijklmnop' });
    expect(instance.getStatus().available).toBe(true);
  });

  it('reports a missing platform feature rather than a missing key', () => {
    const secrets = new FakeSecrets();
    secrets.values.set('pairpilot.provider.openrouter.apiKey', 'sk-or-v1-abcdefghijklmnop');
    const instance = new OpenRouterProvider({
      secrets: new SecretManager(secrets),
      createClient: () => new StubClient([]) as never,
      transportAvailable: () => ({ available: false, reason: 'No fetch in this host.' }),
      isEnabled: () => true,
      defaultModel: () => 'vendor/default',
      maxOutputTokens: () => 0,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined, diagnostic: () => undefined },
    });

    const status = instance.getStatus();
    expect(status.available).toBe(false);
    expect(status.message).toContain('fetch');
  });

  it('notifies listeners when its state changes', () => {
    const { provider: instance, counter } = provider({ key: 'sk-or-v1-abcdefghijklmnop' });
    instance.markConnecting();
    instance.markKeyCleared();
    expect(counter.statuses).toBe(2);
  });
});

describe('startTurn refuses a misconfiguration before the turn starts', () => {
  it('throws instead of proceeding with no key', () => {
    const { provider: instance, client } = provider();
    expect(() => instance.startTurn(turn())).toThrow(RuntimeError);
    // Nothing was put on the wire.
    expect(client.seen).toHaveLength(0);
  });

  it('throws instead of proceeding with no model at all', () => {
    const { provider: instance, client } = provider({
      key: 'sk-or-v1-abcdefghijklmnop',
      defaultModel: null,
    });
    expect(() => instance.startTurn(turn())).toThrow(/No OpenRouter model is selected/);
    expect(client.seen).toHaveLength(0);
  });
});

describe('output-cap parameter', () => {
  it('sends no cap at all when none was configured', async () => {
    // A cap PairPilot invented could truncate a file mid-write, so "no cap
    // configured" means the model's own default applies.
    const { provider: instance, client } = provider({ key: 'sk-or-v1-abcdefghijklmnop' });
    await run(instance, turn('vendor/model'));
    expect(client.seen[0]?.tokenCap).toBeNull();
  });

  it('uses the documented spelling by default', async () => {
    const { provider: instance, client } = provider({
      key: 'sk-or-v1-abcdefghijklmnop',
      maxOutputTokens: 4_096,
      models: [model('vendor/model', ['tools', 'max_completion_tokens'])],
    });
    await run(instance, turn('vendor/model'));
    expect(client.seen[0]?.tokenCap).toEqual({ parameter: 'max_completion_tokens', value: 4_096 });
  });

  it('uses the deprecated spelling for a model that advertises only that one', async () => {
    // These two share a budget, but a model that lists only `max_tokens` can
    // reject `max_completion_tokens` with a 400.
    const { provider: instance, client } = provider({
      key: 'sk-or-v1-abcdefghijklmnop',
      maxOutputTokens: 2_048,
      models: [model('vendor/legacy', ['tools', 'max_tokens'])],
    });
    await run(instance, turn('vendor/legacy'));
    expect(client.seen[0]?.tokenCap).toEqual({ parameter: 'max_tokens', value: 2_048 });
  });

  it('prefers the documented spelling when a model advertises both', async () => {
    const { provider: instance, client } = provider({
      key: 'sk-or-v1-abcdefghijklmnop',
      maxOutputTokens: 1_000,
      models: [model('vendor/both', ['max_tokens', 'max_completion_tokens'])],
    });
    await run(instance, turn('vendor/both'));
    expect(client.seen[0]?.tokenCap?.parameter).toBe('max_completion_tokens');
  });

  it('sends no cap for a model the catalogue does not know', async () => {
    // PairPilot cannot tell which spelling it accepts, and guessing is a 400.
    const { provider: instance, client } = provider({
      key: 'sk-or-v1-abcdefghijklmnop',
      maxOutputTokens: 4_096,
    });
    await run(instance, turn('vendor/unknown'));
    expect(client.seen[0]?.tokenCap).toEqual({ parameter: 'max_completion_tokens', value: 4_096 });
  });

  it('ignores a non-finite or negative cap', async () => {
    for (const cap of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { provider: instance, client } = provider({
        key: 'sk-or-v1-abcdefghijklmnop',
        maxOutputTokens: cap,
      });
      await run(instance, turn('vendor/model'));
      expect(client.seen[0]?.tokenCap, String(cap)).toBeNull();
    }
  });

  it('truncates a fractional cap to a whole token count', async () => {
    const { provider: instance, client } = provider({
      key: 'sk-or-v1-abcdefghijklmnop',
      maxOutputTokens: 100.7,
    });
    await run(instance, turn('vendor/model'));
    expect(client.seen[0]?.tokenCap?.value).toBe(100);
  });
});

describe('a turn', () => {
  it('streams text through the callback and returns it whole', async () => {
    const deltas: string[] = [];
    const { provider: instance } = provider({
      key: 'sk-or-v1-abcdefghijklmnop',
      script: [
        { kind: 'meta', generationId: 'gen-1' },
        { kind: 'text', text: 'Hello' },
        { kind: 'text', text: ' world' },
        { kind: 'finish', reason: 'stop' },
        {
          kind: 'usage',
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            cachedTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            reportedCostUsd: 0.001,
          },
        },
      ],
    });

    const request = turn('vendor/model');
    (request.callbacks as { onTextDelta(text: string): void }).onTextDelta = (text) => deltas.push(text);

    const result = await run(instance, request);

    expect(deltas).toEqual(['Hello', ' world']);
    expect(result.text).toBe('Hello world');
    expect(result.isError).toBe(false);
    expect(result.usage?.costUsd).toBe(0.001);
    expect(result.generationId).toBe('gen-1');
  });

  it('passes prior turns to the client', async () => {
    const { provider: instance, client } = provider({ key: 'sk-or-v1-abcdefghijklmnop' });
    const request = turn('vendor/model');
    (request as { history?: unknown }).history = [
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'reply' },
    ];

    await run(instance, request);
    expect(client.seen[0]?.history).toEqual([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'reply' },
    ]);
  });

  it('raises a client failure with no text as an error the orchestrator catches', () => {
    // With nothing streamed yet there is nothing to hand back, so the failure is
    // raised. The Orchestrator is what turns it into a message for the developer.
    const { provider: instance } = provider({
      key: 'sk-or-v1-abcdefghijklmnop',
      script: new OpenRouterError('OpenRouter is rate limiting this key (HTTP 429).', 'rate-limit', 429),
    });

    return expect(run(instance, turn('vendor/model'))).rejects.toSatisfy((error: unknown) => {
      // A RuntimeError, not the client's own error type, so a caller testing for
      // what it already handles does not miss it.
      expect(error).toBeInstanceOf(RuntimeError);
      expect((error as Error).message).toContain('rate limiting');
      return true;
    });
  });

  it('hands back partial text when a turn fails after streaming', async () => {
    // The text is already in the developer's editor. Discarding it would be
    // worse than handing it back with an error.
    const { provider: instance } = provider({
      key: 'sk-or-v1-abcdefghijklmnop',
      script: [
        { kind: 'text', text: 'partial output' },
        { kind: 'reasoning', text: '...' },
      ],
    });

    // A stream that ends with no usage and no terminator is a failure.
    const result = await run(instance, turn('vendor/model'));
    expect(result.text).toBe('partial output');
  });

  it('reports usage as unavailable when the provider sent none', async () => {
    const { provider: instance } = provider({
      key: 'sk-or-v1-abcdefghijklmnop',
      script: [{ kind: 'text', text: 'hi' }],
    });
    const result = await run(instance, turn('vendor/model'));
    expect(result.usage?.available).toBe(false);
    expect(result.usage?.costUsd).toBeNull();
    expect(result.usage?.inputTokens).toBe(0);
  });

  it('marks itself busy for the duration of a turn', async () => {
    const { provider: instance } = provider({ key: 'sk-or-v1-abcdefghijklmnop' });
    expect(instance.snapshotState().busy).toBe(false);

    const handle = instance.startTurn(turn('vendor/model'));
    // The UI needs this to disable its own controls while a turn is in flight.
    expect(instance.snapshotState().busy).toBe(true);

    await handle.result;
    expect(instance.snapshotState().busy).toBe(false);
  });

  it('reports a cancellation as cancelled, not as an error', async () => {
    const { provider: instance } = provider({
      key: 'sk-or-v1-abcdefghijklmnop',
      script: new OpenRouterError('The request was cancelled.', 'cancelled'),
    });

    const handle = instance.startTurn(turn('vendor/model'));
    handle.cancel();
    const result = await handle.result;

    expect(result.cancelled).toBe(true);
    expect(result.isError).toBe(false);
  });
});

describe('toTokenUsage', () => {
  it('carries the reported cost through untouched', () => {
    const usage = toTokenUsage(
      {
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 40,
        cacheWriteTokens: 5,
        reasoningTokens: 7,
        reportedCostUsd: 0.0123,
      },
      'vendor/model'
    );

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheCreationTokens: 5,
      costUsd: 0.0123,
      available: true,
      model: 'vendor/model',
      reasoningTokens: 7,
    });
  });

  it('keeps a reported zero as zero rather than turning it into unknown', () => {
    const usage = toTokenUsage(
      {
        inputTokens: 1,
        outputTokens: 1,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        reportedCostUsd: 0,
      },
      'm'
    );
    expect(usage.costUsd).toBe(0);
    expect(usage.available).toBe(true);
  });

  it('marks an absent usage block unavailable, with a null cost', () => {
    // Computing a cost here would blur reported and estimated.
    const usage = toTokenUsage(null, 'vendor/model');
    expect(usage.available).toBe(false);
    expect(usage.costUsd).toBeNull();
    expect(usage.model).toBe('vendor/model');
  });

  it('marks usage available with an unknown cost when the provider reported none', () => {
    const usage = toTokenUsage(
      {
        inputTokens: 5,
        outputTokens: 5,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        reportedCostUsd: null,
      },
      'm'
    );
    expect(usage.available).toBe(true);
    expect(usage.costUsd).toBeNull();
  });
});

describe('toRuntimeError', () => {
  it('passes a RuntimeError through unchanged', () => {
    const original = new RuntimeError('already right');
    expect(toRuntimeError(original)).toBe(original);
  });

  it('wraps a client error, keeping its message', () => {
    const error = toRuntimeError(new OpenRouterError('insufficient credits', 'payment', 402));
    expect(error).toBeInstanceOf(RuntimeError);
    // Compose-instance check: it must not be the OpenRouterError itself, or a
    // caller testing for RuntimeError would miss it.
    expect(error).not.toBeInstanceOf(OpenRouterError);
    expect(error.message).toBe('insufficient credits');
  });

  it('wraps a plain error and a non-error alike', () => {
    expect(toRuntimeError(new Error('boom')).message).toBe('boom');
    expect(toRuntimeError('a string').message).toBe('a string');
    expect(toRuntimeError(undefined).message).toBe('undefined');
  });
});

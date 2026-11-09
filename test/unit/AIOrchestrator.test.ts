/**
 * AIOrchestrator — where a turn is started and what it cost (spec sections 9,
 * 12 and 14).
 *
 * This class sits between the workflows and the providers, and it is the only
 * place that holds a turn's token counts and its model id at the same time. That
 * position makes four properties worth pinning, and each of them is a way the
 * rest of the app would otherwise be able to lie:
 *
 *  1. **The model sent to a provider comes from the selection chain, and only a
 *     remote provider is told one.** A local CLI picks its own model, so naming
 *     one would be a claim PairPilot cannot keep.
 *  2. **A completed turn writes exactly one cost row, or none when there was
 *     nothing to bill.** A turn that produced neither usage nor text is not
 *     recorded, because a zero-cost row would inflate the request count.
 *  3. **Bookkeeping never fails a turn.** The code has already been written and
 *     approved by the time the row is written; a storage error must not turn
 *     that into a failed operation.
 *  4. **"Recently used" means used.** The list is written here, from a turn that
 *     ran on a catalogue model — not from a selection, which would let a model
 *     chosen and never tried outrank one that had just written code.
 *
 * The tests run in plain Node against the real collaborators — no `vscode`, no
 * network, no key — which is the property the class's own doc comment claims.
 */

import { describe, expect, it } from 'vitest';

import { RuntimeError } from '../../src/core/errors';
import { ModelRegistry, type CatalogStorageLike } from '../../src/models/ModelRegistry';
import {
  ModelSelectionService,
  type SelectionStorageLike,
} from '../../src/models/ModelSelectionService';
import { AIOrchestrator, type StartTurnOptions } from '../../src/orchestration/AIOrchestrator';
import { UsageTracker, type UsageStorageLike } from '../../src/pricing/UsageTracker';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { emptyUsage, type Logger, type TurnResult } from '../../src/types';
import type { ProviderId } from '../../src/types/provider';
import type { AITurnRequest, AIProvider, AIProviderStatus } from '../../src/types/provider';

/** An in-memory `vscode.Memento`, with named keys that refuse to be written. */
class FakeStorage implements CatalogStorageLike, SelectionStorageLike, UsageStorageLike {
  readonly values = new Map<string, unknown>();
  /** Keys whose writes fail, so the bookkeeping guards can be reached. */
  readonly failing = new Set<string>();

  get<T>(key: string, defaultValue: T): T {
    return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (this.failing.has(key)) {
      throw new Error(`storage refused the write to ${key}`);
    }
    this.values.set(key, value);
  }
}

/** The keys the two parties below actually write, named so a test can fail one. */
const HISTORY_KEY = 'pairpilot.usage.history.v1';
const RECENT_KEY = 'pairpilot.models.recent.v1';

function entry(id: string, prompt = '0.000001', completion = '0.000002'): Record<string, unknown> {
  return {
    id,
    name: id,
    context_length: 100_000,
    pricing: { prompt, completion },
    supported_parameters: ['tools'],
  };
}

function turn(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    text: 'done',
    usage: emptyUsage(),
    isError: false,
    cancelled: false,
    ...overrides,
  };
}

function usage(input: number, output: number, costUsd: number | null, model?: string) {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd,
    available: true,
    ...(model === undefined ? {} : { model }),
  };
}

interface FakeProvider extends AIProvider {
  readonly requests: AITurnRequest[];
  readonly calls: { requireAvailable: number; cancel: number };
  /** What the next turn resolves to. */
  answerWith(result: TurnResult): void;
  /** Make the next turn reject, as a provider that failed mid-flight would. */
  failWith(error: Error): void;
  setAvailable(available: boolean, message?: string): void;
}

function fakeProvider(id: ProviderId, available = true): FakeProvider {
  const listeners = new Set<(status: AIProviderStatus) => void>();
  const requests: AITurnRequest[] = [];
  const calls = { requireAvailable: 0, cancel: 0 };
  let status: AIProviderStatus = {
    id,
    label: id,
    available,
    message: available ? `${id} is ready` : `${id} is not available`,
  };
  let next: TurnResult = turn();
  let failure: Error | null = null;

  const provider: FakeProvider = {
    id,
    label: id,
    requests,
    calls,
    getStatus: () => status,
    detect: async () => status,
    requireAvailable: () => {
      calls.requireAvailable += 1;
      if (!status.available) {
        throw new RuntimeError(status.message);
      }
    },
    startTurn: (request) => {
      requests.push(request);
      return {
        result: failure === null ? Promise.resolve(next) : Promise.reject(failure),
        cancel: () => {
          calls.cancel += 1;
        },
        isRunning: false,
      };
    },
    onDidChangeStatus: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    answerWith: (result) => {
      next = result;
      failure = null;
    },
    failWith: (error) => {
      failure = error;
    },
    setAvailable: (nowAvailable, message) => {
      status = { ...status, available: nowAvailable, message: message ?? status.message };
      for (const listener of listeners) {
        listener(status);
      }
    },
  };

  return provider;
}

/** A fixed local midday, so a timestamp never sits on a day boundary. */
const BASE = new Date(2026, 4, 10, 12, 0, 0).getTime();

interface Harness {
  orchestrator: AIOrchestrator;
  catalog: ModelRegistry;
  selection: ModelSelectionService;
  usage: UsageTracker;
  storage: FakeStorage;
  cli: FakeProvider;
  remote: FakeProvider;
  warnings: string[];
  budgetEvents: { spentUsd: number; limitUsd: number }[];
  /** Move the injected clock, for the budget and timestamp checks. */
  advance(ms: number): void;
  /** Make the usage record's own id factory throw, to reach the outer guard. */
  breakUsageIds(): void;
}

async function harness(
  options: {
    active?: ProviderId;
    available?: boolean;
    entries?: string[];
    budgetUsd?: number;
    projectPath?: string | null;
  } = {}
): Promise<Harness> {
  const storage = new FakeStorage();
  const warnings: string[] = [];
  const logger: Logger = {
    info: () => undefined,
    warn: (message) => void warnings.push(message),
    error: () => undefined,
    diagnostic: () => undefined,
  };

  const clock = { at: BASE };
  let ids = 0;
  let brokenIds = false;
  const cli = fakeProvider('claude-code');
  const remote = fakeProvider('openrouter', options.available ?? true);
  const providers = new ProviderRegistry();
  providers.register(cli);
  providers.register(remote);
  providers.select(options.active ?? 'openrouter');

  const catalog = new ModelRegistry({
    storage,
    fetchModels: async () =>
      (options.entries ?? ['vendor/one', 'vendor/two']).map((id) => entry(id)),
    logger,
    now: () => clock.at,
  });
  await catalog.refresh();

  const selection = new ModelSelectionService(storage);
  selection.load();

  const usage = new UsageTracker({
    storage,
    logger,
    now: () => clock.at,
    newId: () => {
      if (brokenIds) {
        throw new Error('id factory unavailable');
      }
      return `usage-${++ids}`;
    },
  });
  usage.load();

  const budgetEvents: { spentUsd: number; limitUsd: number }[] = [];
  const orchestrator = new AIOrchestrator({
    providers,
    selection,
    catalog,
    usage,
    logger,
    workspaceRoot: () => options.projectPath ?? '/repo',
    sessionId: () => 'session-1',
    budgetUsd: () => options.budgetUsd ?? 0,
    onBudgetExceeded: (spentUsd, limitUsd) => void budgetEvents.push({ spentUsd, limitUsd }),
    now: () => clock.at,
    newId: () => `session-${++ids}`,
  });

  return {
    orchestrator,
    catalog,
    selection,
    usage,
    storage,
    cli,
    remote,
    warnings,
    budgetEvents,
    advance: (ms) => {
      clock.at += ms;
    },
    breakUsageIds: () => {
      brokenIds = true;
    },
  };
}

function options(overrides: Partial<StartTurnOptions> = {}): StartTurnOptions {
  return {
    role: 'coding',
    prompt: 'add a function',
    cwd: '/repo',
    timeoutMs: 1_000,
    scanCode: true,
    callbacks: { onTextDelta: () => undefined, onCodeDelta: () => undefined },
    ...overrides,
  };
}

describe('dispatch: which model a turn runs on', () => {
  it('sends the selected model when the active provider is a remote one', async () => {
    const h = await harness();
    await h.selection.setGlobal('vendor/one');

    await h.orchestrator.startTurn(options()).result;

    expect(h.remote.requests).toHaveLength(1);
    expect(h.remote.requests[0]?.model).toBe('vendor/one');
  });

  it('omits the model entirely for the local CLI, which chooses its own', async () => {
    // Absent and "explicitly the default" are different facts. Sending a model
    // id to a CLI that ignores it would make the selection screen a lie.
    const h = await harness({ active: 'claude-code' });
    await h.selection.setGlobal('vendor/one');

    await h.orchestrator.startTurn(options()).result;

    expect(h.cli.requests).toHaveLength(1);
    expect(h.cli.requests[0]?.model).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(h.cli.requests[0], 'model')).toBe(false);
  });

  it('resolves through the whole inheritance chain, not just the global level', async () => {
    const h = await harness();
    await h.selection.setGlobal('vendor/one');
    await h.selection.setProject('/repo', 'vendor/two');

    expect(h.orchestrator.resolveModel('coding').modelId).toBe('vendor/two');
    expect(h.orchestrator.resolveModel('coding').sourceLabel).toContain('Project');
  });

  it('refuses a turn whose provider is unavailable, before a handle exists', async () => {
    // Thrown, not rejected: the caller finds out before a handle exists, so
    // there is no in-flight turn to clean up.
    const h = await harness({ available: false });

    expect(() => h.orchestrator.startTurn(options())).toThrow(RuntimeError);
    expect(h.remote.requests).toHaveLength(0);
  });

  it('hands the provider its own cancel() and isRunning, unwrapped', async () => {
    const h = await harness();
    const handle = h.orchestrator.startTurn(options());

    handle.cancel();

    expect(h.remote.calls.cancel).toBe(1);
    expect(handle.isRunning).toBe(false);
    await handle.result;
  });

  it('passes conversation history only to a provider that cannot resume', async () => {
    const history = [{ role: 'user' as const, text: 'earlier' }];

    const remote = await harness();
    await remote.orchestrator.startTurn(options({ history })).result;
    expect(remote.remote.requests[0]?.history).toEqual(history);

    // The CLI has a server-side thread to resume, so sending the history too
    // would bill the developer for the same conversation twice.
    const cli = await harness({ active: 'claude-code' });
    await cli.orchestrator.startTurn(options({ history })).result;
    expect(cli.cli.requests[0]?.history).toBeUndefined();
  });

  it('leaves history off a remote request when there is none to send', async () => {
    const h = await harness();

    await h.orchestrator.startTurn(options({ history: [] })).result;

    expect(h.remote.requests[0]?.history).toBeUndefined();
  });
});

describe('recording what a turn cost', () => {
  it('writes one row with the model, the tokens and the provider’s own cost', async () => {
    const h = await harness();
    h.remote.answerWith(
      turn({ text: 'done', usage: usage(1_000, 200, 0.0125, 'vendor/one') })
    );

    await h.orchestrator.startTurn(options({ taskLabel: 'add a function' })).result;

    const rows = h.usage.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerId: 'openrouter',
      modelId: 'vendor/one',
      role: 'coding',
      task: 'add a function',
      sessionId: 'session-1',
      projectPath: '/repo',
      inputTokens: 1_000,
      outputTokens: 200,
      usageAvailable: true,
    });
    // A cost the provider published is reported, not re-derived from prices.
    expect(rows[0]?.cost.source).toBe('reported');
    expect(rows[0]?.cost.totalUsd).toBeCloseTo(0.0125, 10);
  });

  it('prices an unreported turn from the catalogue and says it is an estimate', async () => {
    const h = await harness({ entries: ['vendor/one'] });
    h.remote.answerWith(turn({ usage: usage(1_000_000, 0, null, 'vendor/one') }));

    await h.orchestrator.startTurn(options()).result;

    const row = h.usage.list()[0];
    expect(row?.cost.source).toBe('estimated');
    // $1 per million input tokens, published by the catalogue.
    expect(row?.cost.totalUsd).toBeCloseTo(1, 10);
  });

  it('leaves the cost unavailable when neither the provider nor the catalogue priced it', async () => {
    const h = await harness();
    h.remote.answerWith(turn({ usage: usage(500, 500, null, 'vendor/gone') }));

    await h.orchestrator.startTurn(options()).result;

    const row = h.usage.list()[0];
    expect(row?.cost.source).toBe('unavailable');
    expect(row?.cost.totalUsd).toBeNull();
  });

  it('records a turn that produced no usage but did produce text', async () => {
    // A stream that dies after half an answer was still billed.
    const h = await harness();
    h.remote.answerWith(turn({ text: 'partial answer', usage: emptyUsage() }));

    await h.orchestrator.startTurn(options()).result;

    const rows = h.usage.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.usageAvailable).toBe(false);
    expect(rows[0]?.cost.totalUsd).toBeNull();
  });

  it('records nothing for a turn that produced neither usage nor text', async () => {
    const h = await harness();
    h.remote.answerWith(turn({ text: '', usage: emptyUsage() }));

    await h.orchestrator.startTurn(options()).result;

    expect(h.usage.list()).toHaveLength(0);
  });

  it('keeps the turn and the row when the history cannot be persisted', async () => {
    // By this point the code has been written and approved. Losing the
    // bookkeeping is a warning, not a failed operation — and the row stays in
    // memory, so this session's totals are still complete.
    const h = await harness();
    h.remote.answerWith(turn({ text: 'written', usage: usage(10, 10, 0.01, 'vendor/one') }));
    h.storage.failing.add(HISTORY_KEY);

    const result = await h.orchestrator.startTurn(options()).result;

    expect(result.text).toBe('written');
    expect(h.usage.list()).toHaveLength(1);
    expect(h.warnings.join('\n')).toContain('could not save its usage history');
  });

  it('never fails the turn when the row cannot be built at all', async () => {
    // The usage row goes through the Orchestrator's own guard only when
    // `record` throws outright, which the storage below cannot cause (it
    // swallows its own write failure). An id factory that throws is the blunt
    // way to reach it, and it tests the property the guard exists for: the turn
    // is already written and approved, so bookkeeping cannot fail it.
    const h = await harness();
    h.remote.answerWith(turn({ text: 'written', usage: usage(10, 10, 0.01, 'vendor/one') }));
    h.breakUsageIds();

    const result = await h.orchestrator.startTurn(options()).result;

    expect(result.text).toBe('written');
    expect(h.usage.list()).toHaveLength(0);
    expect(h.warnings.join('\n')).toContain('could not record usage');
  });

  it('keeps the turn when the recently-used list cannot be written', async () => {
    const h = await harness();
    h.remote.answerWith(turn({ usage: usage(10, 10, 0.01, 'vendor/one') }));
    // Only the recent-list write fails; the usage row is written first and
    // normally, which is what makes the two warnings distinguishable.
    h.storage.failing.add(RECENT_KEY);

    const result = await h.orchestrator.startTurn(options()).result;

    expect(result.text).toBe('done');
    expect(h.usage.list()).toHaveLength(1);
    expect(h.warnings.join('\n')).toContain('could not update its recently-used models');
    // And the message does not claim the usage row was lost, because it was not.
    expect(h.warnings.join('\n')).not.toContain('could not record usage');
  });

  it('stamps the row with the clock it was given, not with the wall clock', async () => {
    // The dashboard's daily history is only correct if every row is dated by
    // the same clock, including the one a test injects.
    const h = await harness();
    h.remote.answerWith(turn({ usage: usage(10, 10, 0.01, 'vendor/one') }));
    h.advance(90 * 60_000);

    await h.orchestrator.startTurn(options()).result;

    expect(h.usage.list()[0]?.at).toBe(BASE + 90 * 60_000);
  });

  it('records nothing when the turn itself throws', async () => {
    const h = await harness();
    h.remote.failWith(new RuntimeError('provider exploded'));

    await expect(h.orchestrator.startTurn(options()).result).rejects.toThrow('provider exploded');

    expect(h.usage.list()).toHaveLength(0);
    expect(h.catalog.recentIds()).toEqual([]);
  });
});

describe('recently used', () => {
  it('marks the model once a turn has actually run on it', async () => {
    const h = await harness();
    h.remote.answerWith(turn({ usage: usage(10, 10, 0.01, 'vendor/one') }));
    expect(h.catalog.recentIds()).toEqual([]);

    await h.orchestrator.startTurn(options()).result;

    expect(h.catalog.recentIds()).toEqual(['vendor/one']);
  });

  it('marks the requested model when the provider reports no model of its own', async () => {
    const h = await harness();
    await h.selection.setGlobal('vendor/two');
    h.remote.answerWith(turn({ usage: usage(10, 10, 0.01) }));

    await h.orchestrator.startTurn(options()).result;

    expect(h.catalog.recentIds()).toEqual(['vendor/two']);
  });

  it('marks nothing for a model the catalogue does not carry', async () => {
    // The CLI reports its own model id, which the Explorer could never offer
    // back. A recent pick that cannot be shown is worse than no pick.
    const h = await harness({ active: 'claude-code' });
    h.cli.answerWith(turn({ usage: usage(10, 10, 0.01, 'claude-sonnet-4-5') }));

    await h.orchestrator.startTurn(options()).result;

    expect(h.usage.list()).toHaveLength(1);
    expect(h.catalog.recentIds()).toEqual([]);
  });

  it('keeps the most recent first, and does not repeat a model', async () => {
    const h = await harness();
    h.remote.answerWith(turn({ usage: usage(10, 10, 0.01, 'vendor/one') }));
    await h.orchestrator.startTurn(options()).result;
    h.remote.answerWith(turn({ usage: usage(10, 10, 0.01, 'vendor/two') }));
    await h.orchestrator.startTurn(options()).result;
    h.remote.answerWith(turn({ usage: usage(10, 10, 0.01, 'vendor/one') }));
    await h.orchestrator.startTurn(options()).result;

    expect(h.catalog.recentIds()).toEqual(['vendor/one', 'vendor/two']);
  });
});

describe('the budget warning', () => {
  it('warns once when a turn crosses the limit, and still runs it', async () => {
    const h = await harness({ budgetUsd: 0.005 });
    h.remote.answerWith(turn({ usage: usage(10, 10, 0.01, 'vendor/one') }));

    await h.orchestrator.startTurn(options()).result;
    await h.orchestrator.startTurn(options()).result;

    expect(h.budgetEvents).toHaveLength(1);
    expect(h.budgetEvents[0]?.limitUsd).toBe(0.005);
    // Two turns ran and two rows were written: the limit warns, it does not gate.
    expect(h.usage.list()).toHaveLength(2);
    expect(h.remote.requests).toHaveLength(2);
  });

  it('says nothing when no limit is configured', async () => {
    const h = await harness();
    h.remote.answerWith(turn({ usage: usage(10, 10, 5, 'vendor/one') }));

    await h.orchestrator.startTurn(options()).result;

    expect(h.budgetEvents).toEqual([]);
  });

  it('warns again in a new session', async () => {
    const h = await harness({ budgetUsd: 0.005 });
    h.remote.answerWith(turn({ usage: usage(10, 10, 0.01, 'vendor/one') }));
    await h.orchestrator.startTurn(options()).result;
    await h.orchestrator.startTurn(options()).result;
    expect(h.budgetEvents).toHaveLength(1);

    h.orchestrator.resetBudgetWarning();
    await h.orchestrator.startTurn(options()).result;

    expect(h.budgetEvents).toHaveLength(2);
  });
});

describe('provider availability, for callers that only need the status', () => {
  it('reports the active provider as usable or not', async () => {
    const available = await harness();
    expect(available.orchestrator.isActiveAvailable()).toBe(true);

    const unavailable = await harness({ available: false });
    unavailable.remote.setAvailable(false, 'OpenRouter is switched off.');
    expect(unavailable.orchestrator.isActiveAvailable()).toBe(false);
  });

  it('throws the provider’s own message, so the UI can show an actionable one', async () => {
    const h = await harness();
    h.remote.setAvailable(false, 'No OpenRouter API key is stored.');

    expect(() => h.orchestrator.requireProvider()).toThrow('No OpenRouter API key is stored.');
  });
});

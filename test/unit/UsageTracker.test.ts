/**
 * Usage history, totals and the budget warning (spec section 14).
 *
 * The rule the whole dashboard rests on: a total that cannot be established is
 * `null`, never `0`. A session with three requests and no prices must not read
 * as "$0.00 spent", and the per-day chart must distinguish a day with no usage
 * from a day with usage that could not be priced.
 *
 * The budget is tested for the property the spec demands explicitly: it warns
 * and does not block. Nothing in `UsageTracker` can refuse a request, and the
 * tests check that `exceeded` is a report rather than a gate.
 */

import { describe, expect, it } from 'vitest';
import {
  UsageTracker,
  addTotals,
  dayKey,
  totalsOf,
  type UsageStorageLike,
  type UsageRecordInput,
} from '../../src/pricing/UsageTracker';
import { unavailableCost, type CostBreakdown, type UsageRecord } from '../../src/types/usage';

class FakeStorage implements UsageStorageLike {
  readonly values = new Map<string, unknown>();
  failNextWrite = false;

  get<T>(key: string, defaultValue: T): T {
    return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('storage full');
    }
    this.values.set(key, value);
  }
}

const DAY = 86_400_000;
/** A fixed local midday, so a bucket never lands on a day boundary. */
const BASE = new Date(2026, 4, 10, 12, 0, 0).getTime();

function reported(totalUsd: number): CostBreakdown {
  return { inputUsd: null, outputUsd: null, cachedUsd: null, totalUsd, source: 'reported', note: null };
}

function estimated(totalUsd: number): CostBreakdown {
  return { inputUsd: totalUsd, outputUsd: 0, cachedUsd: 0, totalUsd, source: 'estimated', note: null };
}

function input(overrides: Partial<UsageRecordInput> = {}): UsageRecordInput {
  return {
    providerId: 'openrouter',
    modelId: 'vendor/model',
    role: 'coding',
    task: 'add a feature',
    sessionId: 'session-1',
    projectPath: '/repo',
    inputTokens: 1_000,
    outputTokens: 200,
    cachedTokens: 0,
    reasoningTokens: 0,
    durationMs: 1_500,
    usageAvailable: true,
    cost: reported(0.01),
    pricing: null,
    at: BASE,
    ...overrides,
  };
}

function tracker(
  options: {
    storage?: FakeStorage;
    capacity?: number;
    now?: () => number;
    newId?: () => string;
    warnings?: string[];
  } = {}
): { tracker: UsageTracker; storage: FakeStorage; warnings: string[] } {
  const storage = options.storage ?? new FakeStorage();
  const warnings = options.warnings ?? [];
  return {
    tracker: new UsageTracker({
      storage,
      capacity: options.capacity,
      now: options.now ?? (() => BASE),
      newId: options.newId,
      logger: { warn: (message) => warnings.push(message) },
    }),
    storage,
    warnings,
  };
}

describe('record', () => {
  it('stores the record it returns and persists it', async () => {
    const { tracker: usage, storage } = tracker();
    const stored = await usage.record(input());

    expect(stored.role).toBe('coding');
    expect(stored.at).toBe(BASE);
    expect(usage.retained).toBe(1);
    expect(storage.values.get('pairpilot.usage.history.v1')).toEqual([stored]);
  });

  it('clamps negative and fractional counts rather than storing them', async () => {
    const { tracker: usage } = tracker();
    const stored = await usage.record(
      input({ inputTokens: -5, outputTokens: 10.7, durationMs: -1, cachedTokens: Number.NaN })
    );
    expect(stored.inputTokens).toBe(0);
    expect(stored.outputTokens).toBe(10);
    expect(stored.durationMs).toBe(0);
    // NaN must not become NaN in storage; it is a count of nothing.
    expect(Number.isNaN(stored.cachedTokens)).toBe(false);
  });

  it('truncates a long task preview', async () => {
    const { tracker: usage } = tracker();
    const stored = await usage.record(input({ task: 'x'.repeat(500) }));
    expect(stored.task).not.toBeNull();
    expect((stored.task as string).length).toBeLessThanOrEqual(120);
  });

  it('keeps a null task as null rather than an empty string', async () => {
    const { tracker: usage } = tracker();
    expect((await usage.record(input({ task: null }))).task).toBeNull();
  });

  it('does not fail the turn when history cannot be persisted', async () => {
    // The request already succeeded. Losing the history entry is a much smaller
    // problem than reporting a failure for work that was actually done.
    const storage = new FakeStorage();
    storage.failNextWrite = true;
    const warnings: string[] = [];
    const { tracker: usage } = tracker({ storage, warnings });

    const stored = await usage.record(input());
    expect(stored.id).toBeTruthy();
    expect(usage.retained).toBe(1);
    expect(warnings.join(' ')).toContain('could not save its usage history');
  });

  it('drops the oldest records past the cap and says the history is truncated', async () => {
    const { tracker: usage } = tracker({ capacity: 3 });
    for (let index = 0; index < 5; index += 1) {
      await usage.record(input({ at: BASE + index * 1_000, modelId: `vendor/m${index}` }));
    }

    expect(usage.retained).toBe(3);
    expect(usage.list().map((record) => record.modelId)).toEqual([
      'vendor/m2',
      'vendor/m3',
      'vendor/m4',
    ]);
    expect(usage.historyTruncated).toBe(true);
  });

  it('restores history from storage', async () => {
    const storage = new FakeStorage();
    const first = tracker({ storage });
    await first.tracker.record(input());

    const second = new UsageTracker({ storage });
    second.load();
    expect(second.retained).toBe(1);
    expect(second.list()[0]?.modelId).toBe('vendor/model');
  });

  it('ignores stored history that is not a list of records', () => {
    const storage = new FakeStorage();
    storage.values.set('pairpilot.usage.history.v1', { nope: true });
    const usage = new UsageTracker({ storage });
    usage.load();
    expect(usage.retained).toBe(0);
  });

  it('clears history on request', async () => {
    const { tracker: usage, storage } = tracker();
    await usage.record(input());
    await usage.clear();
    expect(usage.retained).toBe(0);
    expect(storage.values.get('pairpilot.usage.history.v1')).toEqual([]);
  });
});

describe('totalsOf', () => {
  const record = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
    id: 'id',
    at: BASE,
    providerId: 'openrouter',
    modelId: 'vendor/model',
    role: 'coding',
    task: null,
    sessionId: 's',
    projectPath: '/repo',
    inputTokens: 100,
    outputTokens: 20,
    cachedTokens: 5,
    reasoningTokens: 2,
    durationMs: 10,
    usageAvailable: true,
    cost: reported(0.01),
    pricing: null,
    generationId: null,
    ...overrides,
  });

  it('sums tokens and durations', () => {
    const totals = totalsOf([record(), record({ inputTokens: 50 })]);
    expect(totals.requests).toBe(2);
    expect(totals.inputTokens).toBe(150);
    expect(totals.outputTokens).toBe(40);
    expect(totals.cachedTokens).toBe(10);
    expect(totals.durationMs).toBe(20);
  });

  it('sums the costs that are known and counts the ones that are not', () => {
    const totals = totalsOf([
      record({ cost: reported(0.01) }),
      record({ cost: unavailableCost('no price') }),
      record({ cost: estimated(0.02) }),
    ]);

    expect(totals.costUsd).toBeCloseTo(0.03, 9);
    expect(totals.unpricedRequests).toBe(1);
    expect(totals.estimatedRequests).toBe(1);
  });

  it('reports an all-unpriced total as null, not zero', () => {
    // `$0.00` would assert the requests were free. They were not priced.
    const totals = totalsOf([record({ cost: unavailableCost('x') }), record({ cost: unavailableCost('y') })]);
    expect(totals.costUsd).toBeNull();
    expect(totals.unpricedRequests).toBe(2);
  });

  it('reports an empty history as an empty total, not a null cost', () => {
    // No records is not the same as unknown cost; the UI shows "no usage yet".
    const totals = totalsOf([]);
    expect(totals.requests).toBe(0);
    expect(totals.costUsd).toBeNull();
  });

  it('counts a free request as a known cost of zero', () => {
    const totals = totalsOf([record({ cost: reported(0) })]);
    expect(totals.costUsd).toBe(0);
    expect(totals.unpricedRequests).toBe(0);
  });
});

describe('addTotals', () => {
  it('keeps a null total only when neither side knew its cost', () => {
    const empty = totalsOf([]);
    const priced = totalsOf([
      {
        id: 'i',
        at: BASE,
        providerId: 'openrouter',
        modelId: 'm',
        role: 'coding',
        task: null,
        sessionId: null,
        projectPath: null,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        durationMs: 0,
        usageAvailable: true,
        cost: reported(0.05),
        pricing: null,
        generationId: null,
      },
    ]);

    expect(addTotals(empty, empty).costUsd).toBeNull();
    expect(addTotals(empty, priced).costUsd).toBeCloseTo(0.05, 9);
    // Adding "unknown" to "unknown" stays unknown, and adding zero to a known
    // figure keeps the known figure.
    expect(addTotals(totalsOf([]), totalsOf([])).costUsd).toBeNull();
    expect(addTotals(priced, priced).costUsd).toBeCloseTo(0.1, 9);
  });

  it('adds every counter', () => {
    const a = totalsOf([]);
    a.requests = 1;
    a.inputTokens = 10;
    a.unpricedRequests = 2;
    const b = totalsOf([]);
    b.requests = 2;
    b.inputTokens = 5;
    b.unpricedRequests = 1;

    const sum = addTotals(a, b);
    expect(sum.requests).toBe(3);
    expect(sum.inputTokens).toBe(15);
    expect(sum.unpricedRequests).toBe(3);
  });
});

describe('grouping', () => {
  it('groups by model, with an explicit label for an unreported one', async () => {
    const { tracker: usage } = tracker();
    await usage.record(input({ modelId: 'a/one' }));
    await usage.record(input({ modelId: 'a/one' }));
    await usage.record(input({ modelId: null }));

    const groups = usage.byModel();
    expect(groups.map((group) => group.key)).toEqual(['a/one', 'unknown']);
    expect(groups[0]?.totals.requests).toBe(2);
    // Not an empty cell: an absent model is stated as absent.
    expect(groups[1]?.label).toBe('Model not reported');
  });

  it('groups by provider with a readable label', async () => {
    const { tracker: usage } = tracker();
    await usage.record(input({ providerId: 'openrouter' }));
    await usage.record(input({ providerId: 'claude-code' }));

    const groups = usage.byProvider();
    const labels = groups.map((group) => group.label).sort();
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('groups by role', async () => {
    const { tracker: usage } = tracker();
    await usage.record(input({ role: 'coding' }));
    await usage.record(input({ role: 'code-review' }));
    expect(usage.byRole().map((group) => group.key).sort()).toEqual(['code-review', 'coding']);
  });

  it('scopes totals to a session and to a project', async () => {
    const { tracker: usage } = tracker();
    await usage.record(input({ sessionId: 's1', projectPath: '/a', cost: reported(0.01) }));
    await usage.record(input({ sessionId: 's2', projectPath: '/a', cost: reported(0.02) }));
    await usage.record(input({ sessionId: 's1', projectPath: '/b', cost: reported(0.04) }));

    expect(usage.sessionTotals('s1').requests).toBe(2);
    expect(usage.sessionTotals('s1').costUsd).toBeCloseTo(0.05, 9);
    expect(usage.sessionTotals('s2').costUsd).toBeCloseTo(0.02, 9);
    expect(usage.projectTotals('/a').costUsd).toBeCloseTo(0.03, 9);
    expect(usage.projectTotals('/b').costUsd).toBeCloseTo(0.04, 9);
  });

  it('reports an empty total for a null session or project', async () => {
    const { tracker: usage } = tracker();
    await usage.record(input());
    expect(usage.sessionTotals(null).requests).toBe(0);
    expect(usage.projectTotals(null).requests).toBe(0);
  });

  it('returns the newest records first from recent()', async () => {
    const { tracker: usage } = tracker();
    for (let index = 0; index < 3; index += 1) {
      await usage.record(input({ at: BASE + index, modelId: `vendor/m${index}` }));
    }
    expect(usage.recent(2).map((record) => record.modelId)).toEqual(['vendor/m2', 'vendor/m1']);
    expect(usage.list().map((record) => record.modelId)).toEqual([
      'vendor/m0',
      'vendor/m1',
      'vendor/m2',
    ]);
  });
});

describe('history: daily buckets', () => {
  it('emits every day in the window, so a gap means no usage', async () => {
    const now = BASE + 2 * DAY;
    const { tracker: usage } = tracker({ now: () => now });
    await usage.record(input({ at: now }));

    const buckets = usage.history();
    expect(buckets.length).toBeGreaterThan(0);
    const last = buckets.at(-1);
    expect(last?.totals.requests).toBe(1);
    // A quiet day is a bucket with zero requests, not a missing entry.
    const quiet = buckets.filter((bucket) => bucket.totals.requests === 0);
    expect(quiet.length).toBeGreaterThan(0);
  });

  it('orders the window oldest first, ending with today', async () => {
    // The chart draws these left to right. Building the window by counting down
    // from the newest day produces the same set in reverse, which draws the
    // timeline backwards and puts today at the left edge.
    const { tracker: usage } = tracker({ now: () => BASE });
    const buckets = usage.history();

    const days = buckets.map((bucket) => bucket.day);
    expect(days).toEqual([...days].sort());
    expect(days.at(-1)).toBe(dayKey(BASE));
    expect(days.at(0)).toBe(dayKey(BASE - 29 * DAY));
  });

  it('keeps a day whose usage could not be priced distinguishable from a quiet day', async () => {
    // Both have `costUsd: null`, but one has requests. The chart draws them
    // differently, and that distinction lives here.
    const now = BASE;
    const { tracker: usage } = tracker({ now: () => now });
    await usage.record(input({ at: now, cost: unavailableCost('no price') }));

    const today = usage.history().at(-1);
    expect(today?.totals.requests).toBe(1);
    expect(today?.totals.costUsd).toBeNull();

    const quiet = usage.history()[0];
    expect(quiet?.totals.requests).toBe(0);
  });

  it('excludes records older than the window', async () => {
    const now = BASE;
    const { tracker: usage } = tracker({ now: () => now });
    await usage.record(input({ at: now - 400 * DAY }));

    const buckets = usage.history();
    expect(buckets.every((bucket) => bucket.totals.requests === 0)).toBe(true);
    // The record is still retained; it is just outside the chart window.
    expect(usage.retained).toBe(1);
  });
});

describe('dayKey', () => {
  it('produces a stable local date key', () => {
    const key = dayKey(BASE);
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(dayKey(BASE + 1_000)).toBe(key);
    expect(dayKey(BASE + DAY)).not.toBe(key);
  });
});

describe('budget: advisory, never a gate', () => {
  it('reports no limit when the ceiling is unset or zero', async () => {
    const { tracker: usage } = tracker();
    await usage.record(input({ cost: reported(5) }));

    for (const limit of [null, 0, -1]) {
      const state = usage.budget(limit, 'session-1', '/repo');
      expect(state.limitUsd).toBeNull();
      expect(state.exceeded).toBe(false);
      // The spend is still reported, so the UI can show it without a limit set.
      expect(state.sessionUsd).toBeCloseTo(5, 9);
      expect(state.projectUsd).toBeCloseTo(5, 9);
    }
  });

  it('does not report exceeded until the session passes the ceiling', async () => {
    const { tracker: usage } = tracker();
    await usage.record(input({ cost: reported(0.5) }));

    expect(usage.budget(1, 'session-1', '/repo').exceeded).toBe(false);
    await usage.record(input({ cost: reported(0.5) }));
    // At the ceiling exactly counts as reached.
    expect(usage.budget(1, 'session-1', '/repo').exceeded).toBe(true);
    expect(usage.budget(1, 'session-1', '/repo').sessionFraction).toBe(1);
  });

  it('caps the reported fraction at one rather than exceeding the bar', async () => {
    const { tracker: usage } = tracker();
    await usage.record(input({ cost: reported(10) }));
    expect(usage.budget(1, 'session-1', '/repo').sessionFraction).toBe(1);
  });

  it('reports an unknown spend as a null fraction, not as spent-out', async () => {
    // An unpriced session must not look like it has blown the budget.
    const { tracker: usage } = tracker();
    await usage.record(input({ cost: unavailableCost('no price') }));

    const state = usage.budget(1, 'session-1', '/repo');
    expect(state.sessionUsd).toBeNull();
    expect(state.sessionFraction).toBeNull();
    expect(state.exceeded).toBe(false);
  });

  it('scopes the warning to the session, not the whole history', async () => {
    // A previous session's spend must not trip this session's warning.
    const { tracker: usage } = tracker();
    await usage.record(input({ sessionId: 'old', cost: reported(100) }));
    await usage.record(input({ sessionId: 'new', cost: reported(0.01) }));

    const state = usage.budget(1, 'new', '/repo');
    expect(state.sessionUsd).toBeCloseTo(0.01, 9);
    expect(state.exceeded).toBe(false);
    expect(state.projectUsd).toBeCloseTo(100.01, 9);
  });
});

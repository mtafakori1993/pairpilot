/**
 * The Cost & Usage view (spec section 14).
 *
 * The figures here end up in front of a developer who is deciding whether a
 * workflow is affordable, so the tests are about the ways a dashboard can lie:
 *
 *   - an unpriced total rendered as `$0.00`, which reads as "free";
 *   - a partial total rendered as a whole one, with the missing requests
 *     silently absent from the sum;
 *   - an estimated figure presented as though the provider had reported it;
 *   - a day with usage that could not be priced drawn as a day with no usage.
 *
 * The snapshot is assembled by a real `UsageTracker` over a fake storage rather
 * than hand-written, so the test covers the chain an actual request travels.
 */

import { describe, expect, it } from 'vitest';
import {
  COST_DISCLAIMER,
  RECENT_REQUESTS,
  buildCostView,
  toTotalsView,
} from '../../src/ui/CostViewBuilder';
import {
  UsageTracker,
  dayKey,
  totalsOf,
  type UsageStorageLike,
  type UsageRecordInput,
} from '../../src/pricing/UsageTracker';
import {
  emptyTotals,
  unavailableCost,
  type CostBreakdown,
  type UsageTotals,
} from '../../src/types/usage';
import type { CostSnapshot } from '../../src/types/usage';

class FakeStorage implements UsageStorageLike {
  readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

const DAY = 86_400_000;
const BASE = new Date(2026, 4, 10, 12, 0, 0).getTime();

function reported(totalUsd: number, note: string | null = null): CostBreakdown {
  return { inputUsd: null, outputUsd: null, cachedUsd: null, totalUsd, source: 'reported', note };
}

function estimated(totalUsd: number): CostBreakdown {
  return {
    inputUsd: totalUsd,
    outputUsd: 0,
    cachedUsd: 0,
    totalUsd,
    source: 'estimated',
    note: 'Estimated from the catalogue prices in force when the request was made.',
  };
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

async function usage(
  records: UsageRecordInput[],
  options: { recentLimit?: number; capacity?: number; budgetUsd?: number } = {}
): Promise<{ tracker: UsageTracker; snapshot: CostSnapshot; projectTotals: UsageTotals }> {
  const tracker = new UsageTracker({
    storage: new FakeStorage(),
    now: () => BASE,
    capacity: options.capacity,
  });
  for (const record of records) {
    await tracker.record(record);
  }
  return {
    tracker,
    snapshot: {
      totals: tracker.totals(),
      sessionTotals: tracker.sessionTotals('session-1'),
      byModel: tracker.byModel(),
      byProvider: tracker.byProvider(),
      byRole: tracker.byRole(),
      history: tracker.history(),
      // Deliberately more than the view will show, so the cap the builder
      // applies is exercised rather than the one the tracker already applied.
      recent: tracker.recent(options.recentLimit ?? RECENT_REQUESTS * 2),
      budget: tracker.budget(options.budgetUsd ?? 0, 'session-1', '/repo'),
      historyTruncated: tracker.historyTruncated,
      retained: tracker.retained,
      capacity: tracker.capacityLimit,
    },
    projectTotals: tracker.projectTotals('/repo'),
  };
}

function view(
  snapshot: CostSnapshot,
  overrides: Partial<Parameters<typeof buildCostView>[0]> = {}
) {
  return buildCostView({
    snapshot,
    projectTotals: null,
    budgetUsd: 0,
    rangeDays: 30,
    projectPath: null,
    ...overrides,
  });
}

describe('an empty history', () => {
  it('reports itself as empty rather than as a zero-cost history', async () => {
    const { snapshot, projectTotals } = await usage([]);
    const built = view(snapshot, { projectTotals });

    expect(built.isEmpty).toBe(true);
    expect(built.totals.requests).toBe(0);
    // "Unavailable" rather than "$0.00": nothing has been spent, and nothing has
    // been priced either.
    expect(built.totals.costLabel).toBe('Unavailable');
    expect(built.totals.costNote).toBeNull();
    expect(built.recent).toEqual([]);
  });

  it('still reports every day of the chart window', async () => {
    const { snapshot } = await usage([]);
    const built = view(snapshot);
    expect(built.history.length).toBe(30);
    expect(built.history.every((bar) => bar.requests === 0)).toBe(true);
  });
});

describe('totals', () => {
  it('shows a reported total as a figure, with nothing to qualify', () => {
    const totals: UsageTotals = {
      ...emptyTotals(),
      requests: 3,
      inputTokens: 3_000,
      outputTokens: 600,
      durationMs: 4_500,
      costUsd: 0.03,
    };

    const built = toTotalsView(totals);
    expect(built.costLabel).toBe('$0.0300');
    // Every request was priced by the provider, so there is nothing missing and
    // nothing to explain.
    expect(built.costNote).toBeNull();
    expect(built.reportedRequests).toBe(3);
    expect(built.inputLabel).toBe('3,000');
    expect(built.durationLabel).toBe('4.5s');
  });

  it('reports a genuinely free run as $0.00', () => {
    const built = toTotalsView({ ...emptyTotals(), requests: 2, costUsd: 0 });
    expect(built.costLabel).toBe('$0.00');
    expect(built.costNote).toBeNull();
  });

  it('refuses to show a figure when nothing could be priced', () => {
    const built = toTotalsView({ ...emptyTotals(), requests: 4, unpricedRequests: 4 });

    expect(built.costLabel).toBe('Unavailable');
    expect(built.costNote).toContain('None of these 4 requests could be priced');
  });

  it('states that a partial total is partial, in the same breath as the figure', () => {
    // The failure this guards: "$12.34" read as the whole bill when three of
    // forty requests had no price.
    const built = toTotalsView({
      ...emptyTotals(),
      requests: 40,
      unpricedRequests: 3,
      costUsd: 12.34,
    });

    expect(built.costLabel).toBe('$12.34');
    expect(built.costNote).toContain('3 of 40 requests could not be priced');
    expect(built.costNote).toContain('not included');
  });

  it('labels estimated costs as arithmetic on published prices', () => {
    const built = toTotalsView({
      ...emptyTotals(),
      requests: 3,
      estimatedRequests: 1,
      costUsd: 0.05,
    });

    expect(built.costNote).toContain('estimated from catalogue prices');
    expect(built.costNote).toContain('rather than reported by the provider');
    // Singular, because one request is one cost.
    expect(built.costNote).toContain('1 cost is estimated');
  });

  it('pluralises as soon as there is more than one estimate', () => {
    const built = toTotalsView({
      ...emptyTotals(),
      requests: 3,
      estimatedRequests: 2,
      costUsd: 0.05,
    });
    expect(built.costNote).toContain('2 costs are estimated');
  });

  it('says both things at once when a total is partial and partly estimated', () => {
    const built = toTotalsView({
      ...emptyTotals(),
      requests: 10,
      unpricedRequests: 2,
      estimatedRequests: 3,
      costUsd: 1.5,
    });

    expect(built.costNote).toContain('2 of 10 requests could not be priced');
    expect(built.costNote).toContain('3 costs are estimated');
    // One sentence, two clauses: a reader skimming the figure still sees both.
    expect(built.costNote?.split('; ')).toHaveLength(2);
  });

  it('always accounts for every request, whichever way it was priced', () => {
    for (const [reportedCount, estimatedCount, unpricedCount] of [
      [5, 0, 0],
      [0, 5, 0],
      [0, 0, 5],
      [3, 1, 1],
      [1, 3, 1],
    ] as const) {
      const built = toTotalsView({
        ...emptyTotals(),
        requests: reportedCount + estimatedCount + unpricedCount,
        costUsd: 1,
        estimatedRequests: estimatedCount,
        unpricedRequests: unpricedCount,
      });

      expect(
        built.reportedRequests + built.estimatedRequests + built.unpricedRequests,
        `${reportedCount}/${estimatedCount}/${unpricedCount}`
      ).toBe(built.requests);
    }
  });

  it('renders a zero duration as absent rather than as 0ms', () => {
    // A turn whose timing was never recorded is not a turn that took no time.
    const built = toTotalsView({ ...emptyTotals(), requests: 1, durationMs: 0 });
    expect(built.durationLabel).toBe('—');
  });
});

describe('cost provenance through a real record', () => {
  it('counts a request priced from the catalogue as estimated, and says so', async () => {
    // The distinction the dashboard exists to preserve: this figure is
    // arithmetic on a published price, not a bill.
    const { snapshot } = await usage([input({ cost: estimated(0.02) })]);

    const built = view(snapshot);
    expect(built.totals.estimatedRequests).toBe(1);
    expect(built.totals.reportedRequests).toBe(0);
    expect(built.totals.costLabel).toBe('$0.0200');
    expect(built.totals.costNote).toContain('estimated from catalogue prices');
    expect(built.recent[0]?.costSource).toBe('estimated');
  });
});

describe('the session and the project', () => {
  it('scopes the session total to this session and the project to this folder', async () => {
    const { snapshot, projectTotals } = await usage([
      input({ sessionId: 'session-1', projectPath: '/repo', cost: reported(0.01) }),
      input({ sessionId: 'older', projectPath: '/repo', cost: reported(0.02) }),
      input({ sessionId: 'session-1', projectPath: '/other', cost: reported(0.04) }),
    ]);

    const built = view(snapshot, { projectTotals, projectPath: '/repo' });
    expect(built.totals.costLabel).toBe('$0.0700');
    expect(built.session.costLabel).toBe('$0.0500');
    expect(built.project?.costLabel).toBe('$0.0300');
  });

  it('has no project total when no folder is open', async () => {
    const { snapshot, projectTotals } = await usage([input()]);
    expect(view(snapshot, { projectTotals, projectPath: null }).project).toBeNull();
  });

  it('has no project total when the spend for the folder is unknown', async () => {
    const { snapshot } = await usage([input()]);
    expect(view(snapshot, { projectTotals: null, projectPath: '/repo' }).project).toBeNull();
  });
});

describe('the budget', () => {
  it('says no limit is set, and that nothing blocks a request either way', async () => {
    const { snapshot } = await usage([input()]);
    const built = view(snapshot, { budgetUsd: 0 });

    expect(built.budget.limitUsd).toBeNull();
    expect(built.budget.limitLabel).toBe('No limit set');
    expect(built.budget.note).toContain('does not stop a request');
  });

  it('describes a configured limit as a warning rather than a gate', async () => {
    const { snapshot } = await usage([input({ cost: reported(0.5) })]);
    const built = view(snapshot, { budgetUsd: 1 });

    expect(built.budget.limitUsd).toBe(1);
    expect(built.budget.limitLabel).toBe('$1.00');
    expect(built.budget.exceeded).toBe(false);
    expect(built.budget.note).toContain('does not block requests');
    expect(built.budget.note).toContain('not a gate');
  });

  it('reports the session and project spend, and the bar position', async () => {
    const { snapshot, projectTotals } = await usage(
      [input({ sessionId: 'session-1', cost: reported(0.25) })],
      { budgetUsd: 0.5 }
    );
    const built = view(snapshot, { projectTotals, projectPath: '/repo', budgetUsd: 0.5 });

    expect(built.budget.sessionLabel).toBe('$0.2500');
    expect(built.budget.projectLabel).toBe('$0.2500');
    expect(built.budget.widthPercent).toBe(50);
  });

  it('leaves the bar unknown when the session spend cannot be established', async () => {
    // An unpriced session must not render as a bar at zero, which would say
    // "plenty of budget left" about a figure nobody knows.
    const { snapshot } = await usage([input({ cost: unavailableCost('no price') })]);
    const built = view(snapshot, { budgetUsd: 1 });

    expect(built.budget.sessionLabel).toBe('Unavailable');
    expect(built.budget.widthPercent).toBeNull();
    expect(built.budget.exceeded).toBe(false);
  });
});

describe('groupings', () => {
  it('labels an unpriced group as unknown rather than as zero', async () => {
    const { snapshot } = await usage([
      input({ modelId: 'vendor/priced', cost: reported(0.02) }),
      input({ modelId: 'vendor/unpriced', cost: unavailableCost('no price') }),
    ]);

    const built = view(snapshot);
    const priced = built.byModel.find((group) => group.key === 'vendor/priced');
    const unpriced = built.byModel.find((group) => group.key === 'vendor/unpriced');

    expect(priced?.costLabel).toBe('$0.0200');
    expect(priced?.costUnknown).toBe(false);
    expect(unpriced?.costLabel).toBe('Unavailable');
    expect(unpriced?.costUnknown).toBe(true);
  });

  it('states both token directions in one label', async () => {
    const { snapshot } = await usage([input({ inputTokens: 12_000, outputTokens: 340 })]);
    expect(view(snapshot).byModel[0]?.tokensLabel).toBe('12,000 in / 340 out');
  });

  it('names an unreported model rather than leaving a blank cell', async () => {
    const { snapshot } = await usage([input({ modelId: null })]);
    expect(view(snapshot).byModel[0]?.label).toBe('Model not reported');
  });

  it('groups by provider and by role too', async () => {
    const { snapshot } = await usage([
      input({ providerId: 'openrouter', role: 'coding' }),
      input({ providerId: 'claude-code', role: 'code-review' }),
    ]);

    const built = view(snapshot);
    expect(built.byProvider.map((group) => group.key).sort()).toEqual(['claude-code', 'openrouter']);
    expect(built.byRole.map((group) => group.key).sort()).toEqual(['code-review', 'coding']);
    for (const group of built.byProvider) {
      expect(group.label.length).toBeGreaterThan(0);
    }
  });
});

describe('the daily bars', () => {
  it('scales the busiest known day to the full height', async () => {
    const { snapshot } = await usage([
      input({ at: BASE - 2 * DAY, cost: reported(1) }),
      input({ at: BASE - DAY, cost: reported(0.5) }),
    ]);

    const bars = view(snapshot).history.filter((bar) => bar.requests > 0);
    expect(bars.map((bar) => bar.day)).toEqual([
      dayKey(BASE - 2 * DAY),
      dayKey(BASE - DAY),
    ]);
    expect(bars[0]?.heightPercent).toBe(100);
    expect(bars[1]?.heightPercent).toBe(50);
    expect(bars[0]?.label).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it('draws a day whose usage could not be priced as unknown, not as a short bar', async () => {
    const { snapshot } = await usage([
      input({ at: BASE - DAY, cost: reported(1) }),
      input({ at: BASE, cost: unavailableCost('no price') }),
    ]);

    const built = view(snapshot);
    const today = built.history.at(-1);
    expect(today?.requests).toBe(1);
    expect(today?.costUsd).toBeNull();
    expect(today?.costLabel).toBe('Unavailable');
    expect(today?.heightPercent).toBeNull();

    const yesterday = built.history.at(-2);
    expect(yesterday?.heightPercent).toBe(100);
  });

  it('never draws a day with spend as an invisible bar', async () => {
    // A thousandth of the busiest day rounds to a zero-height bar, which would
    // read as a day with no spend at all.
    const { snapshot } = await usage([
      input({ at: BASE - DAY, cost: reported(1_000) }),
      input({ at: BASE, cost: reported(0.01) }),
    ]);

    const today = view(snapshot).history.at(-1);
    expect(today?.costUsd).toBe(0.01);
    expect(today?.heightPercent).toBe(2);
  });

  it('keeps the peak on a day that is inside the window', async () => {
    // The window is 30 days, so a record older than that is retained but not
    // charted, and must not set the scale for days that are.
    const { snapshot } = await usage([
      input({ at: BASE - 400 * DAY, cost: reported(100) }),
      input({ at: BASE, cost: reported(1) }),
    ]);

    const built = view(snapshot);
    expect(built.history.at(-1)?.heightPercent).toBe(100);
  });

  it('orders the bars oldest first and ends on today', async () => {
    const { snapshot } = await usage([]);
    const days = view(snapshot).history.map((bar) => bar.day);
    expect(days).toEqual([...days].sort());
    expect(days.at(-1)).toBe(dayKey(BASE));
  });
});

describe('the recent request table', () => {
  it('lists newest first and stops at the documented cap', async () => {
    const records = Array.from({ length: RECENT_REQUESTS + 10 }, (_, index) =>
      input({ at: BASE + index * 1_000, modelId: `vendor/m${index}` })
    );
    const { snapshot } = await usage(records);

    const built = view(snapshot);
    expect(built.recent).toHaveLength(RECENT_REQUESTS);
    // The cap is applied here as well as at the source, so a caller that passed
    // the whole history still gets a bounded table.
    expect(built.recent[0]?.modelLabel).toBe(`vendor/m${records.length - 1}`);
  });

  it('carries the model, role, task and timings of one request', async () => {
    const { snapshot } = await usage([
      input({ task: 'rename the parser', inputTokens: 1_500, outputTokens: 320, durationMs: 2_400 }),
    ]);

    const record = view(snapshot).recent[0];
    expect(record?.modelLabel).toBe('vendor/model');
    expect(record?.roleLabel).toBe('coding');
    expect(record?.task).toBe('rename the parser');
    expect(record?.inputLabel).toBe('1,500');
    expect(record?.outputLabel).toBe('320');
    expect(record?.durationLabel).toBe('2.4s');
    expect(record?.atLabel.length).toBeGreaterThan(0);
    expect(record?.usageAvailable).toBe(true);
  });

  it('keeps the provider’s own explanation of a cost verbatim', async () => {
    const { snapshot } = await usage([
      input({ cost: reported(0.02, 'Charged by OpenRouter for this generation.') }),
    ]);
    const record = view(snapshot).recent[0];
    expect(record?.costSource).toBe('reported');
    expect(record?.costNote).toBe('Charged by OpenRouter for this generation.');
  });

  it('distinguishes a request with no usage block from one that was priced', async () => {
    const { snapshot } = await usage([
      input({ usageAvailable: false, inputTokens: 0, outputTokens: 0, cost: unavailableCost('none') }),
    ]);
    const record = view(snapshot).recent[0];
    expect(record?.usageAvailable).toBe(false);
    expect(record?.costSource).toBe('unavailable');
    expect(record?.costLabel).toBe('Unavailable');
  });

  it('reports a null task as null, so the cell can say so itself', async () => {
    const { snapshot } = await usage([input({ task: null })]);
    expect(view(snapshot).recent[0]?.task).toBeNull();
  });
});

describe('meta', () => {
  it('carries the retention figures and the range it was built for', async () => {
    const { snapshot } = await usage([input()]);
    const built = view(snapshot, { rangeDays: 90 });

    expect(built.meta.retained).toBe(1);
    expect(built.meta.capacity).toBeGreaterThan(0);
    expect(built.meta.truncated).toBe(false);
    expect(built.meta.rangeDays).toBe(90);
  });

  it('ships the disclaimer with every view, and separates the three sources', () => {
    expect(COST_DISCLAIMER).toContain('Reported means');
    expect(COST_DISCLAIMER).toContain('Estimated means');
    expect(COST_DISCLAIMER).toContain('Unavailable means');
    expect(COST_DISCLAIMER).toContain('invoice');
  });

  it('reports a truncated history as truncated', async () => {
    // The tracker caps at its capacity, so the oldest records are gone and the
    // dashboard must not present the remainder as the whole history.
    const tracker = new UsageTracker({ storage: new FakeStorage(), capacity: 2, now: () => BASE });
    for (let index = 0; index < 3; index += 1) {
      await tracker.record(input({ at: BASE + index }));
    }
    const snapshot: CostSnapshot = {
      totals: totalsOf([]),
      sessionTotals: totalsOf([]),
      byModel: [],
      byProvider: [],
      byRole: [],
      history: tracker.history(),
      recent: tracker.recent(RECENT_REQUESTS),
      budget: tracker.budget(0, 'session-1', '/repo'),
      historyTruncated: tracker.historyTruncated,
      retained: tracker.retained,
      capacity: tracker.capacityLimit,
    };

    const built = view(snapshot);
    expect(built.meta.truncated).toBe(true);
    expect(built.meta.retained).toBe(2);
    expect(built.meta.capacity).toBe(2);
  });
});

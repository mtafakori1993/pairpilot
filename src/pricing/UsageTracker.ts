/**
 * UsageTracker — the record of every AI request PairPilot has made, and the
 * aggregates the Cost & Usage view renders.
 *
 * Three decisions shape this class, and each is about not overstating what the
 * numbers mean.
 *
 *  1. **A total is the sum of what is known, and says how much it is missing.**
 *     If three of forty requests could not be priced, the total is the sum of
 *     the other thirty-seven *and* `unpricedRequests` is 3. The alternative —
 *     refusing to total anything until every request is priced — makes the view
 *     useless precisely when a developer most wants a ballpark. `costUsd` is
 *     `null` only when *nothing* could be priced, so an all-unknown set can
 *     never render as "$0.00".
 *  2. **History is capped, and truncation is reported.** A ring buffer bounded
 *     by a configured capacity, with `historyTruncated` exposed so the view can
 *     say that older requests are no longer counted rather than quietly
 *     under-reporting.
 *  3. **Nothing is written on a failed request.** A turn that errored before
 *     producing output has no usage block and no charge; inventing a zero-cost
 *     row for it would inflate the request count and imply a call that never
 *     happened.
 */

import { emptyTotals, type BudgetState, type CostBreakdown, type PricingSnapshot, type UsageDayBucket, type UsageGroup, type UsageRecord, type UsageTotals } from '../types/usage';
import type { ProviderId } from '../types/provider';

/** The slice of `vscode.Memento` this class uses. */
export interface UsageStorageLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface UsageRecordInput {
  providerId: ProviderId;
  modelId: string | null;
  role: string;
  task: string | null;
  sessionId: string | null;
  projectPath: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  durationMs: number;
  usageAvailable: boolean;
  cost: CostBreakdown;
  pricing: PricingSnapshot | null;
  generationId?: string | null;
  at?: number;
}

export interface UsageTrackerDeps {
  storage: UsageStorageLike;
  /** Maximum records retained. Older entries are dropped. */
  capacity?: number;
  now?(): number;
  newId?(): string;
  logger?: { warn(message: string): void };
}

const HISTORY_KEY = 'pairpilot.usage.history.v1';
const DEFAULT_CAPACITY = 500;
/** How long the task text stored for the history table may be. */
const TASK_PREVIEW_CHARS = 120;
/** Days of daily history the dashboard renders. */
const HISTORY_DAYS = 30;

export class UsageTracker {
  private records: UsageRecord[] = [];
  private dropped = 0;

  constructor(private readonly deps: UsageTrackerDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private get capacity(): number {
    const configured = this.deps.capacity ?? DEFAULT_CAPACITY;
    return configured > 0 ? configured : DEFAULT_CAPACITY;
  }

  /** Restore history from storage. */
  load(): void {
    const stored = this.deps.storage.get<unknown>(HISTORY_KEY, []);
    if (!Array.isArray(stored)) {
      return;
    }
    this.records = stored.filter(isUsageRecord).slice(-this.capacity);
    this.dropped = 0;
  }

  /** Every retained record, oldest first. */
  list(): UsageRecord[] {
    return [...this.records];
  }

  /** The most recent `count` records, newest first. */
  recent(count: number): UsageRecord[] {
    return [...this.records].reverse().slice(0, count);
  }

  get retained(): number {
    return this.records.length;
  }

  get capacityLimit(): number {
    return this.capacity;
  }

  /** True once records have been discarded to stay within the cap. */
  get historyTruncated(): boolean {
    return this.dropped > 0 || this.records.length >= this.capacity;
  }

  /**
   * Append a record and persist.
   *
   * Returns the stored record so the caller can log or display exactly what was
   * written, rather than reconstructing it.
   */
  async record(input: UsageRecordInput): Promise<UsageRecord> {
    const at = input.at ?? this.now();
    const record: UsageRecord = {
      id: this.deps.newId ? this.deps.newId() : fallbackId(at, this.records.length),
      at,
      providerId: input.providerId,
      modelId: input.modelId,
      role: input.role,
      task: truncate(input.task),
      sessionId: input.sessionId,
      projectPath: input.projectPath,
      inputTokens: count(input.inputTokens),
      outputTokens: count(input.outputTokens),
      cachedTokens: count(input.cachedTokens),
      reasoningTokens: count(input.reasoningTokens),
      durationMs: count(input.durationMs),
      usageAvailable: input.usageAvailable,
      cost: input.cost,
      pricing: input.pricing,
      generationId: input.generationId ?? null,
    };

    this.records.push(record);
    while (this.records.length > this.capacity) {
      this.records.shift();
      this.dropped += 1;
    }

    try {
      await this.deps.storage.update(HISTORY_KEY, this.records);
    } catch (error) {
      // History is a convenience; failing to persist it must never fail the turn
      // that just succeeded.
      this.deps.logger?.warn(
        `PairPilot could not save its usage history: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    return record;
  }

  async clear(): Promise<void> {
    this.records = [];
    this.dropped = 0;
    await this.deps.storage.update(HISTORY_KEY, []);
  }

  /* ---------------------------------------------------------------------- */
  /* Aggregates                                                             */
  /* ---------------------------------------------------------------------- */

  /** Totals over every retained record. */
  totals(): UsageTotals {
    return totalsOf(this.records);
  }

  totalsFor(predicate: (record: UsageRecord) => boolean): UsageTotals {
    return totalsOf(this.records.filter(predicate));
  }

  sessionTotals(sessionId: string | null): UsageTotals {
    if (sessionId === null) {
      return emptyTotals();
    }
    return this.totalsFor((record) => record.sessionId === sessionId);
  }

  projectTotals(projectPath: string | null): UsageTotals {
    if (projectPath === null) {
      return emptyTotals();
    }
    return this.totalsFor((record) => record.projectPath === projectPath);
  }

  byModel(): UsageGroup[] {
    return groupBy(this.records, (record) => {
      const key = record.modelId ?? 'unknown';
      return { key, label: record.modelId ?? 'Model not reported' };
    });
  }

  byProvider(): UsageGroup[] {
    return groupBy(this.records, (record) => ({
      key: record.providerId,
      label: labelForProvider(record.providerId),
    }));
  }

  byRole(): UsageGroup[] {
    return groupBy(this.records, (record) => ({ key: record.role, label: record.role }));
  }

  /** Daily totals over the last `HISTORY_DAYS` days, oldest first. */
  history(): UsageDayBucket[] {
    const buckets = new Map<string, UsageRecord[]>();
    const cutoff = this.startOfDay(this.now()) - (HISTORY_DAYS - 1) * 86_400_000;

    for (const record of this.records) {
      if (record.at < cutoff) {
        continue;
      }
      const day = dayKey(record.at);
      const existing = buckets.get(day);
      if (existing === undefined) {
        buckets.set(day, [record]);
      } else {
        existing.push(record);
      }
    }

    // Every day in the window is emitted, including quiet ones, so a gap in the
    // chart means "no usage" rather than "no data".
    //
    // Ascending, so the array reads oldest → newest like the chart that consumes
    // it. Counting down from the newest day builds the same set in reverse,
    // which draws the timeline backwards and puts "today" at the left edge.
    const out: UsageDayBucket[] = [];
    for (let offset = 0; offset < HISTORY_DAYS; offset += 1) {
      const day = dayKey(cutoff + offset * 86_400_000);
      out.push({ day, totals: totalsOf(buckets.get(day) ?? []) });
    }
    return out;
  }

  /**
   * Compare spend against the configured ceiling.
   *
   * Advisory by construction. `exceeded` is reported, never enforced: blocking a
   * request is a decision the developer has to opt into, and this class has no
   * power to make it anyway.
   */
  budget(limitUsd: number | null, sessionId: string | null, projectPath: string | null): BudgetState {
    const session = this.sessionTotals(sessionId);
    const project = this.projectTotals(projectPath);

    if (limitUsd === null || limitUsd <= 0) {
      return {
        limitUsd: null,
        sessionUsd: session.costUsd,
        projectUsd: project.costUsd,
        exceeded: false,
        sessionFraction: null,
      };
    }

    const spent = session.costUsd;
    return {
      limitUsd,
      sessionUsd: spent,
      projectUsd: project.costUsd,
      exceeded: spent !== null && spent >= limitUsd,
      sessionFraction: spent === null ? null : Math.min(spent / limitUsd, 1),
    };
  }

  private startOfDay(at: number): number {
    const date = new Date(at);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }
}

/**
 * A stored count is a non-negative integer.
 *
 * `Math.max(0, Math.trunc(x))` is not enough on its own: `Math.trunc(NaN)` is
 * `NaN`, and `Math.max(0, NaN)` is `NaN` too. A single `NaN` would be written
 * to storage as `null` by JSON, and then poison every sum it later entered —
 * one bad record turning the whole dashboard's totals into `NaN`.
 */
function count(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

/* -------------------------------------------------------------------------- */
/* Pure aggregation                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Sum records.
 *
 * `costUsd` is the sum of the costs that are known. It is `null` — not zero —
 * when there are records but none of them could be priced, because `$0.00` would
 * assert the requests were free.
 */
export function totalsOf(records: readonly UsageRecord[]): UsageTotals {
  const totals = emptyTotals();
  let knownCost = 0;
  let priced = 0;

  for (const record of records) {
    totals.requests += 1;
    totals.inputTokens += record.inputTokens;
    totals.outputTokens += record.outputTokens;
    totals.cachedTokens += record.cachedTokens;
    totals.reasoningTokens += record.reasoningTokens;
    totals.durationMs += record.durationMs;

    const cost = record.cost.totalUsd;
    if (cost === null) {
      totals.unpricedRequests += 1;
    } else {
      knownCost += cost;
      priced += 1;
    }
    if (record.cost.source === 'estimated') {
      totals.estimatedRequests += 1;
    }
  }

  totals.costUsd = records.length === 0 ? null : priced === 0 ? null : round(knownCost);
  return totals;
}

/**
 * Add two totals.
 *
 * `costUsd` stays `null` only when neither side had a known cost — and since
 * each side is itself `null` solely when nothing it counted was priced, this
 * preserves the "never render an unknown total as zero" rule.
 */
export function addTotals(left: UsageTotals, right: UsageTotals): UsageTotals {
  const anyCost = left.costUsd !== null || right.costUsd !== null;
  return {
    requests: left.requests + right.requests,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cachedTokens: left.cachedTokens + right.cachedTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    durationMs: left.durationMs + right.durationMs,
    costUsd: anyCost ? round((left.costUsd ?? 0) + (right.costUsd ?? 0)) : null,
    unpricedRequests: left.unpricedRequests + right.unpricedRequests,
    estimatedRequests: left.estimatedRequests + right.estimatedRequests,
  };
}

function groupBy(
  records: readonly UsageRecord[],
  key: (record: UsageRecord) => { key: string; label: string }
): UsageGroup[] {
  const buckets = new Map<string, { label: string; records: UsageRecord[] }>();
  for (const record of records) {
    const { key: groupKey, label } = key(record);
    const existing = buckets.get(groupKey);
    if (existing === undefined) {
      buckets.set(groupKey, { label, records: [record] });
    } else {
      existing.records.push(record);
    }
  }

  return [...buckets.entries()]
    .map(([groupKey, bucket]) => ({
      key: groupKey,
      label: bucket.label,
      totals: totalsOf(bucket.records),
    }))
    // Most expensive first, then most requests. Unpriced groups sort last, since
    // their cost is unknown rather than zero.
    .sort((left, right) => {
      const leftCost = left.totals.costUsd;
      const rightCost = right.totals.costUsd;
      if (leftCost === null && rightCost === null) {
        return right.totals.requests - left.totals.requests;
      }
      if (leftCost === null) return 1;
      if (rightCost === null) return -1;
      if (rightCost !== leftCost) return rightCost - leftCost;
      return right.totals.requests - left.totals.requests;
    });
}

function round(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

function truncate(text: string | null): string | null {
  if (text === null) {
    return null;
  }
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= TASK_PREVIEW_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, TASK_PREVIEW_CHARS - 1)}…`;
}

/** Local-time `YYYY-MM-DD`. Local, so "today" matches the developer's clock. */
export function dayKey(at: number): string {
  const date = new Date(at);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function labelForProvider(providerId: ProviderId): string {
  return providerId === 'openrouter' ? 'OpenRouter' : 'Claude Code';
}

function isUsageRecord(value: unknown): value is UsageRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<UsageRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.at === 'number' &&
    typeof record.cost === 'object' &&
    record.cost !== null
  );
}

let fallbackCounter = 0;

/** Used only when no id factory was injected. */
function fallbackId(at: number, index: number): string {
  fallbackCounter += 1;
  return `${at.toString(36)}-${index}-${fallbackCounter}`;
}

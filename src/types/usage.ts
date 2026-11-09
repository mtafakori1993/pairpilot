/**
 * Usage, cost and budget types.
 *
 * The single most important idea here is `CostSource`. A cost is either:
 *
 *   - `reported`  — the provider told us what it charged. This is a fact.
 *   - `estimated` — we multiplied tokens by published catalogue prices. This is
 *                   arithmetic on published numbers, and it can legitimately
 *                   differ from the invoice (discounts, price changes, provider
 *                   routing), so it is labelled as an estimate everywhere it
 *                   appears.
 *   - `unavailable` — we do not know, and we say so.
 *
 * Collapsing these into one number would be the easiest thing to build and the
 * most dishonest. PairPilot never does it.
 */

import type { ProviderId } from './provider';

export type CostSource = 'reported' | 'estimated' | 'unavailable';

/**
 * A cost, split into the buckets the developer is actually billed for.
 *
 * Every figure is `null` when unknown. `totalUsd` is `null` when it cannot be
 * established — never `0`, which would read as "this was free".
 */
export interface CostBreakdown {
  inputUsd: number | null;
  outputUsd: number | null;
  cachedUsd: number | null;
  totalUsd: number | null;
  source: CostSource;
  /**
   * Plain-language explanation of how `totalUsd` was arrived at, and of anything
   * that could not be priced. Rendered verbatim in the UI, so it must read as a
   * sentence to a developer who has never seen this code.
   */
  note: string | null;
}

export function unavailableCost(note: string): CostBreakdown {
  return { inputUsd: null, outputUsd: null, cachedUsd: null, totalUsd: null, source: 'unavailable', note };
}

/**
 * The prices in force when a request was made.
 *
 * Stored alongside every usage record so that historical costs stay explicable
 * after the catalogue changes underneath them. Without this, a past session's
 * cost would silently re-derive at today's prices and disagree with what was
 * shown at the time.
 */
export interface PricingSnapshot {
  modelId: string;
  promptPerToken: number | null;
  completionPerToken: number | null;
  cacheReadPerToken: number | null;
  capturedAt: number;
}

/** One completed AI request. */
export interface UsageRecord {
  id: string;
  /** Epoch ms the request finished. */
  at: number;
  providerId: ProviderId;
  modelId: string | null;
  /** The PairPilot role that issued the request, e.g. `coding`. */
  role: string;
  /** The developer's task text, truncated, for the history table. */
  task: string | null;
  sessionId: string | null;
  projectPath: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  durationMs: number;
  /** False when the provider returned no usage block at all. */
  usageAvailable: boolean;
  cost: CostBreakdown;
  pricing: PricingSnapshot | null;
  /** OpenRouter's generation id, for cross-checking a charge. */
  generationId: string | null;
}

/** Additive totals. `costUsd` is null unless every contributing record priced. */
export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  durationMs: number;
  costUsd: number | null;
  /** How many records had no usable cost, so a partial total is never mistaken for a whole one. */
  unpricedRequests: number;
  /** How many records carried an *estimated* rather than reported cost. */
  estimatedRequests: number;
}

export function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    durationMs: 0,
    costUsd: null,
    unpricedRequests: 0,
    estimatedRequests: 0,
  };
}

/** A named group in the cost breakdown tables. */
export interface UsageGroup {
  key: string;
  label: string;
  totals: UsageTotals;
}

/** One day in the spend history. */
export interface UsageDayBucket {
  /** `YYYY-MM-DD`, local time. */
  day: string;
  totals: UsageTotals;
}

export interface BudgetState {
  /** The configured ceiling, or null when the developer has not set one. */
  limitUsd: number | null;
  /** Spend within the current session, when it can be established. */
  sessionUsd: number | null;
  /** Spend recorded for the current project. */
  projectUsd: number | null;
  /** True once spend has reached or passed the limit. Advisory only. */
  exceeded: boolean;
  /** How close to the limit the current session is, 0..1, or null. */
  sessionFraction: number | null;
}

/**
 * Snapshot for the Cost & Usage view.
 *
 * `modelSelection` is included so the dashboard can say which model the figures
 * below it came from — a cost table with no model attribution is not actionable.
 */
export interface CostSnapshot {
  totals: UsageTotals;
  sessionTotals: UsageTotals;
  byModel: UsageGroup[];
  byProvider: UsageGroup[];
  byRole: UsageGroup[];
  history: UsageDayBucket[];
  recent: UsageRecord[];
  budget: BudgetState;
  /** True when the record cap has been reached and older entries were dropped. */
  historyTruncated: boolean;
  /** Records retained, and the configured cap. */
  retained: number;
  capacity: number;
}

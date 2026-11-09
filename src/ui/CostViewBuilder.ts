/**
 * CostViewBuilder — turns recorded usage into the Cost & Usage screen's view.
 *
 * This is a formatting layer, and formatting is where honesty is usually lost.
 * The rules it applies:
 *
 *  - A total that could not be established renders as "Unavailable", never
 *    "$0.00". `UsageTotals.costUsd` is null exactly when nothing could be priced,
 *    and that null survives all the way to the screen.
 *  - A *partial* total says so, in the same breath as the figure: "$12.34 · 3 of
 *    40 requests could not be priced". A number without that qualifier would be
 *    read as the whole bill.
 *  - Reported and estimated costs are counted separately and labelled, because
 *    one is the provider's own figure and the other is arithmetic on a published
 *    price list.
 *  - Nothing is estimated at display time. If a record had no price when it was
 *    written, it has none now; re-deriving it against today's catalogue would
 *    silently rewrite history.
 *
 * Every figure ships twice: as the raw value and as the string to print. The raw
 * value is what the tests assert on, because "null, not 0" is a fact about the
 * number and can be checked without parsing a formatted string for it — and it
 * is what any future export would read. The panel prints the string and nothing
 * else; `test/security/WebviewPanels.test.ts` fails the build if either panel
 * starts reading a raw figure, so the second copy cannot quietly become the
 * one on screen.
 */

import { formatDuration, formatTimestamp, formatTokens, formatUsd } from '../models/format';
import type {
  BudgetState,
  CostBreakdown,
  CostSnapshot,
  UsageDayBucket,
  UsageGroup,
  UsageRecord,
  UsageTotals,
} from '../types/usage';

/** The sentence that travels with every figure this module produces. */
export const COST_DISCLAIMER =
  'Reported means the provider told PairPilot what it charged. Estimated means PairPilot multiplied the token counts by the prices published in the model catalogue, which can differ from your invoice. Unavailable means neither was possible.';

export interface CostTotalsView {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  inputLabel: string;
  outputLabel: string;
  cachedLabel: string;
  reasoningLabel: string;
  durationLabel: string;
  /** The total, or "Unavailable". Never "$0.00" for an unknown total. */
  costLabel: string;
  /** How the total was arrived at, and what is missing from it. Rendered verbatim. */
  costNote: string | null;
  reportedRequests: number;
  estimatedRequests: number;
  unpricedRequests: number;
}

export interface CostGroupView {
  key: string;
  label: string;
  requests: number;
  costLabel: string;
  tokensLabel: string;
  /** True when this group's cost could not be established at all. */
  costUnknown: boolean;
}

export interface CostHistoryBar {
  day: string;
  /** Short axis label, e.g. `Mar 4`. */
  label: string;
  requests: number;
  costLabel: string;
  costUsd: number | null;
  /**
   * Bar height as a percentage of the busiest known day, ready for the `style`
   * attribute. Null when the day's cost is unknown, which the panel draws as an
   * unknown bar rather than as no bar at all.
   *
   * The arithmetic and the floor live here rather than in the panel, which
   * performs neither: a day with spend always shows a bar of at least 2%,
   * because a sub-pixel one reads as a day with none.
   */
  heightPercent: number | null;
}

export interface CostRecordView {
  id: string;
  at: number;
  atLabel: string;
  providerId: string;
  modelLabel: string;
  roleLabel: string;
  task: string | null;
  inputLabel: string;
  outputLabel: string;
  cachedLabel: string;
  durationLabel: string;
  costLabel: string;
  costSource: CostBreakdown['source'];
  /** Why the cost reads as it does, when the note adds anything. */
  costNote: string | null;
  usageAvailable: boolean;
}

export interface CostView {
  totals: CostTotalsView;
  session: CostTotalsView;
  project: CostTotalsView | null;
  budget: {
    limitUsd: number | null;
    limitLabel: string;
    sessionLabel: string;
    projectLabel: string | null;
    exceeded: boolean;
    /** Bar width as a percentage, or null when it cannot be established. */
    widthPercent: number | null;
    /** Plain-language statement of what the limit does, which is nothing but warn. */
    note: string;
  };
  byModel: CostGroupView[];
  byProvider: CostGroupView[];
  byRole: CostGroupView[];
  history: CostHistoryBar[];
  recent: CostRecordView[];
  meta: {
    retained: number;
    capacity: number;
    truncated: boolean;
    rangeDays: number;
    disclaimer: string;
  };
  /** True when there is nothing to show, so the screen renders its empty state. */
  isEmpty: boolean;
}

export interface CostViewInput {
  snapshot: CostSnapshot;
  /**
   * Spend recorded for the current workspace.
   *
   * Passed in rather than read off the snapshot because the snapshot is about the
   * record set as a whole, while a project total is a question about the folder
   * that happens to be open — and that folder can change without the records
   * changing.
   */
  projectTotals: UsageTotals | null;
  /** The configured ceiling in USD. `0` means the developer set none. */
  budgetUsd: number;
  /** Days of history being displayed, for the heading. */
  rangeDays: number;
  /** Named in the heading so "this project" is never ambiguous. */
  projectPath: string | null;
}

/** How many recent requests the table lists. */
export const RECENT_REQUESTS = 50;

export function buildCostView(input: CostViewInput): CostView {
  const { snapshot } = input;
  const totals = toTotalsView(snapshot.totals);
  const session = toTotalsView(snapshot.sessionTotals);
  const project =
    input.projectPath === null || input.projectTotals === null
      ? null
      : toTotalsView(input.projectTotals);

  return {
    totals,
    session,
    project,
    budget: toBudgetView(snapshot.budget, input.budgetUsd),
    byModel: snapshot.byModel.map(toGroupView),
    byProvider: snapshot.byProvider.map(toGroupView),
    byRole: snapshot.byRole.map(toGroupView),
    history: toHistoryBars(snapshot.history),
    recent: snapshot.recent.slice(0, RECENT_REQUESTS).map(toRecordView),
    meta: {
      retained: snapshot.retained,
      capacity: snapshot.capacity,
      truncated: snapshot.historyTruncated,
      rangeDays: input.rangeDays,
      disclaimer: COST_DISCLAIMER,
    },
    isEmpty: snapshot.totals.requests === 0,
  };
}

/* -------------------------------------------------------------------------- */

export function toTotalsView(totals: UsageTotals): CostTotalsView {
  const reported = totals.requests - totals.estimatedRequests - totals.unpricedRequests;
  return {
    requests: totals.requests,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cachedTokens: totals.cachedTokens,
    reasoningTokens: totals.reasoningTokens,
    inputLabel: formatTokens(totals.inputTokens),
    outputLabel: formatTokens(totals.outputTokens),
    cachedLabel: formatTokens(totals.cachedTokens),
    reasoningLabel: formatTokens(totals.reasoningTokens),
    durationLabel: totals.durationMs === 0 ? '—' : formatDuration(totals.durationMs),
    costLabel: formatUsd(totals.costUsd),
    costNote: describeTotals(totals, reported),
    // Counted rather than derived from a stored flag, so the three always add up
    // to `requests` and a future cost source cannot quietly fall outside them.
    reportedRequests: Math.max(0, reported),
    estimatedRequests: totals.estimatedRequests,
    unpricedRequests: totals.unpricedRequests,
  };
}

/**
 * How a total was arrived at.
 *
 * Returns null only for a genuinely complete, fully reported total — the one
 * case where saying nothing is accurate. Every other case states what is
 * missing, because a total that silently omits requests is the failure mode this
 * whole module exists to prevent.
 */
function describeTotals(totals: UsageTotals, reported: number): string | null {
  if (totals.requests === 0) {
    return null;
  }
  if (totals.unpricedRequests === totals.requests) {
    return `None of these ${totals.requests} requests could be priced, so no cost can be shown.`;
  }

  const parts: string[] = [];
  if (totals.unpricedRequests > 0) {
    parts.push(
      `${totals.unpricedRequests} of ${totals.requests} requests could not be priced and are not included`
    );
  }
  if (totals.estimatedRequests > 0) {
    parts.push(
      `${totals.estimatedRequests} ${totals.estimatedRequests === 1 ? 'cost is' : 'costs are'} estimated from catalogue prices rather than reported by the provider`
    );
  }
  if (parts.length === 0) {
    return reported === totals.requests
      ? null
      : `Reported by the provider for ${reported} of ${totals.requests} requests.`;
  }
  return `${parts.join('; ')}.`;
}

function toGroupView(group: UsageGroup): CostGroupView {
  return {
    key: group.key,
    label: group.label,
    requests: group.totals.requests,
    costLabel: formatUsd(group.totals.costUsd),
    tokensLabel: `${formatTokens(group.totals.inputTokens)} in / ${formatTokens(group.totals.outputTokens)} out`,
    costUnknown: group.totals.costUsd === null,
  };
}

function toBudgetView(budget: BudgetState, configuredUsd: number): CostView['budget'] {
  const limit = configuredUsd > 0 ? configuredUsd : null;
  return {
    limitUsd: limit,
    limitLabel: limit === null ? 'No limit set' : formatUsd(limit),
    sessionLabel: formatUsd(budget.sessionUsd),
    projectLabel: budget.projectUsd === null ? null : formatUsd(budget.projectUsd),
    exceeded: budget.exceeded,
    widthPercent:
      budget.sessionFraction === null ? null : Math.round(budget.sessionFraction * 100),
    note:
      limit === null
        ? 'PairPilot does not stop a request on cost. Set "pairpilot.cost.budgetUsd" to be warned when a session passes a figure you choose.'
        : 'PairPilot warns you once per session when spend passes this figure. It does not block requests — the limit is a notification, not a gate.',
  };
}

/**
 * The daily bars.
 *
 * Every day in the window is present, including days with no usage, so a gap in
 * the chart reads as "no requests that day" rather than as missing data. Height
 * is relative to the busiest day that has a known cost; days whose cost is
 * unknown get a null fraction and are drawn as unknown rather than as zero.
 */
function toHistoryBars(history: readonly UsageDayBucket[]): CostHistoryBar[] {
  const known = history
    .map((bucket) => bucket.totals.costUsd)
    .filter((value): value is number => value !== null && value > 0);
  const peak = known.length > 0 ? Math.max(...known) : 0;

  return history.map((bucket) => {
    const cost = bucket.totals.costUsd;
    const fraction = cost === null || peak <= 0 ? null : Math.min(cost / peak, 1);
    return {
      day: bucket.day,
      label: shortDay(bucket.day),
      requests: bucket.totals.requests,
      costLabel: formatUsd(cost),
      costUsd: cost,
      // Floored at 2%: a sub-pixel bar would say "no spend here" about a day
      // that had some.
      heightPercent: fraction === null ? null : Math.max(2, Math.round(fraction * 100)),
    };
  });
}

function toRecordView(record: UsageRecord): CostRecordView {
  return {
    id: record.id,
    at: record.at,
    atLabel: formatTimestamp(record.at),
    providerId: record.providerId,
    modelLabel: record.modelId ?? 'Model not reported',
    roleLabel: record.role,
    task: record.task,
    inputLabel: formatTokens(record.inputTokens),
    outputLabel: formatTokens(record.outputTokens),
    cachedLabel: formatTokens(record.cachedTokens),
    durationLabel: formatDuration(record.durationMs),
    costLabel: formatUsd(record.cost.totalUsd),
    costSource: record.cost.source,
    costNote: record.cost.note,
    usageAvailable: record.usageAvailable,
  };
}

/** `2026-03-04` → `Mar 4`. Falls back to the raw key if it is not that shape. */
function shortDay(day: string): string {
  const parts = day.split('-');
  if (parts.length !== 3) {
    return day;
  }
  const month = Number.parseInt(parts[1] ?? '', 10);
  const date = Number.parseInt(parts[2] ?? '', 10);
  if (!Number.isFinite(month) || !Number.isFinite(date)) {
    return day;
  }
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const name = names[month - 1];
  return name === undefined ? day : `${name} ${date}`;
}

/**
 * CostCalculator — turns token counts and published prices into a `CostBreakdown`.
 *
 * All functions here are pure: no clock, no storage, no network. That is what
 * makes it possible to test the arithmetic exhaustively, including the cases
 * that matter most — an unpriced model, a reported cost with no catalogue price,
 * and a cache-read price the catalogue does not publish.
 *
 * Two rules govern every branch.
 *
 * **A reported cost beats a computed one, and the two are never blended.** When
 * the provider says what it charged, that figure is the total. The per-bucket
 * split may still be computed from catalogue prices, because the provider does
 * not break it down, and the note says so.
 *
 * **A number that cannot be established is `null`, never `0`.** `$0.00` is a
 * factual claim that the request was free. `null` says PairPilot does not know,
 * and the UI renders it as "Unavailable".
 *
 * One arithmetic detail drives most of this file: `cached_tokens` is a *subset*
 * of `prompt_tokens`, following OpenAI's convention, which OpenRouter mirrors.
 * Cached tokens are therefore subtracted from the uncached count before the two
 * are priced at their different rates. Adding them instead — the obvious mistake
 * — would bill every cached token twice. The two buckets are then both added
 * into `totalUsd`, which is the other half of the same mistake: pricing cached
 * tokens correctly and then dropping them from the total under-reports every
 * cache-heavy request.
 */

import type { ModelPricing } from '../types/model';
import type { CostBreakdown, PricingSnapshot } from '../types/usage';

export interface CostInput {
  inputTokens: number;
  outputTokens: number;
  /** Cached prompt tokens. A subset of `inputTokens`. */
  cachedTokens: number;
  /** The charge the provider reported, if it reported one. USD. */
  reportedCostUsd: number | null;
  /** The catalogue prices in force, if the model could be looked up. */
  pricing: ModelPricing | null;
  /** Model id, used in the explanation. */
  modelId?: string | null;
}

/** Costs are small; this keeps float noise out of the stored value. */
function roundUsd(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

/**
 * Work out what a request cost.
 *
 * The returned `note` is written to be read by a developer who has never seen
 * this code, because it is displayed verbatim under the figure it explains.
 */
export function computeCost(input: CostInput): CostBreakdown {
  const { reportedCostUsd, pricing } = input;

  if (reportedCostUsd !== null) {
    return withReportedTotal(input, reportedCostUsd);
  }

  return estimateFromCatalog(input, pricing);
}

/** The provider told us the total. Prefer it, and say so. */
function withReportedTotal(input: CostInput, reportedCostUsd: number): CostBreakdown {
  const buckets = priceBuckets(input, input.pricing);

  if (buckets === null) {
    return {
      inputUsd: null,
      outputUsd: null,
      cachedUsd: null,
      totalUsd: roundUsd(reportedCostUsd),
      source: 'reported',
      note: 'Reported by OpenRouter for this request. The catalogue published no price for this model, so it could not be split into input and output.',
    };
  }

  return {
    inputUsd: buckets.inputUsd,
    outputUsd: buckets.outputUsd,
    cachedUsd: buckets.cachedUsd,
    totalUsd: roundUsd(reportedCostUsd),
    source: 'reported',
    note: `Reported by OpenRouter for this request.${buckets.note} The split above is worked out from catalogue prices and may not add up to the reported total exactly.`,
  };
}

/** No reported cost. Compute from published prices, and label it an estimate. */
function estimateFromCatalog(input: CostInput, pricing: ModelPricing | null): CostBreakdown {
  if (pricing === null) {
    return {
      inputUsd: null,
      outputUsd: null,
      cachedUsd: null,
      totalUsd: null,
      source: 'unavailable',
      note: 'OpenRouter did not report a cost for this request, and the model is not in the cached catalogue, so PairPilot cannot work one out.',
    };
  }

  const buckets = priceBuckets(input, pricing);
  if (buckets === null) {
    return {
      inputUsd: null,
      outputUsd: null,
      cachedUsd: null,
      totalUsd: null,
      source: 'unavailable',
      note: 'OpenRouter did not report a cost for this request, and the catalogue publishes no input or output price for this model.',
    };
  }

  return {
    inputUsd: buckets.inputUsd,
    outputUsd: buckets.outputUsd,
    cachedUsd: buckets.cachedUsd,
    // Every bucket is in the total. `cachedUsd` is easy to forget here because
    // cached tokens are *inside* `inputTokens` — but they are priced separately
    // and are not part of `inputUsd`, so leaving them out would under-report
    // every cache-heavy request.
    totalUsd: roundUsd(
      buckets.inputUsd + buckets.outputUsd + buckets.cachedUsd + (pricing.requestUsd ?? 0)
    ),
    source: 'estimated',
    note: `Estimated from catalogue prices, not reported by OpenRouter.${buckets.note} The real charge can differ — discard policies, routing and provider-specific pricing are not visible here.`,
  };
}

interface Buckets {
  inputUsd: number;
  outputUsd: number;
  cachedUsd: number;
  /** Extra sentences about anything that had to be assumed. */
  note: string;
}

/**
 * Price the token buckets.
 *
 * Returns `null` only when there is nothing to price with at all: no prompt
 * price and no completion price. A model publishing only one of the two is
 * still partially priceable, and the note records which half is missing.
 */
function priceBuckets(input: CostInput, pricing: ModelPricing | null): Buckets | null {
  if (pricing === null) {
    return null;
  }
  const { promptPerToken, completionPerToken, cacheReadPerToken } = pricing;
  if (promptPerToken === null && completionPerToken === null) {
    return null;
  }

  const notes: string[] = [];

  // Cached tokens sit inside inputTokens, so they are removed before the
  // remainder is priced at the full input rate.
  const cachedTokens = Math.max(0, Math.min(input.cachedTokens, input.inputTokens));
  const uncachedInputTokens = input.inputTokens - cachedTokens;

  let inputUsd = 0;
  let cachedUsd = 0;

  if (promptPerToken === null) {
    notes.push('The catalogue publishes no input price, so the input side could not be priced.');
    inputUsd = 0;
    cachedUsd = 0;
  } else {
    if (cachedTokens > 0) {
      // Falling back to the standard input rate is an assumption, so it is
      // stated rather than hidden.
      const cacheRate = cacheReadPerToken ?? promptPerToken;
      if (cacheReadPerToken === null) {
        notes.push(
          `Cached tokens were priced at the standard input rate because the catalogue publishes no cache-read price for this model.`
        );
      }
      cachedUsd = cachedTokens * cacheRate;
    }
    inputUsd = uncachedInputTokens * promptPerToken;
  }

  if (completionPerToken === null) {
    notes.push('The catalogue publishes no output price, so the output side could not be priced.');
  }
  const outputUsd = completionPerToken === null ? 0 : input.outputTokens * completionPerToken;

  return {
    inputUsd: roundUsd(inputUsd),
    outputUsd: roundUsd(outputUsd),
    cachedUsd: roundUsd(cachedUsd),
    note: notes.length > 0 ? ` ${notes.join(' ')}` : '',
  };
}

/**
 * Freeze the prices used for a request.
 *
 * Stored with every usage record so a past cost stays explicable after the
 * catalogue moves on. Without it, reopening last month's session would silently
 * re-derive its cost at today's prices and disagree with the figure shown at the
 * time — with no way to tell which was right.
 */
export function snapshotPricing(
  modelId: string | null,
  pricing: ModelPricing | null,
  at: number
): PricingSnapshot | null {
  if (modelId === null || pricing === null) {
    return null;
  }
  // A model with no published price at all has nothing worth freezing.
  if (
    pricing.promptPerToken === null &&
    pricing.completionPerToken === null &&
    pricing.cacheReadPerToken === null
  ) {
    return null;
  }
  return {
    modelId,
    promptPerToken: pricing.promptPerToken,
    completionPerToken: pricing.completionPerToken,
    cacheReadPerToken: pricing.cacheReadPerToken,
    capturedAt: at,
  };
}

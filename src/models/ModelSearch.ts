/**
 * Model Explorer search, filtering and sorting.
 *
 * Kept as pure functions over a `ModelMetadata[]` so the behaviour can be tested
 * exhaustively without a registry, a network or storage — and so the Explorer
 * and the Model Advisor can share one notion of what a filter means.
 *
 * The invariant that matters most here is the treatment of `null`: a model whose
 * price is unknown sorts *after* every priced model rather than being treated as
 * free. "Unknown" silently sorting as "$0.00" would put the most expensive
 * models at the top of a cheapest-first list.
 */

import {
  LARGE_CONTEXT_TOKENS,
  LOW_COST_INPUT_PER_MILLION_USD,
  type ModelMetadata,
  type ModelQuery,
  type ModelQuickFilter,
  type ModelSortKey,
} from '../types/model';

/** Case-insensitive match over everything a developer might search by. */
export function matchesSearch(model: ModelMetadata, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  const haystack = [model.name, model.id, model.developer ?? '', model.description ?? '']
    .join('\n')
    .toLowerCase();
  return haystack.includes(needle);
}

/** Whether a model satisfies one quick filter. */
export function matchesQuickFilter(model: ModelMetadata, filter: ModelQuickFilter): boolean {
  switch (filter) {
    case 'coding':
      return model.capabilities.toolCalling || model.capabilities.structuredOutput;
    case 'reasoning':
      return model.capabilities.reasoning;
    case 'low-cost': {
      const perMillion = model.pricing.promptPerToken;
      // An unpriced model is not cheap; it is unknown, and does not match.
      return perMillion !== null && perMillion * 1_000_000 <= LOW_COST_INPUT_PER_MILLION_USD;
    }
    case 'large-context':
      return model.contextLength !== null && model.contextLength >= LARGE_CONTEXT_TOKENS;
    case 'vision':
      return model.capabilities.inputModalities.includes('image');
    case 'audio':
      return (
        model.capabilities.inputModalities.includes('audio') ||
        model.capabilities.outputModalities.includes('audio')
      );
    case 'tool-calling':
      return model.capabilities.toolCalling;
    case 'structured-output':
      return model.capabilities.structuredOutput;
    case 'free':
      return model.pricing.isFree;
    default:
      return true;
  }
}

export interface FilterOptions {
  /** Ids the developer has starred. */
  favorites: ReadonlySet<string>;
}

/** Apply every active constraint. */
export function filterModels(
  models: readonly ModelMetadata[],
  query: ModelQuery,
  options: FilterOptions
): ModelMetadata[] {
  return models.filter((model) => {
    if (!matchesSearch(model, query.search)) {
      return false;
    }
    if (query.favoritesOnly && !options.favorites.has(model.id)) {
      return false;
    }
    if (
      query.minContextLength !== null &&
      (model.contextLength === null || model.contextLength < query.minContextLength)
    ) {
      return false;
    }
    if (query.maxInputPricePerMillion !== null) {
      const perMillion = model.pricing.promptPerToken;
      // A model with no published price cannot be shown to satisfy a price cap.
      if (perMillion === null || perMillion * 1_000_000 > query.maxInputPricePerMillion) {
        return false;
      }
    }
    // Every selected filter must hold, so combining them narrows the list.
    return query.quickFilters.every((filter) => matchesQuickFilter(model, filter));
  });
}

/**
 * Sort a filtered list.
 *
 * `null` always sorts last, whatever the direction. Ascending by price with the
 * unknown-price models at the bottom is the only ordering that cannot mislead.
 */
export function sortModels(models: readonly ModelMetadata[], key: ModelSortKey): ModelMetadata[] {
  const sorted = [...models];
  sorted.sort((left, right) => {
    switch (key) {
      case 'input-cost':
        return compareNullable(left.pricing.promptPerToken, right.pricing.promptPerToken, 'asc');
      case 'output-cost':
        return compareNullable(
          left.pricing.completionPerToken,
          right.pricing.completionPerToken,
          'asc'
        );
      case 'context':
        return compareNullable(left.contextLength, right.contextLength, 'desc');
      case 'newest':
        return compareNullable(left.created, right.created, 'desc');
      case 'provider':
        return (
          compareNullable(left.developer, right.developer, 'asc') ||
          left.name.localeCompare(right.name)
        );
      default:
        return left.name.localeCompare(right.name);
    }
  });
  return sorted;
}

/** Compare two possibly-absent values, keeping absent values at the end. */
export function compareNullable<T extends number | string>(
  left: T | null,
  right: T | null,
  direction: 'asc' | 'desc'
): number {
  if (left === null && right === null) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }

  let result: number;
  if (typeof left === 'number' && typeof right === 'number') {
    result = left - right;
  } else {
    result = String(left).localeCompare(String(right));
  }
  return direction === 'asc' ? result : -result;
}

/** The whole pipeline, in the order the Explorer applies it. */
export function selectModels(
  models: readonly ModelMetadata[],
  query: ModelQuery,
  options: FilterOptions
): ModelMetadata[] {
  return sortModels(filterModels(models, query, options), query.sort);
}

/** The default query, so the Explorer and its tests cannot disagree. */
export function defaultModelQuery(): ModelQuery {
  return {
    search: '',
    quickFilters: [],
    maxInputPricePerMillion: null,
    minContextLength: null,
    sort: 'name',
    favoritesOnly: false,
  };
}

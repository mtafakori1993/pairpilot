/**
 * Model catalogue types.
 *
 * The governing rule for this whole module is that a field is either a fact the
 * provider published, or `null`. There is no third option: no default of `0`, no
 * empty string, no "sensible" guess. A `null` context length renders as
 * "Not provided", which is a different and more honest statement than "0 tokens" —
 * and the Model Advisor refuses to rank on a value it does not have.
 *
 * Prices are stored **per single token**, exactly as OpenRouter publishes them
 * (`"0.00003"` means $0.00003/token). Per-million figures are a presentation
 * concern and are computed at render time, never stored, so the two can never
 * drift apart.
 */

import type { ProviderId } from './provider';

/** Input modalities the catalogue can advertise. */
export const MODEL_INPUT_MODALITIES = ['text', 'image', 'file', 'audio', 'video'] as const;
export type ModelInputModality = (typeof MODEL_INPUT_MODALITIES)[number];

/** Output modalities the catalogue can advertise. */
export const MODEL_OUTPUT_MODALITIES = [
  'text',
  'image',
  'embeddings',
  'audio',
  'video',
  'rerank',
  'decisions',
  'speech',
  'transcription',
] as const;
export type ModelOutputModality = (typeof MODEL_OUTPUT_MODALITIES)[number];

/**
 * Pricing for one model, in USD per token.
 *
 * `prompt` and `completion` are the only fields OpenRouter documents as always
 * present; every other field is omitted entirely when it does not apply, so
 * `null` here means "the catalogue did not publish this", not "free".
 */
export interface ModelPricing {
  promptPerToken: number | null;
  completionPerToken: number | null;
  cacheReadPerToken: number | null;
  cacheWritePerToken: number | null;
  /** Flat per-request charge, when the model has one. */
  requestUsd: number | null;
  /** Per-input-image charge, when the model has one. */
  imageUsd: number | null;
  /**
   * True only when the catalogue explicitly priced both prompt and completion at
   * zero. A model with *unknown* pricing is not free — it is unknown.
   */
  isFree: boolean;
}

export function emptyPricing(): ModelPricing {
  return {
    promptPerToken: null,
    completionPerToken: null,
    cacheReadPerToken: null,
    cacheWritePerToken: null,
    requestUsd: null,
    imageUsd: null,
    isFree: false,
  };
}

/**
 * Capabilities, each derived from a specific catalogue field rather than from a
 * curated list. Nothing here is hand-maintained per model, so a model missing
 * from these flags is missing because the catalogue did not say, not because
 * nobody updated a table.
 */
export interface ModelCapabilities {
  inputModalities: ModelInputModality[];
  outputModalities: ModelOutputModality[];
  /** `supported_parameters` contains `tools`. */
  toolCalling: boolean;
  /** `supported_parameters` contains `structured_outputs` or `response_format`. */
  structuredOutput: boolean;
  /** `supported_parameters` mentions reasoning, or the model exposes a reasoning block. */
  reasoning: boolean;
  /** The raw parameter list, so the details view can show what it actually accepts. */
  supportedParameters: string[];
}

export function emptyCapabilities(): ModelCapabilities {
  return {
    inputModalities: [],
    outputModalities: [],
    toolCalling: false,
    structuredOutput: false,
    reasoning: false,
    supportedParameters: [],
  };
}

/**
 * One model, normalised.
 *
 * `unknownFields` lists the catalogue fields that were absent. It exists so the
 * details view can state precisely what is missing instead of silently rendering
 * a blank where a number should be.
 */
export interface ModelMetadata {
  id: string;
  canonicalSlug: string | null;
  name: string;
  /**
   * The vendor, derived from the `vendor/model` id prefix.
   *
   * This is a derivation, not a published field, so it is `null` for an id with
   * no `/`. The UI labels it as derived.
   */
  developer: string | null;
  description: string | null;
  contextLength: number | null;
  maxOutputTokens: number | null;
  /** Unix seconds, when the catalogue reported it. */
  created: number | null;
  pricing: ModelPricing;
  capabilities: ModelCapabilities;
  unknownFields: string[];
  /** Epoch ms this record was captured, so staleness is visible. */
  capturedAt: number;
}

/** A cached catalogue plus when it was captured. */
export interface ModelCatalog {
  providerId: ProviderId;
  fetchedAt: number;
  models: ModelMetadata[];
  /** True when served from cache after a failed refresh. */
  stale: boolean;
  /** Why the most recent refresh failed, when it did. */
  refreshError: string | null;
}

/** Sort keys offered by the Model Explorer. */
export const MODEL_SORT_KEYS = [
  'name',
  'input-cost',
  'output-cost',
  'context',
  'provider',
  'newest',
] as const;
export type ModelSortKey = (typeof MODEL_SORT_KEYS)[number];

/**
 * Quick filters, each backed by a catalogue fact rather than a judgement.
 *
 * A "Fast" filter is deliberately absent. The catalogue publishes no latency or
 * throughput field, so there is nothing to filter on — any such filter would be
 * asserting a speed nobody measured. The rule behind each filter that *is* here
 * is displayed next to it in the UI, so a developer can always see what it
 * actually selects.
 */
export const MODEL_QUICK_FILTERS = [
  'coding',
  'reasoning',
  'low-cost',
  'large-context',
  'vision',
  'audio',
  'tool-calling',
  'structured-output',
  'free',
] as const;
export type ModelQuickFilter = (typeof MODEL_QUICK_FILTERS)[number];

/** The rule each quick filter applies. Shown verbatim as the filter's tooltip. */
export const MODEL_QUICK_FILTER_RULES: Readonly<Record<ModelQuickFilter, string>> = {
  coding: 'Publishes tool calling or structured output in its supported parameters.',
  reasoning: 'Publishes a reasoning parameter block or a reasoning parameter.',
  'low-cost': 'Input priced at or below $1.00 per million tokens.',
  'large-context': 'Advertises a context window of 200,000 tokens or more.',
  vision: 'Accepts image input.',
  audio: 'Accepts audio input, or produces audio output.',
  'tool-calling': 'Publishes the `tools` parameter.',
  'structured-output': 'Publishes `structured_outputs` or `response_format`.',
  free: 'Priced at exactly zero for both input and output.',
};

/** Filters expressing a threshold, named so the UI and the README cannot drift. */
export const LOW_COST_INPUT_PER_MILLION_USD = 1;
export const LARGE_CONTEXT_TOKENS = 200_000;

export interface ModelQuery {
  search: string;
  quickFilters: ModelQuickFilter[];
  /** Inclusive upper bound on the blended input price, USD per million tokens. */
  maxInputPricePerMillion: number | null;
  minContextLength: number | null;
  sort: ModelSortKey;
  favoritesOnly: boolean;
}

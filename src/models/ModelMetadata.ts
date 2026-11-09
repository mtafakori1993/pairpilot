/**
 * Normalisation of the raw catalogue into `ModelMetadata`.
 *
 * Two things make this more than a field-mapping exercise.
 *
 * **The catalogue is not always the shape the docs describe.** A live
 * `GET /models` capture taken while building this returned objects carrying
 * `display_name`, `max_input_tokens`, `max_tokens` and a null `capabilities`
 * field, and *no* `pricing`, `architecture` or `context_length` at all —
 * contradicting the published schema. The normaliser therefore reads a set of
 * documented alternatives per field, in priority order, and never treats an
 * absent value as zero. If none of the alternatives is present, the field is
 * `null` and its name is recorded in `unknownFields` so the UI can say
 * "Not provided" rather than render a blank.
 *
 * **Prices are per token.** The published values are strings such as
 * `"0.00003"`, documented as "USD per token". Everything downstream multiplies
 * by a token count; per-million figures exist only at render time, via
 * `perMillion`, so the two conventions cannot be confused halfway through a
 * calculation.
 *
 * There is no model list, no vendor allowlist and no per-model special case in
 * this file. Every fact comes from the response.
 */

import {
  MODEL_INPUT_MODALITIES,
  MODEL_OUTPUT_MODALITIES,
  emptyPricing,
  type ModelCapabilities,
  type ModelInputModality,
  type ModelMetadata,
  type ModelOutputModality,
  type ModelPricing,
} from '../types/model';
import { asNumber, asRecord, asString, isRecord } from '../providers/OpenRouterClient';

/** Parameters whose presence implies the capability, per OpenRouter's docs. */
const TOOL_PARAMETERS = ['tools', 'tool_choice', 'parallel_tool_calls'];
const STRUCTURED_PARAMETERS = ['structured_outputs', 'response_format'];
const REASONING_PARAMETERS = ['reasoning', 'include_reasoning', 'reasoning_effort'];

/**
 * Normalise one catalogue entry.
 *
 * Returns `null` only when there is no usable identifier — without an id there
 * is nothing to select, so the entry is dropped rather than given a synthetic
 * one.
 */
export function normalizeModel(raw: unknown, capturedAt: number): ModelMetadata | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }

  const id = asString(record['id']);
  if (id === null) {
    return null;
  }

  const unknownFields: string[] = [];

  // `name` is the documented display name; `display_name` is the spelling the
  // observed variant used. Falling back to the id is not an invention — the id
  // is the model's canonical name.
  const publishedName = asString(record['name']) ?? asString(record['display_name']);
  const name = publishedName ?? id;
  if (publishedName === null) {
    unknownFields.push('display name');
  }

  const description = asString(record['description']);
  if (description === null) {
    unknownFields.push('description');
  }

  const contextLength = readContextLength(record);
  if (contextLength === null) {
    unknownFields.push('context length');
  }

  const maxOutputTokens = readMaxOutputTokens(record);
  if (maxOutputTokens === null) {
    unknownFields.push('max output tokens');
  }

  const created = readCreated(record);
  if (created === null) {
    unknownFields.push('release date');
  }

  const pricing = readPricing(record['pricing']);
  if (pricing === null) {
    unknownFields.push('pricing');
  }

  return {
    id,
    canonicalSlug: asString(record['canonical_slug']),
    name,
    developer: deriveDeveloper(id),
    description,
    contextLength,
    maxOutputTokens,
    created,
    pricing: pricing ?? emptyPricing(),
    capabilities: readCapabilities(record),
    unknownFields,
    capturedAt,
  };
}

/**
 * Context length, in preference order.
 *
 * `context_length` is the documented model-level figure. `top_provider.context_length`
 * is documented separately as the context the top provider serves, which is the
 * effective limit when it is present. `max_input_tokens` is the observed
 * variant's spelling of the same quantity. All three are real published values;
 * none is a guess.
 */
function readContextLength(record: Record<string, unknown>): number | null {
  const direct = asNumber(record['context_length']);
  if (direct !== null && direct > 0) {
    return direct;
  }

  const topProvider = asRecord(record['top_provider']);
  if (topProvider !== null) {
    const fromTopProvider = asNumber(topProvider['context_length']);
    if (fromTopProvider !== null && fromTopProvider > 0) {
      return fromTopProvider;
    }
  }

  const variant = asNumber(record['max_input_tokens']);
  return variant !== null && variant > 0 ? variant : null;
}

/** Maximum generated tokens: the documented field, then the variant's spelling. */
function readMaxOutputTokens(record: Record<string, unknown>): number | null {
  const topProvider = asRecord(record['top_provider']);
  if (topProvider !== null) {
    const documented = asNumber(topProvider['max_completion_tokens']);
    if (documented !== null && documented > 0) {
      return documented;
    }
  }

  const variant = asNumber(record['max_tokens']);
  return variant !== null && variant > 0 ? variant : null;
}

/**
 * Release date, normalised to unix seconds.
 *
 * The documented field is an integer; the variant used an ISO-8601 string.
 * A date that will not parse is reported as absent, not as `NaN`.
 */
function readCreated(record: Record<string, unknown>): number | null {
  const unix = asNumber(record['created']);
  if (unix !== null && unix > 0) {
    return Math.floor(unix);
  }

  const iso = asString(record['created_at']);
  if (iso !== null) {
    const parsed = Date.parse(iso);
    if (!Number.isNaN(parsed)) {
      return Math.floor(parsed / 1000);
    }
  }

  return null;
}

/**
 * Pricing, in USD per token.
 *
 * Returns `null` when the catalogue carried no pricing object at all, which is
 * distinct from a pricing object of zeroes — an unpriced model must never be
 * mistaken for a free one.
 */
function readPricing(raw: unknown): ModelPricing | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }

  const promptPerToken = asNumber(record['prompt']);
  const completionPerToken = asNumber(record['completion']);

  return {
    promptPerToken,
    completionPerToken,
    cacheReadPerToken: asNumber(record['input_cache_read']),
    cacheWritePerToken: asNumber(record['input_cache_write']),
    requestUsd: asNumber(record['request']),
    imageUsd: asNumber(record['image']),
    // Only an explicit zero on both sides counts as free.
    isFree: promptPerToken === 0 && completionPerToken === 0,
  };
}

/**
 * Capabilities, derived from the parameter list and the declared modalities.
 *
 * Nothing here is a curated per-model table, so the flags stay correct as the
 * catalogue changes without anyone maintaining a list.
 */
function readCapabilities(record: Record<string, unknown>): ModelCapabilities {
  const architecture = asRecord(record['architecture']);

  const inputModalities = architecture === null
    ? []
    : readModalities<ModelInputModality>(architecture['input_modalities'], MODEL_INPUT_MODALITIES);
  const outputModalities = architecture === null
    ? []
    : readModalities<ModelOutputModality>(architecture['output_modalities'], MODEL_OUTPUT_MODALITIES);

  const supportedParameters = readStringArray(record['supported_parameters']);

  const has = (names: string[]): boolean =>
    names.some((parameter) => supportedParameters.includes(parameter));

  // The documented `reasoning` object is present only on models that reason, so
  // its presence is itself the evidence.
  const declaresReasoningBlock = isRecord(record['reasoning']);

  return {
    inputModalities,
    outputModalities,
    toolCalling: has(TOOL_PARAMETERS),
    structuredOutput: has(STRUCTURED_PARAMETERS),
    reasoning: declaresReasoningBlock || has(REASONING_PARAMETERS),
    supportedParameters,
  };
}

/** Keep only values the schema defines. An unknown token is dropped, not guessed at. */
function readModalities<T extends string>(raw: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const permitted = new Set<string>(allowed);
  const seen = new Set<T>();
  for (const entry of raw) {
    if (typeof entry === 'string' && permitted.has(entry)) {
      seen.add(entry as T);
    }
  }
  return [...seen];
}

function readStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * The vendor, from the `vendor/model` id prefix.
 *
 * This is a derivation from the identifier's own structure, not a published
 * field, which is why the UI labels it as derived and why an id with no `/`
 * yields `null` rather than an empty string.
 */
export function deriveDeveloper(id: string): string | null {
  const separator = id.indexOf('/');
  if (separator <= 0) {
    return null;
  }
  return id.slice(0, separator);
}

/** Convert a per-token price to the per-million figure the UI displays. */
export function perMillion(perToken: number | null): number | null {
  return perToken === null ? null : perToken * 1_000_000;
}

/** True when the model advertises both texts in and text out. */
export function isTextToText(model: ModelMetadata): boolean {
  const inputs = model.capabilities.inputModalities;
  const outputs = model.capabilities.outputModalities;
  const acceptsText = inputs.length === 0 || inputs.includes('text');
  return acceptsText && (outputs.length === 0 || outputs.includes('text'));
}

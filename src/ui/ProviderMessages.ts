/**
 * The message contract between the provider Webviews and the Extension Host.
 *
 * Everything arriving from a Webview is untrusted input, and is treated as such:
 * each message is validated field by field against a bounded shape before the
 * Host acts on it. A Webview is not a privileged caller just because PairPilot
 * wrote it — its content can be influenced by model output, and the whole point
 * of the CSP is that it must not be able to talk the Host into anything.
 *
 * Two decisions here are load-bearing for security.
 *
 * **`openExternal` names a destination, not a URL.** The Webview cannot ask the
 * Host to open an arbitrary address. It can ask for one of three documented
 * destinations, which the Host maps to a constant. A URL-validating
 * implementation would have to get its allowlist exactly right on every future
 * edit; this one cannot be wrong, because there is no URL to validate.
 *
 * **Model ids are pattern-checked.** A model id reaches an outbound HTTP request
 * body. Bounding its length and character set means a malformed or hostile id
 * cannot become part of a request in an unexpected shape.
 */

import {
  MODEL_QUICK_FILTERS,
  MODEL_SORT_KEYS,
  type ModelQuickFilter,
  type ModelSortKey,
} from '../types/model';
import type { ProviderId } from '../types/provider';
import type { ModelTaskId, SelectionLevel } from '../types/providerConfig';

/** Maximum length accepted for any identifier taken from a Webview. */
const MAX_ID_LENGTH = 200;

/** Model and provider ids: the alphabet OpenRouter and PairPilot actually use. */
const ID_PATTERN = /^[A-Za-z0-9._:@+/-]+$/;

/** Selections the UI is allowed to write. `task` is set by the Host, not the UI. */
const SETTABLE_LEVELS: readonly SelectionLevel[] = ['global', 'project', 'role'];

const PROVIDER_IDS: readonly ProviderId[] = ['claude-code', 'openrouter'];

const TASK_IDS: readonly ModelTaskId[] = [
  'product-discovery',
  'architecture-design',
  'coding',
  'code-review',
  'simple-questions',
  'documentation',
  'large-repo-analysis',
];

const EXTERNAL_TARGETS = ['keys', 'credits', 'usage'] as const;
export type ExternalTarget = (typeof EXTERNAL_TARGETS)[number];

/** Where each named destination actually points. */
export const EXTERNAL_URLS: Readonly<Record<ExternalTarget, string>> = {
  keys: 'https://openrouter.ai/keys',
  credits: 'https://openrouter.ai/credits',
  usage: 'https://openrouter.ai/activity',
};

export type ProviderRequest =
  | { type: 'ready' }
  | { type: 'setApiKey' }
  | { type: 'clearApiKey' }
  | { type: 'testConnection' }
  | { type: 'selectProvider'; providerId: ProviderId }
  | { type: 'setProviderEnabled'; providerId: ProviderId; enabled: boolean }
  | { type: 'refreshCatalog' }
  | { type: 'setQuery'; search: string; quickFilters: ModelQuickFilter[]; sort: ModelSortKey; favoritesOnly: boolean }
  | { type: 'loadMore' }
  | { type: 'selectModel'; level: SelectionLevel; key: string | null; modelId: string }
  | { type: 'clearSelection'; level: SelectionLevel; key: string | null }
  | { type: 'toggleFavorite'; modelId: string }
  | { type: 'showModelDetails'; modelId: string | null }
  | { type: 'requestAdvice'; taskId: ModelTaskId }
  | { type: 'applyAdvice'; roleId: ModelTaskId; modelId: string }
  | { type: 'openExternal'; target: ExternalTarget };

export type CostRequest =
  | { type: 'ready' }
  | { type: 'clearHistory' }
  | { type: 'selectRange'; days: number };

/**
 * Two result types rather than one union, so a caller cannot be handed a cost
 * message by the provider parser and then act on it as though it were a provider
 * message. The types carry that distinction; a `switch` on the wrong union would
 * not compile.
 */
export type ProviderParseResult =
  | { ok: true; request: ProviderRequest }
  | { ok: false; reason: string };

export type CostParseResult = { ok: true; request: CostRequest } | { ok: false; reason: string };

/**
 * Validate a message from the providers panel.
 *
 * Returns a reason on rejection rather than throwing: a malformed message from a
 * Webview is a bug or an attack, and either way the Host should log it and
 * continue rather than tear down.
 */
export function parseProviderRequest(raw: unknown): ProviderParseResult {
  const record = asRecord(raw);
  if (record === null) {
    return reject('a message must be an object');
  }
  const type = asString(record['type']);
  if (type === null) {
    return reject('a message must have a string "type"');
  }

  switch (type) {
    case 'ready':
    case 'setApiKey':
    case 'clearApiKey':
    case 'testConnection':
    case 'refreshCatalog':
    case 'loadMore':
      return accept({ type });

    case 'selectProvider': {
      const providerId = readProviderId(record['providerId']);
      return providerId === null
        ? reject('unknown provider id')
        : accept({ type, providerId });
    }

    case 'setProviderEnabled': {
      const providerId = readProviderId(record['providerId']);
      const enabled = record['enabled'];
      if (providerId === null) {
        return reject('unknown provider id');
      }
      if (typeof enabled !== 'boolean') {
        return reject('"enabled" must be a boolean');
      }
      return accept({ type, providerId, enabled });
    }

    case 'setQuery': {
      const search = typeof record['search'] === 'string' ? record['search'].slice(0, 200) : '';
      return accept({
        type,
        search,
        // Validated against the same constants the Explorer renders, so an
        // unknown filter name is dropped here rather than travelling inward and
        // being silently ignored by `matchesQuickFilter`.
        quickFilters: readQuickFilters(record['quickFilters']),
        sort: readSortKey(record['sort']),
        favoritesOnly: record['favoritesOnly'] === true,
      });
    }

    case 'selectModel': {
      const level = readLevel(record['level']);
      const key = readOptionalKey(record['key']);
      const modelId = readId(record['modelId']);
      if (level === null) return reject('unknown selection level');
      if (key === undefined) return reject('"key" must be a string or null');
      if (modelId === null) return reject('"modelId" is missing or malformed');
      if (!isKeyValidForLevel(level, key)) return reject(`level "${level}" requires a key`);
      return accept({ type, level, key, modelId });
    }

    case 'clearSelection': {
      const level = readLevel(record['level']);
      const key = readOptionalKey(record['key']);
      if (level === null) return reject('unknown selection level');
      if (key === undefined) return reject('"key" must be a string or null');
      if (!isKeyValidForLevel(level, key)) return reject(`level "${level}" requires a key`);
      return accept({ type, level, key });
    }

    case 'toggleFavorite': {
      const modelId = readId(record['modelId']);
      return modelId === null
        ? reject('"modelId" is missing or malformed')
        : accept({ type, modelId });
    }

    case 'showModelDetails': {
      if (record['modelId'] === null || record['modelId'] === undefined) {
        return accept({ type, modelId: null });
      }
      const modelId = readId(record['modelId']);
      return modelId === null
        ? reject('"modelId" is malformed')
        : accept({ type, modelId });
    }

    case 'requestAdvice': {
      const taskId = readTaskId(record['taskId']);
      return taskId === null
        ? reject('unknown task id')
        : accept({ type, taskId });
    }

    case 'applyAdvice': {
      const roleId = readTaskId(record['roleId']);
      const modelId = readId(record['modelId']);
      if (roleId === null) return reject('unknown role id');
      if (modelId === null) return reject('"modelId" is missing or malformed');
      return accept({ type, roleId, modelId });
    }

    case 'openExternal': {
      const target = record['target'];
      if (typeof target !== 'string' || !EXTERNAL_TARGETS.includes(target as ExternalTarget)) {
        // The Webview names a destination from a fixed set. It never supplies a
        // URL, so there is nothing here to validate as one.
        return reject('unknown external target');
      }
      return accept({ type, target: target as ExternalTarget });
    }

    default:
      return reject(`unsupported message type "${type}"`);
  }
}

/** Validate a message from the cost panel. */
export function parseCostRequest(raw: unknown): CostParseResult {
  const record = asRecord(raw);
  if (record === null) {
    return reject('a message must be an object');
  }
  const type = asString(record['type']);
  if (type === null) {
    return reject('a message must have a string "type"');
  }

  switch (type) {
    case 'ready':
    case 'clearHistory':
      return accept({ type });

    case 'selectRange': {
      const days = record['days'];
      if (typeof days !== 'number' || !Number.isFinite(days)) {
        return reject('"days" must be a number');
      }
      return accept({ type, days: Math.min(Math.max(Math.trunc(days), 1), 365) });
    }

    default:
      return reject(`unsupported message type "${type}"`);
  }
}

/* -------------------------------------------------------------------------- */

/**
 * Overloads rather than one union-returning signature.
 *
 * Each parser is exhaustive over its own union, so narrowing the argument here
 * lets a case that returns the wrong shape fail to compile — which is what keeps
 * a provider message from being answered with a cost result, or the reverse.
 */
function accept(request: ProviderRequest): { ok: true; request: ProviderRequest };
function accept(request: CostRequest): { ok: true; request: CostRequest };
function accept(
  request: ProviderRequest | CostRequest
): { ok: true; request: ProviderRequest | CostRequest } {
  return { ok: true, request };
}

function reject(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** An identifier from the Webview: bounded length, restricted alphabet. */
function readId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ID_LENGTH) {
    return null;
  }
  return ID_PATTERN.test(trimmed) ? trimmed : null;
}

function readProviderId(value: unknown): ProviderId | null {
  const id = asString(value);
  return id !== null && PROVIDER_IDS.includes(id as ProviderId) ? (id as ProviderId) : null;
}

function readTaskId(value: unknown): ModelTaskId | null {
  const id = asString(value);
  return id !== null && TASK_IDS.includes(id as ModelTaskId) ? (id as ModelTaskId) : null;
}

function readLevel(value: unknown): SelectionLevel | null {
  const level = asString(value);
  return level !== null && SETTABLE_LEVELS.includes(level as SelectionLevel)
    ? (level as SelectionLevel)
    : null;
}

/** Returns the key, or `undefined` when the field was neither a string nor null. */
function readOptionalKey(value: unknown): string | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  // A project key is a workspace path; it is only ever used as a storage key and
  // never as a file path, but it is still bounded here.
  return value.length <= 1_024 ? value : undefined;
}

/** `global` needs no key; `project` and `role` are meaningless without one. */
function isKeyValidForLevel(level: SelectionLevel, key: string | null): boolean {
  if (level === 'global') {
    return true;
  }
  return key !== null && key.trim().length > 0;
}

/** Keep only filter names the Explorer actually implements. */
function readQuickFilters(value: unknown): ModelQuickFilter[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<ModelQuickFilter>();
  for (const entry of value.slice(0, MODEL_QUICK_FILTERS.length)) {
    if (typeof entry === 'string' && (MODEL_QUICK_FILTERS as readonly string[]).includes(entry)) {
      seen.add(entry as ModelQuickFilter);
    }
  }
  return [...seen];
}

/** A sort key, defaulting to name for anything unrecognised. */
function readSortKey(value: unknown): ModelSortKey {
  return typeof value === 'string' && (MODEL_SORT_KEYS as readonly string[]).includes(value)
    ? (value as ModelSortKey)
    : 'name';
}

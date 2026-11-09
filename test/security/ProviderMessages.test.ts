/**
 * The Webview → Host message contract (spec section 17).
 *
 * A message from a Webview is untrusted input. PairPilot wrote the page, but its
 * content can be shaped by model output, and the whole point of the CSP is that a
 * compromised page must not be able to talk the Host into anything. So every
 * field is validated here, and this file is written from the attacker's side:
 * what would a forged message have to contain to make the Host do something it
 * should not?
 *
 * Two specific attacks are tested directly.
 *
 * **An arbitrary URL.** `openExternal` names a destination from a fixed set and
 * never carries a URL. A message that tries to supply one is rejected, and there
 * is no branch anywhere that would open it.
 *
 * **An oversized or malformed model id.** A model id travels into an outbound
 * HTTP request body. An id of unbounded length or unusual characters is refused
 * here rather than becoming part of a request in an unexpected shape.
 */

import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_URLS,
  parseCostRequest,
  parseProviderRequest,
  type ProviderRequest,
} from '../../src/ui/ProviderMessages';

/** Parse and require success, so the assertion reads on the request itself. */
function ok(raw: unknown): ProviderRequest {
  const parsed = parseProviderRequest(raw);
  if (!parsed.ok) {
    throw new Error(`expected a valid request, got: ${parsed.reason}`);
  }
  return parsed.request;
}

/** Parse and require failure, returning the reason. */
function reason(raw: unknown): string {
  const parsed = parseProviderRequest(raw);
  if (parsed.ok) {
    throw new Error(`expected a rejection, got: ${JSON.stringify(parsed.request)}`);
  }
  return parsed.reason;
}

describe('the envelope', () => {
  it('rejects anything that is not an object with a string type', () => {
    expect(reason(null)).toContain('must be an object');
    expect(reason(undefined)).toContain('must be an object');
    expect(reason('ready')).toContain('must be an object');
    expect(reason(42)).toContain('must be an object');
    // An array is not an object for this purpose.
    expect(reason([])).toContain('must be an object');
    expect(reason({})).toContain('string "type"');
    expect(reason({ type: 7 })).toContain('string "type"');
  });

  it('rejects an unknown message type', () => {
    expect(reason({ type: 'deleteEverything' })).toContain('unsupported message type');
  });

  it('accepts every no-argument message', () => {
    for (const type of ['ready', 'setApiKey', 'clearApiKey', 'testConnection', 'refreshCatalog', 'loadMore']) {
      expect(ok({ type })).toEqual({ type });
    }
  });
});

describe('provider and model ids', () => {
  it('accepts only the providers PairPilot knows', () => {
    expect(ok({ type: 'selectProvider', providerId: 'openrouter' })).toEqual({
      type: 'selectProvider',
      providerId: 'openrouter',
    });
    expect(ok({ type: 'selectProvider', providerId: 'claude-code' })).toEqual({
      type: 'selectProvider',
      providerId: 'claude-code',
    });
    expect(reason({ type: 'selectProvider', providerId: 'attacker' })).toContain('unknown provider id');
    expect(reason({ type: 'selectProvider' })).toContain('unknown provider id');
  });

  it('requires a boolean for enabled', () => {
    expect(ok({ type: 'setProviderEnabled', providerId: 'openrouter', enabled: false })).toEqual({
      type: 'setProviderEnabled',
      providerId: 'openrouter',
      enabled: false,
    });
    expect(reason({ type: 'setProviderEnabled', providerId: 'openrouter', enabled: 'yes' })).toContain(
      '"enabled" must be a boolean'
    );
  });

  it('accepts the ids a real catalogue publishes', () => {
    for (const modelId of [
      'anthropic/claude-sonnet-5-5',
      'meta-llama/llama-4-scout:free',
      'google/gemini-2.5-pro-preview-05-06',
      'x-ai/grok-4@beta',
      'vendor/model+plus',
      'nested/path/model',
    ]) {
      expect(ok({ type: 'toggleFavorite', modelId })).toEqual({ type: 'toggleFavorite', modelId });
    }
  });

  it('rejects an id with characters that have no place in a request body', () => {
    for (const modelId of [
      'vendor/model with spaces',
      'vendor/model"quote',
      'vendor/model{brace}',
      'vendor/model?query=1',
      'vendor/model#fragment',
      'vendor/model<script>',
      'vendor/mod\u0000el',
      'vendor\\model',
      'vendor/model%2Ftraversal',
    ]) {
      expect(reason({ type: 'toggleFavorite', modelId }), JSON.stringify(modelId)).toContain(
        'missing or malformed'
      );
    }
  });

  it('trims surrounding whitespace, and uses the trimmed id', () => {
    // A newline at the end of an id is a copy-paste artefact, not an injection:
    // the trimmed result still has to match the allowed alphabet, so nothing
    // unexpected can reach a request body. The value used is the trimmed one, so
    // a selection cannot be stored under a key the catalogue does not have.
    expect(ok({ type: 'toggleFavorite', modelId: 'vendor/model\n' })).toEqual({
      type: 'toggleFavorite',
      modelId: 'vendor/model',
    });
    expect(ok({ type: 'toggleFavorite', modelId: '  vendor/model  ' })).toEqual({
      type: 'toggleFavorite',
      modelId: 'vendor/model',
    });
  });

  it('rejects an id that is empty after trimming', () => {
    expect(reason({ type: 'toggleFavorite', modelId: '' })).toContain('missing or malformed');
    expect(reason({ type: 'toggleFavorite', modelId: '   ' })).toContain('missing or malformed');
  });

  it('rejects an id longer than the bound', () => {
    // A model id reaches an outbound request body, so its length is bounded.
    expect(reason({ type: 'toggleFavorite', modelId: 'a'.repeat(201) })).toContain(
      'missing or malformed'
    );
    expect(ok({ type: 'toggleFavorite', modelId: 'a'.repeat(200) })).toEqual({
      type: 'toggleFavorite',
      modelId: 'a'.repeat(200),
    });
  });

  it('rejects a non-string id', () => {
    expect(reason({ type: 'toggleFavorite', modelId: 42 })).toContain('missing or malformed');
    expect(reason({ type: 'toggleFavorite' })).toContain('missing or malformed');
  });
});

describe('openExternal never opens an arbitrary URL', () => {
  it('accepts the three named destinations', () => {
    for (const target of ['keys', 'credits', 'usage'] as const) {
      expect(ok({ type: 'openExternal', target })).toEqual({ type: 'openExternal', target });
    }
  });

  it('points each destination at a fixed, documented address', () => {
    expect(EXTERNAL_URLS.keys).toBe('https://openrouter.ai/keys');
    for (const url of Object.values(EXTERNAL_URLS)) {
      expect(url.startsWith('https://openrouter.ai/')).toBe(true);
    }
  });

  it('rejects a URL supplied in place of a destination', () => {
    const attack = [
      { type: 'openExternal', target: 'https://evil.example.com' },
      { type: 'openExternal', target: 'file:///etc/passwd' },
      { type: 'openExternal', target: 'vscode://some.other/command' },
      { type: 'openExternal', url: 'https://evil.example.com' },
      { type: 'openExternal', target: 'KEYS' },
      { type: 'openExternal' },
    ];
    for (const message of attack) {
      expect(reason(message), JSON.stringify(message)).toContain('unknown external target');
    }
  });

  it('cannot be talked into an address even with a valid destination alongside it', () => {
    // The extra field is simply not read: the request carries only the target.
    expect(ok({ type: 'openExternal', target: 'keys', url: 'https://evil.example.com' })).toEqual({
      type: 'openExternal',
      target: 'keys',
    });
  });
});

describe('selection levels and keys', () => {
  it('accepts the levels the UI may write', () => {
    for (const level of ['global', 'project', 'role']) {
      const key = level === 'global' ? null : '/repo';
      expect(ok({ type: 'selectModel', level, key, modelId: 'a/b' })).toEqual({
        type: 'selectModel',
        level,
        key,
        modelId: 'a/b',
      });
    }
  });

  it('refuses the task level, which only the Host sets', () => {
    // A per-task override is written by the Host from a recommendation, never
    // posted by the page.
    expect(reason({ type: 'selectModel', level: 'task', key: 'coding', modelId: 'a/b' })).toContain(
      'unknown selection level'
    );
  });

  it('requires a key wherever a key is meaningful', () => {
    expect(reason({ type: 'selectModel', level: 'project', key: null, modelId: 'a/b' })).toContain(
      'requires a key'
    );
    expect(reason({ type: 'selectModel', level: 'role', key: '  ', modelId: 'a/b' })).toContain(
      'requires a key'
    );
    // Global needs none.
    expect(ok({ type: 'selectModel', level: 'global', key: null, modelId: 'a/b' })).toBeTruthy();
  });

  it('rejects a key that is neither a string nor null', () => {
    expect(reason({ type: 'selectModel', level: 'project', key: 42, modelId: 'a/b' })).toContain(
      '"key" must be a string or null'
    );
  });

  it('rejects an absurdly long key, since a project key is a path', () => {
    expect(
      reason({ type: 'selectModel', level: 'project', key: 'x'.repeat(2_000), modelId: 'a/b' })
    ).toContain('"key" must be a string or null');
  });

  it('treats a missing key as null for a clear', () => {
    expect(ok({ type: 'clearSelection', level: 'global' })).toEqual({
      type: 'clearSelection',
      level: 'global',
      key: null,
    });
  });
});

describe('setQuery', () => {
  it('keeps only filter names the Explorer implements', () => {
    // An unknown name would travel inward and be silently ignored by
    // `matchesQuickFilter`, so it is dropped at the boundary instead.
    const request = ok({
      type: 'setQuery',
      search: 'claude',
      quickFilters: ['reasoning', 'fast', 'not-a-filter', 'vision', 42, null],
      sort: 'input-cost',
      favoritesOnly: true,
    });
    expect(request).toEqual({
      type: 'setQuery',
      search: 'claude',
      quickFilters: ['reasoning', 'vision'],
      sort: 'input-cost',
      favoritesOnly: true,
    });
  });

  it('de-duplicates filters', () => {
    const request = ok({ type: 'setQuery', quickFilters: ['vision', 'vision'] });
    expect(request).toMatchObject({ quickFilters: ['vision'] });
  });

  it('bounds the filter count', () => {
    const many = Array.from({ length: 500 }, () => 'vision');
    expect(ok({ type: 'setQuery', quickFilters: many })).toMatchObject({ quickFilters: ['vision'] });
  });

  it('bounds the search text', () => {
    const request = ok({ type: 'setQuery', search: 'x'.repeat(5_000) });
    expect(request).toMatchObject({ search: 'x'.repeat(200) });
  });

  it('falls back to safe defaults for everything malformed', () => {
    expect(ok({ type: 'setQuery' })).toEqual({
      type: 'setQuery',
      search: '',
      quickFilters: [],
      sort: 'name',
      favoritesOnly: false,
    });
    expect(ok({ type: 'setQuery', quickFilters: 'vision', sort: 'by-vibes', favoritesOnly: 'yes' })).toEqual({
      type: 'setQuery',
      search: '',
      quickFilters: [],
      sort: 'name',
      favoritesOnly: false,
    });
  });

  it('accepts every sort key the Explorer offers', () => {
    for (const sort of ['name', 'input-cost', 'output-cost', 'context', 'provider', 'newest']) {
      expect(ok({ type: 'setQuery', sort })).toMatchObject({ sort });
    }
  });
});

describe('task and advice messages', () => {
  it('accepts only known task ids', () => {
    for (const taskId of [
      'product-discovery',
      'architecture-design',
      'coding',
      'code-review',
      'simple-questions',
      'documentation',
      'large-repo-analysis',
    ]) {
      expect(ok({ type: 'requestAdvice', taskId })).toEqual({ type: 'requestAdvice', taskId });
    }
    expect(reason({ type: 'requestAdvice', taskId: 'planning-studio' })).toContain('unknown task id');
    expect(reason({ type: 'requestAdvice' })).toContain('unknown task id');
  });

  it('requires both a known role and a malformed-free model for applyAdvice', () => {
    expect(ok({ type: 'applyAdvice', roleId: 'coding', modelId: 'a/b' })).toEqual({
      type: 'applyAdvice',
      roleId: 'coding',
      modelId: 'a/b',
    });
    expect(reason({ type: 'applyAdvice', roleId: 'nope', modelId: 'a/b' })).toContain('unknown role id');
    expect(reason({ type: 'applyAdvice', roleId: 'coding', modelId: 'a b' })).toContain(
      'missing or malformed'
    );
  });
});

describe('showModelDetails', () => {
  it('accepts null, meaning "close the panel"', () => {
    expect(ok({ type: 'showModelDetails', modelId: null })).toEqual({
      type: 'showModelDetails',
      modelId: null,
    });
    expect(ok({ type: 'showModelDetails' })).toEqual({ type: 'showModelDetails', modelId: null });
  });

  it('rejects a malformed id rather than treating it as a close', () => {
    // Silently closing on a malformed id would hide a bug rather than surface it.
    expect(reason({ type: 'showModelDetails', modelId: 'a b' })).toContain('malformed');
  });
});

describe('parseCostRequest', () => {
  it('accepts the cost panel messages', () => {
    expect(parseCostRequest({ type: 'ready' })).toEqual({ ok: true, request: { type: 'ready' } });
    expect(parseCostRequest({ type: 'clearHistory' })).toEqual({
      ok: true,
      request: { type: 'clearHistory' },
    });
    expect(parseCostRequest({ type: 'selectRange', days: 7 })).toEqual({
      ok: true,
      request: { type: 'selectRange', days: 7 },
    });
  });

  it('clamps the range to something usable', () => {
    const days = (value: unknown): number | null => {
      const parsed = parseCostRequest({ type: 'selectRange', days: value });
      // Narrowed rather than asserted: the parser returns a union, and a case
      // that answered a range with a different request must not read as 0.
      if (!parsed.ok || parsed.request.type !== 'selectRange') {
        return null;
      }
      return parsed.request.days;
    };
    expect(days(1)).toBe(1);
    expect(days(0)).toBe(1);
    expect(days(-30)).toBe(1);
    expect(days(90)).toBe(90);
    expect(days(9_999)).toBe(365);
    expect(days(7.9)).toBe(7);
  });

  it('rejects a non-finite range', () => {
    for (const value of ['7', null, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      const parsed = parseCostRequest({ type: 'selectRange', days: value });
      expect(parsed.ok, JSON.stringify(value)).toBe(false);
    }
  });

  it('rejects a provider message, so the two panels cannot be confused', () => {
    // The two parsers return different types; this checks the runtime half of
    // that separation, not just the compile-time half.
    const parsed = parseCostRequest({ type: 'setApiKey' });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.reason).toContain('unsupported message type');
  });

  it('rejects a malformed envelope', () => {
    expect(parseCostRequest(null).ok).toBe(false);
    expect(parseCostRequest({}).ok).toBe(false);
  });
});

/**
 * Credential handling (spec sections 7 and 8).
 *
 * These are the tests that matter most in the suite, because the failure they
 * guard against is a leak rather than a bug report.
 *
 * The stated constraints, each with a test below:
 *   - the key is stored in `SecretStorage` and nowhere else;
 *   - the key is never rendered — only a mask is, and the mask never contains
 *     enough to reconstruct it;
 *   - replacement is safe, and clearing leaves no inconsistency between `has()`
 *     and `get()`.
 *
 * The mask test is written as a property rather than an example: for a range of
 * key lengths and contents, the masked value must not contain the original, must
 * not contain any *long* run of it, and must not be the original. A single
 * hardcoded expected string would pass while a later edit leaked the tail.
 */

import { describe, expect, it } from 'vitest';
import {
  OPENROUTER_SECRET_KEY,
  SecretManager,
  looksLikeOpenRouterKey,
  maskSecret,
  secretKeyFor,
  type SecretStorageLike,
} from '../../src/security/SecretManager';

/**
 * A stand-in for `vscode.SecretStorage`.
 *
 * It records every call so the tests can assert that the key never reaches a
 * store other than the encrypted one.
 */
class FakeSecretStorage implements SecretStorageLike {
  readonly values = new Map<string, string>();
  readonly calls: { op: 'get' | 'store' | 'delete'; key: string }[] = [];

  async get(key: string): Promise<string | undefined> {
    this.calls.push({ op: 'get', key });
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.calls.push({ op: 'store', key });
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.calls.push({ op: 'delete', key });
    this.values.delete(key);
  }
}

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';

function manager(): { secrets: SecretManager; storage: FakeSecretStorage } {
  const storage = new FakeSecretStorage();
  return { secrets: new SecretManager(storage), storage };
}

describe('secretKeyFor', () => {
  it('namespaces the storage key per provider', () => {
    expect(secretKeyFor('openrouter')).toBe('pairpilot.provider.openrouter.apiKey');
    expect(OPENROUTER_SECRET_KEY).toBe(secretKeyFor('openrouter'));
    expect(secretKeyFor('openrouter')).not.toBe(secretKeyFor('anthropic'));
  });
});

describe('storage', () => {
  it('writes the key to the encrypted store and nowhere else', async () => {
    const { secrets, storage } = manager();
    await secrets.set('openrouter', KEY);

    expect(storage.calls).toEqual([{ op: 'store', key: OPENROUTER_SECRET_KEY }]);
    expect(storage.values.get(OPENROUTER_SECRET_KEY)).toBe(KEY);
    // Exactly one entry exists; nothing was written under a second name.
    expect(storage.values.size).toBe(1);
  });

  it('trims a pasted key, because a trailing newline is a paste artefact', async () => {
    const { secrets, storage } = manager();
    await secrets.set('openrouter', `  ${KEY}\n`);
    expect(storage.values.get(OPENROUTER_SECRET_KEY)).toBe(KEY);
    expect(await secrets.get('openrouter')).toBe(KEY);
  });

  it('returns the raw key only from get(), for the one call that needs it', async () => {
    const { secrets } = manager();
    await secrets.set('openrouter', KEY);
    expect(await secrets.get('openrouter')).toBe(KEY);
  });

  it('reports an absent key rather than an empty string', async () => {
    const { secrets } = manager();
    expect(await secrets.get('openrouter')).toBeUndefined();
    expect(await secrets.has('openrouter')).toBe(false);
    expect(await secrets.summary('openrouter')).toEqual({
      present: false,
      masked: null,
      prefixWarning: null,
    });
  });

  it('treats a whitespace-only stored value as absent', async () => {
    const { secrets, storage } = manager();
    storage.values.set(OPENROUTER_SECRET_KEY, '   \n  ');
    expect(await secrets.get('openrouter')).toBeUndefined();
    expect(await secrets.has('openrouter')).toBe(false);
  });

  it('keeps providers independent', async () => {
    const { secrets } = manager();
    await secrets.set('openrouter', KEY);
    expect(await secrets.get('anthropic')).toBeUndefined();
  });
});

describe('replacement', () => {
  it('replaces a stored key in place, leaving exactly one entry', async () => {
    const { secrets, storage } = manager();
    await secrets.set('openrouter', KEY);
    await secrets.set('openrouter', 'sk-or-v1-replacement-key-000000000000');

    expect(storage.values.size).toBe(1);
    expect(await secrets.get('openrouter')).toBe('sk-or-v1-replacement-key-000000000000');
  });

  it('clearing an empty value deletes rather than storing a blank', async () => {
    // Storing "" would leave `has()` true while `get()` returns undefined — an
    // inconsistency the UI renders as "key set" against a key that cannot be
    // used.
    const { secrets, storage } = manager();
    await secrets.set('openrouter', KEY);
    await secrets.set('openrouter', '   ');

    expect(storage.values.size).toBe(0);
    expect(await secrets.has('openrouter')).toBe(false);
    expect(await secrets.get('openrouter')).toBeUndefined();
  });

  it('deletes on request', async () => {
    const { secrets, storage } = manager();
    await secrets.set('openrouter', KEY);
    await secrets.delete('openrouter');

    expect(storage.values.size).toBe(0);
    expect(await secrets.has('openrouter')).toBe(false);
  });

  it('deletes an absent key without complaining', async () => {
    const { secrets } = manager();
    await expect(secrets.delete('openrouter')).resolves.toBeUndefined();
  });
});

describe('summary', () => {
  it('describes the stored key without returning it', async () => {
    const { secrets } = manager();
    await secrets.set('openrouter', KEY);

    const summary = await secrets.summary('openrouter');
    expect(summary.present).toBe(true);
    expect(summary.masked).not.toBeNull();
    expect(summary.prefixWarning).toBeNull();

    // The summary object has exactly these three fields — there is no variant of
    // this method, and no field, that carries the key.
    expect(Object.keys(summary).sort()).toEqual(['masked', 'prefixWarning', 'present']);
    expect(JSON.stringify(summary)).not.toContain(KEY);
    expect(JSON.stringify(summary)).not.toContain(KEY.slice(0, -4));
  });

  it('warns about a key that does not look like an OpenRouter key, without refusing it', async () => {
    // Deliberately a warning: OpenRouter could change its prefix format, and a
    // tool that rejects a valid key over a hardcoded literal is worse than one
    // that accepts it and reports the server's verdict.
    const { secrets } = manager();
    await secrets.set('openrouter', 'some-other-vendors-key-value');

    const summary = await secrets.summary('openrouter');
    expect(summary.present).toBe(true);
    expect(summary.prefixWarning).toContain('sk-or-');
  });

  it('does not apply the OpenRouter prefix rule to other providers', async () => {
    const { secrets } = manager();
    await secrets.set('anthropic', 'sk-ant-something-else-entirely');
    expect((await secrets.summary('anthropic')).prefixWarning).toBeNull();
  });
});

describe('maskSecret: a property, not an example', () => {
  const cases = [
    { name: 'a real OpenRouter key', value: KEY },
    { name: 'a short key', value: 'sk-or-abc' },
    { name: 'a medium key', value: 'sk-or-abcdefgh' },
    { name: 'a key at the safe-prefix boundary', value: 'x'.repeat(16) },
    { name: 'a long key', value: 'y'.repeat(200) },
    { name: 'a key of digits', value: '12345678901234567890' },
  ];

  for (const { name, value } of cases) {
    it(`never reveals enough of ${name} to reconstruct it`, () => {
      const masked = maskSecret(value);

      expect(masked).not.toBe(value);
      expect(masked).not.toContain(value);
      // Removing the shown head and tail must still leave most of the key
      // hidden: at most 10 characters of a key may be visible.
      const visible = masked.replace('…', '').replace(/•/g, '').length;
      if (value.length > 10) {
        expect(visible, `${name}: ${masked}`).toBeLessThanOrEqual(10);
        expect(visible).toBeLessThan(value.length);
      }
    });
  }

  it('shows a head and tail for a long key, and hides the middle', () => {
    expect(maskSecret(KEY)).toBe('sk-or-…cdef');
  });

  it('shows less of a mid-length key', () => {
    // A 6-character key revealed as `ab…ef` is mostly revealed, so the visible
    // portion shrinks with the key.
    expect(maskSecret('abcdefghij')).toBe('ab…ij');
  });

  it('reveals nothing at all of a short key', () => {
    expect(maskSecret('sk-or-abc')).toBe('•'.repeat(9));
    expect(maskSecret('a')).toBe('•');
  });

  it('renders an empty secret as an empty string', () => {
    expect(maskSecret('')).toBe('');
    expect(maskSecret('   ')).toBe('');
  });

  it('never contains a run of the original longer than the safe prefix', () => {
    for (const { value } of cases) {
      const masked = maskSecret(value);
      // The longest substring of the original that survives must be bounded by
      // the safe head and tail.
      for (let length = value.length; length > 10; length -= 1) {
        for (let start = 0; start + length <= value.length; start += 1) {
          expect(masked.includes(value.slice(start, start + length))).toBe(false);
        }
      }
    }
  });
});

describe('looksLikeOpenRouterKey', () => {
  it('accepts the documented prefix', () => {
    expect(looksLikeOpenRouterKey(KEY)).toBe(true);
    expect(looksLikeOpenRouterKey(`  ${KEY}  `)).toBe(true);
  });

  it('rejects anything else, without throwing', () => {
    expect(looksLikeOpenRouterKey('')).toBe(false);
    expect(looksLikeOpenRouterKey('sk-ant-1234')).toBe(false);
    expect(looksLikeOpenRouterKey('SK-OR-1234')).toBe(false);
  });
});

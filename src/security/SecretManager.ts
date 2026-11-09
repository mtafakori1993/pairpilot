/**
 * SecretManager — the only code in PairPilot allowed to touch an API key.
 *
 * Design rules, each of which exists because the obvious alternative is a leak:
 *
 *  1. **`SecretStorage` only.** Keys go to VS Code's encrypted store. Never
 *     `settings.json`, never `globalState`, never a file. `settings.json` is
 *     synced, shared in dotfiles repos, and printed in bug reports.
 *  2. **One entry point.** Every read goes through `get()`, so there is exactly
 *     one place to audit. A second reader added later cannot be overlooked
 *     because there is nowhere else to add it.
 *  3. **Masking is done here, not by the caller.** `masked()` is the only way to
 *     render a key, so a screen that wants to show "which key is set" cannot
 *     accidentally show the key.
 *  4. **Nothing is logged.** This class takes no logger. A credential cannot be
 *     written to the output channel by code that has no way to write there.
 *
 * The storage is typed structurally rather than as `vscode.SecretStorage`, which
 * is what lets this be tested in plain Node with a fake — including the tests
 * that assert a stored key never appears in a masked value.
 */

/**
 * The slice of `vscode.SecretStorage` this class uses.
 *
 * `vscode.SecretStorage` satisfies it exactly, so the extension host passes the
 * real thing without a cast, while tests pass a `Map`.
 */
export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

/** Storage key per provider. Namespaced so a future provider cannot collide. */
export function secretKeyFor(providerId: string): string {
  return `pairpilot.provider.${providerId}.apiKey`;
}

export const OPENROUTER_SECRET_KEY = secretKeyFor('openrouter');

/** Longest prefix of an unrecognised key that may be shown. */
const SAFE_PREFIX = 6;
const SAFE_SUFFIX = 4;

/**
 * Render a credential so it is recognisable but not usable.
 *
 * The invariant, which the tests assert directly: the output never contains
 * enough of the input to reconstruct it, and every character of the original
 * beyond a short head and tail is replaced. Short secrets are replaced entirely
 * rather than partly shown — a 6-character key revealed as `ab…ef` is mostly
 * revealed.
 */
export function maskSecret(secret: string): string {
  const value = secret.trim();
  if (value.length === 0) {
    return '';
  }
  if (value.length >= 16) {
    return `${value.slice(0, SAFE_PREFIX)}…${value.slice(-SAFE_SUFFIX)}`;
  }
  if (value.length >= 10) {
    return `${value.slice(0, 2)}…${value.slice(-2)}`;
  }
  // Too short for any prefix to be safe: show only its length.
  return `•`.repeat(value.length);
}

/**
 * A cheap sanity check for the paste-a-wrong-thing case.
 *
 * Deliberately a *warning*, never a refusal. OpenRouter could change its prefix
 * format, and a tool that rejects a valid key because of a hardcoded literal is
 * worse than one that accepts it and reports the server's verdict. The real
 * validation is `GET /key`.
 */
export function looksLikeOpenRouterKey(secret: string): boolean {
  return secret.trim().startsWith('sk-or-');
}

/** Everything a caller needs to describe a stored key without holding one. */
export interface KeySummary {
  present: boolean;
  masked: string | null;
  /** Set when the value does not match the provider's documented prefix. */
  prefixWarning: string | null;
}

export class SecretManager {
  constructor(private readonly storage: SecretStorageLike) {}

  /** The raw key, for the single HTTP call that needs it. Never render this. */
  async get(providerId: string): Promise<string | undefined> {
    const value = await this.storage.get(secretKeyFor(providerId));
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
  }

  async set(providerId: string, secret: string): Promise<void> {
    const value = secret.trim();
    if (value.length === 0) {
      // Storing an empty string would leave `has()` true while `get()` returns
      // undefined — an inconsistency the UI would render as "key set".
      await this.delete(providerId);
      return;
    }
    await this.storage.store(secretKeyFor(providerId), value);
  }

  async delete(providerId: string): Promise<void> {
    await this.storage.delete(secretKeyFor(providerId));
  }

  async has(providerId: string): Promise<boolean> {
    return (await this.get(providerId)) !== undefined;
  }

  /**
   * Describe the stored key for display.
   *
   * Returns the mask and a prefix warning, and nothing else — there is no
   * variant of this method that returns the key itself, so a UI screen has no
   * way to obtain one.
   */
  async summary(providerId: string): Promise<KeySummary> {
    const secret = await this.get(providerId);
    if (secret === undefined) {
      return { present: false, masked: null, prefixWarning: null };
    }
    return {
      present: true,
      masked: maskSecret(secret),
      prefixWarning:
        providerId === 'openrouter' && !looksLikeOpenRouterKey(secret)
          ? 'This key does not start with "sk-or-". If it came from somewhere else, the connection test will confirm.'
          : null,
    };
  }
}

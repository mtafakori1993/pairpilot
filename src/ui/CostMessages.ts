/**
 * CostMessages — the validated message contract for the Cost & Usage panel.
 *
 * This began life inside `ProviderMessages`, alongside the providers panel's
 * own contract. That panel is gone: provider and model choice happen in native
 * prompts now, and there is no Webview left to send `selectModel`. What remains
 * is this file's small contract, moved out so the cost panel does not have to
 * import a module that describes a screen that no longer exists.
 *
 * The rule is unchanged and worth restating: a message from a Webview is
 * untrusted input. Nothing here trusts a field's type, and no branch accepts a
 * value it has not bounded.
 */

export type CostRequest =
  | { type: 'ready' }
  | { type: 'clearHistory' }
  | { type: 'selectRange'; days: number };

export type CostParseResult = { ok: true; request: CostRequest } | { ok: false; reason: string };

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
      return { ok: true, request: { type } };

    case 'selectRange': {
      const days = record['days'];
      if (typeof days !== 'number' || !Number.isFinite(days)) {
        return reject('"days" must be a number');
      }
      // Clamped rather than refused: the panel offers a fixed set of ranges, so
      // an out-of-range number is a bug rather than an attack, and the cheapest
      // safe answer is a window the history certainly covers.
      return { ok: true, request: { type, days: Math.min(Math.max(Math.trunc(days), 1), 365) } };
    }

    default:
      return reject(`unsupported message type "${type}"`);
  }
}

function reject(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

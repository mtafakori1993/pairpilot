/**
 * Diagnostics for the response protocol.
 *
 * Spec 1.3 asks for "raw response diagnostics stored safely for debugging".
 * Both halves of that sentence are constraints, and they pull in opposite
 * directions: a raw reply is the only thing that can explain a parse failure,
 * and a raw reply is exactly where an API key or a credential-adjacent code
 * snippet would be.
 *
 * So the store keeps a bounded ring of recent replies, and every one of them is
 * redacted on the way in. Redaction happens at *write* time, not read time, so
 * there is no path — including a future export or bug report — on which the
 * unredacted text exists in memory at all.
 *
 * The store is also the evidence base for the retry policy: when a reply fails
 * validation, the corrective prompt is built from the recorded issues rather
 * than from a re-parse, so what the developer was told and what the model is
 * told cannot drift apart.
 */

import type { AdaptationKind, ProtocolIssue, ProtocolMessageType } from './types';
import type { ProtocolFailureKind } from './parse';

/** One recorded reply. */
export interface ProtocolDiagnosticEntry {
  /** When the reply was processed (epoch ms). */
  at: number;
  /** The session this reply belongs to, when known. */
  sessionId?: string;
  /** Which provider produced it, when known. */
  providerId?: string;
  /** The model id, when the provider reported one. */
  modelId?: string;
  ok: boolean;
  /** How the reply was shaped on arrival. */
  adaptation: AdaptationKind;
  /** The canonical type, when it validated. */
  messageType?: ProtocolMessageType;
  /** Why it failed, when it did. */
  failureKind?: ProtocolFailureKind;
  /** Per-field detail. */
  issues: ProtocolIssue[];
  /** Non-fatal notes. */
  notes: string[];
  /** Redacted, truncated raw reply. */
  raw: string;
  /** Character length of the original reply, before truncation. */
  rawLength: number;
}

/** How many replies are retained. Small: this is a debugging aid, not a log. */
const DEFAULT_LIMIT = 20;

/** How much of a reply is retained. */
const MAX_RAW_CHARS = 20_000;

/* -------------------------------------------------------------------------- */
/* Redaction                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Patterns for values that must never be retained verbatim.
 *
 * Deliberately broad. A false positive costs a few asterisks in a truncated
 * debugging string; a false negative puts a live credential into a support
 * bundle.
 */
const SECRET_PATTERNS: readonly { pattern: RegExp; replacement: string }[] = [
  // OpenRouter, OpenAI and Anthropic style keys.
  { pattern: /\b(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]{6,}/g, replacement: '$1••••redacted' },
  { pattern: /\b(sk-or-v1-)[A-Za-z0-9]{6,}/g, replacement: '$1••••redacted' },
  // Bearer tokens and Authorization headers.
  { pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, replacement: '$1••••redacted' },
  { pattern: /\b(Basic\s+)[A-Za-z0-9+/]{8,}=*/gi, replacement: '$1••••redacted' },
  // `api_key = "..."`, `"api_key": "..."`, `password: ...`, `token=...`.
  // The optional `["']?` after the key name is what catches the JSON form, where
  // a quote sits between the key and its colon — without it, a key logged inside
  // a JSON body would pass through untouched.
  {
    pattern:
      /\b((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|pwd)["']?\s*[:=]\s*)(["'`]?)([^\s"'`,;)}\]]{4,})/gi,
    replacement: '$1$2••••redacted',
  },
  // JSON Web Tokens.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replacement: '••••redacted-jwt',
  },
  // Private key blocks.
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '••••redacted-private-key',
  },
];

/**
 * Remove anything credential-shaped from a string.
 *
 * Exported because the same treatment is applied to any raw reply that is shown
 * in the UI or written to the log — one implementation, used everywhere, rather
 * than a redaction that exists only on the diagnostics path.
 */
export function redactSecrets(text: string): string {
  let output = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

/* -------------------------------------------------------------------------- */
/* The store                                                                  */
/* -------------------------------------------------------------------------- */

export interface RecordInput {
  ok: boolean;
  adaptation: AdaptationKind;
  raw: string;
  issues?: ProtocolIssue[];
  notes?: string[];
  messageType?: ProtocolMessageType;
  failureKind?: ProtocolFailureKind;
  sessionId?: string;
  providerId?: string;
  modelId?: string;
  now?: number;
}

/**
 * A bounded, redacting record of recent protocol activity.
 *
 * Plain in-memory state rather than VS Code `workspaceState`: a raw model reply
 * is the developer's code, and persisting it to disk would put source content
 * into storage they never asked PairPilot to write. The ring lives as long as
 * the session and is cleared with it.
 */
export class ProtocolDiagnostics {
  private readonly entries: ProtocolDiagnosticEntry[] = [];

  constructor(private readonly limit: number = DEFAULT_LIMIT) {}

  record(input: RecordInput): ProtocolDiagnosticEntry {
    const redacted = redactSecrets(input.raw);
    const entry: ProtocolDiagnosticEntry = {
      at: input.now ?? Date.now(),
      ok: input.ok,
      adaptation: input.adaptation,
      issues: input.issues ?? [],
      notes: input.notes ?? [],
      raw: redacted.length > MAX_RAW_CHARS ? `${redacted.slice(0, MAX_RAW_CHARS)}\n… [truncated]` : redacted,
      rawLength: input.raw.length,
      ...(input.messageType !== undefined ? { messageType: input.messageType } : {}),
      ...(input.failureKind !== undefined ? { failureKind: input.failureKind } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
    };

    this.entries.push(entry);
    while (this.entries.length > this.limit) {
      this.entries.shift();
    }
    return entry;
  }

  /** Most recent first. */
  recent(): readonly ProtocolDiagnosticEntry[] {
    return [...this.entries].reverse();
  }

  /** The most recent failure, which is what a "why did that not work?" needs. */
  lastFailure(): ProtocolDiagnosticEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry && !entry.ok) {
        return entry;
      }
    }
    return undefined;
  }

  /** How many consecutive most-recent replies failed. Used to stop retrying. */
  consecutiveFailures(): number {
    let count = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]?.ok) {
        break;
      }
      count += 1;
    }
    return count;
  }

  clear(): void {
    this.entries.length = 0;
  }

  get size(): number {
    return this.entries.length;
  }
}

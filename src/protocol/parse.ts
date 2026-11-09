/**
 * Extraction of a JSON payload from whatever the model actually sent.
 *
 * ## Why this is not `JSON.parse(text)`
 *
 * By the time a reply reaches here it may carry any of:
 *
 *  - Markdown fences, with or without a `json` tag, sometimes with prose before
 *    and after them.
 *  - A sentence of preamble: "Here is the proposal:".
 *  - Trailing commentary after the closing brace.
 *  - A completely bare object, which is the happy path.
 *
 * ## Why the scan is character-by-character
 *
 * The obvious implementation — slice from the first `{` to the last `}` — breaks
 * on the very input this extension exists to handle. `content` fields hold
 * source code, and source code holds braces, quotes and backslashes. A `}` in a
 * string literal, or a `{` in a regex, makes naive slicing cut the object in the
 * wrong place and produces a parse error that blames the model for correct
 * output.
 *
 * This scanner therefore tracks string state and escape state, so a brace inside
 * a string is data and only a structurally balanced object is ever handed to
 * `JSON.parse`.
 *
 * It is bounded in both directions: the scan is linear, and candidates are
 * capped in number and size, so a pathological or hostile reply cannot turn
 * parsing into a denial of service.
 */

import { adaptCandidate, type AdaptedCandidate } from './adapt';
import { validateProtocolMessage, type ProtocolValidationResult } from './schema';
import type { AdaptationKind, ProtocolIssue } from './types';

/* -------------------------------------------------------------------------- */
/* Limits                                                                     */
/* -------------------------------------------------------------------------- */

export const EXTRACTION_LIMITS = {
  /** Objects considered per reply. A reply with more is prose with braces in it. */
  maxCandidates: 16,
  /** Longest candidate handed to `JSON.parse`, in characters. */
  maxCandidateChars: 4_000_000,
  /**
   * Characters scanned for balanced objects.
   *
   * Beyond this the text is almost certainly not a JSON reply — a pasted log, a
   * book chapter — and continuing to scan would block the extension host.
   */
  maxScanChars: 8_000_000,
} as const;

/* -------------------------------------------------------------------------- */
/* Balanced-object scan                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Find every brace-balanced top-level object in `text`.
 *
 * Returns them longest-first. A nested fragment can be balanced too (a
 * `proposal` value, say), and the enclosing object is nearly always the payload,
 * so the largest is tried first.
 *
 * @param markers Only objects mentioning one of these are returned. This keeps
 *   a brace pair in trailing prose from being mistaken for the payload — but a
 *   marker of `null` accepts every object, which is what a caller that wants to
 *   classify *any* JSON reply needs.
 */
export function extractBalancedObjects(
  text: string,
  markers: readonly string[] | null = null
): string[] {
  const found: string[] = [];
  const scanUpTo = Math.min(text.length, EXTRACTION_LIMITS.maxScanChars);

  for (let start = 0; start < scanUpTo; start++) {
    if (text.charAt(start) !== '{') {
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let i = start; i < scanUpTo; i++) {
      const c = text.charAt(i);
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (c === '\\') {
          escaped = true;
        } else if (c === '"') {
          inString = false;
        }
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === '{') {
        depth++;
        continue;
      }
      if (c === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
        if (depth < 0) {
          break;
        }
      }
    }

    if (end !== -1) {
      const length = end - start + 1;
      if (length <= EXTRACTION_LIMITS.maxCandidateChars) {
        const candidate = text.slice(start, end + 1);
        if (markers === null || markers.some((marker) => candidate.includes(marker))) {
          found.push(candidate);
        }
      }
      // Continue from `start + 1` rather than from `end`: the payload may itself
      // be nested inside a larger balanced object that starts earlier.
    }
  }

  return found.sort((a, b) => b.length - a.length);
}

/** Fenced code blocks, tried before the raw text: a fence is an explicit signal. */
const FENCE_PATTERN = /```(?:json|jsonc|json5|javascript|js)?\s*\n?([\s\S]*?)```/gi;

/** Candidate JSON strings, most-likely first, de-duplicated. */
export function primaryCandidates(text: string): string[] {
  const candidates: string[] = [];

  FENCE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_PATTERN.exec(text)) !== null) {
    const body = match[1]?.trim();
    if (body && (body.startsWith('{') || body.startsWith('['))) {
      candidates.push(body);
    }
  }

  const trimmed = text.trim();
  // The happy path: the whole reply is the object (or, wrongly, an array — which
  // is still read as *the* reply so it can be reported as such, rather than
  // being picked apart into fragments).
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    candidates.push(trimmed);
  }

  return candidates;
}

/** Candidate JSON strings, most-likely first, de-duplicated. */
export function collectCandidates(text: string): string[] {
  const candidates: string[] = [...primaryCandidates(text)];

  for (const object of extractBalancedObjects(text)) {
    candidates.push(object);
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidate of candidates) {
    if (!seen.has(candidate) && unique.length < EXTRACTION_LIMITS.maxCandidates) {
      seen.add(candidate);
      unique.push(candidate);
    }
  }
  return unique;
}

/* -------------------------------------------------------------------------- */
/* The parse pipeline                                                         */
/* -------------------------------------------------------------------------- */

/** Why a reply could not be read as a canonical message. */
export type ProtocolFailureKind =
  | 'empty'
  | 'no_json'
  | 'unparsable'
  | 'schema';

export interface ProtocolParseFailure {
  ok: false;
  kind: ProtocolFailureKind;
  /** One line, shown to the developer. */
  reason: string;
  /** Per-field detail, shown under the reason and fed to the retry prompt. */
  issues: ProtocolIssue[];
  /** Raw reply, truncated. Kept for diagnostics. */
  raw: string;
}

export interface ProtocolParseSuccess {
  ok: true;
  /** The canonical message. */
  message: import('./types').ProtocolMessage;
  /** The exact JSON text that produced it. */
  raw: string;
  /** How the reply was shaped on arrival. */
  adaptation: AdaptedCandidate['kind'];
  /** Non-fatal notes from adaptation and validation. */
  notes: string[];
}

export type ProtocolParseOutcome = ProtocolParseSuccess | ProtocolParseFailure;

/** Keep a bounded copy of a raw reply for diagnostics. */
export function truncateRaw(text: string, max = 20_000): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n… [${text.length - max} more characters omitted]`;
}

/**
 * Read one candidate string.
 *
 * Split out from `parseProtocol` so the caller can try several candidates and
 * keep the *most informative* failure rather than the first one.
 */
function readCandidate(candidate: string): ProtocolParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    return {
      ok: false,
      kind: 'unparsable',
      reason: `A JSON object was found but could not be parsed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      issues: [],
      raw: candidate,
    };
  }

  // Adaptation only applies to objects. An array or a scalar is passed straight
  // to validation so the developer is told *what* arrived ("a reply must be a
  // JSON object, but this was an array") instead of being shown the complaint
  // about an empty object that adaptation would have produced.
  let candidateValue: unknown = parsed;
  let adaptation: AdaptationKind = 'canonical';
  let notes: string[] = [];

  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const adapted = adaptCandidate(parsed);
    candidateValue = adapted.value;
    adaptation = adapted.kind;
    notes = adapted.notes;
  }

  const result: ProtocolValidationResult = validateProtocolMessage(candidateValue);

  if (!result.ok) {
    return {
      ok: false,
      kind: 'schema',
      reason: 'The reply was valid JSON but did not match the PairPilot response contract.',
      issues: result.issues,
      raw: candidate,
    };
  }

  return {
    ok: true,
    message: result.value,
    raw: candidate,
    adaptation,
    notes: [...notes, ...result.notes],
  };
}

/**
 * Parse an assistant reply into the canonical contract.
 *
 * ## Two tiers, and why the order is a safety property
 *
 * A reply that *is* JSON — the whole text, or a fenced block inside it — is read
 * as that JSON and nothing else. Only when neither yields JSON at all does the
 * balanced-object scan get a turn, which is the case of a payload wrapped in
 * prose ("Here is the proposal: {…}").
 *
 * The distinction matters because the scan also finds objects *inside* a reply.
 * Without the two tiers, a reply that was valid JSON but wrong in one field would
 * fail to parse whole, then succeed as one of its own fragments — and PairPilot
 * would write a single file out of a proposal it had just rejected as a set,
 * reporting success. Reading the whole document first makes that impossible.
 */
export function parseProtocol(text: string): ProtocolParseOutcome {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return {
      ok: false,
      kind: 'empty',
      reason: 'The AI returned an empty response.',
      issues: [],
      raw: '',
    };
  }

  // --- Tier one: the reply is JSON -----------------------------------------
  const primaries = primaryCandidates(text);
  let sawJson = false;
  let best: ProtocolParseFailure | null = null;

  for (const candidate of primaries) {
    const outcome = readCandidate(candidate);
    if (outcome.ok) {
      return outcome;
    }
    if (outcome.kind !== 'unparsable') {
      sawJson = true;
    }
    best = betterFailure(best, outcome);
  }

  // The reply was JSON, but not a usable message. Report that, rather than
  // hunting for a fragment of it that happens to validate.
  if (sawJson && best) {
    return best;
  }

  // --- Tier two: the payload is embedded in prose --------------------------
  const seen = new Set(primaries);
  for (const object of extractBalancedObjects(text)) {
    if (seen.has(object)) {
      continue;
    }
    seen.add(object);
    const outcome = readCandidate(object);
    if (outcome.ok) {
      return outcome;
    }
    best = betterFailure(best, outcome);
  }

  if (best) {
    return best;
  }

  return {
    ok: false,
    kind: 'no_json',
    reason:
      'No JSON object was found in the response, so PairPilot treated it as plain text.',
    issues: [],
    raw: truncateRaw(text),
  };
}

/** Keep whichever failure names more specific problems. */
function betterFailure(
  current: ProtocolParseFailure | null,
  outcome: ProtocolParseOutcome
): ProtocolParseFailure {
  const failure: ProtocolParseFailure = {
    ok: false,
    kind: outcome.ok ? 'schema' : outcome.kind === 'unparsable' ? 'unparsable' : 'schema',
    reason: outcome.ok ? '' : outcome.reason,
    issues: outcome.ok ? [] : outcome.issues,
    raw: truncateRaw(outcome.ok ? outcome.raw : outcome.raw),
  };
  if (current === null || failure.issues.length > current.issues.length) {
    return failure;
  }
  return current;
}

/**
 * Render a failure as the multi-line message the developer sees.
 *
 * Bulleted per-field detail, because "the reply was invalid" is not something a
 * developer can act on, while `/changes/2/content — each change must carry the
 * complete file content` is.
 */
export function describeProtocolFailure(failure: ProtocolParseFailure): string {
  const lines = [failure.reason];
  if (failure.issues.length > 0) {
    lines.push('');
    for (const issue of failure.issues.slice(0, 12)) {
      lines.push(issue.path ? `• ${issue.path} — ${issue.message}` : `• ${issue.message}`);
    }
    if (failure.issues.length > 12) {
      lines.push(`• …and ${failure.issues.length - 12} more.`);
    }
  }
  return lines.join('\n');
}

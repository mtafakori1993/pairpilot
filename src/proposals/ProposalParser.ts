/**
 * ProposalParser — turns raw assistant text into a candidate proposal object.
 *
 * Spec section 7 says "validate all AI output before using it". This module does
 * the *parsing* half: finding the JSON object inside whatever the model actually
 * produced. The `ProposalValidator` does the *trust* half.
 *
 * Why this is not just `JSON.parse`:
 *
 *  - Models add markdown fences despite instructions not to.
 *  - Models prepend a sentence such as "Here's the proposal:".
 *  - Code strings contain braces and escaped quotes, so the first `{` and the
 *    last `}` are frequently not the object's boundaries: a brace inside a
 *    string, or a `}` in trailing prose, will break naive slicing.
 *
 * The extractor therefore tracks string state and escape state to find a
 * genuinely balanced top-level object. Everything else is rejected with a
 * clear reason, because a silently-misparsed proposal is worse than a refusal.
 */

import type { CodeProposal } from '../types';
import { looksLikeProposal } from '../runtime/prompts';

export type ParseOutcome =
  | { ok: true; proposal: CodeProposal; raw: string }
  | { ok: false; reason: string; raw: string };

/** Fence languages we are willing to look inside for a JSON object. */
const FENCE_PATTERN = /```(?:json|jsonc|json5)?\s*([\s\S]*?)```/gi;

export class ProposalParser {
  /**
   * Extract and parse the first valid `code_proposal` object in `text`.
   *
   * @param text Full assistant text for the turn.
   */
  parse(text: string): ParseOutcome {
    if (typeof text !== 'string' || text.trim().length === 0) {
      return { ok: false, reason: 'The AI returned an empty response.', raw: text ?? '' };
    }

    const candidates = this.collectCandidates(text);
    if (candidates.length === 0) {
      return {
        ok: false,
        reason:
          'No JSON object was found in the response. PairPilot asked for a code_proposal and received prose instead.',
        raw: text,
      };
    }

    let lastError = 'The response did not contain a valid code_proposal object.';
    for (const candidate of candidates) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(candidate);
      } catch (error) {
        lastError = `Found a JSON object but it could not be parsed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        continue;
      }

      if (!looksLikeProposal(parsed)) {
        // A JSON object that is not a proposal (an advisor reply, say) is not a
        // parse failure so much as an absent proposal; keep the reason honest.
        lastError = 'Found valid JSON, but it is not a code_proposal object.';
        continue;
      }

      return { ok: true, proposal: parsed, raw: candidate };
    }

    return { ok: false, reason: lastError, raw: text };
  }

  /**
   * Candidate JSON strings, most-likely first.
   *
   * Fenced blocks are tried before the whole text because a fence is an explicit
   * signal from the model about where the payload is.
   */
  private collectCandidates(text: string): string[] {
    const candidates: string[] = [];

    FENCE_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FENCE_PATTERN.exec(text)) !== null) {
      const body = match[1]?.trim();
      if (body && body.startsWith('{')) {
        candidates.push(body);
      }
    }

    // The whole trimmed response first (the happy path, since the system prompt
    // demands bare JSON), then each balanced object discovered within it.
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      candidates.push(trimmed);
    }

    for (const object of extractBalancedObjects(text)) {
      candidates.push(object);
    }

    // De-duplicate while preserving order.
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const candidate of candidates) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        unique.push(candidate);
      }
    }
    return unique;
  }
}

/**
 * Find every brace-balanced top-level object in `text`, respecting JSON string
 * and escape rules so that braces inside string values do not miscount.
 *
 * Returns them longest-first, because a nested fragment that happens to be
 * balanced is far less likely to be the intended payload than the enclosing one.
 */
export function extractBalancedObjects(
  text: string,
  /**
   * Field names that identify a brace-balanced blob as the payload we want.
   *
   * This is a parameter rather than a constant because the same scan is used for
   * two different contracts: code proposals (marked by `code_proposal` or
   * `filePath`) and Engineering Advisor recommendations (marked by `title` and
   * `reason`, and carrying no path at all). Hard-coding the proposal markers made
   * a fenced advisor reply invisible to the caller.
   */
  markers: readonly string[] = ['code_proposal', 'filePath']
): string[] {
  const found: string[] = [];

  for (let start = 0; start < text.length; start++) {
    if (text.charAt(start) !== '{') {
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let i = start; i < text.length; i++) {
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
      const candidate = text.slice(start, end + 1);
      // Only keep objects that actually mention the payload we are looking for,
      // so trailing prose containing an unrelated brace pair does not pollute
      // the candidate list.
      if (markers.some((marker) => candidate.includes(marker))) {
        found.push(candidate);
      }
      // Continue scanning after this object's start rather than after its end:
      // the payload may be nested inside a larger brace-balanced blob.
    }
  }

  return found.sort((a, b) => b.length - a.length);
}

/**
 * EngineeringAdvisor — recommends exactly one next engineering step.
 *
 * Spec section 10. Two sources of advice, in priority order:
 *
 *  1. The AI runtime, given the approved file and the list of files that already
 *     exist, asked for a single recommendation.
 *  2. Local static analysis, used when AI advice is disabled or fails.
 *
 * The local analyser is not a fallback toy: it produces genuinely useful advice
 * by extracting import specifiers and referenced identifiers from the approved
 * code, discarding ones that already exist, and recommending the first missing
 * one with a note about why. Its value is that it always works and cannot
 * hallucinate a file that already exists — a failure mode the AI path needs
 * explicit guarding against.
 *
 * Nothing here executes anything. A recommendation is a suggestion the developer
 * must accept.
 */

import * as path from 'node:path';
import { extractBalancedObjects } from '../protocol/parse';
import type { AdvisorRecommendation } from '../types';

/** What the advisor needs to reason about a finished file. */
export interface AdvisorInput {
  relativePath: string;
  code: string;
  dependencies: string[];
  /** Workspace-relative paths known to exist, for de-duplication. */
  existingPaths: string[];
}

/** A dependency reference discovered in code. */
export interface DiscoveredReference {
  /** The raw specifier as written, e.g. `./user-service` or `express`. */
  specifier: string;
  /** True when it points inside the project rather than at a package. */
  relative: boolean;
  /** Resolved candidate workspace-relative paths, best guess first. */
  candidates: string[];
}

/**
 * Extract import/require/use references from source text.
 *
 * Regex-based rather than AST-based on purpose: PairPilot writes proposals for
 * many languages and has no parser for most of them. A regex that finds the
 * common import forms across JS/TS/Python/PHP/Go/Ruby/Java is more useful here
 * than a rigorous parser for one language.
 */
export function extractReferences(code: string): DiscoveredReference[] {
  const found = new Map<string, DiscoveredReference>();

  const record = (specifier: string): void => {
    const trimmed = specifier.trim();
    if (!trimmed || found.has(trimmed)) {
      return;
    }
    // Only same-project references are actionable as "create this file".
    const relative = trimmed.startsWith('./') || trimmed.startsWith('../');
    found.set(trimmed, {
      specifier: trimmed,
      relative,
      candidates: relative ? resolveRelativeCandidates(trimmed) : [],
    });
  };

  // import x from './y'  |  import './y'  |  export ... from './y'
  const esImport = /\bfrom\s+['"]([^'"]+)['"]/g;
  // import './y'  (side-effect import)
  const sideEffectImport = /\bimport\s+['"]([^'"]+)['"]/g;
  // require('./y')
  const requireCall = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  // Python: from .y import z   |   import y
  const pyFrom = /^\s*from\s+([.\w]+)\s+import\b/gm;
  // PHP: use App\Services\UserService;  |  require_once 'x.php';
  const phpUse = /^\s*use\s+([\w\\]+)\s*;/gm;
  const phpRequire = /\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g;
  // Ruby: require_relative 'x'
  const rubyRelative = /\brequire_relative\s+['"]([^'"]+)['"]/g;

  for (const pattern of [esImport, sideEffectImport, requireCall, phpRequire]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code)) !== null) {
      if (match[1]) {
        record(match[1]);
      }
    }
  }

  pyFrom.lastIndex = 0;
  let pyMatch: RegExpExecArray | null;
  while ((pyMatch = pyFrom.exec(code)) !== null) {
    const module = pyMatch[1];
    if (module && module.startsWith('.')) {
      // Convert a Python relative module to a path-ish specifier.
      const depth = module.match(/^\.+/)?.[0].length ?? 1;
      const remainder = module.slice(depth).replace(/\./g, '/');
      const prefix = depth === 1 ? './' : '../'.repeat(depth - 1);
      record(`${prefix}${remainder}`);
    }
  }

  rubyRelative.lastIndex = 0;
  let rubyMatch: RegExpExecArray | null;
  while ((rubyMatch = rubyRelative.exec(code)) !== null) {
    if (rubyMatch[1]) {
      record(`./${rubyMatch[1]}`);
    }
  }

  // PHP `use` statements are absolute namespaces, not file paths, so they are
  // reported only when they map onto something that does not exist yet.
  phpUse.lastIndex = 0;
  let phpMatch: RegExpExecArray | null;
  while ((phpMatch = phpUse.exec(code)) !== null) {
    const namespace = phpMatch[1];
    if (namespace && !namespace.startsWith('\\')) {
      const asPath = `${namespace.replace(/\\/g, '/')}.php`;
      if (!found.has(asPath)) {
        found.set(asPath, {
          specifier: namespace,
          relative: false,
          candidates: [asPath, `src/${asPath}`, `app/${asPath}`],
        });
      }
    }
  }

  return [...found.values()];
}

/** Best-guess candidate paths for a relative specifier. */
function resolveRelativeCandidates(specifier: string): string[] {
  const normalised = specifier.replace(/\\/g, '/');
  const extension = path.posix.extname(normalised);
  const candidates: string[] = [];
  if (extension) {
    candidates.push(normalised);
    return candidates;
  }
  // Try the common source extensions and index files, mirroring how bundlers
  // and language runtimes resolve a bare relative specifier.
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.py', '.php', '.rb', '.go']) {
    candidates.push(`${normalised}${ext}`);
  }
  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    candidates.push(`${normalised}/index${ext}`);
  }
  return candidates;
}

export class EngineeringAdvisor {
  private readonly workspaceRoot: string;

  constructor(deps: {
    /** Absolute path of the workspace root. */
    workspaceRoot: string;
    logger: { info(m: string): void; warn(m: string): void; error(m: string, e?: unknown): void };
  }) {
    this.workspaceRoot = deps.workspaceRoot;
  }

  /** Exposed for diagnostics and tests. */
  get root(): string {
    return this.workspaceRoot;
  }

  /**
   * Produce a local recommendation from static analysis alone.
   *
   * Returns null when nothing is missing, so the caller can report "no further
   * step is required" honestly rather than inventing work.
   */
  analyseLocally(input: AdvisorInput): AdvisorRecommendation | null {
    const existing = new Set(input.existingPaths.map(normalisePath));
    const references = extractReferences(input.code);

    for (const reference of references) {
      // Only a reference that maps onto a path can become "create this file".
      // A bare package specifier such as `express` has no candidates, and
      // falling back to the specifier itself would recommend creating a file
      // named `express` — advice to shadow a dependency, which is worse than no
      // advice at all.
      if (reference.candidates.length === 0) {
        continue;
      }

      // Resolve BEFORE normalising. `normalisePath` strips the leading `./`,
      // which is exactly the marker that says "relative to the source file", so
      // normalising first would leave `./user-service.ts` looking like a
      // root-level path and both the existence check and the sibling preference
      // below would silently operate on the wrong directory.
      const resolved = resolveCandidates(reference.candidates, input.relativePath);

      // The reference is satisfied if ANY candidate resolves to a file that
      // exists. Checking only the preferred candidate would report a gap that
      // is not there whenever a project uses a layout we did not guess first.
      if (resolved.some((candidate) => existing.has(candidate))) {
        continue;
      }

      const target = this.pickBestCandidate(resolved, input.relativePath);
      if (!target) {
        continue;
      }

      // A relative import that resolves to nothing is a real gap: the code
      // cannot run until the file exists.
      return {
        title: `Create ${target}`,
        reason: reference.relative
          ? `${shortName(input.relativePath)} imports "${reference.specifier}", but no matching file exists in the workspace. The code will not resolve until it is created.`
          : `${shortName(input.relativePath)} references "${reference.specifier}", which does not appear in the workspace.`,
        responsibilities: this.suggestResponsibilities(target, input.relativePath),
        files: [target],
        required: reference.relative,
        source: 'local',
      };
    }

    return null;
  }

  /**
   * Choose among candidates that are already resolved to workspace-relative
   * paths. Prefers a sibling of the source file, which matches the common
   * project layout, and otherwise takes the first candidate — the most specific
   * extension guess from `resolveRelativeCandidates`.
   */
  private pickBestCandidate(resolved: string[], sourceRelativePath: string): string | null {
    if (resolved.length === 0) {
      return null;
    }
    const sourceDir = path.posix.dirname(normalisePath(sourceRelativePath));
    const sibling = resolved.find((candidate) => path.posix.dirname(candidate) === sourceDir);
    return sibling ?? resolved[0] ?? null;
  }

  private suggestResponsibilities(target: string, sourceRelativePath: string): string[] {
    const base = path.posix.basename(target);
    const name = base.replace(path.posix.extname(base), '');
    const pascal = name
      .split(/[-_.]/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');

    return [
      `Provide the exports that ${shortName(sourceRelativePath)} imports.`,
      `Hold the ${pascal} logic in one place, so callers depend on a single implementation.`,
      'Stay free of direct I/O or UI concerns unless the callers already require them.',
    ];
  }

  /**
   * Turn an advisor reply into a recommendation.
   *
   * The reply is untrusted AI output, so every field is type-checked and
   * length-bounded. A malformed reply returns null and the caller falls back to
   * local analysis, rather than surfacing a half-parsed recommendation.
   */
  parseAdvisorReply(text: string, input: AdvisorInput): AdvisorRecommendation | null {
    if (typeof text !== 'string' || text.trim().length === 0) {
      return null;
    }

    const candidates: string[] = [];
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      candidates.push(trimmed);
    }
    // An advisor reply is marked by `title`/`reason`, not by the proposal
    // markers, so the scan has to be told what to look for.
    candidates.push(...extractBalancedObjects(text, ADVISOR_MARKERS));

    for (const candidate of candidates) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        continue;
      }
      const record = parsed as Record<string, unknown>;
      const title = asTrimmedString(record['title'], 300);
      const reason = asTrimmedString(record['reason'], 2000);
      if (!title || !reason) {
        continue;
      }

      const files = asStringList(record['files'], 10, 300);
      // Guard against advice to create a file that already exists.
      const existing = new Set(input.existingPaths.map(normalisePath));
      const filesFiltered = files.filter((file) => !existing.has(normalisePath(file)));

      return {
        title,
        reason,
        responsibilities: asStringList(record['responsibilities'], 10, 500),
        files: filesFiltered,
        required: record['required'] === true,
        source: 'ai',
      };
    }

    return null;
  }
}

/**
 * Turn candidates from `resolveRelativeCandidates` into workspace-relative paths.
 *
 * A relative candidate (`./x`, `../x`) is resolved against the directory of the
 * file that referenced it; anything else is already workspace-root-relative.
 */
function resolveCandidates(candidates: string[], sourceRelativePath: string): string[] {
  const sourceDir = path.posix.dirname(normalisePath(sourceRelativePath));
  const output: string[] = [];
  for (const candidate of candidates) {
    const resolved =
      candidate.startsWith('./') || candidate.startsWith('../')
        ? path.posix.join(sourceDir, candidate)
        : candidate;
    const normalised = normalisePath(resolved);
    if (normalised.length > 0) {
      output.push(normalised);
    }
  }
  return output;
}

/** What a brace-balanced blob must mention to be an advisor recommendation. */
const ADVISOR_MARKERS: readonly string[] = ['title', 'reason'];

function normalisePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').trim();
}

function shortName(relativePath: string): string {
  return path.posix.basename(relativePath);
}

function asTrimmedString(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.slice(0, maxChars);
}

function asStringList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const output: string[] = [];
  for (const item of value.slice(0, maxItems)) {
    const text = asTrimmedString(item, maxChars);
    if (text) {
      output.push(text);
    }
  }
  return output;
}

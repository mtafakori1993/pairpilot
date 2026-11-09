/**
 * ProposalValidator — the trust boundary for AI-generated content.
 *
 * Spec section 7: "Do not trust AI-generated paths or commands. Reject paths
 * outside the active workspace. Support create and update in MVP. Deletion must
 * be disabled."
 *
 * This module takes a *validated* canonical `code_proposal` message — valid in
 * the sense that `protocol/schema.ts` has already checked its shape — and turns
 * it into either a `ValidatedChangeSet` that is safe to act on, or a list of
 * reasons it is not.
 *
 * It is stricter than a schema check because the model is an untrusted author:
 *
 *  - **Paths** are re-checked against the `PathGuard`: they must not escape the
 *    workspace, must not be absolute, must not name build or dependency output,
 *    and a sensitive target needs its own explicit approval.
 *  - **`delete` is not representable.** It is rejected at the type level in
 *    `protocol/types.ts` and again here, so there is no path to a deletion.
 *  - **`create` over an existing file is refused**, because silently overwriting
 *    a file the developer already has is a destructive act disguised as a create.
 *  - **`update` over a missing file is refused**, with a hint to use `create`.
 *  - **Two changes must not target the same file**, because the second would
 *    silently discard the first.
 *  - **The approval hash covers path + operation + all content**, so neither the
 *    target nor the bytes can change after approval without invalidating it.
 *
 * Warnings are separated from errors deliberately: a huge file, an unexpected
 * extension or a dependency that does not exist yet is worth telling the
 * developer about, but is not a reason to refuse the whole proposal.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ProposalInvalidError } from '../core/errors';
import type { PathGuard } from '../security/PathGuard';
import { EXECUTABLE_OPERATIONS, type CodeProposalMessage, type ProposalChange } from '../protocol/types';
import {
  type ProposalBlock,
  type ValidatedChange,
  type ValidatedChangeSet,
  type ValidatedProposal,
} from '../types';

/** Upper bounds, mirroring the protocol's own. */
const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_PATH_CHARS = 512;
/** Above this, a single file is worth flagging even though it is allowed. */
const LARGE_FILE_CHARS = 120_000;

/** Extensions we accept, so a "proposal" cannot target a binary blob. */
const ALLOWED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.json', '.jsonc', '.json5', '.md', '.mdx', '.txt',
  '.css', '.scss', '.sass', '.less', '.html', '.htm', '.vue', '.svelte',
  '.py', '.rb', '.php', '.go', '.rs', '.java', '.kt', '.kts', '.swift',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.fs', '.fsx',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.env.example',
  '.sql', '.graphql', '.gql', '.proto', '.xml', '.svg', '.csv', '.gitignore',
  '.editorconfig', '.eslintrc', '.prettierrc', '.dockerfile', '.tf', '.hcl',
  '.blade.php', '.twig', '.ejs', '.hbs', '.phtml',
]);

const ALLOWED_BASENAMES = new Set([
  'Dockerfile', 'Makefile', 'Rakefile', 'Gemfile', 'Procfile', 'LICENSE', 'README',
  'CHANGELOG', '.gitignore', '.dockerignore', '.editorconfig', '.npmrc.example',
  'composer.json', 'package.json', 'go.mod', 'Cargo.toml', 'requirements.txt',
]);

export interface ValidationOptions {
  /**
   * Extension-only callers pass true here after the developer has explicitly
   * approved writing a sensitive path.
   */
  approvedSensitive?: boolean;
}

export class ProposalValidator {
  constructor(private readonly guard: PathGuard) {}

  /**
   * Validate a canonical proposal message.
   *
   * @throws ProposalInvalidError when the proposal must not be acted on.
   */
  validateChangeSet(
    message: CodeProposalMessage,
    options: ValidationOptions = {}
  ): ValidatedChangeSet {
    const errors: string[] = [];
    const warnings: string[] = [];
    const changes: ValidatedChange[] = [];
    const claimedPaths = new Map<string, string>();

    if (!Array.isArray(message.changes) || message.changes.length === 0) {
      throw new ProposalInvalidError('The AI proposal contained no changes.', [
        'A code_proposal must carry at least one file change.',
      ]);
    }

    message.changes.forEach((change, index) => {
      const label = `Change ${index + 1} (${change.file || 'no file'})`;
      const validated = this.validateChange(change, label, index, errors, warnings, options);
      if (!validated) {
        return;
      }
      const previous = claimedPaths.get(validated.relativePath);
      if (previous !== undefined) {
        errors.push(
          `${label} targets "${validated.relativePath}", which ${previous} already targets. Merge them into a single change so nothing is silently overwritten.`
        );
        return;
      }
      claimedPaths.set(validated.relativePath, label);
      changes.push(validated);
    });

    if (errors.length > 0) {
      throw new ProposalInvalidError(
        'The AI proposal was rejected before anything was written to disk.',
        errors
      );
    }

    // Dependency checks need the full set, so they run once every change has
    // been validated and its final path is known.
    for (const change of changes) {
      this.checkDependencies(change, claimedPaths, warnings);
    }

    const ordered = this.orderByDependencies(changes, warnings);

    return {
      envelope: message,
      changes: ordered,
      warnings,
      changeSetHash: hashChangeSet(ordered),
    };
  }

  /**
   * Validate a single change.
   *
   * Returns null when the change cannot be used, having pushed at least one
   * error. Every other failure mode is reported as a warning.
   */
  private validateChange(
    change: ProposalChange,
    label: string,
    index: number,
    errors: string[],
    warnings: string[],
    options: ValidationOptions
  ): ValidatedChange | null {
    const before = errors.length;

    // --- operation ---------------------------------------------------------
    if (!(EXECUTABLE_OPERATIONS as readonly string[]).includes(change.operation)) {
      errors.push(
        `${label}: the "${String(change.operation)}" operation cannot be applied by this version of PairPilot. Only "create" and "update" are executable, and deletion is disabled.`
      );
    }

    // --- path --------------------------------------------------------------
    let relativePath = '';
    let absolutePath = '';

    if (typeof change.file !== 'string' || change.file.trim() === '') {
      errors.push(`${label}: no file path was given.`);
    } else if (change.file.length > MAX_PATH_CHARS) {
      errors.push(`${label}: the path exceeds ${MAX_PATH_CHARS} characters.`);
    } else {
      const raw = change.file.trim();

      if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) {
        errors.push(
          `${label}: "${raw}" is an absolute path. PairPilot only accepts workspace-relative paths.`
        );
      } else if (raw.split(/[\\/]/).includes('..')) {
        errors.push(`${label}: "${raw}" contains a ".." segment.`);
      } else {
        try {
          const assessment = this.guard.assess(raw);
          relativePath = assessment.relativePath;
          absolutePath = assessment.absolutePath;
          if (assessment.verdict === 'blocked' || assessment.verdict === 'excluded') {
            errors.push(`${label}: "${raw}" is not writable — ${assessment.reason}`);
          } else if (assessment.verdict === 'sensitive' && !options.approvedSensitive) {
            errors.push(`${label}: "${raw}" looks sensitive — ${assessment.reason}`);
          }
          if (isInsideExcludedOutput(relativePath)) {
            errors.push(`${label}: "${raw}" is inside a build output or dependency directory.`);
          }
        } catch (error) {
          errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    // --- content -----------------------------------------------------------
    if (typeof change.content !== 'string' || change.content.trim().length === 0) {
      errors.push(`${label}: the change carries no file content.`);
    }

    if (errors.length > before) {
      return null;
    }

    if (!isLikelyTextFile(relativePath)) {
      warnings.push(
        `"${relativePath}" has an extension PairPilot does not recognise as source code. Review the preview carefully before approving.`
      );
    }

    if (PLACEHOLDER_PATTERN.test(change.content)) {
      warnings.push(
        `"${relativePath}" appears to contain placeholder text (for example "... rest of code"). The file may be incomplete.`
      );
    }

    // --- operation vs. filesystem reality ----------------------------------
    const exists = existsAsFile(absolutePath);
    if (change.operation === 'create' && exists) {
      errors.push(
        `"${relativePath}" already exists, but the proposal is a "create". Overwriting an existing file requires an explicit "update" proposal so you can review the change.`
      );
    }
    if (change.operation === 'update' && !exists) {
      errors.push(
        `"${relativePath}" does not exist, but the proposal is an "update". Use "create" for a new file.`
      );
    }

    if (errors.length > before) {
      return null;
    }

    const data: ValidatedChange = {
      change: { ...change, file: relativePath },
      relativePath,
      absolutePath,
      // Same construction as the 0.1.x hash, so the traversal-resistant property
      // carries over unchanged: operation, path and every byte of content.
      contentHash: hashProposal(
        change.operation,
        relativePath,
        blocksFor(change.content)
      ),
      assembledCode: ensureTrailingNewline(change.content),
      warnings: [],
      sourceIndex: index,
    };

    if (change.content.length > LARGE_FILE_CHARS) {
      warnings.push(`"${relativePath}" is unusually large (${change.content.length} characters).`);
    }

    return data;
  }

  /**
   * Report a dependency the proposal neither creates nor finds on disk.
   *
   * A warning rather than an error: the developer may be adding a file that
   * genuinely belongs to a later change, and refusing the whole proposal over it
   * would block work that is otherwise correct.
   */
  private checkDependencies(
    change: ValidatedChange,
    claimed: Map<string, string>,
    warnings: string[]
  ): void {
    for (const dependency of change.change.dependencies) {
      const normalised = normaliseDependency(dependency);
      if (normalised === null) {
        // A package name rather than a path — not something PairPilot manages.
        continue;
      }
      if (normalised === change.relativePath) {
        continue;
      }
      if (claimed.has(normalised)) {
        continue;
      }
      // A dependency outside the workspace cannot be created by this proposal
      // either, so it is not reported: the warning is about files the developer
      // could still be missing, not about every import.
      const assessment = this.guard.assess(normalised);
      if (assessment.verdict === 'blocked' || assessment.verdict === 'excluded') {
        continue;
      }
      if (existsAsFile(assessment.absolutePath)) {
        continue;
      }
      warnings.push(
        `"${change.relativePath}" declares a dependency on "${dependency}", which this proposal does not create and which is not in the workspace. Make sure it exists before approving.`
      );
    }
  }

  /**
   * Order changes so a file is written after the changes it depends on.
   *
   * A depth-first topological sort. Ties are broken by the model's own ordering,
   * which keeps the output stable and predictable: a proposal that is already
   * well-ordered comes back exactly as it was sent.
   *
   * A cycle is not fatal. Two files that import each other are legal in most
   * languages, and refusing the proposal would be wrong; the cycle is reported
   * as a warning and the declared order is kept for the members involved.
   */
  private orderByDependencies(changes: ValidatedChange[], warnings: string[]): ValidatedChange[] {
    const byPath = new Map<string, ValidatedChange>();
    for (const change of changes) {
      byPath.set(change.relativePath, change);
    }

    const order: ValidatedChange[] = [];
    const state = new Map<string, 'visiting' | 'done'>();

    const visit = (change: ValidatedChange, trail: string[]): void => {
      const current = state.get(change.relativePath);
      if (current === 'done') {
        return;
      }
      if (current === 'visiting') {
        // A cycle. Report it once, from the change that closes it.
        const cycle = [...trail.slice(trail.indexOf(change.relativePath)), change.relativePath];
        warnings.push(
          `These changes depend on each other in a cycle: ${cycle.join(' → ')}. They were kept in the order the AI proposed; check that they do not deadlock.`
        );
        return;
      }

      state.set(change.relativePath, 'visiting');
      for (const dependency of change.change.dependencies) {
        const normalised = normaliseDependency(dependency);
        if (normalised === null) {
          continue;
        }
        const producer = byPath.get(normalised);
        if (producer && producer !== change) {
          visit(producer, [...trail, change.relativePath]);
        }
      }
      state.set(change.relativePath, 'done');
      order.push(change);
    };

    for (const change of changes) {
      visit(change, []);
    }

    return order;
  }
}

/* -------------------------------------------------------------------------- */
/* Bridges to the single-file machinery                                       */
/* -------------------------------------------------------------------------- */

/**
 * Present one validated change in the shape the writer, the approval manager and
 * the review panel already use.
 *
 * Keeping this bridge explicit — rather than teaching every one of those three
 * about change sets — is what lets the multi-file path reuse the existing,
 * tested write-and-rollback machinery instead of duplicating it. The envelope's
 * narrative fields (`message`, `task`) are folded into the per-change record so
 * the review panel shows the same explanation for change 2 of 5 as for change 1.
 */
export function toValidatedProposal(
  change: ValidatedChange,
  envelope?: CodeProposalMessage
): ValidatedProposal {
  const description =
    change.change.description.trim().length > 0
      ? change.change.description.trim().slice(0, MAX_DESCRIPTION_CHARS)
      : (envelope?.task?.title ?? 'A file change');

  return {
    proposal: {
      type: 'code_proposal',
      filePath: change.relativePath,
      operation: change.change.operation === 'update' ? 'update' : 'create',
      description,
      dependencies: change.change.dependencies,
      blocks: blocksFor(change.change.content),
      ...(change.change.rationale !== undefined
        ? { rationale: change.change.rationale }
        : envelope?.message
          ? { rationale: envelope.message }
          : {}),
      ...(change.change.responsibilities !== undefined
        ? { responsibilities: change.change.responsibilities }
        : {}),
      ...(change.change.potentialProblems !== undefined
        ? { potentialProblems: change.change.potentialProblems }
        : {}),
      ...(envelope?.nextStep !== undefined
        ? {
            nextStep: {
              title: envelope.nextStep.title,
              reason: envelope.nextStep.reason,
              ...(envelope.nextStep.files !== undefined ? { files: envelope.nextStep.files } : {}),
              ...(envelope.nextStep.required !== undefined ? { required: envelope.nextStep.required } : {}),
            },
          }
        : {}),
    },
    relativePath: change.relativePath,
    absolutePath: change.absolutePath,
    contentHash: change.contentHash,
    assembledCode: change.assembledCode,
    warnings: change.warnings,
  };
}

/**
 * A canonical change is one complete file, so it maps to exactly one block.
 *
 * The block abstraction survives because the review panel and the approval hash
 * are built on it, and because a future patch-based operation would need several
 * blocks per file again. For a full-content change there is exactly one.
 */
export function blocksFor(content: string): ProposalBlock[] {
  return [
    {
      id: 'file',
      type: 'file',
      description: 'Complete file content',
      code: content,
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Markers that indicate the model left the implementation unfinished. */
const PLACEHOLDER_PATTERN =
  /(\/\/\s*(\.\.\.|rest of|remaining|implement|your code here|TODO: implement)|#\s*(\.\.\.|rest of|remaining|your code|TODO: implement)|<\s*!--\s*\.\.\.|\/\*\s*\.\.\.\s*\*\/|\.\.\.\s*(rest|remaining|existing)\s+(of\s+)?(the\s+)?(code|file|implementation))/i;

/** Join blocks in order. Exported so the writer and tests share one definition. */
export function assembleCode(blocks: ProposalBlock[]): string {
  const parts = blocks.map((block) => block.code);
  if (parts.length === 0) {
    return '';
  }
  return ensureTrailingNewline(parts.join('\n'));
}

/** Exactly one trailing newline: a file that gains one on every write drifts. */
export function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

/**
 * The approval hash for one file.
 *
 * Deliberately includes the operation and the path as well as the code. If only
 * the code were hashed, a swapped `filePath` would leave an approval valid and
 * let an approved write land somewhere it was never reviewed for.
 */
export function hashProposal(
  operation: string,
  relativePath: string,
  blocks: ProposalBlock[]
): string {
  const hasher = crypto.createHash('sha256');
  hasher.update(`operation:${operation}\n`);
  hasher.update(`path:${relativePath}\n`);
  for (const block of blocks) {
    hasher.update(`block:${block.id}:${block.code.length}\n`);
    hasher.update(block.code);
    hasher.update('\n');
  }
  return hasher.digest('hex');
}

/**
 * The hash of a whole change set.
 *
 * Derived from the ordered per-file hashes, so the set hash changes if a file is
 * added, removed, reordered or edited. It is what a "approve everything" action
 * binds to, which is what makes group approval as revocable as single approval.
 */
export function hashChangeSet(changes: readonly ValidatedChange[]): string {
  const hasher = crypto.createHash('sha256');
  hasher.update(`changes:${changes.length}\n`);
  for (const change of changes) {
    hasher.update(`${change.relativePath}:${change.contentHash}\n`);
  }
  return hasher.digest('hex');
}

/**
 * Decide whether a declared dependency is a workspace path PairPilot could
 * create, or a package name it cannot.
 *
 * A dot, a slash or a recognised source extension means a path. `express`,
 * `laravel/framework` and `@scope/pkg` do not match any of those, so they are
 * ignored — reporting them as missing would produce a warning on every proposal
 * that uses a library.
 */
export function normaliseDependency(dependency: string): string | null {
  const value = dependency.trim().replace(/^\.\//, '');
  if (value.length === 0 || value.includes(' ')) {
    return null;
  }
  const looksLikePath =
    value.includes('/') ||
    value.includes('\\') ||
    /\.[a-z0-9]{1,8}$/i.test(value) ||
    /^\.\.?$/.test(value);
  if (!looksLikePath) {
    return null;
  }
  const normalised = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalised.startsWith('..')) {
    return null;
  }
  return normalised;
}

/** Detect a path that is inside build output even if the top segment is fine. */
function isInsideExcludedOutput(relativePath: string): boolean {
  const segments = relativePath.split('/');
  return segments.some((segment, index) => {
    if (index === segments.length - 1) {
      return false;
    }
    return ['dist', 'build', 'out', 'output', 'target', 'coverage', 'bin', 'obj'].includes(
      segment.toLowerCase()
    );
  });
}

/** Conservative acceptance check for the warning path. */
function isLikelyTextFile(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath);
  if (ALLOWED_BASENAMES.has(basename)) {
    return true;
  }
  const extension = path.posix.extname(basename).toLowerCase();
  if (extension === '') {
    // Extensionless files are accepted (LICENSE, Procfile, …) but only when the
    // name looks textual.
    return !basename.includes('.');
  }
  if (ALLOWED_EXTENSIONS.has(extension)) {
    return true;
  }
  // `.blade.php` and friends: a compound extension whose last part is unknown.
  const compound = basename.slice(basename.indexOf('.'));
  return ALLOWED_EXTENSIONS.has(compound);
}

function existsAsFile(absolutePath: string): boolean {
  try {
    return fs.statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

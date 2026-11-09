/**
 * ProposalValidator — the trust boundary for AI-generated content.
 *
 * Spec section 7: "Do not trust AI-generated paths or commands. Reject paths
 * outside the active workspace. Support create and update in MVP. Deletion must
 * be disabled."
 *
 * This module takes a parsed-but-untrusted object and produces either a
 * `ValidatedProposal` that is safe to act on, or a list of reasons it is not. It
 * is stricter than a schema check because the model is an untrusted author:
 *
 *  - Paths are re-checked against the PathGuard, and must not escape the
 *    workspace, must not be absolute, must not be in build/dependency output.
 *  - `delete` is not representable; it is rejected at the type level and here.
 *  - `create` over an existing file is refused, because silently overwriting a
 *    file the developer already has is a destructive act disguised as a create.
 *  - `update` over a missing file is refused, with a hint to use `create`.
 *  - The approval hash covers path + operation + all code, so neither the target
 *    nor the bytes can change after approval without invalidating it.
 *
 * Warnings are separated from errors deliberately: a huge file or an unexpected
 * extension is worth telling the developer about, but is not a reason to refuse.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ProposalInvalidError } from '../core/errors';
import type { PathGuard } from '../security/PathGuard';
import {
  OPERATION_TYPES,
  type CodeProposal,
  type ProposalBlock,
  type ValidatedProposal,
} from '../types';

/** Upper bounds. Generous enough for real code, tight enough to stop abuse. */
const MAX_BLOCKS = 64;
const MAX_CODE_CHARS = 400_000;
const MAX_TOTAL_CODE_CHARS = 2_000_000;
const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_DEPENDENCIES = 200;
const MAX_PATH_CHARS = 512;
const MAX_LIST_ITEMS = 50;

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
]);

const ALLOWED_BASENAMES = new Set([
  'Dockerfile', 'Makefile', 'Rakefile', 'Gemfile', 'Procfile', 'LICENSE', 'README',
  'CHANGELOG', '.gitignore', '.dockerignore', '.editorconfig', '.npmrc.example',
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
   * Validate a parsed proposal.
   * @throws ProposalInvalidError when the proposal must not be acted on.
   */
  validate(proposal: CodeProposal, options: ValidationOptions = {}): ValidatedProposal {
    const errors: string[] = [];
    const warnings: string[] = [];

    // --- operation ---------------------------------------------------------
    const operation = proposal.operation;
    if (!OPERATION_TYPES.includes(operation)) {
      // Covers `delete`, which the runtime is told never to emit, and any
      // hallucinated operation such as `rename` or `move`.
      errors.push(
        `Unsupported operation "${String(operation)}". Only "create" and "update" are allowed; deletion is disabled.`
      );
    }

    // --- path --------------------------------------------------------------
    let relativePath = '';
    let absolutePath = '';
    if (typeof proposal.filePath !== 'string' || proposal.filePath.trim() === '') {
      errors.push('The proposal has no filePath.');
    } else if (proposal.filePath.length > MAX_PATH_CHARS) {
      errors.push(`The filePath exceeds ${MAX_PATH_CHARS} characters.`);
    } else {
      const raw = proposal.filePath.trim();

      if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) {
        // Explicitly refused rather than silently relativised: an absolute path
        // is either a mistake or an escape attempt, and both deserve a refusal.
        errors.push(
          `The filePath "${raw}" is absolute. PairPilot only accepts workspace-relative paths.`
        );
      } else if (raw.split(/[\\/]/).includes('..')) {
        errors.push(`The filePath "${raw}" contains a ".." segment.`);
      } else {
        let assessment;
        try {
          assessment = this.guard.assess(raw);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
          assessment = undefined;
        }
        if (assessment) {
          relativePath = assessment.relativePath;
          absolutePath = assessment.absolutePath;
          if (assessment.verdict === 'blocked' || assessment.verdict === 'excluded') {
            errors.push(`The filePath "${raw}" is not writable: ${assessment.reason}`);
          } else if (assessment.verdict === 'sensitive' && !options.approvedSensitive) {
            errors.push(
              `The filePath "${raw}" looks sensitive: ${assessment.reason}`
            );
          }
          if (isInsideExcludedOutput(relativePath)) {
            errors.push(
              `The filePath "${raw}" is inside a build output or dependency directory.`
            );
          }
        }
      }
    }

    if (relativePath && !isLikelyTextFile(relativePath)) {
      warnings.push(
        `"${relativePath}" has an extension PairPilot does not recognise as source code. Review the preview carefully before approving.`
      );
    }

    // --- blocks ------------------------------------------------------------
    const blocks = this.validateBlocks(proposal, errors, warnings);

    // --- metadata ----------------------------------------------------------
    const description =
      typeof proposal.description === 'string' && proposal.description.trim().length > 0
        ? proposal.description.trim().slice(0, MAX_DESCRIPTION_CHARS)
        : '';
    if (!description) {
      errors.push('The proposal has no description, so it cannot be reviewed meaningfully.');
    }

    const rationale = typeof proposal.rationale === 'string' ? proposal.rationale.slice(0, MAX_DESCRIPTION_CHARS) : undefined;
    const responsibilities = toStringList(proposal.responsibilities, MAX_LIST_ITEMS, MAX_DESCRIPTION_CHARS);
    const potentialProblems = toStringList(proposal.potentialProblems, MAX_LIST_ITEMS, MAX_DESCRIPTION_CHARS);
    const dependencies = toStringList(proposal.dependencies, MAX_DEPENDENCIES, 512);

    // --- operation vs. filesystem reality ----------------------------------
    if (errors.length === 0 && absolutePath) {
      const exists = existsAsFile(absolutePath);
      if (operation === 'create' && exists) {
        errors.push(
          `"${relativePath}" already exists, but the proposal is a "create". Overwriting an existing file requires an explicit "update" proposal so you can review the change.`
        );
      }
      if (operation === 'update' && !exists) {
        errors.push(
          `"${relativePath}" does not exist, but the proposal is an "update". Use "create" for a new file.`
        );
      }
    }

    if (errors.length > 0) {
      throw new ProposalInvalidError(
        'The AI proposal was rejected before anything was written to disk.',
        errors
      );
    }

    const assembledCode = assembleCode(blocks);
    const contentHash = hashProposal(operation, relativePath, blocks);

    return {
      proposal: {
        ...proposal,
        operation,
        filePath: relativePath,
        description,
        blocks,
        dependencies: dependencies ?? [],
        ...(rationale !== undefined ? { rationale } : {}),
        ...(responsibilities !== undefined ? { responsibilities } : {}),
        ...(potentialProblems !== undefined ? { potentialProblems } : {}),
      },
      relativePath,
      absolutePath,
      contentHash,
      assembledCode,
      warnings,
    };
  }

  private validateBlocks(
    proposal: CodeProposal,
    errors: string[],
    warnings: string[]
  ): ProposalBlock[] {
    if (!Array.isArray(proposal.blocks) || proposal.blocks.length === 0) {
      errors.push('The proposal contains no code blocks.');
      return [];
    }
    if (proposal.blocks.length > MAX_BLOCKS) {
      errors.push(`The proposal has ${proposal.blocks.length} blocks; the limit is ${MAX_BLOCKS}.`);
    }

    const blocks: ProposalBlock[] = [];
    const seenIds = new Set<string>();
    let totalChars = 0;

    proposal.blocks.slice(0, MAX_BLOCKS).forEach((raw, index) => {
      if (raw === null || typeof raw !== 'object') {
        errors.push(`Block ${index + 1} is not an object.`);
        return;
      }
      const block = raw as Partial<ProposalBlock>;

      if (typeof block.code !== 'string') {
        errors.push(`Block ${index + 1} has no "code" string.`);
        return;
      }
      if (block.code.trim().length === 0) {
        errors.push(`Block ${index + 1} has empty code.`);
        return;
      }
      if (block.code.length > MAX_CODE_CHARS) {
        errors.push(`Block ${index + 1} exceeds ${MAX_CODE_CHARS} characters.`);
        return;
      }
      totalChars += block.code.length;
      if (totalChars > MAX_TOTAL_CODE_CHARS) {
        errors.push(`The proposal's total code exceeds ${MAX_TOTAL_CODE_CHARS} characters.`);
        return;
      }

      // Placeholder text is a real failure mode: the model sometimes emits a
      // stub and the developer approves something that does not run.
      if (PLACEHOLDER_PATTERN.test(block.code)) {
        warnings.push(
          `Block ${index + 1} appears to contain placeholder text (for example "... rest of code"). The code may be incomplete.`
        );
      }

      let id = typeof block.id === 'string' && block.id.trim().length > 0 ? block.id.trim() : `block-${String(index + 1).padStart(3, '0')}`;
      if (seenIds.has(id)) {
        id = `${id}-${index + 1}`;
        warnings.push(`Block ${index + 1} had a duplicate id; it was renamed to "${id}".`);
      }
      seenIds.add(id);

      blocks.push({
        id,
        type: typeof block.type === 'string' && block.type.trim() ? block.type.trim() : 'code',
        description:
          typeof block.description === 'string' ? block.description.slice(0, MAX_DESCRIPTION_CHARS) : '',
        code: block.code,
        ...(typeof block.language === 'string' ? { language: block.language } : {}),
      });
    });

    return blocks;
  }
}

/** Markers that indicate the model left the implementation unfinished. */
const PLACEHOLDER_PATTERN =
  /(\/\/\s*(\.\.\.|rest of|remaining|implement|your code here|TODO: implement)|#\s*(\.\.\.|rest of|remaining)|<\s*!--\s*\.\.\.|\/\*\s*\.\.\.\s*\*\/)/i;

/** Join blocks in order. Exported so the writer and tests share one definition. */
export function assembleCode(blocks: ProposalBlock[]): string {
  const parts = blocks.map((block) => block.code);
  if (parts.length === 0) {
    return '';
  }
  let output = parts.join('\n');
  if (!output.endsWith('\n')) {
    output += '\n';
  }
  return output;
}

/**
 * The approval hash.
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
    // Extensionless files are accepted (LICENSE, Procfile, ...) but only when
    // the name looks textual.
    return !basename.includes('.');
  }
  return ALLOWED_EXTENSIONS.has(extension);
}

function toStringList(
  value: unknown,
  maxItems: number,
  maxItemChars: number
): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const output: string[] = [];
  for (const item of value.slice(0, maxItems)) {
    if (typeof item === 'string' && item.trim().length > 0) {
      output.push(item.trim().slice(0, maxItemChars));
    }
  }
  // An empty list is reported as absent rather than as `[]`, so the review panel
  // does not render empty "Dependencies"/"Potential problems" headings and the
  // UI snapshot stays free of meaningless fields.
  return output.length > 0 ? output : undefined;
}

function existsAsFile(absolutePath: string): boolean {
  try {
    return fs.statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

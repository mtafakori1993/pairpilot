/**
 * PathGuard — the single choke point for every path that enters or leaves
 * PairPilot.
 *
 * Threat model. AI output is untrusted input. A proposal may name
 * `../../.ssh/id_rsa`, `/etc/passwd`, a symlink that escapes the workspace, or a
 * `.env` file. The extension must reject these *before* any read or write, not
 * after. Every file operation in PairPilot routes through `assess()`.
 *
 * Verdicts:
 *   allow      — normal project file.
 *   sensitive  — readable/writable only with explicit per-file approval.
 *   excluded   — dependency/build output. Never sent as context, never written.
 *   blocked    — never accessible under any circumstance.
 *
 * `excluded` and `blocked` are deliberately *not* approvable. A dialog that can
 * be clicked through is not a security boundary; for private keys and `.git`
 * internals there is no legitimate PairPilot workflow that needs access.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { PathRejectedError } from '../core/errors';

export type PathVerdict = 'allow' | 'sensitive' | 'excluded' | 'blocked';

export interface PathAssessment {
  verdict: PathVerdict;
  /** Normalised, POSIX-separated, workspace-relative path. */
  relativePath: string;
  /** Absolute path (normalised, not necessarily existing). */
  absolutePath: string;
  /** Human-readable explanation, shown in the UI. */
  reason: string;
  /** True when a modal approval can lift this restriction. */
  approvable: boolean;
}

/** Dependency and build-output directories: never context, never written. */
export const EXCLUDED_DIR_NAMES: readonly string[] = [
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'output',
  'target',
  'bin',
  'obj',
  'coverage',
  'htmlcov',
  '__pycache__',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.tox',
  '.venv',
  'venv',
  '.gradle',
  '.idea',
  '.terraform',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.vscode-test',
  '.serverless',
  '.yarn',
  '.pnpm-store',
];

/**
 * Hard-blocked path fragments. `.git` is blocked because writing into it can
 * corrupt the repository or plant hooks that execute on the developer's behalf.
 */
export const BLOCKED_PATH_FRAGMENTS: readonly string[] = [
  '/.git/',
  '/.ssh/',
  '/.gnupg/',
  '/.aws/',
  '/.azure/',
  '/.kube/',
  '/.docker/config.json',
  '/.config/gh/hosts.yml',
];

/** Filenames that are always blocked, whatever the extension. */
export const BLOCKED_BASENAMES: readonly string[] = ['.netrc', '.htpasswd', '.pgpass'];

/** File extensions treated as private key material. */
export const BLOCKED_EXTENSIONS: readonly string[] = [
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.ppk',
  '.asc',
  '.gpg',
  '.ovpn',
];

/**
 * Basenames that look like private keys (`id_rsa`, `id_ed25519`, ...).
 *
 * Matched against the basename *and* its extension-stripped stem, so variants
 * such as `id_rsa.bak`, `id_rsa.old` or `id_rsa.ts` are caught too. A backup of a
 * key is still a key, and no legitimate PairPilot task writes a file with this
 * name, so blocking the whole family costs nothing.
 */
const PRIVATE_KEY_BASENAME = /^id_(rsa|dsa|ecdsa|ed25519|ecdsa_sk|ed25519_sk)$/i;

/**
 * Sensitive-but-approvable filenames. Spec section 6 requires an approval prompt
 * for these rather than an outright refusal.
 */
const SENSITIVE_BASENAME = /^(\.env(\..+)?|\.envrc|\.?npmrc|\.yarnrc|\.pypirc|\.gemrc|\.dockercfg|\.git-credentials|\.s3cfg|\.pgpass2)$/i;
const SENSITIVE_CONTAINS = /(secret|credential|password|passwd|token|apikey|api_key|private_key|auth)/i;

/** Windows reserved device names — writing these can hang or corrupt a system. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export interface PathGuardOptions {
  /**
   * Allow `sensitive` files to be offered at all. Even when true, each file
   * still needs a per-file approval; this only controls whether the option is
   * surfaced. Blocked paths are unaffected.
   */
  allowSensitiveFiles?: boolean;
}

export class PathGuard {
  private readonly root: string;
  /** Case-insensitive comparisons on Windows/macOS. */
  private readonly caseInsensitive: boolean;
  private readonly allowSensitiveFiles: boolean;

  constructor(workspaceRoot: string, options: PathGuardOptions = {}) {
    if (!workspaceRoot) {
      throw new PathRejectedError('No workspace folder is open.', workspaceRoot);
    }
    // `path.resolve` normalises `..` and trailing separators so that later
    // containment checks cannot be fooled by `a/../../b`.
    this.root = path.resolve(workspaceRoot);
    this.caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
    this.allowSensitiveFiles = options.allowSensitiveFiles ?? false;
  }

  get workspaceRoot(): string {
    return this.root;
  }

  /**
   * Classify a candidate path without touching the filesystem.
   *
   * Never throws for blocked/excluded paths — callers need the verdict to render
   * a message. Throws only for structurally impossible input (empty, null bytes).
   */
  assess(candidate: string): PathAssessment {
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      throw new PathRejectedError('An empty path was provided.', String(candidate));
    }
    // A NUL byte truncates paths in native calls and enables bypass tricks.
    if (candidate.includes('\u0000')) {
      throw new PathRejectedError('Path contains a NUL byte.', candidate);
    }
    // Reject non-local schemes outright (`file:`, `untitled:`, `vscode-remote:`).
    if (/^[a-z][a-z0-9+.-]*:/i.test(candidate) && !/^[a-zA-Z]:[\\/]/.test(candidate)) {
      throw new PathRejectedError(`Unsupported path scheme: ${candidate}`, candidate);
    }

    const absolutePath = path.resolve(this.root, candidate);
    const relativeRaw = path.relative(this.root, absolutePath);

    // Containment check. `path.relative` yields `..` segments (or an absolute
    // path on a different drive) when the target escapes the root.
    //
    // Note the `..` test is exact-segment, not `startsWith('..')`: a file
    // legitimately named `..foo` produces the relative path `..foo`, which a
    // naive prefix test would misclassify as an escape.
    const escapes =
      relativeRaw === '..' ||
      relativeRaw.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeRaw);
    if (escapes) {
      return {
        verdict: 'blocked',
        relativePath: relativeRaw,
        absolutePath,
        reason: 'The path is outside the current workspace. PairPilot never reads or writes outside your workspace.',
        approvable: false,
      };
    }
    if (relativeRaw === '') {
      // The workspace root itself is not a file target.
      return {
        verdict: 'blocked',
        relativePath: '.',
        absolutePath,
        reason: 'The workspace root itself cannot be modified.',
        approvable: false,
      };
    }

    const relativePath = toPosix(relativeRaw);
    const segments = relativePath.split('/').filter(Boolean);
    const basename = segments[segments.length - 1] ?? relativePath;
    const compare = this.caseInsensitive ? relativePath.toLowerCase() : relativePath;
    const compareBase = this.caseInsensitive ? basename.toLowerCase() : basename;

    // --- blocked -----------------------------------------------------------
    const blockedFragment = BLOCKED_PATH_FRAGMENTS.find((fragment) =>
      `/${compare}/`.includes(this.caseInsensitive ? fragment.toLowerCase() : fragment)
    );
    if (blockedFragment) {
      return {
        verdict: 'blocked',
        relativePath,
        absolutePath,
        reason: `Access to ${blockedFragment} is permanently blocked: it can contain credentials or repository internals.`,
        approvable: false,
      };
    }

    const ext = path.extname(compareBase);
    if (BLOCKED_EXTENSIONS.includes(ext)) {
      return {
        verdict: 'blocked',
        relativePath,
        absolutePath,
        reason: `Files ending in "${ext}" may hold private key material and are permanently blocked.`,
        approvable: false,
      };
    }
    // Test both the full basename and its stem, so `id_rsa`, `id_rsa.bak` and
    // `id_rsa.ts` are all refused.
    const stem = ext ? compareBase.slice(0, compareBase.length - ext.length) : compareBase;
    if (PRIVATE_KEY_BASENAME.test(compareBase) || PRIVATE_KEY_BASENAME.test(stem)) {
      return {
        verdict: 'blocked',
        relativePath,
        absolutePath,
        reason: `"${basename}" matches a private key filename and is permanently blocked.`,
        approvable: false,
      };
    }
    if (BLOCKED_BASENAMES.includes(compareBase)) {
      return {
        verdict: 'blocked',
        relativePath,
        absolutePath,
        reason: `"${basename}" looks like stored credentials and is permanently blocked.`,
        approvable: false,
      };
    }
    if (WINDOWS_RESERVED.test(compareBase)) {
      return {
        verdict: 'blocked',
        relativePath,
        absolutePath,
        reason: `"${basename}" is a reserved device name.`,
        approvable: false,
      };
    }

    // --- excluded ----------------------------------------------------------
    const excludedDir = segments.find((segment) => {
      const s = this.caseInsensitive ? segment.toLowerCase() : segment;
      return EXCLUDED_DIR_NAMES.some((d) => d.toLowerCase() === s);
    });
    if (excludedDir) {
      return {
        verdict: 'excluded',
        relativePath,
        absolutePath,
        reason: `"${excludedDir}" is dependency or build output. It is never sent as context and never written.`,
        approvable: false,
      };
    }

    // --- sensitive ---------------------------------------------------------
    if (SENSITIVE_BASENAME.test(basename) || SENSITIVE_CONTAINS.test(basename)) {
      return {
        verdict: 'sensitive',
        relativePath,
        absolutePath,
        reason:
          'This file may contain secrets or credentials. Reading it as context, or writing it, requires your explicit approval each time.',
        approvable: this.allowSensitiveFiles,
      };
    }

    return {
      verdict: 'allow',
      relativePath,
      absolutePath,
      reason: 'Path is inside the workspace.',
      approvable: true,
    };
  }

  /**
   * Resolve a path for writing, enforcing that only `allow` (and, when the caller
   * has already obtained approval, `sensitive`) paths proceed.
   */
  resolveForWrite(candidate: string, approvedSensitive = false): PathAssessment {
    const assessment = this.assess(candidate);
    if (assessment.verdict === 'blocked' || assessment.verdict === 'excluded') {
      throw new PathRejectedError(assessment.reason, candidate);
    }
    if (assessment.verdict === 'sensitive' && !approvedSensitive) {
      throw new PathRejectedError(
        `${assessment.reason} (approval not granted for this write)`,
        candidate
      );
    }
    return assessment;
  }

  /** True when `candidate` resolves inside the workspace root. */
  isInsideWorkspace(candidate: string): boolean {
    try {
      const assessment = this.assess(candidate);
      return assessment.verdict === 'allow' || assessment.verdict === 'sensitive';
    } catch {
      return false;
    }
  }

  /**
   * Symlink escape check.
   *
   * `assess()` is purely lexical, so `link -> /etc` passes it. This resolves
   * symlinks on the deepest existing ancestor and re-checks containment. Call it
   * immediately before any write.
   */
  assertRealPathInsideWorkspace(candidate: string): PathAssessment {
    const assessment = this.assess(candidate);
    if (assessment.verdict === 'blocked' || assessment.verdict === 'excluded') {
      throw new PathRejectedError(assessment.reason, candidate);
    }

    const realRoot = safeRealpath(this.root) ?? this.root;
    // Walk up to the deepest ancestor that exists, then resolve that.
    let probe = assessment.absolutePath;
    for (let depth = 0; depth < 64; depth++) {
      if (fs.existsSync(probe)) {
        const real = safeRealpath(probe);
        if (real) {
          // Re-derive the remainder of the path relative to the resolved ancestor.
          const remainder = path.relative(probe, assessment.absolutePath);
          const resolvedTarget = remainder ? path.resolve(real, remainder) : real;
          if (!isContained(realRoot, resolvedTarget, this.caseInsensitive)) {
            throw new PathRejectedError(
              'The path resolves outside the workspace through a symbolic link.',
              candidate
            );
          }
        }
        break;
      }
      const parent = path.dirname(probe);
      if (parent === probe) {
        break;
      }
      probe = parent;
    }
    return assessment;
  }
}

/** Convert a platform path to POSIX separators. */
export function toPosix(value: string): string {
  return value.split(path.sep).join('/').split('\\').join('/');
}

function isContained(root: string, target: string, caseInsensitive: boolean): boolean {
  const rel = path.relative(root, target);
  if (rel === '') {
    return true;
  }
  const escapes =
    rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  if (!escapes) {
    return true;
  }
  // On case-insensitive filesystems a case-only difference is still inside.
  if (caseInsensitive) {
    const relLower = path.relative(root.toLowerCase(), target.toLowerCase());
    return (
      relLower === '' ||
      !(relLower === '..' || relLower.startsWith(`..${path.sep}`) || path.isAbsolute(relLower))
    );
  }
  return false;
}

function safeRealpath(target: string): string | null {
  try {
    return fs.realpathSync.native(target);
  } catch {
    try {
      return fs.realpathSync(target);
    } catch {
      return null;
    }
  }
}

/**
 * FileReader — the only code path that reads workspace files.
 *
 * Spec section 6 requires that we never send the whole workspace and never read
 * excluded or sensitive files without approval. This module enforces that by
 * construction: it takes a `PathGuard` and refuses anything that is not `allow`
 * (or `sensitive` *with* a per-file approval flag).
 *
 * Two operational details that matter in practice:
 *
 *  - Size limits are applied while reading, not after. `fs.readSync` into a
 *    fixed buffer means a 2 GB log file cannot exhaust memory just because it was
 *    picked as context.
 *  - Binary files are detected by inspecting the first chunk for a NUL byte and
 *    are skipped with a reason, rather than being decoded into replacement
 *    characters that would waste the model's context window.
 */

import * as fs from 'node:fs';
import type { PathGuard } from '../security/PathGuard';

export interface ReadFileOptions {
  /** Maximum bytes to read from the file. */
  maxBytes: number;
  /**
   * Set only after the developer approved this specific sensitive file for this
   * request. Never defaulted to true anywhere in the codebase.
   */
  approvedSensitive?: boolean;
}

export interface FileReadResult {
  relativePath: string;
  content: string;
  /** True when the file was larger than the limit and was cut off. */
  truncated: boolean;
  bytesRead: number;
  /** Total size on disk, for reporting. */
  totalBytes: number;
}

export type FileReadOutcome =
  | { ok: true; value: FileReadResult }
  | { ok: false; reason: string; blocked: boolean };

/** Bytes inspected to decide whether a file is binary. */
const SNIFF_BYTES = 8000;

export class FileReader {
  constructor(private readonly guard: PathGuard) {}

  /**
   * Read one file as UTF-8 text, subject to the guard and the size limit.
   *
   * Returns a discriminated result instead of throwing, because "this file
   * cannot be used as context" is an expected outcome that the UI reports, not
   * an error.
   */
  read(relativePath: string, options: ReadFileOptions): FileReadOutcome {
    let assessment;
    try {
      assessment = this.guard.assess(relativePath);
    } catch (error) {
      return {
        ok: false,
        blocked: true,
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    if (assessment.verdict === 'blocked' || assessment.verdict === 'excluded') {
      return { ok: false, blocked: true, reason: assessment.reason };
    }
    if (assessment.verdict === 'sensitive' && !options.approvedSensitive) {
      return { ok: false, blocked: true, reason: assessment.reason };
    }

    // Re-check through symlinks immediately before opening. The lexical check
    // above cannot see `link -> /etc/passwd`.
    let resolved;
    try {
      resolved = this.guard.assertRealPathInsideWorkspace(relativePath);
    } catch (error) {
      return {
        ok: false,
        blocked: true,
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    let handle: number | undefined;
    try {
      const stat = fs.statSync(resolved.absolutePath);
      if (!stat.isFile()) {
        return { ok: false, blocked: false, reason: 'Not a regular file.' };
      }
      const totalBytes = stat.size;
      if (totalBytes === 0) {
        return {
          ok: true,
          value: {
            relativePath: resolved.relativePath,
            content: '',
            truncated: false,
            bytesRead: 0,
            totalBytes: 0,
          },
        };
      }

      handle = fs.openSync(resolved.absolutePath, 'r');
      const readSize = Math.min(totalBytes, options.maxBytes);
      const buffer = Buffer.allocUnsafe(readSize);
      const bytesRead = fs.readSync(handle, buffer, 0, readSize, 0);

      const slice = buffer.subarray(0, bytesRead);
      if (looksBinary(slice)) {
        return {
          ok: false,
          blocked: false,
          reason: 'Binary file. Binary contents are not sent as context.',
        };
      }

      let content = slice.toString('utf8');
      const truncated = bytesRead < totalBytes;
      if (truncated) {
        content += `\n\n/* ... PairPilot truncated this file at ${readSize} of ${totalBytes} bytes ... */`;
      }

      return {
        ok: true,
        value: {
          relativePath: resolved.relativePath,
          content,
          truncated,
          bytesRead,
          totalBytes,
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { ok: false, blocked: false, reason: 'File does not exist.' };
      }
      if (code === 'EACCES' || code === 'EPERM') {
        return { ok: false, blocked: false, reason: 'Permission denied.' };
      }
      return {
        ok: false,
        blocked: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (handle !== undefined) {
        try {
          fs.closeSync(handle);
        } catch {
          /* nothing useful to do */
        }
      }
    }
  }

  /** `assess` passthrough, so callers can render a verdict without reading. */
  assess(candidate: string) {
    return this.guard.assess(candidate);
  }

  /** True when the path exists as a regular file inside the workspace. */
  exists(relativePath: string): boolean {
    try {
      const assessment = this.guard.assess(relativePath);
      if (assessment.verdict === 'blocked' || assessment.verdict === 'excluded') {
        return false;
      }
      return fs.statSync(assessment.absolutePath).isFile();
    } catch {
      return false;
    }
  }
}

/**
 * Heuristic binary detection: a NUL byte in the first chunk, or a high
 * proportion of non-text control characters.
 */
export function looksBinary(slice: Buffer): boolean {
  const inspect = slice.subarray(0, Math.min(slice.length, SNIFF_BYTES));
  if (inspect.includes(0)) {
    return true;
  }
  let suspicious = 0;
  for (const byte of inspect) {
    // Allow tab, newline, carriage return and form feed; count other C0 controls.
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) {
      suspicious++;
    }
  }
  return inspect.length > 0 && suspicious / inspect.length > 0.3;
}

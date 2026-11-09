/**
 * PathGuard tests.
 *
 * These are the highest-value tests in the project: they verify the claim that
 * the AI cannot reach outside the workspace or touch credentials. Every case
 * here is a real escape technique, not a hypothetical.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PathGuard, toPosix } from '../../src/security/PathGuard';
import { PathRejectedError } from '../../src/core/errors';

let root: string;

beforeEach(() => {
  // A real temporary directory, so symlink and realpath behaviour is genuine.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pairpilot-guard-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const a = 1;\n');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function guard(options = {}): PathGuard {
  return new PathGuard(root, options);
}

describe('PathGuard: allowed paths', () => {
  it('allows a normal source file', () => {
    const assessment = guard().assess('src/index.ts');
    expect(assessment.verdict).toBe('allow');
    expect(assessment.relativePath).toBe('src/index.ts');
  });

  it('normalises a backslash-separated path to POSIX', () => {
    expect(guard().assess('src\\index.ts').relativePath).toBe('src/index.ts');
  });

  it('normalises redundant segments without rejecting them', () => {
    // `./src/./index.ts` is inside the workspace, so it should be allowed and
    // normalised rather than refused.
    expect(guard().assess('./src/./index.ts').relativePath).toBe('src/index.ts');
  });

  it('allows a not-yet-existing file (a create proposal)', () => {
    const assessment = guard().assess('src/brand-new.ts');
    expect(assessment.verdict).toBe('allow');
  });

  it('allows a file whose name begins with two dots', () => {
    // `..foo` is a legal filename. A naive `startsWith("..")` check would call
    // this an escape attempt.
    expect(guard().assess('src/..hidden').verdict).toBe('allow');
  });
});

describe('PathGuard: workspace escapes', () => {
  it('blocks a parent traversal', () => {
    const assessment = guard().assess('../secrets.txt');
    expect(assessment.verdict).toBe('blocked');
    expect(assessment.approvable).toBe(false);
  });

  it('blocks a traversal buried mid-path', () => {
    expect(guard().assess('src/../../outside.txt').verdict).toBe('blocked');
  });

  it('blocks an absolute path outside the workspace', () => {
    expect(guard().assess('/etc/passwd').verdict).toBe('blocked');
  });

  it('allows an absolute path that resolves inside the workspace', () => {
    // The guard itself is containment-based, so an absolute path inside the root
    // is permitted. The *proposal* layer separately refuses absolute paths as a
    // policy, because the AI is required to emit relative ones.
    expect(guard().assess(path.join(root, 'src', 'index.ts')).verdict).toBe('allow');
  });

  it('blocks the workspace root itself, which is not a file target', () => {
    expect(guard().assess('.').verdict).toBe('blocked');
  });

  it('refuses an empty path outright', () => {
    expect(() => guard().assess('')).toThrow(PathRejectedError);
  });

  it('rejects non-file URI schemes', () => {
    expect(() => guard().assess('https://evil.example/x.ts')).toThrow(PathRejectedError);
    expect(() => guard().assess('untitled:Untitled-1')).toThrow(PathRejectedError);
  });

  it('rejects a path containing a NUL byte', () => {
    // Native calls truncate at NUL, which is a classic bypass.
    expect(() => guard().assess('src/index.ts\u0000.png')).toThrow(PathRejectedError);
  });

  it('rejects a non-string path', () => {
    expect(() => guard().assess(undefined as unknown as string)).toThrow(PathRejectedError);
  });
});

describe('PathGuard: permanently blocked credentials', () => {
  it.each([
    '.env',
    '.env.local',
    '.env.production',
    '.npmrc',
    '.git-credentials',
    'src/config/.env',
  ])('classifies %s as sensitive (approvable, not silently readable)', (candidate) => {
    const assessment = guard().assess(candidate);
    expect(assessment.verdict).toBe('sensitive');
    // Even when sensitive files are enabled, they stay non-approvable unless the
    // developer opted in.
    expect(assessment.approvable).toBe(false);
  });

  it.each([
    'config/server.pem',
    'certs/private.key',
    'keys/bundle.p12',
    'ssh/id_rsa',
    'secrets.jks',
  ])('permanently blocks %s', (candidate) => {
    const assessment = guard().assess(candidate);
    expect(assessment.verdict).toBe('blocked');
    expect(assessment.approvable).toBe(false);
  });

  it('permanently blocks .git internals', () => {
    const assessment = guard().assess('.git/config');
    expect(assessment.verdict).toBe('blocked');
    expect(assessment.approvable).toBe(false);
  });

  it('blocks a planted git hook, which would execute on the developer behalf', () => {
    expect(guard().assess('.git/hooks/pre-commit').verdict).toBe('blocked');
  });

  it('blocks known credential file locations', () => {
    expect(guard().assess('.aws/credentials').verdict).toBe('blocked');
    expect(guard().assess('.ssh/known_hosts').verdict).toBe('blocked');
  });

  it('blocks Windows reserved device names', () => {
    expect(guard().assess('src/CON').verdict).toBe('blocked');
    expect(guard().assess('src/nul.txt').verdict).toBe('blocked');
  });

  it('marks sensitive files approvable only when explicitly enabled', () => {
    expect(guard({ allowSensitiveFiles: true }).assess('.env').approvable).toBe(true);
    // Private keys remain non-approvable regardless.
    expect(guard({ allowSensitiveFiles: true }).assess('id_rsa').approvable).toBe(false);
  });
});

describe('PathGuard: excluded directories', () => {
  it.each([
    'node_modules/express/index.js',
    'vendor/autoload.php',
    'dist/bundle.js',
    'build/output.o',
    'coverage/lcov.info',
    '__pycache__/mod.pyc',
    '.venv/lib/python3.11/site.py',
    'src/node_modules/nested.js',
  ])('excludes %s', (candidate) => {
    const assessment = guard().assess(candidate);
    expect(assessment.verdict).toBe('excluded');
    expect(assessment.approvable).toBe(false);
  });

  it('is not fooled by a similar-looking directory name', () => {
    // `node_modules_backup` is a different directory and must be allowed.
    expect(guard().assess('node_modules_backup/x.js').verdict).toBe('allow');
  });
});

describe('PathGuard: symlink escapes', () => {
  it('detects a symlink pointing outside the workspace', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pairpilot-outside-'));
    try {
      // Deliberately a bland name: if it were called `secret.txt` the sensitive
      // filename rule would mask the escape and the test would prove nothing.
      const payload = path.join(outside, 'notes.txt');
      fs.writeFileSync(payload, 'data outside the workspace\n');
      const linkPath = path.join(root, 'escape');
      try {
        fs.symlinkSync(outside, linkPath, 'dir');
      } catch {
        // Some CI environments forbid symlinks; skip rather than fail falsely.
        return;
      }

      // The lexical check cannot see through the link, so `assess` allows it.
      const lexical = guard().assess('escape/notes.txt');
      expect(lexical.verdict).toBe('allow');
      // The real-path check must catch it.
      expect(() => guard().assertRealPathInsideWorkspace('escape/notes.txt')).toThrow(
        PathRejectedError
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('permits a symlink that stays inside the workspace', () => {
    const target = path.join(root, 'src');
    const linkPath = path.join(root, 'src-link');
    try {
      fs.symlinkSync(target, linkPath, 'dir');
    } catch {
      return;
    }
    expect(() => guard().assertRealPathInsideWorkspace('src-link/index.ts')).not.toThrow();
  });
});

describe('PathGuard: resolveForWrite', () => {
  it('refuses a blocked path', () => {
    expect(() => guard().resolveForWrite('.env')).toThrow(PathRejectedError);
    expect(() => guard().resolveForWrite('id_rsa')).toThrow(PathRejectedError);
  });

  it('refuses an excluded path', () => {
    expect(() => guard().resolveForWrite('node_modules/x.js')).toThrow(PathRejectedError);
  });

  it('refuses a sensitive path without explicit approval', () => {
    expect(() => guard({ allowSensitiveFiles: true }).resolveForWrite('.env')).toThrow(
      PathRejectedError
    );
  });

  it('permits a sensitive path when approval was granted', () => {
    expect(() =>
      guard({ allowSensitiveFiles: true }).resolveForWrite('.env', true)
    ).not.toThrow();
  });

  it('permits an ordinary path', () => {
    expect(() => guard().resolveForWrite('src/index.ts')).not.toThrow();
  });
});

describe('PathGuard: construction', () => {
  it('refuses an empty workspace root', () => {
    expect(() => new PathGuard('')).toThrow(PathRejectedError);
  });

  it('resolves a relative root to an absolute one', () => {
    const relative = new PathGuard('.');
    expect(path.isAbsolute(relative.workspaceRoot)).toBe(true);
  });
});

describe('toPosix', () => {
  it('converts separators to forward slashes', () => {
    expect(toPosix('a\\b\\c')).toBe('a/b/c');
    expect(toPosix('a/b/c')).toBe('a/b/c');
  });
});

describe('PathGuard: private key filename variants', () => {
  it.each(['id_rsa', 'id_rsa.bak', 'id_rsa.old', 'keys/id_ed25519.txt'])(
    'blocks %s, because a backed-up key is still a key',
    (candidate) => {
      expect(guard().assess(candidate).verdict).toBe('blocked');
    }
  );

  it('does not block an unrelated filename that merely contains "id"', () => {
    expect(guard().assess('src/id.ts').verdict).toBe('allow');
    expect(guard().assess('src/validate.ts').verdict).toBe('allow');
  });
});

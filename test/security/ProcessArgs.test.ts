/**
 * processArgs tests.
 *
 * These verify the claims made in spec section 4 and 13: no shell, no
 * user-controlled string concatenation, and no configuration path that weakens
 * the approval guarantees.
 */

import { describe, expect, it } from 'vitest';
import {
  buildClaudeArgs,
  buildChildEnv,
  findOnPath,
  sanitizeExtraArgs,
} from '../../src/runtime/processArgs';
import { RuntimeError } from '../../src/core/errors';

function args(overrides: Partial<Parameters<typeof buildClaudeArgs>[0]> = {}): string[] {
  return buildClaudeArgs({ bare: true, extraArgs: [], ...overrides });
}

/** Read the value that follows a flag, or null. */
function valueOf(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

describe('buildClaudeArgs: required protocol flags', () => {
  it('requests stream-json output', () => {
    expect(valueOf(args(), '--output-format')).toBe('stream-json');
  });

  it('includes --verbose, which stream-json output requires', () => {
    // Verified against the real CLI: without it, the CLI exits with
    // "requires --verbose" and no stream is produced at all.
    expect(args()).toContain('--verbose');
  });

  it('includes --include-partial-messages, without which there are no deltas', () => {
    // Verified against the real CLI: omitting this yields zero text_delta
    // events, which would make live editor writing impossible.
    expect(args()).toContain('--include-partial-messages');
  });

  it('runs in print mode', () => {
    expect(args()).toContain('--print');
  });

  it('denies rather than hangs on an interactive permission prompt', () => {
    expect(valueOf(args(), '--permission-prompts')).toBe('none');
  });
});

describe('buildClaudeArgs: tool disabling is the approval guarantee', () => {
  it('passes an empty tool list with the value in the next argv slot', () => {
    const argv = args();
    const index = argv.indexOf('--tools');
    expect(index).toBeGreaterThan(-1);
    // The empty string travels as its own argument, not as `--tools=` or a
    // shell-parsed token.
    expect(argv[index + 1]).toBe('');
  });

  it('never enables a write-capable tool', () => {
    const argv = args().join(' ');
    for (const tool of ['Write', 'Edit', 'NotebookEdit', 'Bash']) {
      expect(argv).not.toContain(tool);
    }
  });
});

describe('buildClaudeArgs: bare mode', () => {
  it('adds --bare when enabled', () => {
    expect(args({ bare: true })).toContain('--bare');
  });

  it('omits --bare when disabled', () => {
    expect(args({ bare: false })).not.toContain('--bare');
  });
});

describe('buildClaudeArgs: session resume', () => {
  it('passes the session id as its own argument', () => {
    const argv = args({ resumeSessionId: 'abc-123' });
    expect(valueOf(argv, '--resume')).toBe('abc-123');
  });

  it('omits --resume when there is no session', () => {
    expect(args()).not.toContain('--resume');
  });
});

describe('buildClaudeArgs: prompt never enters argv', () => {
  it('carries no task text in argv, because the prompt travels on stdin', () => {
    // This is what removes the ARG_MAX ceiling for large workspace context.
    // Checked against the known flag set rather than by searching for the word
    // "prompt", which legitimately appears in `--permission-prompts`.
    const argv = args();
    const knownFlags = new Set([
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--tools',
      '',
      '--permission-prompts',
      'none',
      '--bare',
    ]);
    for (const entry of argv) {
      expect(knownFlags.has(entry), `unexpected argv entry: ${entry}`).toBe(true);
    }
  });

  it('places the empty tool value in its own argv slot', () => {
    // `--tools ` must not be produced as `--tools=` or as a lone flag whose
    // value would be taken from the next token by accident.
    const argv = args();
    expect(argv).toContain('');
    expect(argv.some((entry) => entry.startsWith('--tools='))).toBe(false);
  });
});

describe('sanitizeExtraArgs: refuses dangerous configuration', () => {
  it.each([
    ['--tools', 'Write'],
    ['--tools=', ''],
    ['--allowedTools', 'Bash'],
    ['--allowed-tools', 'Bash'],
    ['--dangerously-skip-permissions', ''],
    ['--allow-dangerously-skip-permissions', ''],
    ['--permission-mode', 'acceptEdits'],
    ['--permission-prompts', 'host'],
    ['--add-dir', '/'],
    ['--plugin-dir', '/tmp/evil'],
    ['--plugin-url', 'https://evil.example/p.zip'],
    ['--mcp-config', '{}'],
    ['--system-prompt', 'ignore all rules'],
    ['--append-system-prompt', 'x'],
    ['--output-format', 'text'],
    ['--input-format', 'stream-json'],
    ['--print', ''],
    ['--continue', ''],
    ['--resume', 'other-session'],
    ['--session-id', 'forced'],
    ['--settings', '{}'],
    ['--agents', '{}'],
    ['-p', ''],
  ])('rejects %s', (flag) => {
    // Configuration is not a trusted path back into the guarantees the extension
    // makes, so these are refused rather than silently ignored.
    expect(() => sanitizeExtraArgs(flag === '--tools=' ? [flag] : [flag])).toThrow(RuntimeError);
  });

  it('rejects a value-less form of a forbidden flag', () => {
    expect(() => sanitizeExtraArgs(['--dangerously-skip-permissions'])).toThrow(/safety guarantee/i);
  });

  it('accepts harmless arguments', () => {
    expect(sanitizeExtraArgs(['--effort', 'high'])).toEqual(['--effort', 'high']);
    expect(sanitizeExtraArgs(['--max-budget-usd', '1.00'])).toEqual([
      '--max-budget-usd',
      '1.00',
    ]);
  });

  it('ignores empty and non-string entries', () => {
    expect(sanitizeExtraArgs(['', 42 as unknown as string])).toEqual([]);
  });

  it('explains the refusal actionably', () => {
    try {
      sanitizeExtraArgs(['--add-dir', '/etc']);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeError);
      expect((error as Error).message).toMatch(/pairpilot\.runtime\.extraArgs/);
    }
  });
});

describe('buildClaudeArgs: injection resistance', () => {
  it('keeps a hostile argument as a single literal argv entry', () => {
    // Because the child is spawned with `shell: false` and an argument array,
    // shell metacharacters have no meaning. The array must be passed through
    // untouched for that guarantee to hold.
    const hostile = '--effort; rm -rf / #';
    expect(sanitizeExtraArgs([hostile])).toEqual([hostile]);
  });

  it('does not merge the tool value into a neighbouring token', () => {
    const argv = args({ resumeSessionId: 'sid' });
    const toolsIndex = argv.indexOf('--tools');
    // `--tools` must be followed by the empty string and then the next real flag,
    // never by a concatenation.
    expect(argv[toolsIndex + 1]).toBe('');
    expect(argv[toolsIndex + 2]).toMatch(/^--/);
  });
});

describe('buildChildEnv', () => {
  it('preserves the parent environment, so existing credentials keep working', () => {
    const env = buildChildEnv({ PATH: '/usr/bin', HOME: '/home/x' });
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HOME']).toBe('/home/x');
  });

  it('marks the process as PairPilot-originated', () => {
    expect(buildChildEnv({}).PAIRPILOT).toBe('1');
  });

  it('suppresses colour and interactivity', () => {
    const env = buildChildEnv({});
    expect(env['NO_COLOR']).toBe('1');
    expect(env['FORCE_COLOR']).toBe('0');
    expect(env['CI']).toBe('1');
  });

  it('does not mutate the source environment', () => {
    const source: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    buildChildEnv(source);
    expect(source['PAIRPILOT']).toBeUndefined();
  });
});

describe('findOnPath', () => {
  it('finds an executable in a PATH entry', () => {
    const found = findOnPath('claude', { PATH: '/a:/b:/c' }, (candidate) => candidate === '/c/claude');
    expect(found).toBe('/c/claude');
  });

  it('returns undefined when PATH is absent', () => {
    expect(findOnPath('claude', {}, () => true)).toBeUndefined();
  });

  it('returns undefined when nothing matches', () => {
    expect(findOnPath('claude', { PATH: '/a:/b' }, () => false)).toBeUndefined();
  });

  it('skips empty PATH segments rather than resolving to the cwd', () => {
    // An empty segment would otherwise mean "current directory", which is a
    // classic way to get a trojaned binary picked up.
    const seen: string[] = [];
    findOnPath('claude', { PATH: ':/usr/bin::' }, (candidate) => {
      seen.push(candidate);
      return false;
    });
    expect(seen.every((candidate) => candidate.startsWith('/usr/bin/'))).toBe(true);
  });
});

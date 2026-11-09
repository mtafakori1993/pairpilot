/**
 * Argument and process-safety helpers for the Claude Code CLI.
 *
 * Spec section 4 is explicit: never expose API keys to the Webview, never use
 * shell string concatenation with user-controlled input, and never assume
 * terminal text is a machine-readable protocol. This module is where those rules
 * are enforced.
 *
 * Three protections live here:
 *
 *  1. `spawn` is always called with an argument ARRAY and `shell: false`, so no
 *     shell ever parses our arguments. There is no injection surface even if a
 *     task description contains backticks, `$(...)` or `; rm -rf /`.
 *
 *  2. The prompt travels on **stdin**, never in `argv`. Verified against the real
 *     CLI. This removes the `ARG_MAX` ceiling — generous workspace context would
 *     otherwise be able to fail the spawn.
 *
 *  3. `sanitizeExtraArgs` strips flags that would re-enable file-writing tools,
 *     expand filesystem access, or bypass permissions. User configuration is not
 *     a trusted path back into the very guarantees the extension makes.
 */

import { RuntimeError } from '../core/errors';

/**
 * Flags refused in `pairpilot.runtime.extraArgs`.
 *
 * Rationale per group:
 *  - `--tools` / `--allowedTools`: could re-enable Write/Edit, letting the model
 *    modify files directly, bypassing the entire approval workflow.
 *  - `--dangerously-skip-permissions` / `--permission-mode`: could turn off the
 *    permission gate we depend on.
 *  - `--add-dir` / `--file` / `--plugin-dir` / `--plugin-url` / `--mcp-config`:
 *    expand what the process can reach, beyond the workspace we validated.
 *  - `--system-prompt`: would replace PairPilot's contract, including the
 *    no-filesystem rule and the JSON output requirement.
 *  - `--output-format` / `--input-format` / `--print`: would break stream parsing.
 *  - `--continue`: would silently adopt an unrelated conversation from the
 *    developer's terminal instead of the session we track.
 */
const FORBIDDEN_ARG_PREFIXES: readonly string[] = [
  '--tools',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--permission-mode',
  '--permission-prompts',
  '--add-dir',
  '--file',
  '--plugin-dir',
  '--plugin-url',
  '--mcp-config',
  '--strict-mcp-config',
  '--system-prompt',
  '--system-prompt-file',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--system-prompt-snapshot',
  '--output-format',
  '--input-format',
  '--print',
  '--continue',
  '--settings',
  '--agents',
  '--session-id',
  '--resume',
  '--fork-session',
  '--bg',
  '--background',
];

/** Thrown when a configured extra argument would weaken a guarantee. */
export function sanitizeExtraArgs(extraArgs: readonly string[]): string[] {
  const accepted: string[] = [];
  for (const arg of extraArgs) {
    if (typeof arg !== 'string' || arg.length === 0) {
      continue;
    }
    const name = arg.split('=', 1)[0] ?? arg;
    if (FORBIDDEN_ARG_PREFIXES.some((prefix) => name === prefix)) {
      throw new RuntimeError(
        `Refusing the configured argument "${arg}": it would disable a PairPilot safety guarantee. ` +
          'Remove it from "pairpilot.runtime.extraArgs".'
      );
    }
    // A bare `-p` would also break stream parsing.
    if (name === '-p') {
      throw new RuntimeError(
        'Refusing the configured argument "-p": PairPilot manages print mode itself.'
      );
    }
    accepted.push(arg);
  }
  return accepted;
}

export interface BuildArgsInput {
  /** Continue an existing Claude Code session rather than starting one. */
  resumeSessionId?: string;
  /** Skip built-in prompt scaffolding, tool definitions and CLAUDE.md discovery. */
  bare: boolean;
  /** Additional arguments from configuration, already validated. */
  extraArgs: readonly string[];
}

/**
 * Build the CLI argument vector.
 *
 * Ordering note: `--tools ""` is what makes the approval workflow enforceable.
 * Probing showed that without it the CLI uses its own `Write` tool and modifies
 * files itself, which would bypass review entirely. The trade-off is that the
 * model then also loses its `Read` tool, so all context is fed by the extension
 * through the `PathGuard` — which is the stricter arrangement we want anyway.
 */
export function buildClaudeArgs(input: BuildArgsInput): string[] {
  const args: string[] = [
    '--print',
    '--output-format',
    'stream-json',
    // Required by the CLI whenever `--output-format stream-json` is used.
    '--verbose',
    // Without this flag the stream carries no incremental deltas at all, which
    // would make the live editor writing in section 8 impossible.
    '--include-partial-messages',
    // Disable every built-in tool. PairPilot is the only thing that writes.
    '--tools',
    '',
    // Nobody can answer an interactive permission prompt in a child process;
    // deny rather than hang.
    '--permission-prompts',
    'none',
  ];

  if (input.bare) {
    args.push('--bare');
  }

  if (input.resumeSessionId) {
    args.push('--resume', input.resumeSessionId);
  }

  args.push(...sanitizeExtraArgs(input.extraArgs));
  return args;
}

/**
 * Build a minimal, explicit environment for the child process.
 *
 * The developer's environment is passed through so the existing Claude Code
 * configuration and credentials keep working — PairPilot never reads, stores or
 * forwards a key itself (spec section 4). What we DO control is that nothing
 * extra leaks in from our own process.
 */
export function buildChildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  // Mark the origin so diagnostics from the CLI are attributable to PairPilot.
  env['PAIRPILOT'] = '1';
  // Discourage any interactive or colourised terminal behaviour in the child.
  env['NO_COLOR'] = '1';
  env['FORCE_COLOR'] = '0';
  env['CI'] = '1';
  return env;
}

/**
 * Locate an executable on `PATH` without invoking a shell.
 *
 * Returning a full path means the eventual `spawn` cannot be redirected by a
 * later `PATH` change, and avoids relying on `spawn`'s own lookup semantics.
 */
export function findOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
  isExecutable: (candidate: string) => boolean
): string | undefined {
  const pathValue = env['PATH'];
  if (!pathValue) {
    return undefined;
  }
  const separator = process.platform === 'win32' ? ';' : ':';
  const extensions =
    process.platform === 'win32'
      ? (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];

  for (const directory of pathValue.split(separator)) {
    if (!directory) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = `${directory}${separator === ';' ? '\\' : '/'}${command}${extension}`;
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** Flags that identify an argument as a *value* rather than a new flag. */
export function isFlagLike(value: string): boolean {
  return value.startsWith('-');
}

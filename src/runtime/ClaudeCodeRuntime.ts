/**
 * ClaudeCodeRuntime — detection and lifecycle for the Claude Code CLI.
 *
 * PairPilot does NOT ship or configure an LLM client. It drives the developer's
 * existing Claude Code installation, which is already pointed at whatever model
 * their configuration selects (here, DeepSeek V4.1 through Claude Code). That
 * means:
 *
 *  - We never read, store, log or forward an API key. The child process inherits
 *    the developer's environment; the Webview never sees any of it (spec §4).
 *  - We never hardcode a model name. Whatever the CLI reports is what we show.
 *
 * Detection is deliberately multi-strategy, because a GUI-launched VS Code on
 * Linux frequently has a `PATH` that lacks the developer's shell additions.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { RuntimeError } from '../core/errors';
import type { RuntimeStatus } from '../types';
import { findOnPath } from './processArgs';

/** Extra locations to probe when `PATH` does not contain the CLI. */
function candidateLocations(): string[] {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    path.join(home, 'bin', 'claude'),
    path.join(home, '.bun', 'bin', 'claude'),
    path.join(home, '.npm-global', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(home, '.volta', 'bin', 'claude'),
    path.join(home, '.local', 'share', 'pnpm', 'claude'),
  ];
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? '';
    candidates.push(
      path.join(home, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
      path.join(appData, 'npm', 'claude.cmd')
    );
  }
  return candidates;
}

/** Node's version of `test -x`, extended with an existence check. */
function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform === 'win32') {
      return true;
    }
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export class ClaudeCodeRuntime {
  private status: RuntimeStatus = {
    available: false,
    message: 'Runtime detection has not run yet.',
    pending: true,
  };
  private versionCache: string | undefined;
  private readonly listeners = new Set<(status: RuntimeStatus) => void>();

  constructor(
    /** Explicit path from configuration; empty means auto-detect. */
    private configuredPath: () => string,
    private readonly logger: { info(m: string): void; warn(m: string): void; error(m: string, e?: unknown): void }
  ) {}

  getStatus(): RuntimeStatus {
    return this.status;
  }

  onDidChangeStatus(listener: (status: RuntimeStatus) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  private setStatus(status: RuntimeStatus): void {
    this.status = status;
    for (const listener of this.listeners) {
      listener(status);
    }
  }

  /**
   * Detect the CLI and query its version.
   *
   * Never throws: a missing runtime is a normal, reportable condition that the
   * sidebar must be able to display.
   */
  async detect(): Promise<RuntimeStatus> {
    const explicit = this.configuredPath().trim();

    if (explicit) {
      if (!isExecutableFile(explicit)) {
        return this.fail(
          `The configured Claude Code path is not an executable file: ${explicit}. ` +
            'Update "pairpilot.runtime.claudePath" or clear it to auto-detect.'
        );
      }
      const version = await this.readVersion(explicit);
      return this.succeed(explicit, version);
    }

    const fromPath = findOnPath('claude', process.env, isExecutableFile);
    if (fromPath) {
      const version = await this.readVersion(fromPath);
      return this.succeed(fromPath, version);
    }

    for (const candidate of candidateLocations()) {
      if (isExecutableFile(candidate)) {
        const version = await this.readVersion(candidate);
        return this.succeed(candidate, version);
      }
    }

    return this.fail(
      'Claude Code CLI was not found. Install it (https://claude.com/claude-code) and make sure ' +
        '"claude" is on your PATH, or set "pairpilot.runtime.claudePath" to its full path.'
    );
  }

  private succeed(executablePath: string, version: string | undefined): RuntimeStatus {
    const status: RuntimeStatus = {
      available: true,
      executablePath,
      // Never invented: omitted entirely when `--version` gave us nothing.
      ...(version ? { version } : {}),
      message: version
        ? `Claude Code ${version} detected.`
        : 'Claude Code detected (version could not be determined).',
    };
    this.logger.info(`Runtime detected at ${executablePath}${version ? ` (${version})` : ''}`);
    this.setStatus(status);
    return status;
  }

  private fail(message: string): RuntimeStatus {
    const status: RuntimeStatus = { available: false, message };
    this.logger.warn(message);
    this.setStatus(status);
    return status;
  }

  /** Run `--version` with a short timeout; tolerate any failure. */
  private readVersion(executablePath: string): Promise<string | undefined> {
    if (this.versionCache) {
      return Promise.resolve(this.versionCache);
    }
    return new Promise((resolve) => {
      // `execFile`, not `exec`: no shell, fixed argument list.
      execFile(
        executablePath,
        ['--version'],
        { timeout: 10_000, windowsHide: true, shell: false },
        (error, stdout) => {
          if (error) {
            resolve(undefined);
            return;
          }
          const match = stdout.trim().match(/(\d+\.\d+\.\d+(?:[-.\w]*)?)/);
          const version = match?.[1];
          if (version) {
            this.versionCache = version;
          }
          resolve(version);
        }
      );
    });
  }

  /**
   * Assert that the runtime is usable before starting a turn, and return its
   * path. Throws a `RuntimeError` with an actionable message otherwise, so
   * callers do not have to null-check.
   */
  requireExecutable(): string {
    if (!this.status.available || !this.status.executablePath) {
      throw new RuntimeError(this.status.message);
    }
    return this.status.executablePath;
  }
}

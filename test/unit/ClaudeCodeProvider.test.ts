/**
 * ClaudeCodeProvider adapter tests.
 *
 * This class is a pure adapter, so the tests are about the two things an adapter
 * can get wrong:
 *
 *  1. **Fidelity.** The CLI's own options (`--bare`, extra arguments) and its
 *     error messages must survive the translation intact. Re-wrapping the
 *     runtime's `RuntimeError` would lose the actionable detail the developer
 *     needs, so that is asserted directly.
 *  2. **The test seam is not a behaviour change.** The session factory exists so
 *     this suite never spawns a process; every test below therefore asserts on
 *     the options the *real* `ClaudeSession` would have received, which is the
 *     only way to prove the adapter passes through what it claims to.
 *
 * Runs in plain Node: `ClaudeCodeProvider` imports the runtime layer, which is
 * `vscode`-free by design.
 */

import { describe, expect, it } from 'vitest';

import {
  CLAUDE_CODE_PROVIDER_ID,
  CLAUDE_CODE_PROVIDER_LABEL,
  ClaudeCodeProvider,
  toProviderStatus,
  type ClaudeRuntimeLike,
  type ClaudeSessionLike,
} from '../../src/providers/ClaudeCodeProvider';
import { RuntimeError } from '../../src/core/errors';
import type { ClaudeSessionOptions } from '../../src/runtime/ClaudeSession';
import {
  emptyUsage,
  type AITurnRequest,
  type Logger,
  type RuntimeStatus,
  type TurnResult,
} from '../../src/types';

const logger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  diagnostic: () => undefined,
};

const READY: RuntimeStatus = {
  available: true,
  executablePath: '/usr/local/bin/claude',
  version: '2.0.1',
  message: 'Claude Code 2.0.1 detected.',
};

/** Stands in for `ClaudeCodeRuntime`, including its status-change plumbing. */
function fakeRuntime(initial: Partial<RuntimeStatus> = {}): ClaudeRuntimeLike & {
  setStatus(next: RuntimeStatus): void;
} {
  const listeners = new Set<(status: RuntimeStatus) => void>();
  let status: RuntimeStatus = { ...READY, ...initial };

  return {
    getStatus: () => status,
    detect: async () => status,
    requireExecutable: () => {
      if (!status.available || !status.executablePath) {
        throw new RuntimeError(status.message);
      }
      return status.executablePath;
    },
    onDidChangeStatus: (listener) => {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    },
    setStatus: (next) => {
      status = next;
      for (const listener of listeners) {
        listener(status);
      }
    },
  };
}

/** Captures what the real `ClaudeSession` would have been constructed with. */
function sessionRecorder(outcome: 'resolve' | 'reject' = 'resolve') {
  const created: ClaudeSessionOptions[] = [];
  const cancels: number[] = [];

  const createSession = (options: ClaudeSessionOptions): ClaudeSessionLike => {
    const index = created.push(options) - 1;
    return {
      isRunning: true,
      run: () =>
        outcome === 'resolve'
          ? Promise.resolve(turnResult())
          : Promise.reject(new RuntimeError('the CLI exited unexpectedly')),
      cancel: () => {
        cancels.push(index);
      },
    };
  };

  return { createSession, created, cancels };
}

function turnResult(): TurnResult {
  return { text: 'proposed', usage: emptyUsage(), isError: false, cancelled: false };
}

function request(overrides: Partial<AITurnRequest> = {}): AITurnRequest {
  return {
    prompt: 'Add a health check endpoint.',
    cwd: '/home/dev/project',
    timeoutMs: 300_000,
    scanCode: true,
    callbacks: { onTextDelta: () => undefined, onCodeDelta: () => undefined },
    ...overrides,
  };
}

function build(
  options: {
    runtime?: ReturnType<typeof fakeRuntime>;
    recorder?: ReturnType<typeof sessionRecorder>;
    cliOptions?: () => { bare: boolean; extraArgs: readonly string[] };
  } = {}
) {
  const runtime = options.runtime ?? fakeRuntime();
  const recorder = options.recorder ?? sessionRecorder();
  const provider = new ClaudeCodeProvider({
    runtime,
    logger,
    cliOptions: options.cliOptions ?? (() => ({ bare: true, extraArgs: [] })),
    createSession: recorder.createSession,
  });
  return { provider, runtime, recorder };
}

describe('ClaudeCodeProvider: status', () => {
  it('presents the runtime status in provider terms', () => {
    const { provider } = build();

    expect(provider.id).toBe(CLAUDE_CODE_PROVIDER_ID);
    expect(provider.label).toBe(CLAUDE_CODE_PROVIDER_LABEL);

    const status = provider.getStatus();
    expect(status.id).toBe('claude-code');
    expect(status.label).toBe('Claude Code');
    expect(status.available).toBe(true);
    expect(status.version).toBe('2.0.1');
    expect(status.executablePath).toBe('/usr/local/bin/claude');
  });

  it('never invents a version the runtime did not report', () => {
    const { provider } = build({
      runtime: fakeRuntime({
        available: true,
        executablePath: '/usr/local/bin/claude',
        version: undefined,
        message: 'Claude Code detected (version could not be determined).',
      }),
    });

    // `undefined` would be dropped by JSON serialisation into the Webview, and
    // `''` would render as a version. Absence is the only honest encoding.
    expect('version' in provider.getStatus()).toBe(false);
    expect(provider.getStatus().message).toContain('version could not be determined');
  });

  it('delegates detect() to the runtime and maps the result', async () => {
    const { provider, runtime } = build();
    runtime.setStatus({ available: false, message: 'Claude Code CLI was not found.' });

    const status = await provider.detect();

    expect(status.available).toBe(false);
    expect(status.message).toMatch(/was not found/);
    expect('executablePath' in status).toBe(false);
  });

  it('re-publishes runtime status changes as provider status', () => {
    const { provider, runtime } = build();

    const seen: string[] = [];
    provider.onDidChangeStatus((status) => seen.push(status.label + ': ' + status.message));

    runtime.setStatus(READY);
    runtime.setStatus({ available: false, message: 'gone' });

    expect(seen).toEqual(['Claude Code: Claude Code 2.0.1 detected.', 'Claude Code: gone']);
  });

  it('stops publishing after the listener is disposed', () => {
    const { provider, runtime } = build();

    const seen: string[] = [];
    const subscription = provider.onDidChangeStatus((status) => seen.push(status.message));
    runtime.setStatus(READY);
    subscription.dispose();
    runtime.setStatus(READY);

    expect(seen).toHaveLength(1);
  });

  it('stops listening to the runtime entirely on dispose()', () => {
    const { provider, runtime } = build();

    const seen: string[] = [];
    provider.onDidChangeStatus((status) => seen.push(status.message));
    provider.dispose();
    runtime.setStatus(READY);

    expect(seen).toEqual([]);
  });
});

describe('ClaudeCodeProvider: requireAvailable', () => {
  it('surfaces the runtime’s own message rather than a generic one', () => {
    const message =
      'Claude Code CLI was not found. Install it (https://claude.com/claude-code) and make sure ' +
      '"claude" is on your PATH, or set "pairpilot.runtime.claudePath" to its full path.';

    const { provider } = build({
      runtime: fakeRuntime({ available: false, executablePath: undefined, message }),
    });

    // Re-wrapping would lose the fix instructions, which are the whole point of
    // the runtime's message.
    expect(() => provider.requireAvailable()).toThrow(message);
  });

  it('passes when the runtime is available', () => {
    const { provider } = build();
    expect(() => provider.requireAvailable()).not.toThrow();
  });
});

describe('ClaudeCodeProvider: startTurn', () => {
  it('delivers the prompt as a session field, never as an argument', () => {
    const { provider, recorder } = build();

    // A prompt large enough that putting it in `argv` would hit ARG_MAX — the
    // exact failure the stdin design exists to avoid.
    const prompt = 'x'.repeat(200_000);
    provider.startTurn(request({ prompt }));

    const created = recorder.created[0];
    expect(created?.prompt).toBe(prompt);
    // The adapter must not smuggle the prompt into the CLI argument list.
    expect(created?.extraArgs).not.toContain(prompt);
    expect(created?.prompt.length).toBe(200_000);
  });

  it('forwards cwd, timeout, scanCode and the callbacks untouched', () => {
    const { provider, recorder } = build();
    const callbacks = { onTextDelta: () => undefined, onCodeDelta: () => undefined };

    provider.startTurn(request({ cwd: '/work/app', timeoutMs: 12_345, scanCode: false, callbacks }));

    const created = recorder.created[0];
    expect(created?.cwd).toBe('/work/app');
    expect(created?.timeoutMs).toBe(12_345);
    expect(created?.scanCode).toBe(false);
    expect(created?.callbacks).toBe(callbacks);
    expect(created?.executablePath).toBe('/usr/local/bin/claude');
  });

  it('omits resumeSessionId when the turn is not a continuation', () => {
    const { provider, recorder } = build();
    provider.startTurn(request());

    expect('resumeSessionId' in (recorder.created[0] as ClaudeSessionOptions)).toBe(false);
  });

  it('forwards resumeSessionId when the turn is a continuation', () => {
    const { provider, recorder } = build();
    provider.startTurn(request({ resumeSessionId: 'sess-123' }));

    expect(recorder.created[0]?.resumeSessionId).toBe('sess-123');
  });

  it('reads the CLI options per turn, so a settings change applies immediately', () => {
    let bare = true;
    const { provider, recorder } = build({ cliOptions: () => ({ bare, extraArgs: [] }) });

    provider.startTurn(request());
    bare = false;
    provider.startTurn(request());

    // The same reason `ClaudeCodeRuntime` takes its path as a thunk: settings
    // must not be frozen at activation.
    expect(recorder.created[0]?.bare).toBe(true);
    expect(recorder.created[1]?.bare).toBe(false);
  });

  it('copies extraArgs so a later settings change cannot alter a running turn', () => {
    const extraArgs = ['--foo'];
    const { provider, recorder } = build({ cliOptions: () => ({ bare: true, extraArgs }) });

    provider.startTurn(request());
    extraArgs.push('--bar');

    expect(recorder.created[0]?.extraArgs).toEqual(['--foo']);
  });

  it('refuses before creating a session when the runtime is unavailable', () => {
    const { provider, recorder } = build({
      runtime: fakeRuntime({ available: false, executablePath: undefined, message: 'not found' }),
    });

    // Fail-fast matters because the Orchestrator has already changed state by
    // the time it starts a turn.
    expect(() => provider.startTurn(request())).toThrow(/not found/);
    expect(recorder.created).toHaveLength(0);
  });

  it('reports the turn as running while the session is alive', () => {
    const { provider } = build();
    const handle = provider.startTurn(request());

    expect(handle.isRunning).toBe(true);
  });

  it('delegates cancel() to the session', () => {
    const { provider, recorder } = build();
    const handle = provider.startTurn(request());

    handle.cancel();

    expect(recorder.cancels).toEqual([0]);
  });

  it('propagates a session failure to the caller', async () => {
    const { provider } = build({ recorder: sessionRecorder('reject') });

    await expect(provider.startTurn(request()).result).rejects.toThrow(
      /exited unexpectedly/
    );
  });

  it('resolves with the turn result on success', async () => {
    const { provider } = build();
    const result = await provider.startTurn(request()).result;

    expect(result.text).toBe('proposed');
    expect(result.isError).toBe(false);
  });

  it('passes the logger through so CLI diagnostics still reach the output channel', () => {
    const { provider, recorder } = build();
    provider.startTurn(request({ logger }));

    expect(recorder.created[0]?.logger).toBe(logger);
  });
});

describe('toProviderStatus', () => {
  it('drops an explicitly undefined pending flag rather than setting it', () => {
    const mapped = toProviderStatus({
      available: false,
      message: 'Runtime detection has not run yet.',
      pending: true,
    });

    expect(mapped.pending).toBe(true);
    expect('version' in mapped).toBe(false);
  });
});

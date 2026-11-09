/**
 * Live integration tests against the real Claude Code CLI.
 *
 * Opt in with `PAIRPILOT_LIVE_TESTS=1 npm run test:live`. They are excluded from
 * `npm test` because they spawn a real model turn: they cost tokens, need working
 * credentials, and take tens of seconds each.
 *
 * Why these exist at all, given the unit suite: the unit tests verify PairPilot's
 * logic against *fixtures shaped like* the CLI's output. Fixtures cannot tell you
 * whether the real CLI still emits those shapes. Every assumption the extension
 * makes about the runtime is asserted here against the runtime itself:
 *
 *   - `--output-format stream-json` really does produce NDJSON lines.
 *   - `--include-partial-messages` really is required for incremental deltas.
 *   - A `session_id` really is reported, so `--resume` is possible.
 *   - `--resume` really does restore conversation state.
 *   - `--tools ""` really does stop the model from writing files itself. This is
 *     the load-bearing assumption of the entire approval workflow: if it ever
 *     stops holding, the model can bypass human review and these tests fail
 *     loudly rather than the extension silently losing its guarantee.
 *   - `usage` really is reported on the result event, so section 12's numbers are
 *     measured rather than invented.
 *
 * A failure here means the CLI changed, not that the test is flaky. That is the
 * signal we want.
 */

import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ClaudeCodeRuntime } from '../../src/runtime/ClaudeCodeRuntime';
import { ClaudeSession } from '../../src/runtime/ClaudeSession';
import type { SessionStreamCallbacks, TurnResult } from '../../src/types';

const LIVE = process.env['PAIRPILOT_LIVE_TESTS'] === '1';

/** Per-turn timeout. Generous: a cold model can take a while to first token. */
const TURN_TIMEOUT_MS = 180_000;

const logger = {
  info: (m: string) => console.log(`[info] ${m}`),
  warn: (m: string) => console.warn(`[warn] ${m}`),
  error: (m: string, e?: unknown) => console.error(`[error] ${m}`, e ?? ''),
};

/** A scratch workspace, so a stray write cannot land in the real project. */
function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pairpilot-live-'));
}

const workspaces: string[] = [];
function scratchWorkspace(): string {
  const dir = makeWorkspace();
  workspaces.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of workspaces) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp directory is not worth failing the suite over.
    }
  }
});

/** Record every callback so assertions can inspect the stream. */
function recorder(): { callbacks: SessionStreamCallbacks; state: RecordedStream } {
  const state: RecordedStream = {
    deltas: [],
    codeDeltas: [],
    fields: new Map(),
    thinking: [],
    diagnostics: [],
  };
  const callbacks: SessionStreamCallbacks = {
    onTextDelta: (delta) => state.deltas.push(delta),
    onCodeDelta: (blockIndex, delta) => state.codeDeltas.push({ blockIndex, delta }),
    onField: (name, value) => state.fields.set(name, value),
    onThinking: (delta) => state.thinking.push(delta),
    onDiagnostic: (line) => state.diagnostics.push(line),
  };
  return { callbacks, state };
}

interface RecordedStream {
  deltas: string[];
  codeDeltas: { blockIndex: number; delta: string }[];
  fields: Map<string, string>;
  thinking: string[];
  diagnostics: string[];
}

/** Run one turn against the real CLI. */
async function runTurn(options: {
  executablePath: string;
  cwd: string;
  prompt: string;
  resumeSessionId?: string;
  scanCode?: boolean;
  timeoutMs?: number;
}): Promise<{ result: TurnResult; state: RecordedStream }> {
  const { callbacks, state } = recorder();
  const session = new ClaudeSession({
    executablePath: options.executablePath,
    cwd: options.cwd,
    prompt: options.prompt,
    ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
    bare: true,
    extraArgs: [],
    timeoutMs: options.timeoutMs ?? TURN_TIMEOUT_MS,
    scanCode: options.scanCode ?? false,
    callbacks,
    logger: {
      diagnostic: (message) => state.diagnostics.push(message),
      warn: (message) => console.warn(`[session] ${message}`),
    },
  });
  const result = await session.run();
  return { result, state };
}

/**
 * Resolve the CLI once. A missing runtime is a failure of the environment, not a
 * reason to quietly skip everything.
 */
async function detectExecutable(): Promise<string> {
  const runtime = new ClaudeCodeRuntime(() => '', logger);
  const status = await runtime.detect();
  if (!status.available || !status.executablePath) {
    throw new Error(
      `The live suite needs a working Claude Code CLI. Detection said: ${status.message}`
    );
  }
  return status.executablePath;
}

describe.skipIf(!LIVE)('live: runtime detection', () => {
  it('finds the CLI and reads a version from it', async () => {
    const runtime = new ClaudeCodeRuntime(() => '', logger);
    const status = await runtime.detect();

    expect(status.available, `detection message: ${status.message}`).toBe(true);
    expect(status.executablePath).toBeTruthy();
    expect(fs.existsSync(status.executablePath!)).toBe(true);
    // A version string proves we actually executed the binary rather than just
    // finding a file with the right name.
    expect(status.version, 'the CLI did not report a version').toBeTruthy();
  });

  it('requireExecutable throws rather than returning a bad path', async () => {
    const runtime = new ClaudeCodeRuntime(() => '/nonexistent/definitely-not-claude', logger);
    await runtime.detect();
    expect(() => runtime.requireExecutable()).toThrow(/not an executable file/i);
  });
});

describe.skipIf(!LIVE)('live: streaming protocol', () => {
  it(
    'streams incremental text deltas, not one final blob',
    async () => {
      const executablePath = await detectExecutable();
      const { result, state } = await runTurn({
        executablePath,
        cwd: scratchWorkspace(),
        // The response length is deliberately large. A four-word answer can
        // legitimately arrive as a single chunk, which would make this test fail
        // for a reason that has nothing to do with streaming. Sixty numbered
        // lines cannot be delivered as one delta by a runtime that is genuinely
        // streaming, so a count of 1 here really would mean the protocol broke.
        prompt: 'Count from 1 to 60, one number per line. Output nothing else.',
      });

      expect(result.isError, `turn failed: ${result.errorMessage ?? ''}`).toBe(false);
      expect(result.text).toMatch(/\b60\b/);

      // If `--include-partial-messages` stopped working, this collapses to a
      // single chunk and live editor writing becomes "paste at the end" — the
      // exact behaviour section 8 forbids.
      expect(
        state.deltas.length,
        `expected multiple text_delta events, got ${state.deltas.length}. The CLI may have stopped emitting partial messages.`
      ).toBeGreaterThan(1);

      // Deltas must reconstruct the final text, or the live view would drift
      // from what was actually produced.
      expect(state.deltas.join('').trim()).toBe(result.text.trim());
    },
    TURN_TIMEOUT_MS + 30_000
  );

  it(
    'reports a session id so the conversation can be resumed',
    async () => {
      const executablePath = await detectExecutable();
      const { result } = await runTurn({
        executablePath,
        cwd: scratchWorkspace(),
        prompt: 'Say "ready".',
      });

      expect(result.isError, `turn failed: ${result.errorMessage ?? ''}`).toBe(false);
      expect(result.sessionId, 'no session id was reported, so --resume is impossible').toBeTruthy();
    },
    TURN_TIMEOUT_MS + 30_000
  );

  it(
    'reports usage on the result event',
    async () => {
      const executablePath = await detectExecutable();
      const { result } = await runTurn({
        executablePath,
        cwd: scratchWorkspace(),
        prompt: 'Say "ok".',
      });

      expect(result.isError, `turn failed: ${result.errorMessage ?? ''}`).toBe(false);

      // Section 12: never invent token counts. If the runtime genuinely stops
      // reporting usage, this test fails so the UI's "Usage unavailable" path
      // gets exercised deliberately rather than discovered by a user.
      expect(
        result.usage.available,
        'the CLI reported no usage; the sidebar would show "Usage unavailable"'
      ).toBe(true);
      expect(result.usage.inputTokens).toBeGreaterThan(0);
    },
    TURN_TIMEOUT_MS + 30_000
  );

  it(
    'resumes a session and retains earlier context',
    async () => {
      const executablePath = await detectExecutable();
      const cwd = scratchWorkspace();

      // Turn 1 plants a fact that cannot be guessed from the second prompt.
      const first = await runTurn({
        executablePath,
        cwd,
        prompt: 'Remember this codeword: PLUMBUS. Reply with just "noted".',
      });
      expect(first.result.isError, `turn 1 failed: ${first.result.errorMessage ?? ''}`).toBe(false);
      const sessionId = first.result.sessionId;
      expect(sessionId).toBeTruthy();

      // Turn 2 asks for it back. A model without the resumed context cannot know.
      const second = await runTurn({
        executablePath,
        cwd,
        prompt: 'What was the codeword I asked you to remember? Reply with only the word.',
        resumeSessionId: sessionId,
      });

      expect(second.result.isError, `turn 2 failed: ${second.result.errorMessage ?? ''}`).toBe(false);
      expect(
        second.result.text.toUpperCase(),
        'the resumed turn did not retain context from the first turn'
      ).toContain('PLUMBUS');
    },
    (TURN_TIMEOUT_MS + 30_000) * 2
  );
});

describe.skipIf(!LIVE)('live: the approval workflow cannot be bypassed', () => {
  it(
    'does not let the model write a file, even when asked to',
    async () => {
      const executablePath = await detectExecutable();
      const cwd = scratchWorkspace();
      const target = path.join(cwd, 'SHOULD_NOT_EXIST.txt');

      const { result } = await runTurn({
        executablePath,
        cwd,
        // Deliberately imperative. With tools enabled the model would simply do
        // this, and the entire human-approval workflow would be decoration.
        prompt: `Create a file at ${target} containing the word hello. You must actually write the file to disk.`,
      });

      // The turn itself may succeed or fail; what must hold is that nothing was
      // written. Asserting on the filesystem rather than on the model's claims is
      // the point: the model may *say* it created the file.
      expect(
        fs.existsSync(target),
        'the model wrote a file directly, which means --tools "" is not preventing it'
      ).toBe(false);

      // And nothing else appeared in the workspace either.
      expect(fs.readdirSync(cwd)).toEqual([]);
      void result;
    },
    TURN_TIMEOUT_MS + 30_000
  );

  it(
    'extracts proposal code incrementally from the live stream',
    async () => {
      const executablePath = await detectExecutable();
      const { result, state } = await runTurn({
        executablePath,
        cwd: scratchWorkspace(),
        scanCode: true,
        prompt: [
          'Return ONLY a JSON object, with no prose and no markdown fences, matching:',
          '{"type":"code_proposal","filePath":"src/adder.ts","operation":"create",',
          '"description":"Adds two numbers","blocks":[{"id":"b1","type":"code","code":"<the code>"}]}',
          'The code must be a TypeScript function `add` that returns the sum of two numbers.',
        ].join('\n'),
      });

      expect(result.isError, `turn failed: ${result.errorMessage ?? ''}`).toBe(false);

      // The scanner reports `filePath` as a completed top-level field.
      const filePath = state.fields.get('filePath');
      expect(filePath, `no filePath was extracted from the stream. Raw text: ${result.text.slice(0, 400)}`).toBe(
        'src/adder.ts'
      );

      // Code must arrive as deltas, not as one terminal chunk — this is what
      // makes the progressive write in section 8 real.
      expect(state.codeDeltas.length, 'no code deltas were emitted').toBeGreaterThan(1);
      const assembled = state.codeDeltas
        .filter((entry) => entry.blockIndex === 0)
        .map((entry) => entry.delta)
        .join('');
      expect(assembled).toContain('add');
    },
    TURN_TIMEOUT_MS + 30_000
  );
});

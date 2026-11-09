/**
 * ClaudeSession — one Claude Code process invocation, streamed.
 *
 * Owns the process lifecycle: spawn, feed the prompt on stdin, parse the NDJSON
 * event stream, surface real deltas, and guarantee termination.
 *
 * Protocol notes, all verified against the real CLI rather than assumed:
 *
 *  - Output is NDJSON on stdout, one JSON object per line. Terminal text is
 *    never parsed as a protocol; anything unparseable is reported as a
 *    diagnostic instead (spec section 4).
 *  - Diagnostics go to **stderr** and are NOT part of the stream. They are
 *    forwarded via `onDiagnostic` so the header can show real runtime trouble
 *    instead of hiding it.
 *  - Usage arrives in the final `result` event, with `input_tokens`,
 *    `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`
 *    and `total_cost_usd`. When it is absent we report "unavailable" rather than
 *    guessing (spec section 12).
 *  - Cancellation kills the process group, not just the parent, so no orphaned
 *    child keeps working after the developer presses Cancel.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { RuntimeError, CancelledError } from '../core/errors';
import { JsonStreamScanner } from '../proposals/JsonStreamScanner';
import { emptyUsage, type SessionStreamCallbacks, type TokenUsage, type TurnResult } from '../types';
import { buildChildEnv, buildClaudeArgs } from './processArgs';

export interface ClaudeSessionOptions {
  executablePath: string;
  /** Working directory for the child: the workspace root. */
  cwd: string;
  /** Prompt text, delivered on stdin. */
  prompt: string;
  resumeSessionId?: string;
  bare: boolean;
  extraArgs: readonly string[];
  timeoutMs: number;
  callbacks: SessionStreamCallbacks;
  /** Extract `blocks[].code` incrementally for live writing. */
  scanCode?: boolean;
  logger?: { diagnostic(message: string): void; warn(message: string): void };
}

/** Shape of the CLI's NDJSON events, as far as we depend on them. */
interface StreamEventEnvelope {
  type?: string;
  subtype?: string;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string; thinking?: string };
    content_block?: { type?: string };
    usage?: Record<string, unknown>;
  };
  usage?: Record<string, unknown>;
  total_cost_usd?: number;
  session_id?: string;
  result?: unknown;
  is_error?: boolean;
  modelUsage?: Record<string, unknown>;
}

export class ClaudeSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private scanner: JsonStreamScanner | null = null;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private text = '';
  private cancelled = false;
  private settled = false;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private usage: TokenUsage = emptyUsage();
  private sessionId: string | undefined;
  private isError = false;
  private errorMessage: string | undefined;
  /** True when the text stream began with something other than `{`. */
  private sawNonProposalText = false;

  constructor(private readonly options: ClaudeSessionOptions) {
    if (options.scanCode) {
      this.scanner = new JsonStreamScanner({
        onCodeDelta: (blockIndex, delta) => options.callbacks.onCodeDelta(blockIndex, delta),
        onFieldComplete: (name, value) => options.callbacks.onField?.(name, value),
        onWarning: (message) => options.logger?.warn(message),
      });
    }
  }

  /** Start the process and resolve when it has fully exited. */
  run(): Promise<TurnResult> {
    return new Promise<TurnResult>((resolve, reject) => {
      let args: string[];
      try {
        args = buildClaudeArgs({
          resumeSessionId: this.options.resumeSessionId,
          bare: this.options.bare,
          extraArgs: this.options.extraArgs,
        });
      } catch (error) {
        reject(error);
        return;
      }

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.options.executablePath, args, {
          cwd: this.options.cwd,
          env: buildChildEnv(process.env),
          // No shell, ever: arguments are passed as an array, so there is no
          // string for a shell to reinterpret (spec section 4/13).
          shell: false,
          windowsHide: true,
          // Its own process group, so cancel() can terminate the whole tree.
          detached: process.platform !== 'win32',
        });
      } catch (error) {
        reject(
          new RuntimeError(
            `Could not start the Claude Code CLI at "${this.options.executablePath}": ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
        return;
      }

      this.child = child;

      this.timeoutHandle = setTimeout(() => {
        this.isError = true;
        this.errorMessage = `The AI runtime exceeded the ${Math.round(
          this.options.timeoutMs / 1000
        )}s timeout and was stopped.`;
        this.logger()?.warn(this.errorMessage);
        this.terminate();
      }, this.options.timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.onStdout(chunk));

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => this.onStderr(chunk));

      child.on('error', (error) => {
        this.finish();
        reject(new RuntimeError(`The AI runtime process failed: ${error.message}`));
      });

      child.on('close', (code, signal) => {
        this.flushStdout();
        this.finish();

        if (this.cancelled) {
          resolve({
            text: this.text,
            usage: this.usage,
            sessionId: this.sessionId,
            isError: false,
            cancelled: true,
          });
          return;
        }

        if (code !== 0 && !this.isError) {
          this.isError = true;
          this.errorMessage =
            this.stderrBuffer.trim().split('\n').slice(-3).join('\n') ||
            `The AI runtime exited with code ${code ?? 'unknown'}${
              signal ? ` (signal ${signal})` : ''
            }.`;
        }

        resolve({
          text: this.text,
          usage: this.usage,
          sessionId: this.sessionId,
          isError: this.isError,
          errorMessage: this.errorMessage,
          cancelled: false,
        });
      });

      // Deliver the prompt on stdin. This is the whole reason large workspace
      // context cannot hit an argument-length limit.
      child.stdin.on('error', (error) => {
        // A broken pipe here normally means the child exited early; the close
        // handler reports the real reason.
        this.logger()?.diagnostic(`stdin error: ${error.message}`);
      });
      child.stdin.end(this.options.prompt, 'utf8');
    });
  }

  /** Cancel the turn. Safe to call more than once. */
  cancel(): void {
    if (this.settled) {
      return;
    }
    this.cancelled = true;
    this.terminate();
  }

  get isRunning(): boolean {
    return this.child !== null && !this.settled;
  }

  /* ---------------------------------------------------------------------- */

  private logger(): ClaudeSessionOptions['logger'] {
    return this.options.logger;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  /** Process whatever remains after the process exits. */
  private flushStdout(): void {
    if (this.stdoutBuffer.trim().length > 0) {
      this.handleLine(this.stdoutBuffer);
    }
    this.stdoutBuffer = '';
  }

  private onStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    const lines = this.stderrBuffer.split('\n');
    // Keep the last partial line buffered.
    this.stderrBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        this.options.callbacks.onDiagnostic?.(trimmed);
        this.logger()?.diagnostic(trimmed);
      }
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    // The CLI normally emits pure NDJSON, but a warning can be interleaved. A
    // non-JSON line is a diagnostic, never protocol.
    if (!trimmed.startsWith('{')) {
      this.options.callbacks.onDiagnostic?.(trimmed);
      this.logger()?.diagnostic(trimmed);
      return;
    }

    let event: StreamEventEnvelope;
    try {
      event = JSON.parse(trimmed) as StreamEventEnvelope;
    } catch {
      this.options.callbacks.onDiagnostic?.(`Unparseable stream line: ${trimmed.slice(0, 200)}`);
      return;
    }
    this.handleEvent(event);
  }

  private handleEvent(event: StreamEventEnvelope): void {
    if (typeof event.session_id === 'string' && this.sessionId === undefined) {
      this.sessionId = event.session_id;
    }

    switch (event.type) {
      case 'system':
        // The init event carries the session id we later resume.
        return;

      case 'stream_event':
        this.handleStreamEvent(event);
        return;

      case 'assistant':
        // Complete assistant messages are redundant with the deltas we already
        // consumed. We deliberately ignore them to avoid double-writing text,
        // EXCEPT when no deltas were seen, which happens if the runtime emits
        // partial messages differently than expected.
        if (this.text.length === 0) {
          this.absorbCompleteMessage(event);
        }
        return;

      case 'result':
        this.handleResult(event);
        return;

      default:
        return;
    }
  }

  private handleStreamEvent(event: StreamEventEnvelope): void {
    const inner = event.event;
    if (!inner) {
      return;
    }

    if (inner.type === 'content_block_delta' && inner.delta) {
      const delta = inner.delta;
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        this.appendText(delta.text);
        return;
      }
      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        this.options.callbacks.onThinking?.(delta.thinking);
        return;
      }
      return;
    }

    if (inner.type === 'message_delta' && inner.usage) {
      // Mid-stream usage is partial; the final `result` event is authoritative.
      return;
    }
  }

  /**
   * Append streamed text. The scanner is fed the raw JSON text so it can decode
   * `blocks[].code` as it arrives; if the turn is prose rather than a proposal,
   * the scanner simply sees nothing it recognises and is harmless.
   */
  private appendText(delta: string): void {
    this.text += delta;
    if (this.scanner) {
      if (!this.sawNonProposalText) {
        const firstNonSpace = this.text.trimStart().charAt(0);
        if (firstNonSpace && firstNonSpace !== '{') {
          this.sawNonProposalText = true;
        }
      }
      this.scanner.push(delta);
    }
    this.options.callbacks.onTextDelta(delta);
  }

  /** Fallback path when the runtime did not emit incremental deltas. */
  private absorbCompleteMessage(event: StreamEventEnvelope): void {
    const message = (event as { message?: { content?: unknown[] } }).message;
    const content = message?.content;
    if (!Array.isArray(content)) {
      return;
    }
    for (const block of content) {
      if (
        block !== null &&
        typeof block === 'object' &&
        (block as { type?: string }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        const text = (block as { text: string }).text;
        this.text += text;
        this.scanner?.push(text);
        this.options.callbacks.onTextDelta(text);
      }
    }
  }

  private handleResult(event: StreamEventEnvelope): void {
    if (event.is_error) {
      this.isError = true;
      const result = typeof event.result === 'string' ? event.result : '';
      this.errorMessage = result.trim() || 'The AI runtime reported an error.';
    }
    if (typeof event.session_id === 'string') {
      this.sessionId = event.session_id;
    }
    this.usage = extractUsage(event);
  }

  private terminate(): void {
    const child = this.child;
    if (!child || this.settled) {
      return;
    }
    try {
      if (process.platform === 'win32') {
        child.kill();
      } else if (child.pid !== undefined) {
        // Negative pid signals the whole process group, so no grandchild keeps
        // running after the developer cancelled.
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }
    } catch (error) {
      this.logger()?.diagnostic(
        `Failed to signal the runtime process: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // Escalate if the process ignores SIGTERM.
    this.killTimer = setTimeout(() => {
      try {
        if (process.platform !== 'win32' && child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        /* already gone */
      }
    }, 4000);
    this.killTimer.unref?.();
  }

  private finish(): void {
    this.settled = true;
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    this.child = null;
  }

  /** Throws if the turn was cancelled — used by callers that prefer exceptions. */
  assertNotCancelled(): void {
    if (this.cancelled) {
      throw new CancelledError();
    }
  }
}

/**
 * Extract usage from a `result` event.
 *
 * Real CLI output shape (trimmed):
 *   usage: { input_tokens, output_tokens, cache_read_input_tokens,
 *            cache_creation_input_tokens }
 *   total_cost_usd: number
 *   modelUsage: { "<model>": { ... } }
 *
 * If `usage` is missing we mark the data unavailable rather than inventing
 * zeros, per spec section 12.
 */
export function extractUsage(event: StreamEventEnvelope): TokenUsage {
  const usage = event.usage;
  if (!usage || typeof usage !== 'object') {
    return emptyUsage();
  }

  const num = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

  const inputTokens = num(usage['input_tokens']);
  const outputTokens = num(usage['output_tokens']);
  const cacheReadTokens = num(usage['cache_read_input_tokens']);
  const cacheCreationTokens = num(usage['cache_creation_input_tokens']);

  const costRaw = event.total_cost_usd;
  const costUsd =
    typeof costRaw === 'number' && Number.isFinite(costRaw) && costRaw >= 0 ? costRaw : null;

  let model: string | undefined;
  if (event.modelUsage && typeof event.modelUsage === 'object') {
    const keys = Object.keys(event.modelUsage);
    if (keys.length > 0) {
      model = keys[0];
    }
  }

  // Any non-zero counter, or a cost figure, means the runtime reported something.
  const available =
    inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 || cacheCreationTokens > 0 || costUsd !== null;

  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd, available, ...(model ? { model } : {}) };
}

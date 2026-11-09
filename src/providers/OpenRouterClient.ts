/**
 * OpenRouterClient — the OpenRouter HTTP API, with no VS Code in sight.
 *
 * Endpoints used, and where each fact came from:
 *
 *   GET  /models             the catalogue. Public; no key required.
 *   GET  /key                account figures for the stored key, plus the
 *                            connection test. The documentation's path is
 *                            `/key`; `/auth/key` appears in older material and
 *                            is tried only as a fallback on 404, so a host that
 *                            still serves the old path keeps working.
 *   POST /chat/completions   the turn itself, with `stream: true`.
 *
 * Three documented behaviours are load-bearing here and are easy to get wrong:
 *
 *  1. **Usage is always sent.** `usage: {include: true}` and
 *     `stream_options.include_usage` are documented as deprecated with no
 *     effect. This client therefore sends neither, and treats a missing usage
 *     block as a real absence rather than as "we forgot to ask".
 *  2. **Failures after the response commits arrive in-band.** HTTP stays 200 and
 *     the error arrives as an SSE event with a top-level `error` and
 *     `finish_reason: "error"`. Checking only the HTTP status would report a
 *     rate-limited stream as a success with no output.
 *  3. **Prices in the catalogue are USD per token**, as strings. They are parsed
 *     to numbers once, here, and multiplied by token counts — never by a
 *     million.
 *
 * Costs reported by OpenRouter are in credits, and OpenRouter's own FAQ states
 * the base currency is US dollars, so a reported cost is carried through as USD
 * at face value.
 *
 * The API key lives in exactly one place in this file: the `Authorization`
 * header of an outgoing request. It is never placed in a URL, a log line, an
 * error message or a thrown object. `redact()` exists because a remote server
 * can echo a credential back inside an error string, and a server echoing it is
 * not a reason for PairPilot to display it.
 */

import { maskSecret } from '../security/SecretManager';
import type { HttpTransport } from './HttpTransport';
import { parseSse } from './HttpTransport';

export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/** Identifies PairPilot to OpenRouter for attribution. Optional per the docs. */
export const OPENROUTER_APP_TITLE = 'PairPilot';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export type OpenRouterErrorKind =
  /** 401 — the key is missing, expired or invalid. */
  | 'auth'
  /** 402 — insufficient credits. */
  | 'payment'
  /** 403 — permission, guardrail or moderation refusal. */
  | 'forbidden'
  /** 429 — rate limited. */
  | 'rate-limit'
  /** 408, or our own timeout firing. */
  | 'timeout'
  /** 5xx, including the documented 502/503. */
  | 'server'
  /** The request never reached the server. */
  | 'network'
  /** 400 and friends — the request itself was wrong. */
  | 'bad-request'
  /** The developer cancelled. */
  | 'cancelled'
  /** HTTP worked; the stream was malformed or ended early. */
  | 'stream';

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly kind: OpenRouterErrorKind,
    readonly status: number | null = null,
    readonly retryAfterSeconds: number | null = null,
    /** OpenRouter's stable `error.metadata.error_type`, when supplied. */
    readonly errorType: string | null = null
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

/** True for the conditions OpenRouter's own docs say are worth retrying. */
export function isRetryable(error: unknown): boolean {
  return (
    error instanceof OpenRouterError &&
    (error.kind === 'rate-limit' || error.kind === 'server')
  );
}

/* -------------------------------------------------------------------------- */
/* Wire shapes                                                                */
/* -------------------------------------------------------------------------- */

/** Token accounting as OpenRouter reports it. All counts in tokens, cost in USD. */
export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /**
   * The charge OpenRouter reported for this request.
   *
   * `null` when it did not report one. Never derived here — deriving a cost is
   * `CostCalculator`'s job, and it labels its output as an estimate.
   */
  reportedCostUsd: number | null;
}

export type ChatStreamEvent =
  /** Emitted once, before any content, with OpenRouter's `X-Generation-Id`. */
  | { kind: 'meta'; generationId: string | null }
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'usage'; usage: StreamUsage }
  | { kind: 'finish'; reason: string | null };

/** Account figures from `GET /key`. */
export interface OpenRouterKeyInfo {
  keyLabel: string | null;
  usageUsd: number | null;
  limitUsd: number | null;
  limitRemainingUsd: number | null;
  limitReset: string | null;
  isFreeTier: boolean | null;
}

export interface ChatRequest {
  model: string;
  /** Prior turns, for providers with no server-side thread. */
  history?: readonly { readonly role: 'user' | 'assistant'; readonly text: string }[];
  prompt: string;
  /**
   * Cap on generated tokens, and which parameter to use for it.
   *
   * `null` for the parameter means "this model advertises neither spelling, so
   * send no cap at all". Guessing wrong here is a 400 on models that accept only
   * one of the two names.
   */
  tokenCap?: { readonly parameter: 'max_completion_tokens' | 'max_tokens'; readonly value: number } | null;
}

export interface OpenRouterClientDeps {
  transport: HttpTransport;
  /** Read per call, so a key replaced mid-session applies immediately. */
  apiKey(): Promise<string | undefined>;
  baseUrl: string;
  /** Identifies the app to OpenRouter. Optional per the docs. */
  appTitle?: string;
  /** Injectable for tests; the suite must never actually wait. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  /** Tests pin this to make backoff deterministic. */
  random?(): number;
}

/** Attempts per request, including the first. */
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

export class OpenRouterClient {
  /**
   * The key from the most recent authenticated request, kept solely so that
   * error text can be scrubbed of it.
   *
   * Error construction is synchronous while key lookup is not, so the value has
   * to be captured at the one moment it is legitimately in hand. It is never
   * read for any other purpose, and never leaves this class.
   */
  private lastKnownKey: string | undefined;

  constructor(private readonly deps: OpenRouterClientDeps) {}

  /** `GET /models`. Returns the raw array; normalisation is `ModelRegistry`'s job. */
  async listModels(signal: AbortSignal): Promise<unknown[]> {
    const result = await this.send({
      method: 'GET',
      path: 'models',
      signal,
      authenticated: false,
    });

    const parsed = safeJson(result.text);
    const data = isRecord(parsed) ? parsed['data'] : undefined;
    if (!Array.isArray(data)) {
      throw new OpenRouterError(
        'OpenRouter returned a model catalogue PairPilot could not read: the response had no "data" array.',
        'stream',
        result.status
      );
    }
    return data;
  }

  /** `GET /key`, falling back to the older `/auth/key` path. */
  async getKey(signal: AbortSignal): Promise<OpenRouterKeyInfo> {
    let result = await this.send({
      method: 'GET',
      path: 'key',
      signal,
      authenticated: true,
      // A 404 here means this deployment only serves the older path, which is a
      // routing difference rather than an empty response, so it must not be
      // reported as one.
      tolerate404: true,
    });

    if (result.status === 404) {
      result = await this.send({
        method: 'GET',
        path: 'auth/key',
        signal,
        authenticated: true,
      });
    }

    const parsed = safeJson(result.text);
    const data = isRecord(parsed) && isRecord(parsed['data']) ? parsed['data'] : null;
    if (data === null) {
      throw new OpenRouterError(
        'OpenRouter accepted the key but returned no account details.',
        'stream',
        result.status
      );
    }

    return {
      keyLabel: asString(data['label']),
      usageUsd: asNumber(data['usage']),
      limitUsd: asNumber(data['limit']),
      limitRemainingUsd: asNumber(data['limit_remaining']),
      limitReset: asString(data['limit_reset']),
      isFreeTier: asBoolean(data['is_free_tier']),
    };
  }

  /**
   * `POST /chat/completions` with `stream: true`.
   *
   * Retries only while nothing has been emitted yet. Once the first token
   * reaches the developer, a retry would re-bill the whole prompt and produce a
   * second, interleaved answer — OpenRouter's own docs note that upstream
   * failover stops once part of the response has arrived, and this mirrors that
   * rule on the client side.
   */
  async *chat(request: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatStreamEvent> {
    let emitted = false;
    let attempt = 0;

    for (;;) {
      attempt += 1;
      try {
        for await (const event of this.attemptChat(request, signal)) {
          if (event.kind === 'text' || event.kind === 'reasoning') {
            emitted = true;
          }
          yield event;
        }
        return;
      } catch (error) {
        if (emitted || attempt >= MAX_ATTEMPTS || !isRetryable(error)) {
          throw error;
        }
        const waitMs = retryDelayMs(error, attempt, this.deps.random ?? Math.random);
        await this.sleep(waitMs, signal);
      }
    }
  }

  private async *attemptChat(
    request: ChatRequest,
    signal: AbortSignal
  ): AsyncGenerator<ChatStreamEvent> {
    const messages: { role: string; content: string }[] = [];
    for (const turn of request.history ?? []) {
      messages.push({ role: turn.role, content: turn.text });
    }
    messages.push({ role: 'user', content: request.prompt });

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      stream: true,
    };
    if (request.tokenCap) {
      body[request.tokenCap.parameter] = request.tokenCap.value;
    }

    const response = await this.deps.transport.stream({
      url: this.url('chat/completions'),
      method: 'POST',
      headers: await this.headers(true),
      body: JSON.stringify(body),
      signal,
    });

    // Before the response commits, an error is a normal JSON body with a real
    // status code.
    if (response.status < 200 || response.status >= 300) {
      const text = await collect(response.chunks);
      throw this.errorFromBody(response.status, text, response.headers);
    }

    // OpenRouter returns this header on every inference endpoint, and it is the
    // only way to reconcile a stored cost against the provider's own record.
    yield { kind: 'meta', generationId: response.headers['x-generation-id'] ?? null };

    let sawDone = false;
    let sawUsage = false;
    let emittedText = false;

    try {
      for await (const event of parseSse(response.chunks)) {
        if (event.kind === 'done') {
          sawDone = true;
          break;
        }

        const parsed = safeJson(event.payload);
        if (parsed === null) {
          // A malformed frame is not worth aborting a paid stream over; the
          // remaining frames are still good.
          continue;
        }

        const chunk = asRecord(parsed);
        if (chunk === null) {
          continue;
        }

        // After the response commits, errors ride in-band on a 200 response.
        const inBand = asRecord(chunk['error']);
        if (inBand !== null) {
          throw this.errorFromChunk(response.status, inBand);
        }

        for (const described of describeChoices(chunk)) {
          if (described.kind === 'text') {
            emittedText = true;
          }
          yield described;
        }

        const usage = readUsage(chunk['usage']);
        if (usage !== null) {
          sawUsage = true;
          yield { kind: 'usage', usage };
        }
      }
    } catch (error) {
      throw this.translateStreamFailure(error, signal);
    }

    // The documented stream always ends with a usage chunk and `[DONE]`. Getting
    // neither *and* no content means the connection died before the response
    // began, which must not be reported as an empty success. Content without a
    // terminator is deliberately allowed through: a truncated answer fails in
    // the proposal parser, which explains the symptom far better than a generic
    // stream error would.
    if (!sawDone && !sawUsage && !emittedText) {
      throw new OpenRouterError(
        'OpenRouter closed the connection before sending any content. The request may have been interrupted.',
        'stream'
      );
    }
  }

  /* ---------------------------------------------------------------------- */

  private async send(options: {
    method: 'GET';
    path: string;
    signal: AbortSignal;
    authenticated: boolean;
    tolerate404?: boolean;
  }): Promise<{ status: number; headers: Record<string, string>; text: string }> {
    const response = await this.deps.transport.request({
      url: this.url(options.path),
      method: options.method,
      headers: await this.headers(options.authenticated),
      signal: options.signal,
    });

    if (response.status < 200 || response.status >= 300) {
      if (options.tolerate404 && response.status === 404) {
        return { status: response.status, headers: response.headers, text: response.text };
      }
      throw this.errorFromBody(response.status, response.text, response.headers);
    }
    return { status: response.status, headers: response.headers, text: response.text };
  }

  private url(path: string): string {
    const base = this.deps.baseUrl.replace(/\/+$/, '');
    return `${base}/${path}`;
  }

  private async headers(withAuth: boolean): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Optional per the docs, and sent so PairPilot is identifiable in
      // OpenRouter's own usage reporting.
      'X-OpenRouter-Title': this.deps.appTitle ?? OPENROUTER_APP_TITLE,
    };

    if (withAuth) {
      const key = await this.deps.apiKey();
      if (key === undefined) {
        throw new OpenRouterError(
          'No OpenRouter API key is stored. Add one with the "PairPilot: Set or Replace Provider API Key" command.',
          'auth'
        );
      }
      this.lastKnownKey = key;
      // The only place a key is ever placed.
      headers['Authorization'] = `Bearer ${key}`;
    }

    return headers;
  }

  /** Build an error from an HTTP status and a JSON error body. */
  private errorFromBody(
    status: number,
    text: string,
    headers: Record<string, string>
  ): OpenRouterError {
    const parsed = safeJson(text);
    const envelope = isRecord(parsed) ? asRecord(parsed['error']) : null;
    const serverMessage = envelope !== null ? asString(envelope['message']) : null;
    const errorType =
      envelope !== null && isRecord(envelope['metadata'])
        ? asString((envelope['metadata'] as Record<string, unknown>)['error_type'])
        : null;

    // Redacted before it can reach the message, so a server echoing the key
    // back cannot put it in the panel or the output channel.
    const detail = serverMessage !== null ? this.redact(serverMessage) : firstLine(text);
    const retryAfter = parseRetryAfter(headers['retry-after']);
    const kind = kindForStatus(status);

    return new OpenRouterError(
      composeMessage(kind, status, detail, retryAfter),
      kind,
      status,
      retryAfter,
      errorType
    );
  }

  /** Build an error from the in-band `error` object of a committed stream. */
  private errorFromChunk(status: number, error: Record<string, unknown>): OpenRouterError {
    const code = asNumber(error['code']);
    const effective = code !== null && Number.isFinite(code) ? code : status;
    const metadata = asRecord(error['metadata']);
    const errorType = metadata !== null ? asString(metadata['error_type']) : null;
    const message = asString(error['message']) ?? 'OpenRouter reported an error mid-stream.';
    const redacted = this.redact(message);
    const kind = kindForStatus(effective);

    return new OpenRouterError(
      composeMessage(kind, effective, redacted, null),
      kind,
      effective,
      null,
      errorType
    );
  }

  /**
   * Remove the stored key from anything about to be shown or thrown.
   *
   * A remote service echoing a credential back is not a reason for PairPilot to
   * display it in the panel, the output channel or a stack trace.
   */
  private redact(text: string): string {
    return redactSecret(text, this.lastKnownKey);
  }

  /** Re-shape a transport failure so `cancel`, timeout and network are distinct. */
  private translateStreamFailure(error: unknown, signal: AbortSignal): unknown {
    if (error instanceof OpenRouterError) {
      return error;
    }
    if (signal.aborted) {
      return new OpenRouterError('The request was cancelled.', 'cancelled');
    }
    const message = error instanceof Error ? error.message : String(error);
    return new OpenRouterError(
      `Could not reach OpenRouter: ${this.redact(message)}`,
      'network'
    );
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    const sleep = this.deps.sleep ?? realSleep;
    return sleep(ms, signal);
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function kindForStatus(status: number): OpenRouterErrorKind {
  if (status === 401) return 'auth';
  if (status === 402) return 'payment';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'bad-request';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'server';
  if (status >= 400) return 'bad-request';
  return 'network';
}

/**
 * A sentence a developer can act on.
 *
 * Each branch names the fix, because "429" alone tells a developer nothing about
 * whether to wait, top up, or pick a different model.
 */
function composeMessage(
  kind: OpenRouterErrorKind,
  status: number,
  detail: string | null,
  retryAfter: number | null
): string {
  const suffix = detail !== null && detail.length > 0 ? ` OpenRouter said: ${detail}` : '';

  switch (kind) {
    case 'auth':
      return `OpenRouter rejected the API key (HTTP ${status}). Check the key with "PairPilot: Set or Replace Provider API Key", or create a new one at https://openrouter.ai/keys.${suffix}`;
    case 'payment':
      return `OpenRouter reports insufficient credits for this request (HTTP ${status}). Add credits at https://openrouter.ai/credits, or choose a cheaper model.${suffix}`;
    case 'forbidden':
      return `OpenRouter refused the request (HTTP ${status}). This is usually a permission or content-policy refusal rather than a configuration problem.${suffix}`;
    case 'rate-limit':
      return `OpenRouter is rate limiting this key (HTTP ${status}).${retryAfter !== null ? ` It asked PairPilot to wait ${retryAfter}s.` : ''} Try again shortly, or pick a different model.${suffix}`;
    case 'timeout':
      return `The request timed out (HTTP ${status}). Raise "pairpilot.runtime.timeoutMs" or try a faster model.${suffix}`;
    case 'server':
      return `OpenRouter reported a server-side problem (HTTP ${status}). This is usually transient.${suffix}`;
    case 'cancelled':
      return 'The request was cancelled.';
    case 'bad-request':
      return `OpenRouter rejected the request (HTTP ${status}).${suffix}`;
    case 'stream':
      return `The response stream was not usable.${suffix}`;
    default:
      return `Could not reach OpenRouter.${suffix}`;
  }
}

/** Replace every occurrence of `secret` in `text` with its mask. */
export function redactSecret(text: string, secret: string | undefined): string {
  if (secret === undefined || secret.length < 8) {
    return text;
  }
  return text.split(secret).join(maskSecret(secret));
}

function describeChoices(chunk: Record<string, unknown>): ChatStreamEvent[] {
  const events: ChatStreamEvent[] = [];
  const choices = chunk['choices'];
  if (!Array.isArray(choices)) {
    return events;
  }

  for (const raw of choices) {
    const choice = asRecord(raw);
    if (choice === null) {
      continue;
    }

    const delta = asRecord(choice['delta']);
    if (delta !== null) {
      const content = asString(delta['content']);
      if (content !== null && content.length > 0) {
        events.push({ kind: 'text', text: content });
      }

      const reasoning = readReasoning(delta);
      if (reasoning !== null && reasoning.length > 0) {
        events.push({ kind: 'reasoning', text: reasoning });
      }
    }

    const reason = asString(choice['finish_reason']);
    if (reason !== null) {
      events.push({ kind: 'finish', reason });
    }
  }

  return events;
}

/**
 * Reasoning text on a delta.
 *
 * The documented streaming location is `delta.reasoning_details`, an array whose
 * text entries carry `text`. A plain `delta.reasoning` string is *not*
 * documented, but some compatible deployments send it, so it is read as a
 * fallback. Neither is invented: when both are absent there is no reasoning
 * event at all.
 */
function readReasoning(delta: Record<string, unknown>): string | null {
  const details = delta['reasoning_details'];
  if (Array.isArray(details)) {
    let combined = '';
    for (const raw of details) {
      const entry = asRecord(raw);
      if (entry === null) {
        continue;
      }
      const text = asString(entry['text']);
      if (text !== null) {
        combined += text;
      }
    }
    if (combined.length > 0) {
      return combined;
    }
  }

  return asString(delta['reasoning']);
}

/** Read the `usage` block. Returns null when absent, so absence stays visible. */
export function readUsage(raw: unknown): StreamUsage | null {
  const usage = asRecord(raw);
  if (usage === null) {
    return null;
  }

  const promptDetails = asRecord(usage['prompt_tokens_details']);
  const completionDetails = asRecord(usage['completion_tokens_details']);

  return {
    inputTokens: asNumber(usage['prompt_tokens']) ?? 0,
    outputTokens: asNumber(usage['completion_tokens']) ?? 0,
    cachedTokens: promptDetails !== null ? asNumber(promptDetails['cached_tokens']) ?? 0 : 0,
    cacheWriteTokens:
      promptDetails !== null ? asNumber(promptDetails['cache_write_tokens']) ?? 0 : 0,
    reasoningTokens:
      completionDetails !== null ? asNumber(completionDetails['reasoning_tokens']) ?? 0 : 0,
    reportedCostUsd: asNumber(usage['cost']),
  };
}

/**
 * `Retry-After` in seconds.
 *
 * The docs say it may accompany 429 and 503. It can also be an HTTP date, which
 * is handled rather than silently ignored.
 */
export function parseRetryAfter(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) {
    // A plain number is the documented form. A negative one is malformed, and
    // must not fall through to the date parser below: `Date.parse('-5')` is not
    // an error, it is the year 5 BC, which would come back as "retry now".
    return seconds >= 0 ? Math.min(seconds, 300) : null;
  }
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.max(0, Math.min(Math.round((date - Date.now()) / 1000), 300));
  }
  return null;
}

/** Exponential backoff, honouring `Retry-After` when the server supplied one. */
export function retryDelayMs(error: unknown, attempt: number, random: () => number): number {
  if (error instanceof OpenRouterError && error.retryAfterSeconds !== null) {
    return error.retryAfterSeconds * 1000;
  }
  const exponential = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  // Jitter, so a burst of retries from one window does not synchronise.
  const jitter = random() * BASE_BACKOFF_MS;
  return Math.min(exponential + jitter, MAX_BACKOFF_MS);
}

/** Collect a chunk iterable into a string, for a non-streaming error path. */
async function collect(chunks: AsyncIterable<string>): Promise<string> {
  let text = '';
  for await (const chunk of chunks) {
    text += chunk;
    // An error body is small; this bounds a pathological response.
    if (text.length > 64_000) {
      break;
    }
  }
  return text;
}

function realSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new OpenRouterError('The request was cancelled.', 'cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new OpenRouterError('The request was cancelled.', 'cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/* -------------------------------------------------------------------------- */
/* Coercion                                                                   */
/* -------------------------------------------------------------------------- */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** Numbers may arrive as JSON numbers or as numeric strings. Both are accepted. */
export function asNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function firstLine(text: string): string | null {
  const line = text.split('\n', 1)[0]?.trim();
  return line !== undefined && line.length > 0 && line.length < 300 ? line : null;
}

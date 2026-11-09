/**
 * HTTP transport, plus the SSE parser that runs on top of it.
 *
 * The transport is an interface for one reason: the suite must be able to prove
 * the streaming client is correct *without a network and without a key*. A
 * recorded fixture feeds the same `parseSse` generator the real socket does, so
 * the tests exercise the production parse path rather than a stand-in for it.
 *
 * `parseSse` is written against OpenRouter's documented wire format, including
 * the parts that are easy to get wrong:
 *
 *  - `data: ` is a prefix with a trailing space, and lines that are not `data:`
 *    must be skipped rather than parsed.
 *  - Comment lines begin with `:`. OpenRouter sends `: OPENROUTER PROCESSING`
 *    to hold the connection open, and the docs warn that feeding one to
 *    `JSON.parse` throws. Those lines are dropped here, so no consumer can
 *    forget to.
 *  - The terminator is the literal `[DONE]`, and it is reported as its own event
 *    kind rather than as a payload, so it can never reach `JSON.parse`.
 *  - A chunk boundary can fall in the middle of a line, so lines are buffered.
 */

/** One HTTP call's inputs. */
export interface HttpRequestSpec {
  url: string;
  method: 'GET' | 'POST';
  headers: Readonly<Record<string, string>>;
  /** Serialised request body. Absent for GET. */
  body?: string;
  signal: AbortSignal;
}

/** Response headers, lower-cased because HTTP header names are case-insensitive. */
export type HttpHeaders = Readonly<Record<string, string>>;

export interface HttpResult {
  status: number;
  headers: HttpHeaders;
  text: string;
}

export interface HttpStreamResult {
  status: number;
  headers: HttpHeaders;
  /**
   * Decoded text chunks in arrival order.
   *
   * Chunks are *not* lines: a chunk can end mid-line. `parseSse` is what turns
   * them into events, and it is the only thing that should.
   */
  chunks: AsyncIterable<string>;
}

export interface HttpTransport {
  /** False when the host lacks the platform feature this transport needs. */
  readonly available: boolean;
  /** Why it is unavailable, phrased for the developer. */
  readonly unavailableReason?: string;
  request(spec: HttpRequestSpec): Promise<HttpResult>;
  stream(spec: HttpRequestSpec): Promise<HttpStreamResult>;
}

/* -------------------------------------------------------------------------- */
/* SSE parsing                                                                */
/* -------------------------------------------------------------------------- */

export type SseEvent = { kind: 'data'; payload: string } | { kind: 'done' };

/**
 * Turn decoded text chunks into SSE events.
 *
 * Terminates after `[DONE]` rather than consuming the rest of the socket. The
 * caller is expected to abort the response at that point — OpenRouter sends
 * nothing after the sentinel, and leaving the connection open would hold a
 * socket for no reason.
 */
export async function* parseSse(chunks: AsyncIterable<string>): AsyncGenerator<SseEvent> {
  let buffer = '';

  for await (const chunk of chunks) {
    buffer += chunk;

    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);

      const event = interpretSseLine(line);
      if (event !== null) {
        yield event;
        if (event.kind === 'done') {
          return;
        }
      }
      newline = buffer.indexOf('\n');
    }
  }

  // A final line with no trailing newline still counts.
  if (buffer.length > 0) {
    const event = interpretSseLine(buffer);
    if (event !== null) {
      yield event;
    }
  }
}

/** Interpret one raw line. Returns null for anything that is not a data event. */
export function interpretSseLine(rawLine: string): SseEvent | null {
  // Tolerate CRLF: strip a single trailing carriage return.
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

  // Blank line = event separator. Nothing to emit.
  if (line.length === 0) {
    return null;
  }
  // `: OPENROUTER PROCESSING` and friends. Skipping here is what keeps a
  // keep-alive from reaching JSON.parse.
  if (line.startsWith(':')) {
    return null;
  }
  // Any other SSE field (`event:`, `id:`, `retry:`). OpenRouter does not use
  // them on this endpoint, and ignoring them is safer than guessing.
  if (!line.startsWith('data:')) {
    return null;
  }

  const payload = line.slice('data:'.length).trim();
  if (payload.length === 0) {
    return null;
  }
  if (payload === '[DONE]') {
    return { kind: 'done' };
  }
  return { kind: 'data', payload };
}

/* -------------------------------------------------------------------------- */
/* fetch implementation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `HttpTransport` over the host's global `fetch`.
 *
 * VS Code 1.95 runs Electron 32 / Node 20, where `fetch`, `AbortController` and
 * `ReadableStream` are all present. Rather than shipping a `node:https`
 * fallback that would never be exercised, this reports itself unavailable and
 * says why — an honest failure beats a second, untested code path.
 */
export class FetchTransport implements HttpTransport {
  readonly available: boolean;
  readonly unavailableReason?: string;

  constructor() {
    const missing = describeMissingPlatformFeature();
    this.available = missing === null;
    if (missing !== null) {
      this.unavailableReason = missing;
    }
  }

  async request(spec: HttpRequestSpec): Promise<HttpResult> {
    const response = await fetch(spec.url, {
      method: spec.method,
      headers: spec.headers,
      ...(spec.body !== undefined ? { body: spec.body } : {}),
      signal: spec.signal,
    });
    return { status: response.status, headers: collectHeaders(response), text: await response.text() };
  }

  async stream(spec: HttpRequestSpec): Promise<HttpStreamResult> {
    const response = await fetch(spec.url, {
      method: spec.method,
      headers: spec.headers,
      ...(spec.body !== undefined ? { body: spec.body } : {}),
      signal: spec.signal,
    });

    const headers = collectHeaders(response);
    const body = response.body;

    if (body === null) {
      // A 4xx/5xx with no body still needs its status surfaced; the caller reads
      // the status and raises before it ever touches the chunk iterable.
      return { status: response.status, headers, chunks: emptyChunks() };
    }

    return { status: response.status, headers, chunks: decodeBody(body) };
  }
}

function describeMissingPlatformFeature(): string | null {
  if (typeof globalThis.fetch !== 'function') {
    return 'This VS Code build does not provide the global fetch API, which PairPilot needs for remote providers.';
  }
  if (typeof globalThis.AbortController !== 'function') {
    return 'This VS Code build does not provide AbortController, which PairPilot needs to cancel remote requests.';
  }
  return null;
}

function collectHeaders(response: Response): HttpHeaders {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

async function* decodeBody(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value !== undefined) {
        // `stream: true` so a multi-byte character split across two network
        // chunks is not mangled into replacement characters.
        const text = decoder.decode(value, { stream: true });
        if (text.length > 0) {
          yield text;
        }
      }
    }
    const tail = decoder.decode();
    if (tail.length > 0) {
      yield tail;
    }
  } finally {
    // Releases the reader even when the consumer stops early — which is exactly
    // what happens on `[DONE]` or on cancellation.
    reader.releaseLock();
  }
}

async function* emptyChunks(): AsyncGenerator<string> {
  // Intentionally yields nothing.
}

/**
 * JsonStreamScanner — incremental, string-aware extraction of fields from a
 * JSON document that is still arriving.
 *
 * Why this exists. Spec section 8 requires code written into the editor
 * *progressively, from real streamed AI output*, and forbids timers that merely
 * simulate typing. The runtime gives us real `text_delta` chunks, but those
 * chunks are raw JSON text: a chunk boundary can land mid-escape, mid-token, or
 * mid-string, so naive substring matching would write corrupted code.
 *
 * This scanner consumes the stream character by character, tracks JSON
 * structure with a frame stack, and emits a delta only for characters that are
 * *already unambiguously decoded*:
 *
 *   - a chunk ending in the middle of `\u00` emits nothing yet;
 *   - a chunk ending mid-key never emits the next field's content;
 *   - commas, braces and quotes inside string values are treated as data.
 *
 * Deliberately narrow: it extracts the one string per change that carries file
 * content (for progressive writing) and the short scalars worth showing early.
 * Everything else is the parser's job on the completed document — we do not
 * build a second JSON parser.
 *
 * ## Which shape it reads
 *
 * Both the canonical contract and the 0.1.x one, because the scanner runs while
 * the document is still arriving and cannot know which the model chose:
 *
 *   - canonical: `changes[i].content`, with `changes[i].file` for the label
 *   - legacy:    `blocks[i].code`,     with a root-level `filePath`
 *
 * The array is recognised by the key it hangs off (`changes`, `files` or
 * `blocks`), so a nested `content` key anywhere else in the document is never
 * mistaken for code.
 *
 * Also bounded: a malicious or runaway stream cannot grow memory without limit.
 */

export interface ScannerCallbacks {
  /** Decoded, newly-available characters of the change's content string. */
  onCodeDelta?(blockIndex: number, delta: string): void;
  /** A short scalar finished (for example `file`, `filePath` or `type`). */
  onFieldComplete?(name: string, value: string): void;
  /** Called when the scanner sees a structural problem. Non-fatal. */
  onWarning?(message: string): void;
}

export interface ScannerLimits {
  /** Maximum characters retained per code block. */
  maxBlockChars: number;
  /** Maximum characters retained for a single top-level scalar. */
  maxFieldChars: number;
}

const DEFAULT_LIMITS: ScannerLimits = {
  maxBlockChars: 512 * 1024,
  maxFieldChars: 8 * 1024,
};

/** Root-level scalars worth surfacing before the document completes. */
const INTERESTING_ROOT_FIELDS = new Set([
  'type',
  'filePath',
  'operation',
  'description',
  'rationale',
  'message',
]);

/** Scalars inside one change object, which is where the canonical shape puts them. */
const INTERESTING_CHANGE_FIELDS = new Set([
  'file',
  'filePath',
  'operation',
  'description',
  'language',
]);

/** Keys whose string value is the file's content. */
const CODE_KEYS = new Set(['content', 'code']);

/** Array keys whose elements are changes. */
const CHANGE_ARRAY_KEYS = new Set(['changes', 'files', 'blocks']);

interface Frame {
  kind: 'object' | 'array';
  /** For arrays: index of the element currently being read. */
  index: number;
  /** For objects: the key awaiting a value. */
  pendingKey: string | null;
  /** For objects: true when the next string is a key rather than a value. */
  expectKey: boolean;
  /** True for the root-level array whose elements are changes. */
  isChangeArray: boolean;
}

/** What the string currently being read is being collected into. */
type StringTarget =
  | { kind: 'code'; blockIndex: number }
  | { kind: 'field'; name: string }
  | { kind: 'skip'; isKey: true }
  | null;

export class JsonStreamScanner {
  private readonly cb: ScannerCallbacks;
  private readonly limits: ScannerLimits;

  private frames: Frame[] = [];
  private inString = false;
  private escaped = false;
  /** Held while decoding a `\uXXXX` escape, so partial escapes emit nothing. */
  private unicodeBuffer: string | null = null;
  private stringTarget: StringTarget = null;
  /** Retained per-block decoded code, for `getCode()`. */
  private readonly blockCode = new Map<number, string>();
  /** Accumulator for the non-code string being read. */
  private scalarBuffer = '';
  private truncatedWarned = false;
  private depthGuardWarned = false;

  constructor(callbacks: ScannerCallbacks = {}, limits: Partial<ScannerLimits> = {}) {
    this.cb = callbacks;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /** Feed a raw chunk of JSON text. */
  push(chunk: string): void {
    for (let i = 0; i < chunk.length; i++) {
      this.consume(chunk.charAt(i));
    }
  }

  /** Concatenated code decoded for a block so far. */
  getCode(blockIndex: number): string {
    return this.blockCode.get(blockIndex) ?? '';
  }

  /** True once the root object has closed. */
  get complete(): boolean {
    return this.frames.length === 0 && this.sawRootClose;
  }

  private sawRootClose = false;

  reset(): void {
    this.frames = [];
    this.inString = false;
    this.escaped = false;
    this.unicodeBuffer = null;
    this.stringTarget = null;
    this.blockCode.clear();
    this.scalarBuffer = '';
    this.truncatedWarned = false;
    this.depthGuardWarned = false;
    this.sawRootClose = false;
  }

  /* ---------------------------------------------------------------------- */

  private top(): Frame | undefined {
    return this.frames[this.frames.length - 1];
  }

  private consume(c: string): void {
    if (this.inString) {
      this.consumeInString(c);
      return;
    }

    switch (c) {
      case '"':
        this.beginString();
        return;
      case '{':
        this.pushFrame({ kind: 'object', index: 0, pendingKey: null, expectKey: true, isChangeArray: false });
        return;
      case '[': {
        const parent = this.top();
        const isChanges =
          parent?.kind === 'object' &&
          parent.pendingKey !== null &&
          CHANGE_ARRAY_KEYS.has(parent.pendingKey) &&
          this.frames.length === 1;
        this.pushFrame({ kind: 'array', index: 0, pendingKey: null, expectKey: false, isChangeArray: isChanges });
        return;
      }
      case '}':
      case ']': {
        const frame = this.frames.pop();
        if (!frame) {
          this.warn('Unbalanced closing bracket in streamed JSON.');
          return;
        }
        if (this.frames.length === 0) {
          this.sawRootClose = true;
        }
        this.afterValue();
        return;
      }
      case ',':
        this.afterComma();
        return;
      case ':': {
        // The value position begins; `pendingKey` was set when the key closed.
        const frame = this.top();
        if (frame?.kind === 'object') {
          frame.expectKey = false;
        }
        return;
      }
      default:
        // Numbers, true/false/null, whitespace: no structural effect for our
        // two extraction targets.
        return;
    }
  }

  private pushFrame(frame: Frame): void {
    // Depth guard: a hostile stream must not exhaust the stack.
    if (this.frames.length > 128) {
      if (!this.depthGuardWarned) {
        this.depthGuardWarned = true;
        this.warn('Streamed JSON exceeded the maximum nesting depth; further structure is ignored.');
      }
      return;
    }
    this.frames.push(frame);
  }

  /** Called after a nested container closes: it counts as a completed value. */
  private afterValue(): void {
    const frame = this.top();
    if (frame?.kind === 'object') {
      frame.pendingKey = null;
      frame.expectKey = true;
    }
  }

  private afterComma(): void {
    const frame = this.top();
    if (!frame) {
      return;
    }
    if (frame.kind === 'array') {
      frame.index += 1;
      return;
    }
    frame.expectKey = true;
    frame.pendingKey = null;
  }

  private beginString(): void {
    this.inString = true;
    this.escaped = false;
    this.unicodeBuffer = null;
    this.scalarBuffer = '';
    this.stringTarget = this.resolveStringTarget();
  }

  /**
   * Decide what the string about to be read represents, *before* its content
   * arrives. Doing this up front is what lets us stream characters immediately
   * instead of buffering the whole value and diffing afterwards.
   *
   * The change array is identified by its position — the second frame, hanging
   * off a change-array key — so nested objects that happen to contain a
   * `content` key of their own are not mistaken for file content.
   */
  private resolveStringTarget(): StringTarget {
    const frame = this.top();
    if (!frame) {
      return null;
    }
    if (frame.kind === 'object') {
      if (frame.expectKey) {
        return { kind: 'skip', isKey: true };
      }
      const key = frame.pendingKey;
      if (key === null) {
        return null;
      }
      // Root-level scalar?
      if (this.frames.length === 1 && INTERESTING_ROOT_FIELDS.has(key)) {
        return { kind: 'field', name: key };
      }
      // Inside one element of the changes array: [root, array, changeObject].
      if (this.frames.length === 3) {
        const array = this.frames[1];
        if (array?.kind !== 'array' || !array.isChangeArray) {
          return null;
        }
        if (CODE_KEYS.has(key)) {
          return { kind: 'code', blockIndex: array.index };
        }
        if (INTERESTING_CHANGE_FIELDS.has(key)) {
          // Reported under the change's own index so the UI can say which file
          // of a set is being written, rather than just "a file".
          return { kind: 'field', name: `changes[${array.index}].${key}` };
        }
      }
      return null;
    }
    return null;
  }

  private consumeInString(c: string): void {
    // Decoding a `\uXXXX` escape: collect four hex digits before emitting.
    if (this.unicodeBuffer !== null) {
      this.unicodeBuffer += c;
      if (this.unicodeBuffer.length === 5) {
        const code = Number.parseInt(this.unicodeBuffer.slice(1), 16);
        this.unicodeBuffer = null;
        this.emitChar(Number.isNaN(code) ? '�' : String.fromCharCode(code));
      }
      return;
    }

    if (this.escaped) {
      this.escaped = false;
      switch (c) {
        case 'n': this.emitChar('\n'); return;
        case 't': this.emitChar('\t'); return;
        case 'r': this.emitChar('\r'); return;
        case 'b': this.emitChar('\b'); return;
        case 'f': this.emitChar('\f'); return;
        case '"': this.emitChar('"'); return;
        case '\\': this.emitChar('\\'); return;
        case '/': this.emitChar('/'); return;
        case 'u':
          this.unicodeBuffer = '\\u';
          return;
        default:
          // Unknown escape: preserve the character rather than dropping content.
          this.emitChar(c);
          return;
      }
    }

    if (c === '\\') {
      this.escaped = true;
      return;
    }

    if (c === '"') {
      this.endString();
      return;
    }

    this.emitChar(c);
  }

  /** Route one decoded character to the active target. */
  private emitChar(ch: string): void {
    const target = this.stringTarget;
    if (!target) {
      return;
    }
    if (target.kind === 'code') {
      const current = this.blockCode.get(target.blockIndex) ?? '';
      if (current.length >= this.limits.maxBlockChars) {
        if (!this.truncatedWarned) {
          this.truncatedWarned = true;
          this.warn('Streamed code exceeded the size limit; extra content is not displayed live.');
        }
        return;
      }
      this.blockCode.set(target.blockIndex, current + ch);
      this.cb.onCodeDelta?.(target.blockIndex, ch);
      return;
    }
    if (target.kind === 'field') {
      if (this.scalarBuffer.length < this.limits.maxFieldChars) {
        this.scalarBuffer += ch;
      }
      return;
    }
    // A key is accumulated too: `endString` needs the completed key name to know
    // which value follows it. Missing this is what made `pendingKey` always
    // empty, so no `code` field was ever recognised.
    if (this.scalarBuffer.length < this.limits.maxFieldChars) {
      this.scalarBuffer += ch;
    }
  }

  private endString(): void {
    this.inString = false;
    const target = this.stringTarget;
    this.stringTarget = null;
    const frame = this.top();
    if (!frame) {
      return;
    }

    if (target && target.kind === 'skip') {
      // This was an object key; remember it so the following value knows its name.
      if (frame.kind === 'object') {
        frame.pendingKey = this.scalarBuffer;
        frame.expectKey = false;
      }
      this.scalarBuffer = '';
      return;
    }

    if (target && target.kind === 'field') {
      this.cb.onFieldComplete?.(target.name, this.scalarBuffer);
      this.scalarBuffer = '';
      this.afterValue();
      return;
    }

    this.scalarBuffer = '';
    if (frame.kind === 'object') {
      this.afterValue();
    }
  }

  private warn(message: string): void {
    this.cb.onWarning?.(message);
  }
}

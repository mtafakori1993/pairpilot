/**
 * JsonStreamScanner tests.
 *
 * This scanner is what makes section 8's "no timer-based typing" requirement
 * possible, and it is the most failure-prone code in the project: it decodes
 * code out of a JSON document that arrives in arbitrary chunks. The tests
 * therefore focus on chunk boundaries, because that is where corruption would
 * appear as subtly wrong code in the developer's editor.
 *
 * The core assertion throughout: feeding a document one character at a time must
 * produce byte-identical code to feeding it whole.
 */

import { describe, expect, it } from 'vitest';
import { JsonStreamScanner } from '../../src/proposals/JsonStreamScanner';

interface Collected {
  code: Map<number, string>;
  fields: Map<string, string>;
  warnings: string[];
}

/** Build a scanner that records every callback. */
function makeScanner(): { scanner: JsonStreamScanner; result: Collected } {
  const result: Collected = { code: new Map(), fields: new Map(), warnings: [] };
  const scanner = new JsonStreamScanner({
    onCodeDelta: (blockIndex, delta) => {
      result.code.set(blockIndex, (result.code.get(blockIndex) ?? '') + delta);
    },
    onFieldComplete: (name, value) => {
      result.fields.set(name, value);
    },
    onWarning: (message) => result.warnings.push(message),
  });
  return { scanner, result };
}

const DOCUMENT = JSON.stringify({
  type: 'code_proposal',
  filePath: 'src/service/user-service.ts',
  operation: 'create',
  description: 'Create a user service',
  dependencies: ['express'],
  blocks: [
    {
      id: 'block-001',
      type: 'class',
      description: 'The service',
      code: 'export class UserService {\n  async find(id: string) {\n    return { id };\n  }\n}\n',
    },
    {
      id: 'block-002',
      type: 'export',
      description: 'Barrel export',
      code: "export * from './user-service';\n",
    },
  ],
});

describe('JsonStreamScanner: extraction', () => {
  it('extracts every block code from a whole document', () => {
    const { scanner, result } = makeScanner();
    scanner.push(DOCUMENT);

    const parsed = JSON.parse(DOCUMENT) as { blocks: { code: string }[] };
    expect(result.code.get(0)).toBe(parsed.blocks[0]!.code);
    expect(result.code.get(1)).toBe(parsed.blocks[1]!.code);
  });

  it('extracts top-level scalar fields', () => {
    const { scanner, result } = makeScanner();
    scanner.push(DOCUMENT);
    expect(result.fields.get('filePath')).toBe('src/service/user-service.ts');
    expect(result.fields.get('operation')).toBe('create');
    expect(result.fields.get('description')).toBe('Create a user service');
  });

  it('accumulates code incrementally rather than in one jump', () => {
    const { scanner, result } = makeScanner();
    // Feed in small chunks; the accumulated total must still be exact.
    for (let i = 0; i < DOCUMENT.length; i += 7) {
      scanner.push(DOCUMENT.slice(i, i + 7));
    }
    const parsed = JSON.parse(DOCUMENT) as { blocks: { code: string }[] };
    expect(result.code.get(0)).toBe(parsed.blocks[0]!.code);
  });
});

describe('JsonStreamScanner: chunk-boundary robustness', () => {
  it('produces identical output for every chunk size', () => {
    const parsed = JSON.parse(DOCUMENT) as { blocks: { code: string }[] };

    for (const size of [1, 2, 3, 5, 13, 64, 512]) {
      const { scanner, result } = makeScanner();
      for (let i = 0; i < DOCUMENT.length; i += size) {
        scanner.push(DOCUMENT.slice(i, i + size));
      }
      expect(result.code.get(0), `chunk size ${size}`).toBe(parsed.blocks[0]!.code);
      expect(result.code.get(1), `chunk size ${size}`).toBe(parsed.blocks[1]!.code);
    }
  });

  it('does not emit a partial unicode escape (a surrogate pair split across chunks)', () => {
    // U+1F600 as a surrogate pair, escaped. A naive decoder would emit half.
    const document = JSON.stringify({
      type: 'code_proposal',
      filePath: 'a.ts',
      blocks: [{ id: 'b', code: 'const face = "\\ud83d\\ude00";' }],
    });

    for (const size of [1, 2, 6, 11]) {
      const { scanner, result } = makeScanner();
      for (let i = 0; i < document.length; i += size) {
        scanner.push(document.slice(i, i + size));
      }
      const parsed = JSON.parse(document) as { blocks: { code: string }[] };
      expect(result.code.get(0), `chunk size ${size}`).toBe(parsed.blocks[0]!.code);
    }
  });

  it('handles an escape sequence split across chunks', () => {
    const document = '{"type":"code_proposal","filePath":"a.ts","blocks":[{"id":"b","code":"line1\\n\\tline2\\\\end"}]}';
    const parsed = JSON.parse(document) as { blocks: { code: string }[] };

    for (const size of [1, 3, 8]) {
      const { scanner, result } = makeScanner();
      for (let i = 0; i < document.length; i += size) {
        scanner.push(document.slice(i, i + size));
      }
      expect(result.code.get(0), `chunk size ${size}`).toBe(parsed.blocks[0]!.code);
    }
  });

  it('treats braces and commas inside a string as data, not structure', () => {
    const code = 'const o = { a: 1, b: [2, 3] };\nconst s = "}{,";\n';
    const document = JSON.stringify({
      type: 'code_proposal',
      filePath: 'a.ts',
      blocks: [{ id: 'b', code }],
    });
    const { scanner, result } = makeScanner();
    scanner.push(document);
    expect(result.code.get(0)).toBe(code);
  });

  it('handles a key that appears as a substring inside another key', () => {
    // `description` contains `code`? No — but `codeSample` does start with `code`.
    // The scanner must match the key exactly.
    const document = JSON.stringify({
      type: 'code_proposal',
      filePath: 'a.ts',
      blocks: [{ id: 'b', codeSample: 'NOT CODE', code: 'REAL CODE' }],
    });
    const { scanner, result } = makeScanner();
    scanner.push(document);
    expect(result.code.get(0)).toBe('REAL CODE');
  });

  it('ignores a nested `code` key that is not inside blocks', () => {
    const document = JSON.stringify({
      type: 'code_proposal',
      filePath: 'a.ts',
      metadata: { code: 'SHOULD NOT BE CAPTURED' },
      blocks: [{ id: 'b', code: 'REAL' }],
    });
    const { scanner, result } = makeScanner();
    scanner.push(document);
    expect(result.code.get(0)).toBe('REAL');
  });
});

describe('JsonStreamScanner: limits and malformed input', () => {
  it('stops accumulating a block past the size limit and warns once', () => {
    const { scanner, result } = makeScanner();
    const limited = new JsonStreamScanner(
      {
        onCodeDelta: (blockIndex, delta) => {
          result.code.set(blockIndex, (result.code.get(blockIndex) ?? '') + delta);
        },
        onWarning: (message) => result.warnings.push(message),
      },
      { maxBlockChars: 50, maxFieldChars: 20 }
    );

    limited.push(JSON.stringify({ blocks: [{ code: 'x'.repeat(500) }] }));
    expect((result.code.get(0) ?? '').length).toBe(50);
    expect(result.warnings.filter((w) => w.includes('size limit')).length).toBe(1);
    void scanner;
  });

  it('survives an unbalanced closing brace without throwing', () => {
    const { scanner, result } = makeScanner();
    expect(() => scanner.push('}}}')).not.toThrow();
    expect(result.warnings.some((w) => w.includes('Unbalanced'))).toBe(true);
  });

  it('survives a truncated document', () => {
    const { scanner } = makeScanner();
    const truncated = DOCUMENT.slice(0, Math.floor(DOCUMENT.length / 2));
    expect(() => scanner.push(truncated)).not.toThrow();
  });

  it('caps nesting depth rather than exhausting the stack', () => {
    const { scanner, result } = makeScanner();
    const deep = '{"a":'.repeat(300) + '1' + '}'.repeat(300);
    expect(() => scanner.push(deep)).not.toThrow();
    expect(result.warnings.some((w) => w.includes('nesting depth'))).toBe(true);
  });

  it('reports completion only after the root object closes', () => {
    const { scanner } = makeScanner();
    scanner.push('{"blocks":[]');
    expect(scanner.complete).toBe(false);
    scanner.push('}');
    expect(scanner.complete).toBe(true);
  });

  it('resets cleanly', () => {
    const { scanner, result } = makeScanner();
    scanner.push(DOCUMENT);
    scanner.reset();
    expect(scanner.getCode(0)).toBe('');
    expect(result.code.size).toBeGreaterThan(0);
    expect(scanner.complete).toBe(false);
  });
});

describe('JsonStreamScanner: progressive delivery', () => {
  it('emits code deltas well before the document completes', () => {
    const { scanner, result } = makeScanner();
    // Feed everything up to (but not including) the end of the first code value.
    const marker = 'export class UserService {';
    const cut = DOCUMENT.indexOf(marker) + marker.length;
    scanner.push(DOCUMENT.slice(0, cut));

    // The opening of the class must already be available: this is what makes the
    // live editor writing real rather than simulated.
    expect(result.code.get(0)).toBe(marker);
    expect(scanner.complete).toBe(false);
  });

  it('delivers many small deltas rather than one large one', () => {
    let deltaCount = 0;
    const scanner = new JsonStreamScanner({
      onCodeDelta: () => {
        deltaCount++;
      },
    });
    for (let i = 0; i < DOCUMENT.length; i += 5) {
      scanner.push(DOCUMENT.slice(i, i + 5));
    }
    expect(deltaCount).toBeGreaterThan(20);
  });
});

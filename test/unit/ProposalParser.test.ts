/**
 * ProposalParser tests.
 *
 * Models do not reliably emit bare JSON. These tests cover the shapes actually
 * observed: fenced output, a preamble sentence, trailing commentary, and braces
 * inside string values (which break naive slicing).
 */

import { describe, expect, it } from 'vitest';
import { ProposalParser, extractBalancedObjects } from '../../src/proposals/ProposalParser';

const parser = new ProposalParser();

const VALID = {
  type: 'code_proposal',
  filePath: 'src/a.ts',
  operation: 'create',
  description: 'Create a',
  dependencies: [],
  blocks: [{ id: 'b1', type: 'code', description: '', code: 'export const a = 1;\n' }],
};

describe('ProposalParser: happy path', () => {
  it('parses bare JSON', () => {
    const result = parser.parse(JSON.stringify(VALID));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.filePath).toBe('src/a.ts');
    }
  });

  it('parses JSON surrounded by whitespace', () => {
    expect(parser.parse(`\n\n  ${JSON.stringify(VALID)}  \n`).ok).toBe(true);
  });
});

describe('ProposalParser: tolerated formatting', () => {
  it('parses a fenced json block', () => {
    expect(parser.parse('```json\n' + JSON.stringify(VALID) + '\n```').ok).toBe(true);
  });

  it('parses a fence with no language tag', () => {
    expect(parser.parse('```\n' + JSON.stringify(VALID) + '\n```').ok).toBe(true);
  });

  it('parses JSON with a preamble sentence', () => {
    const text = `Here is the proposal you asked for:\n\n${JSON.stringify(VALID)}`;
    expect(parser.parse(text).ok).toBe(true);
  });

  it('parses JSON with trailing commentary', () => {
    const text = `${JSON.stringify(VALID)}\n\nLet me know if you would like changes.`;
    expect(parser.parse(text).ok).toBe(true);
  });

  it('parses JSON wrapped in both a preamble and a fence', () => {
    const text = `Sure!\n\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\`\nHope that helps.`;
    expect(parser.parse(text).ok).toBe(true);
  });
});

describe('ProposalParser: braces inside strings', () => {
  it('parses code containing braces and quotes', () => {
    const tricky = {
      ...VALID,
      blocks: [
        {
          id: 'b1',
          type: 'code',
          description: 'object literal',
          code: 'const o = { a: "}{", b: [1, 2] };\nconst s = \'{"nested": true}\';\n',
        },
      ],
    };
    const result = parser.parse(JSON.stringify(tricky));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.blocks[0]!.code).toContain('"}{"');
    }
  });

  it('parses code containing a closing brace in a string, with prose after it', () => {
    // A naive `lastIndexOf('}')` slice would swallow the trailing prose here.
    const tricky = {
      ...VALID,
      blocks: [{ id: 'b1', type: 'code', description: '', code: 'const t = "}";\n' }],
    };
    const text = `${JSON.stringify(tricky)}\n\nDone.`;
    const result = parser.parse(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.blocks[0]!.code).toBe('const t = "}";\n');
    }
  });
});

describe('ProposalParser: rejections', () => {
  it('rejects an empty response', () => {
    const result = parser.parse('');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/empty/i);
    }
  });

  it('rejects pure prose, explaining what happened', () => {
    const result = parser.parse('I would suggest creating a service class that handles users.');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/no json object/i);
    }
  });

  it('rejects malformed JSON', () => {
    const result = parser.parse('{"type":"code_proposal","filePath":"a.ts",,}');
    expect(result.ok).toBe(false);
  });

  it('rejects valid JSON that is not a proposal', () => {
    const result = parser.parse(JSON.stringify({ title: 'Do a thing', reason: 'because' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not a code_proposal/i);
    }
  });

  it('rejects a proposal with no blocks array', () => {
    const result = parser.parse(JSON.stringify({ type: 'code_proposal', filePath: 'a.ts' }));
    expect(result.ok).toBe(false);
  });

  it('handles a non-string input defensively', () => {
    expect(parser.parse(null as unknown as string).ok).toBe(false);
    expect(parser.parse(undefined as unknown as string).ok).toBe(false);
  });
});

describe('ProposalParser: choosing among candidates', () => {
  it('prefers a real proposal over an unrelated JSON object', () => {
    const text = [
      'Here is some metadata: {"note":"hello"}',
      '',
      'And the proposal:',
      JSON.stringify(VALID),
    ].join('\n');
    const result = parser.parse(text);
    expect(result.ok).toBe(true);
  });

  it('picks the enclosing object when a nested one is also balanced', () => {
    const text = `prefix ${JSON.stringify(VALID)} suffix`;
    const result = parser.parse(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The nested block object is balanced too; the outer one must win.
      expect(result.proposal.blocks).toHaveLength(1);
    }
  });
});

describe('extractBalancedObjects', () => {
  it('finds a top-level object', () => {
    expect(extractBalancedObjects('{"filePath":"a.ts"}')).toEqual(['{"filePath":"a.ts"}']);
  });

  it('ignores an unbalanced fragment', () => {
    expect(extractBalancedObjects('{"filePath":"a.ts"')).toEqual([]);
  });

  it('does not miscount a brace inside a string', () => {
    const text = '{"code":"a { b","filePath":"x.ts"}';
    expect(extractBalancedObjects(text)).toHaveLength(1);
  });

  it('does not miscount an escaped quote', () => {
    const text = '{"code":"say \\"hi\\" {","filePath":"x.ts"}';
    expect(extractBalancedObjects(text)).toHaveLength(1);
  });

  it('sorts longest first, so the enclosing payload is preferred', () => {
    const text = '{"a":{"code_proposal":1},"b":2}';
    const found = extractBalancedObjects(text);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]).toBe(text);
  });

  it('returns nothing for text with no objects', () => {
    expect(extractBalancedObjects('no braces here')).toEqual([]);
  });
});

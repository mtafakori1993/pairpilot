/**
 * ProposalValidator tests.
 *
 * These verify spec section 7's rule that AI output is never trusted: paths are
 * re-checked, deletion is unrepresentable, and the approval hash binds a decision
 * to the exact reviewed content.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProposalValidator, assembleCode, hashProposal } from '../../src/proposals/ProposalValidator';
import { PathGuard } from '../../src/security/PathGuard';
import { ProposalInvalidError } from '../../src/core/errors';
import type { CodeProposal } from '../../src/types';

let root: string;
let validator: ProposalValidator;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pairpilot-validator-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'existing.ts'), 'export const existing = true;\n');
  validator = new ProposalValidator(new PathGuard(root));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function proposal(overrides: Partial<CodeProposal> = {}): CodeProposal {
  return {
    type: 'code_proposal',
    filePath: 'src/new-service.ts',
    operation: 'create',
    description: 'Create a new service',
    dependencies: [],
    blocks: [
      {
        id: 'block-001',
        type: 'class',
        description: 'The service',
        code: 'export class NewService {}\n',
      },
    ],
    ...overrides,
  };
}

/** Collect the issues from a validation failure. */
function issuesFrom(fn: () => unknown): string[] {
  try {
    fn();
    return [];
  } catch (error) {
    if (error instanceof ProposalInvalidError) {
      return error.issues;
    }
    throw error;
  }
}

describe('ProposalValidator: happy path', () => {
  it('validates a well-formed create proposal', () => {
    const validated = validator.validate(proposal());
    expect(validated.relativePath).toBe('src/new-service.ts');
    expect(validated.proposal.operation).toBe('create');
    expect(validated.assembledCode).toBe('export class NewService {}\n');
    expect(validated.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('validates an update proposal for an existing file', () => {
    const validated = validator.validate(
      proposal({
        filePath: 'src/existing.ts',
        operation: 'update',
        blocks: [{ id: 'b', type: 'code', description: '', code: 'export const existing = false;\n' }],
      })
    );
    expect(validated.proposal.operation).toBe('update');
  });

  it('normalises the path in the returned proposal', () => {
    const validated = validator.validate(proposal({ filePath: 'src\\nested\\thing.ts' }));
    expect(validated.relativePath).toBe('src/nested/thing.ts');
  });
});

describe('ProposalValidator: paths are untrusted', () => {
  it('rejects a parent traversal', () => {
    const issues = issuesFrom(() => validator.validate(proposal({ filePath: '../outside.ts' })));
    expect(issues.join(' ')).toMatch(/\.\.|not writable|outside/i);
  });

  it('rejects an absolute POSIX path', () => {
    const issues = issuesFrom(() => validator.validate(proposal({ filePath: '/etc/passwd' })));
    expect(issues.join(' ')).toMatch(/absolute/i);
  });

  it('rejects an absolute Windows path', () => {
    const issues = issuesFrom(() => validator.validate(proposal({ filePath: 'C:\\Windows\\x.ts' })));
    expect(issues.join(' ')).toMatch(/absolute/i);
  });

  it('rejects a path into node_modules', () => {
    const issues = issuesFrom(() =>
      validator.validate(proposal({ filePath: 'node_modules/evil/index.js' }))
    );
    expect(issues.join(' ')).toMatch(/not writable|dependency|build output/i);
  });

  it('rejects a path into build output nested mid-tree', () => {
    const issues = issuesFrom(() =>
      validator.validate(proposal({ filePath: 'packages/app/dist/bundle.js' }))
    );
    expect(issues.join(' ')).toMatch(/build output|not writable/i);
  });

  it('rejects a private key path', () => {
    const issues = issuesFrom(() => validator.validate(proposal({ filePath: 'keys/id_rsa.ts' })));
    expect(issues.join(' ')).toMatch(/not writable/i);
  });

  it('rejects writing to .env', () => {
    const issues = issuesFrom(() => validator.validate(proposal({ filePath: '.env' })));
    expect(issues.join(' ')).toMatch(/sensitive|not writable/i);
  });

  it('rejects a missing filePath', () => {
    const issues = issuesFrom(() =>
      validator.validate(proposal({ filePath: undefined as unknown as string }))
    );
    expect(issues.join(' ')).toMatch(/no filePath/i);
  });

  it('rejects an over-long path', () => {
    const issues = issuesFrom(() =>
      validator.validate(proposal({ filePath: `src/${'a'.repeat(600)}.ts` }))
    );
    expect(issues.join(' ')).toMatch(/exceeds/i);
  });
});

describe('ProposalValidator: deletion is unrepresentable', () => {
  it('rejects a delete operation', () => {
    const issues = issuesFrom(() =>
      validator.validate(proposal({ operation: 'delete' as unknown as 'create' }))
    );
    expect(issues.join(' ')).toMatch(/unsupported operation|deletion is disabled/i);
  });

  it('rejects a hallucinated operation', () => {
    const issues = issuesFrom(() =>
      validator.validate(proposal({ operation: 'rename' as unknown as 'create' }))
    );
    expect(issues.join(' ')).toMatch(/unsupported operation/i);
  });
});

describe('ProposalValidator: operation must match reality', () => {
  it('refuses create over an existing file, so nothing is silently overwritten', () => {
    const issues = issuesFrom(() =>
      validator.validate(proposal({ filePath: 'src/existing.ts', operation: 'create' }))
    );
    expect(issues.join(' ')).toMatch(/already exists/i);
  });

  it('refuses update of a missing file, and points at create', () => {
    const issues = issuesFrom(() =>
      validator.validate(proposal({ filePath: 'src/ghost.ts', operation: 'update' }))
    );
    expect(issues.join(' ')).toMatch(/does not exist/i);
  });
});

describe('ProposalValidator: blocks', () => {
  it('rejects an empty block list', () => {
    const issues = issuesFrom(() => validator.validate(proposal({ blocks: [] })));
    expect(issues.join(' ')).toMatch(/no code blocks/i);
  });

  it('rejects a block with no code', () => {
    const issues = issuesFrom(() =>
      validator.validate(proposal({ blocks: [{ id: 'b', type: 'x', description: '', code: '' }] }))
    );
    expect(issues.join(' ')).toMatch(/empty code/i);
  });

  it('rejects a block whose code is not a string', () => {
    const issues = issuesFrom(() =>
      validator.validate(
        proposal({
          blocks: [{ id: 'b', type: 'x', description: '', code: 42 as unknown as string }],
        })
      )
    );
    expect(issues.join(' ')).toMatch(/no "code" string/i);
  });

  it('rejects an oversized block', () => {
    const issues = issuesFrom(() =>
      validator.validate(
        proposal({ blocks: [{ id: 'b', type: 'x', description: '', code: 'x'.repeat(500_000) }] })
      )
    );
    expect(issues.join(' ')).toMatch(/exceeds/i);
  });

  it('warns about placeholder text rather than silently accepting a stub', () => {
    const validated = validator.validate(
      proposal({
        blocks: [
          {
            id: 'b',
            type: 'code',
            description: '',
            code: 'export class A {\n  // TODO: implement the rest of the methods\n}\n',
          },
        ],
      })
    );
    expect(validated.warnings.join(' ')).toMatch(/placeholder|incomplete/i);
  });

  it('generates an id when the AI omits one', () => {
    const validated = validator.validate(
      proposal({ blocks: [{ id: '', type: 'code', description: '', code: 'const a = 1;\n' }] })
    );
    expect(validated.proposal.blocks[0]!.id).toBe('block-001');
  });

  it('renames duplicate block ids and warns', () => {
    const validated = validator.validate(
      proposal({
        blocks: [
          { id: 'same', type: 'a', description: '', code: 'const a = 1;\n' },
          { id: 'same', type: 'b', description: '', code: 'const b = 2;\n' },
        ],
      })
    );
    expect(validated.proposal.blocks[0]!.id).toBe('same');
    expect(validated.proposal.blocks[1]!.id).toBe('same-2');
    expect(validated.warnings.join(' ')).toMatch(/duplicate/i);
  });
});

describe('ProposalValidator: description is required for review', () => {
  it('rejects a proposal with no description', () => {
    const issues = issuesFrom(() =>
      validator.validate(proposal({ description: '   ' }))
    );
    expect(issues.join(' ')).toMatch(/no description/i);
  });
});

describe('ProposalValidator: the approval hash', () => {
  it('is stable for identical content', () => {
    const a = validator.validate(proposal());
    const b = validator.validate(proposal());
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('changes when the code changes', () => {
    const a = validator.validate(proposal());
    const b = validator.validate(
      proposal({
        blocks: [{ id: 'block-001', type: 'class', description: 'The service', code: 'export class Other {}\n' }],
      })
    );
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it('changes when the path changes', () => {
    // This is the property that stops an approved write being redirected: a
    // swapped target must invalidate the approval.
    const a = validator.validate(proposal({ filePath: 'src/one.ts' }));
    const b = validator.validate(proposal({ filePath: 'src/two.ts' }));
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it('changes when the operation changes', () => {
    const createHash = hashProposal('create', 'src/x.ts', [
      { id: 'b', type: 'c', description: '', code: 'x' },
    ]);
    const updateHash = hashProposal('update', 'src/x.ts', [
      { id: 'b', type: 'c', description: '', code: 'x' },
    ]);
    expect(createHash).not.toBe(updateHash);
  });

  it('changes when a block is added', () => {
    const one = hashProposal('create', 'src/x.ts', [
      { id: 'a', type: 'c', description: '', code: 'A' },
    ]);
    const two = hashProposal('create', 'src/x.ts', [
      { id: 'a', type: 'c', description: '', code: 'A' },
      { id: 'b', type: 'c', description: '', code: 'B' },
    ]);
    expect(one).not.toBe(two);
  });
});

describe('assembleCode', () => {
  it('joins blocks with newlines and ends with one', () => {
    expect(
      assembleCode([
        { id: 'a', type: 'c', description: '', code: 'const a = 1;' },
        { id: 'b', type: 'c', description: '', code: 'const b = 2;' },
      ])
    ).toBe('const a = 1;\nconst b = 2;\n');
  });

  it('does not double a trailing newline', () => {
    expect(assembleCode([{ id: 'a', type: 'c', description: '', code: 'x\n' }])).toBe('x\n');
  });

  it('returns an empty string for no blocks', () => {
    expect(assembleCode([])).toBe('');
  });
});

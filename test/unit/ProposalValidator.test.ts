/**
 * ProposalValidator tests.
 *
 * These verify spec section 7's rule that AI output is never trusted: paths are
 * re-checked, deletion is unrepresentable, and the approval hash binds a decision
 * to the exact reviewed bytes.
 *
 * Since 0.2 a proposal is a *change set* rather than a single file, so the
 * assertions come in two groups: the per-file rules that were always there, and
 * the set-level rules that multi-file writing made necessary — duplicate targets,
 * dependency ordering, and a group hash that lets one approval cover a set
 * without weakening what an approval means.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ProposalValidator,
  assembleCode,
  hashChangeSet,
  hashProposal,
  toValidatedProposal,
} from '../../src/proposals/ProposalValidator';
import { PathGuard } from '../../src/security/PathGuard';
import { ProposalInvalidError } from '../../src/core/errors';
import { PAIRPILOT_PROTOCOL_VERSION } from '../../src/protocol/types';
import type { CodeProposalMessage, ProposalChange } from '../../src/protocol/types';
import type { ProposalBlock } from '../../src/types';

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

/** One canonical change, with overrides. */
function change(overrides: Partial<ProposalChange> = {}): ProposalChange {
  return {
    id: 'change_001',
    file: 'src/new-service.ts',
    operation: 'create',
    description: 'Create a new service',
    content: 'export class NewService {}\n',
    dependencies: [],
    risk: 'low',
    ...overrides,
  };
}

/** A one-change proposal message. */
function proposal(overrides: Partial<ProposalChange> = {}): CodeProposalMessage {
  return {
    protocol_version: PAIRPILOT_PROTOCOL_VERSION,
    type: 'code_proposal',
    message: 'Here is the change.',
    changes: [change(overrides)],
    summary: { files_to_create: 1, files_to_update: 0, files_to_delete: 0 },
  };
}

/** A proposal over several changes. */
function multi(...changes: ProposalChange[]): CodeProposalMessage {
  return {
    protocol_version: PAIRPILOT_PROTOCOL_VERSION,
    type: 'code_proposal',
    message: 'Here are the changes.',
    changes,
    summary: { files_to_create: changes.length, files_to_update: 0, files_to_delete: 0 },
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

/* -------------------------------------------------------------------------- */
/* Happy path                                                                 */
/* -------------------------------------------------------------------------- */

describe('ProposalValidator: happy path', () => {
  it('validates a well-formed create proposal', () => {
    const set = validator.validateChangeSet(proposal());
    expect(set.changes).toHaveLength(1);
    const validated = set.changes[0]!;
    expect(validated.relativePath).toBe('src/new-service.ts');
    expect(validated.change.operation).toBe('create');
    expect(validated.assembledCode).toBe('export class NewService {}\n');
    expect(validated.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('validates an update proposal for an existing file', () => {
    const set = validator.validateChangeSet(
      proposal({
        file: 'src/existing.ts',
        operation: 'update',
        content: 'export const existing = false;\n',
      })
    );
    expect(set.changes[0]!.change.operation).toBe('update');
  });

  it('normalises a backslash path', () => {
    const set = validator.validateChangeSet(proposal({ file: 'src\\nested\\thing.ts' }));
    expect(set.changes[0]!.relativePath).toBe('src/nested/thing.ts');
  });

  it('adds a trailing newline so the file on disk ends cleanly', () => {
    const set = validator.validateChangeSet(proposal({ content: 'const a = 1;' }));
    expect(set.changes[0]!.assembledCode).toBe('const a = 1;\n');
  });

  it('preserves the envelope for the review panel', () => {
    const message = proposal();
    const set = validator.validateChangeSet(message);
    expect(set.envelope).toBe(message);
  });
});

/* -------------------------------------------------------------------------- */
/* Paths are untrusted                                                        */
/* -------------------------------------------------------------------------- */

describe('ProposalValidator: paths are untrusted', () => {
  it('rejects a parent traversal', () => {
    const issues = issuesFrom(() => validator.validateChangeSet(proposal({ file: '../outside.ts' })));
    expect(issues.join(' ')).toMatch(/\.\.|not writable|outside/i);
  });

  it('rejects a traversal hidden mid-path', () => {
    const issues = issuesFrom(() =>
      validator.validateChangeSet(proposal({ file: 'src/../../outside.ts' }))
    );
    expect(issues.join(' ')).toMatch(/\.\./);
  });

  it('rejects an absolute POSIX path', () => {
    const issues = issuesFrom(() => validator.validateChangeSet(proposal({ file: '/etc/passwd' })));
    expect(issues.join(' ')).toMatch(/absolute/i);
  });

  it('rejects an absolute Windows path', () => {
    const issues = issuesFrom(() =>
      validator.validateChangeSet(proposal({ file: 'C:\\Windows\\x.ts' }))
    );
    expect(issues.join(' ')).toMatch(/absolute/i);
  });

  it('rejects a path into node_modules', () => {
    const issues = issuesFrom(() =>
      validator.validateChangeSet(proposal({ file: 'node_modules/evil/index.js' }))
    );
    expect(issues.join(' ')).toMatch(/not writable|dependency|build output/i);
  });

  it('rejects a path into build output nested mid-tree', () => {
    const issues = issuesFrom(() =>
      validator.validateChangeSet(proposal({ file: 'packages/app/dist/bundle.js' }))
    );
    expect(issues.join(' ')).toMatch(/build output|not writable/i);
  });

  it('rejects a private key path', () => {
    const issues = issuesFrom(() =>
      validator.validateChangeSet(proposal({ file: 'keys/id_rsa.ts' }))
    );
    expect(issues.join(' ')).toMatch(/not writable/i);
  });

  it('rejects writing to .env', () => {
    const issues = issuesFrom(() => validator.validateChangeSet(proposal({ file: '.env' })));
    expect(issues.join(' ')).toMatch(/sensitive|not writable/i);
  });

  it('rejects a missing file path', () => {
    const issues = issuesFrom(() =>
      validator.validateChangeSet(proposal({ file: undefined as unknown as string }))
    );
    expect(issues.join(' ')).toMatch(/no file path/i);
  });

  it('rejects an over-long path', () => {
    const issues = issuesFrom(() =>
      validator.validateChangeSet(proposal({ file: `src/${'a'.repeat(600)}.ts` }))
    );
    expect(issues.join(' ')).toMatch(/exceeds/i);
  });

  it('names the offending change when one of many is bad', () => {
    const issues = issuesFrom(() =>
      validator.validateChangeSet(
        multi(change(), change({ id: 'change_002', file: '../escape.ts' }))
      )
    );
    expect(issues.join(' ')).toMatch(/Change 2/);
  });
});

/* -------------------------------------------------------------------------- */
/* Deletion and unknown operations                                            */
/* -------------------------------------------------------------------------- */

describe('ProposalValidator: deletion is unrepresentable', () => {
  it('rejects a delete operation even if it reached the validator', () => {
    // The schema refuses `delete` too; this asserts the second lock on the same
    // door, because a future caller could construct the message by hand.
    const issues = issuesFrom(() =>
      validator.validateChangeSet(
        proposal({ operation: 'delete' as unknown as 'create', content: '' })
      )
    );
    expect(issues.join(' ')).toMatch(/cannot be applied|deletion is disabled/i);
  });

  it('rejects a hallucinated operation', () => {
    const issues = issuesFrom(() =>
      validator.validateChangeSet(proposal({ operation: 'rename' as unknown as 'create' }))
    );
    expect(issues.join(' ')).toMatch(/cannot be applied/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Operation must match reality                                               */
/* -------------------------------------------------------------------------- */

describe('ProposalValidator: operation must match reality', () => {
  it('refuses create over an existing file, so nothing is silently overwritten', () => {
    const issues = issuesFrom(() =>
      validator.validateChangeSet(proposal({ file: 'src/existing.ts', operation: 'create' }))
    );
    expect(issues.join(' ')).toMatch(/already exists/i);
  });

  it('refuses update of a missing file, and points at create', () => {
    const issues = issuesFrom(() =>
      validator.validateChangeSet(proposal({ file: 'src/ghost.ts', operation: 'update' }))
    );
    expect(issues.join(' ')).toMatch(/does not exist/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Content                                                                    */
/* -------------------------------------------------------------------------- */

describe('ProposalValidator: content', () => {
  it('rejects a change with no content', () => {
    const issues = issuesFrom(() =>
      validator.validateChangeSet(proposal({ content: '   ' }))
    );
    expect(issues.join(' ')).toMatch(/no file content/i);
  });

  it('warns about placeholder text rather than silently accepting a stub', () => {
    const set = validator.validateChangeSet(
      proposal({ content: 'export class A {\n  // TODO: implement the rest of the methods\n}\n' })
    );
    expect(set.warnings.join(' ')).toMatch(/placeholder|incomplete/i);
  });

  it('warns about a file it does not recognise as source', () => {
    const set = validator.validateChangeSet(proposal({ file: 'src/data.weirdext', content: 'x\n' }));
    expect(set.warnings.join(' ')).toMatch(/does not recognise/i);
  });

  it('warns about an unusually large file', () => {
    const set = validator.validateChangeSet(proposal({ content: 'x'.repeat(150_000) }));
    expect(set.warnings.join(' ')).toMatch(/unusually large/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Multi-file behaviour                                                       */
/* -------------------------------------------------------------------------- */

describe('ProposalValidator: change sets', () => {
  it('validates every change in a set', () => {
    const set = validator.validateChangeSet(
      multi(change(), change({ id: 'change_002', file: 'src/other.ts' }))
    );
    expect(set.changes.map((entry) => entry.relativePath)).toEqual([
      'src/new-service.ts',
      'src/other.ts',
    ]);
  });

  it('refuses two changes that target the same file', () => {
    // The second would silently discard the first, and the developer would have
    // approved a file that never existed in that form.
    const issues = issuesFrom(() =>
      validator.validateChangeSet(multi(change(), change({ id: 'change_002' })))
    );
    expect(issues.join(' ')).toMatch(/already targets/i);
  });

  it('refuses a change set with no changes at all', () => {
    const issues = issuesFrom(() =>
      validator.validateChangeSet({ ...proposal(), changes: [] })
    );
    expect(issues.join(' ')).toMatch(/at least one file change/i);
  });

  it('reports every failing change, not just the first', () => {
    const issues = issuesFrom(() =>
      validator.validateChangeSet(
        multi(change({ file: '../one.ts' }), change({ id: 'c2', file: '/two.ts' }))
      )
    );
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });

  it('does not write anything when one change of many is refused', () => {
    // The whole point of set-level validation: a set is applied or it is not.
    expect(
      issuesFrom(() =>
        validator.validateChangeSet(
          multi(change(), change({ id: 'c2', file: 'src/existing.ts', operation: 'create' }))
        )
      ).length
    ).toBeGreaterThan(0);
  });

  it('records where each change came from in the sent reply', () => {
    const set = validator.validateChangeSet(
      multi(change({ id: 'a', file: 'src/a.ts' }), change({ id: 'b', file: 'src/b.ts' }))
    );
    // The stream scanner indexes live code by the position in the reply, so the
    // mapping has to survive validation.
    const indices = set.changes.map((entry) => entry.sourceIndex).sort();
    expect(indices).toEqual([0, 1]);
  });
});

/* -------------------------------------------------------------------------- */
/* Dependency ordering                                                        */
/* -------------------------------------------------------------------------- */

describe('ProposalValidator: dependency ordering', () => {
  it('writes a dependency before the file that needs it', () => {
    const set = validator.validateChangeSet(
      multi(
        change({ id: 'b', file: 'src/b.ts', content: 'import { a } from "./a";\n', dependencies: ['src/a.ts'] }),
        change({ id: 'a', file: 'src/a.ts', content: 'export const a = 1;\n' })
      )
    );
    expect(set.changes.map((entry) => entry.relativePath)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('keeps the declared order when there are no dependencies', () => {
    const set = validator.validateChangeSet(
      multi(change({ id: 'a', file: 'src/a.ts' }), change({ id: 'b', file: 'src/b.ts' }))
    );
    expect(set.changes.map((entry) => entry.relativePath)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('does not reorder for a package dependency, which no change can provide', () => {
    const set = validator.validateChangeSet(
      multi(change({ id: 'a', file: 'src/a.ts', dependencies: ['express'] }), change({ id: 'b', file: 'src/b.ts' }))
    );
    expect(set.changes.map((entry) => entry.relativePath)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('warns about a dependency the proposal neither creates nor finds', () => {
    const set = validator.validateChangeSet(
      proposal({ dependencies: ['src/missing-helper.ts'] })
    );
    expect(set.warnings.join(' ')).toMatch(/missing-helper|does not (exist|create)/i);
  });

  it('does not warn about a dependency that is already on disk', () => {
    const set = validator.validateChangeSet(
      proposal({ file: 'src/uses-existing.ts', dependencies: ['src/existing.ts'] })
    );
    expect(set.warnings.join(' ')).not.toMatch(/existing\.ts/);
  });

  it('survives a dependency cycle, keeping the declared order and warning', () => {
    const set = validator.validateChangeSet(
      multi(
        change({ id: 'a', file: 'src/a.ts', dependencies: ['src/b.ts'] }),
        change({ id: 'b', file: 'src/b.ts', dependencies: ['src/a.ts'] })
      )
    );
    expect(set.changes).toHaveLength(2);
    expect(set.warnings.join(' ')).toMatch(/circular|cycle/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Approval hashes                                                            */
/* -------------------------------------------------------------------------- */

describe('ProposalValidator: the approval hash', () => {
  it('is stable for identical content', () => {
    const a = validator.validateChangeSet(proposal());
    const b = validator.validateChangeSet(proposal());
    expect(a.changes[0]!.contentHash).toBe(b.changes[0]!.contentHash);
    expect(a.changeSetHash).toBe(b.changeSetHash);
  });

  it('changes when the content changes', () => {
    const a = validator.validateChangeSet(proposal());
    const b = validator.validateChangeSet(proposal({ content: 'export class Other {}\n' }));
    expect(a.changes[0]!.contentHash).not.toBe(b.changes[0]!.contentHash);
    expect(a.changeSetHash).not.toBe(b.changeSetHash);
  });

  it('changes when the path changes', () => {
    // This is the property that stops an approved write being redirected: a
    // swapped target must invalidate the approval.
    const a = validator.validateChangeSet(proposal({ file: 'src/one.ts' }));
    const b = validator.validateChangeSet(proposal({ file: 'src/two.ts' }));
    expect(a.changes[0]!.contentHash).not.toBe(b.changes[0]!.contentHash);
    expect(a.changeSetHash).not.toBe(b.changeSetHash);
  });

  it('changes when the operation changes', () => {
    const createHash = hashProposal('create', 'src/x.ts', blocksOf('x'));
    const updateHash = hashProposal('update', 'src/x.ts', blocksOf('x'));
    expect(createHash).not.toBe(updateHash);
  });

  it('changes when a file is added to the set', () => {
    const one = validator.validateChangeSet(proposal());
    const two = validator.validateChangeSet(
      multi(change(), change({ id: 'c2', file: 'src/other.ts' }))
    );
    expect(one.changeSetHash).not.toBe(two.changeSetHash);
  });

  it('is computed over the write order, so the sequence is part of what is approved', () => {
    // Two independent files sent in a different order are two different write
    // sequences, and the developer approves a sequence: the review panel says
    // "change 1 of 2". So the hash must follow the order, not ignore it.
    const a = validator.validateChangeSet(
      multi(change({ id: 'a', file: 'src/a.ts' }), change({ id: 'b', file: 'src/b.ts' }))
    );
    const b = validator.validateChangeSet(
      multi(change({ id: 'b', file: 'src/b.ts' }), change({ id: 'a', file: 'src/a.ts' }))
    );
    expect(a.changeSetHash).not.toBe(b.changeSetHash);
  });

  it('is the same however the reply happened to order a dependent pair', () => {
    // Here dependency sorting fixes the write order, so both replies describe
    // the same sequence and must be the same approval.
    const forwards = validator.validateChangeSet(
      multi(
        change({ id: 'a', file: 'src/a.ts', content: 'export const a = 1;\n' }),
        change({
          id: 'b',
          file: 'src/b.ts',
          content: 'import { a } from "./a";\n',
          dependencies: ['src/a.ts'],
        })
      )
    );
    const backwards = validator.validateChangeSet(
      multi(
        change({
          id: 'b',
          file: 'src/b.ts',
          content: 'import { a } from "./a";\n',
          dependencies: ['src/a.ts'],
        }),
        change({ id: 'a', file: 'src/a.ts', content: 'export const a = 1;\n' })
      )
    );
    expect(forwards.changes.map((entry) => entry.relativePath)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(backwards.changes.map((entry) => entry.relativePath)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(forwards.changeSetHash).toBe(backwards.changeSetHash);
  });

  it('produces a 64-character hex digest for the set', () => {
    const set = validator.validateChangeSet(proposal());
    expect(set.changeSetHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('differs between two sets that share their first file', () => {
    const a = validator.validateChangeSet(
      multi(change(), change({ id: 'c2', file: 'src/x.ts', content: 'export const x = 1;\n' }))
    );
    const b = validator.validateChangeSet(
      multi(change(), change({ id: 'c2', file: 'src/y.ts', content: 'export const x = 1;\n' }))
    );
    expect(a.changeSetHash).not.toBe(b.changeSetHash);
  });

  it('hashChangeSet is stable for identical change lists', () => {
    const one = hashChangeSet([
      {
        change: change(),
        relativePath: 'src/a.ts',
        absolutePath: '/tmp/a.ts',
        contentHash: 'h',
        assembledCode: 'x\n',
        warnings: [],
        sourceIndex: 0,
      },
    ]);
    const two = hashChangeSet([
      {
        change: change(),
        relativePath: 'src/a.ts',
        absolutePath: '/tmp/a.ts',
        contentHash: 'h',
        assembledCode: 'x\n',
        warnings: [],
        sourceIndex: 0,
      },
    ]);
    expect(one).toBe(two);
  });
});

/* -------------------------------------------------------------------------- */
/* The bridge to the 0.1.x per-file machinery                                 */
/* -------------------------------------------------------------------------- */

describe('toValidatedProposal', () => {
  it('maps a change to the shape the writer and review panel use', () => {
    const set = validator.validateChangeSet(proposal());
    const validated = toValidatedProposal(set.changes[0]!, set.envelope);
    expect(validated.relativePath).toBe('src/new-service.ts');
    expect(validated.proposal.filePath).toBe('src/new-service.ts');
    expect(validated.proposal.operation).toBe('create');
    expect(validated.proposal.blocks).toHaveLength(1);
    expect(validated.proposal.blocks[0]!.code).toBe('export class NewService {}\n');
    expect(validated.contentHash).toBe(set.changes[0]!.contentHash);
  });

  it('carries the rationale from the envelope when the change has none', () => {
    const set = validator.validateChangeSet({ ...proposal(), message: 'Because it was asked for.' });
    const validated = toValidatedProposal(set.changes[0]!, set.envelope);
    expect(validated.proposal.rationale).toBe('Because it was asked for.');
  });

  it('prefers the change’s own rationale', () => {
    const set = validator.validateChangeSet(proposal({ rationale: 'Its own reason.' }));
    const validated = toValidatedProposal(set.changes[0]!, set.envelope);
    expect(validated.proposal.rationale).toBe('Its own reason.');
  });

  it('falls back to the task title when the change has no description', () => {
    const message: CodeProposalMessage = {
      ...proposal({ description: '   ' }),
      task: { title: 'User module', description: 'Entity and repository.' },
    };
    // The description is required by the schema, so this exercises the mapping
    // rather than validation: an empty description must not produce an empty
    // review heading.
    const set = validator.validateChangeSet(message);
    const validated = toValidatedProposal(set.changes[0]!, set.envelope);
    expect(validated.proposal.description.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* assembleCode: retained for the block abstraction                           */
/* -------------------------------------------------------------------------- */

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

/** A single-block array, for the hash-construction tests. */
function blocksOf(code: string): ProposalBlock[] {
  return [{ id: 'b', type: 'c', description: '', code }];
}

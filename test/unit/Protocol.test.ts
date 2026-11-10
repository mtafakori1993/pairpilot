/**
 * Protocol tests.
 *
 * These are the regression tests for the reported failure:
 *
 *   Found valid JSON, but it is not a code_proposal object.
 *   PairPilot did not write anything.
 *
 * The reply that produced it was a perfectly good `code_proposal` wrapped in a
 * `proposal` key. The old parser required a root-level `blocks[]`, so it refused
 * the message and blamed the developer's phrasing. Every test in the
 * "adaptation" block below is a shape a real model has actually produced, and
 * each one must now be readable.
 *
 * The tests are organised to match the pipeline the extension actually runs:
 *
 *     extractBalancedObjects  →  raw JSON strings from noisy text
 *     validateProtocolMessage →  canonical message, or per-field issues
 *     parseProtocol           →  the two composed, with adaptation
 *     interpretTurn           →  what the turn should do about it
 */

import { describe, expect, it } from 'vitest';
import { extractBalancedObjects, parseProtocol } from '../../src/protocol/parse';
import { validateProtocolMessage, PROTOCOL_LIMITS } from '../../src/protocol/schema';
import { adaptCandidate } from '../../src/protocol/adapt';
import { interpretTurn, renderMessage } from '../../src/proposals/TurnInterpreter';
import { classifyTurnIntent } from '../../src/protocol/classify';
import { ProtocolDiagnostics, redactSecrets } from '../../src/protocol/diagnostics';
import { PAIRPILOT_PROTOCOL_VERSION } from '../../src/protocol/types';
import { buildCorrectionPrompt } from '../../src/runtime/prompts';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** The reply shape that caused the original bug: nested under `proposal`. */
const NESTED_REPLY = {
  type: 'code_proposal',
  message: 'Here is the User class you asked for.',
  proposal: {
    filePath: 'src/User.php',
    operation: 'create',
    description: 'A PHP user entity',
    dependencies: [],
    blocks: [{ id: 'b1', type: 'code', description: '', code: '<?php\n\nfinal class User {}\n' }],
  },
};

/** The canonical multi-file shape the prompt now specifies. */
const CANONICAL_REPLY = {
  protocol_version: PAIRPILOT_PROTOCOL_VERSION,
  type: 'code_proposal',
  message: 'A user module backed by SQLite.',
  task: { title: 'User module', description: 'Entity, repository and migration.', status: 'proposed' },
  changes: [
    {
      id: 'change_001',
      file: 'src/Domain/User.php',
      operation: 'create',
      language: 'php',
      description: 'The User entity.',
      content: '<?php\n\nfinal class User {}\n',
      dependencies: [],
      risk: 'low',
      rationale: 'Keeps the domain layer free of persistence concerns.',
      responsibilities: ["Hold a user's identity."],
      potentialProblems: ['No email validation yet.'],
    },
    {
      id: 'change_002',
      file: 'src/Infrastructure/UserRepository.php',
      operation: 'create',
      description: 'SQLite-backed repository.',
      content: '<?php\n\nfinal class UserRepository {}\n',
      dependencies: ['src/Domain/User.php'],
      risk: 'medium',
    },
  ],
  nextStep: {
    title: 'Add a repository interface',
    reason: 'The service needs an abstraction before it can be tested.',
    files: ['src/Contracts/UserRepositoryInterface.php'],
    required: true,
  },
};

/** The 0.1.x flat single-file shape, which still arrives from cached prompts. */
const LEGACY_FLAT = {
  type: 'code_proposal',
  filePath: 'src/a.ts',
  operation: 'create',
  description: 'Create a',
  dependencies: [],
  blocks: [{ id: 'b1', type: 'code', description: '', code: 'export const a = 1;\n' }],
};

/** A change with no envelope at all. */
const BARE_CHANGE = {
  file: 'src/lonely.ts',
  operation: 'create',
  description: 'A file on its own',
  content: 'export const lonely = true;\n',
};

/* -------------------------------------------------------------------------- */
/* Extraction                                                                 */
/* -------------------------------------------------------------------------- */

describe('extractBalancedObjects', () => {
  it('finds a top-level object', () => {
    expect(extractBalancedObjects('{"file":"a.ts"}')).toEqual(['{"file":"a.ts"}']);
  });

  it('ignores an unbalanced fragment', () => {
    expect(extractBalancedObjects('{"file":"a.ts"')).toEqual([]);
  });

  it('does not miscount a brace inside a string', () => {
    expect(extractBalancedObjects('{"code":"a { b","file":"x.ts"}')).toHaveLength(1);
  });

  it('does not miscount an escaped quote', () => {
    expect(extractBalancedObjects('{"code":"say \\"hi\\" {","file":"x.ts"}')).toHaveLength(1);
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

  it('does not lose balance on a Persian string containing braces', () => {
    // The `{ }` inside the string is balanced in its own right, so the scan
    // legitimately reports it as a second candidate; what matters is that string
    // tracking did not misplace the *outer* object, which is reported first.
    const text = '{"message":"مجموعه { } خالی است","type":"chat_response"}';
    const found = extractBalancedObjects(text);
    expect(found[0]).toBe(text);
  });
});

/* -------------------------------------------------------------------------- */
/* The reported bug                                                           */
/* -------------------------------------------------------------------------- */

describe('adaptation: the reported failure', () => {
  it('reads a proposal nested under "proposal"', () => {
    const outcome = parseProtocol(JSON.stringify(NESTED_REPLY));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.message.type).toBe('code_proposal');
    expect(outcome.adaptation).toBe('nested_proposal');
  });

  it('carries the nested proposal through to a reviewable change', () => {
    const outcome = parseProtocol(JSON.stringify(NESTED_REPLY));
    if (!outcome.ok || outcome.message.type !== 'code_proposal') {
      throw new Error('expected a code_proposal');
    }
    expect(outcome.message.changes).toHaveLength(1);
    expect(outcome.message.changes[0]!.file).toBe('src/User.php');
    expect(outcome.message.changes[0]!.operation).toBe('create');
    expect(outcome.message.changes[0]!.content).toContain('final class User');
  });

  it('does NOT report "not a code_proposal object" for the nested shape', () => {
    const outcome = parseProtocol(JSON.stringify(NESTED_REPLY));
    expect(outcome.ok).toBe(true);
  });

  it('lifts the same reply when nested under "code_proposal"', () => {
    const reply = {
      type: 'code_proposal',
      message: 'Done.',
      code_proposal: NESTED_REPLY.proposal,
    };
    const outcome = parseProtocol(JSON.stringify(reply));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.adaptation).toBe('nested_proposal');
    }
  });

  it('lifts the same reply when nested under "data"', () => {
    const reply = { type: 'code_proposal', message: 'Done.', data: NESTED_REPLY.proposal };
    expect(parseProtocol(JSON.stringify(reply)).ok).toBe(true);
  });

  it('explains an unreadable proposal with the offending path, not a shrug', () => {
    const reply = {
      type: 'code_proposal',
      message: 'Done.',
      changes: [{ file: 'src/a.ts', operation: 'create', description: 'x' }],
    };
    const outcome = parseProtocol(JSON.stringify(reply));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe('schema');
    expect(outcome.issues[0]!.path).toContain('/changes/0');
    expect(outcome.issues[0]!.message).toMatch(/content/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Canonical shape                                                            */
/* -------------------------------------------------------------------------- */

describe('canonical multi-file proposal', () => {
  it('reads a two-file proposal', () => {
    const outcome = parseProtocol(JSON.stringify(CANONICAL_REPLY));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.message.type !== 'code_proposal') return;
    expect(outcome.message.changes).toHaveLength(2);
    expect(outcome.adaptation).toBe('canonical');
  });

  it('preserves per-change metadata', () => {
    const outcome = parseProtocol(JSON.stringify(CANONICAL_REPLY));
    if (!outcome.ok || outcome.message.type !== 'code_proposal') return;
    const first = outcome.message.changes[0]!;
    expect(first.risk).toBe('low');
    expect(first.language).toBe('php');
    expect(first.rationale).toMatch(/domain layer/i);
    expect(first.responsibilities).toEqual(["Hold a user's identity."]);
    expect(first.potentialProblems).toEqual(['No email validation yet.']);
  });

  it('preserves declared dependencies', () => {
    const outcome = parseProtocol(JSON.stringify(CANONICAL_REPLY));
    if (!outcome.ok || outcome.message.type !== 'code_proposal') return;
    expect(outcome.message.changes[1]!.dependencies).toEqual(['src/Domain/User.php']);
  });

  it('keeps the task envelope and the next step', () => {
    const outcome = parseProtocol(JSON.stringify(CANONICAL_REPLY));
    if (!outcome.ok || outcome.message.type !== 'code_proposal') return;
    expect(outcome.message.task?.title).toBe('User module');
    expect(outcome.message.nextStep?.title).toBe('Add a repository interface');
    expect(outcome.message.nextStep?.required).toBe(true);
  });

  it('infers the create/update summary from the changes themselves', () => {
    const outcome = parseProtocol(JSON.stringify(CANONICAL_REPLY));
    if (!outcome.ok || outcome.message.type !== 'code_proposal') return;
    expect(outcome.message.summary?.files_to_create).toBe(2);
    expect(outcome.message.summary?.files_to_update).toBe(0);
  });

  it('does not mutate the parsed reply while adapting it', () => {
    const before = JSON.stringify(CANONICAL_REPLY);
    parseProtocol(before);
    expect(JSON.stringify(CANONICAL_REPLY)).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/* Every other message type                                                   */
/* -------------------------------------------------------------------------- */

describe('message types', () => {
  const cases: { type: string; body: Record<string, unknown>; expect: string }[] = [
    { type: 'chat_response', body: { message: 'Hello!' }, expect: 'narrative' },
    {
      type: 'project_analysis',
      body: { message: 'A PHP project.', analysis: { stack: ['PHP 8.3'], structure: ['src'] } },
      expect: 'narrative',
    },
    {
      type: 'project_plan',
      body: { message: 'Here is a plan.', plan: { phases: [{ name: 'Foundation', tasks: ['Boot'] }] } },
      expect: 'narrative',
    },
    {
      type: 'code_review',
      body: { message: 'Reviewed.', review: { verdict: 'concerns', findings: [] } },
      expect: 'narrative',
    },
    {
      type: 'engineering_advice',
      body: { message: 'Next.', advice: { title: 'Add tests', reason: 'There are none.' } },
      expect: 'advice',
    },
    {
      type: 'clarification_request',
      body: { message: 'Which database?', clarification: { question: 'Which database?' } },
      expect: 'question',
    },
    {
      type: 'task_update',
      body: { message: 'Working.', task: { title: 'User module', status: 'in_progress' } },
      expect: 'narrative',
    },
    { type: 'error', body: { message: 'Cannot do that.' }, expect: 'narrative' },
  ];

  for (const entry of cases) {
    it(`reads "${entry.type}" as ${entry.expect}`, () => {
      const outcome = parseProtocol(
        JSON.stringify({
          protocol_version: PAIRPILOT_PROTOCOL_VERSION,
          type: entry.type,
          ...entry.body,
        })
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(interpretTurn(JSON.stringify(outcome.message)).kind).toBe(entry.expect);
    });
  }

  it('normalises a normalised vocabulary value', () => {
    const outcome = parseProtocol(
      JSON.stringify({
        type: 'task_update',
        message: 'Working.',
        task: { title: 'T', status: 'In Progress' },
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.message.type === 'task_update') {
      expect(outcome.message.task.status).toBe('in_progress');
    }
  });

  it('rejects an unknown message type by name', () => {
    const outcome = parseProtocol(JSON.stringify({ type: 'file_write', message: 'x' }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues[0]!.code).toBe('unknown_message_type');
      expect(outcome.issues[0]!.message).toContain('file_write');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Tolerated formatting                                                       */
/* -------------------------------------------------------------------------- */

describe('formatting tolerance', () => {
  const payload = JSON.stringify(CANONICAL_REPLY);

  it('reads bare JSON', () => {
    expect(parseProtocol(payload).ok).toBe(true);
  });

  it('reads JSON surrounded by whitespace', () => {
    expect(parseProtocol(`\n\n  ${payload}  \n`).ok).toBe(true);
  });

  it('reads a fenced json block', () => {
    expect(parseProtocol('```json\n' + payload + '\n```').ok).toBe(true);
  });

  it('reads a fence with no language tag', () => {
    expect(parseProtocol('```\n' + payload + '\n```').ok).toBe(true);
  });

  it('reads JSON with a preamble sentence', () => {
    expect(parseProtocol(`Here is the proposal you asked for:\n\n${payload}`).ok).toBe(true);
  });

  it('reads JSON with trailing commentary', () => {
    expect(parseProtocol(`${payload}\n\nLet me know if you would like changes.`).ok).toBe(true);
  });

  it('reads JSON wrapped in both a preamble and a fence', () => {
    expect(parseProtocol(`Sure!\n\n\`\`\`json\n${payload}\n\`\`\`\nHope that helps.`).ok).toBe(true);
  });

  it('reads a reply whose JSON carries a BOM', () => {
    expect(parseProtocol('﻿' + payload).ok).toBe(true);
  });

  it('keeps brace-bearing code intact', () => {
    const tricky = {
      type: 'code_proposal',
      message: 'Done.',
      changes: [
        {
          file: 'src/a.ts',
          operation: 'create',
          description: 'object literal',
          content: 'const o = { a: "}{", b: [1, 2] };\nconst s = \'{"nested": true}\';\n',
        },
      ],
    };
    const outcome = parseProtocol(JSON.stringify(tricky) + '\n\nDone.');
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.message.type === 'code_proposal') {
      expect(outcome.message.changes[0]!.content).toContain('"}{"');
    }
  });

  it('picks the enclosing object when a nested one is balanced too', () => {
    const outcome = parseProtocol(`prefix ${JSON.stringify(CANONICAL_REPLY)} suffix`);
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.message.type === 'code_proposal') {
      expect(outcome.message.changes).toHaveLength(2);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Internationalisation                                                       */
/* -------------------------------------------------------------------------- */

describe('unicode and right-to-left content', () => {
  it('round-trips Persian prose exactly', () => {
    const text = 'سلام! من آمادهام تا به شما در ساخت این پروژه کمک کنم.';
    const outcome = parseProtocol(JSON.stringify({ type: 'chat_response', message: text }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.message.message).toBe(text);
    }
  });

  it('round-trips Persian code comments and identifiers', () => {
    const content = '<?php\n\n// ثبت نام کاربر\nfunction ثبت_نام() {}\n';
    const outcome = parseProtocol(
      JSON.stringify({
        type: 'code_proposal',
        message: 'فایل ساخته شد.',
        changes: [{ file: 'src/User.php', operation: 'create', description: 'ثبت نام', content }],
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.message.type === 'code_proposal') {
      expect(outcome.message.changes[0]!.content).toBe(content);
    }
  });

  it('measures limits in code points, not UTF-16 units', () => {
    // A description of emoji is short by characters but long by code units.
    const description = '🎯'.repeat(50);
    const outcome = parseProtocol(
      JSON.stringify({
        type: 'code_proposal',
        message: 'ok',
        changes: [{ file: 'src/a.ts', operation: 'create', description, content: 'x\n' }],
      })
    );
    expect(outcome.ok).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Failure modes                                                              */
/* -------------------------------------------------------------------------- */

describe('failures are specific', () => {
  it('reports an empty reply as empty', () => {
    const outcome = parseProtocol('');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe('empty');
    }
  });

  it('reports prose as prose — not as a schema error', () => {
    const outcome = parseProtocol('I would suggest creating a service class that handles users.');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe('no_json');
    }
    // The parse layer reports "there is no JSON here" — that is all it can know.
    // The interpreter then decides what a JSON-less reply *means*, and for a
    // reply that is entirely words the answer is "this is the model's answer",
    // not "this is a broken message". Treating the two as the same failure is
    // what made "Hi" come back as a protocol error.
    const prose = interpretTurn('just words');
    expect(prose.kind).toBe('narrative');
    if (prose.kind === 'narrative') {
      expect(prose.adaptation).toBe('prose');
      expect(prose.message.type).toBe('chat_response');
      expect(renderMessage(prose.message)).toBe('just words');
    }
  });

  it('reports malformed JSON as unparsable', () => {
    const outcome = parseProtocol('{"type":"code_proposal","changes":[,]}');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe('unparsable');
    }
    const malformed = interpretTurn('{"a":,}');
    expect(malformed.kind).toBe('failure');
    if (malformed.kind === 'failure') {
      expect(malformed.retryable).toBe(false);
    }
  });

  it('marks a schema failure as retryable, because a better prompt can fix it', () => {
    const reply = JSON.stringify({ type: 'code_proposal', message: 'Done.', changes: [] });
    const interpretation = interpretTurn(reply);
    expect(interpretation.kind).toBe('failure');
    if (interpretation.kind === 'failure') {
      expect(interpretation.retryable).toBe(true);
      expect(interpretation.failure.issues.length).toBeGreaterThan(0);
    }
  });

  it('rejects an unsupported protocol version with an actionable message', () => {
    const outcome = parseProtocol(
      JSON.stringify({ protocol_version: '9.9', type: 'chat_response', message: 'hi' })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues[0]!.code).toBe('unsupported_version');
      expect(outcome.issues[0]!.message).toContain(PAIRPILOT_PROTOCOL_VERSION);
    }
  });

  it('accepts a missing protocol version and notes the assumption', () => {
    const outcome = parseProtocol(JSON.stringify({ type: 'chat_response', message: 'hi' }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.notes.join(' ')).toMatch(/protocol_version/i);
    }
  });

  it('refuses a reserved operation, telling the model what to send instead', () => {
    const reply = {
      type: 'code_proposal',
      message: 'Patching.',
      changes: [
        { file: 'src/a.ts', operation: 'patch', description: 'A patch', content: 'x\n' },
      ],
    };
    const outcome = parseProtocol(JSON.stringify(reply));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      const reserved = outcome.issues.find((issue) => issue.code === 'reserved_operation');
      expect(reserved, JSON.stringify(outcome.issues)).toBeDefined();
      expect(reserved!.message).toMatch(/update/i);
    }
  });

  it('makes "delete" unrepresentable', () => {
    const reply = {
      type: 'code_proposal',
      message: 'Deleting.',
      changes: [{ file: 'src/a.ts', operation: 'delete', description: 'Remove it', content: '' }],
    };
    expect(parseProtocol(JSON.stringify(reply)).ok).toBe(false);
  });

  it('reports a duplicate change rather than silently dropping one', () => {
    const reply = {
      type: 'code_proposal',
      message: 'Twice.',
      changes: [
        { file: 'src/a.ts', operation: 'create', description: 'First', content: 'a\n' },
        { file: 'src/a.ts', operation: 'create', description: 'Second', content: 'b\n' },
      ],
    };
    const outcome = parseProtocol(JSON.stringify(reply));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues.some((issue) => issue.code === 'duplicate_change')).toBe(true);
    }
  });

  it('refuses a proposal beyond the change limit', () => {
    const changes = Array.from({ length: PROTOCOL_LIMITS.maxChanges + 1 }, (_, index) => ({
      file: `src/f${index}.ts`,
      operation: 'create',
      description: `File ${index}`,
      content: 'x\n',
    }));
    const outcome = parseProtocol(JSON.stringify({ type: 'code_proposal', message: 'Many.', changes }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues[0]!.code).toBe('too_many_changes');
    }
  });

  it('handles a non-string input defensively', () => {
    expect(parseProtocol(null as unknown as string).ok).toBe(false);
    expect(parseProtocol(undefined as unknown as string).ok).toBe(false);
    expect(parseProtocol(42 as unknown as string).ok).toBe(false);
  });

  it('rejects a JSON array at the root', () => {
    const outcome = parseProtocol('[{"file":"a.ts"}]');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues[0]!.code).toBe('not_an_object');
    }
  });

  it('never throws while reading hostile input', () => {
    const hostile = [
      '{"a":' + '"x"'.repeat(5000),
      '{"type":"code_proposal","changes":[{"file":"' + '../'.repeat(500) + 'x.ts"}]}',
      '{"type":"\\u0000","message":"\\u0000"}',
      '{'.repeat(2000),
      '```json\n```',
    ];
    for (const text of hostile) {
      expect(() => parseProtocol(text)).not.toThrow();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Legacy and bare shapes                                                     */
/* -------------------------------------------------------------------------- */

describe('adaptation: other shapes a model may send', () => {
  it('reads the 0.1.x flat proposal', () => {
    const outcome = parseProtocol(JSON.stringify(LEGACY_FLAT));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.adaptation).toBe('legacy_flat');
      if (outcome.message.type === 'code_proposal') {
        expect(outcome.message.changes[0]!.file).toBe('src/a.ts');
        expect(outcome.message.changes[0]!.content).toBe('export const a = 1;\n');
      }
    }
  });

  it('reads a root-level "changes" array with no envelope type', () => {
    const outcome = adaptCandidate({ changes: [BARE_CHANGE] });
    expect(outcome.kind).toBe('flat_changes');
  });

  it('reads a bare change and synthesises an envelope', () => {
    const outcome = parseProtocol(JSON.stringify(BARE_CHANGE));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.adaptation).toBe('bare_change');
      if (outcome.message.type === 'code_proposal') {
        expect(outcome.message.changes[0]!.file).toBe('src/lonely.ts');
      }
    }
  });

  it('infers "update" from a "modify" operation synonym', () => {
    const outcome = parseProtocol(
      JSON.stringify({
        type: 'code_proposal',
        message: 'Editing.',
        changes: [{ filePath: 'src/a.ts', operation: 'modify', description: 'x', code: 'y\n' }],
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.message.type === 'code_proposal') {
      expect(outcome.message.changes[0]!.operation).toBe('update');
    }
  });

  it('joins a legacy multi-block file the way the 0.1.x writer did', () => {
    const reply = {
      type: 'code_proposal',
      filePath: 'src/a.ts',
      operation: 'create',
      description: 'Two blocks',
      blocks: [
        { id: 'b1', type: 'code', description: 'head', code: 'line one\n' },
        { id: 'b2', type: 'code', description: 'tail', code: 'line two\n' },
      ],
    };
    const outcome = parseProtocol(JSON.stringify(reply));
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.message.type === 'code_proposal') {
      // `parts.join('\n')`: blocks were separate pieces, and the blank line
      // between them is what the developer reviewed in 0.1.x. Faithfulness here
      // is the point — the bytes must not drift between versions.
      expect(outcome.message.changes[0]!.content).toBe('line one\n\nline two\n');
    }
  });

  it('never invents content for a change that has none', () => {
    const reply = {
      type: 'code_proposal',
      message: 'Empty.',
      changes: [{ file: 'src/a.ts', operation: 'create', description: 'nothing here' }],
    };
    expect(parseProtocol(JSON.stringify(reply)).ok).toBe(false);
  });

  it('recognises an already-canonical message', () => {
    const outcome = adaptCandidate(CANONICAL_REPLY);
    expect(outcome.kind).toBe('canonical');
    expect(outcome.value['type']).toBe('code_proposal');
    expect(outcome.value['changes']).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Intent classification                                                      */
/* -------------------------------------------------------------------------- */

describe('classifyTurnIntent', () => {
  it('treats a greeting as conversation', () => {
    expect(classifyTurnIntent('Hi')).toBe('conversational');
    expect(classifyTurnIntent('hello')).toBe('conversational');
    expect(classifyTurnIntent('thanks!')).toBe('conversational');
  });

  it('treats a greeting in Persian as conversation', () => {
    expect(classifyTurnIntent('سلام')).toBe('conversational');
    expect(classifyTurnIntent('ممنونم')).toBe('conversational');
  });

  it('treats "create a User class" as engineering', () => {
    expect(classifyTurnIntent('Create a PHP User class')).toBe('engineering');
  });

  it('treats a build request in Persian as engineering', () => {
    expect(classifyTurnIntent('یک کلاس کاربر در PHP بساز')).toBe('engineering');
  });

  it('treats a long message as engineering even without a keyword', () => {
    expect(
      classifyTurnIntent(
        'I have been thinking about the way our current architecture handles the boundary between the domain layer and the persistence layer, and I wonder what you make of it.'
      )
    ).toBe('engineering');
  });

  it('hints conversation for a greeting and a proposal for a task', () => {
    expect(classifyTurnIntent('Hi')).toBe('conversational');
  });
});

/* -------------------------------------------------------------------------- */
/* Diagnostics and redaction                                                  */
/* -------------------------------------------------------------------------- */

describe('redactSecrets', () => {
  it('redacts an OpenRouter key', () => {
    const text = 'using key sk-or-v1-abcdef0123456789abcdef0123456789';
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain('abcdef0123456789abcdef0123456789');
    expect(redacted).toMatch(/redacted/);
  });

  it('redacts an OpenAI-style key', () => {
    expect(redactSecrets('sk-abcdefghijklmnopqrstuvwxyz012345')).toMatch(/redacted/);
  });

  it('redacts a bearer token', () => {
    const redacted = redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');
    expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('redacts a JSON API-key assignment', () => {
    const redacted = redactSecrets('{"api_key": "supersecretvalue123"}');
    expect(redacted).not.toContain('supersecretvalue123');
  });

  it('redacts a private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----';
    expect(redactSecrets(pem)).not.toContain('MIIEow==');
  });

  it('leaves ordinary code alone', () => {
    const code = 'const key = lookup(record);\n';
    expect(redactSecrets(code)).toBe(code);
  });

  it('is idempotent', () => {
    const once = redactSecrets('sk-or-v1-abcdef0123456789abcdef0123456789');
    expect(redactSecrets(once)).toBe(once);
  });
});

describe('ProtocolDiagnostics', () => {
  it('records and returns entries in order', () => {
    const diagnostics = new ProtocolDiagnostics();
    diagnostics.record({ ok: true, adaptation: 'canonical', raw: '{"a":1}', sessionId: 's1' });
    diagnostics.record({ ok: false, adaptation: 'prose', raw: 'no json', sessionId: 's1' });
    expect(diagnostics.recent()).toHaveLength(2);
    expect(diagnostics.lastFailure()?.adaptation).toBe('prose');
  });

  it('stores the raw reply already redacted', () => {
    const diagnostics = new ProtocolDiagnostics();
    diagnostics.record({
      ok: false,
      adaptation: 'prose',
      raw: 'the key is sk-or-v1-abcdef0123456789abcdef0123456789',
      sessionId: 's1',
    });
    expect(diagnostics.recent()[0]!.raw).not.toContain('sk-or-v1-abcdef0123456789');
  });

  it('bounds how much raw text it keeps', () => {
    const diagnostics = new ProtocolDiagnostics();
    diagnostics.record({ ok: true, adaptation: 'canonical', raw: 'x'.repeat(100_000), sessionId: 's1' });
    expect(diagnostics.recent()[0]!.raw.length).toBeLessThan(100_000);
  });

  it('bounds how many entries it keeps', () => {
    const diagnostics = new ProtocolDiagnostics(3);
    for (let i = 0; i < 10; i++) {
      diagnostics.record({ ok: true, adaptation: 'canonical', raw: `{"i":${i}}`, sessionId: 's1' });
    }
    expect(diagnostics.size).toBe(3);
  });

  it('counts consecutive failures and resets on success', () => {
    const diagnostics = new ProtocolDiagnostics();
    diagnostics.record({ ok: false, adaptation: 'prose', raw: 'a', sessionId: 's' });
    diagnostics.record({ ok: false, adaptation: 'prose', raw: 'b', sessionId: 's' });
    expect(diagnostics.consecutiveFailures()).toBe(2);
    diagnostics.record({ ok: true, adaptation: 'canonical', raw: '{}', sessionId: 's' });
    expect(diagnostics.consecutiveFailures()).toBe(0);
  });

  it('clears on request', () => {
    const diagnostics = new ProtocolDiagnostics();
    diagnostics.record({ ok: true, adaptation: 'canonical', raw: '{}', sessionId: 's' });
    diagnostics.clear();
    expect(diagnostics.size).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

describe('renderMessage', () => {
  it('renders a chat response as its own words', () => {
    const outcome = parseProtocol(JSON.stringify({ type: 'chat_response', message: 'Hello there.' }));
    if (!outcome.ok) throw new Error('expected a message');
    expect(renderMessage(outcome.message)).toBe('Hello there.');
  });

  it('lists the files of a proposal', () => {
    const outcome = parseProtocol(JSON.stringify(CANONICAL_REPLY));
    if (!outcome.ok) throw new Error('expected a message');
    const rendered = renderMessage(outcome.message);
    expect(rendered).toContain('src/Domain/User.php');
    expect(rendered).toContain('src/Infrastructure/UserRepository.php');
  });

  it('passes a chat reply through verbatim, so the panel is the only escaper', () => {
    // `renderMessage` never emits HTML of its own — the panel inserts every
    // string with `textContent`, which the webview security suite asserts
    // directly. So markup in a model's prose must arrive as literal characters
    // here, and be inert there, rather than being "cleaned" into something the
    // panel would then have to trust.
    const outcome = parseProtocol(
      JSON.stringify({
        type: 'chat_response',
        message: 'See [this](javascript:alert(1)) and <img src=x onerror=alert(1)>',
      })
    );
    if (!outcome.ok) throw new Error('expected a message');
    expect(renderMessage(outcome.message)).toBe(
      'See [this](javascript:alert(1)) and <img src=x onerror=alert(1)>'
    );
  });

  it('renders a plan with its phases', () => {
    const outcome = parseProtocol(
      JSON.stringify({
        type: 'project_plan',
        message: 'Here is the plan.',
        plan: { phases: [{ name: 'Foundation', goal: 'A skeleton', tasks: ['Boot it'] }] },
      })
    );
    if (!outcome.ok) throw new Error('expected a message');
    const rendered = renderMessage(outcome.message);
    expect(rendered).toContain('Phase 1: Foundation');
    expect(rendered).toContain('Boot it');
  });
});

/* -------------------------------------------------------------------------- */
/* Large replies                                                              */
/* -------------------------------------------------------------------------- */

describe('large replies', () => {
  it('reads a proposal whose files run to hundreds of kilobytes', () => {
    const big = 'export const value = 1;\n'.repeat(6_000);
    const outcome = parseProtocol(
      JSON.stringify({
        type: 'code_proposal',
        message: 'A large file.',
        changes: [
          { file: 'src/big.ts', operation: 'create', description: 'Large', content: big },
        ],
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.message.type === 'code_proposal') {
      expect(outcome.message.changes[0]!.content.length).toBe(big.length);
    }
  });

  it('stays within a sane time budget on a large reply', () => {
    const big = 'const x = 1;\n'.repeat(20_000);
    const started = Date.now();
    parseProtocol(
      JSON.stringify({
        type: 'code_proposal',
        message: 'Large.',
        changes: [{ file: 'src/big.ts', operation: 'create', description: 'Large', content: big }],
      })
    );
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});

/* -------------------------------------------------------------------------- */
/* Contract sanity                                                            */
/* -------------------------------------------------------------------------- */

describe('schema contract', () => {
  it('requires a human-readable message on every type', () => {
    const result = validateProtocolMessage({ type: 'chat_response' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path === '/message')).toBe(true);
    }
  });

  it('reports every wrong field at once, not just the first', () => {
    const result = validateProtocolMessage({
      type: 'code_proposal',
      changes: [{ file: 42, operation: 'create' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(1);
    }
  });

  it('normalises the version number on the way out', () => {
    const result = validateProtocolMessage({ type: 'chat_response', message: 'hi' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.protocol_version).toBe(PAIRPILOT_PROTOCOL_VERSION);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The reported contract mismatch                                             */
/* -------------------------------------------------------------------------- */

/**
 * The second reported failure, replayed.
 *
 *     The reply was valid JSON but did not match the PairPilot response contract.
 *     /changes/0/file — The "file" field is required and was not present.
 *
 * The developer had asked for implementation, the session was in Coding, and the
 * model's reply was refused for a field it had — under another name. The path
 * field is the one a reply most easily misnames (`fileName`, `relativePath`,
 * `file_path`, `path`), and the diagnostic that came out of it said only that
 * `file` was absent. Nothing told the model what a change should look like, so a
 * corrective retry had nothing to correct.
 *
 * These tests pin the whole class: every spelling of the path that is
 * unambiguous is read, a path that is genuinely absent is reported once with the
 * keys that *did* arrive and the shape that was expected, and no refusal invents
 * a path to write.
 */
describe('the path field a reply lost', () => {
  const canonicalRest = {
    operation: 'create',
    description: 'A user entity.',
    content: '<?php\n\nfinal class User {}\n',
  };

  it.each([
    ['fileName', 'fileName'],
    ['file_name', 'file_name'],
    ['relativePath', 'relativePath'],
    ['relative_path', 'relative_path'],
    ['file_path', 'file_path'],
    ['filePath', 'filePath'],
    ['path', 'path'],
    ['target_file', 'target_file'],
  ])('reads %s as the target path', (_label, key) => {
    const reply = {
      type: 'code_proposal',
      message: 'Here it is.',
      changes: [{ [key]: 'src/User.php', ...canonicalRest }],
    };
    const outcome = parseProtocol(JSON.stringify(reply));
    expect(outcome.ok, JSON.stringify(!outcome.ok ? outcome.issues : [])).toBe(true);
    if (outcome.ok && outcome.message.type === 'code_proposal') {
      expect(outcome.message.changes[0]!.file).toBe('src/User.php');
      // The rename is recorded: a reply that adapted is not the same as one that
      // matched the contract, and the diagnostics panel has to be able to say so.
      expect(outcome.notes.join(' ')).toContain(key);
    }
  });

  it('refuses a change with no path at all, naming the change and the shape', () => {
    const reply = {
      type: 'code_proposal',
      message: 'Here it is.',
      changes: [canonicalRest],
    };
    const outcome = parseProtocol(JSON.stringify(reply));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }

    // One complaint, not four: the change had three of its four fields, and the
    // developer is told about the one that is missing.
    expect(outcome.issues).toHaveLength(1);
    const issue = outcome.issues[0]!;
    expect(issue.path).toBe('/changes/0/file');
    expect(issue.code).toBe('missing_field');
    // Which change, in the developer's own counting.
    expect(issue.message).toMatch(/Change 1/);
    // What actually arrived, so the misnamed field is visible.
    expect(issue.message).toContain('"operation"');
    expect(issue.message).toContain('"content"');
    // And what was expected instead.
    expect(issue.message).toMatch(/"operation" \("create" or "update"\)/);
    expect(issue.message).toMatch(/workspace-relative path/);
  });

  it('invents no path when the field is missing', () => {
    const reply = {
      type: 'code_proposal',
      message: 'Here it is.',
      changes: [canonicalRest],
    };
    const outcome = parseProtocol(JSON.stringify(reply));
    // Nothing to write, and nothing silently filled in: a proposal with an
    // invented path would be a file the developer never reviewed.
    expect(outcome.ok).toBe(false);
    expect(interpretTurn(JSON.stringify(reply)).kind).toBe('failure');
  });

  it('reports a non-object change as such, once', () => {
    const reply = { type: 'code_proposal', message: 'Done.', changes: ['src/a.ts'] };
    const outcome = parseProtocol(JSON.stringify(reply));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // The change was a string, and that is what the developer is told. Four
      // missing-field complaints about a change that has no fields at all is how
      // this used to read.
      expect(outcome.issues).toHaveLength(1);
      expect(outcome.issues[0]!.code).toBe('not_an_object');
      expect(outcome.issues[0]!.message).toMatch(/arrived as a string/);
      expect(outcome.issues[0]!.message).toMatch(/must be a JSON object/i);
    }
  });

  it('reads a nested proposal carrying a canonical changes array', () => {
    // The 0.1.x nested shape, with the change list spelled the canonical way.
    // Both halves have to work at once: the payload lifted out of `proposal`,
    // and its changes read as changes.
    const reply = {
      type: 'code_proposal',
      message: 'Here it is.',
      proposal: {
        changes: [
          { file: 'src/Domain/User.php', ...canonicalRest },
          {
            file: 'src/Infrastructure/UserRepository.php',
            operation: 'update',
            description: 'The repository.',
            content: '<?php\n\nfinal class UserRepository {}\n',
          },
        ],
      },
    };
    const outcome = parseProtocol(JSON.stringify(reply));
    expect(outcome.ok, JSON.stringify(!outcome.ok ? outcome.issues : [])).toBe(true);
    if (outcome.ok && outcome.message.type === 'code_proposal') {
      expect(outcome.message.changes.map((change) => change.file)).toEqual([
        'src/Domain/User.php',
        'src/Infrastructure/UserRepository.php',
      ]);
      expect(outcome.adaptation).toBe('nested_proposal');
    }
  });

  it('reads a change list sent under "files"', () => {
    const reply = {
      type: 'code_proposal',
      message: 'Here it is.',
      files: [{ file: 'src/User.php', ...canonicalRest }],
    };
    const outcome = parseProtocol(JSON.stringify(reply));
    expect(outcome.ok, JSON.stringify(!outcome.ok ? outcome.issues : [])).toBe(true);
    if (outcome.ok && outcome.message.type === 'code_proposal') {
      expect(outcome.message.changes).toHaveLength(1);
      expect(outcome.notes.join(' ')).toMatch(/files/i);
    }
  });

  it('joins a content array into the string the contract carries', () => {
    const reply = {
      type: 'code_proposal',
      message: 'Here it is.',
      changes: [
        {
          file: 'src/User.php',
          operation: 'create',
          description: 'A user entity.',
          content: ['<?php', '', 'final class User {}', ''],
        },
      ],
    };
    const outcome = parseProtocol(JSON.stringify(reply));
    expect(outcome.ok, JSON.stringify(!outcome.ok ? outcome.issues : [])).toBe(true);
    if (outcome.ok && outcome.message.type === 'code_proposal') {
      expect(outcome.message.changes[0]!.content).toBe('<?php\n\nfinal class User {}\n');
    }
  });

  it('still refuses a genuinely empty change, and says what was missing', () => {
    const reply = { type: 'code_proposal', message: 'Done.', changes: [{}] };
    const outcome = parseProtocol(JSON.stringify(reply));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      const fileIssue = outcome.issues.find((issue) => issue.path === '/changes/0/file');
      expect(fileIssue).toBeDefined();
      expect(fileIssue!.message).toMatch(/empty object/i);
    }
  });
});

describe('the required fields, one at a time', () => {
  it('refuses a change with no operation', () => {
    const reply = {
      type: 'code_proposal',
      message: 'Done.',
      changes: [
        { file: 'src/a.ts', description: 'A file', content: 'export const a = 1;\n' },
      ],
    };
    const outcome = parseProtocol(JSON.stringify(reply));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      const issue = outcome.issues.find((entry) => entry.path === '/changes/0/operation');
      expect(issue, JSON.stringify(outcome.issues)).toBeDefined();
      expect(issue!.code).toBe('missing_field');
      expect(issue!.message).toMatch(/Change 1/);
      expect(issue!.message).toMatch(/"create" for a new file/);
    }
  });

  it('reads "type" as the operation, as the reported contract names it', () => {
    const reply = {
      type: 'code_proposal',
      message: 'Done.',
      changes: [
        { file: 'src/a.ts', type: 'create', description: 'A file', content: 'export const a = 1;\n' },
      ],
    };
    const outcome = parseProtocol(JSON.stringify(reply));
    expect(outcome.ok, JSON.stringify(!outcome.ok ? outcome.issues : [])).toBe(true);
    if (outcome.ok && outcome.message.type === 'code_proposal') {
      expect(outcome.message.changes[0]!.operation).toBe('create');
    }
  });

  it('refuses a create with no content', () => {
    const reply = {
      type: 'code_proposal',
      message: 'Done.',
      changes: [{ file: 'src/a.ts', operation: 'create', description: 'A file' }],
    };
    const outcome = parseProtocol(JSON.stringify(reply));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues).toHaveLength(1);
      const issue = outcome.issues[0]!;
      expect(issue.path).toBe('/changes/0/content');
      expect(issue.message).toMatch(/Change 1/);
      expect(issue.message).toMatch(/src\/a\.ts/);
      expect(issue.message).toMatch(/complete final file/);
    }
  });

  it('refuses an update with no content, exactly as it refuses a create', () => {
    const reply = {
      type: 'code_proposal',
      message: 'Done.',
      changes: [{ file: 'src/a.ts', operation: 'update', description: 'A file' }],
    };
    expect(parseProtocol(JSON.stringify(reply)).ok).toBe(false);
  });

  it('refuses content that is not a string', () => {
    const reply = {
      type: 'code_proposal',
      message: 'Done.',
      changes: [{ file: 'src/a.ts', operation: 'create', description: 'A file', content: 42 }],
    };
    const outcome = parseProtocol(JSON.stringify(reply));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues[0]!.code).toBe('wrong_type');
    }
  });
});

describe('a reply of a different type', () => {
  it.each([
    ['chat_response', 'narrative'],
    ['engineering_advice', 'advice'],
    ['clarification_request', 'question'],
    ['project_analysis', 'narrative'],
    ['project_plan', 'narrative'],
    ['architecture_discussion', 'narrative'],
    ['code_review', 'narrative'],
    ['task_update', 'narrative'],
    ['error', 'narrative'],
  ])('handles %s with its own handler, not as a proposal', (type, expected) => {
    const bodies: Record<string, Record<string, unknown>> = {
      chat_response: { message: 'Here is what I would do.' },
      engineering_advice: {
        message: 'Next step.',
        advice: { title: 'Add a repository interface', reason: 'It is untestable without one.' },
      },
      clarification_request: {
        message: 'Which database?',
        clarification: { question: 'Which database?', options: ['SQLite', 'Postgres'] },
      },
      project_analysis: { message: 'Analysed.', analysis: { stack: ['PHP 8.3'] } },
      project_plan: {
        message: 'Planned.',
        plan: { phases: [{ name: 'Foundation', goal: 'A skeleton', tasks: ['Set it up'] }] },
      },
      architecture_discussion: { message: 'Discussed.', requirements: ['Users'] },
      code_review: { message: 'Reviewed.', review: { verdict: 'concerns' } },
      task_update: { message: 'Done.', task: { title: 'Build it', status: 'completed' } },
      error: { message: 'Could not comply.', error: { detail: 'No.' } },
    };

    // A valid reply of another type is answered as what it is. It is never
    // coerced into a code_proposal: doing that on an implementation turn is how
    // "the model asked a question" becomes "the model failed the contract".
    const interpretation = interpretTurn(JSON.stringify({ type, ...bodies[type] }));
    expect(interpretation.kind).toBe(expected);
    if (interpretation.kind === 'failure') {
      throw new Error(`expected ${type} to be handled, got failure: ${interpretation.failure.reason}`);
    }
    expect(interpretation.message.type).toBe(type);
  });

  it('does not coerce a chat_response that also carries a changes array', () => {
    // The model is allowed to be conversational and thorough at once. The type
    // it declared is what it is answered as.
    const reply = {
      type: 'chat_response',
      message: 'Here is the approach I would take.',
      changes: [{ file: 'src/a.ts', operation: 'create', description: 'A file', content: 'x\n' }],
    };
    const interpretation = interpretTurn(JSON.stringify(reply));
    expect(interpretation.kind).toBe('narrative');
  });
});

describe('a corrected retry', () => {
  it('carries the expected structure back to the model, not only the complaint', () => {
    const issues = [
      { path: '/changes/0/file', code: 'missing_field', message: 'Change 1 has no "file".' },
    ];
    const prompt = buildCorrectionPrompt(issues);

    // The complaint, against the JSON path the validator used.
    expect(prompt).toContain('/changes/0/file');
    expect(prompt).toContain('Change 1 has no "file".');
    // And the shape to send instead, spelled the way the host parses it.
    expect(prompt).toContain('"changes"');
    expect(prompt).toContain('"file"');
    expect(prompt).toContain('"operation"');
    expect(prompt).toContain('"content"');
    expect(prompt).toMatch(/"create" or "update"/);
    expect(prompt).toMatch(/ONE complete, corrected JSON object/);
  });

  it('accepts the corrected reply on the second attempt', () => {
    // The first attempt is refused; the second is the same proposal, fixed.
    const broken = {
      type: 'code_proposal',
      message: 'Done.',
      changes: [{ file: 'src/a.ts', operation: 'create', description: 'A file' }],
    };
    const first = interpretTurn(JSON.stringify(broken));
    expect(first.kind).toBe('failure');
    if (first.kind === 'failure') {
      expect(first.retryable).toBe(true);
    }

    const fixed = {
      type: 'code_proposal',
      message: 'Done.',
      changes: [
        { file: 'src/a.ts', operation: 'create', description: 'A file', content: 'x\n' },
      ],
    };
    expect(interpretTurn(JSON.stringify(fixed)).kind).toBe('proposal');
  });
});

/* -------------------------------------------------------------------------- */
/* The contract failure on "make simple x.html for test agent"                 */
/*                                                                            */
/* The developer asked for a file; the model answered with a description of    */
/* the file in `message` and no `changes` array. The refusal was correct —     */
/* what was wrong was everything around it: shapes carrying the real code     */
/* one level down were refused alongside it, the prompt offered a type menu    */
/* where a build instruction needed a demand, and a reply pairing a summary  */
/* with the actual proposal lost the proposal to scan order. These tests pin   */
/* each half: the summary-only reply must stay refused, and every shape that   */
/* does carry content must come through with its bytes intact.                 */
/* -------------------------------------------------------------------------- */

describe('the summary-without-changes contract failure', () => {
  /** The complete file the developer asked for and the model wrote. */
  const FULL_HTML =
    '<!DOCTYPE html>\n<html>\n<head><meta charset="utf-8"><title>Agent test</title></head>\n<body><h1>Test agent page</h1></body>\n</html>\n';
  /** One complete, valid change for x.html. */
  const change = {
    file: 'x.html',
    operation: 'create',
    description: 'A simple page the test agent loads.',
    content: FULL_HTML,
  };
  /** The summary-shaped reply that produced the reported error. */
  const summaryEcho = JSON.stringify({
    type: 'code_proposal',
    message: 'Creates a simple x.html page for the test agent to load and verify.',
  });

  it('refuses a description of the file in place of the file itself', () => {
    const outcome = parseProtocol(summaryEcho);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe('schema');
      expect(outcome.issues[0]!.path).toBe('/changes');
      expect(outcome.issues[0]!.code).toBe('missing_field');
      expect(outcome.issues[0]!.message).toContain('non-empty "changes"');
    }
  });

  it('refuses an empty changes array the same way, with the empty_value code', () => {
    const outcome = parseProtocol(
      JSON.stringify({ type: 'code_proposal', message: 'Creating the page.', changes: [] })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues[0]!.code).toBe('empty_value');
    }
  });

  it('reads the real proposal when a summary-shaped object precedes it', () => {
    // The shape of the reported interaction: the model narrates first, then
    // delivers. The first JSON object is a valid object of the wrong shape;
    // until the scan-order fix, parsing stopped there and the file content
    // later in the reply was never read.
    const reply = [
      'Here is the summary:',
      '```json',
      summaryEcho,
      '```',
      '',
      'The proposal:',
      JSON.stringify({ type: 'code_proposal', message: 'Creating the page.', changes: [change] }),
    ].join('\n');
    const outcome = parseProtocol(reply);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const message = outcome.message as import('../../src/protocol/types').CodeProposalMessage;
      expect(message.type).toBe('code_proposal');
      expect(message.changes).toHaveLength(1);
      expect(message.changes[0]!.content).toBe(FULL_HTML);
    }
  });

  it('lifts a nested payload even when an empty root changes array occupies the key', () => {
    const reply = JSON.stringify({
      type: 'code_proposal',
      message: 'Creates a simple x.html page for the test agent.',
      changes: [],
      proposal: { changes: [change] },
    });
    const outcome = parseProtocol(reply);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const message = outcome.message as import('../../src/protocol/types').CodeProposalMessage;
      expect(message.changes[0]!.content).toBe(FULL_HTML);
    }
  });

  it('reads a changes value sent as a single object as a one-change array', () => {
    const outcome = parseProtocol(
      JSON.stringify({ type: 'code_proposal', message: 'm', changes: change })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const message = outcome.message as import('../../src/protocol/types').CodeProposalMessage;
      expect(message.changes).toHaveLength(1);
      expect(message.changes[0]!.content).toBe(FULL_HTML);
    }
  });

  it('reads a bare change that spells its operation in "type"', () => {
    const outcome = parseProtocol(
      JSON.stringify({ file: 'x.html', type: 'create', description: 'd', content: FULL_HTML })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const message = outcome.message as import('../../src/protocol/types').CodeProposalMessage;
      expect(message.changes[0]!.operation).toBe('create');
      expect(message.changes[0]!.content).toBe(FULL_HTML);
    }
  });

  it('still refuses a fragment of a rejected whole document', () => {
    // A whole document was parsed and refused (its change has no content).
    // Nothing inside it may then validate on its own: the inner change object
    // is not an independent message, it is part of what was refused. This is
    // the safety property the two-tier design protects — a proposal rejected
    // as a set must not have one file quietly salvaged out of it.
    const broken = JSON.stringify({
      type: 'code_proposal',
      message: 'm',
      changes: [{ file: 'x.html', operation: 'create', description: 'd' }],
    });
    const outcome = parseProtocol(broken);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues.some((issue) => issue.code === 'missing_field')).toBe(true);
    }
  });

  it('still refuses content nested two levels under the change, and names the field', () => {
    const outcome = parseProtocol(
      JSON.stringify({
        type: 'code_proposal',
        message: 'm',
        changes: [{ file: 'x.html', operation: 'create', description: 'd', create: { content: FULL_HTML } }],
      })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues[0]!.path).toBe('/changes/0/content');
    }
  });

  it('renders the summary line the developer saw for a valid proposal', () => {
    const outcome = parseProtocol(
      JSON.stringify({ type: 'code_proposal', message: 'Creating the page.', changes: [change] })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const text = renderMessage(outcome.message);
      expect(text).toContain('1 to create, 0 to update.');
    }
  });

  it('handles PHP, CSS, JS and multi-file proposals with their bytes intact', () => {
    const multi = JSON.stringify({
      type: 'code_proposal',
      message: 'A small page with its stylesheet and script.',
      changes: [
        { file: 'page.php', operation: 'create', description: 'PHP entry point.', content: '<?php\necho "hi";\n' },
        { file: 'style.css', operation: 'create', description: 'Styles.', content: 'body { margin: 0; }\n' },
        { file: 'app.js', operation: 'create', description: 'Script.', content: 'console.log("hi");\n' },
        { file: 'x.html', operation: 'create', description: 'The page.', content: FULL_HTML },
      ],
    });
    const outcome = parseProtocol(multi);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const message = outcome.message as import('../../src/protocol/types').CodeProposalMessage;
      expect(message.changes).toHaveLength(4);
      expect(message.changes[0]!.content).toBe('<?php\necho "hi";\n');
      expect(message.changes[1]!.content).toBe('body { margin: 0; }\n');
      expect(message.changes[2]!.content).toBe('console.log("hi");\n');
      expect(message.changes[3]!.content).toBe(FULL_HTML);
    }
  });

  it('does not coerce a chat_response that mentions a file into a proposal', () => {
    const outcome = parseProtocol(
      JSON.stringify({ type: 'chat_response', message: 'You asked me to make x.html earlier.' })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.message.type).toBe('chat_response');
    }
  });
});

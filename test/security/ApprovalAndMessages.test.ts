/**
 * ApprovalManager and MessageValidator tests.
 *
 * Together these verify spec section 9 ("approval must be associated with the
 * exact content hash") and section 11 ("never let Webview messages bypass
 * approval rules").
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ApprovalManager, toProposalRecord } from '../../src/proposals/ApprovalManager';
import { ProposalValidator, toValidatedProposal } from '../../src/proposals/ProposalValidator';
import { MessageValidator } from '../../src/security/MessageValidator';
import { PathGuard } from '../../src/security/PathGuard';
import { ApprovalMismatchError, MessageRejectedError } from '../../src/core/errors';
import { PAIRPILOT_PROTOCOL_VERSION } from '../../src/protocol/types';
import type { CodeProposalMessage } from '../../src/protocol/types';
import type { ValidatedProposal } from '../../src/types';

let root: string;
let validator: ProposalValidator;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pairpilot-approval-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  validator = new ProposalValidator(new PathGuard(root));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makeProposal(filePath = 'src/a.ts', code = 'export const a = 1;\n'): ValidatedProposal {
  const message: CodeProposalMessage = {
    protocol_version: PAIRPILOT_PROTOCOL_VERSION,
    type: 'code_proposal',
    message: 'Create a',
    changes: [
      {
        id: 'change_001',
        file: filePath,
        operation: 'create',
        description: 'Create a',
        content: code,
        dependencies: [],
        risk: 'low',
      },
    ],
    summary: { files_to_create: 1, files_to_update: 0, files_to_delete: 0 },
  };
  const set = validator.validateChangeSet(message);
  return toValidatedProposal(set.changes[0]!, set.envelope);
}

describe('ApprovalManager: hash binding', () => {
  it('verifies a matching hash', () => {
    const manager = new ApprovalManager();
    const proposal = makeProposal();
    manager.setPending(proposal);
    expect(manager.verify(proposal.contentHash)).toBe(proposal);
  });

  it('refuses a mismatch, so a swapped proposal cannot be approved', () => {
    const manager = new ApprovalManager();
    manager.setPending(makeProposal('src/a.ts'));
    const other = makeProposal('src/b.ts');
    expect(() => manager.verify(other.contentHash)).toThrow(ApprovalMismatchError);
  });

  it('refuses a decision when nothing is pending', () => {
    expect(() => new ApprovalManager().verify('a'.repeat(64))).toThrow(ApprovalMismatchError);
  });

  it('refuses a replayed decision', () => {
    // A duplicate message from a stale panel must not authorise a second write.
    const manager = new ApprovalManager();
    const proposal = makeProposal();
    manager.setPending(proposal);
    manager.record('approve', proposal);

    manager.setPending(proposal);
    expect(() => manager.verify(proposal.contentHash)).toThrow(/already been decided/i);
  });

  it('exposes the pending hash for the UI to echo back', () => {
    const manager = new ApprovalManager();
    const proposal = makeProposal();
    manager.setPending(proposal);
    expect(manager.getPendingHash()).toBe(proposal.contentHash);
  });

  it('clears the pending proposal', () => {
    const manager = new ApprovalManager();
    manager.setPending(makeProposal());
    manager.clearPending();
    expect(manager.getPending()).toBeNull();
    expect(manager.getPendingHash()).toBeNull();
  });
});

describe('ApprovalManager: decision history', () => {
  it('records an approval with feedback omitted', () => {
    const manager = new ApprovalManager();
    const proposal = makeProposal();
    manager.setPending(proposal);
    const record = manager.record('approve', proposal);
    expect(record.decision).toBe('approve');
    expect(record.relativePath).toBe('src/a.ts');
    expect(record.feedback).toBeUndefined();
  });

  it('records change-request feedback', () => {
    const manager = new ApprovalManager();
    const proposal = makeProposal();
    manager.setPending(proposal);
    const record = manager.record('request_changes', proposal, { feedback: 'Use a factory.' });
    expect(record.feedback).toBe('Use a factory.');
  });

  it('consumes the pending proposal on record', () => {
    const manager = new ApprovalManager();
    const proposal = makeProposal();
    manager.setPending(proposal);
    manager.record('reject', proposal);
    expect(manager.getPending()).toBeNull();
  });
});

describe('ApprovalManager: drift detection', () => {
  it('finds the approval covering a file', () => {
    const manager = new ApprovalManager();
    const proposal = makeProposal();
    manager.setPending(proposal);
    manager.record('approve', proposal, { approvedFileHash: 'hash-one' });
    expect(manager.findApprovalFor('src/a.ts')?.contentHash).toBe(proposal.contentHash);
  });

  it('reports drift when the file changed after approval', () => {
    // Spec section 9: an approved file must not be modified without a new
    // approval. Drift is how the extension notices.
    const manager = new ApprovalManager();
    const proposal = makeProposal();
    manager.setPending(proposal);
    manager.record('approve', proposal, { approvedFileHash: 'hash-one' });

    expect(manager.hasDrifted('src/a.ts', 'hash-one')).toBe(false);
    expect(manager.hasDrifted('src/a.ts', 'hash-two')).toBe(true);
  });

  it('does not report drift for a file with no recorded approval', () => {
    expect(new ApprovalManager().hasDrifted('src/unknown.ts', 'anything')).toBe(false);
  });

  it('ignores a rejected proposal when looking for an approval', () => {
    const manager = new ApprovalManager();
    const proposal = makeProposal();
    manager.setPending(proposal);
    manager.record('reject', proposal);
    expect(manager.findApprovalFor('src/a.ts')).toBeUndefined();
  });

  it('reset clears everything', () => {
    const manager = new ApprovalManager();
    const proposal = makeProposal();
    manager.setPending(proposal);
    manager.record('approve', proposal);
    manager.reset();
    expect(manager.getPending()).toBeNull();
    expect(manager.getHistory()).toHaveLength(0);
    expect(manager.isDecided(proposal.contentHash)).toBe(false);
  });
});

describe('toProposalRecord', () => {
  it('builds a UI record carrying the hash and block content', () => {
    const proposal = makeProposal();
    const record = toProposalRecord(proposal);
    expect(record.contentHash).toBe(proposal.contentHash);
    expect(record.relativePath).toBe('src/a.ts');
    expect(record.blocks).toHaveLength(1);
    expect(record.operation).toBe('create');
  });

  it('omits absent optional fields rather than setting them undefined', () => {
    // `rationale` is *not* absent here: a change with no rationale of its own
    // inherits the proposal's own explanation, which is the model's account of
    // why the change set exists. The fields that really are absent must not be
    // written as `undefined`, because the panel tests for their presence.
    const record = toProposalRecord(makeProposal());
    expect(record.rationale).toBe('Create a');
    expect('potentialProblems' in record).toBe(false);
    expect('responsibilities' in record).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

const messageValidator = new MessageValidator();

describe('MessageValidator: accepted messages', () => {
  it('accepts a bare ready message', () => {
    expect(messageValidator.validate({ type: 'ready' })).toEqual({ type: 'ready' });
  });

  it('accepts a task submission', () => {
    const result = messageValidator.validate({ type: 'submitTask', text: 'build me a thing' });
    expect(result).toEqual({ type: 'submitTask', text: 'build me a thing' });
  });

  it('accepts the streaming controls the composer offers', () => {
    expect(messageValidator.validate({ type: 'pauseWrite' })).toEqual({ type: 'pauseWrite' });
    expect(messageValidator.validate({ type: 'resumeWrite' })).toEqual({ type: 'resumeWrite' });
    expect(
      messageValidator.validate({ type: 'requestChangesDuringWrite', feedback: 'write it shorter' })
    ).toEqual({ type: 'requestChangesDuringWrite', feedback: 'write it shorter' });
  });

  it('accepts the request to open the editor review', () => {
    expect(messageValidator.validate({ type: 'openReviewInEditor' })).toEqual({
      type: 'openReviewInEditor',
    });
  });

  it('accepts "choose a model" and carries nothing up with it', () => {
    // Which level to configure is chosen in the QuickPick. A level from the
    // panel would be a settings write chosen by untrusted input.
    expect(
      messageValidator.validate({ type: 'chooseModel', level: 'role', key: 'coding' })
    ).toEqual({ type: 'chooseModel' });
  });

  it('accepts "continue the roadmap" but strips any path the panel sends with it', () => {
    // The host starts the file it offered, not a path the Webview supplied. A
    // path here would be untrusted input choosing what PairPilot writes.
    expect(
      messageValidator.validate({
        type: 'continueRoadmap',
        relativePath: '../../etc/passwd',
        path: '/etc/shadow',
      })
    ).toEqual({ type: 'continueRoadmap' });
  });
});

describe('MessageValidator: shape enforcement', () => {
  it('rejects a non-object', () => {
    expect(() => messageValidator.validate('hello')).toThrow(MessageRejectedError);
    expect(() => messageValidator.validate(null)).toThrow(MessageRejectedError);
    expect(() => messageValidator.validate([])).toThrow(MessageRejectedError);
  });

  it('rejects a missing type', () => {
    expect(() => messageValidator.validate({ text: 'x' })).toThrow(/missing a string "type"/i);
  });

  it('rejects an unknown type', () => {
    expect(() => messageValidator.validate({ type: 'deleteEverything' })).toThrow(
      /Unsupported message type/i
    );
  });

  it('rejects prototype-pollution keys', () => {
    // Constructing this literally avoids the object-literal setter trap.
    const payload = JSON.parse('{"type":"ready","__proto__":{"polluted":true}}');
    expect(() => messageValidator.validate(payload)).toThrow(/forbidden key/i);
  });

  it('has no vocabulary for a decision, so no Webview message can approve anything', () => {
    // This is the structural guarantee behind "treat Webview messages as
    // untrusted input": the channel cannot carry a decision, forged or
    // otherwise, because no such message type exists.
    for (const type of [
      'approveCode',
      'rejectCode',
      'requestChanges',
      'approveFileCreation',
      'rejectFileCreation',
    ]) {
      expect(() =>
        messageValidator.validate({ type, contentHash: 'a'.repeat(64), feedback: 'x' })
      ).toThrow(/Unsupported message type/i);
    }
  });

  it('rejects a blank task', () => {
    expect(() => messageValidator.validate({ type: 'submitTask', text: '   ' })).toThrow(
      /must not be blank/i
    );
  });

  it('rejects a task over the length limit', () => {
    expect(() =>
      messageValidator.validate({ type: 'submitTask', text: 'x'.repeat(40_000) })
    ).toThrow(/exceeds the maximum length/i);
  });

  it('rejects non-string fields', () => {
    expect(() => messageValidator.validate({ type: 'submitTask', text: 42 })).toThrow(
      /must be a string/i
    );
    expect(() =>
      messageValidator.validate({ type: 'openFile', relativePath: { toString: () => 'x' } })
    ).toThrow(/must be a string/i);
  });

  it('rejects a NUL byte in a path', () => {
    expect(() =>
      messageValidator.validate({ type: 'openFile', relativePath: 'a\u0000b' })
    ).toThrow(/NUL/i);
  });

  it('rejects an unknown session id', () => {
    expect(() =>
      messageValidator.validate(
        { type: 'loadSession', sessionId: 'ghost' },
        { knownSessionIds: new Set(['real']) }
      )
    ).toThrow(/Unknown session id/i);
  });

  it('accepts a known session id', () => {
    expect(
      messageValidator.validate(
        { type: 'loadSession', sessionId: 'real' },
        { knownSessionIds: new Set(['real']) }
      )
    ).toEqual({ type: 'loadSession', sessionId: 'real' });
  });
});

describe('MessageValidator: tryValidate', () => {
  it('returns a result rather than throwing', () => {
    const good = messageValidator.tryValidate({ type: 'ready' });
    expect(good.ok).toBe(true);

    const bad = messageValidator.tryValidate({ type: 'nonsense' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toMatch(/Unsupported message type/i);
    }
  });
});

/**
 * Workflow modes: classification, mode transitions, and the policy boundary.
 *
 * The scenario this file is built around is the reported bug, in full:
 *
 *   "I want to build a simple PHP and SQLite user management system. Features:
 *    create, list, retrieve, update and delete users. Use PDO. No framework.
 *    Do not write code yet. First discuss requirements and architecture."
 *
 * Every step the report lists — discovery, requirements, architecture, approval,
 * roadmap, and only then coding — is asserted here as a transition of a pure
 * function, so "architecture approval does not authorise code" is a statement a
 * test can make rather than an observation about an integration.
 */

import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_MODES,
  classifyIntention,
  nextMode,
  policyFor,
  refusedProposalReason,
  typeAllowedIn,
  type WorkflowMode,
} from '../../src/protocol/mode';

/** Classify from a given mode, with no conversation history. */
function intentOf(task: string, previousMode: WorkflowMode = 'discovery') {
  return classifyIntention({ task, previousMode });
}

/** The mode a single turn would leave the session in. */
function modeAfter(task: string, previousMode: WorkflowMode): WorkflowMode {
  return nextMode(previousMode, intentOf(task, previousMode).intention);
}

/* -------------------------------------------------------------------------- */
/* The reported scenario, turn by turn                                        */
/* -------------------------------------------------------------------------- */

const REPORTED_OPENING =
  'I want to build a simple PHP and SQLite user management system. Features: create, list, ' +
  'retrieve, update and delete users. Use PDO. No framework. Do not write code yet. ' +
  'First discuss requirements and architecture.';

describe('the reported scenario', () => {
  it('sends the opening message to Discovery, not to a proposal', () => {
    const result = intentOf(REPORTED_OPENING);
    expect(result.intention).toBe('requirements_analysis');
    expect(result.explicit).toBe(true);
    expect(nextMode('discovery', result.intention)).toBe('discovery');
  });

  it('does not let a planning mode produce an applicable proposal', () => {
    const policy = policyFor(modeAfter(REPORTED_OPENING, 'discovery'));
    expect(policy.allowsProposals).toBe(false);
    expect(policy.allowsWrites).toBe(false);
    expect(typeAllowedIn(policy, 'code_proposal')).toBe(false);
    expect(typeAllowedIn(policy, 'architecture_discussion')).toBe(true);
  });

  it('walks the whole journey only when the developer drives it', () => {
    let mode: WorkflowMode = 'discovery';

    // 1-2. Requirements discussion stays in discovery.
    mode = modeAfter(REPORTED_OPENING, mode);
    expect(mode).toBe('discovery');

    // 3. Answering the clarifying question is still discovery.
    mode = modeAfter('Soft delete is fine, and email should be unique.', mode);
    expect(mode).toBe('discovery');

    // 4. Asking for the design moves to architecture — and no further.
    mode = modeAfter('Now propose an architecture for this.', mode);
    expect(mode).toBe('architecture');

    // 5. Agreeing with the design moves to implementation, never to coding.
    mode = modeAfter('That architecture looks good, let us go with it.', mode);
    expect(mode).toBe('implementation');

    // 6. Asking for the roadmap keeps it there.
    mode = modeAfter('Give me the implementation plan.', mode);
    expect(mode).toBe('implementation');

    // 7. Only an explicit implementation instruction enters coding.
    mode = modeAfter('Go ahead and implement the first step.', mode);
    expect(mode).toBe('coding');
  });

  it('never writes anything before the developer authorises code', () => {
    const journey = [
      REPORTED_OPENING,
      'Soft delete. Email unique.',
      'Propose an architecture.',
      'That architecture looks good.',
      'Give me the implementation plan.',
    ];
    let mode: WorkflowMode = 'discovery';
    for (const turn of journey) {
      mode = modeAfter(turn, mode);
      expect(policyFor(mode).allowsWrites).toBe(false);
    }
    // And then, and only then:
    expect(policyFor(modeAfter('Go ahead and implement the first step.', mode)).allowsWrites).toBe(
      true
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Explicit instructions override assumptions                                 */
/* -------------------------------------------------------------------------- */

describe('an explicit "no code yet"', () => {
  const phrasings = [
    'Add a login page but do not write any code yet.',
    'Build me the repository. No code yet please.',
    'Implement the service without writing code for now.',
    'Refactor this module, but first discuss the approach.',
    'Create the user table — hold off until we agree on the schema.',
    'Add validation later; for now just design it.',
    'فعلا کد ننویس، اول معماری را بررسی کنیم.',
    'میخوام یه سیستم کاربر بسازم، بدون کد اول نیازمندیها رو تحلیل کن.',
  ];

  for (const phrasing of phrasings) {
    it(`keeps a planning mode for: "${phrasing.slice(0, 52)}…"`, () => {
      const result = intentOf(phrasing, 'coding');
      expect(result.explicit).toBe(true);
      expect(policyFor(nextMode('coding', result.intention)).allowsProposals).toBe(false);
    });
  }

  it('treats an explicit constraint as a return from Coding to planning', () => {
    // Even mid-implementation, "do not write code yet" is obeyed.
    expect(modeAfter('Stop — do not write any more code yet, let us discuss it.', 'coding')).toBe(
      'architecture'
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Wishes are not instructions                                                */
/* -------------------------------------------------------------------------- */

describe('a description of what the developer wants', () => {
  const wishes = [
    'I want to build a user management system.',
    'We need a small CRUD service for users.',
    'I am planning a PHP API for invoices.',
    "I'd like to have a reports module eventually.",
    'میخوام یه سیستم مدیریت کاربر بسازم.',
  ];

  for (const wish of wishes) {
    it(`does not authorise code for: "${wish}"`, () => {
      const result = intentOf(wish, 'discovery');
      expect(result.intention).not.toBe('code_generation');
      expect(result.intention).not.toBe('code_modification');
      expect(policyFor(nextMode('discovery', result.intention)).allowsProposals).toBe(false);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Direct instructions are still obeyed                                       */
/* -------------------------------------------------------------------------- */

describe('a direct instruction', () => {
  const instructions = [
    'Create a PHP User class',
    'Write the UserRepository class using PDO.',
    'Implement the create user endpoint',
    'Add a unique index on the email column.',
    'Improve the query in UserRepository.',
    'Build the login form.',
    'Fix the bug in src/User.php',
    'This is broken — the insert fails.',
    'یه کلاس User بساز',
  ];

  for (const instruction of instructions) {
    it(`enters Coding for: "${instruction}"`, () => {
      expect(modeAfter(instruction, 'discovery')).toBe('coding');
    });
  }

  it('honours a modification request even from a design conversation', () => {
    expect(modeAfter('Fix the bug in src/UserRepository.php', 'architecture')).toBe('coding');
  });
});

/* -------------------------------------------------------------------------- */
/* Approval is not authorisation                                              */
/* -------------------------------------------------------------------------- */

describe('approving a design', () => {
  it('moves to implementation planning, never straight to coding', () => {
    expect(modeAfter('Yes, that architecture is right.', 'architecture')).toBe('implementation');
    expect(modeAfter('Approved. The design looks good.', 'architecture')).toBe('implementation');
    expect(modeAfter('موافقم، معماری خوبه.', 'architecture')).toBe('implementation');
  });

  it('leaves the coding edge to an instruction that asks for code', () => {
    // The same words, one step apart in intent.
    expect(modeAfter('Sounds good, let us build it.', 'implementation')).toBe('coding');
    expect(modeAfter('The plan looks good.', 'implementation')).toBe('implementation');
  });

  it('is not inferred from a bare "ok" in Coding', () => {
    // In Coding, "ok" is an acknowledgement of a question, not a design approval.
    expect(modeAfter('ok', 'coding')).toBe('coding');
  });
});

/* -------------------------------------------------------------------------- */
/* Small talk leaves the mode alone                                           */
/* -------------------------------------------------------------------------- */

describe('small talk', () => {
  it('does not abandon a design conversation', () => {
    for (const mode of WORKFLOW_MODES) {
      expect(modeAfter('Hi', mode)).toBe(mode);
      expect(modeAfter('thanks!', mode)).toBe(mode);
      expect(modeAfter('سلام', mode)).toBe(mode);
    }
  });

  it('is recognised for a Persian greeting', () => {
    expect(intentOf('سلام').intention).toBe('general_chat');
  });
});

/* -------------------------------------------------------------------------- */
/* The policy table                                                           */
/* -------------------------------------------------------------------------- */

describe('the mode policy', () => {
  it('refuses proposals and writes everywhere except Coding', () => {
    expect(policyFor('discovery').allowsProposals).toBe(false);
    expect(policyFor('architecture').allowsProposals).toBe(false);
    expect(policyFor('implementation').allowsProposals).toBe(false);
    expect(policyFor('coding').allowsProposals).toBe(true);
    expect(policyFor('coding').allowsWrites).toBe(true);
  });

  it('names every mode in its hint, so the prompt states where it is', () => {
    expect(policyFor('discovery').hint('engineering')).toMatch(/DISCOVERY/);
    expect(policyFor('architecture').hint('engineering')).toMatch(/ARCHITECTURE/);
    expect(policyFor('implementation').hint('engineering')).toMatch(/IMPLEMENTATION PLANNING/);
    expect(policyFor('coding').hint('engineering')).toMatch(/CODING/);
  });

  it('forbids file contents in every planning hint', () => {
    for (const mode of ['discovery', 'architecture', 'implementation'] as const) {
      for (const intent of ['conversational', 'engineering'] as const) {
        expect(policyFor(mode).hint(intent)).toMatch(/code_proposal/);
        expect(policyFor(mode).hint(intent)).toMatch(/director|folder|creating/i);
      }
    }
  });

  it('tells a greeting in a planning mode to stay a greeting', () => {
    // The one case where the mode's own instructions must give way: a "hi" in
    // Discovery is a greeting, not an opening to summarise requirements nobody
    // has stated yet.
    const greeting = policyFor('discovery').hint('conversational');
    expect(greeting).toMatch(/small talk/i);
    expect(greeting).not.toMatch(/ask ONE clarifying question/i);

    const work = policyFor('discovery').hint('engineering');
    expect(work).toMatch(/ask ONE clarifying question/i);
  });

  it('allows code_proposal only in the coding allow-list', () => {
    expect(typeAllowedIn(policyFor('coding'), 'code_proposal')).toBe(true);
    for (const mode of ['discovery', 'architecture', 'implementation'] as const) {
      expect(typeAllowedIn(policyFor(mode), 'code_proposal')).toBe(false);
      expect(typeAllowedIn(policyFor(mode), 'architecture_discussion')).toBe(true);
    }
  });

  it('explains a refusal and how to move on', () => {
    const reason = refusedProposalReason('architecture');
    expect(reason).toMatch(/Architecture/);
    expect(reason).toMatch(/did not apply/i);
    expect(reason).toMatch(/implement it/i);
  });

  it('covers every mode', () => {
    for (const mode of WORKFLOW_MODES) {
      expect(policyFor(mode).mode).toBe(mode);
      expect(policyFor(mode).allowedTypes.length).toBeGreaterThan(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Mode transitions are total                                                 */
/* -------------------------------------------------------------------------- */

describe('mode transitions', () => {
  it('answers for every mode and every intention', () => {
    const intentions = [
      'general_chat',
      'discovery',
      'requirements_analysis',
      'architecture_discussion',
      'architecture_approval',
      'implementation_planning',
      'code_generation',
      'code_modification',
      'code_review',
    ] as const;
    for (const mode of WORKFLOW_MODES) {
      for (const intention of intentions) {
        expect(WORKFLOW_MODES).toContain(nextMode(mode, intention));
      }
    }
  });

  it('returns to discovery whenever requirements are raised again', () => {
    // Going back to requirements is a legitimate move, not a regression to hide.
    expect(nextMode('coding', 'requirements_analysis')).toBe('discovery');
    expect(nextMode('implementation', 'discovery')).toBe('discovery');
  });

  it('treats a review as coding work, because it needs the code read', () => {
    expect(nextMode('architecture', 'code_review')).toBe('coding');
  });
});

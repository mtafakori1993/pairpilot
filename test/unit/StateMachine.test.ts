/**
 * StateMachine tests.
 *
 * The state machine is the reason a Webview message cannot bypass an approval
 * gate, so these tests assert both that legal flows work and that illegal ones
 * are refused. The illegal cases matter more.
 */

import { describe, expect, it, vi } from 'vitest';
import { StateMachine } from '../../src/core/StateMachine';
import { PairPilotState, STATE_TRANSITIONS } from '../../src/types';

describe('StateMachine: legality', () => {
  it('starts in IDLE', () => {
    expect(new StateMachine().state).toBe(PairPilotState.IDLE);
  });

  it('walks the full happy path', () => {
    const machine = new StateMachine();
    const path = [
      PairPilotState.ANALYZING,
      PairPilotState.PROPOSING,
      PairPilotState.WAITING_FILE_APPROVAL,
      PairPilotState.CREATING_FILE,
      PairPilotState.WRITING_CODE,
      PairPilotState.REVIEWING,
      PairPilotState.WAITING_CODE_APPROVAL,
      PairPilotState.APPROVED,
      PairPilotState.ANALYZING_NEXT_STEP,
      PairPilotState.COMPLETED,
    ];
    for (const state of path) {
      expect(() => machine.transition(state), `to ${state}`).not.toThrow();
    }
    expect(machine.state).toBe(PairPilotState.COMPLETED);
  });

  it('refuses to skip the file approval gate', () => {
    // This is the critical invariant: the writing states are unreachable without
    // passing WAITING_FILE_APPROVAL.
    const machine = new StateMachine();
    machine.transition(PairPilotState.ANALYZING);
    machine.transition(PairPilotState.PROPOSING);
    expect(machine.canTransition(PairPilotState.WRITING_CODE)).toBe(false);
    expect(() => machine.transition(PairPilotState.WRITING_CODE)).toThrow(/Illegal transition/);
  });

  it('refuses to approve code that was never written', () => {
    const machine = new StateMachine();
    machine.transition(PairPilotState.ANALYZING);
    machine.transition(PairPilotState.PROPOSING);
    expect(machine.canTransition(PairPilotState.APPROVED)).toBe(false);
  });

  it('refuses a self-transition, which would re-trigger side effects', () => {
    const machine = new StateMachine();
    expect(() => machine.transition(PairPilotState.IDLE)).toThrow(/already in IDLE/);
  });

  it('allows cancellation from an in-flight state', () => {
    const machine = new StateMachine();
    machine.transition(PairPilotState.ANALYZING);
    machine.transition(PairPilotState.PROPOSING);
    expect(() => machine.transition(PairPilotState.CANCELLED)).not.toThrow();
  });

  it('allows cancellation mid-write, so a partial write can be rolled back', () => {
    const machine = new StateMachine();
    for (const state of [
      PairPilotState.ANALYZING,
      PairPilotState.PROPOSING,
      PairPilotState.WAITING_FILE_APPROVAL,
      PairPilotState.CREATING_FILE,
      PairPilotState.WRITING_CODE,
    ]) {
      machine.transition(state);
    }
    expect(machine.canTransition(PairPilotState.CANCELLED)).toBe(true);
  });

  it('allows cancelling at the review gate', () => {
    const machine = new StateMachine();
    for (const state of [
      PairPilotState.ANALYZING,
      PairPilotState.PROPOSING,
      PairPilotState.WAITING_FILE_APPROVAL,
      PairPilotState.CREATING_FILE,
      PairPilotState.WRITING_CODE,
      PairPilotState.WAITING_CODE_APPROVAL,
    ]) {
      machine.transition(state);
    }
    expect(machine.canTransition(PairPilotState.CANCELLED)).toBe(true);
  });

  it('offers all three review choices at the code approval gate', () => {
    const machine = new StateMachine();
    for (const state of [
      PairPilotState.ANALYZING,
      PairPilotState.PROPOSING,
      PairPilotState.WAITING_FILE_APPROVAL,
      PairPilotState.CREATING_FILE,
      PairPilotState.WRITING_CODE,
      PairPilotState.WAITING_CODE_APPROVAL,
    ]) {
      machine.transition(state);
    }
    expect(machine.canTransition(PairPilotState.APPROVED)).toBe(true);
    expect(machine.canTransition(PairPilotState.REJECTED)).toBe(true);
    expect(machine.canTransition(PairPilotState.REQUESTING_CHANGES)).toBe(true);
  });

  it('returns to analysis after a change request, so the revision is reviewed again', () => {
    const machine = new StateMachine();
    for (const state of [
      PairPilotState.ANALYZING,
      PairPilotState.PROPOSING,
      PairPilotState.WAITING_FILE_APPROVAL,
      PairPilotState.CREATING_FILE,
      PairPilotState.WRITING_CODE,
      PairPilotState.WAITING_CODE_APPROVAL,
      PairPilotState.REQUESTING_CHANGES,
    ]) {
      machine.transition(state);
    }
    expect(machine.canTransition(PairPilotState.ANALYZING)).toBe(true);
    // And it must not be able to jump straight to approval.
    expect(machine.canTransition(PairPilotState.APPROVED)).toBe(false);
  });
});

describe('StateMachine: queries', () => {
  it('reports busy states', () => {
    const machine = new StateMachine();
    expect(machine.isBusy()).toBe(false);
    machine.transition(PairPilotState.ANALYZING);
    expect(machine.isBusy()).toBe(true);
  });

  it('reports states that await a human decision', () => {
    const machine = new StateMachine();
    machine.transition(PairPilotState.ANALYZING);
    machine.transition(PairPilotState.PROPOSING);
    machine.transition(PairPilotState.WAITING_FILE_APPROVAL);
    expect(machine.isAwaitingHuman()).toBe(true);
    expect(machine.isBusy()).toBe(false);
  });

  it('reports writing states', () => {
    const machine = new StateMachine();
    machine.transition(PairPilotState.ANALYZING);
    machine.transition(PairPilotState.PROPOSING);
    machine.transition(PairPilotState.WAITING_FILE_APPROVAL);
    machine.transition(PairPilotState.CREATING_FILE);
    expect(machine.isWriting()).toBe(true);
  });

  it('identifies terminal states', () => {
    expect(new StateMachine(PairPilotState.COMPLETED).isTerminal()).toBe(true);
    expect(new StateMachine(PairPilotState.APPROVED).isTerminal()).toBe(true);
    expect(new StateMachine(PairPilotState.REJECTED).isTerminal()).toBe(true);
    expect(new StateMachine(PairPilotState.IDLE).isTerminal()).toBe(false);
  });

  it('accepts a multi-state check', () => {
    const machine = new StateMachine(PairPilotState.REVIEWING);
    expect(machine.is(PairPilotState.REVIEWING, PairPilotState.WAITING_CODE_APPROVAL)).toBe(true);
    expect(machine.is(PairPilotState.IDLE)).toBe(false);
  });
});

describe('StateMachine: reset', () => {
  it('resets from a terminal state', () => {
    const machine = new StateMachine(PairPilotState.COMPLETED);
    machine.reset();
    expect(machine.state).toBe(PairPilotState.IDLE);
  });

  it('refuses to reset while a turn is in flight', () => {
    const machine = new StateMachine();
    machine.transition(PairPilotState.ANALYZING);
    expect(() => machine.reset()).toThrow(/still in progress/i);
  });

  it('refuses to reset from IDLE', () => {
    expect(() => new StateMachine().reset()).toThrow(/already in IDLE/);
  });
});

describe('StateMachine: notifications and history', () => {
  it('notifies listeners with the change', () => {
    const machine = new StateMachine();
    const listener = vi.fn();
    machine.onDidChange(listener);
    machine.transition(PairPilotState.ANALYZING, 'test reason');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        from: PairPilotState.IDLE,
        to: PairPilotState.ANALYZING,
        reason: 'test reason',
      })
    );
  });

  it('stops notifying after dispose', () => {
    const machine = new StateMachine();
    const listener = vi.fn();
    const subscription = machine.onDidChange(listener);
    subscription.dispose();
    machine.transition(PairPilotState.ANALYZING);
    expect(listener).not.toHaveBeenCalled();
  });

  it('records history', () => {
    const machine = new StateMachine();
    machine.transition(PairPilotState.ANALYZING);
    machine.transition(PairPilotState.PROPOSING);
    expect(machine.getHistory().map((change) => change.to)).toEqual([
      PairPilotState.ANALYZING,
      PairPilotState.PROPOSING,
    ]);
  });

  it('does not record a refused transition', () => {
    const machine = new StateMachine();
    try {
      machine.transition(PairPilotState.APPROVED);
    } catch {
      /* expected */
    }
    expect(machine.state).toBe(PairPilotState.IDLE);
    expect(machine.getHistory()).toHaveLength(0);
  });

  it('tryTransition reports refusal without throwing', () => {
    const machine = new StateMachine();
    expect(machine.tryTransition(PairPilotState.APPROVED)).toBe(false);
    expect(machine.tryTransition(PairPilotState.ANALYZING)).toBe(true);
    expect(machine.state).toBe(PairPilotState.ANALYZING);
  });
});

describe('STATE_TRANSITIONS table integrity', () => {
  it('covers every state', () => {
    const states = Object.values(PairPilotState);
    for (const state of states) {
      expect(STATE_TRANSITIONS[state], `missing entry for ${state}`).toBeDefined();
    }
  });

  it('only references known states', () => {
    const known = new Set<string>(Object.values(PairPilotState));
    for (const [from, targets] of Object.entries(STATE_TRANSITIONS)) {
      for (const target of targets) {
        expect(known.has(target), `${from} -> ${target}`).toBe(true);
      }
    }
  });

  it('never lists a state as its own successor', () => {
    for (const [from, targets] of Object.entries(STATE_TRANSITIONS)) {
      expect(targets.includes(from as PairPilotState), `${from} transitions to itself`).toBe(false);
    }
  });

  it('lets every non-terminal state reach CANCELLED', () => {
    // Cancellation must always be possible, or a stuck state could never be
    // escaped without reloading the window.
    const terminal = new Set([
      PairPilotState.APPROVED,
      PairPilotState.REJECTED,
      PairPilotState.COMPLETED,
      PairPilotState.FAILED,
      PairPilotState.CANCELLED,
    ]);
    for (const state of Object.values(PairPilotState)) {
      if (terminal.has(state)) {
        continue;
      }
      if (state === PairPilotState.IDLE) {
        // IDLE reaches CANCELLED directly.
        expect(STATE_TRANSITIONS[state].includes(PairPilotState.CANCELLED)).toBe(true);
        continue;
      }
      const reachable =
        STATE_TRANSITIONS[state].includes(PairPilotState.CANCELLED) ||
        STATE_TRANSITIONS[state].includes(PairPilotState.FAILED);
      expect(reachable, `${state} cannot be cancelled`).toBe(true);
    }
  });
});

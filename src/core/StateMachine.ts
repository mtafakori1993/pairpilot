/**
 * StateMachine — the authority on what PairPilot may do next.
 *
 * The Extension Host owns the only instance. The Webview renders the state but
 * cannot change it: Webview messages arrive as *requests* that the Orchestrator
 * checks against this machine. That is what makes "approval cannot be bypassed
 * from the UI" a structural property rather than a convention.
 *
 * Illegal transitions throw rather than being silently ignored. A swallowed
 * illegal transition is how approval bugs hide.
 */

import { PairPilotState, STATE_TRANSITIONS, TERMINAL_STATES } from '../types';

export interface StateChange {
  from: PairPilotState;
  to: PairPilotState;
  at: number;
  reason?: string;
}

export type StateListener = (change: StateChange) => void;

export class StateMachine {
  private current: PairPilotState;
  private readonly history: StateChange[] = [];
  private readonly listeners = new Set<StateListener>();
  private readonly maxHistory = 200;

  constructor(initial: PairPilotState = PairPilotState.IDLE) {
    this.current = initial;
  }

  get state(): PairPilotState {
    return this.current;
  }

  /** True when a transition to `to` is legal from the current state. */
  canTransition(to: PairPilotState): boolean {
    const allowed = STATE_TRANSITIONS[this.current];
    return allowed.includes(to);
  }

  /** Legal transitions from the current state. */
  allowedTransitions(): readonly PairPilotState[] {
    return STATE_TRANSITIONS[this.current];
  }

  /**
   * Move to `to`, or throw if the transition is illegal.
   * @throws Error when the transition is not permitted.
   */
  transition(to: PairPilotState, reason?: string): StateChange {
    if (to === this.current) {
      // Self-transitions are refused: they usually mean a duplicate event
      // (double-click on Approve) and must not re-trigger side effects.
      throw new Error(
        `Illegal transition: already in ${this.current}.`
      );
    }
    if (!this.canTransition(to)) {
      throw new Error(
        `Illegal transition ${this.current} -> ${to}. Allowed: ${
          STATE_TRANSITIONS[this.current].join(', ') || '(none)'
        }`
      );
    }
    const change: StateChange = { from: this.current, to, at: Date.now(), reason };
    this.current = to;
    this.history.push(change);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
    for (const listener of this.listeners) {
      listener(change);
    }
    return change;
  }

  /** Non-throwing variant for UI-facing code that only needs a yes/no. */
  tryTransition(to: PairPilotState, reason?: string): boolean {
    if (!this.canTransition(to)) {
      return false;
    }
    this.transition(to, reason);
    return true;
  }

  is(...states: PairPilotState[]): boolean {
    return states.includes(this.current);
  }

  isTerminal(): boolean {
    return TERMINAL_STATES.includes(this.current);
  }

  /**
   * True while an AI turn is in flight. Used to disable the composer and to
   * refuse a second concurrent task.
   */
  isBusy(): boolean {
    return this.is(
      PairPilotState.ANALYZING,
      PairPilotState.PROPOSING,
      PairPilotState.CREATING_FILE,
      PairPilotState.WRITING_CODE,
      PairPilotState.ANALYZING_NEXT_STEP
    );
  }

  /**
   * True when PairPilot is waiting on a human decision. The UI must render the
   * corresponding prompt, and no autonomous step may proceed.
   */
  isAwaitingHuman(): boolean {
    return this.is(
      PairPilotState.WAITING_FILE_APPROVAL,
      PairPilotState.WAITING_CODE_APPROVAL,
      PairPilotState.REVIEWING
    );
  }

  /** True when a file operation is in progress and can be rolled back. */
  isWriting(): boolean {
    return this.is(PairPilotState.CREATING_FILE, PairPilotState.WRITING_CODE);
  }

  onDidChange(listener: StateListener): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  getHistory(): readonly StateChange[] {
    return this.history;
  }

  /**
   * Return to IDLE from a terminal state, for a fresh turn in the same session.
   * Refuses while a turn is in flight so a late UI event cannot abort work.
   */
  reset(reason = 'reset for a new turn'): StateChange {
    if (this.current === PairPilotState.IDLE) {
      throw new Error('Illegal transition: already in IDLE.');
    }
    if (!this.canTransition(PairPilotState.IDLE)) {
      throw new Error(
        `Cannot reset from ${this.current}; this turn is still in progress. Cancel it first.`
      );
    }
    return this.transition(PairPilotState.IDLE, reason);
  }
}

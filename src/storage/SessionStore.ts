/**
 * SessionStore — local persistence for sessions.
 *
 * Spec section 11: persist session state using VS Code storage APIs. This uses
 * `workspaceState`, so history is scoped to the project rather than leaking
 * between unrelated workspaces, and nothing leaves the machine.
 *
 * Two details worth stating plainly:
 *
 *  - The Claude Code session id is persisted, because that is what makes "session
 *    can be resumed" true across window reloads. Without it, resume would only
 *    work within a single VS Code session.
 *  - Context file *contents* are never persisted. Only the paths the developer
 *    pinned are stored. History therefore cannot become a cache of source code,
 *    which would be a quiet exfiltration risk and would also go stale.
 */

import * as crypto from 'node:crypto';
import type * as vscode from 'vscode';
import {
  emptyUsage,
  type ChatMessage,
  type SessionRecord,
  type SessionSummary,
  type TokenUsage,
} from '../types';

const STORAGE_KEY = 'pairpilot.sessions.v1';
const ACTIVE_KEY = 'pairpilot.activeSessionId.v1';

/** Hard caps, so a long-lived workspace cannot grow storage without bound. */
const MAX_SESSIONS = 50;
const MAX_MESSAGES_PER_SESSION = 400;
const MAX_MESSAGE_CHARS = 100_000;

export class SessionStore {
  private readonly cache = new Map<string, SessionRecord>();
  private activeId: string | null = null;
  private readonly maxSessions: number;
  private loaded = false;

  constructor(
    private readonly memento: vscode.Memento,
    private readonly logger: { warn(m: string): void; error(m: string, e?: unknown): void },
    options: { maxSessions?: number } = {}
  ) {
    this.maxSessions = Math.max(1, Math.min(options.maxSessions ?? MAX_SESSIONS, 500));
  }

  /**
   * Exposed so the extension can log once, at activation, whether history was
   * restored. Keeps the logger dependency meaningful without logging on every
   * store operation.
   */
  describeState(): string {
    return `${this.cache.size} stored session(s); active: ${this.activeId ?? 'none'}`;
  }

  /** Load persisted state. Safe to call repeatedly. */
  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const raw = this.memento.get<unknown>(STORAGE_KEY);
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          const record = reviveSession(entry, this.logger);
          if (record) {
            this.cache.set(record.id, record);
          }
        }
      }
      const active = this.memento.get<unknown>(ACTIVE_KEY);
      if (typeof active === 'string' && this.cache.has(active)) {
        this.activeId = active;
      }
    } catch (error) {
      // Corrupt storage must not prevent activation; start clean instead.
      this.logger.error('Could not read stored PairPilot sessions; starting fresh.', error);
      this.cache.clear();
      this.activeId = null;
    }
  }

  /** Create a new session and make it active. */
  create(title = 'New session'): SessionRecord {
    const record: SessionRecord = {
      id: crypto.randomUUID(),
      title: title.slice(0, 200),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      usage: emptyUsage(),
      proposals: [],
    };
    this.cache.set(record.id, record);
    this.activeId = record.id;
    void this.persist();
    return record;
  }

  getActive(): SessionRecord | null {
    if (!this.activeId) {
      return null;
    }
    return this.cache.get(this.activeId) ?? null;
  }

  /** Get the active session, creating one if none exists. */
  getOrCreateActive(): SessionRecord {
    return this.getActive() ?? this.create();
  }

  setActive(sessionId: string): SessionRecord | null {
    const record = this.cache.get(sessionId);
    if (!record) {
      return null;
    }
    this.activeId = sessionId;
    void this.persist();
    return record;
  }

  get(sessionId: string): SessionRecord | null {
    return this.cache.get(sessionId) ?? null;
  }

  /** The persisted Claude Code session id, used for `--resume`. */
  getRuntimeSessionId(sessionId: string): string | undefined {
    return this.cache.get(sessionId)?.runtimeSessionId;
  }

  setRuntimeSessionId(sessionId: string, runtimeSessionId: string): void {
    const record = this.cache.get(sessionId);
    if (!record || !runtimeSessionId) {
      return;
    }
    if (record.runtimeSessionId === runtimeSessionId) {
      return;
    }
    record.runtimeSessionId = runtimeSessionId;
    record.updatedAt = Date.now();
    void this.persist();
  }

  appendMessage(sessionId: string, message: ChatMessage): void {
    const record = this.cache.get(sessionId);
    if (!record) {
      return;
    }
    const trimmed: ChatMessage = {
      ...message,
      text: message.text.slice(0, MAX_MESSAGE_CHARS),
    };
    record.messages.push(trimmed);
    if (record.messages.length > MAX_MESSAGES_PER_SESSION) {
      // Drop from the front: recent turns matter most for continuity.
      record.messages.splice(0, record.messages.length - MAX_MESSAGES_PER_SESSION);
    }
    record.updatedAt = Date.now();
    if (record.title === 'New session' && message.role === 'user') {
      record.title = message.text.trim().slice(0, 80) || 'New session';
    }
    void this.persist();
  }

  /** Replace the streaming placeholder for an assistant turn. */
  updateMessage(sessionId: string, messageId: string, patch: Partial<ChatMessage>): void {
    const record = this.cache.get(sessionId);
    if (!record) {
      return;
    }
    const index = record.messages.findIndex((message) => message.id === messageId);
    const existing = record.messages[index];
    if (index === -1 || !existing) {
      return;
    }
    record.messages[index] = { ...existing, ...patch };
    record.updatedAt = Date.now();
    void this.persist();
  }

  addUsage(sessionId: string, usage: TokenUsage): void {
    const record = this.cache.get(sessionId);
    if (!record) {
      return;
    }
    record.usage = accumulate(record.usage, usage);
    record.updatedAt = Date.now();
    void this.persist();
  }

  setUsage(sessionId: string, usage: TokenUsage): void {
    const record = this.cache.get(sessionId);
    if (!record) {
      return;
    }
    record.usage = usage;
    void this.persist();
  }

  addProposal(sessionId: string, proposal: SessionRecord['proposals'][number]): void {
    const record = this.cache.get(sessionId);
    if (!record) {
      return;
    }
    record.proposals.push(proposal);
    // Keep storage bounded; the approval history lives in memory.
    if (record.proposals.length > 100) {
      record.proposals.splice(0, record.proposals.length - 100);
    }
    record.updatedAt = Date.now();
    void this.persist();
  }

  recordRollback(sessionId: string, entry: NonNullable<SessionRecord['rolledBackWrites']>[number]): void {
    const record = this.cache.get(sessionId);
    if (!record) {
      return;
    }
    record.rolledBackWrites = [...(record.rolledBackWrites ?? []), entry].slice(-50);
    record.updatedAt = Date.now();
    void this.persist();
  }

  /** Most recently updated first. */
  list(): SessionSummary[] {
    return [...this.cache.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((record) => ({
        id: record.id,
        title: record.title,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        messageCount: record.messages.length,
        proposalCount: record.proposals.length,
      }));
  }

  knownIds(): Set<string> {
    return new Set(this.cache.keys());
  }

  delete(sessionId: string): boolean {
    const existed = this.cache.delete(sessionId);
    if (this.activeId === sessionId) {
      this.activeId = null;
    }
    if (existed) {
      void this.persist();
    }
    return existed;
  }

  /** Drop the oldest sessions beyond the configured cap. */
  private prune(): void {
    if (this.cache.size <= this.maxSessions) {
      return;
    }
    const ordered = [...this.cache.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    const excess = this.cache.size - this.maxSessions;
    for (let i = 0; i < excess; i++) {
      const victim = ordered[i];
      if (victim) {
        this.cache.delete(victim.id);
      }
    }
  }

  /**
   * Persist to `workspaceState`.
   *
   * Failures are logged rather than thrown: losing history is annoying, but it
   * must never break an in-flight approval flow.
   */
  private async persist(): Promise<void> {
    try {
      this.prune();
      const payload = [...this.cache.values()];
      await this.memento.update(STORAGE_KEY, payload);
      await this.memento.update(ACTIVE_KEY, this.activeId);
    } catch (error) {
      this.logger.error('Could not persist PairPilot session state.', error);
    }
  }

  /** Test/debug helper: the number of stored sessions. */
  get size(): number {
    return this.cache.size;
  }
}

/** Add usage, preserving "cost unknown" as unknown rather than zero. */
export function accumulate(a: TokenUsage, b: TokenUsage): TokenUsage {
  const costKnown = a.costUsd !== null && b.costUsd !== null;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    costUsd: costKnown ? (a.costUsd as number) + (b.costUsd as number) : null,
    available: a.available || b.available,
    ...(b.model ?? a.model ? { model: b.model ?? a.model } : {}),
  };
}

/**
 * Validate a value read back from storage, discarding anything malformed.
 *
 * Storage is written by this extension, but a downgrade, a hand-edited state
 * file, or an interrupted write can leave a shape we no longer understand.
 * Discarding a bad entry is correct; refusing to activate is not. The reason is
 * logged so a developer whose history vanished can find out why.
 */
function reviveSession(
  value: unknown,
  logger: { warn(m: string): void }
): SessionRecord | null {
  if (value === null || typeof value !== 'object') {
    logger.warn('Discarded a stored PairPilot session: it was not an object.');
    return null;
  }
  const record = value as Partial<SessionRecord>;
  if (typeof record.id !== 'string' || record.id.length === 0) {
    logger.warn('Discarded a stored PairPilot session: it had no id.');
    return null;
  }
  const messages = Array.isArray(record.messages)
    ? record.messages.filter(isPlausibleMessage)
    : [];
  const createdAt = typeof record.createdAt === 'number' ? record.createdAt : Date.now();

  return {
    id: record.id,
    ...(typeof record.runtimeSessionId === 'string'
      ? { runtimeSessionId: record.runtimeSessionId }
      : {}),
    title: typeof record.title === 'string' ? record.title : 'Session',
    createdAt,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : createdAt,
    messages,
    usage: isPlausibleUsage(record.usage) ? record.usage : emptyUsage(),
    proposals: Array.isArray(record.proposals) ? record.proposals.filter(isPlausibleProposal) : [],
  };
}

function isPlausibleMessage(value: unknown): value is ChatMessage {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const message = value as Partial<ChatMessage>;
  return (
    typeof message.id === 'string' &&
    (message.role === 'user' || message.role === 'assistant' || message.role === 'system') &&
    typeof message.text === 'string' &&
    typeof message.timestamp === 'number'
  );
}

function isPlausibleUsage(value: unknown): value is TokenUsage {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const usage = value as Partial<TokenUsage>;
  return (
    typeof usage.inputTokens === 'number' &&
    typeof usage.outputTokens === 'number' &&
    typeof usage.available === 'boolean'
  );
}

function isPlausibleProposal(value: unknown): value is SessionRecord['proposals'][number] {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const proposal = value as Record<string, unknown>;
  return (
    typeof proposal['relativePath'] === 'string' &&
    typeof proposal['contentHash'] === 'string' &&
    Array.isArray(proposal['blocks'])
  );
}

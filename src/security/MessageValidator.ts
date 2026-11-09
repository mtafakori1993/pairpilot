/**
 * MessageValidator — the trust boundary between the Webview and the Extension
 * Host.
 *
 * The Webview is a presentation layer that may be compromised by anything it
 * renders (a pasted string, an AI message containing markup, a future XSS).
 * Therefore every inbound message is untrusted input and is validated for
 * *shape* here, before the Orchestrator ever sees it.
 *
 * Two rules this module enforces:
 *   1. Never trust a payload's types, lengths or keys.
 *   2. Only accept decisions that carry the content hash of the exact proposal
 *      the developer was shown. A message cannot say "approve" without saying
 *      *what* it approves, and that hash is verified later against the live
 *      proposal.
 */

import { MessageRejectedError } from '../core/errors';
import type { WebviewRequest } from '../types';

/** Upper bounds, to keep a hostile Webview from allocating without limit. */
const MAX_TEXT_LENGTH = 32_000;
const MAX_FEEDBACK_LENGTH = 8_000;
const MAX_PATH_LENGTH = 1_024;
const MAX_ID_LENGTH = 128;

/** SHA-256 hex digest, which is the only accepted hash format. */
const SHA256_HEX = /^[a-f0-9]{64}$/;

/** Keys that must never appear in an inbound payload (prototype pollution). */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface ValidationContext {
  /** Set of session ids the host currently knows about. */
  knownSessionIds?: ReadonlySet<string>;
}

export class MessageValidator {
  /**
   * Parse and validate an unknown value from `webview.onDidReceiveMessage`.
   * @throws MessageRejectedError with a reason suitable for the log.
   */
  validate(raw: unknown, context: ValidationContext = {}): WebviewRequest {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new MessageRejectedError('Webview message must be a JSON object.');
    }
    const message = raw as Record<string, unknown>;

    for (const key of Object.keys(message)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new MessageRejectedError(`Webview message contains a forbidden key: ${key}`);
      }
    }

    const type = message['type'];
    if (typeof type !== 'string') {
      throw new MessageRejectedError('Webview message is missing a string "type".');
    }

    switch (type) {
      case 'ready':
      case 'cancel':
      case 'acceptRecommendation':
      case 'dismissRecommendation':
      case 'newSession':
      case 'addActiveEditorContext':
      case 'revealOutput':
        return { type };

      case 'submitTask':
        return { type, text: this.requireText(message, 'text', MAX_TEXT_LENGTH, 'task') };

      case 'requestChanges':
        return {
          type,
          contentHash: this.requireHash(message, 'contentHash'),
          feedback: this.requireText(message, 'feedback', MAX_FEEDBACK_LENGTH, 'feedback'),
        };

      case 'approveFileCreation':
      case 'rejectFileCreation':
      case 'approveCode':
      case 'rejectCode':
        return { type, contentHash: this.requireHash(message, 'contentHash') };

      case 'loadSession':
      case 'deleteSession': {
        const sessionId = this.requireString(message, 'sessionId', MAX_ID_LENGTH);
        if (context.knownSessionIds && !context.knownSessionIds.has(sessionId)) {
          throw new MessageRejectedError(`Unknown session id: ${sessionId}`);
        }
        return { type, sessionId };
      }

      case 'openFile':
        return { type, relativePath: this.requireString(message, 'relativePath', MAX_PATH_LENGTH) };

      case 'removeContext':
        return {
          type,
          relativePath: this.requireString(message, 'relativePath', MAX_PATH_LENGTH),
        };

      default:
        throw new MessageRejectedError(`Unsupported message type: ${type}`);
    }
  }

  /** Non-throwing helper for callers that prefer a result tuple. */
  tryValidate(
    raw: unknown,
    context: ValidationContext = {}
  ): { ok: true; value: WebviewRequest } | { ok: false; error: string } {
    try {
      return { ok: true, value: this.validate(raw, context) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private requireString(
    message: Record<string, unknown>,
    key: string,
    maxLength: number
  ): string {
    const value = message[key];
    if (typeof value !== 'string') {
      throw new MessageRejectedError(`Field "${key}" must be a string.`);
    }
    if (value.length === 0) {
      throw new MessageRejectedError(`Field "${key}" must not be empty.`);
    }
    if (value.length > maxLength) {
      throw new MessageRejectedError(
        `Field "${key}" exceeds the maximum length of ${maxLength} characters.`
      );
    }
    if (value.includes('\u0000')) {
      throw new MessageRejectedError(`Field "${key}" contains a NUL byte.`);
    }
    return value;
  }

  /** Text fields allow whitespace but must carry non-whitespace content. */
  private requireText(
    message: Record<string, unknown>,
    key: string,
    maxLength: number,
    label: string
  ): string {
    const value = this.requireString(message, key, maxLength);
    if (value.trim().length === 0) {
      throw new MessageRejectedError(`The ${label} must not be blank.`);
    }
    return value;
  }

  private requireHash(message: Record<string, unknown>, key: string): string {
    const value = this.requireString(message, key, 64);
    if (!SHA256_HEX.test(value)) {
      throw new MessageRejectedError(
        `Field "${key}" must be a lowercase SHA-256 hex digest.`
      );
    }
    return value;
  }
}

/**
 * Adaptation: bringing a reply of *any* plausible shape into the canonical one.
 *
 * ## The bug this module fixes
 *
 * PairPilot 0.1.x recognised a reply as a proposal only if it had a root-level
 * `blocks` array. A model answering a multi-file request naturally produced:
 *
 *     { "type": "code_proposal",
 *       "proposal": { "message": "Created a PHP User class with SQLite service…",
 *                     "changes": [ { "file": "User.php", "type": "create",
 *                                    "content": "<?php …" } ] } }
 *
 * Valid JSON, correct intent, complete code — refused, with a message saying it
 * "is not a code_proposal object". The model was not wrong; the contract was too
 * narrow and the parser had no way to say so.
 *
 * ## What adaptation does, and what it does not
 *
 * It rewrites *shape*, never meaning. It renames `file`/`path`/`filePath` to
 * `file`, `type`/`operation` to `operation`, `content`/`code` to `content`, and
 * splices a nested `proposal` object up to the envelope. It concatenates a
 * legacy `blocks[]` array into the single `content` string that the canonical
 * contract carries, because that is what the developer reviewed in 0.1.x and
 * what the file on disk contained.
 *
 * It does **not** invent content. If a change has no code in any of the keys a
 * model might have used, adaptation leaves it empty and validation refuses the
 * reply. Guessing at code is the one thing that would make this layer dangerous.
 *
 * Everything it does is recorded as an `AdaptationKind` plus a list of notes, so
 * a later report of "the model keeps answering oddly" can be answered with the
 * shape that actually arrived.
 */

import { PROTOCOL_MESSAGE_TYPES, type AdaptationKind } from './types';

/** What adaptation produced, before validation. */
export interface AdaptedCandidate {
  /** Best-effort canonical shape. Still untrusted; validate before use. */
  value: Record<string, unknown>;
  /** Which shape was recognised. */
  kind: AdaptationKind;
  /** What was rewritten, in plain language, for the diagnostics panel. */
  notes: string[];
}

/** Keys a model might use for the same concept, in priority order. */
const FILE_KEYS = ['file', 'filePath', 'filepath', 'path', 'filename', 'target'] as const;
const CONTENT_KEYS = ['content', 'code', 'source', 'text', 'body', 'newContent'] as const;
const OPERATION_KEYS = ['operation', 'type', 'action', 'op', 'changeType'] as const;
const DESCRIPTION_KEYS = ['description', 'summary', 'title', 'purpose'] as const;
const DEPENDENCY_KEYS = ['dependencies', 'dependsOn', 'requires', 'imports'] as const;
const MESSAGE_KEYS = ['message', 'explanation', 'text', 'summary', 'response'] as const;

/** Read the first key that is present and non-empty, in priority order. */
function pick(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) {
      if (typeof value === 'string' && value.trim().length === 0) {
        continue;
      }
      return value;
    }
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const output: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim().length > 0) {
      output.push(item.trim());
    } else if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const nested = pick(item as Record<string, unknown>, ['path', 'file', 'name', 'package']);
      const text = asString(nested);
      if (text) {
        output.push(text);
      }
    }
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* -------------------------------------------------------------------------- */
/* Change-level adaptation                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Rewrite one change object into the canonical key names.
 *
 * The `changes` array element may itself carry a legacy `blocks[]` array — the
 * shape 0.1.x used for a single file whose content was assembled from named
 * pieces. Those are joined with newlines, which is exactly how the 0.1.x writer
 * assembled them, so the resulting content matches byte for byte what the
 * developer would have reviewed then.
 */
function adaptChange(raw: unknown, index: number, notes: string[]): Record<string, unknown> {
  if (!isRecord(raw)) {
    // Leave the value untouched so validation reports "must be an object"
    // against the path the model actually sent.
    return { __unadapted: raw } as unknown as Record<string, unknown>;
  }

  const file = pick(raw, FILE_KEYS);
  const operation = pick(raw, OPERATION_KEYS);
  const description = pick(raw, DESCRIPTION_KEYS);
  const dependencies = pick(raw, DEPENDENCY_KEYS);

  let content = pick(raw, CONTENT_KEYS);

  // Legacy `blocks[]`: join the pieces the way the 0.1.x writer did.
  if (content === undefined && Array.isArray(raw['blocks'])) {
    const pieces: string[] = [];
    for (const block of raw['blocks']) {
      if (isRecord(block)) {
        const code = asString(pick(block, CONTENT_KEYS));
        if (code !== undefined) {
          pieces.push(code);
        }
      } else {
        const code = asString(block);
        if (code !== undefined) {
          pieces.push(code);
        }
      }
    }
    if (pieces.length > 0) {
      content = pieces.join('\n');
      notes.push(
        `Change ${index + 1}: joined ${pieces.length} legacy "blocks" into the single "content" the contract carries.`
      );
    }
  }

  const rationale = asString(raw['rationale'] ?? raw['why']);
  const language = asString(raw['language'] ?? raw['lang']);
  const risk = asString(raw['risk'] ?? raw['riskLevel']);
  const responsibilities = asStringList(raw['responsibilities'] ?? raw['responsibility']);
  const potentialProblems = asStringList(
    raw['potentialProblems'] ?? raw['risks'] ?? raw['problems']
  );

  const out: Record<string, unknown> = {};
  if (file !== undefined) out['file'] = file;
  if (operation !== undefined) out['operation'] = operation;
  if (description !== undefined) out['description'] = description;
  if (content !== undefined) out['content'] = content;
  if (dependencies !== undefined) out['dependencies'] = asStringList(dependencies);
  if (rationale !== undefined) out['rationale'] = rationale;
  if (language !== undefined) out['language'] = language;
  if (risk !== undefined) out['risk'] = risk;
  if (responsibilities.length > 0) out['responsibilities'] = responsibilities;
  if (potentialProblems.length > 0) out['potentialProblems'] = potentialProblems;
  // `id` is carried through when the model supplied one; validation generates a
  // stable fallback otherwise, so omitting it is not an error.
  if (typeof raw['id'] === 'string' && raw['id'].trim().length > 0) {
    out['id'] = raw['id'].trim();
  }

  return out;
}

/**
 * A change with no explicit operation is a "create" when the file is new and an
 * "update" otherwise — but this layer has no filesystem, so it cannot know.
 * It therefore leaves the operation absent and lets validation say so, which
 * produces the actionable "state the operation" diagnostic rather than a guess
 * that silently overwrites a file.
 */
function inferOperation(operation: unknown, notes: string[], index: number): unknown {
  const text = asString(operation);
  if (text === undefined) {
    return undefined;
  }
  const normalised = text.trim().toLowerCase().replace(/[\s-]+/g, '_');
  // The nested shape that broke 0.1.x used `type` for the operation, and some
  // models write `type: "file"` there instead. `file` is not an operation.
  if (normalised === 'file' || normalised === 'new' || normalised === 'add') {
    notes.push(`Change ${index + 1}: read "${text}" as "create".`);
    return 'create';
  }
  if (normalised === 'modify' || normalised === 'edit' || normalised === 'change') {
    notes.push(`Change ${index + 1}: read "${text}" as "update".`);
    return 'update';
  }
  return text;
}

/* -------------------------------------------------------------------------- */
/* Envelope adaptation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Recognise the shape of a candidate reply and rewrite it to canonical form.
 *
 * The order of the checks matters. Each is tried against the *root* first and
 * then against a `proposal` sub-object, because "the payload is one level down"
 * is the single most common structural difference between models.
 */
export function adaptCandidate(value: unknown): AdaptedCandidate {
  const notes: string[] = [];

  if (!isRecord(value)) {
    return { value: {}, kind: 'prose', notes: ['The reply was not a JSON object.'] };
  }

  // --- 1. Is the payload nested one level down? ---------------------------
  // Checked before anything else: when a root object has BOTH a `type` and a
  // nested `proposal` carrying the changes, the nested object is the payload and
  // the root is a thin wrapper.
  const nested = value['proposal'] ?? value['code_proposal'] ?? value['result'] ?? value['data'];
  if (isRecord(nested) && !Array.isArray(value['changes'])) {
    const nestedHasPayload =
      Array.isArray(nested['changes']) ||
      Array.isArray(nested['files']) ||
      Array.isArray(nested['blocks']);
    if (nestedHasPayload) {
      notes.push('The reply nested its payload under "proposal"; it was lifted to the envelope.');
      const merged: Record<string, unknown> = {
        ...nested,
        // The root's own type wins when it is a real message type; the nested
        // object usually has no type at all.
        type: asString(value['type']) ?? nested['type'],
      };
      if (asString(merged['message']) === undefined) {
        const message = pick(nested, MESSAGE_KEYS) ?? pick(value, MESSAGE_KEYS);
        if (message !== undefined) {
          merged['message'] = message;
        }
      }
      // The lifted object is itself in some shape — usually the 0.1.x flat one,
      // with `blocks`/`filePath` at its root. Re-entering adaptation is what
      // turns it into canonical changes; without this the lift produces an
      // envelope with no `changes` array and validation refuses the reply.
      const inner = adaptCandidate(merged);
      return {
        value: inner.value,
        kind: 'nested_proposal',
        notes: [...notes, ...inner.notes],
      };
    }
  }

  // --- 2. Root-level changes, with a recognisable envelope ----------------
  const changes = value['changes'] ?? value['files'];
  if (Array.isArray(changes)) {
    return finish(
      value,
      isKnownMessageType(value['type']) ? 'canonical' : 'flat_changes',
      notes
    );
  }

  // --- 3. No envelope at all: a bare change object ------------------------
  // Checked before the legacy shape, because a bare change also has `file` and
  // `operation` and would otherwise be misread as a 0.1.x envelope — which is
  // how a fragment of a larger reply could be quietly accepted on its own.
  if (
    asString(value['type']) === undefined &&
    asString(pick(value, FILE_KEYS)) !== undefined &&
    (pick(value, CONTENT_KEYS) !== undefined || Array.isArray(value['blocks']))
  ) {
    notes.push('The reply was a bare change with no envelope; an envelope was synthesised.');
    return finish(
      {
        type: 'code_proposal',
        changes: [adaptChange(value, 0, notes)],
      },
      'bare_change',
      notes
    );
  }

  // --- 4. Legacy flat: a single file at the root --------------------------
  if (Array.isArray(value['blocks']) || asString(value['filePath']) !== undefined) {
    notes.push('The reply used the single-file shape of PairPilot 0.1.x; it was read as a one-change proposal.');
    const change = adaptChange(value, 0, notes);
    const out: Record<string, unknown> = {
      ...value,
      changes: [change],
    };
    delete out['blocks'];
    delete out['filePath'];
    delete out['operation'];
    // `finish` is skipped here because the change is already adapted; the
    // message synthesis it performs is applied by the call below.
    return finish(out, 'legacy_flat', notes);
  }

  // --- 5. Already canonical (or a non-proposal type) ----------------------
  return finish(value, 'canonical', notes);
}

/** Is this one of the protocol's message type names? */
function isKnownMessageType(value: unknown): boolean {
  const text = asString(value);
  return text !== undefined && (PROTOCOL_MESSAGE_TYPES as readonly string[]).includes(text.trim());
}

/**
 * Normalise the change array of an already-envelope-shaped candidate.
 *
 * Split out because every path above funnels here: whatever produced the
 * envelope, its `changes` entries still need their key names normalised and
 * their operations inferred.
 */
function finish(
  value: Record<string, unknown>,
  kind: AdaptationKind,
  notes: string[]
): AdaptedCandidate {
  const out: Record<string, unknown> = { ...value };

  if (!asString(out['type'])) {
    // A reply with `changes` and no type can only have meant a proposal.
    if (Array.isArray(out['changes'])) {
      out['type'] = 'code_proposal';
      notes.push('The reply carried "changes" but no "type"; it was read as a code_proposal.');
    }
  }

  if (Array.isArray(out['changes'])) {
    out['changes'] = (out['changes'] as unknown[]).map((raw, index) => {
      const change = adaptChange(raw, index, notes);
      if (isRecord(raw) && change['operation'] !== undefined) {
        const inferred = inferOperation(change['operation'], notes, index);
        if (inferred === undefined) {
          delete change['operation'];
        } else {
          change['operation'] = inferred;
        }
      }
      return change;
    });
  }

  if (asString(out['message']) === undefined) {
    const message = pick(out, MESSAGE_KEYS);
    if (message !== undefined) {
      out['message'] = asString(message) ?? String(message);
    }
  }

  // Every message type requires a human-readable `message`, and the 0.1.x shape
  // did not have one: it carried `description` instead. Synthesising a summary
  // from the proposal's own words is shape rewriting, not invention — the file
  // content is never touched, and the developer still reads what the model said
  // about the change. Only when there is nothing to quote is a neutral sentence
  // used, and that is recorded as a note.
  if (asString(out['message']) === undefined) {
    const first = Array.isArray(out['changes']) ? (out['changes'] as unknown[])[0] : undefined;
    const quoted =
      asString(pick(out, DESCRIPTION_KEYS)) ??
      (isRecord(first) ? asString(pick(first, DESCRIPTION_KEYS)) : undefined) ??
      (isRecord(out['task']) ? asString(pick(out['task'] as Record<string, unknown>, ['title', 'description'])) : undefined);

    if (quoted !== undefined) {
      out['message'] = quoted;
      notes.push('The reply carried no "message"; its own description was used as the summary.');
    } else {
      out['message'] = 'The AI proposed a change without describing it.';
      notes.push('The reply carried no "message", and none could be recovered from it.');
    }
  }

  return { value: out, kind, notes };
}

/**
 * Runtime validation for the canonical response contract.
 *
 * ## Why a hand-written validator instead of a schema library
 *
 * PairPilot ships with **zero runtime dependencies** — the whole extension is
 * bundled by esbuild into a single file, and every other trust boundary in the
 * codebase (`PathGuard`, `MessageValidator`, `ProposalValidator`) is hand-written
 * for the same reason: a defence that a reader can audit line by line beats a
 * defence that requires trusting a transitive dependency tree.
 *
 * A schema library would also fight the requirement this module exists to meet.
 * The parser must produce a *diagnostic* for a bad reply — which field, what was
 * expected, what arrived — and it must do so for a reply that is 90% right, so
 * the retry prompt can say exactly what to fix. Most validators stop at the
 * first error and describe it in their own vocabulary.
 *
 * ## What "validation" means here
 *
 * This function parses and normalises: it fills optional fields with their
 * documented defaults (`risk: "low"`, `dependencies: []`) and generates stable
 * ids for changes that arrived without one. It never invents *content*. A change
 * with no `content`, an envelope with no `type`, a file path that is blank —
 * those are reported as issues and the caller refuses the reply.
 *
 * ## What it deliberately does not do
 *
 * It does not check the workspace. A path that is syntactically fine can still
 * escape the workspace root, name a private key, or collide with an existing
 * file; those are `PathGuard` and `ProposalValidator`'s job, and they are the
 * only place with the workspace in hand.
 */

import {
  ALL_OPERATIONS,
  CHANGE_RISKS,
  EXECUTABLE_OPERATIONS,
  PROTOCOL_MESSAGE_TYPES,
  DEFAULT_PROTOCOL_VERSION,
  RESERVED_OPERATIONS,
  SUPPORTED_PROTOCOL_VERSIONS,
  TASK_STATUSES,
  type ChangeOperation,
  type ExecutableOperation,
  type ProposalChange,
  type ProposalNextStep,
  type ProposalSummary,
  type ProposalTask,
  type ProtocolIssue,
  type ProtocolMessage,
  type ProtocolMessageType,
  type TaskStatus,
} from './types';

/* -------------------------------------------------------------------------- */
/* Limits                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Upper bounds. Generous enough for a real multi-file change to a large
 * codebase, tight enough that a runaway or hostile reply cannot exhaust memory.
 */
export const PROTOCOL_LIMITS = {
  maxChanges: 64,
  maxContentChars: 400_000,
  maxTotalContentChars: 2_000_000,
  maxDescriptionChars: 4_000,
  maxPathChars: 512,
  maxListItems: 50,
  maxListItemChars: 512,
  maxDependencies: 200,
} as const;

/* -------------------------------------------------------------------------- */
/* Result                                                                     */
/* -------------------------------------------------------------------------- */

export type ProtocolValidationResult =
  | {
      ok: true;
      value: ProtocolMessage;
      /**
       * Non-fatal observations — a reserved operation that was reported rather
       * than refused, an unknown field that was dropped. Surfaced so nothing
       * about the reply changes silently.
       */
      notes: string[];
    }
  | { ok: false; issues: ProtocolIssue[] };

/* -------------------------------------------------------------------------- */
/* Small readers                                                              */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a required non-empty string, reporting a stable issue when absent. */
function requiredString(
  source: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProtocolIssue[],
  options: { maxChars?: number } = {}
): string {
  const value = source[key];
  if (value === undefined || value === null) {
    issues.push({
      path: `${path}/${key}`,
      code: 'missing_field',
      message: `The "${key}" field is required and was not present.`,
    });
    return '';
  }
  if (typeof value !== 'string') {
    issues.push({
      path: `${path}/${key}`,
      code: 'wrong_type',
      message: `"${key}" must be a string but arrived as ${describeType(value)}.`,
    });
    return '';
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    issues.push({
      path: `${path}/${key}`,
      code: 'empty_value',
      message: `"${key}" is present but empty.`,
    });
    return '';
  }
  const max = options.maxChars;
  if (max !== undefined && value.length > max) {
    issues.push({
      path: `${path}/${key}`,
      code: 'too_large',
      message: `"${key}" is ${value.length} characters; the maximum is ${max}.`,
    });
    return value.slice(0, max);
  }
  return value;
}

/** Read an optional string, ignoring one of the wrong type but noting it. */
function optionalString(
  source: Record<string, unknown>,
  key: string,
  path: string,
  notes: string[],
  options: { maxChars?: number } = {}
): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    notes.push(`${path}/${key} was ignored: expected a string, received ${describeType(value)}.`);
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return options.maxChars !== undefined ? value.slice(0, options.maxChars) : value;
}

/** Read an optional list of strings, dropping non-strings with a note. */
function optionalStringList(
  source: Record<string, unknown>,
  key: string,
  path: string,
  notes: string[],
  maxItems: number = PROTOCOL_LIMITS.maxListItems
): string[] {
  const value = source[key];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    notes.push(`${path}/${key} was ignored: expected an array, received ${describeType(value)}.`);
    return [];
  }
  const output: string[] = [];
  for (const item of value.slice(0, maxItems)) {
    if (typeof item === 'string' && item.trim().length > 0) {
      output.push(item.trim().slice(0, PROTOCOL_LIMITS.maxListItemChars));
    } else if (isRecord(item)) {
      // Models sometimes write an object where a string was asked for. A
      // `{ "path": "src/x.ts" }` dependency is unambiguous enough to read.
      const nested = item['path'] ?? item['file'] ?? item['name'];
      if (typeof nested === 'string' && nested.trim().length > 0) {
        output.push(nested.trim().slice(0, PROTOCOL_LIMITS.maxListItemChars));
      }
    }
  }
  if (value.length > maxItems) {
    notes.push(
      `${path}/${key} had ${value.length} entries; only the first ${maxItems} were kept.`
    );
  }
  return output;
}

/** Read an optional boolean with a documented default. */
function optionalBoolean(
  source: Record<string, unknown>,
  key: string,
  fallback: boolean,
  path: string,
  notes: string[]
): boolean {
  const value = source[key];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'true' || value === 'false') {
    return value === 'true';
  }
  notes.push(`${path}/${key} was ignored: expected a boolean, received ${describeType(value)}.`);
  return fallback;
}

/** Human-readable type name, for diagnostics that a developer can act on. */
function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  switch (typeof value) {
    case 'string':
      return 'a string';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    case 'object':
      return 'an object';
    default:
      return typeof value;
  }
}

/**
 * Match a value against a closed vocabulary, tolerating the separators and
 * letter case a model might plausibly use ("in progress", "In Progress",
 * "in-progress" → `in_progress`).
 */
function matchVocabulary<T extends string>(
  value: unknown,
  vocabulary: readonly T[]
): T | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalised = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return vocabulary.find((entry) => entry === normalised);
}

/* -------------------------------------------------------------------------- */
/* Changes                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The canonical shape of one change, in the words a corrective retry needs.
 *
 * Repeated in every message that has to explain the structure, because each of
 * those messages is read on its own: a model that omitted `file` is told what a
 * change looks like, not pointed at another issue that happens to say so.
 */
const CHANGE_SHAPE =
  'A change is an object with "file" (the workspace-relative path, such as "src/User.php"), "operation" ("create" or "update"), "description" (one sentence about what it does) and "content" (the complete file).';

/** How many of an unexpected object's keys are quoted back. */
const MAX_REPORTED_KEYS = 12;

/** The keys a change carried, for a diagnostic that has to name what arrived. */
function describeKeys(raw: Record<string, unknown>): string {
  const keys = Object.keys(raw).slice(0, MAX_REPORTED_KEYS);
  if (keys.length === 0) {
    return 'It was an empty object.';
  }
  const quoted = keys.map((key) => `"${key}"`).join(', ');
  const more = Object.keys(raw).length > keys.length ? ', and more' : '';
  return `It carried ${quoted}${more}.`;
}

/**
 * Read the target path of a change.
 *
 * `file` gets its own reader rather than the generic `requiredString` because
 * this is the field a reply most often loses, and the generic message — "The
 * "file" field is required and was not present" — is the one the developer
 * reported: true, and useless. It does not say which change, does not say what
 * *did* arrive, and does not say what a change should look like. A model that
 * wrote `fileName`, or `path`, or an object of lines, is one key away from being
 * correct, and the diagnostic that tells it so is the difference between a
 * retry that works and one that repeats itself.
 */
function readFilePath(
  raw: Record<string, unknown>,
  path: string,
  index: number,
  issues: ProtocolIssue[]
): string {
  const value = raw['file'];
  if (value === undefined || value === null) {
    issues.push({
      path: `${path}/file`,
      code: 'missing_field',
      message:
        `Change ${index + 1} has no "file", so PairPilot does not know which file it applies to. ` +
        `${describeKeys(raw)} ${CHANGE_SHAPE}`,
    });
    return '';
  }
  if (typeof value !== 'string') {
    issues.push({
      path: `${path}/file`,
      code: 'wrong_type',
      message: `"file" must be a string holding the workspace-relative path but arrived as ${describeType(value)}. ${CHANGE_SHAPE}`,
    });
    return '';
  }
  if (value.trim().length === 0) {
    issues.push({
      path: `${path}/file`,
      code: 'empty_value',
      message: `Change ${index + 1} has an empty "file", so PairPilot does not know which file it applies to. ${CHANGE_SHAPE}`,
    });
    return '';
  }
  if (value.length > PROTOCOL_LIMITS.maxPathChars) {
    issues.push({
      path: `${path}/file`,
      code: 'too_large',
      message: `"file" is ${value.length} characters; the maximum is ${PROTOCOL_LIMITS.maxPathChars}.`,
    });
    return value.slice(0, PROTOCOL_LIMITS.maxPathChars);
  }
  return value;
}

/**
 * Validate one change.
 *
 * Returns null and pushes issues when the change cannot be used. A change that
 * fails validation fails the *whole reply*: applying the parts of a proposal
 * that happened to parse would write a half-built module into the workspace.
 */
function readChange(
  raw: unknown,
  index: number,
  issues: ProtocolIssue[],
  notes: string[]
): ProposalChange | null {
  const path = `/changes/${index}`;
  if (!isRecord(raw)) {
    issues.push({
      path,
      code: 'not_an_object',
      message: `Change ${index + 1} must be a JSON object but arrived as ${describeType(raw)}. ${CHANGE_SHAPE}`,
    });
    return null;
  }

  const before = issues.length;

  const file = readFilePath(raw, path, index, issues);
  const description = requiredString(raw, 'description', path, issues, {
    maxChars: PROTOCOL_LIMITS.maxDescriptionChars,
  });

  // `content` is required for an executable operation. A reserved operation is
  // reported below before `content` is read, so an incomplete `patch` change
  // produces one accurate complaint rather than two confusing ones.
  const operationRaw = raw['operation'];
  const operationMatch = matchVocabulary(operationRaw, ALL_OPERATIONS as readonly string[]);
  const isReserved =
    operationMatch !== undefined &&
    (RESERVED_OPERATIONS as readonly string[]).includes(operationMatch);

  let content = '';
  if (!isReserved) {
    if (raw['content'] === undefined || raw['content'] === null) {
      issues.push({
        path: `${path}/content`,
        code: 'missing_field',
        message:
          `Change ${index + 1} ("${file || 'unnamed'}") carries no "content". PairPilot writes exactly what you reviewed, so a change with no content cannot be applied — send the complete final file.`,
      });
    } else if (typeof raw['content'] !== 'string') {
      issues.push({
        path: `${path}/content`,
        code: 'wrong_type',
        message: `"content" must be a string but arrived as ${describeType(raw['content'])}.`,
      });
    } else if (raw['content'].trim().length === 0) {
      issues.push({
        path: `${path}/content`,
        code: 'empty_value',
        message: `Change ${index + 1} ("${file || 'unnamed'}") has empty content.`,
      });
    } else if (raw['content'].length > PROTOCOL_LIMITS.maxContentChars) {
      issues.push({
        path: `${path}/content`,
        code: 'too_large',
        message: `"${file}" is ${raw['content'].length} characters; the per-file maximum is ${PROTOCOL_LIMITS.maxContentChars}.`,
      });
    } else {
      content = raw['content'];
    }
  }

  // Operation.
  let operation: ChangeOperation = 'create';
  if (operationRaw === undefined || operationRaw === null) {
    issues.push({
      path: `${path}/operation`,
      code: 'missing_field',
      message: `Change ${index + 1} ("${file || 'unnamed'}") does not state its "operation". Use "create" for a new file and "update" to replace an existing one.`,
    });
  } else if (operationMatch === undefined) {
    issues.push({
      path: `${path}/operation`,
      code: 'unknown_operation',
      message: `Change ${index + 1} ("${file || 'unnamed'}") has an unsupported operation "${String(operationRaw)}". Use "create" or "update".`,
    });
  } else if (isReserved) {
    // Reported, never silently dropped: the model is told what PairPilot can
    // actually do so its retry can be a full-content change instead.
    issues.push({
      path: `${path}/operation`,
      code: 'reserved_operation',
      message: `The "${operationMatch}" operation is not supported by this version of PairPilot. Re-send "${file || 'this change'}" as an "update" carrying the complete new file content.`,
    });
  } else {
    operation = operationMatch as ChangeOperation;
  }

  if (issues.length > before) {
    return null;
  }

  const id =
    optionalString(raw, 'id', path, notes, { maxChars: 120 }) ??
    `change-${String(index + 1).padStart(3, '0')}`;

  const language = optionalString(raw, 'language', path, notes, { maxChars: 60 });
  const rationale = optionalString(raw, 'rationale', path, notes, {
    maxChars: PROTOCOL_LIMITS.maxDescriptionChars,
  });
  const responsibilities = optionalStringList(raw, 'responsibilities', path, notes);
  const potentialProblems = optionalStringList(raw, 'potentialProblems', path, notes);

  return {
    id,
    file,
    operation,
    ...(language !== undefined ? { language } : {}),
    description,
    content,
    dependencies: optionalStringList(raw, 'dependencies', path, notes, PROTOCOL_LIMITS.maxDependencies),
    risk: matchVocabulary(raw['risk'], CHANGE_RISKS) ?? 'low',
    ...(rationale !== undefined ? { rationale } : {}),
    ...(responsibilities.length > 0 ? { responsibilities } : {}),
    ...(potentialProblems.length > 0 ? { potentialProblems } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* The entry point                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Read a candidate canonical message.
 *
 * @param value A parsed JSON value of unknown shape.
 */
export function validateProtocolMessage(value: unknown): ProtocolValidationResult {
  const issues: ProtocolIssue[] = [];
  const notes: string[] = [];

  if (!isRecord(value)) {
    return {
      ok: false,
      issues: [
        {
          path: '',
          code: 'not_an_object',
          message: `A PairPilot reply must be a JSON object, but this was ${describeType(value)}.`,
        },
      ],
    };
  }

  // --- protocol version ---------------------------------------------------
  const version = value['protocol_version'];
  if (version !== undefined && version !== null) {
    if (typeof version !== 'string') {
      issues.push({
        path: '/protocol_version',
        code: 'wrong_type',
        message: `"protocol_version" must be a string but arrived as ${describeType(version)}.`,
      });
    } else if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version.trim())) {
      issues.push({
        path: '/protocol_version',
        code: 'unsupported_version',
        message: `Protocol version "${version.trim()}" is not supported by this build of PairPilot, which speaks ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}. Re-send the reply using protocol version ${DEFAULT_PROTOCOL_VERSION}.`,
      });
    }
  } else {
    // Absent is fine and normalised; the model is not required to remember it.
    notes.push(`No protocol_version was supplied; assumed ${DEFAULT_PROTOCOL_VERSION}.`);
  }

  // --- type ---------------------------------------------------------------
  const typeMatch = matchVocabulary(value['type'], PROTOCOL_MESSAGE_TYPES);
  if (value['type'] === undefined || value['type'] === null) {
    issues.push({
      path: '/type',
      code: 'missing_field',
      message: `Every reply must carry a "type". Valid types are: ${PROTOCOL_MESSAGE_TYPES.join(', ')}.`,
    });
  } else if (typeMatch === undefined) {
    issues.push({
      path: '/type',
      code: 'unknown_message_type',
      message: `"${String(value['type'])}" is not a PairPilot message type. Valid types are: ${PROTOCOL_MESSAGE_TYPES.join(', ')}.`,
    });
  }

  if (issues.length > 0 || typeMatch === undefined) {
    return { ok: false, issues };
  }

  const type: ProtocolMessageType = typeMatch;

  // --- message ------------------------------------------------------------
  // Required on every type: a reply that says nothing is not a usable reply,
  // and every message kind has something human-readable to say.
  const message = requiredString(value, 'message', '', issues, {
    maxChars: PROTOCOL_LIMITS.maxDescriptionChars,
  });

  const resolvedVersion =
    typeof version === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(version.trim())
      ? version.trim()
      : DEFAULT_PROTOCOL_VERSION;

  /**
   * Everything except `type`.
   *
   * `type` is added per case rather than shared, because a plain object property
   * loses the narrowing the `switch` gives the `type` variable — and without
   * that narrowing TypeScript cannot tell a `chat_response` from a
   * `code_proposal`, which is precisely the distinction this contract exists to
   * make.
   */
  const base = { protocol_version: resolvedVersion, message };

  switch (type) {
    case 'chat_response': {
      const suggestions = optionalStringList(value, 'suggestions', '', notes);
      if (issues.length > 0) return { ok: false, issues };
      return { ok: true, notes, value: { ...base,
          type, ...(suggestions.length > 0 ? { suggestions } : {}) } };
    }

    case 'code_proposal': {
      const rawChanges = value['changes'];
      if (!Array.isArray(rawChanges) || rawChanges.length === 0) {
        issues.push({
          path: '/changes',
          code: rawChanges === undefined ? 'missing_field' : 'empty_value',
          message:
            'A code_proposal must carry a non-empty "changes" array. Send a chat_response instead if there is nothing to write.',
        });
        return { ok: false, issues };
      }
      if (rawChanges.length > PROTOCOL_LIMITS.maxChanges) {
        issues.push({
          path: '/changes',
          code: 'too_many_changes',
          message: `This proposal has ${rawChanges.length} changes; the limit is ${PROTOCOL_LIMITS.maxChanges}. Split it into smaller proposals.`,
        });
        return { ok: false, issues };
      }

      const changes: ProposalChange[] = [];
      const seenFiles = new Map<string, number>();
      let totalChars = 0;

      rawChanges.forEach((raw, index) => {
        const change = readChange(raw, index, issues, notes);
        if (!change) {
          return;
        }
        const key = `${change.operation}:${change.file}`;
        const previous = seenFiles.get(key);
        if (previous !== undefined) {
          issues.push({
            path: `/changes/${index}`,
            code: 'duplicate_change',
            message: `"${change.operation} ${change.file}" is proposed twice (changes ${previous + 1} and ${index + 1}). Merge them into one change.`,
          });
          return;
        }
        seenFiles.set(key, index);

        totalChars += change.content.length;
        if (totalChars > PROTOCOL_LIMITS.maxTotalContentChars) {
          issues.push({
            path: `/changes/${index}/content`,
            code: 'too_large',
            message: `The proposal's total content exceeds ${PROTOCOL_LIMITS.maxTotalContentChars} characters. Split it into smaller proposals.`,
          });
          return;
        }
        changes.push(change);
      });

      if (issues.length > 0) {
        return { ok: false, issues };
      }

      const task = readTask(value['task'], notes);
      const summary = summarise(changes);
      const nextStep = readNextStep(value['nextStep'], notes);

      return {
        ok: true,
        notes,
        value: {
          ...base,
          type,
          ...(task !== undefined ? { task } : {}),
          changes,
          summary,
          ...(nextStep !== undefined ? { nextStep } : {}),
        },
      };
    }

    case 'project_analysis': {
      const raw = isRecord(value['analysis']) ? value['analysis'] : {};
      if (issues.length > 0) return { ok: false, issues };
      return {
        ok: true,
        notes,
        value: {
          ...base,
          type,
          analysis: {
            stack: optionalStringList(raw, 'stack', '/analysis', notes),
            structure: optionalStringList(raw, 'structure', '/analysis', notes),
            conventions: optionalStringList(raw, 'conventions', '/analysis', notes),
            gaps: optionalStringList(raw, 'gaps', '/analysis', notes),
          },
        },
      };
    }

    case 'project_plan': {
      const raw = isRecord(value['plan']) ? value['plan'] : {};
      const rawPhases = Array.isArray(raw['phases']) ? raw['phases'] : [];
      const phases: { name: string; goal: string; tasks: string[] }[] = [];
      rawPhases.slice(0, 40).forEach((entry, index) => {
        if (!isRecord(entry)) {
          notes.push(`/plan/phases/${index} was ignored: expected an object.`);
          return;
        }
        const name = optionalString(entry, 'name', `/plan/phases/${index}`, notes) ?? `Phase ${index + 1}`;
        phases.push({
          name,
          goal: optionalString(entry, 'goal', `/plan/phases/${index}`, notes) ?? '',
          tasks: optionalStringList(entry, 'tasks', `/plan/phases/${index}`, notes),
        });
      });
      if (issues.length > 0) return { ok: false, issues };
      return {
        ok: true,
        notes,
        value: {
          ...base,
          type,
          plan: {
            phases,
            ...(optionalStringList(raw, 'questions', '/plan', notes).length > 0
              ? { questions: optionalStringList(raw, 'questions', '/plan', notes) }
              : {}),
            ...(optionalStringList(raw, 'risks', '/plan', notes).length > 0
              ? { risks: optionalStringList(raw, 'risks', '/plan', notes) }
              : {}),
          },
        },
      };
    }

    case 'architecture_discussion': {
      const raw = isRecord(value['architecture']) ? value['architecture'] : {};
      const rawComponents = Array.isArray(raw['components']) ? raw['components'] : [];
      const components: { name: string; responsibility: string }[] = [];
      rawComponents.slice(0, 40).forEach((entry, index) => {
        if (!isRecord(entry)) {
          notes.push(`/architecture/components/${index} was ignored: expected an object.`);
          return;
        }
        const name = optionalString(entry, 'name', `/architecture/components/${index}`, notes);
        if (name === undefined) {
          notes.push(
            `/architecture/components/${index} was ignored: it named nothing, and an unnamed component cannot be discussed.`
          );
          return;
        }
        components.push({
          name,
          responsibility:
            optionalString(entry, 'responsibility', `/architecture/components/${index}`, notes) ?? '',
        });
      });

      // Components may also arrive as bare strings, which is what a model writes
      // when it lists parts without describing them. Each becomes a component
      // with no stated responsibility rather than being dropped, because the
      // *list of parts* is the part of a design conversation that matters most.
      for (const name of optionalStringList(raw, 'componentNames', '/architecture', notes)) {
        components.push({ name, responsibility: '' });
      }

      if (issues.length > 0) return { ok: false, issues };
      const alternatives = optionalStringList(raw, 'alternatives', '/architecture', notes);
      const dependencies = optionalStringList(raw, 'dependencies', '/architecture', notes);
      const requirements = optionalStringList(value, 'requirements', '', notes);
      const questions = optionalStringList(value, 'questions', '', notes);
      const nextStep = optionalString(value, 'nextStep', '', notes);
      return {
        ok: true,
        notes,
        value: {
          ...base,
          type,
          ...(requirements.length > 0 ? { requirements } : {}),
          ...(components.length > 0 || alternatives.length > 0 || dependencies.length > 0
            ? {
                architecture: {
                  ...(components.length > 0 ? { components } : {}),
                  ...(dependencies.length > 0 ? { dependencies } : {}),
                  ...(alternatives.length > 0 ? { alternatives } : {}),
                },
              }
            : {}),
          ...(questions.length > 0 ? { questions } : {}),
          ...(nextStep !== undefined ? { nextStep } : {}),
        },
      };
    }

    case 'code_review': {
      const raw = isRecord(value['review']) ? value['review'] : {};
      const rawFindings = Array.isArray(raw['findings']) ? raw['findings'] : [];
      const findings: {
        severity: 'info' | 'warning' | 'error';
        title: string;
        detail: string;
        file?: string;
      }[] = [];
      rawFindings.slice(0, 100).forEach((entry, index) => {
        if (!isRecord(entry)) {
          notes.push(`/review/findings/${index} was ignored: expected an object.`);
          return;
        }
        const title = optionalString(entry, 'title', `/review/findings/${index}`, notes);
        if (!title) {
          notes.push(`/review/findings/${index} was ignored: it had no title.`);
          return;
        }
        const file = optionalString(entry, 'file', `/review/findings/${index}`, notes);
        findings.push({
          severity: matchVocabulary(entry['severity'], ['info', 'warning', 'error'] as const) ?? 'info',
          title,
          detail: optionalString(entry, 'detail', `/review/findings/${index}`, notes) ?? '',
          ...(file !== undefined ? { file } : {}),
        });
      });
      if (issues.length > 0) return { ok: false, issues };
      return {
        ok: true,
        notes,
        value: {
          ...base,
          type,
          review: {
            verdict: matchVocabulary(raw['verdict'], ['pass', 'concerns', 'block'] as const) ?? 'concerns',
            findings,
            ...(optionalStringList(raw, 'security', '/review', notes).length > 0
              ? { security: optionalStringList(raw, 'security', '/review', notes) }
              : {}),
            ...(optionalStringList(raw, 'performance', '/review', notes).length > 0
              ? { performance: optionalStringList(raw, 'performance', '/review', notes) }
              : {}),
            ...(optionalStringList(raw, 'tests', '/review', notes).length > 0
              ? { tests: optionalStringList(raw, 'tests', '/review', notes) }
              : {}),
          },
        },
      };
    }

    case 'engineering_advice': {
      const raw = isRecord(value['advice']) ? value['advice'] : {};
      const title = optionalString(raw, 'title', '/advice', notes);
      const reason = optionalString(raw, 'reason', '/advice', notes);
      if (!title || !reason) {
        issues.push({
          path: '/advice',
          code: 'missing_field',
          message:
            'An engineering_advice reply must carry "advice.title" and "advice.reason" so the recommendation can be shown and justified.',
        });
        return { ok: false, issues };
      }
      const priority =
        matchVocabulary(raw['priority'], ['required', 'recommended', 'optional'] as const) ??
        (raw['required'] === true ? 'required' : 'recommended');
      return {
        ok: true,
        notes,
        value: {
          ...base,
          type,
          advice: {
            title,
            reason,
            ...(optionalStringList(raw, 'responsibilities', '/advice', notes).length > 0
              ? { responsibilities: optionalStringList(raw, 'responsibilities', '/advice', notes) }
              : {}),
            ...(optionalStringList(raw, 'files', '/advice', notes).length > 0
              ? { files: optionalStringList(raw, 'files', '/advice', notes) }
              : {}),
            required: priority === 'required',
            priority,
          },
        },
      };
    }

    case 'clarification_request': {
      const raw = isRecord(value['clarification']) ? value['clarification'] : {};
      const question =
        optionalString(raw, 'question', '/clarification', notes) ??
        (message.length > 0 ? message : undefined);
      if (!question) {
        issues.push({
          path: '/clarification',
          code: 'missing_field',
          message: 'A clarification_request must carry the question to ask.',
        });
        return { ok: false, issues };
      }
      const options = optionalStringList(raw, 'options', '/clarification', notes, 8);
      return {
        ok: true,
        notes,
        value: {
          ...base,
          type,
          clarification: { question, ...(options.length > 0 ? { options } : {}) },
        },
      };
    }

    case 'task_update': {
      const raw = isRecord(value['task']) ? value['task'] : {};
      const title = optionalString(raw, 'title', '/task', notes);
      const status = matchVocabulary<TaskStatus>(raw['status'], TASK_STATUSES);
      if (!title || !status) {
        issues.push({
          path: '/task',
          code: 'missing_field',
          message: `A task_update must carry "task.title" and a "task.status" from: ${TASK_STATUSES.join(', ')}.`,
        });
        return { ok: false, issues };
      }
      const description = optionalString(raw, 'description', '/task', notes);
      const notesList = optionalStringList(raw, 'notes', '/task', notes);
      return {
        ok: true,
        notes,
        value: {
          ...base,
          type,
          task: {
            title,
            status,
            ...(description !== undefined ? { description } : {}),
            ...(notesList.length > 0 ? { notes: notesList } : {}),
          },
        },
      };
    }

    case 'error': {
      const raw = isRecord(value['error']) ? value['error'] : {};
      const code = optionalString(raw, 'code', '/error', notes, { maxChars: 80 });
      const detail = optionalString(raw, 'detail', '/error', notes, {
        maxChars: PROTOCOL_LIMITS.maxDescriptionChars,
      });
      return {
        ok: true,
        notes,
        value: { ...base,
          type, error: { ...(code !== undefined ? { code } : {}), ...(detail !== undefined ? { detail } : {}) } },
      };
    }

    default: {
      // Unreachable while the union is exhaustive; the `never` check makes a
      // newly added message type a compile error rather than a silent no-op.
      const exhaustive: never = type;
      void exhaustive;
      return { ok: false, issues };
    }
  }
}

function readTask(value: unknown, notes: string[]): ProposalTask | undefined {
  if (!isRecord(value)) {
    if (value !== undefined && value !== null) {
      notes.push('/task was ignored: expected an object.');
    }
    return undefined;
  }
  const title = optionalString(value, 'title', '/task', notes, { maxChars: 200 });
  if (!title) {
    return undefined;
  }
  const description = optionalString(value, 'description', '/task', notes, {
    maxChars: PROTOCOL_LIMITS.maxDescriptionChars,
  });
  const status = matchVocabulary<TaskStatus>(value['status'], TASK_STATUSES);
  return {
    title,
    ...(description !== undefined ? { description } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

function readNextStep(value: unknown, notes: string[]): ProposalNextStep | undefined {
  if (!isRecord(value)) {
    if (value !== undefined && value !== null) {
      notes.push('/nextStep was ignored: expected an object.');
    }
    return undefined;
  }
  const title = optionalString(value, 'title', '/nextStep', notes, { maxChars: 200 });
  const reason = optionalString(value, 'reason', '/nextStep', notes, {
    maxChars: PROTOCOL_LIMITS.maxDescriptionChars,
  });
  if (!title || !reason) {
    return undefined;
  }
  const responsibilities = optionalStringList(value, 'responsibilities', '/nextStep', notes);
  const files = optionalStringList(value, 'files', '/nextStep', notes);
  const priority = matchVocabulary(value['priority'], ['required', 'recommended', 'optional'] as const);
  return {
    title,
    reason,
    ...(responsibilities.length > 0 ? { responsibilities } : {}),
    ...(files.length > 0 ? { files } : {}),
    required: optionalBoolean(value, 'required', priority === 'required', '/nextStep', notes),
    ...(priority !== undefined ? { priority } : {}),
  };
}

/** Count the changes, so the review panel can state the scope up front. */
export function summarise(changes: readonly ProposalChange[]): ProposalSummary {
  let create = 0;
  let update = 0;
  for (const change of changes) {
    if (change.operation === 'create') {
      create += 1;
    } else if (change.operation === 'update') {
      update += 1;
    }
  }
  return {
    files_to_create: create,
    files_to_update: update,
    // Deletion is not representable, so this is structurally always zero. It is
    // reported anyway so the review panel's summary shape matches the contract
    // and a future build that adds deletion has a field waiting for it.
    files_to_delete: 0,
  };
}

/** True when an operation can actually be applied by this build. */
export function isExecutableOperation(operation: string): operation is ExecutableOperation {
  return (EXECUTABLE_OPERATIONS as readonly string[]).includes(operation);
}

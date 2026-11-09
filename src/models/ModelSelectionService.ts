/**
 * ModelSelectionService — which model a given piece of work runs on.
 *
 * Selection is a four-level chain, resolved most-specific-first:
 *
 *     per-task  →  role  →  project  →  global
 *
 * The chain exists because the alternative — one model for everything — is
 * wrong in both directions: a developer wants a cheap model for a quick question
 * and a strong one for architecture work, and they do not want to re-choose
 * every time they switch repositories.
 *
 * Two properties are load-bearing.
 *
 * **Resolution always reports its own provenance.** `ResolvedModel` carries the
 * level that won and a label for it. Once settings can be inherited, "why is it
 * using that model?" is the only question a developer actually has, and a UI
 * that shows the model without the reason forces them to go hunting.
 *
 * **Selection never switches anything by itself.** Setting a role's model
 * changes which model the *next* turn uses; it does not restart a running turn,
 * and it does not touch another level. The Model Advisor recommends; only the
 * developer's own click writes a selection.
 *
 * Note on vocabulary: PairPilot has no "Planning Studio" or "Coding Studio"
 * screens — there is one control loop. The role ids below therefore describe
 * *kinds of work*, and `MODEL_ROLES` records which of them a workflow actually
 * reads today. Roles nothing consumes are still storable, and the UI says so
 * rather than implying a screen exists.
 */

import {
  MODEL_ROLES,
  type ModelSelection,
  type ModelTaskId,
  type ResolvedModel,
  type SelectionLevel,
} from '../types/providerConfig';

/** The slice of `vscode.Memento` this class uses. */
export interface SelectionStorageLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

const SELECTION_KEY = 'pairpilot.models.selection.v1';

interface SelectionState {
  global: string | null;
  /** Project path → model id. */
  projects: Record<string, string>;
  /** Role id → model id. */
  roles: Record<string, string>;
  /** Task id → model id. */
  tasks: Record<string, string>;
}

function emptyState(): SelectionState {
  return { global: null, projects: {}, roles: {}, tasks: {} };
}

/** Everything the selection UI renders, for every level. */
export interface SelectionSnapshot {
  global: string | null;
  projects: Record<string, string>;
  roles: Record<string, string>;
  tasks: Record<string, string>;
  rolesWithConsumers: ModelTaskId[];
}

export interface ResolveOptions {
  /** A per-task override to consult first. */
  taskId?: string | null;
  /** The role the work belongs to. */
  roleId?: ModelTaskId | null;
  /** The current workspace root, for the project level. */
  projectPath?: string | null;
}

export class ModelSelectionService {
  private state: SelectionState = emptyState();

  constructor(private readonly storage: SelectionStorageLike) {}

  load(): void {
    const stored = this.storage.get<unknown>(SELECTION_KEY, null);
    this.state = readState(stored);
  }

  /**
   * The model to use, and where the choice came from.
   *
   * A level is skipped when it holds nothing, so clearing a role falls back to
   * the project rather than erroring.
   */
  resolve(options: ResolveOptions = {}): ResolvedModel {
    const taskId = options.taskId ?? null;
    const roleId = options.roleId ?? null;
    const projectPath = options.projectPath ?? null;

    if (taskId !== null) {
      const modelId = this.state.tasks[taskId];
      if (modelId !== undefined) {
        return resolved(modelId, 'task', `Task: ${taskId}`);
      }
    }

    if (roleId !== null) {
      const modelId = this.state.roles[roleId];
      if (modelId !== undefined) {
        return resolved(modelId, 'role', `Role: ${labelForRole(roleId)}`);
      }
    }

    if (projectPath !== null) {
      const modelId = this.state.projects[projectPath];
      if (modelId !== undefined) {
        return resolved(modelId, 'project', 'Project');
      }
    }

    if (this.state.global !== null) {
      return resolved(this.state.global, 'global', 'Global default');
    }

    // Nothing configured. The provider's own default applies, and the UI says
    // exactly that rather than naming a model PairPilot did not choose.
    return {
      modelId: null,
      level: null,
      sourceLabel: 'Provider default',
      isProviderDefault: true,
    };
  }

  snapshot(): SelectionSnapshot {
    return {
      global: this.state.global,
      projects: { ...this.state.projects },
      roles: { ...this.state.roles },
      tasks: { ...this.state.tasks },
      rolesWithConsumers: MODEL_ROLES.filter((role) => role.consumers.length > 0).map(
        (role) => role.id
      ),
    };
  }

  selectionAt(level: SelectionLevel, key?: string): ModelSelection | null {
    const modelId = this.readLevel(level, key ?? null);
    if (modelId === null || modelId === undefined) {
      return null;
    }
    return { modelId, level, key: key ?? null, updatedAt: 0 };
  }

  /* ---------------------------------------------------------------------- */
  /* Writes                                                                 */
  /* ---------------------------------------------------------------------- */

  async setGlobal(modelId: string | null): Promise<void> {
    this.state.global = modelId;
    await this.persist();
  }

  async setProject(projectPath: string, modelId: string | null): Promise<void> {
    this.state.projects = writeKey(this.state.projects, projectPath, modelId);
    await this.persist();
  }

  async setRole(roleId: ModelTaskId, modelId: string | null): Promise<void> {
    this.state.roles = writeKey(this.state.roles, roleId, modelId);
    await this.persist();
  }

  async setTask(taskId: string, modelId: string | null): Promise<void> {
    this.state.tasks = writeKey(this.state.tasks, taskId, modelId);
    await this.persist();
  }

  /**
   * Drop every reference to a model.
   *
   * Used when a model disappears from the catalogue. Leaving a dangling id in
   * place would make the next turn fail with a provider-side "unknown model"
   * error long after the catalogue changed, which is a much harder problem to
   * trace back to its cause.
   */
  async forgetModel(modelId: string): Promise<number> {
    let removed = 0;
    if (this.state.global === modelId) {
      this.state.global = null;
      removed += 1;
    }
    for (const map of [this.state.projects, this.state.roles, this.state.tasks]) {
      for (const [key, value] of Object.entries(map)) {
        if (value === modelId) {
          delete map[key];
          removed += 1;
        }
      }
    }
    if (removed > 0) {
      await this.persist();
    }
    return removed;
  }

  /** Every model id referenced at any level. */
  referencedModelIds(): string[] {
    const ids = new Set<string>();
    if (this.state.global !== null) {
      ids.add(this.state.global);
    }
    for (const map of [this.state.projects, this.state.roles, this.state.tasks]) {
      for (const value of Object.values(map)) {
        ids.add(value);
      }
    }
    return [...ids];
  }

  /** Ids referenced at some level that the catalogue no longer contains. */
  danglingModelIds(known: ReadonlySet<string>): string[] {
    return this.referencedModelIds().filter((id) => !known.has(id));
  }

  private readLevel(level: SelectionLevel, key: string | null): string | null | undefined {
    switch (level) {
      case 'global':
        return this.state.global;
      case 'project':
        return key === null ? undefined : this.state.projects[key];
      case 'role':
        return key === null ? undefined : this.state.roles[key];
      case 'task':
        return key === null ? undefined : this.state.tasks[key];
      default:
        return undefined;
    }
  }

  private persist(): Promise<void> {
    return Promise.resolve(this.storage.update(SELECTION_KEY, this.state));
  }
}

/* -------------------------------------------------------------------------- */

function resolved(modelId: string, level: SelectionLevel, sourceLabel: string): ResolvedModel {
  return { modelId, level, sourceLabel, isProviderDefault: false };
}

function labelForRole(roleId: ModelTaskId): string {
  return MODEL_ROLES.find((role) => role.id === roleId)?.label ?? roleId;
}

/** Write or delete a key, so an empty map is stored as absent rather than `""`. */
function writeKey(
  map: Record<string, string>,
  key: string,
  value: string | null
): Record<string, string> {
  const next = { ...map };
  if (value === null) {
    delete next[key];
  } else {
    next[key] = value;
  }
  return next;
}

function readState(stored: unknown): SelectionState {
  if (typeof stored !== 'object' || stored === null) {
    return emptyState();
  }
  const candidate = stored as Partial<SelectionState>;
  return {
    global: typeof candidate.global === 'string' ? candidate.global : null,
    projects: readStringMap(candidate.projects),
    roles: readStringMap(candidate.roles),
    tasks: readStringMap(candidate.tasks),
  };
}

function readStringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && entry.length > 0) {
      out[key] = entry;
    }
  }
  return out;
}

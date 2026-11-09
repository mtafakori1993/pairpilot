/**
 * ModelRegistry — the cached catalogue, plus the developer's favourites and
 * recent picks.
 *
 * The registry exists so that the Explorer, the details view and the Model
 * Advisor all read one list, fetched once and refreshed on a schedule the
 * developer controls. Fetching per view would triple the traffic and let the
 * three screens disagree about what a model costs.
 *
 * Its most important behaviour is what happens when a refresh *fails*: the
 * previous catalogue is kept and marked stale rather than being replaced with an
 * empty list. Losing the catalogue because a laptop briefly lost Wi-Fi would
 * take the Model Advisor down with it, and an empty Explorer reads as "no models
 * exist" — a much worse lie than "these prices are from yesterday".
 *
 * Storage is typed structurally, matching `vscode.Memento`, so this class is
 * testable in plain Node.
 */

import { normalizeModel } from './ModelMetadata';
import type { ModelCatalog, ModelMetadata } from '../types/model';

/** The slice of `vscode.Memento` this class uses. */
export interface CatalogStorageLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface ModelRegistryDeps {
  /** Fetch the raw catalogue. Supplied by `OpenRouterClient`. */
  fetchModels(signal?: AbortSignal): Promise<unknown[]>;
  storage: CatalogStorageLike;
  now?(): number;
  logger?: { warn(message: string): void };
  /** How many recent picks to remember. */
  recentLimit?: number;
}

const CATALOG_KEY = 'pairpilot.models.catalog.v1';
const FAVORITES_KEY = 'pairpilot.models.favorites.v1';
const RECENT_KEY = 'pairpilot.models.recent.v1';

const DEFAULT_RECENT_LIMIT = 10;
/** Bound on what is written back, so a pathological response cannot bloat state. */
const MAX_STORED_MODELS = 2_000;

export class ModelRegistry {
  private catalog: ModelCatalog | null = null;
  private favorites = new Set<string>();
  private recent: string[] = [];
  private refreshing = false;

  constructor(private readonly deps: ModelRegistryDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private get recentLimit(): number {
    return this.deps.recentLimit ?? DEFAULT_RECENT_LIMIT;
  }

  /** Restore the cached catalogue. Cheap, and safe to call before any network. */
  load(): void {
    this.catalog = readCatalog(this.deps.storage);
    this.favorites = new Set(readStringArray(this.deps.storage, FAVORITES_KEY));
    this.recent = readStringArray(this.deps.storage, RECENT_KEY).slice(0, this.recentLimit);
  }

  getCatalog(): ModelCatalog | null {
    return this.catalog;
  }

  list(): ModelMetadata[] {
    return this.catalog?.models ?? [];
  }

  count(): number {
    return this.catalog?.models.length ?? 0;
  }

  get(modelId: string): ModelMetadata | null {
    return this.list().find((model) => model.id === modelId) ?? null;
  }

  get isRefreshing(): boolean {
    return this.refreshing;
  }

  /** The models the developer starred, in catalogue order. */
  favoritesList(): ModelMetadata[] {
    return this.list().filter((model) => this.favorites.has(model.id));
  }

  isFavorite(modelId: string): boolean {
    return this.favorites.has(modelId);
  }

  favoritesSet(): ReadonlySet<string> {
    return this.favorites;
  }

  async toggleFavorite(modelId: string): Promise<boolean> {
    const nowFavorite = !this.favorites.has(modelId);
    if (nowFavorite) {
      this.favorites.add(modelId);
    } else {
      this.favorites.delete(modelId);
    }
    await this.deps.storage.update(FAVORITES_KEY, [...this.favorites]);
    return nowFavorite;
  }

  /**
   * Ids of the models most recently used, most recent first.
   *
   * "Used" is deliberate: this is written when a turn completes on a model
   * (`AIOrchestrator.record`), not when one is selected. The Explorer labels the
   * list "Recently used", and a selected-but-untried model appearing there would
   * make the label a lie.
   */
  recentIds(): string[] {
    return [...this.recent];
  }

  /** Record a model as just used, moving it to the front of the list. */
  async markUsed(modelId: string): Promise<void> {
    this.recent = [modelId, ...this.recent.filter((id) => id !== modelId)].slice(
      0,
      this.recentLimit
    );
    await this.deps.storage.update(RECENT_KEY, this.recent);
  }

  /**
   * Whether a refresh is due.
   *
   * `intervalHours` of 0 disables automatic refresh entirely — the developer
   * refreshes by hand. That is the correct reading of "never", and is not the
   * same as "every zero hours", which would refresh continuously.
   */
  isRefreshDue(intervalHours: number): boolean {
    if (intervalHours <= 0) {
      return false;
    }
    if (this.catalog === null) {
      return true;
    }
    const ageMs = this.now() - this.catalog.fetchedAt;
    return ageMs >= intervalHours * 3_600_000;
  }

  /**
   * Fetch and replace the catalogue.
   *
   * On failure the previous catalogue is retained and flagged stale; the error
   * is returned rather than thrown so the caller can render it without losing
   * the models it already has.
   */
  async refresh(signal?: AbortSignal): Promise<{ ok: boolean; error: string | null; count: number }> {
    if (this.refreshing) {
      return { ok: false, error: 'A catalogue refresh is already running.', count: this.count() };
    }
    this.refreshing = true;

    try {
      const raw = await this.deps.fetchModels(signal);
      const capturedAt = this.now();
      // One malformed entry must cost the developer that entry, not the whole
      // refresh, so each is normalised inside its own guard.
      const models: ModelMetadata[] = [];
      for (const entry of raw.slice(0, MAX_STORED_MODELS)) {
        try {
          const model = normalizeModel(entry, capturedAt);
          if (model !== null) {
            models.push(model);
          }
        } catch (error) {
          this.deps.logger?.warn(
            `Skipped a model entry PairPilot could not read: ${describeError(error)}`
          );
        }
      }

      if (models.length === 0) {
        // An empty catalogue is not a success: it would wipe the Explorer and
        // leave the Model Advisor with nothing to rank. Treat it as a failure
        // and keep what we had.
        return this.recordFailure(
          raw.length === 0
            ? 'OpenRouter returned an empty model list.'
            : 'None of the models OpenRouter returned had a usable identifier.'
        );
      }

      this.catalog = {
        providerId: 'openrouter',
        fetchedAt: capturedAt,
        models,
        stale: false,
        refreshError: null,
      };
      await this.deps.storage.update(CATALOG_KEY, this.catalog);
      return { ok: true, error: null, count: models.length };
    } catch (error) {
      return this.recordFailure(describeError(error));
    } finally {
      this.refreshing = false;
    }
  }

  /** Keep the existing catalogue, note why it could not be updated. */
  private async recordFailure(message: string): Promise<{ ok: false; error: string; count: number }> {
    if (this.catalog !== null) {
      this.catalog = { ...this.catalog, stale: true, refreshError: message };
      await this.deps.storage.update(CATALOG_KEY, this.catalog);
    }
    return { ok: false, error: message, count: this.count() };
  }
}

/* -------------------------------------------------------------------------- */

function readCatalog(storage: CatalogStorageLike): ModelCatalog | null {
  const stored = storage.get<ModelCatalog | null>(CATALOG_KEY, null);
  if (stored === null || typeof stored !== 'object') {
    return null;
  }
  if (!Array.isArray(stored.models)) {
    return null;
  }
  // A cached catalogue restored from an older build must not be trusted blindly.
  const models = stored.models.filter(
    (model): model is ModelMetadata =>
      typeof model === 'object' && model !== null && typeof (model as ModelMetadata).id === 'string'
  );
  if (models.length === 0) {
    return null;
  }
  return {
    providerId: 'openrouter',
    fetchedAt: typeof stored.fetchedAt === 'number' ? stored.fetchedAt : 0,
    models,
    // Anything read back from storage is by definition not fresh this session.
    stale: true,
    refreshError: null,
  };
}

function readStringArray(storage: CatalogStorageLike, key: string): string[] {
  const stored = storage.get<unknown>(key, []);
  if (!Array.isArray(stored)) {
    return [];
  }
  return stored.filter((entry): entry is string => typeof entry === 'string');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

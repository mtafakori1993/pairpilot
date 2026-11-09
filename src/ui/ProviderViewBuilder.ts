/**
 * ProviderViewBuilder — assembles everything the AI Providers & Models screen
 * and the Cost & Usage screen render.
 *
 * The builder exists so the Webview providers stay thin and this logic stays
 * testable. It imports no `vscode`: every fact it needs arrives through a
 * function on its dependency object, so a test can hand it a catalogue of three
 * models and assert on exactly the rows a developer would see.
 *
 * Three rules it enforces, each a correctness property rather than a
 * presentation choice:
 *
 *  1. **It formats, and formatting is lossy in one direction only.** Prices go
 *     from per-token to per-million here and nowhere else; an absent value
 *     becomes a sentence ("Not provided") and never a number. No figure in the
 *     snapshot is invented, and no null is rendered as a zero.
 *  2. **Nothing in a snapshot can reconstruct a credential.** The only
 *     key-derived field is `maskedKey`, which comes from `SecretManager.summary()`
 *     — a value that never contains enough of the key to be usable.
 *  3. **The catalogue is paged, not silently truncated.** A filtered list longer
 *     than a page reports `matchingModels` and `hasMore`, so the screen can say
 *     "showing 60 of 412" instead of appearing to have lost the rest.
 */

import { selectModels } from '../models/ModelSearch';
import {
  formatPricePerMillion,
  formatRelative,
  formatScore,
  formatTokensCompact,
  formatUsd,
} from '../models/format';
import type { ModelExplanation } from '../models/ModelAdvisor';
import {
  MODEL_QUICK_FILTER_RULES,
  MODEL_SORT_KEYS,
  type ModelMetadata,
  type ModelQuery,
  type ModelQuickFilter,
  type ModelSortKey,
} from '../types/model';
import {
  MODEL_ROLES,
  type AccountInfo,
  type AuthState,
  type CatalogState,
  type ConnectionState,
  type ModelAdvice,
  type ModelRecommendation,
  type ModelTaskId,
  type ProviderAccountView,
  type ProviderView,
  type SelectionLevel,
} from '../types/providerConfig';
import type { AIProviderStatus, ProviderId } from '../types/provider';
import type { KeySummary } from '../security/SecretManager';
import type { ModelRegistry } from '../models/ModelRegistry';
import type { ModelSelectionService } from '../models/ModelSelectionService';
import type { ModelAdvisor } from '../models/ModelAdvisor';

/** How many model rows one snapshot carries. */
export const MODEL_PAGE_SIZE = 60;

/** Static facts about a provider, read from configuration by the extension. */
export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  description: string;
  baseUrl: string;
  enabled: boolean;
  /** False when this build cannot offer the provider at all. */
  selectable: boolean;
  /** False when the runtime it needs is missing — no CLI, no outbound HTTPS. */
  runtimeAvailable: boolean;
}

/** OpenRouter's live state, as `OpenRouterProvider.snapshotState()` reports it. */
export interface OpenRouterLiveState {
  authState: AuthState;
  connectionState: ConnectionState;
  authenticated: boolean | null;
  /** Already masked and mapped by the extension. Never contains a key. */
  account: AccountInfo | null;
  lastConnectedAt: number | null;
  lastConnectionError: string | null;
  busy: boolean;
}

export interface ProviderViewBuilderDeps {
  descriptors(): ProviderDescriptor[];
  /** Live status of a registered provider, or null when it is not registered. */
  statusOf(providerId: ProviderId): AIProviderStatus | null;
  /** OpenRouter's own state, or null when it is not registered. */
  openRouterState(): OpenRouterLiveState | null;
  /** The cached key summary. Cheap, and never contains the key. */
  keySummary(): KeySummary;
  activeProviderId(): ProviderId;
  catalog: ModelRegistry;
  selection: ModelSelectionService;
  advisor: ModelAdvisor;
  /** Why the last catalogue refresh failed, if it did. */
  catalogError(): string | null;
  /** The workspace root, for the project selection level. */
  projectPath?(): string | null;
  now?(): number;
}

/** What the panel is currently showing. Held by the Webview provider, not here. */
export interface ProvidersViewState {
  query: ModelQuery;
  /** Index into the filtered list that this page starts at. */
  offset: number;
  /** Model whose details panel is open. */
  detailsModelId: string | null;
  /** Task the advisor panel is showing. */
  adviceTaskId: ModelTaskId | null;
  notice: ProviderNotice | null;
}

export interface ProviderNotice {
  level: 'info' | 'warning' | 'error';
  text: string;
}

/** One row in the Model Explorer table. */
export interface ModelRowView {
  id: string;
  name: string;
  developer: string | null;
  description: string | null;
  contextLabel: string;
  maxOutputLabel: string;
  /** Per-million labels. `Not provided` when the catalogue published no price. */
  inputPriceLabel: string;
  outputPriceLabel: string;
  isFree: boolean;
  isFavorite: boolean;
  /** True when some selection level points at this model. */
  isSelected: boolean;
  /** Short capability chips, each backed by a catalogue field. */
  capabilityChips: string[];
}

export interface ModelDetailsView {
  row: ModelRowView;
  canonicalSlug: string | null;
  createdLabel: string;
  /** Every price the catalogue published, per million tokens. */
  pricingRows: { label: string; value: string }[];
  capabilities: {
    toolCalling: boolean;
    structuredOutput: boolean;
    reasoning: boolean;
    inputModalities: string[];
    outputModalities: string[];
  };
  supportedParameters: string[];
  /** Catalogue fields that were absent, named so the gap is visible. */
  unknownFields: string[];
  /** Where this model is selected, at every level. */
  selectedAt: string[];
  /** The "Why should I use this model?" answer, when an advisor task is chosen. */
  explanation: ExplanationView | null;
  /** Stale prices are flagged, because a snapshot is only as good as its date. */
  capturedAt: number;
}

/**
 * A recommendation, with its score formatted.
 *
 * The score is formatted here rather than in the panel so that the panel never
 * has to turn a number into a figure — the same rule the prices follow. `score`
 * itself stays, because the panel sizes a meter with it, and that is layout
 * rather than arithmetic on a value: it is the 0..1 the advisor already decided.
 */
export interface RecommendationView extends ModelRecommendation {
  /** Host-formatted, e.g. `82% fit`. */
  scoreLabel: string;
}

/** The advisor's answer for one task, as the panel renders it. */
export interface AdviceView extends Omit<ModelAdvice, 'recommendations'> {
  recommendations: RecommendationView[];
}

/** One model explained against one task, as the details pane renders it. */
export interface ExplanationView extends Omit<ModelExplanation, 'recommendation'> {
  recommendation: RecommendationView | null;
}

export interface SelectionLevelView {
  level: SelectionLevel;
  label: string;
  key: string | null;
  modelId: string | null;
  modelName: string | null;
  /** The workflow that reads this level today, or null when nothing does. */
  consumerLabel: string | null;
  note: string | null;
}

export interface SelectionSummaryView {
  levels: SelectionLevelView[];
  /** What the next coding turn will use, and which level supplied it. */
  resolved: {
    modelId: string | null;
    modelName: string | null;
    sourceLabel: string;
    isProviderDefault: boolean;
  };
  /** Ids a level points at that the catalogue no longer contains. */
  dangling: { modelId: string; where: string }[];
}

export interface ProvidersSnapshot {
  providers: ProviderView[];
  activeProviderId: ProviderId;
  catalog: {
    state: CatalogState;
    count: number;
    /** The count with thousands separators, for a sentence the Host writes. */
    countLabel: string;
    fetchedAt: number | null;
    ageLabel: string;
    stale: boolean;
    refreshing: boolean;
    error: string | null;
  };
  query: ModelQuery;
  filters: { id: ModelQuickFilter; label: string; rule: string; active: boolean }[];
  sorts: { id: ModelSortKey; label: string }[];
  models: ModelRowView[];
  totalModels: number;
  matchingModels: number;
  page: { offset: number; pageSize: number; hasMore: boolean; firstOrdinal: number; lastOrdinal: number };
  favorites: ModelRowView[];
  recent: ModelRowView[];
  details: ModelDetailsView | null;
  advice: AdviceView | null;
  adviceTasks: { id: ModelTaskId; label: string }[];
  selection: SelectionSummaryView;
  notice: ProviderNotice | null;
}

/** Human labels for the quick filters. The rule text comes from the catalogue types. */
const QUICK_FILTER_LABELS: Readonly<Record<ModelQuickFilter, string>> = {
  coding: 'Coding',
  reasoning: 'Reasoning',
  'low-cost': 'Low Cost',
  'large-context': 'Large Context',
  vision: 'Vision',
  audio: 'Audio',
  'tool-calling': 'Tool Calling',
  'structured-output': 'Structured Output',
  free: 'Free',
};

const SORT_LABELS: Readonly<Record<ModelSortKey, string>> = {
  name: 'Name',
  'input-cost': 'Input cost (low to high)',
  'output-cost': 'Output cost (low to high)',
  context: 'Context window (largest first)',
  provider: 'Developer',
  newest: 'Newest first',
};

export class ProviderViewBuilder {
  constructor(private readonly deps: ProviderViewBuilderDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  build(state: ProvidersViewState): ProvidersSnapshot {
    const catalog = this.deps.catalog;
    const models = catalog.list();
    const matched = selectModels(models, state.query, { favorites: catalog.favoritesSet() });

    const offset = clampOffset(state.offset, matched.length);
    const pageRows = matched.slice(offset, offset + MODEL_PAGE_SIZE);

    return {
      providers: this.buildProviders(),
      activeProviderId: this.deps.activeProviderId(),
      catalog: this.buildCatalogSummary(),
      query: state.query,
      filters: this.buildFilters(state.query),
      sorts: MODEL_SORT_KEYS.map((id) => ({ id, label: SORT_LABELS[id] })),
      models: pageRows.map((model) => this.toRow(model)),
      totalModels: models.length,
      matchingModels: matched.length,
      page: {
        offset,
        pageSize: MODEL_PAGE_SIZE,
        hasMore: offset + pageRows.length < matched.length,
        firstOrdinal: pageRows.length === 0 ? 0 : offset + 1,
        lastOrdinal: offset + pageRows.length,
      },
      favorites: catalog.favoritesList().map((model) => this.toRow(model)),
      recent: catalog
        .recentIds()
        .map((id) => catalog.get(id))
        .filter((model): model is ModelMetadata => model !== null)
        .map((model) => this.toRow(model)),
      details: state.detailsModelId === null ? null : this.buildDetails(state),
      advice: state.adviceTaskId === null ? null : toAdviceView(this.deps.advisor.recommend(state.adviceTaskId)),
      adviceTasks: MODEL_ROLES.map((role) => ({ id: role.id, label: role.label })),
      selection: this.buildSelection(),
      notice: state.notice,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Providers                                                              */
  /* ---------------------------------------------------------------------- */

  private buildProviders(): ProviderView[] {
    const activeId = this.deps.activeProviderId();
    return this.deps.descriptors().map((descriptor) => this.buildProvider(descriptor, activeId));
  }

  private buildProvider(descriptor: ProviderDescriptor, activeId: ProviderId): ProviderView {
    const status = this.deps.statusOf(descriptor.id);
    const catalogCount = this.deps.catalog.count();

    if (descriptor.id === 'openrouter') {
      const live = this.deps.openRouterState();
      const key = this.deps.keySummary();
      return {
        id: descriptor.id,
        label: descriptor.label,
        description: descriptor.description,
        baseUrl: descriptor.baseUrl,
        enabled: descriptor.enabled,
        isActive: activeId === descriptor.id,
        selectable: descriptor.selectable,
        authState: live?.authState ?? (key.present ? 'stored' : 'unconfigured'),
        connectionState: live?.connectionState ?? 'unknown',
        available: status?.available ?? false,
        statusMessage: status?.message ?? 'OpenRouter is not registered.',
        // The mask, and only the mask. `SecretManager` is the one component
        // allowed to look at the key, and this is the only shape it hands out.
        maskedKey: key.masked,
        hasStoredKey: key.present,
        account: toAccountView(live?.account ?? null, this.now()),
        lastConnectedAt: live?.lastConnectedAt ?? null,
        lastConnectionError: live?.lastConnectionError ?? null,
        catalogState: this.catalogState(catalogCount),
        catalogError: this.deps.catalogError(),
        lastCatalogRefreshAt: this.deps.catalog.getCatalog()?.fetchedAt ?? null,
        catalogModelCountLabel:
          catalogCount === 0 ? null : `${catalogCount.toLocaleString('en-US')} models`,
        busy: live?.busy ?? false,
        controls: { apiKey: true, catalog: true, disable: true },
      };
    }

    // A local CLI provider: no API key, no catalogue, and its own sign-in. The
    // status strings come from the provider itself, so a missing executable is
    // reported in the CLI's own words rather than a generic failure.
    const available = status?.available ?? false;
    return {
      id: descriptor.id,
      label: descriptor.label,
      description: descriptor.description,
      baseUrl: descriptor.baseUrl,
      enabled: descriptor.enabled,
      isActive: activeId === descriptor.id,
      selectable: descriptor.selectable,
      authState: available ? 'valid' : 'unconfigured',
      connectionState: status?.pending ? 'connecting' : available ? 'connected' : 'error',
      available,
      statusMessage:
        status?.message ??
        (descriptor.runtimeAvailable
          ? 'Registered, but it has not reported a status yet.'
          : 'This provider needs a runtime that is not present in this build.'),
      maskedKey: null,
      hasStoredKey: false,
      account: null,
      lastConnectedAt: null,
      lastConnectionError: available ? null : status?.message ?? null,
      catalogState: 'never',
      catalogError: null,
      lastCatalogRefreshAt: null,
      catalogModelCountLabel: null,
      busy: false,
      controls: { apiKey: false, catalog: false, disable: false },
    };
  }

  private catalogState(count: number): CatalogState {
    if (this.deps.catalog.isRefreshing) {
      return 'loading';
    }
    if (count > 0) {
      return 'ready';
    }
    return this.deps.catalogError() === null ? 'never' : 'error';
  }

  private buildCatalogSummary(): ProvidersSnapshot['catalog'] {
    const catalog = this.deps.catalog.getCatalog();
    const count = this.deps.catalog.count();
    return {
      state: this.catalogState(count),
      count,
      countLabel: count.toLocaleString('en-US'),
      fetchedAt: catalog?.fetchedAt ?? null,
      ageLabel: formatRelative(catalog?.fetchedAt ?? null, this.now()),
      // Restored-from-storage catalogues are marked stale too, because their
      // prices are from a previous session even when the last refresh succeeded.
      stale: catalog?.stale ?? false,
      refreshing: this.deps.catalog.isRefreshing,
      error: this.deps.catalogError(),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Models                                                                 */
  /* ---------------------------------------------------------------------- */

  private toRow(model: ModelMetadata): ModelRowView {
    return {
      id: model.id,
      name: model.name,
      developer: model.developer,
      description: model.description,
      contextLabel: formatTokensCompact(model.contextLength),
      maxOutputLabel: formatTokensCompact(model.maxOutputTokens),
      inputPriceLabel: formatPricePerMillion(model.pricing.promptPerToken),
      outputPriceLabel: formatPricePerMillion(model.pricing.completionPerToken),
      isFree: model.pricing.isFree,
      isFavorite: this.deps.catalog.isFavorite(model.id),
      isSelected: this.isSelected(model.id),
      capabilityChips: capabilityChips(model),
    };
  }

  private isSelected(modelId: string): boolean {
    return this.deps.selection.referencedModelIds().includes(modelId);
  }

  private buildDetails(state: ProvidersViewState): ModelDetailsView | null {
    const modelId = state.detailsModelId;
    if (modelId === null) {
      return null;
    }
    const model = this.deps.catalog.get(modelId);
    if (model === null) {
      // The model vanished between the click and this build — usually because the
      // catalogue refreshed underneath the panel. Returning null lets the screen
      // close the details pane instead of rendering an empty shell.
      return null;
    }

    const pricing = model.pricing;
    return {
      row: this.toRow(model),
      canonicalSlug: model.canonicalSlug,
      createdLabel:
        model.created === null ? 'Not provided' : new Date(model.created * 1000).toLocaleDateString(),
      pricingRows: [
        { label: 'Input', value: formatPricePerMillion(pricing.promptPerToken) },
        { label: 'Output', value: formatPricePerMillion(pricing.completionPerToken) },
        { label: 'Cached input (read)', value: formatPricePerMillion(pricing.cacheReadPerToken) },
        { label: 'Cache write', value: formatPricePerMillion(pricing.cacheWritePerToken) },
        { label: 'Per request', value: pricing.requestUsd === null ? 'Not provided' : `$${pricing.requestUsd}` },
        { label: 'Per input image', value: pricing.imageUsd === null ? 'Not provided' : `$${pricing.imageUsd}` },
      ],
      capabilities: {
        toolCalling: model.capabilities.toolCalling,
        structuredOutput: model.capabilities.structuredOutput,
        reasoning: model.capabilities.reasoning,
        inputModalities: model.capabilities.inputModalities,
        outputModalities: model.capabilities.outputModalities,
      },
      supportedParameters: model.capabilities.supportedParameters,
      unknownFields: model.unknownFields,
      selectedAt: this.selectionLabelsFor(model.id),
      explanation:
        state.adviceTaskId === null
          ? null
          : toExplanationView(this.deps.advisor.explain(model.id, state.adviceTaskId)),
      capturedAt: model.capturedAt,
    };
  }

  private buildFilters(query: ModelQuery): ProvidersSnapshot['filters'] {
    const active = new Set(query.quickFilters);
    return (Object.keys(QUICK_FILTER_LABELS) as ModelQuickFilter[]).map((id) => ({
      id,
      label: QUICK_FILTER_LABELS[id],
      rule: MODEL_QUICK_FILTER_RULES[id],
      active: active.has(id),
    }));
  }

  /* ---------------------------------------------------------------------- */
  /* Selection                                                              */
  /* ---------------------------------------------------------------------- */

  private buildSelection(): SelectionSummaryView {
    const selection = this.deps.selection;
    const snapshot = selection.snapshot();
    const nameOf = (modelId: string | null): string | null =>
      modelId === null ? null : this.deps.catalog.get(modelId)?.name ?? null;

    const levels: SelectionLevelView[] = [
      {
        level: 'global',
        label: 'Global default',
        key: null,
        modelId: snapshot.global,
        modelName: nameOf(snapshot.global),
        consumerLabel: 'Every workflow, when nothing more specific is set',
        note: null,
      },
    ];

    // The project level is shown only when there *is* a folder open, because a
    // "this project" row with nothing behind it would invite a selection that
    // could never resolve. It sits between the global default and the roles in
    // the list, matching the order they are consulted in reverse: a role beats a
    // project, a project beats the global default.
    const projectPath = this.projectPath();
    if (projectPath !== null) {
      const projectModelId = snapshot.projects[projectPath] ?? null;
      levels.push({
        level: 'project',
        label: 'This project',
        key: projectPath,
        modelId: projectModelId,
        modelName: nameOf(projectModelId),
        consumerLabel: 'Every workflow in this workspace, unless a role overrides it',
        note: 'Applies to this workspace only, and beats the global default.',
      });
    }

    for (const role of MODEL_ROLES) {
      const modelId = snapshot.roles[role.id] ?? null;
      levels.push({
        level: 'role',
        label: role.label,
        key: role.id,
        modelId,
        modelName: nameOf(modelId),
        consumerLabel: role.consumers.length > 0 ? role.consumers.join(', ') : null,
        // Stated on screen rather than left for the developer to discover: a
        // stored role nothing reads is a preference, not a setting in force.
        note:
          role.consumers.length > 0
            ? role.description
            : `${role.description} No PairPilot workflow reads this role yet, so this is stored but not in use.`,
      });
    }

    const resolved = selection.resolve({ roleId: 'coding', projectPath: this.projectPath() });

    return {
      levels,
      resolved: {
        modelId: resolved.modelId,
        modelName: nameOf(resolved.modelId),
        sourceLabel: resolved.sourceLabel,
        isProviderDefault: resolved.isProviderDefault,
      },
      dangling: this.danglingSelections(),
    };
  }

  private selectionLabelsFor(modelId: string): string[] {
    return this.buildSelection()
      .levels.filter((level) => level.modelId === modelId)
      .map((level) => level.label);
  }

  /** Selections pointing at models the catalogue no longer carries. */
  private danglingSelections(): { modelId: string; where: string }[] {
    const known = new Set(this.deps.catalog.list().map((model) => model.id));
    const snapshot = this.deps.selection.snapshot();
    const out: { modelId: string; where: string }[] = [];

    if (snapshot.global !== null && !known.has(snapshot.global)) {
      out.push({ modelId: snapshot.global, where: 'Global default' });
    }
    const projectPath = this.projectPath();
    if (projectPath !== null) {
      const projectModelId = snapshot.projects[projectPath];
      if (projectModelId !== undefined && !known.has(projectModelId)) {
        out.push({ modelId: projectModelId, where: 'This project' });
      }
    }
    for (const role of MODEL_ROLES) {
      const modelId = snapshot.roles[role.id];
      if (modelId !== undefined && !known.has(modelId)) {
        out.push({ modelId, where: `Role: ${role.label}` });
      }
    }
    return out;
  }

  private projectPath(): string | null {
    // Passed in rather than read here: the builder has no workspace access of
    // its own. The path doubles as the storage key for the project level, which
    // is why it travels to the panel — it is a folder name, not a credential.
    return this.deps.projectPath ? this.deps.projectPath() : null;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The capability chips a row shows.
 *
 * Each chip names a catalogue field, and none is shown for a model that did not
 * declare it — so an absent chip means "not declared", which is why the details
 * view spells the flags out in full rather than relying on these.
 */
function capabilityChips(model: ModelMetadata): string[] {
  const chips: string[] = [];
  if (model.capabilities.toolCalling) {
    chips.push('Tools');
  }
  if (model.capabilities.structuredOutput) {
    chips.push('Structured output');
  }
  if (model.capabilities.reasoning) {
    chips.push('Reasoning');
  }
  if (model.capabilities.inputModalities.includes('image')) {
    chips.push('Vision');
  }
  if (
    model.capabilities.inputModalities.includes('audio') ||
    model.capabilities.outputModalities.includes('audio')
  ) {
    chips.push('Audio');
  }
  return chips;
}

/** Keep a page offset inside the list it indexes. */
function clampOffset(offset: number, length: number): number {
  if (!Number.isFinite(offset) || offset <= 0) {
    return 0;
  }
  const truncated = Math.trunc(offset);
  if (truncated >= length) {
    // The list shrank under the panel, usually because a filter changed. Fall
    // back to the first page rather than rendering an empty table.
    return 0;
  }
  return truncated;
}

/** A recommendation with its score formatted for display. */
function toRecommendationView(recommendation: ModelRecommendation): RecommendationView {
  return { ...recommendation, scoreLabel: formatScore(recommendation.score) };
}

function toAdviceView(advice: ModelAdvice): AdviceView {
  return { ...advice, recommendations: advice.recommendations.map(toRecommendationView) };
}

/** Null in, null out: a model that was not ranked has no recommendation to format. */
function toExplanationView(explanation: ModelExplanation | null): ExplanationView | null {
  if (explanation === null) {
    return null;
  }
  return {
    ...explanation,
    recommendation:
      explanation.recommendation === null ? null : toRecommendationView(explanation.recommendation),
  };
}

/**
 * The account figures, formatted.
 *
 * `formatUsd(null)` is `Unavailable`, which is the point: a key whose usage
 * OpenRouter did not report must not be shown as `$0.00` spent. The limit
 * figures go further and stay *absent* rather than becoming "Unavailable" — a
 * key with no limit at all is the normal case, and a line reading "Limit:
 * Unavailable" beside every such key would describe a missing feature as a
 * missing fact.
 */
function toAccountView(account: AccountInfo | null, now: number): ProviderAccountView | null {
  if (account === null) {
    return null;
  }
  return {
    keyLabel: account.keyLabelMasked,
    usageLabel: formatUsd(account.usageUsd),
    limitLabel: account.limitUsd === null ? null : formatUsd(account.limitUsd),
    limitRemainingLabel:
      // Only meaningful when there is a limit to draw down from.
      account.limitUsd === null || account.limitRemainingUsd === null
        ? null
        : formatUsd(account.limitRemainingUsd),
    limitReset: account.limitReset,
    planLabel:
      account.isFreeTier === null ? null : account.isFreeTier ? 'Free tier' : 'Paid tier',
    fetchedAtLabel: formatRelative(account.fetchedAt, now),
  };
}

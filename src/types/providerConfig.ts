/**
 * Provider configuration and connection state.
 *
 * Nothing in this file may ever carry a credential. Every value here is either a
 * URL, a status, a timestamp, or a figure the provider published about the
 * *account* (`usage`, `limit_remaining`). The API key itself lives only in
 * `SecretStorage` and is represented in the UI by a locally-computed mask.
 */

import type { ProviderId } from './provider';

export type AuthState =
  /** No key has been stored. */
  | 'unconfigured'
  /** A key is stored but has not been verified against the provider. */
  | 'stored'
  /** The provider accepted the key. */
  | 'valid'
  /** The provider rejected the key (401/403). */
  | 'invalid';

export type ConnectionState = 'unknown' | 'connecting' | 'connected' | 'error';

export type CatalogState = 'never' | 'loading' | 'ready' | 'error';

/** Account figures from `GET /key`. All optional: the endpoint may not be reachable. */
export interface AccountInfo {
  /**
   * The key's own label, masked again on our side.
   *
   * OpenRouter already returns this masked, but it is still derived from the
   * credential, so it passes through the same masker as everything else rather
   * than being trusted because a remote service said it was safe.
   */
  keyLabelMasked: string | null;
  usageUsd: number | null;
  limitUsd: number | null;
  limitRemainingUsd: number | null;
  /** e.g. `monthly`. */
  limitReset: string | null;
  isFreeTier: boolean | null;
  fetchedAt: number;
}

/**
 * The account figures from `GET /key`, as the screen prints them.
 *
 * `AccountInfo` carries the numbers the provider published; this carries the
 * words the panel shows. The split is deliberate: the panel performs no
 * arithmetic and no formatting, so a figure it had to turn into a string would
 * be a figure it could turn into the wrong string — `$0.00` for a limit nobody
 * reported, which reads as "nothing spent" rather than "not known".
 */
export interface ProviderAccountView {
  /** The key's own label as the provider reported it, masked again locally. */
  keyLabel: string | null;
  /** e.g. `$3.75`; `Unavailable` when no usage figure was reported. */
  usageLabel: string;
  /** The key's limit, or null when it has none. */
  limitLabel: string | null;
  /** What is left of that limit, or null when there is no limit to draw down. */
  limitRemainingLabel: string | null;
  /** e.g. `monthly`, in the provider's own words. */
  limitReset: string | null;
  /** e.g. `Free tier`, or null when the provider did not say. */
  planLabel: string | null;
  /** e.g. `4 minutes ago`. */
  fetchedAtLabel: string;
}

/**
 * Everything the Providers screen renders for one provider.
 *
 * This is a *view* of state, assembled by the host. It is safe to serialise into
 * a Webview: there is no field from which a key could be recovered.
 */
export interface ProviderView {
  id: ProviderId;
  label: string;
  /** One line on what this provider is, for the management list. */
  description: string;
  baseUrl: string;
  enabled: boolean;
  /** True when this provider currently receives PairPilot's turns. */
  isActive: boolean;
  /** False when the provider cannot be activated in this build. */
  selectable: boolean;
  authState: AuthState;
  connectionState: ConnectionState;
  /** Whether the SDK/runtime this provider needs is present. */
  available: boolean;
  /** Human-readable status line. Never contains a credential. */
  statusMessage: string;
  /** Locally-computed mask of the stored key, e.g. `sk-or-…a1b2`. */
  maskedKey: string | null;
  /** True when a key is stored, so the UI can show "Replace" instead of "Add". */
  hasStoredKey: boolean;
  account: ProviderAccountView | null;
  lastConnectedAt: number | null;
  lastConnectionError: string | null;
  catalogState: CatalogState;
  catalogError: string | null;
  lastCatalogRefreshAt: number | null;
  /** How many models the catalogue holds, as a sentence fragment, or null. */
  catalogModelCountLabel: string | null;
  /** True when a turn is in flight, so the UI can disable destructive actions. */
  busy: boolean;
  /**
   * Which controls the management screen offers for this provider.
   *
   * Explicit rather than inferred from `id`, so adding a provider does not mean
   * editing a conditional in the UI: the provider says what it supports and the
   * screen renders exactly that. A control that would do nothing is worse than
   * an absent one.
   */
  controls: {
    /** Authenticates with an API key held in `SecretStorage`. */
    apiKey: boolean;
    /** Publishes a model catalogue that can be fetched and refreshed. */
    catalog: boolean;
    /** Can be switched off, leaving the other providers usable. */
    disable: boolean;
  };
}

/** One entry in the "Why should I use this model?" section. */
export interface ModelAdviceReason {
  /** The catalogue fact the point rests on. */
  fact: string;
  /** What it means for the named task. Rendered as prose. */
  implication: string;
}

export interface ModelRecommendation {
  modelId: string;
  name: string;
  /** 0..1, derived from catalogue metadata only. Not a quality score. */
  score: number;
  reasons: ModelAdviceReason[];
  /** What the developer gives up by picking this model. Always non-empty. */
  tradeoffs: string[];
}

export interface ModelAdvice {
  taskId: ModelTaskId;
  taskLabel: string;
  /** The requirements the ranking was performed against, stated explicitly. */
  requirements: string[];
  recommendations: ModelRecommendation[];
  /**
   * Always present. States that the ranking is built from catalogue metadata,
   * and that PairPilot has not measured these models' output quality.
   */
  disclaimer: string;
  /** Set when the catalogue lacked the data the ranking needed. */
  caveat: string | null;
}

/* -------------------------------------------------------------------------- */
/* Model selection                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The work a model is being selected *for*.
 *
 * These mirror the Model Advisor's task profiles, so "recommend a model for code
 * review" and "set the model used for code review" speak the same vocabulary.
 */
export const MODEL_TASK_IDS = [
  'product-discovery',
  'architecture-design',
  'coding',
  'code-review',
  'simple-questions',
  'documentation',
  'large-repo-analysis',
] as const;
export type ModelTaskId = (typeof MODEL_TASK_IDS)[number];

/**
 * How broad a selection is.
 *
 * `task` beats `role` beats `project` beats `global`. The UI shows the resolved
 * value *and* which level supplied it, because "why is it using that model?" is
 * the only question that matters once settings can be inherited.
 */
export type SelectionLevel = 'global' | 'project' | 'role' | 'task';

export interface ModelSelection {
  modelId: string;
  level: SelectionLevel;
  /** Set for `role` and `task` levels. */
  key: string | null;
  updatedAt: number;
}

/** A resolved model choice, with provenance. */
export interface ResolvedModel {
  modelId: string | null;
  level: SelectionLevel | null;
  /** Human-readable provenance, e.g. "Role: Coding". */
  sourceLabel: string;
  /** True when nothing is configured and the provider default applies. */
  isProviderDefault: boolean;
}

/**
 * Which roles have a live consumer in the current build.
 *
 * This exists because PairPilot does not have Planning or Coding *Studios* —
 * there is one control loop. Rather than inventing screens to justify the
 * settings, the UI states plainly which roles a workflow actually reads. A role
 * with `consumers: []` is a stored preference that nothing acts on yet, and it
 * says so on screen.
 */
export interface ModelRoleDescriptor {
  id: ModelTaskId;
  label: string;
  description: string;
  /** Names of the PairPilot workflows that read this role today. */
  consumers: string[];
}

export const MODEL_ROLES: readonly ModelRoleDescriptor[] = [
  {
    id: 'coding',
    label: 'Coding',
    description: 'Writing the proposal for a file PairPilot is about to change.',
    consumers: ['The main coding turn'],
  },
  {
    id: 'code-review',
    label: 'Code Review',
    description: 'Reviewing written code and recommending the next engineering step.',
    consumers: ['Engineering Advisor'],
  },
  {
    id: 'product-discovery',
    label: 'Product Discovery',
    description: 'Exploring requirements before any code exists.',
    consumers: [],
  },
  {
    id: 'architecture-design',
    label: 'Architecture Design',
    description: 'Deciding structure and boundaries.',
    consumers: [],
  },
  {
    id: 'simple-questions',
    label: 'Simple Questions',
    description: 'Short questions that need a quick, cheap answer.',
    consumers: [],
  },
  {
    id: 'documentation',
    label: 'Documentation',
    description: 'Writing READMEs, guides and comments.',
    consumers: [],
  },
  {
    id: 'large-repo-analysis',
    label: 'Large Repository Analysis',
    description: 'Reading across many files at once.',
    consumers: [],
  },
];

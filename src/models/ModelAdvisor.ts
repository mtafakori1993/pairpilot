/**
 * ModelAdvisor — "why should I use this model?", answered from the catalogue.
 *
 * The Advisor's entire input is the published model metadata: price, context
 * window, maximum output, and the capabilities each model *declares* through its
 * supported-parameter list. It has no benchmark data, no evaluation results and
 * no telemetry from other users, and so it makes no claim about how good any
 * model's output is. What it does claim is narrower and checkable: *this model
 * costs this much, accepts this much context, and declares these capabilities,
 * which match what this task needs.*
 *
 * Three consequences of that discipline, all deliberate:
 *
 *  1. **Every reason cites a number or a field.** "Large context window" is not a
 *     reason; "Context window: 1,000,000 tokens, against the 128,000 this task
 *     needs" is. Each reason is a fact paired with its implication.
 *  2. **Every recommendation carries trade-offs, and they are never empty.** A
 *     shortlist with no downsides would be an advertisement. If a model is
 *     cheaper than its shortlist it is not the strongest; if it is strong it is
 *     not the cheapest. Whatever is *not* true of the model is stated.
 *  3. **A missing value is not a low value.** A model whose price is unknown
 *     scores zero on cost and is reported as unpriced — it is never treated as
 *     free, which is what would happen if `null` were coerced to `0`.
 *
 * The score is a ranking device over metadata, not a quality grade. It is
 * documented as such, and the disclaimer travels with every result so no caller
 * can display the number without the caveat.
 */

import { formatPricePerMillion, formatTokens, formatUsd } from './format';
import type { ModelMetadata } from '../types/model';
import type {
  ModelAdvice,
  ModelAdviceReason,
  ModelRecommendation,
  ModelTaskId,
} from '../types/providerConfig';

/** How many models the shortlist shows. */
export const SHORTLIST_SIZE = 5;

/** The request shape cost is compared on: a typical turn for this workflow. */
const REFERENCE_INPUT_TOKENS = 10_000;
const REFERENCE_OUTPUT_TOKENS = 2_000;

export interface TaskProfile {
  id: ModelTaskId;
  label: string;
  /** Stated on screen, so the ranking's criteria are inspectable. */
  requirements: string[];
  /**
   * A floor the task genuinely needs, not a preference.
   *
   * Applied as a hard filter when the catalogue publishes a context length. A
   * model whose context is *unknown* cannot be shown to meet the requirement, so
   * it is left out of the ranking too — but never silently: the count is
   * reported as a caveat on the advice, and `explain` names it as the reason a
   * particular model was not ranked. Dropping it quietly, or ranking it as
   * though its context were adequate, would both be a claim nobody published.
   */
  minContextTokens: number | null;
  weights: {
    context: number;
    outputRoom: number;
    lowCost: number;
    reasoning: number;
    structuredOutput: number;
    toolCalling: number;
    vision: number;
  };
}

/**
 * One profile per role, with weights that encode what the task actually
 * stresses. These are engineering judgements about *requirements*, not about
 * which model writes better code — and the requirements list is rendered next to
 * the results so a developer can disagree with them.
 */
export const TASK_PROFILES: readonly TaskProfile[] = [
  {
    id: 'simple-questions',
    label: 'Simple Questions',
    requirements: [
      'Low cost per request matters more than depth',
      'A short answer is sufficient',
    ],
    minContextTokens: null,
    weights: {
      context: 0.1,
      outputRoom: 0.2,
      lowCost: 0.65,
      reasoning: 0.05,
      structuredOutput: 0,
      toolCalling: 0,
      vision: 0,
    },
  },
  {
    id: 'coding',
    label: 'Coding',
    requirements: [
      'At least 128,000 tokens of context, to hold the files around the change',
      'Enough room for a full file in one response',
      'Declares structured output, which PairPilot’s proposal format relies on',
    ],
    minContextTokens: 128_000,
    weights: {
      context: 0.25,
      outputRoom: 0.22,
      lowCost: 0.15,
      reasoning: 0.08,
      structuredOutput: 0.3,
      toolCalling: 0,
      vision: 0,
    },
  },
  {
    id: 'code-review',
    label: 'Code Review',
    requirements: [
      'At least 128,000 tokens of context, to see the change and its neighbours',
      'Declares a reasoning capability',
    ],
    minContextTokens: 128_000,
    weights: {
      context: 0.3,
      outputRoom: 0.12,
      lowCost: 0.18,
      reasoning: 0.4,
      structuredOutput: 0,
      toolCalling: 0,
      vision: 0,
    },
  },
  {
    id: 'architecture-design',
    label: 'Architecture Design',
    requirements: [
      'At least 200,000 tokens of context, to weigh several parts of a system at once',
      'Declares a reasoning capability',
    ],
    minContextTokens: 200_000,
    weights: {
      context: 0.35,
      outputRoom: 0.15,
      lowCost: 0.12,
      reasoning: 0.38,
      structuredOutput: 0,
      toolCalling: 0,
      vision: 0,
    },
  },
  {
    id: 'product-discovery',
    label: 'Product Discovery',
    requirements: [
      'At least 128,000 tokens of context',
      'Declares a reasoning capability',
    ],
    minContextTokens: 128_000,
    weights: {
      context: 0.3,
      outputRoom: 0.12,
      lowCost: 0.28,
      reasoning: 0.3,
      structuredOutput: 0,
      toolCalling: 0,
      vision: 0,
    },
  },
  {
    id: 'documentation',
    label: 'Documentation',
    requirements: [
      'At least 128,000 tokens of context, to read what is being documented',
      'Room for long prose',
    ],
    minContextTokens: 128_000,
    weights: {
      context: 0.3,
      outputRoom: 0.25,
      lowCost: 0.35,
      reasoning: 0.1,
      structuredOutput: 0,
      toolCalling: 0,
      vision: 0,
    },
  },
  {
    id: 'large-repo-analysis',
    label: 'Large Repository Analysis',
    requirements: [
      'At least 400,000 tokens of context',
      'Low per-token cost, because requests are large',
    ],
    minContextTokens: 400_000,
    weights: {
      context: 0.6,
      outputRoom: 0.1,
      lowCost: 0.3,
      reasoning: 0,
      structuredOutput: 0,
      toolCalling: 0,
      vision: 0,
    },
  },
];

export function profileFor(taskId: ModelTaskId): TaskProfile | null {
  return TASK_PROFILES.find((profile) => profile.id === taskId) ?? null;
}

/** The sentence that must accompany every score this module produces. */
export const ADVISOR_DISCLAIMER =
  'Ranked from the prices, context windows and declared capabilities in the model catalogue. PairPilot has not measured these models’ output quality and publishes no benchmark results, so this is a fit-for-requirements ranking, not a claim that one model writes better code than another.';

export interface AdvisorDeps {
  list(): ModelMetadata[];
}

/** One model, explained against one task. The "Why should I use this model?" answer. */
export interface ModelExplanation {
  taskId: ModelTaskId;
  taskLabel: string;
  requirements: string[];
  disclaimer: string;
  /** 1-based position in the full ranking, or null when it was not ranked. */
  rank: number | null;
  /** How many models were ranked. */
  poolSize: number;
  /** How many of those the shortlist displays. */
  shortlistSize: number;
  /**
   * Set when the model was left out of the ranking, with the reason.
   *
   * This is the more useful half of the answer: "PairPilot does not rank this
   * model for coding, because its published context window is below what this
   * task needs" tells a developer something a favourable blurb never could.
   */
  excludedReason: string | null;
  /** Facts and trade-offs, present only when the model was ranked. */
  recommendation: ModelRecommendation | null;
  caveat: string | null;
}

/** The pool a ranking runs over, or the advice explaining why there is none. */
type PreparedPool =
  | { kind: 'pool'; profile: TaskProfile; models: ModelMetadata[]; caveats: string[] }
  | { kind: 'unavailable'; advice: ModelAdvice };

export class ModelAdvisor {
  constructor(private readonly deps: AdvisorDeps) {}

  recommend(taskId: ModelTaskId): ModelAdvice {
    const prepared = this.prepare(taskId);
    if (prepared.kind === 'unavailable') {
      return prepared.advice;
    }

    return {
      taskId,
      taskLabel: prepared.profile.label,
      requirements: prepared.profile.requirements,
      recommendations: rankModels(prepared.models, prepared.profile).slice(0, SHORTLIST_SIZE),
      disclaimer: ADVISOR_DISCLAIMER,
      caveat: prepared.caveats.length > 0 ? prepared.caveats.join(' ') : null,
    };
  }

  /**
   * Explain one named model against one task.
   *
   * The ranking is run over the *whole* pool rather than a pool of one, so the
   * position reported is the model's real position and the cost comparisons are
   * against the models it is actually competing with. Ranking a single model
   * against itself would score every model a perfect relative cost and produce a
   * flattering, meaningless answer.
   */
  explain(modelId: string, taskId: ModelTaskId): ModelExplanation | null {
    const model = this.deps.list().find((entry) => entry.id === modelId);
    if (model === undefined) {
      return null;
    }

    const prepared = this.prepare(taskId);
    if (prepared.kind === 'unavailable') {
      return {
        taskId,
        taskLabel: prepared.advice.taskLabel,
        requirements: prepared.advice.requirements,
        disclaimer: ADVISOR_DISCLAIMER,
        rank: null,
        poolSize: 0,
        shortlistSize: SHORTLIST_SIZE,
        excludedReason: prepared.advice.caveat,
        recommendation: null,
        caveat: prepared.advice.caveat,
      };
    }

    const ranked = rankModels(prepared.models, prepared.profile);
    const index = ranked.findIndex((entry) => entry.modelId === modelId);

    return {
      taskId,
      taskLabel: prepared.profile.label,
      requirements: prepared.profile.requirements,
      disclaimer: ADVISOR_DISCLAIMER,
      rank: index === -1 ? null : index + 1,
      poolSize: ranked.length,
      shortlistSize: SHORTLIST_SIZE,
      excludedReason: index === -1 ? explainExclusion(model, prepared.profile) : null,
      recommendation: index === -1 ? null : ranked[index] ?? null,
      caveat: prepared.caveats.length > 0 ? prepared.caveats.join(' ') : null,
    };
  }

  /**
   * Build the pool a ranking runs over, shared by `recommend` and `explain` so
   * the shortlist and the single-model explanation can never disagree about
   * which models were in the running.
   */
  private prepare(taskId: ModelTaskId): PreparedPool {
    const profile = profileFor(taskId);
    if (profile === null) {
      return {
        kind: 'unavailable',
        advice: {
          taskId,
          taskLabel: taskId,
          requirements: [],
          recommendations: [],
          disclaimer: ADVISOR_DISCLAIMER,
          caveat: 'PairPilot has no requirement profile for this task.',
        },
      };
    }

    const all = this.deps.list();
    if (all.length === 0) {
      return {
        kind: 'unavailable',
        advice: {
          taskId,
          taskLabel: profile.label,
          requirements: profile.requirements,
          recommendations: [],
          disclaimer: ADVISOR_DISCLAIMER,
          caveat:
            'The model catalogue is empty. Open the AI Providers & Models view and refresh the catalogue to get a recommendation.',
        },
      };
    }

    const caveats: string[] = [];
    const { kept, excludedUnknownContext, excludedTooSmall } = applyContextFloor(all, profile);

    if (excludedUnknownContext > 0) {
      caveats.push(
        `${excludedUnknownContext} of ${all.length} models publish no context window, so PairPilot cannot check them against this task’s requirement and left them out.`
      );
    }
    if (excludedTooSmall > 0) {
      caveats.push(
        `${excludedTooSmall} model${excludedTooSmall === 1 ? '' : 's'} fell below this task’s context requirement.`
      );
    }

    // A hard floor that empties the list is worse than a shortlist with a
    // warning, so the floor is relaxed and the relaxation is disclosed.
    let models = kept;
    if (models.length < 3) {
      models = all.filter((model) => model.contextLength !== null || profile.minContextTokens === null);
      if (models.length === 0) {
        models = [...all];
      }
      const restored = models.length - kept.length;
      if (restored > 0) {
        caveats.push(
          `Too few models met the context requirement on their published figures, so ${restored} more were included and the ranking weights below reflect their lower context scores.`
        );
      }
    }

    return { kind: 'pool', profile, models, caveats };
  }
}

/** Why a model is absent from a task's ranking. */
function explainExclusion(model: ModelMetadata, profile: TaskProfile): string {
  if (profile.minContextTokens === null) {
    // Unreachable in practice: a task with no floor ranks the whole catalogue.
    // Stated plainly rather than dressed up as a finding.
    return 'It was not included in this task’s ranking.';
  }
  if (model.contextLength === null) {
    return `The catalogue publishes no context window for this model, and this task asks for at least ${formatTokens(profile.minContextTokens)}, so PairPilot cannot check it and left it out of the ranking.`;
  }
  if (model.contextLength < profile.minContextTokens) {
    return `Its published context window of ${formatTokens(model.contextLength)} tokens is below the ${formatTokens(profile.minContextTokens)} this task asks for.`;
  }
  return 'It was not included in this task’s ranking.';
}

/* -------------------------------------------------------------------------- */
/* Ranking                                                                    */
/* -------------------------------------------------------------------------- */

/** The context floor, plus counts of what it removed and why. */
export function applyContextFloor(
  models: readonly ModelMetadata[],
  profile: TaskProfile
): { kept: ModelMetadata[]; excludedUnknownContext: number; excludedTooSmall: number } {
  if (profile.minContextTokens === null) {
    return { kept: [...models], excludedUnknownContext: 0, excludedTooSmall: 0 };
  }

  let excludedUnknownContext = 0;
  let excludedTooSmall = 0;
  const kept: ModelMetadata[] = [];

  for (const model of models) {
    if (model.contextLength === null) {
      excludedUnknownContext += 1;
      continue;
    }
    if (model.contextLength < profile.minContextTokens) {
      excludedTooSmall += 1;
      continue;
    }
    kept.push(model);
  }

  return { kept, excludedUnknownContext, excludedTooSmall };
}

/**
 * Rank a pool against a profile.
 *
 * Cost is scored relative to the pool's own range, because an absolute scale
 * would go stale the moment prices moved. Context and output room use a
 * logarithmic curve, so the difference between 4K and 8K counts for as much as
 * the difference between 500K and 1M — which is how those numbers actually
 * matter.
 */
export function rankModels(
  models: readonly ModelMetadata[],
  profile: TaskProfile
): ModelRecommendation[] {
  if (models.length === 0) {
    return [];
  }

  const costs = models.map(referenceCost);
  const known = costs.filter((cost): cost is number => cost !== null);
  const minCost = known.length > 0 ? Math.min(...known) : 0;
  const maxCost = known.length > 0 ? Math.max(...known) : 0;
  const medianCost = median(known);

  const scored = models.map((model) => {
    const dimensions = scoreModel(model, profile, minCost, maxCost);
    return { model, dimensions };
  });

  scored.sort((left, right) => {
    if (right.dimensions.total !== left.dimensions.total) {
      return right.dimensions.total - left.dimensions.total;
    }
    // A stable, explicable tie-break: cheaper first, then alphabetical.
    const leftCost = referenceCost(left.model);
    const rightCost = referenceCost(right.model);
    if (leftCost !== null && rightCost !== null && leftCost !== rightCost) {
      return leftCost - rightCost;
    }
    return left.model.id.localeCompare(right.model.id);
  });

  return scored.map((entry) => ({
    modelId: entry.model.id,
    name: entry.model.name,
    score: entry.dimensions.total,
    reasons: buildReasons(entry.model, profile, entry.dimensions),
    tradeoffs: buildTradeoffs(entry.model, profile, medianCost),
  }));
}

interface Dimensions {
  context: number;
  outputRoom: number;
  lowCost: number;
  reasoning: number;
  structuredOutput: number;
  toolCalling: number;
  vision: number;
  total: number;
}

function scoreModel(
  model: ModelMetadata,
  profile: TaskProfile,
  minCost: number,
  maxCost: number
): Dimensions {
  const cost = referenceCost(model);

  const dimensions: Dimensions = {
    // A missing context window scores zero. It is not "small"; it is unknown,
    // and the trade-off list says so.
    context: logScore(model.contextLength, 4_000, 2_000_000),
    outputRoom: logScore(model.maxOutputTokens, 1_000, 128_000),
    lowCost: cost === null ? 0 : costScore(cost, minCost, maxCost),
    reasoning: model.capabilities.reasoning ? 1 : 0,
    structuredOutput: model.capabilities.structuredOutput ? 1 : 0,
    toolCalling: model.capabilities.toolCalling ? 1 : 0,
    vision: model.capabilities.inputModalities.includes('image') ? 1 : 0,
    total: 0,
  };

  const weights = profile.weights;
  let weighted = 0;
  let totalWeight = 0;

  for (const key of [
    'context',
    'outputRoom',
    'lowCost',
    'reasoning',
    'structuredOutput',
    'toolCalling',
    'vision',
  ] as const) {
    const weight = weights[key];
    if (weight <= 0) {
      continue;
    }
    weighted += dimensions[key] * weight;
    totalWeight += weight;
  }

  dimensions.total = totalWeight === 0 ? 0 : round3(weighted / totalWeight);
  return dimensions;
}

/** Reference cost in USD for the standard request, or null when unpriced. */
export function referenceCost(model: ModelMetadata): number | null {
  const { promptPerToken, completionPerToken, requestUsd } = model.pricing;
  if (promptPerToken === null && completionPerToken === null) {
    return null;
  }
  return (
    (promptPerToken ?? 0) * REFERENCE_INPUT_TOKENS +
    (completionPerToken ?? 0) * REFERENCE_OUTPUT_TOKENS +
    (requestUsd ?? 0)
  );
}

/** Cheapest maps to 1, dearest to 0, logarithmically. */
function costScore(cost: number, minCost: number, maxCost: number): number {
  if (cost <= 0) {
    return 1;
  }
  if (maxCost <= minCost) {
    return 1;
  }
  const low = Math.log(Math.max(minCost, 1e-9));
  const high = Math.log(maxCost);
  if (high <= low) {
    return 1;
  }
  const position = (Math.log(cost) - low) / (high - low);
  return clamp01(1 - position);
}

/** Log-scaled 0..1 over a range, 0 when the value is absent. */
function logScore(value: number | null, low: number, high: number): number {
  if (value === null || value <= 0) {
    return 0;
  }
  const subject = Math.log(Math.max(value, low));
  const floor = Math.log(low);
  const ceiling = Math.log(high);
  if (ceiling <= floor) {
    return 1;
  }
  return clamp01((subject - floor) / (ceiling - floor));
}

/* -------------------------------------------------------------------------- */
/* Explanation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The reasons a model ranks where it does.
 *
 * Each entry pairs a catalogue fact with what it means for this task, and the
 * reasons are ordered by how much they actually contributed to the score — so
 * the first line explains the result rather than decorating it.
 */
function buildReasons(
  model: ModelMetadata,
  profile: TaskProfile,
  dimensions: Dimensions
): ModelAdviceReason[] {
  const reasons: ModelAdviceReason[] = [];
  const weights = profile.weights;

  const candidates: { contribution: number; reason: ModelAdviceReason }[] = [];

  if (weights.context > 0 && dimensions.context > 0) {
    candidates.push({
      contribution: weights.context * dimensions.context,
      reason: {
        fact: `Context window: ${formatTokens(model.contextLength)} tokens.`,
        implication:
          profile.minContextTokens === null
            ? 'Enough room to send the surrounding code with a request.'
            : `This task asks for at least ${formatTokens(profile.minContextTokens)}; this model clears it.`,
      },
    });
  }

  if (weights.lowCost > 0 && dimensions.lowCost > 0) {
    const cost = referenceCost(model);
    candidates.push({
      contribution: weights.lowCost * dimensions.lowCost,
      reason: {
        fact: `Input ${formatPricePerMillion(model.pricing.promptPerToken)}, output ${formatPricePerMillion(model.pricing.completionPerToken)}.`,
        implication:
          cost === null
            ? 'Cheaper than the rest of this shortlist.'
            : `A ${formatTokens(REFERENCE_INPUT_TOKENS)}-token request with a ${formatTokens(REFERENCE_OUTPUT_TOKENS)}-token reply would cost about ${formatUsd(cost)}.`,
      },
    });
  }

  if (weights.reasoning > 0 && model.capabilities.reasoning) {
    candidates.push({
      contribution: weights.reasoning,
      reason: {
        fact: 'Declares a reasoning capability.',
        implication:
          'Built for tasks where the answer depends on weighing alternatives rather than recalling a pattern.',
      },
    });
  }

  if (weights.structuredOutput > 0 && model.capabilities.structuredOutput) {
    candidates.push({
      contribution: weights.structuredOutput,
      reason: {
        fact: `Declares structured output (${describeParameters(model, ['structured_outputs', 'response_format'])}).`,
        implication:
          'Able to be constrained to emit valid JSON, which is the shape PairPilot’s proposals arrive in.',
      },
    });
  }

  if (weights.outputRoom > 0 && dimensions.outputRoom > 0) {
    candidates.push({
      contribution: weights.outputRoom * dimensions.outputRoom,
      reason: {
        fact: `Maximum output: ${formatTokens(model.maxOutputTokens)} tokens.`,
        implication: 'Long enough to return a whole file without being cut off.',
      },
    });
  }

  candidates.sort((left, right) => right.contribution - left.contribution);

  for (const candidate of candidates.slice(0, 4)) {
    reasons.push(candidate.reason);
  }

  if (reasons.length === 0) {
    // A model that clears the context floor but matches nothing else. Saying so
    // is better than returning an empty list the UI would render as blank.
    reasons.push({
      fact: 'No standout catalogue properties for this task.',
      implication: `It cleared the context requirement (${formatTokens(model.contextLength)}) but publishes no price or capability that this task weights heavily.`,
    });
  }

  return reasons;
}

/**
 * What the developer gives up by choosing this model.
 *
 * Never empty by construction: the final fallback compares the model against the
 * shortlist median, and one of the two branches always applies.
 */
function buildTradeoffs(
  model: ModelMetadata,
  profile: TaskProfile,
  /** Median reference cost of the pool, or null when the pool is entirely unpriced. */
  medianCost: number | null
): string[] {
  const tradeoffs: string[] = [];
  const { promptPerToken, completionPerToken, cacheReadPerToken, isFree } = model.pricing;

  if (model.contextLength === null) {
    tradeoffs.push(
      'The catalogue publishes no context window for this model, so PairPilot cannot check that your files fit.'
    );
  }
  if (promptPerToken === null || completionPerToken === null) {
    tradeoffs.push(
      'Pricing is incomplete, so this model’s cost will show as estimated or unavailable rather than exact.'
    );
  } else if (cacheReadPerToken === null && !isFree) {
    tradeoffs.push(
      `No cache-read price is published, so cached tokens are billed at the full input rate of ${formatPricePerMillion(promptPerToken)}.`
    );
  }
  if (profile.weights.structuredOutput > 0 && !model.capabilities.structuredOutput) {
    tradeoffs.push(
      'Does not declare structured output, so the proposal JSON is not schema-enforced and may need a retry.'
    );
  }
  if (profile.weights.reasoning > 0 && !model.capabilities.reasoning) {
    tradeoffs.push('Does not declare a reasoning capability.');
  }
  if (
    profile.minContextTokens !== null &&
    model.contextLength !== null &&
    model.contextLength < profile.minContextTokens
  ) {
    tradeoffs.push(
      `Context window of ${formatTokens(model.contextLength)} is below this task’s stated ${formatTokens(profile.minContextTokens)}.`
    );
  }
  if (model.maxOutputTokens !== null && model.maxOutputTokens < 8_000) {
    tradeoffs.push(
      `Maximum output of ${formatTokens(model.maxOutputTokens)} tokens may truncate a large file.`
    );
  }

  // The relative-cost sentence. Exactly one branch fires, so this always adds a
  // line even for a model with nothing else wrong with it.
  const cost = referenceCost(model);
  if (cost === null) {
    tradeoffs.push('No published price, so its cost cannot be compared with the rest of the shortlist.');
  } else if (medianCost !== null && cost > medianCost) {
    tradeoffs.push(
      `Costs more than the middle of this shortlist: about ${formatUsd(cost)} for the reference request, against a median of ${formatUsd(medianCost)}.`
    );
  } else {
    tradeoffs.push(
      'Cheaper per request than most of this shortlist, which means it is not the strongest option here — the ranking above weights cost, not measured quality.'
    );
  }

  return tradeoffs;
}

/** Name the parameters a model publishes, for a reason's parenthetical. */
function describeParameters(model: ModelMetadata, names: string[]): string {
  const present = names.filter((name) => model.capabilities.supportedParameters.includes(name));
  return present.length > 0 ? present.join(', ') : 'not listed per-parameter';
}

/* -------------------------------------------------------------------------- */

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null;
  }
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  if (lower === undefined || upper === undefined) {
    return null;
  }
  return (lower + upper) / 2;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

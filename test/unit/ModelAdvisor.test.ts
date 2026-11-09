/**
 * The Model Advisor (spec sections 12 and 12b).
 *
 * The spec forbids inventing benchmark scores or claiming objective superiority,
 * so the tests here check the two things that would break that promise:
 *
 *   - Every recommendation carries the disclaimer, and the requirements behind
 *     the ranking are rendered next to it. A ranking whose criteria are hidden
 *     is an opinion wearing a number.
 *   - `explain` must produce a *useful* answer for a model that was not ranked.
 *     The honest negative — "its context window is below what this task asks
 *     for" — is the more valuable half of "Why should I use this model?", and it
 *     is the half that a flattering blurb would omit.
 *
 * `explain` also ranks the whole pool rather than a pool of one, so the position
 * it reports is real. That is asserted directly, because ranking a single model
 * against itself produces a perfect relative cost score and a meaningless "top
 * of its shortlist" answer.
 */

import { describe, expect, it } from 'vitest';
import {
  ADVISOR_DISCLAIMER,
  ModelAdvisor,
  SHORTLIST_SIZE,
  TASK_PROFILES,
  applyContextFloor,
  profileFor,
  rankModels,
  referenceCost,
} from '../../src/models/ModelAdvisor';
import { emptyPricing, type ModelMetadata } from '../../src/types/model';

function model(id: string, overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  const perMillion = (usd: number): number => usd / 1_000_000;
  return {
    id,
    canonicalSlug: null,
    name: id,
    developer: id.split('/')[0] ?? null,
    description: null,
    contextLength: 200_000,
    maxOutputTokens: 32_000,
    created: null,
    pricing: { ...emptyPricing(), promptPerToken: perMillion(3), completionPerToken: perMillion(15) },
    capabilities: {
      inputModalities: ['text'],
      outputModalities: ['text'],
      toolCalling: true,
      structuredOutput: true,
      reasoning: true,
      supportedParameters: ['tools'],
    },
    unknownFields: [],
    capturedAt: 0,
    ...overrides,
  };
}

/** A catalogue where each entry differs on exactly one axis. */
function catalog(): ModelMetadata[] {
  return [
    model('vendor/cheap', {
      contextLength: 200_000,
      pricing: { ...emptyPricing(), promptPerToken: 0.0000001, completionPerToken: 0.0000002 },
    }),
    model('vendor/pricey', {
      contextLength: 1_000_000,
      maxOutputTokens: 128_000,
      pricing: { ...emptyPricing(), promptPerToken: 0.00006, completionPerToken: 0.0002 },
    }),
    model('vendor/small', {
      contextLength: 8_000,
      pricing: { ...emptyPricing(), promptPerToken: 0.000003, completionPerToken: 0.000015 },
    }),
    model('vendor/nocontext', {
      contextLength: null,
      pricing: { ...emptyPricing(), promptPerToken: 0.000003, completionPerToken: 0.000015 },
    }),
    model('vendor/unpriced', {
      contextLength: 200_000,
      pricing: emptyPricing(),
    }),
  ];
}

function advisor(models: ModelMetadata[] = catalog()): ModelAdvisor {
  return new ModelAdvisor({ list: () => models });
}

describe('recommend', () => {
  it('returns a ranked shortlist for every task and always carries the disclaimer', () => {
    for (const profile of TASK_PROFILES) {
      const advice = advisor().recommend(profile.id);
      expect(advice.recommendations.length, profile.id).toBeGreaterThan(0);
      expect(advice.recommendations.length, profile.id).toBeLessThanOrEqual(SHORTLIST_SIZE);
      expect(advice.disclaimer, profile.id).toBe(ADVISOR_DISCLAIMER);
      expect(advice.requirements.length, profile.id).toBeGreaterThan(0);
    }
  });

  it('states the requirements it ranked against, so the criteria are inspectable', () => {
    const advice = advisor().recommend('coding');
    expect(advice.taskLabel).toBe('Coding');
    expect(advice.requirements.join(' ')).toContain('128,000');
  });

  it('orders the shortlist by descending score', () => {
    const advice = advisor().recommend('coding');
    const scores = advice.recommendations.map((entry) => entry.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('gives every recommendation a non-empty reason and trade-off list', () => {
    // A model that appears in a shortlist with no explanation is a claim with no
    // support. Each entry has to say what earned it its place and what it costs.
    for (const entry of advisor().recommend('coding').recommendations) {
      expect(entry.reasons.length, entry.modelId).toBeGreaterThan(0);
      expect(entry.tradeoffs.length, entry.modelId).toBeGreaterThan(0);
      expect(entry.score).toBeGreaterThanOrEqual(0);
      expect(entry.score).toBeLessThanOrEqual(1);
    }
  });

  it('recommends a cheap model for simple questions', () => {
    // The "Simple Questions" profile weights cost 0.65, so the cheapest model
    // with enough context should lead — a check that the weights actually do
    // something rather than being decoration.
    const advice = advisor().recommend('simple-questions');
    expect(advice.recommendations[0]?.modelId).toBe('vendor/cheap');
  });

  it('discloses the models it could not check', () => {
    const advice = advisor().recommend('coding');
    expect(advice.caveat).not.toBeNull();
    expect(advice.caveat).toContain('no context window');
  });

  it('explains an empty catalogue rather than recommending nothing', () => {
    const advice = advisor([]).recommend('coding');
    expect(advice.recommendations).toEqual([]);
    expect(advice.caveat).toContain('catalogue is empty');
    expect(advice.disclaimer).toBe(ADVISOR_DISCLAIMER);
  });

  it('reports an unknown task plainly', () => {
    const advice = advisor().recommend('not-a-task' as never);
    expect(advice.recommendations).toEqual([]);
    expect(advice.caveat).toContain('no requirement profile');
  });
});

describe('explain: "Why should I use this model?"', () => {
  it('reports the model’s real position in the full ranking', () => {
    const models = catalog();
    const explanation = advisor(models).explain('vendor/pricey', 'coding');

    expect(explanation).not.toBeNull();
    const ranked = rankModels(
      models.filter((m) => m.contextLength !== null && m.contextLength >= 128_000),
      profileFor('coding') as never
    );
    expect(explanation?.poolSize).toBe(ranked.length);
    expect(explanation?.rank).toBe(ranked.findIndex((entry) => entry.modelId === 'vendor/pricey') + 1);
  });

  it('does not give an expensive model a flattering cost score in a real pool', () => {
    // The failure this guards: ranking a single model against itself makes the
    // pool's own cost range collapse to that one model, so cheapest and dearest
    // are the same figure and every model scores a perfect 1 on cost. Ranking
    // the whole pool is what makes the comparison mean something.
    const models = catalog();
    const instance = advisor(models);
    const explanation = instance.explain('vendor/pricey', 'coding');

    expect(explanation?.rank).not.toBe(1);
    expect(explanation?.poolSize).toBeGreaterThan(1);
    // The expensive model is ranked, so it must say what it costs.
    expect(explanation?.recommendation?.tradeoffs.join(' ').toLowerCase()).toContain('cost');
  });

  it('reports a pool of one honestly, without inventing a comparison', () => {
    const only = model('vendor/solo', {
      contextLength: 200_000,
      pricing: { ...emptyPricing(), promptPerToken: 0.00006, completionPerToken: 0.0002 },
    });
    const explanation = advisor([only]).explain('vendor/solo', 'coding');
    expect(explanation?.poolSize).toBe(1);
    expect(explanation?.rank).toBe(1);

    // And `recommend` says the same thing about the same pool.
    expect(advisor([only]).recommend('coding').recommendations).toHaveLength(1);
  });

  it('gives a reason rather than a blurb when the model was not ranked', () => {
    const explanation = advisor().explain('vendor/small', 'coding');
    expect(explanation?.rank).toBeNull();
    expect(explanation?.recommendation).toBeNull();
    expect(explanation?.excludedReason).toContain('8,000');
    expect(explanation?.excludedReason).toContain('128,000');
  });

  it('names an unknown context window as the reason, not a low one', () => {
    const explanation = advisor().explain('vendor/nocontext', 'coding');
    expect(explanation?.excludedReason).toContain('publishes no context window');
  });

  it('explains why it cannot advise, for a model that exists but a task that is unknown', () => {
    const explanation = advisor().explain('vendor/cheap', 'not-a-task' as never);
    expect(explanation?.rank).toBeNull();
    expect(explanation?.poolSize).toBe(0);
    expect(explanation?.recommendation).toBeNull();
    expect(explanation?.disclaimer).toBe(ADVISOR_DISCLAIMER);
  });

  it('has nothing to explain about a model the catalogue does not contain', () => {
    // An empty catalogue means the named model cannot exist, so there is no
    // model to answer for — and inventing an explanation would be worse than
    // saying nothing.
    expect(advisor([]).explain('vendor/cheap', 'coding')).toBeNull();
    expect(advisor([]).explain('vendor/cheap', 'coding')).toBeNull();
  });

  it('returns null for a model not in the catalogue', () => {
    expect(advisor().explain('vendor/absent', 'coding')).toBeNull();
  });

  it('agrees with recommend about which models were in the running', () => {
    // Both call the same `prepare`, so the shortlist and the explanation cannot
    // drift apart about the pool.
    const models = catalog();
    const instance = advisor(models);
    const advice = instance.recommend('coding');
    for (const entry of advice.recommendations) {
      const explanation = instance.explain(entry.modelId, 'coding');
      expect(explanation?.rank, entry.modelId).not.toBeNull();
      expect(explanation?.poolSize).toBe(
        instance.explain(advice.recommendations[0]?.modelId ?? '', 'coding')?.poolSize
      );
    }
  });

  it('explains a task with no floor as a full-catalogue ranking', () => {
    const explanation = advisor().explain('vendor/nocontext', 'simple-questions');
    // No context requirement means nothing is excluded for one.
    expect(explanation?.poolSize).toBe(catalog().length);
    expect(explanation?.rank).not.toBeNull();
  });
});

describe('applyContextFloor', () => {
  const profile = profileFor('coding') as never as Parameters<typeof applyContextFloor>[1];

  it('keeps models at or above the floor and counts the reasons for the rest', () => {
    const result = applyContextFloor(catalog(), profile);
    expect(result.kept.map((m) => m.id)).toEqual([
      'vendor/cheap',
      'vendor/pricey',
      'vendor/unpriced',
    ]);
    expect(result.excludedUnknownContext).toBe(1);
    expect(result.excludedTooSmall).toBe(1);
  });

  it('keeps everything when the task sets no floor', () => {
    const noFloor = profileFor('simple-questions') as never as Parameters<typeof applyContextFloor>[1];
    const result = applyContextFloor(catalog(), noFloor);
    expect(result.kept).toHaveLength(5);
    expect(result.excludedUnknownContext).toBe(0);
    expect(result.excludedTooSmall).toBe(0);
  });
});

describe('referenceCost', () => {
  it('prices the standard request from the catalogue rates', () => {
    const cost = referenceCost(
      model('a/b', {
        pricing: { ...emptyPricing(), promptPerToken: 0.000003, completionPerToken: 0.000015 },
      })
    );
    // 10,000 input at $3/M + 2,000 output at $15/M.
    expect(cost).toBeCloseTo(0.03 + 0.03, 9);
  });

  it('includes a flat per-request charge', () => {
    const cost = referenceCost(
      model('a/b', { pricing: { ...emptyPricing(), promptPerToken: 0.000001, requestUsd: 0.02 } })
    );
    expect(cost).toBeCloseTo(0.01 + 0.02, 9);
  });

  it('returns null when the model publishes no price at all', () => {
    expect(referenceCost(model('a/b', { pricing: emptyPricing() }))).toBeNull();
  });

  it('treats a genuinely free model as costing zero', () => {
    expect(
      referenceCost(model('a/b', { pricing: { ...emptyPricing(), promptPerToken: 0, completionPerToken: 0 } }))
    ).toBe(0);
  });
});

describe('the profiles themselves', () => {
  it('covers every task the UI offers, with non-empty requirements', () => {
    for (const profile of TASK_PROFILES) {
      expect(profile.requirements.length, profile.id).toBeGreaterThan(0);
      expect(profile.label.length, profile.id).toBeGreaterThan(0);
    }
    const ids = TASK_PROFILES.map((profile) => profile.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never claims a benchmark or a quality ranking in its wording', () => {
    // The spec forbids inventing benchmark scores or claiming objective
    // superiority. The disclaimer is the place that promise is kept, so it is
    // checked for the words that would break it.
    expect(ADVISOR_DISCLAIMER).toContain('not measured');
    expect(ADVISOR_DISCLAIMER).toContain('no benchmark');
    for (const profile of TASK_PROFILES) {
      const text = [profile.label, ...profile.requirements].join(' ').toLowerCase();
      expect(text, profile.id).not.toContain('best');
      expect(text, profile.id).not.toContain('smartest');
      expect(text, profile.id).not.toContain('benchmark');
    }
  });
});

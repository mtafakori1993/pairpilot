/**
 * Catalogue normalisation (spec sections 10 and 11).
 *
 * The guiding rule: a field PairPilot does not have is `null` and its name is
 * recorded in `unknownFields`, so the UI can say "Not provided". It is never
 * `0`, never `""` and never a plausible-looking default.
 *
 * The second half of these tests is about the shape drift that was actually
 * observed on a live `GET /models`: objects carrying `display_name`,
 * `max_input_tokens`, `max_tokens` and a null `capabilities`, with no
 * `pricing`, no `architecture` and no `context_length` at all. A normaliser that
 * only reads the published schema silently produces a catalogue of empty models
 * against that response, so the fallbacks are tested at the same depth as the
 * documented path.
 */

import { describe, expect, it } from 'vitest';
import {
  deriveDeveloper,
  isTextToText,
  normalizeModel,
  perMillion,
} from '../../src/models/ModelMetadata';

const AT = 1_700_000_000_000;

/** A complete entry in the documented shape. */
function documented(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'anthropic/claude-sonnet-5-5',
    canonical_slug: 'anthropic/claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    description: 'A capable general-purpose model.',
    created: 1_750_000_000,
    context_length: 200_000,
    architecture: {
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      modality: 'text+image->text',
    },
    pricing: {
      prompt: '0.000003',
      completion: '0.000015',
      input_cache_read: '0.0000003',
      input_cache_write: '0.00000375',
      request: '0',
      image: '0',
    },
    top_provider: { context_length: 200_000, max_completion_tokens: 64_000 },
    supported_parameters: ['tools', 'tool_choice', 'response_format', 'reasoning'],
    ...overrides,
  };
}

describe('normalizeModel: documented shape', () => {
  it('reads every documented field', () => {
    const model = normalizeModel(documented(), AT);
    expect(model).not.toBeNull();
    expect(model?.id).toBe('anthropic/claude-sonnet-5-5');
    expect(model?.name).toBe('Claude Sonnet 5.5');
    expect(model?.description).toBe('A capable general-purpose model.');
    expect(model?.contextLength).toBe(200_000);
    expect(model?.maxOutputTokens).toBe(64_000);
    expect(model?.created).toBe(1_750_000_000);
    expect(model?.developer).toBe('anthropic');
    expect(model?.capturedAt).toBe(AT);
    expect(model?.unknownFields).toEqual([]);
  });

  it('keeps prices per token, not per million', () => {
    // The published values are USD per token. Confusing the two conventions
    // halfway through a calculation is a 1,000,000× error, so the stored unit is
    // asserted directly.
    const model = normalizeModel(documented(), AT);
    expect(model?.pricing.promptPerToken).toBe(0.000003);
    expect(model?.pricing.completionPerToken).toBe(0.000015);
    expect(model?.pricing.cacheReadPerToken).toBe(0.0000003);
    expect(model?.pricing.cacheWritePerToken).toBe(0.00000375);
    expect(perMillion(model?.pricing.promptPerToken ?? null)).toBeCloseTo(3, 9);
  });

  it('reads prices published as strings', () => {
    // The live API sends these as JSON strings, not numbers.
    const model = normalizeModel(documented({ pricing: { prompt: '0.000001', completion: '0.000002' } }), AT);
    expect(model?.pricing.promptPerToken).toBe(0.000001);
    expect(model?.pricing.completionPerToken).toBe(0.000002);
  });

  it('derives capabilities from the parameter list rather than a curated table', () => {
    const model = normalizeModel(documented(), AT);
    expect(model?.capabilities.toolCalling).toBe(true);
    expect(model?.capabilities.structuredOutput).toBe(true);
    expect(model?.capabilities.reasoning).toBe(true);
    expect(model?.capabilities.inputModalities).toEqual(['text', 'image']);
    expect(model?.capabilities.outputModalities).toEqual(['text']);
  });

  it('reports no tool calling when the parameter list does not offer it', () => {
    const model = normalizeModel(documented({ supported_parameters: ['temperature', 'top_p'] }), AT);
    expect(model?.capabilities.toolCalling).toBe(false);
    expect(model?.capabilities.structuredOutput).toBe(false);
    expect(model?.capabilities.reasoning).toBe(false);
  });

  it('drops modality tokens the schema does not define', () => {
    const model = normalizeModel(
      documented({ architecture: { input_modalities: ['text', 'telepathy'], output_modalities: ['text'] } }),
      AT
    );
    expect(model?.capabilities.inputModalities).toEqual(['text']);
  });
});

describe('normalizeModel: the observed variant shape', () => {
  /** Reproduces what a live `GET /models` actually returned while building this. */
  const variant = {
    id: 'vendor/model-x',
    display_name: 'Model X',
    description: 'A model.',
    created_at: '2025-04-01T00:00:00.000Z',
    max_input_tokens: 128_000,
    max_tokens: 8_192,
    capabilities: null,
  };

  it('reads the variant spellings for name, context and output cap', () => {
    const model = normalizeModel(variant, AT);
    expect(model?.name).toBe('Model X');
    expect(model?.contextLength).toBe(128_000);
    expect(model?.maxOutputTokens).toBe(8_192);
    expect(model?.created).toBe(Math.floor(Date.parse('2025-04-01T00:00:00.000Z') / 1000));
  });

  it('records the fields the variant did not supply instead of inventing them', () => {
    const model = normalizeModel(variant, AT);
    expect(model?.unknownFields).toContain('pricing');
    expect(model?.unknownFields).not.toContain('display name');
    expect(model?.unknownFields).not.toContain('context length');
    expect(model?.unknownFields).not.toContain('max output tokens');
  });

  it('treats a variant model as unpriced, not as free', () => {
    // This is the distinction that matters most: `isFree` must be false and the
    // prices must be null, so the cost engine reports "unavailable" rather than
    // a confident $0.00.
    const model = normalizeModel(variant, AT);
    expect(model?.pricing.promptPerToken).toBeNull();
    expect(model?.pricing.completionPerToken).toBeNull();
    expect(model?.pricing.isFree).toBe(false);
  });

  it('falls back to the id as the display name, and flags that it did', () => {
    const model = normalizeModel({ id: 'vendor/bare' }, AT);
    expect(model?.name).toBe('vendor/bare');
    expect(model?.unknownFields).toContain('display name');
  });
});

describe('normalizeModel: absent and malformed values', () => {
  it('returns null when there is no usable id', () => {
    // A model with no id cannot be selected, so it is dropped rather than given
    // a synthetic one that would then be sent to the provider.
    expect(normalizeModel({ name: 'nameless' }, AT)).toBeNull();
    expect(normalizeModel({ id: 42 }, AT)).toBeNull();
    expect(normalizeModel({ id: '' }, AT)).toBeNull();
    expect(normalizeModel(null, AT)).toBeNull();
    expect(normalizeModel('a string', AT)).toBeNull();
    expect(normalizeModel([{ id: 'a/b' }], AT)).toBeNull();
  });

  it('nulls a context length of zero rather than reporting an unusable window', () => {
    const model = normalizeModel(documented({ context_length: 0, top_provider: undefined }), AT);
    expect(model?.contextLength).toBeNull();
    expect(model?.unknownFields).toContain('context length');
  });

  it('prefers the top provider\'s served context over an unusable model-level figure', () => {
    // `top_provider.context_length` is the effective limit, so it is a real
    // fallback rather than a second-best guess.
    const model = normalizeModel(documented({ context_length: 0 }), AT);
    expect(model?.contextLength).toBe(200_000);
  });

  it('treats an explicit zero in top_provider as absent', () => {
    const model = normalizeModel(
      documented({ context_length: undefined, max_input_tokens: undefined, top_provider: { context_length: 0 } }),
      AT
    );
    expect(model?.contextLength).toBeNull();
  });

  it('reports an unparseable release date as absent, not as NaN', () => {
    const model = normalizeModel(documented({ created: undefined, created_at: 'sometime' }), AT);
    expect(model?.created).toBeNull();
    expect(model?.unknownFields).toContain('release date');
  });

  it('distinguishes a pricing object of zeroes from no pricing object', () => {
    const free = normalizeModel(documented({ pricing: { prompt: '0', completion: '0' } }), AT);
    expect(free?.pricing.isFree).toBe(true);
    expect(free?.pricing.promptPerToken).toBe(0);

    const unpriced = normalizeModel(documented({ pricing: undefined }), AT);
    expect(unpriced?.pricing.isFree).toBe(false);
    expect(unpriced?.unknownFields).toContain('pricing');
  });

  it('does not call a model free when only one side is zero', () => {
    const model = normalizeModel(documented({ pricing: { prompt: '0', completion: '0.000002' } }), AT);
    expect(model?.pricing.isFree).toBe(false);
  });

  it('reads a null capabilities field without treating it as an empty capability set', () => {
    // `capabilities` is not where capabilities live; the parameter list is. A
    // null here must not suppress a real `tools` entry.
    const model = normalizeModel(documented({ capabilities: null }), AT);
    expect(model?.capabilities.toolCalling).toBe(true);
  });

  it('prefers the documented reasoning block over the parameter list', () => {
    const model = normalizeModel(
      documented({ supported_parameters: [], reasoning: { supported_efforts: ['high'] } }),
      AT
    );
    expect(model?.capabilities.reasoning).toBe(true);
  });

  it('survives malformed arrays and objects', () => {
    const model = normalizeModel(
      documented({
        architecture: 'nope',
        supported_parameters: 'tools',
        top_provider: [],
      }),
      AT
    );
    expect(model?.capabilities.toolCalling).toBe(false);
    expect(model?.capabilities.inputModalities).toEqual([]);
    expect(model?.maxOutputTokens).toBeNull();
  });

  it('drops non-string entries from the parameter list', () => {
    const model = normalizeModel(documented({ supported_parameters: ['tools', 7, null, 'temperature'] }), AT);
    expect(model?.capabilities.supportedParameters).toEqual(['tools', 'temperature']);
  });
});

describe('deriveDeveloper', () => {
  it('reads the vendor prefix from the id', () => {
    expect(deriveDeveloper('anthropic/claude-sonnet-5-5')).toBe('anthropic');
    expect(deriveDeveloper('meta-llama/llama-4-70b')).toBe('meta-llama');
  });

  it('reports an id with no vendor prefix as null rather than empty', () => {
    // PairPilot labels this as derived, so "no vendor" must be a stated absence.
    expect(deriveDeveloper('bare-model')).toBeNull();
    expect(deriveDeveloper('/leading')).toBeNull();
  });
});

describe('isTextToText', () => {
  it('accepts a text-only model', () => {
    const model = normalizeModel(documented(), AT);
    expect(model && isTextToText(model)).toBe(true);
  });

  it('accepts a model declaring no modalities at all', () => {
    // Unknown modalities are not evidence of an incompatible one.
    const model = normalizeModel({ id: 'vendor/bare' }, AT);
    expect(model && isTextToText(model)).toBe(true);
  });

  it('rejects a model that cannot take text in or give text out', () => {
    const audioIn = normalizeModel(
      documented({ architecture: { input_modalities: ['audio'], output_modalities: ['text'] } }),
      AT
    );
    expect(audioIn && isTextToText(audioIn)).toBe(false);

    const imageOut = normalizeModel(
      documented({ architecture: { input_modalities: ['text'], output_modalities: ['image'] } }),
      AT
    );
    expect(imageOut && isTextToText(imageOut)).toBe(false);
  });
});

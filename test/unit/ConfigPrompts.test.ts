/**
 * ConfigPrompts — the data a native QuickPick shows.
 *
 * The pickers themselves need an editor host, and are exercised by the real-host
 * suite. What is provable here is the part that decides what a developer sees:
 * the step order, the wording of each choice, and the promise that a choice is
 * stored at the level the resolver actually reads.
 */

import { describe, expect, it } from 'vitest';
import {
  categoryChoices,
  clearedConfirmation,
  filterChoices,
  keyOf,
  levelOf,
  listSummary,
  modelItem,
  providerChoice,
  selectionConfirmation,
  targetLabel,
  type SelectionTarget,
} from '../../src/config/ConfigPrompts';
import { MODEL_QUICK_FILTERS, type ModelMetadata } from '../../src/types/model';
import type { ProviderView } from '../../src/types/providerConfig';

function model(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    id: 'anthropic/claude-sonnet-4',
    canonicalSlug: 'anthropic/claude-sonnet-4',
    name: 'Claude Sonnet 4',
    developer: 'anthropic',
    description: null,
    contextLength: 200_000,
    maxOutputTokens: 64_000,
    created: null,
    pricing: {
      promptPerToken: 0.000003,
      completionPerToken: 0.000015,
      cacheReadPerToken: null,
      cacheWritePerToken: null,
      requestUsd: null,
      imageUsd: null,
      isFree: false,
    },
    capabilities: {
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      toolCalling: true,
      structuredOutput: true,
      reasoning: true,
      supportedParameters: ['tools', 'reasoning'],
    },
    unknownFields: [],
    capturedAt: 1,
    ...overrides,
  };
}

describe('categoryChoices', () => {
  it('offers every role, in workflow order, and always offers the global default', () => {
    const choices = categoryChoices('/workspace');
    const roleIds = choices
      .filter((choice) => choice.target.kind === 'role')
      .map((choice) => (choice.target as { roleId: string }).roleId);

    // Planning, coding and review come first because that is the order the
    // workflow runs them. Every declared role is present exactly once.
    expect(roleIds.slice(0, 3)).toEqual(['architecture-design', 'coding', 'code-review']);
    expect(new Set(roleIds).size).toBe(roleIds.length);
    expect(roleIds).toHaveLength(7);
    expect(choices.some((choice) => choice.target.kind === 'global')).toBe(true);
  });

  it('names the workflow roles the way the product does', () => {
    const labels = categoryChoices('/workspace').map((choice) => choice.label);
    expect(labels).toContain('Planning');
    expect(labels).toContain('Coding');
    expect(labels[labels.indexOf('Code review & Engineering Advisor')]).toBeTruthy();
    expect(labels).toContain('Every turn (global default)');
  });

  it('says plainly when nothing in this build reads a role', () => {
    const documentation = categoryChoices(null).find(
      (choice) => choice.target.kind === 'role' && choice.target.roleId === 'documentation'
    );
    expect(documentation?.detail).toContain('Nothing in this build reads this role yet');
  });

  it('names the consumer of a role that does have one', () => {
    const coding = categoryChoices(null).find(
      (choice) => choice.target.kind === 'role' && choice.target.roleId === 'coding'
    );
    expect(coding?.detail).toContain('The main coding turn');
  });

  it('offers a project level only when a workspace is open', () => {
    expect(categoryChoices(null).some((choice) => choice.target.kind === 'project')).toBe(false);
    expect(categoryChoices('/workspace').some((choice) => choice.target.kind === 'project')).toBe(true);
  });
});

describe('target mapping', () => {
  const targets: Array<[SelectionTarget, string, string | null]> = [
    [{ kind: 'global' }, 'global', null],
    [{ kind: 'project', projectPath: '/w' }, 'project', '/w'],
    [{ kind: 'role', roleId: 'coding' }, 'role', 'coding'],
  ];

  it.each(targets)('maps %o to the level and key the resolver reads', (target, level, key) => {
    expect(levelOf(target)).toBe(level);
    expect(keyOf(target)).toBe(key);
  });

  it('names each target in a sentence', () => {
    expect(targetLabel({ kind: 'global' })).toBe('the global default');
    expect(targetLabel({ kind: 'role', roleId: 'coding' })).toBe('the coding model');
    expect(targetLabel({ kind: 'project', projectPath: '/w' })).toBe('/w');
  });
});

describe('modelItem', () => {
  it('shows price and context as the inline description', () => {
    const item = modelItem(model());
    expect(item.description).toContain('$3.00/M in');
    expect(item.description).toContain('$15.00/M out');
    expect(item.description).toContain('200K context');
    expect(item.description).toContain('reasoning');
    expect(item.description).toContain('tools');
    expect(item.description).toContain('vision');
  });

  it('distinguishes a free model from one whose price nobody published', () => {
    const free = modelItem(
      model({
        pricing: { ...model().pricing, promptPerToken: 0, completionPerToken: 0, isFree: true },
      })
    );
    expect(free.description).toContain('Free');

    const unpublished = modelItem(
      model({
        pricing: {
          ...model().pricing,
          promptPerToken: null,
          completionPerToken: null,
          isFree: false,
        },
      })
    );
    expect(unpublished.description).toContain('Price not published');
    // Never "$0.00" for an unknown price, which would read as free.
    expect(unpublished.description).not.toContain('$0.00');
  });

  it('states a missing context window instead of a blank', () => {
    expect(modelItem(model({ contextLength: null })).description).toContain('context not published');
  });

  it('marks a favourite, and keeps the id available for the write', () => {
    const item = modelItem(model(), { isFavorite: true });
    expect(item.label.startsWith('$(star-full)')).toBe(true);
    expect(item.modelId).toBe('anthropic/claude-sonnet-4');
    expect(item.detail).toContain('anthropic');
  });

  it('falls back to the id when the catalogue named no developer', () => {
    const item = modelItem(model({ developer: null, id: 'mystery-model' }));
    expect(item.detail).toBe('mystery-model');
  });
});

describe('listSummary', () => {
  it('distinguishes a filtered empty result from an absent catalogue', () => {
    expect(listSummary(0, true, 300)).toContain('No model matches');
    expect(listSummary(0, false, 0)).toContain('catalogue is empty');
  });

  it('counts what is shown, against the total when filtered', () => {
    expect(listSummary(12, true, 300)).toBe('12 of 300 models');
    expect(listSummary(300, false, 300)).toBe('300 models');
  });
});

describe('filterChoices', () => {
  it('offers every quick filter plus a way back to the whole list', () => {
    const choices = filterChoices(new Set());
    expect(choices[0]?.key).toBe('none');
    expect(choices[0]?.picked).toBe(true);
    expect(choices).toHaveLength(MODEL_QUICK_FILTERS.length + 1);
    for (const filter of MODEL_QUICK_FILTERS) {
      expect(choices.some((choice) => choice.key === filter)).toBe(true);
    }
  });

  it('marks the filters already applied, so the same prompt removes them', () => {
    const choices = filterChoices(new Set(['coding', 'free']));
    expect(choices.find((choice) => choice.key === 'coding')?.picked).toBe(true);
    expect(choices.find((choice) => choice.key === 'free')?.picked).toBe(true);
    expect(choices.find((choice) => choice.key === 'none')?.picked).toBe(false);
    expect(choices.find((choice) => choice.key === 'vision')?.picked).toBe(false);
  });

  it('shows the rule behind each filter, not a marketing label', () => {
    const coding = filterChoices(new Set()).find((choice) => choice.key === 'coding');
    expect(coding?.description).toContain('tool calling');
  });
});

describe('providerChoice', () => {
  function view(overrides: Partial<ProviderView> = {}): ProviderView {
    return {
      id: 'openrouter',
      label: 'OpenRouter',
      description: 'One API for many models.',
      baseUrl: 'https://openrouter.ai/api/v1',
      enabled: true,
      isActive: true,
      selectable: true,
      authState: 'valid',
      connectionState: 'connected',
      available: true,
      statusMessage: 'Connected.',
      maskedKey: 'sk-or-…a1b2',
      hasStoredKey: true,
      account: null,
      lastConnectedAt: null,
      lastConnectionError: null,
      catalogState: 'ready',
      catalogError: null,
      lastCatalogRefreshAt: null,
      catalogModelCountLabel: '312 models',
      busy: false,
      controls: { apiKey: true, catalog: true, disable: true },
      ...overrides,
    };
  }

  it('marks the active provider and its readiness', () => {
    const choice = providerChoice(view(), true);
    expect(choice.description).toContain('active');
    expect(choice.description).toContain('key stored');
    expect(choice.description).toContain('312 models');
    expect(choice.providerId).toBe('openrouter');
    expect(choice.selectable).toBe(true);
  });

  it('states why a provider cannot be activated rather than hiding it', () => {
    const choice = providerChoice(view({ selectable: false, statusMessage: 'No runtime.' }), false);
    expect(choice.description).toContain('cannot be activated');
    expect(choice.detail).toContain('No runtime.');
    expect(choice.selectable).toBe(false);
  });

  it('never carries the key itself, only the fact that one is stored', () => {
    const choice = providerChoice(view(), true);
    const text = `${choice.label} ${choice.description} ${choice.detail}`;
    expect(text).not.toContain('sk-or-…a1b2');
    expect(text).toContain('key stored');
  });
});

describe('confirmation wording', () => {
  it('names the model and where it was stored', () => {
    expect(selectionConfirmation('Claude Sonnet 4', { kind: 'role', roleId: 'coding' })).toBe(
      'Claude Sonnet 4 is now the coding model.'
    );
  });

  it('says what clearing a level falls back to', () => {
    expect(clearedConfirmation({ kind: 'global' })).toContain('follows the level above it');
  });
});

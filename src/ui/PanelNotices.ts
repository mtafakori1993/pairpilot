/**
 * The one-line messages the AI Providers & Models panel shows above its
 * sections.
 *
 * They are composed on the Host for the same reason every figure is: the panel
 * cannot know what happened. It asked for a catalogue refresh and got a new list
 * of rows; only the Host knows whether that refresh succeeded, failed, or was
 * skipped because an earlier one was still in flight.
 *
 * Two rules hold here:
 *
 *  - **A notice states what was done, not what was intended.** `setSelection`
 *    refuses a model the catalogue does not carry, and its callers pass that
 *    refusal along instead of announcing a selection that was never written.
 *  - **No notice carries a credential.** Nothing here reads the key. The only
 *     key-derived string that reaches the panel is the mask on the card, which
 *     this module never touches.
 */

import { MODEL_ROLES, type SelectionLevel } from '../types/providerConfig';
import type { CatalogRefreshOutcome } from './ManagementController';
import type { ProviderNotice } from './ProviderViewBuilder';

/**
 * What a catalogue refresh did.
 *
 * A failure names the models still on hand, because "the refresh failed" beside
 * a populated Explorer is a very different situation from the same sentence
 * beside an empty one.
 */
export function catalogNotice(outcome: CatalogRefreshOutcome): ProviderNotice {
  switch (outcome.status) {
    case 'refreshed':
      return {
        level: 'info',
        text: `Loaded ${outcome.count} model${outcome.count === 1 ? '' : 's'} from the OpenRouter catalogue.`,
      };
    case 'skipped':
      return {
        level: 'info',
        text: 'A catalogue refresh was already running, so this one was not started.',
      };
    case 'failed':
      return {
        level: 'warning',
        text:
          outcome.count > 0
            ? `The catalogue could not be refreshed: ${outcome.error} The ${outcome.count} models already loaded are still listed, and are marked as out of date.`
            : `The catalogue could not be loaded: ${outcome.error}`,
      };
  }
}

/**
 * How a selection level is named inside a sentence.
 *
 * Deliberately not the table's own labels: a row reads "This project", while a
 * sentence needs "this project". Keeping the sentence forms here means the
 * vocabulary lives in one place rather than being rebuilt at each call site.
 */
export function destinationLabel(level: SelectionLevel, key: string | null): string {
  switch (level) {
    case 'global':
      return 'the global default';
    case 'project':
      return 'this project';
    case 'role': {
      const role = MODEL_ROLES.find((entry) => entry.id === key);
      return `the ${role ? role.label : (key ?? 'unknown')} role`;
    }
    case 'task':
      return `the ${key ?? 'unknown'} task`;
  }
}

/** The selection was written, so the panel can say where to. */
export function selectionSetNotice(
  modelName: string,
  level: SelectionLevel,
  key: string | null
): ProviderNotice {
  return {
    level: 'info',
    text: `${modelName} is now used for ${destinationLabel(level, key)}.`,
  };
}

/**
 * A level was cleared.
 *
 * The second sentence is the useful one: it says what happens *next*, because a
 * cleared level is not "no model" — it is the next level down.
 */
export function selectionClearedNotice(level: SelectionLevel, key: string | null): ProviderNotice {
  return {
    level: 'info',
    text: `Cleared ${destinationLabel(level, key)}. The next request falls back to the next level that is set, or to the provider's own default.`,
  };
}

/**
 * ModelPicker — the native `showQuickPick` flow for choosing a model.
 *
 * This is the piece the spec asked for: a provider and a catalogue of several
 * hundred models are configured through the prompts VS Code already has, not
 * through a Webview a few hundred pixels wide. The flow is
 *
 *     provider  →  what for?  →  filters  →  the list  →  confirm
 *
 * and it is *linear*, not a panel: every step either moves forward, goes back,
 * or ends. Cancelling any step ends the flow with no write at all, because a
 * half-configured model is worse than an untouched one.
 *
 * Four rules are enforced here rather than by convention:
 *
 *  1. **The catalogue is never rendered whole.** The list is one `showQuickPick`
 *     over rows filtered by the current query; `showQuickPick` does the
 *     search-as-you-type itself. No array of every model is ever handed to the
 *     API surface or serialised anywhere.
 *  2. **Choosing is a write through `ManagementController.setSelection`**, which
 *     already refuses a model the catalogue does not have. There is no second
 *     validation path, so the two can never disagree.
 *  3. **Every prompt can be cancelled**, and cancellation is propagated as
 *     `undefined` to the caller rather than treated as "nothing chosen, clear
 *     it" — an Esc is not a decision, and treating it as one is how a model
 *     gets cleared by accident.
 *  4. **State lives in this extension's host, not in the picker.** The filters
 *     and the chosen target are local to one run of the flow; the selection is
 *     read back from `ModelSelectionService` so the list marks what is already
 *     set instead of starting from nothing each time.
 *
 * Everything here talks to `vscode.window`, so it is exercised by the real-host
 * suite. The *data* it shows is built by `ConfigPrompts`, which is pure and
 * unit-tested separately.
 */

import * as vscode from 'vscode';
import {
  automaticItem,
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
  type ModelListItem,
  type SelectionTarget,
} from './ConfigPrompts';
import { defaultModelQuery, selectModels } from '../models/ModelSearch';
import type { ManagementController } from '../ui/ManagementController';
import type { ModelQuickFilter, ModelQuery } from '../types/model';

/** What a completed flow did, so the caller can report it truthfully. */
export type ModelPickOutcome =
  | { kind: 'selected'; modelId: string; target: SelectionTarget }
  | { kind: 'cleared'; target: SelectionTarget }
  /** The developer pressed Escape, or closed a prompt. Nothing was written. */
  | { kind: 'cancelled' }
  /** A step refused to proceed and said why. Nothing was written. */
  | { kind: 'refused'; reason: string };

/** A quick-pick row that also carries its `ModelListItem` payload. */
interface ModelRowItem extends vscode.QuickPickItem {
  readonly row: ModelListItem;
}

interface AutomaticRowItem extends vscode.QuickPickItem {
  readonly automatic: true;
}

/** Rows the model list can return. */
type ListPick = ModelRowItem | AutomaticRowItem;

export class ModelPicker {
  constructor(private readonly management: ManagementController) {}

  /**
   * The full flow, from "which thing are you configuring" to a written choice.
   *
   * A `target` skips the category step, which is what the `Select Coding Model`
   * (and the other role-specific) commands do: the developer has already said
   * what they are configuring, and asking again would be a step that only
   * repeats the command's own name.
   */
  async run(options: { target?: SelectionTarget } = {}): Promise<ModelPickOutcome> {
    const target = options.target ?? (await this.askTarget());
    if (target === undefined) {
      return { kind: 'cancelled' };
    }

    const query = defaultModelQuery();
    // One mutable filter set for this run of the flow. It is reopened as often
    // as the developer likes, and every reopening shows the current filters
    // ticked — that is how they are removed again.
    const active = new Set<ModelQuickFilter>();

    for (;;) {
      const filters = await this.askFilters(active);
      if (filters === undefined) {
        return { kind: 'cancelled' };
      }
      replaceSet(active, filters);

      const pick = await this.askModel(target, { ...query, quickFilters: [...active] });
      if (pick === undefined) {
        return { kind: 'cancelled' };
      }

      if (pick.kind === 'back') {
        // "Change filters" — loop, keeping the target.
        continue;
      }
      if (pick.kind === 'automatic') {
        const cleared = await this.management.setSelection(levelOf(target), keyOf(target), null);
        if (!cleared) {
          return { kind: 'refused', reason: 'The stored choice could not be cleared.' };
        }
        const message = clearedConfirmation(target);
        const open = 'Choose a model';
        const answer = await vscode.window.showInformationMessage(`PairPilot: ${message}`, open);
        if (answer === open) {
          return this.run({ target });
        }
        return { kind: 'cleared', target };
      }

      const confirmed = await this.confirm(target, pick.row);
      if (confirmed === undefined) {
        return { kind: 'cancelled' };
      }
      if (!confirmed) {
        continue;
      }

      const written = await this.management.setSelection(
        levelOf(target),
        keyOf(target),
        pick.row.modelId
      );
      if (!written) {
        // `setSelection` has already shown why (a model missing from the
        // catalogue); saying it twice would be noise.
        return { kind: 'refused', reason: pick.row.modelId };
      }

      void vscode.window.showInformationMessage(
        `PairPilot: ${selectionConfirmation(pick.row.label.replace('$(star-full) ', ''), target)}`
      );
      return { kind: 'selected', modelId: pick.row.modelId, target };
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Provider                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Choose which provider receives turns.
   *
   * A provider's key is *not* collected here. Connecting is its own command,
   * because entering a credential and switching a backend are two decisions a
   * developer may want minutes apart — and because a picker that asks for a key
   * would need the key in its own state.
   */
  async chooseProvider(): Promise<{ kind: 'selected'; providerId: string } | { kind: 'cancelled' }> {
    const providers = this.management.providersForPicker();
    const activeId = this.management.currentProviderId();

    const items = providers.map((view) => {
      const choice = providerChoice(view, view.id === activeId);
      return {
        label: choice.label,
        description: choice.description,
        detail: choice.detail,
        providerId: view.id,
        selectable: choice.selectable,
      };
    });

    const picked = await vscode.window.showQuickPick(items, {
      title: 'PairPilot: Select Provider',
      placeHolder: 'Which backend should receive your turns?',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) {
      return { kind: 'cancelled' };
    }
    if (!picked.selectable) {
      void vscode.window.showWarningMessage(
        'PairPilot: that provider cannot be activated in this build.'
      );
      return { kind: 'cancelled' };
    }

    const switched = await this.management.selectProvider(picked.providerId);
    if (!switched) {
      return { kind: 'cancelled' };
    }
    void vscode.window.showInformationMessage(`PairPilot: turns now go to ${picked.label}.`);
    return { kind: 'selected', providerId: picked.providerId };
  }

  /* ---------------------------------------------------------------------- */
  /* Steps                                                                  */
  /* ---------------------------------------------------------------------- */

  /** Step 1b: what is the model for? */
  private async askTarget(): Promise<SelectionTarget | undefined> {
    const items = categoryChoices(this.workspaceRoot()).map((choice) => ({
      label: choice.label,
      description: choice.description,
      detail: choice.detail,
      choice,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      title: 'PairPilot: Select Model',
      placeHolder: 'What is this model for?',
      matchOnDescription: true,
    });
    return picked?.choice.target;
  }

  /**
   * Step 2: filters, as a multi-select.
   *
   * A `canPickMany` prompt with the current set ticked. Choosing only "No
   * filter" clears everything; choosing "No filter" alongside a filter is
   * treated as clearing, because the row says "No filter" and honouring it
   * alongside a contradiction would be a rule nobody can see.
   */
  private async askFilters(active: ReadonlySet<ModelQuickFilter>): Promise<ModelQuickFilter[] | undefined> {
    const items = filterChoices(active).map((choice) => ({
      label: choice.label,
      description: choice.description,
      picked: choice.picked,
      filter: choice.key,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      title: 'PairPilot: Narrow the list (optional)',
      placeHolder:
        active.size === 0
          ? 'Enter to browse every model, or choose filters first'
          : `${active.size} filter(s) applied — untick to remove, Enter to keep`,
      canPickMany: true,
      matchOnDescription: true,
    });
    if (picked === undefined) {
      return undefined;
    }
    if (picked.some((item) => item.filter === 'none')) {
      return [];
    }
    return picked.map((item) => item.filter).filter((key): key is ModelQuickFilter => key !== 'none');
  }

  /**
   * Step 3: the list.
   *
   * Three outcomes: a model, "Automatic", or go back to the filters. The rows
   * are filtered once, here, and handed to `showQuickPick` as they are — the
   * prompt's own search narrows them further without another round trip.
   */
  private async askModel(
    target: SelectionTarget,
    query: ModelQuery
  ): Promise<
    { kind: 'model'; row: ModelListItem } | { kind: 'automatic' } | { kind: 'back' } | undefined
  > {
    const models = this.management.catalog.list();
    if (models.length === 0) {
      const refresh = 'Refresh the catalogue';
      const answer = await vscode.window.showWarningMessage(
        'PairPilot: the model catalogue is empty, so there is nothing to choose from. It is fetched from the provider once a key is stored and verified.',
        refresh
      );
      if (answer === refresh) {
        await this.management.refreshCatalog({ announce: true });
        return this.askModel(target, query);
      }
      void vscode.window.showWarningMessage('PairPilot: no model was chosen.');
      return { kind: 'back' };
    }

    const favorites = this.management.catalog.favoritesSet();
    const matched = selectModels(models, query, { favorites });

    // The current choice at this level, so it can be marked rather than
    // duplicated into the list.
    const current = this.management.selectionAt(levelOf(target), keyOf(target));
    const inherited = this.inheritedLabel(target);

    const items: ListPick[] = [
      asAutomatic(automaticItem(target, inherited)),
      { label: '', kind: vscode.QuickPickItemKind.Separator } as unknown as ListPick,
      ...matched.map(
        (model): ModelRowItem => ({
          label: markCurrent(modelItem(model, { isFavorite: favorites.has(model.id) }).label, model.id, current?.modelId ?? null),
          description: modelItem(model, { isFavorite: favorites.has(model.id) }).description,
          detail: modelItem(model, { isFavorite: favorites.has(model.id) }).detail,
          row: modelItem(model, { isFavorite: favorites.has(model.id) }),
        })
      ),
      { label: '', kind: vscode.QuickPickItemKind.Separator } as unknown as ListPick,
      {
        label: '$(filter) Change filters…',
        description: listSummary(matched.length, query.quickFilters.length > 0, models.length),
        back: true,
      } as unknown as ListPick,
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: `PairPilot: Choose the model for ${targetLabel(target)}`,
      placeHolder: 'Type to search by name, id or developer',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (picked === undefined) {
      return undefined;
    }
    if ('automatic' in picked && picked.automatic === true) {
      return { kind: 'automatic' };
    }
    if ('back' in picked) {
      return { kind: 'back' };
    }
    return { kind: 'model', row: (picked as ModelRowItem).row };
  }

  /**
   * Step 4: confirm, with the facts that matter in front of the developer.
   *
   * A modal is used on purpose. It is the one point where a mis-key would write
   * a change silently, and a modal makes the outcome a deliberate press.
   */
  private async confirm(target: SelectionTarget, row: ModelListItem): Promise<boolean | undefined> {
    const CHOOSE = 'Use this model';
    const answer = await vscode.window.showInformationMessage(
      `${row.label.replace('$(star-full) ', '')} — ${row.description}\n\nSet as ${targetLabel(target)}?`,
      { modal: true, detail: row.detail },
      CHOOSE
    );
    if (answer === undefined) {
      return undefined;
    }
    return answer === CHOOSE;
  }

  /**
   * How the level above names itself, for the "Automatic" row.
   *
   * Read through the resolver so the sentence is true rather than reasoned
   * about: this asks exactly what the next turn would use.
   */
  private inheritedLabel(target: SelectionTarget): string | null {
    const projectPath = this.workspaceRoot();
    const resolved =
      target.kind === 'role'
        ? this.management.resolveFor({ roleId: target.roleId, projectPath })
        : this.management.resolveFor({ projectPath });
    if (resolved.modelId === null) {
      return null;
    }
    return `${resolved.sourceLabel} (${resolved.modelId})`;
  }

  private workspaceRoot(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return null;
    }
    return folders[0]?.uri.fsPath ?? null;
  }
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                             */
/* -------------------------------------------------------------------------- */

function asAutomatic(item: ReturnType<typeof automaticItem>): AutomaticRowItem {
  return {
    label: item.label,
    description: item.description,
    detail: item.detail,
    automatic: true,
  };
}

/** Mark the model already set at this level, so the list answers "which one?" */
function markCurrent(label: string, modelId: string, currentId: string | null): string {
  return modelId === currentId ? `$(check) ${label}` : label;
}

function replaceSet(target: Set<ModelQuickFilter>, next: readonly ModelQuickFilter[]): void {
  target.clear();
  for (const filter of next) {
    target.add(filter);
  }
}

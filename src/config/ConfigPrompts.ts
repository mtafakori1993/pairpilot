/**
 * ConfigPrompts — the native VS Code prompt shapes for provider and model
 * configuration, kept as pure data so they can be tested without an editor.
 *
 * The provider and model screens moved out of the sidebar because a Webview a
 * few hundred pixels wide is the wrong place for a catalogue of several
 * hundred models. What replaced them is the UI VS Code already has:
 *
 *     provider  →  what are you choosing for?  →  filter  →  search  →  confirm
 *
 * Every step below is a `showQuickPick`, a `showInputBox` or a notification.
 * None of it is a Webview, and no API key ever passes through a Webview at all —
 * `showInputBox({ password: true })` collects it in the Extension Host and
 * `SecretManager` writes it to `SecretStorage`.
 *
 * Two things live here rather than in the command file:
 *
 *  - **Formatting.** A `QuickPickItem`'s description and detail are built by the
 *    same formatters the Cost and Providers views use, so a price cannot read
 *    `$0.00` in one place and `Not provided` in another.
 *  - **The shape of each step.** Writing the steps as data means a test can pin
 *    the order, and can assert that the catalogue is never handed to a prompt in
 *    full — which is the whole reason this moved out of the sidebar.
 *
 * The list of models is built one item at a time by the flow, from however many
 * models the filters let through. Nothing here ever holds the whole catalogue.
 */

import { formatPricePerMillion, formatTokensCompact } from '../models/format';
import {
  MODEL_QUICK_FILTERS,
  MODEL_QUICK_FILTER_RULES,
  type ModelMetadata,
  type ModelQuickFilter,
} from '../types/model';
import { MODEL_ROLES, type ModelRoleDescriptor, type ModelTaskId, type SelectionLevel } from '../types/providerConfig';
import type { ProviderView } from '../types/providerConfig';

/* -------------------------------------------------------------------------- */
/* What is being configured                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The thing a model choice is stored against.
 *
 * These map exactly onto `ModelSelectionService`'s four levels, so a choice
 * made here and a turn's `resolve()` cannot disagree about where a value came
 * from. `task` is absent deliberately: nothing in this build sets a per-task
 * override, and offering a level the resolver would then ignore is worse than
 * not offering it.
 */
export type SelectionTarget =
  /** Chosen explicitly for one project, beating the global default. */
  | { kind: 'project'; projectPath: string }
  /** Applied to every project that has no project choice of its own. */
  | { kind: 'global' }
  /** A workflow role, beating project and global. */
  | { kind: 'role'; roleId: ModelTaskId };

export interface CategoryChoice {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly detail: string;
  readonly target: SelectionTarget;
}

/**
 * The order the roles appear in, which is the order the workflow runs them.
 *
 * `MODEL_ROLES` is declared in a designer's order; a developer configuring
 * models is thinking about the next turn, so planning comes first, then coding,
 * then review. The remaining roles follow in their declared order. Every role
 * appears exactly once — a role omitted here would be a role that can never be
 * configured, which is why the list is completed from `MODEL_ROLES` rather than
 * written out in full.
 */
const WORKFLOW_ORDER: readonly ModelTaskId[] = [
  'architecture-design',
  'coding',
  'code-review',
  'product-discovery',
];

function orderedRoles(): ModelRoleDescriptor[] {
  const byId = new Map(MODEL_ROLES.map((role) => [role.id, role]));
  const ordered: ModelRoleDescriptor[] = [];
  for (const id of WORKFLOW_ORDER) {
    const role = byId.get(id);
    if (role) {
      ordered.push(role);
      byId.delete(id);
    }
  }
  for (const role of MODEL_ROLES) {
    if (byId.has(role.id)) {
      ordered.push(role);
      byId.delete(role.id);
    }
  }
  return ordered;
}

/**
 * What a role is *for*, in the words a developer picks by.
 *
 * The declared labels are kept (`Coding`, `Code Review`) because they are the
 * vocabulary the rest of the extension uses. Where a role is also called
 * something else in the product — planning is `architecture-design`, and the
 * advisor *is* the code reviewer — that second name is added here rather than
 * becoming a second role in the list.
 */
function rolePlainName(role: ModelRoleDescriptor): string {
  switch (role.id) {
    case 'architecture-design':
      return 'Planning';
    case 'code-review':
      return 'Code review & Engineering Advisor';
    case 'product-discovery':
      return 'Product discovery';
    case 'simple-questions':
      return 'Simple questions';
    case 'documentation':
      return 'Documentation';
    case 'large-repo-analysis':
      return 'Large repository analysis';
    case 'coding':
      return 'Coding';
  }
}

/**
 * The second step: what is this model for?
 *
 * A role with no consumer in this build is shown anyway. Hiding it would make
 * the remaining list look complete, and a developer who picked a model for
 * "documentation" and saw it silently ignored is exactly the confusion the
 * role's `detail` line exists to prevent.
 */
export function categoryChoices(projectPath: string | null): CategoryChoice[] {
  const choices: CategoryChoice[] = [];

  for (const role of orderedRoles()) {
    const uses =
      role.consumers.length > 0
        ? `Used by: ${role.consumers.join(', ')}.`
        : 'Nothing in this build reads this role yet. The choice is stored for when something does.';
    choices.push({
      key: `role:${role.id}`,
      label: rolePlainName(role),
      description: role.label,
      detail: `${role.description} ${uses}`,
      target: { kind: 'role', roleId: role.id },
    });
  }

  choices.push({
    key: 'global',
    label: 'Every turn (global default)',
    description: 'Global default',
    detail:
      'Used by any role, and any project, that has no more specific choice. This is what most people mean by "my model".',
    target: { kind: 'global' },
  });

  if (projectPath !== null) {
    choices.push({
      key: 'project',
      label: `This project only`,
      description: projectPath,
      detail:
        'Overrides the global default for this workspace, but a role set above still wins. Useful when one repository needs a larger context than the rest.',
      target: { kind: 'project', projectPath },
    });
  }

  return choices;
}

/** The level this target writes to. */
export function levelOf(target: SelectionTarget): SelectionLevel {
  switch (target.kind) {
    case 'project':
      return 'project';
    case 'global':
      return 'global';
    case 'role':
      return 'role';
  }
}

/** The key this target writes under; `null` for the global level. */
export function keyOf(target: SelectionTarget): string | null {
  switch (target.kind) {
    case 'project':
      return target.projectPath;
    case 'global':
      return null;
    case 'role':
      return target.roleId;
  }
}

/** How the chosen target is named back to the developer. */
export function targetLabel(target: SelectionTarget): string {
  switch (target.kind) {
    case 'project':
      return target.projectPath;
    case 'global':
      return 'the global default';
    case 'role': {
      const role = MODEL_ROLES.find((entry) => entry.id === target.roleId);
      return role ? `the ${rolePlainName(role).toLowerCase()} model` : `the ${target.roleId} model`;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Model list                                                                 */
/* -------------------------------------------------------------------------- */

/** The row that clears a selection, so inheriting is always reachable. */
export interface AutomaticItem {
  readonly kind: 'automatic';
  readonly label: string;
  readonly description: string;
  readonly detail: string;
}

/** One selectable model. */
export interface ModelListItem {
  readonly kind: 'model';
  readonly label: string;
  readonly description: string;
  readonly detail: string;
  readonly modelId: string;
}

export type ModelListRow = AutomaticItem | ModelListItem;

/** A spacing row, so the "Automatic" escape sits apart from the catalogue. */
export interface SeparatorRow {
  readonly kind: 'separator';
  readonly label: string;
}

export type ModelListEntry = ModelListRow | SeparatorRow;

export function separator(label = ''): SeparatorRow {
  return { kind: 'separator', label };
}

/**
 * The first row of every model list: "stop choosing".
 *
 * This is what the spec means by automatic selection, and it is a *row in the
 * list* rather than a button elsewhere because that is the moment the developer
 * wants it — while looking at models and deciding they do not want to pick.
 *
 * It says what the choice falls back to, from the resolver, so "Automatic" is
 * never a mystery: either the level above, or the provider's own default.
 */
export function automaticItem(target: SelectionTarget, inherited: string | null): AutomaticItem {
  const fallsBack =
    inherited !== null
      ? `Will use ${inherited} instead.`
      : `Will use the provider's own default model.`;
  return {
    kind: 'automatic',
    label: '$(sync) Automatic',
    description: 'Clear this choice',
    detail: `${targetLabel(target)} will stop being set. ${fallsBack}`,
  };
}

/**
 * One model, as a prompt row.
 *
 * Shorter than the sidebar's row on purpose: `QuickPick` renders `description`
 * inline and `detail` under the focused row, and the sidebar's version (four
 * price labels, capability chips, selected-at list) wraps into unreadability at
 * prompt width. What is kept is what a choice is made on — price, context,
 * vision, and free/paid.
 */
export function modelItem(model: ModelMetadata, options: { isFavorite?: boolean } = {}): ModelListItem {
  const prompt = formatPricePerMillion(model.pricing.promptPerToken);
  const completion = formatPricePerMillion(model.pricing.completionPerToken);
  const priced = model.pricing.promptPerToken !== null || model.pricing.completionPerToken !== null;

  const price = model.pricing.isFree
    ? 'Free'
    : priced
      ? `${prompt} in · ${completion} out`
      : 'Price not published';

  const context =
    model.contextLength === null
      ? 'context not published'
      : `${formatTokensCompact(model.contextLength)} context`;

  const bits = [price, context];
  if (model.capabilities.reasoning) {
    bits.push('reasoning');
  }
  if (model.capabilities.toolCalling) {
    bits.push('tools');
  }
  if (model.capabilities.inputModalities.includes('image')) {
    bits.push('vision');
  }

  return {
    kind: 'model',
    label: `${options.isFavorite === true ? '$(star-full) ' : ''}${model.name}`,
    description: bits.join(' · '),
    detail: model.developer === null ? model.id : `${model.developer} · ${model.id}`,
    modelId: model.id,
  };
}

/** The counts line a model list ends on, so "no results" is distinguishable. */
export function listSummary(shown: number, filtered: boolean, total: number): string {
  if (shown === 0) {
    return filtered
      ? 'No model matches this filter. Choose a different filter, or search for a name.'
      : 'The catalogue is empty. Refresh it from the Command Palette.';
  }
  return filtered ? `${shown} of ${total} models` : `${shown} models`;
}

/* -------------------------------------------------------------------------- */
/* Filter step                                                                */
/* -------------------------------------------------------------------------- */

/** The filter picker's rows. Always includes a way back to the whole list. */
export interface FilterChoice {
  readonly key: ModelQuickFilter | 'none';
  readonly label: string;
  readonly description: string;
  readonly picked: boolean;
}

/**
 * The filter step, as a multi-select.
 *
 * Any combination may be chosen, and the current combination is shown already
 * ticked — so opening the step again is how a developer *removes* a filter.
 * There is no separate "clear" action to discover, and no state to get stuck in.
 */
export function filterChoices(active: ReadonlySet<ModelQuickFilter>): FilterChoice[] {
  return [
    {
      key: 'none',
      label: '$(list-unordered) No filter',
      description: active.size === 0 ? 'Showing every model in the catalogue.' : 'Show every model in the catalogue.',
      picked: active.size === 0,
    },
    ...MODEL_QUICK_FILTERS.map((filter) => ({
      key: filter,
      label: `${filterIcon(filter)} ${filterLabel(filter)}`,
      description: MODEL_QUICK_FILTER_RULES[filter],
      picked: active.has(filter),
    })),
  ];
}

function filterLabel(filter: ModelQuickFilter): string {
  switch (filter) {
    case 'coding':
      return 'Good for coding';
    case 'reasoning':
      return 'Reasoning';
    case 'low-cost':
      return 'Low cost';
    case 'large-context':
      return 'Large context';
    case 'vision':
      return 'Vision';
    case 'audio':
      return 'Audio';
    case 'tool-calling':
      return 'Tool calling';
    case 'structured-output':
      return 'Structured output';
    case 'free':
      return 'Free';
  }
}

function filterIcon(filter: ModelQuickFilter): string {
  switch (filter) {
    case 'coding':
      return '$(code)';
    case 'reasoning':
      return '$(lightbulb)';
    case 'low-cost':
      return '$(credit-card)';
    case 'large-context':
      return '$(library)';
    case 'vision':
      return '$(eye)';
    case 'audio':
      return '$(unmute)';
    case 'tool-calling':
      return '$(tools)';
    case 'structured-output':
      return '$(json)';
    case 'free':
      return '$(gift)';
  }
}

/* -------------------------------------------------------------------------- */
/* Provider list                                                              */
/* -------------------------------------------------------------------------- */

export interface ProviderChoice {
  readonly label: string;
  readonly description: string;
  readonly detail: string;
  readonly providerId: ProviderView['id'];
  /** False when this provider cannot be activated in this build. */
  readonly selectable: boolean;
}

/**
 * One provider row, with its readiness stated rather than implied.
 *
 * Built from `ProviderView`, which is already the credential-free description
 * of a provider — the same object the sidebar used — so there is no second
 * path that could format a provider differently in two places.
 */
export function providerChoice(view: ProviderView, isActive: boolean): ProviderChoice {
  const marks: string[] = [];
  if (isActive) {
    marks.push('$(check) active');
  }
  if (!view.selectable) {
    marks.push('$(warning) cannot be activated here');
  }
  if (view.hasStoredKey) {
    marks.push('$(key) key stored');
  }
  if (view.catalogModelCountLabel !== null) {
    marks.push(view.catalogModelCountLabel);
  }

  return {
    label: `${view.selectable ? '$(circuit-board)' : '$(warning)'} ${view.label}`,
    description: marks.join(' · '),
    detail: [view.description, view.statusMessage].filter((part) => part.length > 0).join(' '),
    providerId: view.id,
    selectable: view.selectable,
  };
}

/* -------------------------------------------------------------------------- */
/* Confirmation wording                                                       */
/* -------------------------------------------------------------------------- */

/** What a successful selection reports. */
export function selectionConfirmation(modelName: string, target: SelectionTarget): string {
  return `${modelName} is now ${targetLabel(target)}.`;
}

/** What a cleared selection reports. */
export function clearedConfirmation(target: SelectionTarget): string {
  return `${targetLabel(target)} is no longer set, so it follows the level above it again.`;
}

/**
 * Why choosing a provider is a deliberate act.
 *
 * It is the decision that controls whether a request leaves the machine, so it
 * is never made on the developer's behalf.
 */
export const PROVIDER_CHOICE_NOTE =
  'PairPilot never changes this on its own. Choosing a remote provider is what decides whether your code leaves this machine.';

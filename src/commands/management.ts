/**
 * Provider, model and cost commands.
 *
 * Kept apart from the workflow commands because these belong to the management
 * screens rather than to the control loop, and because every one of them either
 * touches a credential or writes provider state — a small surface that is easier
 * to audit when it stands alone.
 *
 * Each command is written to be safe when invoked from the palette with no
 * context at all: none of them assumes a panel is open, a key is stored, or a
 * catalogue has been fetched.
 */

import * as vscode from 'vscode';
import { describeError } from '../core/errors';
import { ModelPicker } from '../config/ModelPicker';
import type { SelectionTarget } from '../config/ConfigPrompts';
import type { ModelTaskId } from '../types/providerConfig';
import type { ManagementController } from '../ui/ManagementController';
import type { CostDashboardProvider } from '../ui/CostDashboardProvider';

export interface ManagementCommandDeps {
  management: ManagementController;
  costView: CostDashboardProvider;
  /** Repaints the status bar after anything that changes its state. */
  refreshStatusBar(): void;
  logger: { info(m: string): void; warn(m: string): void; error(m: string, e?: unknown): void };
}

export function registerManagementCommands(
  context: vscode.ExtensionContext,
  deps: ManagementCommandDeps
): void {
  const register = (id: string, handler: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await handler(...args);
        } catch (error) {
          deps.logger.error(`Command "${id}" failed: ${describeError(error)}`, error);
          void vscode.window.showErrorMessage(`PairPilot: ${describeError(error)}`);
        }
      })
    );
  };

  register('pairpilot.showCosts', async () => {
    await deps.costView.reveal();
  });

  register('pairpilot.setApiKey', async () => {
    await deps.management.promptForApiKey();
  });

  register('pairpilot.testConnection', async () => {
    await deps.management.testConnection({ announce: true });
  });

  register('pairpilot.disconnectProvider', async () => {
    // Confirmed here because the palette has no panel to ask first.
    await deps.management.disconnect({ confirm: true });
  });

  register('pairpilot.clearUsageHistory', async () => {
    await deps.management.clearUsageHistory();
  });

  register('pairpilot.openProviderSettings', async () => {
    // A filtered settings query rather than a specific key, because the screen
    // this command is offered from covers several settings and opening exactly
    // one of them would hide the rest.
    await vscode.commands.executeCommand('workbench.action.openSettings', 'pairpilot.providers');
  });

  register('pairpilot.openKeyPage', async () => {
    // A constant URL, opened by the host at the developer's request. Nothing
    // here takes an address from anywhere else.
    await vscode.env.openExternal(vscode.Uri.parse('https://openrouter.ai/keys'));
  });

  /* ------------------------------------------------------------------------ */
  /* Native provider and model selection                                       */
  /* ------------------------------------------------------------------------ */

  const picker = new ModelPicker(deps.management);

  /**
   * The status bar's repaint runs after every selection command, not just the
   * ones that go through `modelPicker`: switching provider changes the same
   * line, and a status item that is right until the one case somebody forgets
   * is worse than none.
   */
  const chooseModel = async (target?: SelectionTarget): Promise<void> => {
    try {
      await picker.run({ target });
    } finally {
      deps.refreshStatusBar();
    }
  };

  const roleTarget = (roleId: ModelTaskId): SelectionTarget => ({ kind: 'role', roleId });

  register('pairpilot.selectProvider', async () => {
    try {
      await picker.chooseProvider();
    } finally {
      deps.refreshStatusBar();
    }
  });

  register('pairpilot.selectModel', async () => {
    await chooseModel();
  });

  register('pairpilot.selectGlobalModel', async () => {
    await chooseModel({ kind: 'global' });
  });

  register('pairpilot.selectPlanningModel', async () => {
    await chooseModel(roleTarget('architecture-design'));
  });

  register('pairpilot.selectCodingModel', async () => {
    await chooseModel(roleTarget('coding'));
  });

  register('pairpilot.selectReviewModel', async () => {
    await chooseModel(roleTarget('code-review'));
  });

  register('pairpilot.selectAdvisorModel', async () => {
    // The Engineering Advisor *is* the code-review consumer, so this command
    // exists for discoverability rather than as a fourth destination: it must
    // set the same role the review turn reads, or the two would disagree.
    await chooseModel(roleTarget('code-review'));
  });

  register('pairpilot.selectProjectModel', async () => {
    const projectPath = deps.management.workspaceRootPath();
    if (projectPath === null) {
      void vscode.window.showInformationMessage(
        'PairPilot: open a folder first. A project model applies to one workspace.'
      );
      return;
    }
    await chooseModel({ kind: 'project', projectPath });
  });

  register('pairpilot.refreshModelCatalog', async () => {
    await deps.management.refreshCatalog({ announce: true });
    deps.refreshStatusBar();
  });
}

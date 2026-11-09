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
import type { ManagementController } from '../ui/ManagementController';
import type { ProviderManagementProvider } from '../ui/ProviderManagementProvider';
import type { CostDashboardProvider } from '../ui/CostDashboardProvider';

export interface ManagementCommandDeps {
  management: ManagementController;
  providersView: ProviderManagementProvider;
  costView: CostDashboardProvider;
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

  register('pairpilot.showProviders', async () => {
    await deps.providersView.reveal();
  });

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

  register('pairpilot.refreshModelCatalog', async () => {
    await deps.management.refreshCatalog({ announce: true });
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
}

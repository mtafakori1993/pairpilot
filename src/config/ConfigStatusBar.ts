/**
 * ConfigStatusBar — the one-line provider/model indicator in the status bar.
 *
 * The sidebar used to spend a whole screen on "which provider, which model".
 * Most of the time the answer is a single sentence, and a sentence is exactly
 * what the status bar is for: visible without being opened, and one click away
 * from changing it.
 *
 * What it shows is deliberately *not* the resolved model of the next turn. It
 * shows what is configured at the global level, plus the active provider,
 * because a status item that silently changes with the role of whatever turn
 * happens to run is an item a developer cannot learn. The full provenance
 * ("which level decided this") is a hover, where there is room for it.
 *
 * The item is created and disposed with the extension, and every update is a
 * pure function of state the controller already owns — no polling, no timer.
 */

import * as vscode from 'vscode';
import type { ManagementController } from '../ui/ManagementController';

/** The command the item runs when clicked. Registered beside the others. */
export const STATUS_BAR_COMMAND = 'pairpilot.selectModel';

export class ConfigStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private disposed = false;

  constructor(private readonly management: ManagementController) {
    // Right-hand side, with a low priority so it sits among the other
    // extension items rather than pushing the language mode around.
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    this.item.command = STATUS_BAR_COMMAND;
    this.item.name = 'PairPilot provider and model';
    this.render();
    this.item.show();
  }

  /** Re-read the state and repaint. Cheap enough to call on every change. */
  refresh(): void {
    if (this.disposed) {
      return;
    }
    this.render();
  }

  private render(): void {
    const activeId = this.management.currentProviderId();
    const providers = this.management.providersForPicker();
    const provider = providers.find((entry) => entry.id === activeId);
    const providerLabel = provider ? provider.label : activeId;

    const globalChoice = this.management.selectionAt('global', null);
    const modelId = globalChoice?.modelId ?? null;
    const modelName =
      modelId === null
        ? null
        : (this.management.catalog.get(modelId)?.name ?? modelId);

    // Compact: provider, then the model when one is set. Never a bare "$(mute)"
    // or an empty segment — an empty status item reads as a broken one.
    if (modelName === null) {
      this.item.text = `$(circuit-board) ${providerLabel} · automatic`;
    } else {
      this.item.text = `$(circuit-board) ${providerLabel} · $(symbol-method) ${modelName}`;
    }

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**PairPilot**\n\n`);
    tooltip.appendMarkdown(`Provider: ${providerLabel}\n\n`);
    if (provider) {
      tooltip.appendMarkdown(`${provider.statusMessage}\n\n`);
    }

    const projectPath = this.management.workspaceRootPath();
    const coding = this.management.resolveFor({ roleId: 'coding', projectPath });
    tooltip.appendMarkdown(
      `Coding turns use **${coding.modelId === null ? 'the provider default' : coding.modelId}** (${coding.sourceLabel}).\n\n`
    );
    tooltip.appendMarkdown('Click to choose a model, or use the Command Palette.');
    tooltip.isTrusted = false;
    this.item.tooltip = tooltip;

    this.item.accessibilityInformation = {
      label: `PairPilot: ${providerLabel}, model ${modelName ?? 'automatic'}`,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.item.dispose();
  }
}

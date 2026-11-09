/**
 * commands — the command palette and view-title actions.
 *
 * Each command re-checks the state machine rather than trusting that it was only
 * offered when legal. A command can be invoked from the palette at any moment,
 * so "the button was disabled" is not a guarantee the Extension Host can rely on.
 */

import * as vscode from 'vscode';
import { describeError } from '../core/errors';
import type { Orchestrator } from '../core/Orchestrator';
import type { SessionStore } from '../storage/SessionStore';
import type { PairPilotProvider } from '../ui/PairPilotProvider';
import type { WorkspaceContext } from '../context/WorkspaceContext';

export interface CommandDeps {
  orchestrator: Orchestrator;
  store: SessionStore;
  provider: PairPilotProvider;
  logger: { info(m: string): void; warn(m: string): void; error(m: string, e?: unknown): void };
  getWorkspace(): WorkspaceContext | null;
  checkRuntime(): Promise<void>;
}

export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  const register = (id: string, handler: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await handler(...args);
        } catch (error) {
          deps.logger.error(`Command "${id}" failed: ${describeError(error)}`, error);
          void vscode.window.showErrorMessage(`PairPilot: ${describeError(error)}`);
        } finally {
          deps.provider.refresh();
        }
      })
    );
  };

  register('pairpilot.focus', async () => {
    await deps.provider.reveal();
  });

  register('pairpilot.newSession', async () => {
    if (deps.orchestrator.machine.isBusy()) {
      void vscode.window.showWarningMessage(
        'Cancel the current PairPilot task before starting a new session.'
      );
      return;
    }
    deps.orchestrator.newSession();
    await deps.provider.reveal();
  });

  register('pairpilot.resumeSession', async () => {
    const sessions = deps.store.list();
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage('PairPilot has no stored sessions yet.');
      return;
    }
    if (deps.orchestrator.machine.isBusy()) {
      void vscode.window.showWarningMessage(
        'Cancel the current PairPilot task before resuming another session.'
      );
      return;
    }

    const picked = await vscode.window.showQuickPick(
      sessions.map((session) => ({
        label: session.title,
        description: new Date(session.updatedAt).toLocaleString(),
        detail: `${session.messageCount} messages · ${session.proposalCount} proposal(s)`,
        id: session.id,
      })),
      { title: 'Resume a PairPilot session', placeHolder: 'Choose a session' }
    );
    if (!picked) {
      return;
    }
    deps.orchestrator.loadSession(picked.id);
    await deps.provider.reveal();
  });

  register('pairpilot.cancel', async () => {
    if (!deps.orchestrator.machine.isBusy() && !deps.orchestrator.machine.isAwaitingHuman()) {
      void vscode.window.showInformationMessage('PairPilot is not doing anything to cancel.');
      return;
    }
    await deps.orchestrator.cancel();
  });

  register('pairpilot.revertLastWrite', async () => {
    await deps.orchestrator.revertLastWrite();
  });

  register('pairpilot.showUsage', async () => {
    const session = deps.store.getActive();
    if (!session) {
      void vscode.window.showInformationMessage('PairPilot has no active session.');
      return;
    }
    const usage = session.usage;
    if (!usage.available) {
      void vscode.window.showInformationMessage(
        'Usage unavailable — the AI runtime has not reported token counts for this session.'
      );
      return;
    }
    const cost = usage.costUsd === null ? 'not reported' : `$${usage.costUsd.toFixed(4)}`;
    const lines = [
      `Input tokens: ${usage.inputTokens.toLocaleString()}`,
      `Output tokens: ${usage.outputTokens.toLocaleString()}`,
      `Cache read tokens: ${usage.cacheReadTokens.toLocaleString()}`,
      `Cache write tokens: ${usage.cacheCreationTokens.toLocaleString()}`,
      `Reported cost: ${cost}`,
      usage.model ? `Model: ${usage.model}` : undefined,
    ].filter((line): line is string => line !== undefined);

    await vscode.window.showInformationMessage(lines.join('  ·  '), { modal: true });
  });

  register('pairpilot.checkRuntime', async () => {
    await deps.checkRuntime();
  });

  // Open a workspace file by relative path, refusing anything the guard rejects.
  // Registered so the Webview's "open the file" action never constructs a URI
  // out of untrusted input itself.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'pairpilot.openRelativeFile',
      async (relativePath: unknown) => {
        if (typeof relativePath !== 'string') {
          return;
        }
        const workspace = deps.getWorkspace();
        if (!workspace) {
          void vscode.window.showWarningMessage('PairPilot needs an open folder.');
          return;
        }
        try {
          const assessment = workspace.pathGuard.assess(relativePath);
          if (assessment.verdict === 'blocked' || assessment.verdict === 'excluded') {
            void vscode.window.showWarningMessage(assessment.reason);
            return;
          }
          const document = await vscode.workspace.openTextDocument(
            vscode.Uri.file(assessment.absolutePath)
          );
          await vscode.window.showTextDocument(document, { preview: false });
        } catch (error) {
          void vscode.window.showErrorMessage(
            `PairPilot could not open that file: ${describeError(error)}`
          );
        }
      }
    )
  );
}

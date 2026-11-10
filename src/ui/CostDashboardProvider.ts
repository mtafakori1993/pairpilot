/**
 * CostDashboardProvider — the "Cost & Usage" Webview.
 *
 * Same shape as the providers panel, and for the same reasons: a strict CSP with
 * a per-load nonce, one readable folder, a validated message contract, and no
 * credential anywhere near it. This panel has the smaller job of the two — it
 * reads usage records that are already on disk and renders them.
 *
 * It performs no arithmetic. Every figure arrives pre-formatted by
 * `CostViewBuilder`, so the panel cannot invent a cost, cannot round a small one
 * to zero, and cannot turn an unknown total into `$0.00`. The panel's own
 * JavaScript only lays out what it was given.
 */

import * as vscode from 'vscode';
import { parseCostRequest } from './CostMessages';
import type { CostView } from './CostViewBuilder';
import {
  buildMissingAssetsHtml,
  createNonce,
  isMessageSizeAcceptable,
  readTemplateFile,
  renderTemplate,
} from './WebviewAssets';

/** Days of history the panel can be asked to show. */
export const COST_RANGES = [7, 30, 90] as const;
export const DEFAULT_COST_RANGE_DAYS = 30;

export class CostDashboardProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'pairpilot.costView';

  private view: vscode.WebviewView | null = null;
  private rangeDays: number = DEFAULT_COST_RANGE_DAYS;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: {
      buildView(rangeDays: number): CostView;
      /** Called when the developer asks for the history to be erased. */
      onClearHistory(): void | Promise<void>;
      logger: { info(message: string): void; warn(message: string): void; error(message: string, error?: unknown): void };
    }
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };

    view.webview.html = this.buildHtml(view.webview);

    view.webview.onDidReceiveMessage((raw: unknown) => {
      void this.onMessage(raw);
    });

    view.onDidDispose(() => {
      this.view = null;
    });

    this.refresh();
  }

  refresh(): void {
    if (this.view === null) {
      return;
    }
    try {
      this.post({ type: 'state', view: this.deps.buildView(this.rangeDays) });
    } catch (error) {
      this.deps.logger.error('Could not build the Cost & Usage view.', error);
    }
  }

  async reveal(): Promise<void> {
    if (this.view !== null) {
      this.view.show?.(true);
      return;
    }
    await vscode.commands.executeCommand(`${CostDashboardProvider.viewType}.focus`);
  }

  get isOpen(): boolean {
    return this.view !== null;
  }

  private async onMessage(raw: unknown): Promise<void> {
    const parsed = parseCostRequest(raw);
    if (!parsed.ok) {
      this.deps.logger.warn(
        `PairPilot ignored a message from the Cost & Usage panel: ${parsed.reason}`
      );
      return;
    }
    const request = parsed.request;

    switch (request.type) {
      case 'selectRange':
        this.rangeDays = request.days;
        this.refresh();
        return;

      case 'clearHistory':
        await this.deps.onClearHistory();
        this.refresh();
        return;

      case 'ready':
      default:
        this.refresh();
        return;
    }
  }

  private post(message: { type: 'state'; view: CostView }): void {
    if (this.view === null) {
      return;
    }
    const serialised = JSON.stringify(message);
    if (!isMessageSizeAcceptable(serialised)) {
      this.deps.logger.error(
        `PairPilot refused to send a ${Math.round(serialised.length / 1024)}KB message to the cost panel.`
      );
      return;
    }
    void this.view.webview.postMessage(message);
  }

  private buildHtml(webview: vscode.Webview): string {
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    const nonce = createNonce();
    const template = readTemplateFile(vscode.Uri.joinPath(mediaRoot, 'cost.html').fsPath);

    if (template === null) {
      return buildMissingAssetsHtml(nonce, 'Cost & Usage');
    }

    return renderTemplate(template, {
      cspSource: webview.cspSource,
      nonce,
      sharedStyleUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'shared.css')).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'cost.css')).toString(),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'cost.js')).toString(),
    });
  }
}

/**
 * ProviderManagementProvider — the "AI Providers & Models" Webview.
 *
 * This class is deliberately thin. It owns four things and nothing else:
 *
 *  - the panel's own view state (the search query, the open details pane, the
 *    advisor's chosen task), which is presentation and belongs here;
 *  - the HTML, rendered from `media/` with a per-load nonce and the extension's
 *    own `media` folder as the only readable root;
 *  - the validated message contract, through `parseProviderMessages`;
 *  - opening one of three named external pages, which it resolves from a
 *    constant table rather than from anything the panel sent.
 *
 * Everything else — reading the key, fetching the catalogue, writing a
 * selection — is handed to the extension host. A panel that could reach a
 * credential or an HTTP client directly would be a far larger security surface,
 * and this design means it cannot: there is no import of either anywhere below.
 */

import * as vscode from 'vscode';
import { defaultModelQuery } from '../models/ModelSearch';
import {
  EXTERNAL_URLS,
  parseProviderRequest,
  type ProviderRequest,
} from './ProviderMessages';
import {
  MODEL_PAGE_SIZE,
  ProviderViewBuilder,
  type ProviderNotice,
  type ProvidersSnapshot,
  type ProvidersViewState,
} from './ProviderViewBuilder';
import {
  buildMissingAssetsHtml,
  createNonce,
  isMessageSizeAcceptable,
  readTemplateFile,
  renderTemplate,
} from './WebviewAssets';

export class ProviderManagementProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'pairpilot.providersView';

  private view: vscode.WebviewView | null = null;

  private state: ProvidersViewState = {
    query: defaultModelQuery(),
    offset: 0,
    detailsModelId: null,
    // The advisor opens on the role PairPilot actually performs today, so the
    // first thing a developer sees is about their own work rather than an
    // example.
    adviceTaskId: 'coding',
    notice: null,
  };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: {
      builder: ProviderViewBuilder;
      /**
       * Handle a request that changes provider or model state.
       *
       * Everything not purely about this panel's presentation arrives here, so
       * the extension keeps one place where a key is read and one place where a
       * selection is written.
       */
      handle(request: ProviderRequest): void | Promise<void>;
      logger: { info(message: string): void; warn(message: string): void; error(message: string, error?: unknown): void };
    }
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      // The panel can read exactly two files: the stylesheet and the script in
      // the extension's own media folder.
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

  /** Push a fresh snapshot, if the panel is open. */
  refresh(): void {
    if (this.view === null) {
      return;
    }
    try {
      this.post({ type: 'state', snapshot: this.builder().build(this.state) });
    } catch (error) {
      this.deps.logger.error('Could not build the AI Providers snapshot.', error);
    }
  }

  /** Show a one-line message in the panel, or clear it. */
  setNotice(notice: ProviderNotice | null): void {
    this.state = { ...this.state, notice };
  }

  /** Replace the notice and push, for the common "did a thing, say so" case. */
  notify(level: ProviderNotice['level'], text: string): void {
    this.setNotice({ level, text });
    this.refresh();
  }

  /** The query the panel is currently showing. Used by the host for logging. */
  get currentQuery(): ProvidersViewState {
    return this.state;
  }

  async reveal(): Promise<void> {
    if (this.view !== null) {
      this.view.show?.(true);
      return;
    }
    await vscode.commands.executeCommand(`${ProviderManagementProvider.viewType}.focus`);
  }

  get isOpen(): boolean {
    return this.view !== null;
  }

  /* ---------------------------------------------------------------------- */

  private builder(): ProviderViewBuilder {
    return this.deps.builder;
  }

  private async onMessage(raw: unknown): Promise<void> {
    const parsed = parseProviderRequest(raw);
    if (!parsed.ok) {
      // A rejected message is a bug or a tampering attempt. It is logged and
      // dropped; tearing the panel down would punish the developer for either.
      this.deps.logger.warn(
        `PairPilot ignored a message from the AI Providers panel: ${parsed.reason}`
      );
      return;
    }
    const request = parsed.request;

    switch (request.type) {
      // View-only: handled here, because nothing outside this panel cares what
      // page of the model list is on screen.
      case 'setQuery':
        this.state = {
          ...this.state,
          query: {
            ...this.state.query,
            search: request.search,
            quickFilters: request.quickFilters,
            sort: request.sort,
            favoritesOnly: request.favoritesOnly,
          },
          // A new filter makes the previous offset meaningless.
          offset: 0,
        };
        this.refresh();
        return;

      case 'showModelDetails':
        this.state = { ...this.state, detailsModelId: request.modelId };
        this.refresh();
        return;

      case 'requestAdvice':
        this.state = { ...this.state, adviceTaskId: request.taskId };
        this.refresh();
        return;

      case 'loadMore':
        // Only ever forward, never to an arbitrary position: the panel can ask
        // for the next page but cannot ask for a page the builder would have to
        // clamp.
        this.state = { ...this.state, offset: this.state.offset + MODEL_PAGE_SIZE };
        this.refresh();
        return;

      case 'openExternal': {
        const url = EXTERNAL_URLS[request.target];
        // A constant from our own source. The panel named a destination; it
        // never supplied an address.
        await vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }

      default:
        await this.deps.handle(request);
        return;
    }
  }

  private post(message: { type: 'state'; snapshot: ProvidersSnapshot }): void {
    if (this.view === null) {
      return;
    }
    const serialised = JSON.stringify(message);
    if (!isMessageSizeAcceptable(serialised)) {
      // The catalogue page is bounded, so reaching this means a bug rather than
      // a big catalogue. Reported instead of silently freezing the panel.
      this.deps.logger.error(
        `PairPilot refused to send a ${Math.round(serialised.length / 1024)}KB message to the providers panel.`
      );
      return;
    }
    void this.view.webview.postMessage(message);
  }

  private buildHtml(webview: vscode.Webview): string {
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    const nonce = createNonce();
    const template = readTemplateFile(vscode.Uri.joinPath(mediaRoot, 'providers.html').fsPath);

    if (template === null) {
      return buildMissingAssetsHtml(nonce, 'AI Providers & Models');
    }

    return renderTemplate(template, {
      cspSource: webview.cspSource,
      nonce,
      sharedStyleUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'shared.css')).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'providers.css')).toString(),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'providers.js')).toString(),
    });
  }
}

/**
 * Shared Webview scaffolding: the nonce, the template substitution, and the
 * fallback shown when the build step has not copied `media/`.
 *
 * Every Webview in PairPilot needs the same three things, and each of them is a
 * security property rather than a convenience:
 *
 *  - a **per-load nonce**, so the CSP can allow exactly the two script and style
 *    files this load needs and nothing else — including nothing inline;
 *  - **substitution through fixed placeholders** rather than string building, so
 *    a template cannot accidentally interpolate something it should not;
 *  - a **fallback page** that renders when assets are missing, instead of a
 *    blank panel that looks like a crash.
 *
 * `renderTemplate` uses `split`/`join` rather than a regular expression on
 * purpose: the replacement values are URIs, which contain characters that are
 * meaningful in a replacement pattern (`$&`, `$1`). A regex-based replace would
 * corrupt them.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

/** A CSP nonce. 128 bits, base64, fresh for every load. */
export function createNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

/** Read a template file, returning null when it is absent rather than throwing. */
export function readTemplateFile(fsPath: string): string | null {
  try {
    return fs.readFileSync(fsPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Substitute `{{name}}` placeholders.
 *
 * Only the supplied names are replaced; anything left in the template stays as
 * literal text, which makes a typo visible in the rendered page rather than
 * silently blank.
 */
export function renderTemplate(html: string, vars: Readonly<Record<string, string>>): string {
  let rendered = html;
  for (const [name, value] of Object.entries(vars)) {
    rendered = rendered.split(`{{${name}}}`).join(value);
  }
  return rendered;
}

/**
 * The page shown when the Webview assets were never copied into `media/`.
 *
 * This happens when someone runs the extension from source without running the
 * build first, and a blank panel would give them nothing to act on.
 */
export function buildMissingAssetsHtml(nonce: string, viewTitle: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';" />
<title>PairPilot</title>
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; line-height: 1.5; }
code { font-family: var(--vscode-editor-font-family); }
</style>
</head>
<body>
<h3>${escapeHtml(viewTitle)} assets are missing</h3>
<p>The Webview files were not copied into <code>media/</code>. Run the build:</p>
<p><code>npm run compile</code></p>
<p>If you are running from source, reload the window afterwards.</p>
</body>
</html>`;
}

/**
 * Escape text being placed into HTML.
 *
 * The fallback page is the only place a caller-supplied string reaches markup,
 * and it is escaped rather than trusted even though the values are constants
 * today — a view title is exactly the kind of thing that becomes configurable
 * later without anyone revisiting this.
 */
export function escapeHtml(text: string): string {
  return text
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;')
    .split("'").join('&#39;');
}

/**
 * Largest payload the Host will post into a Webview.
 *
 * The model catalogue is the only large message, and it is paged on the Host so
 * this bound is never approached in normal use. It exists so that a bug which
 * started sending the whole catalogue on every keystroke would be caught here
 * rather than by a frozen panel.
 */
export const MAX_HOST_MESSAGE_BYTES = 4 * 1024 * 1024;

/** True when a message is small enough to post. Logged, never silently dropped. */
export function isMessageSizeAcceptable(serialised: string): boolean {
  return serialised.length <= MAX_HOST_MESSAGE_BYTES;
}

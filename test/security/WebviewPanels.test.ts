/**
 * The shipped Webview panels, as files (spec sections 6 and 14).
 *
 * Everything in `src/ui/webview/` is shipped into a Webview, where the model
 * catalogue — remote, third-party text — is rendered. These tests pin the
 * properties the panels rely on, and they are written against the files rather
 * than against a running panel for one reason: a panel that has been *loaded*
 * cannot tell you whether it would have been safe to load.
 *
 * Three groups:
 *
 *  - **The templates.** Every placeholder is one the Host substitutes, the CSP
 *    denies everything it does not name, and nothing inline is allowed to run.
 *  - **The scripts.** No HTML construction, no network, no storage, and no
 *    formatting — the last of which is what stops an unknown cost being turned
 *    into a plausible-looking figure inside the panel.
 *  - **The stylesheets.** No literal colours, so both panels follow the editor's
 *    theme, including high-contrast themes, without a conditional.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The panels live in `src/ui/webview/` and are copied into `media/` by the
 * build. These tests read the source of truth, which exists in a fresh checkout
 * — unlike `media/`, which only exists after a build.
 */
const WEBVIEW_DIR = path.resolve(process.cwd(), 'src/ui/webview');

/** The five values `renderTemplate` is given, and no others. */
const EXPECTED_PLACEHOLDERS = [
  'cspSource',
  'nonce',
  'scriptUri',
  'sharedStyleUri',
  'styleUri',
];

/**
 * Every panel that is actually loaded, and only those.
 *
 * The providers panel used to be here. Provider and model choice now happen in
 * native prompts, so `providers.*` no longer ships — and a hygiene test over a
 * file nothing loads proves something about a page the developer can never
 * reach. The cost panel is the one Webview left.
 */
const PANELS = [
  { name: 'cost', template: 'cost.html', script: 'cost.js', style: 'cost.css' },
];

function read(file: string): string {
  const full = path.join(WEBVIEW_DIR, file);
  if (!fs.existsSync(full)) {
    // Named explicitly: a moved file should fail as a missing file, not as a
    // scan that found nothing to complain about.
    throw new Error(`Expected ${full} to exist. Did the Webview sources move?`);
  }
  return fs.readFileSync(full, 'utf8');
}

/** Strip comments, so a rule can be documented without tripping its own test. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

function stripHtmlComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

describe.each(PANELS)('the $name panel template', ({ template }) => {
  const html = read(template);

  it('names exactly the placeholders the host substitutes', () => {
    const found = [...html.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map((match) => match[1]);
    expect([...new Set(found)].sort()).toEqual([...EXPECTED_PLACEHOLDERS].sort());
  });

  it('loads the shared stylesheet before its own', () => {
    // Both panels share one base, so they cannot drift into looking like
    // different products.
    expect(html.indexOf('{{sharedStyleUri}}')).toBeLessThan(html.indexOf('{{styleUri}}'));
  });

  it('denies everything it does not name explicitly', () => {
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-{{nonce}}'");
    expect(html).not.toContain('unsafe-inline');
    expect(html).not.toContain('unsafe-eval');
    // The panel never reaches the network: the catalogue is fetched by the
    // Extension Host and pushed in.
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain('form-action');
    expect(html).toContain('base-uri');
  });

  it('allows exactly one script, from the extension’s own media folder', () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('nonce="{{nonce}}"');
    expect(scripts[0]).toContain('src="{{scriptUri}}"');
  });

  it('carries no inline handler and no javascript: URL', () => {
    const markup = stripHtmlComments(html);
    expect(markup).not.toMatch(/\son[a-z]+\s*=/i);
    expect(markup).not.toMatch(/javascript:/i);
    expect(markup).not.toContain('<style');
  });
});

describe.each(PANELS)('the $name panel script', ({ script }) => {
  const source = stripComments(read(script));

  it('never builds HTML from a string', () => {
    for (const forbidden of [
      'innerHTML',
      'outerHTML',
      'insertAdjacentHTML',
      'document.write',
      'eval(',
      'new Function',
    ]) {
      expect(source, `${script} must not use ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('never reaches the network, the filesystem or storage itself', () => {
    // `connect-src 'none'` would stop a request at the CSP. This stops one being
    // written in the first place, which is a better place to find out.
    for (const forbidden of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'localStorage', 'sessionStorage']) {
      expect(source, `${script} must not use ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('formats nothing, so it cannot turn an unknown into a figure', () => {
    // Every price, token count and date arrives already formatted by the Host.
    // A `toFixed` here is how an unknown cost would become `$0.00`.
    expect(source).not.toContain('toFixed(');
    expect(source).not.toContain('toLocaleString(');
    expect(source).not.toMatch(/Intl\./);
  });

  it('reads no raw figure off the snapshot', () => {
    // The raw fields exist on the Host's own state types; if one appears here,
    // the panel has started formatting something again.
    for (const raw of ['usageUsd', 'limitRemainingUsd', 'promptPerToken', 'completionPerToken', 'costUsd']) {
      expect(source, `${script} must not read ${raw}`).not.toContain(raw);
    }
  });

  it('talks to the host only through acquireVsCodeApi', () => {
    expect(source).toContain('acquireVsCodeApi()');
    // A message that reaches the Host is validated there; the panel must not
    // hold a second channel, such as a postMessage on the window.
    expect(source).not.toContain('window.postMessage');
    expect(source).not.toContain('parent.postMessage');
  });
});

describe.each(PANELS)('the $name panel stylesheet', ({ style }) => {
  const css = read(style);

  it('takes every colour from the editor theme', () => {
    // No literal colour: that is what makes a light, a dark and a high-contrast
    // theme all legible with no conditional in the code.
    const literals = css.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? [];
    expect(literals).toEqual([]);
  });

  it('uses the shared pp- vocabulary rather than inventing its own', () => {
    const classes = [...css.matchAll(/\.(pp-[a-z0-9-]+)/g)].map((match) => match[1]);
    expect(classes.length).toBeGreaterThan(0);
    for (const className of classes) {
      expect(className).toMatch(/^pp-[a-z0-9-]+$/);
    }
  });
});

describe('the shared stylesheet', () => {
  const css = read('shared.css');

  it('defines the base every panel-specific class builds on', () => {
    for (const className of ['.pp-root', '.pp-header', '.pp-section', '.pp-card', '.pp-table']) {
      expect(css).toContain(className);
    }
  });

  it('has no literal colour either', () => {
    const literals = css.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? [];
    expect(literals).toEqual([]);
  });

  it('falls back to a theme-neutral value, never a literal colour', () => {
    // Fallbacks are written as `var(--vscode-x, transparent)` or as another
    // theme variable: a missing variable must leave a rule inert, or hand the
    // decision to the theme, rather than paint a colour of PairPilot's own.
    const fallbacks = [...css.matchAll(/var\(--vscode-[a-z-]+,\s*([^()]+(?:\([^()]*\))?)\)/gi)].map(
      (match) => match[1]?.trim()
    );

    expect(fallbacks.length).toBeGreaterThan(0);
    for (const fallback of fallbacks) {
      const acceptable =
        fallback === 'transparent' ||
        fallback === 'currentColor' ||
        fallback === 'inherit' ||
        fallback?.startsWith('var(--vscode-') === true;
      expect(acceptable, `unexpected fallback: ${fallback}`).toBe(true);
    }
  });
});

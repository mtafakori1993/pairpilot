/**
 * Webview asset tests (nothing in the panels is trusted).
 *
 * `renderTemplate`, the nonce and the size bound are small, and small is exactly
 * why they get tested: each is a security property that a later refactor could
 * quietly weaken. The `$&` case below is not hypothetical — it is what a
 * `String.replace` implementation would have done to a URI, and the reason this
 * one splits instead.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_HOST_MESSAGE_BYTES,
  buildMissingAssetsHtml,
  createNonce,
  escapeHtml,
  isMessageSizeAcceptable,
  renderTemplate,
} from '../../src/ui/WebviewAssets';

describe('renderTemplate', () => {
  it('substitutes every named placeholder', () => {
    expect(renderTemplate('<a href="{{one}}">{{two}}</a>', { one: 'x', two: 'y' })).toBe(
      '<a href="x">y</a>'
    );
  });

  it('leaves an unknown placeholder as text rather than blanking it', () => {
    // A typo should be visible in the rendered page, not silently empty.
    expect(renderTemplate('{{known}} {{unknown}}', { known: 'a' })).toBe('a {{unknown}}');
  });

  it('does not treat replacement patterns in a URI as patterns', () => {
    // The reason this function splits instead of calling `replace`: `$&` and
    // `$1` are meaningful in a replacement string, and a URI can contain them.
    const uri = 'vscode-webview://a/$&/$1/$`/$\'';
    expect(renderTemplate('src="{{scriptUri}}"', { scriptUri: uri })).toBe(`src="${uri}"`);
  });

  it('replaces every occurrence, not only the first', () => {
    expect(renderTemplate('{{n}}-{{n}}', { n: '1' })).toBe('1-1');
  });
});

describe('createNonce', () => {
  it('is fresh for every load', () => {
    const nonces = new Set(Array.from({ length: 64 }, () => createNonce()));
    expect(nonces.size).toBe(64);
  });

  it('carries 128 bits of entropy, and nothing that needs escaping in HTML', () => {
    const nonce = createNonce();
    // 16 random bytes, base64: 24 characters including padding.
    expect(nonce).toHaveLength(24);
    expect(nonce).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

describe('escapeHtml', () => {
  it('escapes the five characters that can break out of markup', () => {
    expect(escapeHtml(`<a href="x" onerror='y'>&`)).toBe(
      '&lt;a href=&quot;x&quot; onerror=&#39;y&#39;&gt;&amp;'
    );
  });

  it('escapes the ampersand before the characters it introduces', () => {
    // Escaping `&` last would turn `&lt;` into `&amp;lt;`.
    expect(escapeHtml('&<')).toBe('&amp;&lt;');
  });

  it('escapes an ampersand in a title that is otherwise plain', () => {
    expect(escapeHtml('AI Providers & Models')).toBe('AI Providers &amp; Models');
  });
});

describe('the missing-assets page', () => {
  it('escapes a view title rather than trusting it', () => {
    const html = buildMissingAssetsHtml('nonce-value', '<script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('denies everything but the nonce it was given', () => {
    const html = buildMissingAssetsHtml('abc123', 'AI Providers & Models');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("style-src 'nonce-abc123'");
    expect(html).toContain('<style nonce="abc123">');
  });

  it('tells the developer how to fix it', () => {
    const html = buildMissingAssetsHtml('abc', 'Cost & Usage');
    expect(html).toContain('npm run compile');
    expect(html).toContain('Cost &amp; Usage');
  });
});

describe('the size bound', () => {
  it('accepts a message at the bound and refuses one past it', () => {
    expect(isMessageSizeAcceptable('x'.repeat(MAX_HOST_MESSAGE_BYTES))).toBe(true);
    expect(isMessageSizeAcceptable('x'.repeat(MAX_HOST_MESSAGE_BYTES + 1))).toBe(false);
  });

  it('is large enough for any page the catalogue can produce', () => {
    // 60 rows of model metadata, generously estimated, must fit with room to
    // spare — a bound that refused a normal page would freeze the panel.
    expect(MAX_HOST_MESSAGE_BYTES).toBeGreaterThan(512 * 1024);
  });
});

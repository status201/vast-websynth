import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import config from '../vite.config';

/**
 * untrusted-input.md REQ-defence-in-depth-at-delivery (v11) — the shipped CSP refuses
 * inline styles, and only the dev server relaxes it. e2e runs on the dev server
 * and so never sees the strict policy; this pins its shape, and the build +
 * `vite preview` check in the spec covers its effect.
 */
const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
const directive = (name: string): string =>
  csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' ')) ?? '';

describe('the shipped CSP', () => {
  it('has a style-src of self only', () => {
    expect(csp).not.toBe('');
    expect(directive('style-src')).toBe("style-src 'self'");
    expect(directive('script-src')).toBe("script-src 'self'");
  });

  it('leaves no style attribute or style element in index.html', () => {
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/<style[\s>]/i);
  });

  it('is relaxed by the dev-server transform only', () => {
    type P = { name?: string; apply?: string; transformIndexHtml?: (h: string) => string };
    const plugins = ((config as { plugins?: unknown[] }).plugins ?? []).flat() as P[];
    const dev = plugins.find((p) => p?.name === 'csp-dev-styles');
    expect(dev?.apply).toBe('serve');
    const relaxed = dev!.transformIndexHtml!(html);
    expect(relaxed).toContain("style-src 'self' 'unsafe-inline';");
  });
});

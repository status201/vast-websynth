import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * What an old tab says once a deploy has outrun it (version-skew.md). The probe
 * itself is pinned in tests/utils/live-version.test.ts; this drives the toasts.
 *
 * Each test gets fresh modules: a confirmed skew is remembered for the page's
 * lifetime (REQ-a-confirmed-skew-is-remembered), which in a test file would
 * otherwise leak from one case into the next.
 */

const OURS = __APP_VERSION__;
const NEWER = `${Number(OURS.split('.')[0]) + 1}.0.0`;
const OLDER = '0.0.1';

const skewToast = () => document.querySelector('[data-testid="version-skew-toast"]');
const failedToast = () => document.querySelector('[data-testid="lazy-load-failed-toast"]');
const takeoverToast = () => document.querySelector('[data-testid="version-skew-takeover-toast"]');
const text = (el: Element | null) => el?.querySelector('span')?.textContent ?? '';
const action = () => document.querySelector<HTMLButtonElement>('[data-testid="toast-action"]');

function setOnline(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value: online, configurable: true });
}

/** Stub the manifest: `null` answers the HTML a host's SPA fallback would. */
function serve(version: string | null) {
  const fetchFn = vi.fn(async () =>
    version === null
      ? new Response('<!DOCTYPE html>', { status: 200 })
      : new Response(JSON.stringify({ version, files: [] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchFn);
  return fetchFn;
}

async function load() {
  const { showLazyLoadFailure } = await import('../../src/ui/components/lazy-load-toast');
  const skew = await import('../../src/ui/components/version-skew-toast');
  return { showLazyLoadFailure, ...skew };
}

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '';
  setOnline(true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setOnline(true);
});

describe('a deferred surface that fails under a newer release (version-skew.md REQ-a-stale-failure-offers-reload)', () => {
  it('says a newer version is out and offers Reload, not Retry', async () => {
    const { showLazyLoadFailure } = await load();
    serve(NEWER);
    showLazyLoadFailure('the demo library', () => {});
    await vi.waitFor(() => expect(skewToast()).toBeTruthy());
    expect(text(skewToast())).toBe("Couldn't open the demo library — a newer version of VAST is out. Reload to get it.");
    expect(action()?.textContent).toBe('Reload');
    expect(failedToast()).toBeNull();
  });
});

describe('the probe only refines the report (version-skew.md REQ-a-failure-asks-whether-a-newer-version-is-live)', () => {
  for (const [label, version] of [
    ['our own version', OURS], ['an older version (a rollback)', OLDER], ['an unknown version', null],
  ] as const) {
    it(`keeps "the download failed" + Retry for ${label}`, async () => {
      const { showLazyLoadFailure } = await load();
      serve(version);
      showLazyLoadFailure('the demo library', () => {});
      await vi.waitFor(() => expect(failedToast()).toBeTruthy());
      expect(text(failedToast())).toBe("Couldn't open the demo library — the download failed.");
      expect(action()?.textContent).toBe('Retry');
      expect(skewToast()).toBeNull();
    });
  }

  it('asks nothing while offline, and reports at once', async () => {
    const { showLazyLoadFailure } = await load();
    const fetchFn = serve(NEWER);
    setOnline(false);
    showLazyLoadFailure('the demo library', () => {});
    expect(text(failedToast())).toContain("you're offline");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('a confirmed skew is remembered (version-skew.md REQ-a-confirmed-skew-is-remembered)', () => {
  it('asks the server once, then answers later failures from memory', async () => {
    const { reportIfNewerVersion } = await load();
    const fetchFn = serve(NEWER);
    await expect(reportIfNewerVersion("Couldn't open A")).resolves.toBe(true);
    await expect(reportIfNewerVersion("Couldn't open B")).resolves.toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(text(skewToast())).toContain("Couldn't open B");
  });

  it('a takeover by a newer worker confirms it too', async () => {
    const { reportIfNewerVersion, onTakeover } = await load();
    const fetchFn = serve(null);
    onTakeover(NEWER);
    await expect(reportIfNewerVersion("Couldn't open A")).resolves.toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('a demo that fails under a newer release (version-skew.md REQ-a-stale-failure-offers-reload)', () => {
  // The demo loaders are private to the panel's demo door (demo-loader.ts), so the
  // routing is pinned on the source.
  const src = readFileSync(path.join(process.cwd(), 'src/ui/panels/demo-loader.ts'), 'utf8');
  const body = (fn: string) => {
    const start = src.indexOf(`const ${fn} = async`);
    return src.slice(start, src.indexOf('\n  };', start));
  };

  it('routes the fetch-and-parse failures of both demo kinds through the probe', () => {
    expect(src).toContain('reportIfNewerVersion(`Couldn\'t load "${name}"`)');
    expect(src).toMatch(/const showDemoFailure = [^;]*reportDemoFailure\(/);
    for (const fn of ['loadZipDemo', 'loadJsonDemo']) {
      expect(body(fn)).toMatch(/catch \(e\) \{\s*await reportDemoFailure\(name, \(\) => thrownAlert\(/);
    }
  });

  it('keeps the dialog for a failure applying a song that did arrive', () => {
    for (const [fn, apply] of [['loadZipDemo', 'applyProjectBundle'], ['loadJsonDemo', 'applyDemo']]) {
      const b = body(fn);
      const afterApply = b.slice(b.indexOf(`${apply}(`));
      expect(afterApply).toMatch(/catch \(e\) \{\s*await thrownAlert\(/);
      expect(afterApply).not.toContain('reportDemoFailure');
    }
  });
});

describe('the takeover notice (version-skew.md REQ-a-takeover-by-a-newer-worker-is-announced)', () => {
  it('offers Reload and stays until dismissed', async () => {
    const { onTakeover } = await load();
    vi.useFakeTimers();
    onTakeover(NEWER);
    vi.advanceTimersByTime(10 * 60_000);
    expect(takeoverToast()).toBeTruthy();
    expect(text(takeoverToast())).toBe('A newer version of VAST is running in another tab — reload to switch to it.');
    expect(action()?.textContent).toBe('Reload');
  });

  it('says nothing for a worker of an older release', async () => {
    const { onTakeover } = await load();
    onTakeover(OLDER);
    expect(takeoverToast()).toBeNull();
  });
});

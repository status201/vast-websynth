import { describe, it, expect, vi } from 'vitest';
import {
  isNewerVersion,
  liveVersion,
  newerVersionLive,
  watchForTakeover,
  workerVersion,
  OFFLINE_MANIFEST_URL,
} from '../../src/utils/live-version';
import { MAX_VERSION_CHARS } from '../../src/state/limits';
import { OFFLINE_MANIFEST_URL as VIA_OFFLINE_COPY } from '../../src/utils/offline-copy';

/**
 * The version probe and the takeover watch (version-skew.md
 * REQ-the-version-probe-is-bounded, REQ-a-takeover-by-a-newer-worker-is-announced).
 * No DOM, no network: fetch and the service-worker container are stand-ins.
 */

const json = (body: unknown, status = 200) => async () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('liveVersion (version-skew.md REQ-the-version-probe-is-bounded)', () => {
  it("reads the manifest's version, past every cache", async () => {
    const fetchFn = vi.fn(json({ version: '9.9.9', files: [] }));
    await expect(liveVersion(fetchFn)).resolves.toBe('9.9.9');
    expect(fetchFn).toHaveBeenCalledWith(OFFLINE_MANIFEST_URL, expect.objectContaining({ cache: 'no-store' }));
  });

  it('gives up on a request that hangs, so a failure report is never held back', async () => {
    // Settles only when aborted — a captive portal that never answers.
    const hang = (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    await expect(liveVersion(hang, 20)).resolves.toBeNull();
  });

  it('has one spelling of the manifest URL, shared with Play offline', () => {
    expect(VIA_OFFLINE_COPY).toBe(OFFLINE_MANIFEST_URL);
  });

  const UNKNOWN: Array<[string, () => Promise<Response>]> = [
    ['a network error', async () => { throw new TypeError('Failed to fetch'); }],
    ['a 404', json({ version: '9.9.9' }, 404)],
    ['an HTML fallback', async () => new Response('<!DOCTYPE html><html></html>', { status: 200 })],
    ['JSON that is not an object', json('9.9.9')],
    ['JSON null', json(null)],
    ['no version', json({ files: [] })],
    ['a numeric version', json({ version: 9 })],
    ['an empty version', json({ version: '' })],
    ['an oversized version', json({ version: 'x'.repeat(MAX_VERSION_CHARS + 1) })],
  ];
  for (const [label, route] of UNKNOWN) {
    it(`resolves null, never rejects, for ${label}`, async () => {
      await expect(liveVersion(route)).resolves.toBeNull();
    });
  }

  it('accepts a version of exactly the cap', async () => {
    const v = 'x'.repeat(MAX_VERSION_CHARS);
    await expect(liveVersion(json({ version: v }))).resolves.toBe(v);
  });
});

describe('newerVersionLive (version-skew.md REQ-a-failure-asks-whether-a-newer-version-is-live)', () => {
  it('is true only for a known version later than ours', async () => {
    await expect(newerVersionLive(json({ version: '1.0.1' }), '1.0.0')).resolves.toBe(true);
    await expect(newerVersionLive(json({ version: '1.0.0' }), '1.0.0')).resolves.toBe(false);
    await expect(newerVersionLive(json({}, 404), '1.0.0')).resolves.toBe(false);
  });

  it('does not call a rollback newer', async () => {
    await expect(newerVersionLive(json({ version: '1.3.9' }), '1.4.0')).resolves.toBe(false);
  });
});

describe('isNewerVersion', () => {
  it('compares dotted numbers numerically', () => {
    expect(isNewerVersion('2.10.0', '2.9.1')).toBe(true);
    expect(isNewerVersion('2.9.1', '2.10.0')).toBe(false);
    expect(isNewerVersion('3', '2.99.99')).toBe(true);
    expect(isNewerVersion('2.22', '2.22.0')).toBe(false);
  });

  it('falls back to inequality for any other shape', () => {
    expect(isNewerVersion('2.22.0-rc1', '2.22.0')).toBe(true);
    expect(isNewerVersion('dev', 'dev')).toBe(false);
  });
});

/** Just enough ServiceWorkerContainer: a controller and its change event. */
function fakeContainer() {
  const target = new EventTarget();
  const sw = {
    controller: null as ServiceWorker | null,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
  const changeTo = (v: string | null) => {
    sw.controller = v === null
      ? null
      : ({ scriptURL: `https://example.com/sw.js${v ? `?v=${v}` : ''}` } as ServiceWorker);
    target.dispatchEvent(new Event('controllerchange'));
  };
  return { sw: sw as unknown as ServiceWorkerContainer, changeTo };
}

describe('watchForTakeover (version-skew.md REQ-a-takeover-by-a-newer-worker-is-announced)', () => {
  it("reports another version's worker exactly once", () => {
    const { sw, changeTo } = fakeContainer();
    const onTakeover = vi.fn();
    watchForTakeover(sw, onTakeover, '1.0.0');
    changeTo('1.0.1');
    changeTo('1.0.2');
    expect(onTakeover).toHaveBeenCalledTimes(1);
    expect(onTakeover).toHaveBeenCalledWith('1.0.1');
  });

  it("reports an older version's worker too — any takeover purges this version's cache", () => {
    const { sw, changeTo } = fakeContainer();
    const onTakeover = vi.fn();
    watchForTakeover(sw, onTakeover, '1.0.0');
    changeTo('0.9.0');
    expect(onTakeover).toHaveBeenCalledWith('0.9.0');
  });

  it('stays quiet for our own version, a worker without ?v, and no controller', () => {
    const { sw, changeTo } = fakeContainer();
    const onTakeover = vi.fn();
    watchForTakeover(sw, onTakeover, '1.0.0');
    changeTo('1.0.0');
    changeTo('');
    changeTo(null);
    expect(onTakeover).not.toHaveBeenCalled();
  });

  it('stops listening when unsubscribed', () => {
    const { sw, changeTo } = fakeContainer();
    const onTakeover = vi.fn();
    watchForTakeover(sw, onTakeover, '1.0.0')();
    changeTo('1.0.1');
    expect(onTakeover).not.toHaveBeenCalled();
  });
});

describe('workerVersion', () => {
  it("reads a worker's ?v= and tolerates junk", () => {
    expect(workerVersion({ scriptURL: 'https://example.com/sw.js?v=2.0.0' } as ServiceWorker)).toBe('2.0.0');
    expect(workerVersion({ scriptURL: 'not a url' } as ServiceWorker)).toBeNull();
    expect(workerVersion(null)).toBeNull();
  });
});

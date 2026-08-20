import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installLocalStorageMock } from '../storage-mock';
import { ParamBus, registerDefaults } from '../../src/state/params';
import modalStyles from '../../src/ui/styles/modal.module.css';
import type { StudioApi } from '../../src/ui/studio-api';
import type { TourCtx } from '../../src/ui/onboarding/tour';
import type { AiPromptRoutes } from '../../src/ui/components/ai-prompt';
import type { SyncController } from '../../src/audio/transport/sync/sync-controller';
import type { WebRtcSyncTransport } from '../../src/audio/webrtc-sync-transport';

/**
 * onboarding.md REQ-24 (runtime-performance.md REQ-1): the help door is behind
 * two `import()`s, and before this it failed *silently* — a `?` button that
 * appended no card and said nothing, which reads as a broken app rather than a
 * missing download.
 *
 * Both lazy modules are mocked to throw on evaluation, which is what a rejected
 * chunk fetch looks like from the importer's side. The flags are hoisted so a
 * test can switch a module from failing to working and re-drive the same
 * gesture — that is the Retry path, and for the facade it is also the proof
 * that a rejection was not memoized.
 *
 * Lives apart from about.test.ts / onboarding-facade.test.ts on purpose: those
 * suites need the real modules, and a module-level `vi.mock` is file-scoped.
 *
 * ORDER MATTERS, in one direction only. A factory that *throws* leaves nothing
 * in the module cache, so failure-path tests are free to repeat; a factory that
 * *returns* is cached for the rest of the file, and `vi.resetModules()` does not
 * evict it. So per mocked module, every failure test must come before the
 * recovery test that switches its flag off — hence the two "…and stays
 * retryable" cases sit last in their group. Adding a failure case for a module
 * after its recovery case will silently load the real thing.
 */
const h = vi.hoisted(() => ({ aboutFails: true, implFails: true }));

// The recovery case stubs the card rather than returning the real module. Two
// suites racing to transform the whole About graph (about-modal → about-shortcuts
// + about-debug → patterns.ts, dropdown.ts) is enough to push about.test.ts past
// its own load-bearing 15 s timeout in a full run — and what is under test here
// is the retry seam, not the card's contents, which about.test.ts owns.
vi.mock('../../src/ui/components/about-modal', () => {
  if (h.aboutFails) throw new Error('Failed to fetch dynamically imported module');
  const backdrop = document.createElement('div');
  backdrop.dataset.testid = 'about-card-stub';
  return { buildModal: () => ({ backdrop, refreshDebug: () => {}, disposeDebug: () => {} }) };
});

vi.mock('../../src/ui/onboarding/onboarding-impl', () => {
  if (h.implFails) throw new Error('Failed to fetch dynamically imported module');
  return { createOnboardingImpl: () => ({ startTour, toggleInfoBadges }) };
});

// These two have no recovery case, so their flag never flips and the factory
// never caches a success.
vi.mock('../../src/state/authoring-guide', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

vi.mock('../../src/ui/components/sync-pair-modal', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

const startTour = vi.fn();
const toggleInfoBadges = vi.fn();

const { createAboutButton } = await import('../../src/ui/components/about-button');
const { createOnboarding } = await import('../../src/ui/onboarding');
const { createAiPromptButton } = await import('../../src/ui/components/ai-prompt');
const { buildSyncSection } = await import('../../src/ui/components/sync-section');

const toast = () => document.querySelector('[data-testid="lazy-load-failed-toast"]');
const toastText = () => toast()?.querySelector('span')?.textContent ?? '';
const retry = () => document.querySelector<HTMLButtonElement>('[data-testid="toast-action"]');
const card = () => document.querySelector('[data-testid="about-card-stub"]');

/** `navigator.onLine` is a getter in jsdom; override it per test. */
function setOnline(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value: online, configurable: true });
}

/** StudioApi stub — `open()` only ever touches the context's listener pair. */
const ENGINE = {
  ctx: { addEventListener: () => {}, removeEventListener: () => {} },
} as unknown as StudioApi;

const TOUR_CTX = { bus: {}, engine: {} } as unknown as TourCtx;

function bus(): ParamBus {
  const b = new ParamBus();
  registerDefaults(b);
  return b;
}

/** buildSyncSection only touches mode/status/onStatus, and rtc only on open. */
const SYNC_CTRL = {
  mode: 'off',
  status: {
    mode: 'off', activeMode: 'off', links: [], playing: false, followedBpm: null, stalled: false,
  },
  setMode: () => {},
  onStatus: () => () => {},
} as unknown as SyncController;
const RTC = { linked: false, onPortsChange: () => () => {} } as unknown as WebRtcSyncTransport;

describe('A deferred help surface that cannot load (onboarding.md REQ-24)', () => {
  beforeEach(() => {
    installLocalStorageMock();
    document.body.innerHTML = '';
    h.aboutFails = true;
    h.implFails = true;
    startTour.mockClear();
    toggleInfoBadges.mockClear();
    setOnline(true);
  });

  afterEach(() => setOnline(true));

  it('reports instead of doing nothing when the About body will not load', async () => {
    const btn = createAboutButton(ENGINE, { startTour: vi.fn() });
    document.body.appendChild(btn);

    btn.click();
    await vi.waitFor(() => expect(toast()).toBeTruthy());

    // The regression: before REQ-24 this was the whole outcome — no card, and
    // nothing else either.
    expect(card()).toBeNull();
    expect(toastText()).toContain('Help & About');
    expect(retry()?.textContent).toBe('Retry');
  });

  it('says the chunk is missing rather than blaming the network while offline', async () => {
    setOnline(false);
    const btn = createAboutButton(ENGINE, { startTour: vi.fn() });
    document.body.appendChild(btn);

    btn.click();
    await vi.waitFor(() => expect(toast()).toBeTruthy());

    expect(toastText()).toContain("you're offline");
    expect(toastText()).toContain('downloaded');
  });

  it('blames the download, not the connection state, while online', async () => {
    const btn = createAboutButton(ENGINE, { startTour: vi.fn() });
    document.body.appendChild(btn);

    btn.click();
    await vi.waitFor(() => expect(toast()).toBeTruthy());

    expect(toastText()).toContain('the download failed');
    expect(toastText()).not.toContain('offline');
  });

  it('opens About on Retry once the import stops failing', async () => {
    const btn = createAboutButton(ENGINE, { startTour: vi.fn() });
    document.body.appendChild(btn);

    btn.click();
    await vi.waitFor(() => expect(retry()).toBeTruthy());

    h.aboutFails = false;
    retry()!.click();

    await vi.waitFor(() => expect(card()).toBeTruthy());
    expect(toast()).toBeNull(); // the action dismisses its own toast
  });

  it('names the badges, not the tour, when the ⓘ toggle is what failed', async () => {
    const onboarding = createOnboarding(TOUR_CTX);

    onboarding.toggleInfoBadges();
    await vi.waitFor(() => expect(toast()).toBeTruthy());

    expect(toastText()).toContain('the info badges');
    expect(onboarding.isInfoBadgesActive()).toBe(false);
  });

  it('reports a failed tour launch and stays retryable (the memo is not poisoned)', async () => {
    const onboarding = createOnboarding(TOUR_CTX);

    onboarding.startTour();
    await vi.waitFor(() => expect(toast()).toBeTruthy());
    expect(toastText()).toContain('the guided tour');
    expect(startTour).not.toHaveBeenCalled();

    // The regression: `pending` cached the rejection, so every later attempt
    // replayed it and the tour stayed dead for the rest of the session.
    h.implFails = false;
    retry()!.click();

    await vi.waitFor(() => expect(startTour).toHaveBeenCalledTimes(1));
  });

  it('reports when the AI prompt’s authoring guide will not load', async () => {
    const btn = createAiPromptButton(bus(), {} as AiPromptRoutes);
    document.body.appendChild(btn);

    btn.click();
    await vi.waitFor(() => expect(toast()).toBeTruthy());

    expect(toastText()).toContain('the AI prompt');
    expect(document.querySelector(`.${modalStyles.backdrop}`)).toBeNull();
  });

  it('reports when the WiFi pair modal will not load', async () => {
    const section = buildSyncSection(SYNC_CTRL, RTC);
    document.body.appendChild(section);

    section.querySelector<HTMLButtonElement>('[data-testid="sync-wifi-link"]')!.click();
    await vi.waitFor(() => expect(toast()).toBeTruthy());

    expect(toastText()).toContain('WiFi pairing');
  });
});

/**
 * The behavioural cases above reach the four triggers a jsdom test can build
 * cheaply. The other three live inside `app.ts` / `song-panel.ts` /
 * `sampler-panel.ts` as private functions behind a whole panel's dependency
 * graph, and — more to the point — no behavioural test can pin the *set*: the
 * regression this spec exists to prevent is someone adding an eighth deferred
 * surface and forgetting the catch. So the set is pinned structurally, the way
 * overlay-cost.test.ts pins REQ-10 by the absence of a declaration.
 */
describe('Every deferred-surface trigger is guarded (lazy-load-failure.md REQ-1)', () => {
  /**
   * Runtime `import()`s only. Type positions (`typeof import('x').T`,
   * `: import('x').T`) carry no fetch and must not be flagged.
   */
  const RUNTIME_IMPORT = /\bawait import\(|\bimport\([^)]*\)\s*\.(then|catch)\b/;

  /** REQ-4 and REQ-5: the imports that legitimately do not report. */
  const EXEMPT = new Map<string, string>([
    ['src/main.ts', 'REQ-4 — idle warms; not a gesture, so a toast would be noise'],
    ['src/audio/recorder/encode.ts', 'REQ-5 — lamejs mid-export, owned by audio-export.md'],
    ['src/ui/components/sync-pair-modal.ts', 'REQ-5 — jsqr mid-scan, owned by webrtc-sync.md'],
  ]);

  it('leaves no runtime import() in src/ without a report or a documented exemption', async () => {
    const { readFileSync } = await import('node:fs');
    const { globSync } = await import('node:fs');
    const files = globSync('src/**/*.ts', { cwd: process.cwd() })
      .map((f) => f.replace(/\\/g, '/'))
      .filter((f) => !f.startsWith('src/vendor/'));

    // Guards against the glob silently matching nothing and passing vacuously.
    expect(files.length).toBeGreaterThan(50);

    const unguarded = files.filter((f) => {
      const src = readFileSync(f, 'utf8');
      if (!RUNTIME_IMPORT.test(src)) return false;
      if (EXEMPT.has(f)) return false;
      return !src.includes('showLazyLoadFailure');
    });

    expect(unguarded).toEqual([]);
  });

  it('still covers each trigger the spec names', async () => {
    const { readFileSync } = await import('node:fs');
    const TRIGGERS = [
      'src/ui/components/about-button.ts',
      'src/ui/onboarding/index.ts',
      'src/ui/app.ts',
      'src/ui/panels/song-panel.ts',
      'src/ui/panels/sampler-panel.ts',
      'src/ui/components/sync-section.ts',
      'src/ui/components/ai-prompt.ts',
    ];
    for (const f of TRIGGERS) {
      const src = readFileSync(f, 'utf8');
      expect(RUNTIME_IMPORT.test(src), `${f} no longer defers anything`).toBe(true);
      expect(src.includes('showLazyLoadFailure'), `${f} does not report a failed load`).toBe(true);
    }
  });
});

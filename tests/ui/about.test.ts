import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAboutButton, setClipStatsSource } from '../../src/ui/components/about';
import { restoreFactorySettings } from '../../src/state/factory-reset';
import { installLocalStorageMock } from '../storage-mock';
import type { StudioApi } from '../../src/ui/studio-api';
import type { IosAudioDiagnostics } from '../../src/audio/ios-audio-session';
import type { MediaSessionDiagnostics } from '../../src/audio/media-session';

// The About modal wires the factory-reset button to this helper; the helper's
// own behaviour (clear + reload) is pinned by tests/state/factory-reset.test.ts.
vi.mock('../../src/state/factory-reset', () => ({ restoreFactorySettings: vi.fn() }));

const INERT_IOS: IosAudioDiagnostics = { active: false, status: 'n/a', routed: false, paused: null, currentTime: null };
const INERT_MEDIA: MediaSessionDiagnostics = {
  active: false, status: 'n/a', playbackState: 'n/a', handlers: 0, paused: null, currentTime: null,
};

/** Minimal StudioApi — the Debug panel reads the context, the clock/sync state,
 *  the iOS + Android session diagnostics, and (for its actions) panic/resume/sampler. */
function stubEngine(
  state: AudioContextState = 'running',
  iosAudio: IosAudioDiagnostics = INERT_IOS,
  mediaSession: MediaSessionDiagnostics = INERT_MEDIA,
) {
  const osc = {
    frequency: { value: 0 },
    connect: vi.fn(() => gain),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null as null | (() => void),
  };
  const gain = {
    gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const ctx = {
    state,
    sampleRate: 48000,
    currentTime: 0,
    baseLatency: 0.005,
    outputLatency: 0.012,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    suspend: vi.fn(async () => {}),
    createOscillator: vi.fn(() => osc),
    createGain: vi.fn(() => gain),
    destination: {},
  };
  const engine = {
    ctx,
    iosAudio,
    mediaSession,
    clock: { playing: false, bpm: 120, dropouts: 0 },
    sync: { mode: 'off' },
    sampler: { setBuffer: vi.fn() },
    panic: vi.fn(),
    resume: vi.fn(async () => {}),
  };
  return { engine: engine as unknown as StudioApi, ctx, osc, api: engine };
}

const debugSection = () => document.querySelector('[data-testid="debug-section"]') as HTMLElement | null;
const ctxStateRow = () => document.querySelector('[data-testid="debug-ctx-state"]') as HTMLElement | null;
const unlockRow = () => document.querySelector('[data-testid="debug-ios-unlock"]') as HTMLElement | null;
const mediaRow = () => document.querySelector('[data-testid="debug-media-session"]') as HTMLElement | null;
const clipsRow = () => document.querySelector('[data-testid="debug-sampler-clips"]') as HTMLElement | null;
const clipsClearBtn = () => document.querySelector('[data-testid="debug-clips-clear"]') as HTMLButtonElement | null;

/** Close any open modal so its refresh interval / capturing keydown listener don't leak. */
function closeOpenModal(): void {
  const closeBtn = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Close');
  closeBtn?.click();
}

/**
 * The section is default-collapsed and only refreshes while expanded
 * (debug-panel.md REQ-3), so any test that wants *live* rows must open it
 * first. The header above the body is the click target.
 */
function expandDebug(): void {
  (debugSection()!.previousElementSibling as HTMLElement).click();
}

describe('About modal — Debug section', () => {
  beforeEach(() => {
    installLocalStorageMock();
    document.body.innerHTML = '';
    vi.mocked(restoreFactorySettings).mockClear();
  });
  afterEach(() => closeOpenModal());

  it('opens with a default-collapsed Debug section showing the context state', () => {
    const { engine } = stubEngine('running');
    const btn = createAboutButton(engine);
    document.body.appendChild(btn);
    btn.click();

    const section = debugSection();
    expect(section).not.toBeNull();
    expect(section!.classList.contains('collapsed')).toBe(true);
    expect(ctxStateRow()?.textContent).toBe('running');
  });

  it('keeps the readout live via the ctx statechange listener while open', () => {
    const { engine, ctx } = stubEngine('suspended');
    const btn = createAboutButton(engine);
    document.body.appendChild(btn);
    btn.click();
    expandDebug(); // REQ-3 — a folded section reads nothing.

    expect(ctxStateRow()?.textContent).toBe('suspended');

    const handler = ctx.addEventListener.mock.calls.find((c) => c[0] === 'statechange')?.[1] as (() => void) | undefined;
    expect(handler).toBeTypeOf('function');
    ctx.state = 'running';
    handler!();
    expect(ctxStateRow()?.textContent).toBe('running');
  });

  it('renders the iOS audio-unlock diagnostics row', () => {
    const ios: IosAudioDiagnostics = { active: true, status: 'playing', routed: true, paused: false, currentTime: 1.2 };
    const { engine } = stubEngine('running', ios);
    const btn = createAboutButton(engine);
    document.body.appendChild(btn);
    btn.click();

    expect(unlockRow()?.textContent).toBe('playing · routed');
  });

  // media-session.md REQ-8 — on the phone where the crackle reproduces, this row
  // is the only way to tell "the session never formed" from "it formed anyway".
  it('renders the Android keep-alive row, and n/a off Android', () => {
    const media: MediaSessionDiagnostics = {
      active: true, status: 'playing', playbackState: 'playing', handlers: 3,
      paused: false, currentTime: 12.34,
    };
    const { engine } = stubEngine('running', INERT_IOS, media);
    document.body.appendChild(createAboutButton(engine)).click();
    expect(mediaRow()?.textContent).toBe('playing · playing · 3 actions · t=12.3');

    document.body.innerHTML = '';
    const { engine: off } = stubEngine('running');
    document.body.appendChild(createAboutButton(off)).click();
    expect(mediaRow()?.textContent).toBe('n/a');
  });

  // debug-panel.md REQ-4/REQ-5 — the late-bound row idiom, used by
  // sample-persistence.md for the IndexedDB clip store.
  it('reads the sampler-clip row from its late-bound source, or n/a when unbound', () => {
    const { engine } = stubEngine('running');
    document.body.appendChild(createAboutButton(engine)).click();
    expect(clipsRow()?.textContent).toBe('n/a');
    // REQ-8 — the action-side mirror: an unbound source disables its action
    // rather than offering a button that cannot work. (This runs before any
    // other test binds the module-level source, so it pins the real thing.)
    expect(clipsClearBtn()?.disabled).toBe(true);

    closeOpenModal();
    document.body.innerHTML = '';
    setClipStatsSource(() => ({ count: 2, bytes: 4_200_000 }));
    document.body.appendChild(createAboutButton(engine)).click();
    expect(clipsRow()?.textContent).toBe('2 · 4.2 MB');
    expect(clipsClearBtn()?.disabled).toBe(false);
  });

  it('places the factory-reset button between the shortcuts grid and Debug', () => {
    const { engine } = stubEngine();
    document.body.appendChild(createAboutButton(engine));
    (document.body.firstElementChild as HTMLButtonElement).click();

    const reset = document.querySelector('[data-testid="factory-reset"]') as HTMLElement;
    expect(reset).not.toBeNull();
    expect(reset.textContent).toBe('Restore to Factory Settings');
    // Preceded by the shortcuts key/value grid, followed by the Debug header.
    expect(reset.previousElementSibling?.textContent).toContain('Play / stop transport');
    expect(reset.nextElementSibling?.textContent).toContain('Debug');
  });

  it('confirming the factory-reset dialog restores factory settings', async () => {
    const { engine } = stubEngine();
    document.body.appendChild(createAboutButton(engine));
    (document.body.firstElementChild as HTMLButtonElement).click();

    (document.querySelector('[data-testid="factory-reset"]') as HTMLButtonElement).click();
    // The styled confirm carries the Nintendo exit line, italic via .detail.
    const detail = document.querySelector('[data-testid="dialog-detail"]') as HTMLElement;
    expect(detail.textContent).toBe('“Everything not saved will be lost.”');

    (document.querySelector('[data-testid="dialog-confirm"]') as HTMLButtonElement).click();
    await Promise.resolve(); // let the awaited confirmDialog promise settle
    expect(restoreFactorySettings).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the confirm, not the About modal beneath it', async () => {
    const { engine } = stubEngine();
    document.body.appendChild(createAboutButton(engine));
    (document.body.firstElementChild as HTMLButtonElement).click();

    (document.querySelector('[data-testid="factory-reset"]') as HTMLButtonElement).click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await Promise.resolve();

    // The confirm resolved false (no restore) and its backdrop is fading out…
    expect(restoreFactorySettings).not.toHaveBeenCalled();
    const dialogBackdrop = document
      .querySelector('[data-testid="dialog-confirm"]')!
      .closest('[class*="backdrop"]')!;
    expect(dialogBackdrop.classList.contains('hidden')).toBe(true);
    // …while the About modal underneath stays open.
    const aboutBackdrop = debugSection()!.closest('[class*="backdrop"]')!;
    expect(aboutBackdrop.classList.contains('hidden')).toBe(false);
  });

  it('cancelling the factory-reset dialog changes nothing', async () => {
    const { engine } = stubEngine();
    document.body.appendChild(createAboutButton(engine));
    (document.body.firstElementChild as HTMLButtonElement).click();

    (document.querySelector('[data-testid="factory-reset"]') as HTMLButtonElement).click();
    (document.querySelector('[data-testid="dialog-cancel"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(restoreFactorySettings).not.toHaveBeenCalled();
  });

  // ---- v3: interactive actions (debug-panel.md REQ-6..REQ-9) ----

  const openAbout = (engine: StudioApi): void => {
    const btn = createAboutButton(engine);
    document.body.appendChild(btn);
    btn.click();
  };
  const byId = <T extends HTMLElement>(id: string): T =>
    document.querySelector(`[data-testid="${id}"]`) as T;

  it('offers the panel actions and follows the context state', () => {
    const { engine, ctx, api } = stubEngine('suspended');
    openAbout(engine);
    expandDebug(); // REQ-3 — the label only follows the ctx while expanded.

    const toggle = byId<HTMLButtonElement>('debug-ctx-toggle');
    expect(byId('debug-actions')).not.toBeNull();
    // Suspended: the button offers the escape hatch.
    expect(toggle.textContent).toBe('Resume');
    toggle.click();
    expect(api.resume).toHaveBeenCalledTimes(1);

    // Running: it offers the opposite, and suspends the real context.
    ctx.state = 'running';
    const handler = ctx.addEventListener.mock.calls.find((c) => c[0] === 'statechange')?.[1] as () => void;
    handler();
    expect(toggle.textContent).toBe('Suspend');
    toggle.click();
    expect(ctx.suspend).toHaveBeenCalledTimes(1);
  });

  it('panics and plays a test tone straight to the destination', () => {
    const { engine, ctx, osc, api } = stubEngine('running');
    openAbout(engine);

    byId<HTMLButtonElement>('debug-panic').click();
    expect(api.panic).toHaveBeenCalledTimes(1);

    const tone = byId<HTMLButtonElement>('debug-test-tone');
    tone.click();
    expect(osc.start).toHaveBeenCalled();
    expect(osc.frequency.value).toBe(440);
    // Deliberately NOT through the master chain — this asks "is the device
    // silent?", which a muted mix would otherwise hide.
    expect(ctx.createOscillator).toHaveBeenCalledTimes(1);
    expect(tone.textContent).toBe('Playing…');

    // REQ-9 — closing the panel stops it.
    closeOpenModal();
    expect(osc.stop).toHaveBeenCalled();
  });

  it('copies a report of every row plus the version and UA (REQ-7)', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { engine } = stubEngine('running');
    openAbout(engine);

    byId<HTMLButtonElement>('debug-copy').click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    const report = writeText.mock.calls[0]![0] as unknown as string;
    expect(report).toContain(navigator.userAgent);
    expect(report).toContain('AudioContext: running');
    expect(report).toContain('Sample rate: 48000 Hz');
    expect(report).toContain('Transport: stopped · 120.0 BPM · sync off');
  });

  // REQ-6 — a destructive action never fires on the click alone.
  it('confirms before clearing the autosaved session', async () => {
    const { engine } = stubEngine('running');
    localStorage.setItem('websynth.session', JSON.stringify({ v: 1, savedAt: Date.now(), file: {} }));
    openAbout(engine);

    byId<HTMLButtonElement>('debug-session-clear').click();
    byId<HTMLButtonElement>('dialog-cancel').click();
    await Promise.resolve();
    expect(localStorage.getItem('websynth.session')).not.toBeNull();
  });

  it('clears the sampler slots when the clip clear is confirmed', async () => {
    const { engine, api } = stubEngine('running');
    setClipStatsSource(() => ({ count: 2, bytes: 1000 }));
    openAbout(engine);

    byId<HTMLButtonElement>('debug-clips-clear').click();
    byId<HTMLButtonElement>('dialog-confirm').click();
    await Promise.resolve();
    expect(api.sampler.setBuffer).toHaveBeenCalledTimes(8);
    expect(api.sampler.setBuffer).toHaveBeenCalledWith(0, null);
  });

  it('reports storage, session and platform rows', () => {
    const { engine } = stubEngine('running');
    localStorage.setItem('websynth.preset.mine', '{"a":1}');
    openAbout(engine);

    expect(byId('debug-storage').textContent).toMatch(/\d+ keys · [\d.]+ MB/);
    expect(byId('debug-latency').textContent).toBe('base 5.0 ms · output 12.0 ms');
    // Unbound late-bound sources read n/a rather than crashing (REQ-5).
    expect(byId('debug-midi').textContent).toBe('n/a');
    expect(byId('debug-wake').textContent).toBe('n/a');
    // jsdom has no service worker.
    expect(byId('debug-sw').textContent).toBe('unsupported');
  });

  it('expands the Debug section when its header is clicked', () => {
    const { engine } = stubEngine();
    const btn = createAboutButton(engine);
    document.body.appendChild(btn);
    btn.click();

    const section = debugSection()!;
    expect(section.classList.contains('collapsed')).toBe(true);
    // The header (the .sec sibling carrying the chevron) is the click target.
    const header = section.previousElementSibling as HTMLElement;
    header.click();
    expect(section.classList.contains('collapsed')).toBe(false);
  });

  // ---- v4: the panel costs nothing it doesn't have to (REQ-3/REQ-11) ----

  it('reads nothing at all while the Debug section is collapsed (REQ-3)', () => {
    vi.useFakeTimers();
    try {
      const { engine, ctx } = stubEngine('suspended');
      openAbout(engine);
      expect(debugSection()!.classList.contains('collapsed')).toBe(true);
      expect(ctxStateRow()?.textContent).toBe('suspended');

      // The interval keeps firing behind a folded panel — and must do nothing:
      // opening About for the credits shouldn't pay for an off-screen readout.
      ctx.state = 'running';
      vi.advanceTimersByTime(5000);
      expect(ctxStateRow()?.textContent).toBe('suspended');
    } finally {
      vi.useRealTimers();
    }
  });

  it('repaints immediately when the section is expanded, before any tick (REQ-3)', () => {
    const { engine, ctx } = stubEngine('suspended');
    openAbout(engine);

    ctx.state = 'running';
    expect(ctxStateRow()?.textContent).toBe('suspended');
    expandDebug();
    // No timer was advanced — expanding forces the repaint itself.
    expect(ctxStateRow()?.textContent).toBe('running');
  });

  it('re-reads the localStorage-backed rows on the slow tier only (REQ-11)', () => {
    vi.useFakeTimers();
    try {
      const { engine } = stubEngine('running');
      openAbout(engine);
      expandDebug();

      const storageRow = byId('debug-storage');
      const before = storageRow.textContent;

      // A new key changes what storageUsage() would report...
      localStorage.setItem('websynth.slow-tier.probe', 'x'.repeat(64));

      // ...but a single ~500 ms tick must not walk localStorage looking for it.
      vi.advanceTimersByTime(500);
      expect(storageRow.textContent).toBe(before);

      // The ~2 s tier does.
      vi.advanceTimersByTime(2000);
      expect(storageRow.textContent).not.toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

// onboarding.md REQ-17 — the About list is the canonical on-screen shortcut
// reference, and its arrow rows were unreadable.
describe('About modal — keyboard shortcut list', () => {
  beforeEach(() => {
    installLocalStorageMock();
    document.body.innerHTML = '';
  });
  afterEach(() => closeOpenModal());

  function openAbout() {
    const { engine } = stubEngine();
    document.body.appendChild(createAboutButton(engine));
    (document.body.firstElementChild as HTMLButtonElement).click();
    // The key/value grid is the element preceding the factory-reset button.
    const reset = document.querySelector('[data-testid="factory-reset"]') as HTMLElement;
    return reset.previousElementSibling as HTMLElement;
  }

  it('names every global shortcut, including the transport ones', () => {
    const text = openAbout().textContent ?? '';
    for (const s of [
      'Play / stop transport',
      'Move the playhead to bar 1',
      'Move the playhead one bar',
      'Clear the selected step',
      'Undo the last grid edit',
      'Panic — all notes off',
    ]) {
      expect(text, s).toContain(s);
    }
    expect(text).toContain('Home');
    expect(text).toContain('Ctrl/Cmd + Z');
  });

  it('names both routes to the help badges (onboarding.md REQ-19)', () => {
    const keys = openAbout();
    const text = keys.textContent ?? '';
    expect(text).toContain('Show / hide the help badges');
    // The gesture route too — a Shift+click is as reachable as the key, and the
    // list already carries a mouse row (Shift + drag for fine knob control).
    expect(text).toContain('Shift + click Help');
    // The key itself must be listed, not just described.
    const cells = [...keys.children].map((k) => k.textContent);
    expect(cells).toContain('?');
  });

  it('draws arrow runs in the glyph span, not the bare monospace face', () => {
    const keys = openAbout();
    const glyphs = [...keys.querySelectorAll('span')];
    expect(glyphs.length).toBeGreaterThan(0);
    // Every arrow in the list lives inside a glyph span — the monospace face
    // has no glyph for them, so a bare one renders as an illegible fallback.
    for (const g of glyphs) expect(g.textContent).toMatch(/^[←→↑↓⌫⏮\s]+$/);
    const bare = [...keys.children].filter(
      (k) => /[←→↑↓]/.test(k.textContent ?? '') && k.querySelector('span') === null,
    );
    expect(bare).toEqual([]);
  });

  it('keeps the non-symbol part of a combo as plain monospace text', () => {
    const keys = openAbout();
    const shiftArrow = [...keys.children].find((k) => k.textContent?.startsWith('Shift + ←'));
    expect(shiftArrow).toBeTruthy();
    // "Shift + " is a text node; only the arrows are wrapped.
    expect(shiftArrow!.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(shiftArrow!.querySelectorAll('span')).toHaveLength(1);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAboutButton, setClipStatsSource } from '../../src/ui/components/about';
import { restoreFactorySettings } from '../../src/state/factory-reset';
import { installLocalStorageMock } from '../storage-mock';
import modalStyles from '../../src/ui/styles/modal.module.css';
import { NOTE_ROWS } from '../../src/ui/shortcuts';
import {
  LAYOUTS, writeLayoutPref, resetDetectionForTests,
} from '../../src/state/keyboard-layout';
import type { StudioApi } from '../../src/ui/studio-api';
import type { IosAudioDiagnostics } from '../../src/audio/ios-audio-session';
import type { MediaSessionDiagnostics } from '../../src/audio/media-session';
import type { WatchdogDiagnostics } from '../../src/audio/background-watchdog';

// The About modal wires the factory-reset button to this helper; the helper's
// own behaviour (clear + reload) is pinned by tests/state/factory-reset.test.ts.
vi.mock('../../src/state/factory-reset', () => ({ restoreFactorySettings: vi.fn() }));

/** The onboarding hook the modal's "Take the guided tour" button calls
 *  (onboarding.md REQ-20). Injected, so about.ts never imports onboarding. */
const TOUR = { startTour: vi.fn() };

const INERT_IOS: IosAudioDiagnostics = { active: false, status: 'n/a', routed: false, paused: null, currentTime: null };
const INERT_MEDIA: MediaSessionDiagnostics = {
  active: false, status: 'n/a', playbackState: 'n/a', handlers: 0, paused: null, currentTime: null,
};
const IDLE_BG: WatchdogDiagnostics = {
  supported: true, watching: false, underrunRatio: 0, worstUnderrunRatio: 0, driftRatio: 1, suspensions: 0,
};

/** Minimal StudioApi — the Debug panel reads the context, the clock/sync state,
 *  the iOS + Android session diagnostics, and (for its actions) panic/resume/sampler. */
function stubEngine(
  state: AudioContextState = 'running',
  iosAudio: IosAudioDiagnostics = INERT_IOS,
  mediaSession: MediaSessionDiagnostics = INERT_MEDIA,
  backgroundAudio: WatchdogDiagnostics = IDLE_BG,
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
    backgroundAudio,
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
const bgRow = () => document.querySelector('[data-testid="debug-background"]') as HTMLElement | null;
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
    const btn = createAboutButton(engine, TOUR);
    document.body.appendChild(btn);
    btn.click();

    const section = debugSection();
    expect(section).not.toBeNull();
    expect(section!.classList.contains('collapsed')).toBe(true);
    expect(ctxStateRow()?.textContent).toBe('running');
  });

  it('keeps the readout live via the ctx statechange listener while open', () => {
    const { engine, ctx } = stubEngine('suspended');
    const btn = createAboutButton(engine, TOUR);
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
    const btn = createAboutButton(engine, TOUR);
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
    document.body.appendChild(createAboutButton(engine, TOUR)).click();
    expect(mediaRow()?.textContent).toBe('playing · playing · 3 actions · t=12.3');

    document.body.innerHTML = '';
    const { engine: off } = stubEngine('running');
    document.body.appendChild(createAboutButton(off, TOUR)).click();
    expect(mediaRow()?.textContent).toBe('n/a');
  });

  // audio-lifecycle.md REQ-12 — the reading that says whether a background
  // crackle is even ours: zero underruns means it happened downstream of us.
  it('renders the background-watchdog readings', () => {
    const bg: WatchdogDiagnostics = {
      supported: true, watching: true, underrunRatio: 0.0312, worstUnderrunRatio: 0.081,
      driftRatio: 0.994, suspensions: 2,
    };
    const { engine } = stubEngine('running', INERT_IOS, INERT_MEDIA, bg);
    document.body.appendChild(createAboutButton(engine, TOUR)).click();
    expect(bgRow()?.textContent)
      .toBe('watching · underrun 3.1% (worst 8.1%) · clock 99.4% · 2 suspends');

    // Without renderCapacity the drift fallback is all there is; say so.
    document.body.innerHTML = '';
    const { engine: noCap } = stubEngine('running', INERT_IOS, INERT_MEDIA, { ...bg, supported: false });
    document.body.appendChild(createAboutButton(noCap, TOUR)).click();
    expect(bgRow()?.textContent).toContain('underrun n/a');
  });

  // debug-panel.md REQ-4/REQ-5 — the late-bound row idiom, used by
  // sample-persistence.md for the IndexedDB clip store.
  it('reads the sampler-clip row from its late-bound source, or n/a when unbound', () => {
    const { engine } = stubEngine('running');
    document.body.appendChild(createAboutButton(engine, TOUR)).click();
    expect(clipsRow()?.textContent).toBe('n/a');
    // REQ-8 — the action-side mirror: an unbound source disables its action
    // rather than offering a button that cannot work. (This runs before any
    // other test binds the module-level source, so it pins the real thing.)
    expect(clipsClearBtn()?.disabled).toBe(true);

    closeOpenModal();
    document.body.innerHTML = '';
    setClipStatsSource(() => ({ count: 2, bytes: 4_200_000 }));
    document.body.appendChild(createAboutButton(engine, TOUR)).click();
    expect(clipsRow()?.textContent).toBe('2 · 4.2 MB');
    expect(clipsClearBtn()?.disabled).toBe(false);
  });

  it('places the factory-reset button between the shortcuts grid and Debug', () => {
    const { engine } = stubEngine();
    document.body.appendChild(createAboutButton(engine, TOUR));
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
    document.body.appendChild(createAboutButton(engine, TOUR));
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
    document.body.appendChild(createAboutButton(engine, TOUR));
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
    document.body.appendChild(createAboutButton(engine, TOUR));
    (document.body.firstElementChild as HTMLButtonElement).click();

    (document.querySelector('[data-testid="factory-reset"]') as HTMLButtonElement).click();
    (document.querySelector('[data-testid="dialog-cancel"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(restoreFactorySettings).not.toHaveBeenCalled();
  });

  // ---- v3: interactive actions (debug-panel.md REQ-6..REQ-9) ----

  const openAbout = (engine: StudioApi): void => {
    const btn = createAboutButton(engine, TOUR);
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
    const btn = createAboutButton(engine, TOUR);
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
    document.body.appendChild(createAboutButton(engine, TOUR));
    (document.body.firstElementChild as HTMLButtonElement).click();
    // The key/value grid is the element preceding the factory-reset button.
    const reset = document.querySelector('[data-testid="factory-reset"]') as HTMLElement;
    return reset.previousElementSibling as HTMLElement;
  }

  /** Card order is [.., header, layout row, keys, ..] — the picker's row sits
   *  between the foldable header and the grid it folds. */
  const headerOf = (keys: HTMLElement): HTMLElement =>
    keys.previousElementSibling!.previousElementSibling as HTMLElement;

  /** Rows are two cells each, so a "row" is a key cell and its action cell. */
  const visibleKeyCells = (keys: HTMLElement): Element[] =>
    [...keys.children].filter((c) => !c.classList.contains(modalStyles.keyOverflow!));

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

  it('names the ? route to the info badges, and no longer a Help gesture', () => {
    const keys = openAbout();
    const text = keys.textContent ?? '';
    expect(text).toContain('Show / hide the info badges');
    // The key itself must be listed, not just described.
    const cells = [...keys.children].map((k) => k.textContent);
    expect(cells).toContain('?');
    // v15 deleted the modifier-click and the long press, so the row that
    // advertised them would now be teaching a gesture that does nothing.
    expect(text).not.toContain('Shift + click Help');
  });

  // onboarding.md REQ-17b — folded is the resting state; the full list is one
  // click away, which is what keeps REQ-17's "names every global key" true.
  it('shows rows through Space by default, and no further', () => {
    const keys = openAbout();
    expect(keys.classList.contains('collapsed')).toBe(true);

    const shown = visibleKeyCells(keys);
    expect(shown).toHaveLength(12); // 6 rows × (key + action)
    expect(shown[10]?.textContent).toBe('Space');
    // The rest are hidden, not absent — same grid, so the columns never jump.
    expect(keys.children.length).toBeGreaterThan(shown.length);
  });

  it('the header row expands the full list and flips the hint to "Show less"', () => {
    const keys = openAbout();
    const header = headerOf(keys);
    expect(header.textContent).toContain('Keyboard Shortcuts');
    // The verb, not a bare "all" — the hint says what the click does.
    expect(header.textContent).toContain('Show all');

    header.click();
    expect(keys.classList.contains('collapsed')).toBe(false);
    expect(header.textContent).toContain('Show less');
    expect(header.textContent).not.toContain('Show all');
    // Every row is now reachable, including the ones past the cut.
    expect(keys.textContent).toContain('Fine knob control');
  });

  // input-control.md REQ-12 — the list mirrors the keys: up above down.
  it('stacks the two pitch-bend keys, and drops the old . binding', () => {
    const keys = openAbout();
    const cells = [...keys.children].map((c) => c.textContent);
    const up = cells.indexOf('Pitch bend up');
    const down = cells.indexOf('Pitch bend down');
    expect(up).toBeGreaterThan(-1);
    expect(down).toBe(up + 2); // the very next row
    expect(cells[up - 1]).toBe("'");
    expect(cells[down - 1]).toBe('/');
    // No combined row survives, and `.` is no longer a key anywhere.
    expect(keys.textContent).not.toContain('Pitch bend up / down');
    expect(cells).not.toContain('.');
  });

  it('remembers the expanded choice separately from the Debug fold', () => {
    const keys = openAbout();
    headerOf(keys).click();
    expect(localStorage.getItem('websynth.shortcuts.about')).toBe('0');
    // Opening Debug must not be what un-folds the shortcuts, or vice versa.
    expect(localStorage.getItem('websynth.debug.about')).not.toBe('0');
  });

  // onboarding.md REQ-20 — the modal is the only tour-replay route.
  it('carries the guided-tour button above the shortcuts header', () => {
    const keys = openAbout();
    const tourBtn = document.querySelector('[data-testid="start-tour"]') as HTMLButtonElement;
    expect(tourBtn).not.toBeNull();
    expect(tourBtn.textContent).toContain('Take the guided tour');

    const card = keys.parentElement!;
    const order = [...card.children];
    expect(order.indexOf(tourBtn)).toBeLessThan(order.indexOf(headerOf(keys)));

    TOUR.startTour.mockClear();
    tourBtn.click();
    expect(TOUR.startTour).toHaveBeenCalledTimes(1);
    // It closes on the way out — the tour needs the screen it is spotlighting.
    expect(document.querySelector('[data-testid="start-tour"]')?.closest('.hidden')).not.toBeNull();
  });

  it('draws every arrow on its own cap in the glyph face (REQ-17)', () => {
    const keys = openAbout();
    const caps = [...keys.querySelectorAll(`.${modalStyles.cap!}`)];
    // Every arrow is a cap of its own carrying the glyph class — the monospace
    // face has no glyph for them, so a bare one renders as an illegible dash.
    const arrows = caps.filter((c) => /[←→↑↓⌫⏮]/.test(c.textContent ?? ''));
    expect(arrows.length).toBeGreaterThan(0);
    for (const a of arrows) {
      expect(a.classList.contains(modalStyles.glyph!)).toBe(true);
      expect(a.textContent).toMatch(/^[←→↑↓⌫⏮]+$/);
    }
    // …and no arrow is left loose as bare text in a cell.
    const loose = [...keys.children].filter((cell) =>
      [...cell.childNodes].some(
        (n) => n.nodeType === Node.TEXT_NODE && /[←→↑↓]/.test(n.textContent ?? ''),
      ),
    );
    expect(loose).toEqual([]);
  });

  // onboarding.md REQ-17c — the row must not read as a keyboard shortcut.
  it('caps only the real key in "Shift + drag"', () => {
    const keys = openAbout();
    const cell = [...keys.children].find((k) => k.textContent === 'Shift + drag');
    expect(cell).toBeTruthy();
    const caps = cell!.querySelectorAll(`.${modalStyles.cap!}`);
    expect(caps).toHaveLength(1);
    expect(caps[0]!.textContent).toBe('Shift');
    // "drag" stays a text node beside it.
    expect([...cell!.childNodes].some((n) => n.nodeType === Node.TEXT_NODE)).toBe(true);
  });

  it('caps only "F" in "F (hold)"', () => {
    const keys = openAbout();
    const cell = [...keys.children].find((k) => k.textContent === 'F (hold)');
    expect(cell).toBeTruthy();
    expect(cell!.querySelectorAll(`.${modalStyles.cap!}`)).toHaveLength(1);
  });
});

// onboarding.md REQ-17c — the note rows are a keyboard diagram derived from the
// real bindings, so it cannot disagree with the keys it documents.
describe('About modal — the note-row keyboard diagram', () => {
  beforeEach(() => {
    installLocalStorageMock();
    resetDetectionForTests();
    writeLayoutPref('qwerty'); // the letters below are QWERTY's, explicitly
    document.body.innerHTML = '';
  });
  afterEach(() => closeOpenModal());

  /** The first key cell in the grid is the lower-octave diagram. */
  function lowerDiagram(): HTMLElement {
    const { engine } = stubEngine();
    document.body.appendChild(createAboutButton(engine, TOUR));
    (document.body.firstElementChild as HTMLButtonElement).click();
    const reset = document.querySelector('[data-testid="factory-reset"]') as HTMLElement;
    const keys = reset.previousElementSibling as HTMLElement;
    return keys.firstElementChild as HTMLElement;
  }

  const rankCaps = (rank: Element): Element[] =>
    [...rank.querySelectorAll(`.${modalStyles.cap!}`)];

  it('lays the naturals and sharps out as two ranks', () => {
    const cell = lowerDiagram();
    expect(cell.children).toHaveLength(2);
    const [sharpRank, naturalRank] = [...cell.children];

    // Sharps on top, offset; naturals below, in order.
    expect(sharpRank!.classList.contains(modalStyles.notesSharps!)).toBe(true);
    expect(rankCaps(naturalRank!).map((c) => c.textContent))
      .toEqual(['Z', 'X', 'C', 'V', 'B', 'N', 'M', ',']);
    expect(
      rankCaps(sharpRank!)
        .filter((c) => !c.classList.contains(modalStyles.capBlank!))
        .map((c) => c.textContent),
    ).toEqual(['S', 'D', 'G', 'H', 'J']);
  });

  it('leaves cap-sized holes where E-F and B-C have no sharp', () => {
    const cell = lowerDiagram();
    const sharpRank = cell.firstElementChild!;
    const slots = rankCaps(sharpRank);
    // One slot per gap between the 8 naturals; two of them are blank.
    expect(slots).toHaveLength(7);
    const blanks = slots
      .map((c, i) => (c.classList.contains(modalStyles.capBlank!) ? i : -1))
      .filter((i) => i >= 0);
    expect(blanks).toEqual([2, 6]); // E-F and B-C
  });

  it('tints the two ranks apart (REQ-17c)', () => {
    const cell = lowerDiagram();
    const [sharpRank, naturalRank] = [...cell.children];
    for (const c of rankCaps(naturalRank!)) {
      expect(c.classList.contains(modalStyles.capNatural!)).toBe(true);
    }
    for (const c of rankCaps(sharpRank!).filter(
      (c) => !c.classList.contains(modalStyles.capBlank!),
    )) {
      expect(c.classList.contains(modalStyles.capSharp!)).toBe(true);
    }
  });

  it('is derived from the note rows — every physical key appears exactly once', () => {
    const cell = lowerDiagram();
    const drawn = rankCaps(cell)
      .filter((c) => !c.classList.contains(modalStyles.capBlank!))
      .map((c) => c.dataset.code);
    expect([...drawn].sort()).toEqual(Object.keys(NOTE_ROWS.lower).sort());
  });

  it('draws the upper octave from its own row, with the same shape', () => {
    const cell = lowerDiagram().nextElementSibling!.nextElementSibling as HTMLElement;
    const drawn = rankCaps(cell)
      .filter((c) => !c.classList.contains(modalStyles.capBlank!))
      .map((c) => c.dataset.code);
    expect([...drawn].sort()).toEqual(Object.keys(NOTE_ROWS.upper).sort());
    // Same two-rank shape as the lower octave — 8 naturals, 5 sharps.
    expect(rankCaps(cell.lastElementChild!)).toHaveLength(8);
  });

  // keyboard-layout.md REQ-4 / onboarding.md REQ-17c.
  it('relabels in place when the layout changes, keeping its shape', () => {
    const cell = lowerDiagram();
    const naturals = () =>
      rankCaps(cell.lastElementChild!).map((c) => c.textContent);
    expect(naturals()).toEqual(['Z', 'X', 'C', 'V', 'B', 'N', 'M', ',']);

    writeLayoutPref('azerty');
    expect(naturals()).toEqual(['W', 'X', 'C', 'V', 'B', 'N', ',', ';']);
    // Structure is the piano's, so it must not have moved.
    expect(rankCaps(cell.firstElementChild!)).toHaveLength(7);
  });
});

// keyboard-layout.md REQ-4 — the gear must not fight the fold it sits in.
describe('About modal — the keyboard-layout picker', () => {
  beforeEach(() => {
    installLocalStorageMock();
    resetDetectionForTests();
    writeLayoutPref('qwerty');
    document.body.innerHTML = '';
  });
  afterEach(() => closeOpenModal());

  function openAbout(): { keys: HTMLElement; gear: HTMLButtonElement; row: HTMLElement } {
    const { engine } = stubEngine();
    document.body.appendChild(createAboutButton(engine, TOUR));
    (document.body.firstElementChild as HTMLButtonElement).click();
    const reset = document.querySelector('[data-testid="factory-reset"]') as HTMLElement;
    const keys = reset.previousElementSibling as HTMLElement;
    return {
      keys,
      gear: document.querySelector('[data-testid="shortcuts-layout-gear"]')!,
      row: keys.previousElementSibling as HTMLElement,
    };
  }

  it('reveals the select without folding the list', () => {
    const { keys, gear, row } = openAbout();
    (keys.previousElementSibling!.previousElementSibling as HTMLElement).click(); // expand the list
    expect(keys.classList.contains('collapsed')).toBe(false);

    expect(row.classList.contains('collapsed')).toBe(true);
    expect(gear.getAttribute('aria-expanded')).toBe('false');

    gear.click();
    expect(row.classList.contains('collapsed')).toBe(false);
    expect(gear.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[data-testid="shortcuts-layout-select"]')).not.toBeNull();
    // The gear's click must never reach the header, which is the fold's trigger.
    expect(keys.classList.contains('collapsed')).toBe(false);

    gear.click();
    expect(row.classList.contains('collapsed')).toBe(true);
    expect(keys.classList.contains('collapsed')).toBe(false);
  });

  // It rendered an empty button once: an inline hdr-icon SVG only gets its size
  // and `stroke: currentColor` from rules scoped to the *header* button classes.
  // The fix was to use the app's existing in-panel gear instead — the same `⚙`
  // the XY Pad's axis-assignment button draws.
  it('draws the same gear glyph as the XY Pad, beside the section title', () => {
    const { gear } = openAbout();
    expect(gear.textContent).toBe('⚙');

    const title = gear.parentElement!;
    expect(title.classList.contains(modalStyles.secFoldTitle!)).toBe(true);
    expect(title.textContent).toContain('Keyboard Shortcuts');
    // Immediately after the label, not adrift at the other end of the header.
    expect(title.children[0]!.textContent).toBe('Keyboard Shortcuts');
    expect(title.children[1]).toBe(gear);
  });

  it('offers auto plus every tabulated layout', () => {
    const { gear } = openAbout();
    gear.click();
    const select = document.querySelector('[data-testid="shortcuts-layout-select"]')!;
    const text = select.textContent ?? '';
    expect(text).toContain('Auto-detect');
    for (const id of Object.keys(LAYOUTS) as Array<keyof typeof LAYOUTS>) {
      expect(text, id).toContain(LAYOUTS[id].label);
    }
  });
});

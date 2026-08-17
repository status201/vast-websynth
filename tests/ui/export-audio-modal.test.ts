// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openExportAudioModal } from '../../src/ui/components/export-audio-modal';
import { MAX_RUNS, type RecorderPhase } from '../../src/audio/recorder/recorder-controller';
import type { StudioApi } from '../../src/ui/studio-api';

/** The export options modal, and the render surface it becomes (REQ-9/REQ-10). */

const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const btn = (id: string) => byId(id) as HTMLButtonElement;

/**
 * Scripted engine: 120 BPM (a 16th is 0.125 s, a bar 2 s) and a recorder whose
 * phase the test drives by hand, so every stage of a render is reachable without
 * an AudioContext.
 */
function harness(over: { songBars?: number; phase?: RecorderPhase } = {}) {
  let phase: RecorderPhase = over.phase ?? 'idle';
  let progress = 0;
  const phaseListeners = new Set<(p: RecorderPhase) => void>();
  const tickListeners = new Set<() => void>();
  const exportSong = vi.fn((_f: string, _o: unknown) => { phase = 'recording'; });
  const cancelExport = vi.fn(() => { phase = 'idle'; });

  const engine = {
    arrangement: { songBars: () => over.songBars ?? 4 },
    // 4/4 — what `registerDefaults` resolves the meter params to, so every
    // assertion here still describes a 16-tick bar (meter.md REQ-6).
    barTicks: 16,

    clock: {
      sixteenthDuration: () => 0.125,
      onTick: (fn: () => void) => { tickListeners.add(fn); return () => tickListeners.delete(fn); },
    },
    recorder: {
      get phase() { return phase; },
      exportProgress: () => progress,
      exportSong,
      cancelExport,
      onPhase: (fn: (p: RecorderPhase) => void) => {
        phaseListeners.add(fn);
        return () => phaseListeners.delete(fn);
      },
    },
  } as unknown as StudioApi;

  return {
    engine,
    exportSong,
    cancelExport,
    tickListeners,
    /** Advance the render and fire the tick the modal repaints on. */
    tick: (ratio: number) => { progress = ratio; for (const l of [...tickListeners]) l(); },
    setPhase: (p: RecorderPhase) => { phase = p; for (const l of [...phaseListeners]) l(p); },
  };
}

const open = (over?: Parameters<typeof harness>[0]) => {
  const h = harness(over);
  openExportAudioModal(h.engine, 'wav');
  return h;
};

beforeEach(() => { document.body.replaceChildren(); });

afterEach(() => {
  // `Modal` binds Escape on WINDOW and only unbinds on close, and it stops
  // immediate propagation — so a modal left open by one test would swallow the
  // Escape a later test dispatches. Clearing document.body orphans the DOM but
  // not the listener. Pop any survivors: each Escape closes exactly one.
  for (let i = 0; i < 8; i++) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  }
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('the options view', () => {
  it('offers format, runs and the tail bar, with the tail CHECKED by default', () => {
    open();
    expect(byId('export-audio-modal')).toBeTruthy();
    expect(byId('export-audio-fmt-wav')).toBeTruthy();
    expect(byId('export-audio-runs')).toBeTruthy();
    // REQ-3's deliberate split: the API defaults tailBar off (the bench needs
    // bar-exact takes), the human-facing checkbox defaults on.
    expect((byId('export-audio-tail') as HTMLInputElement).checked).toBe(true);
  });

  // Format is the choice that renames the button, so it sits with it: what
  // renders (runs, tail) reads first, what gets written reads last.
  it('orders the rows runs → tail → length → format → actions', () => {
    open();
    const order = ['export-audio-runs', 'export-audio-tail', 'export-audio-length',
      'export-audio-fmt-wav', 'export-audio-confirm'].map((id) => byId(id));
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & 4).toBe(4);
    }
  });

  it('offers exactly MAX_RUNS choices, starting at 1', () => {
    open();
    const labels = [...byId('export-audio-runs').querySelectorAll('button')]
      .map((o) => o.textContent).filter((t) => t && /^\d+$/.test(t));
    expect(labels).toContain('1');
    expect(labels).toContain(String(MAX_RUNS));
    expect(labels).not.toContain(String(MAX_RUNS + 1));
  });

  it('names the format on the button that writes the file (REQ-8)', () => {
    open();
    expect(btn('export-audio-confirm').textContent).toBe('Export as WAV');
    btn('export-audio-fmt-mp3').click();
    expect(btn('export-audio-confirm').textContent).toBe('Export as MP3');
  });

  it('shows the render length, and updates it with runs and the tail', () => {
    open();
    // 4 bars + 1 tail bar = 5 × 2 s = 10 s.
    expect(byId('export-audio-length').textContent).toMatch(/4 bars \+ 1 tail bar/);
    expect(byId('export-audio-length').textContent).toMatch(/about 10 s/);

    (byId('export-audio-tail') as HTMLInputElement).click();
    expect(byId('export-audio-length').textContent).toMatch(/about 8 s/);
    expect(byId('export-audio-length').textContent).not.toMatch(/tail bar/);
  });

  it('expresses a long render in minutes — the cost is visible before you commit', () => {
    open({ songBars: 32 });
    expect(byId('export-audio-length').textContent).toMatch(/1 m 06 s/);
  });

  it('disables Export with the reason while the recorder is busy', () => {
    open({ phase: 'recording' });
    expect(btn('export-audio-confirm').disabled).toBe(true);
    expect(btn('export-audio-confirm').title).toMatch(/recording is in progress/);
  });

  it('exports nothing when cancelled', () => {
    const { exportSong } = open();
    btn('export-audio-cancel').click();
    expect(exportSong).not.toHaveBeenCalled();
  });
});

// REQ-10 — the whole point: a real-time render must not happen behind a closed
// dialog. v7.0 closed on confirm and showed nothing for up to ten minutes.
describe('the in-flight view (REQ-10)', () => {
  it('stays open on confirm and swaps the options for a progress bar', () => {
    const { exportSong } = open();
    btn('export-audio-fmt-mp3').click();
    (byId('export-audio-tail') as HTMLInputElement).click();
    btn('export-audio-confirm').click();

    expect(exportSong).toHaveBeenCalledWith('mp3', { runs: 1, tailBar: false });
    // Still on screen — that is the fix.
    expect(byId('export-audio-modal')).toBeTruthy();
    expect(byId('export-audio-progress')).toBeTruthy();
    expect(btn('export-audio-confirm').hidden).toBe(true);
    expect(byId('export-audio-runs').offsetParent).toBeNull(); // options hidden
  });

  it('reports the bar it is on and advances with the transport', () => {
    const { tick } = open();
    btn('export-audio-confirm').click();
    expect(byId('export-audio-status').textContent).toBe('Rendering… bar 1 of 4');

    tick(0.5);
    expect(byId('export-audio-status').textContent).toBe('Rendering… bar 3 of 4');
    expect(byId('export-audio-progress').getAttribute('aria-valuenow')).toBe('50');

    tick(1);
    expect(byId('export-audio-status').textContent).toBe('Rendering… bar 4 of 4');
  });

  it('says it is preparing the download while encoding, not nothing', () => {
    const { setPhase } = open();
    btn('export-audio-confirm').click();
    setPhase('encoding');
    expect(byId('export-audio-status').textContent).toMatch(/preparing your download/i);
    // Nothing left to abort once the audio is captured.
    expect(btn('export-audio-abort').hidden).toBe(true);
  });

  it('confirms completion, then closes itself', () => {
    vi.useFakeTimers();
    const { setPhase } = open();
    btn('export-audio-confirm').click();
    setPhase('encoding');
    setPhase('idle');
    expect(byId('export-audio-status').textContent).toMatch(/done/i);
    expect(byId('export-audio-modal')).toBeTruthy(); // still up, briefly

    vi.advanceTimersByTime(1000);
    expect(document.querySelector('[data-testid="export-audio-modal"]')?.closest('.hidden'))
      .not.toBeNull();
  });

  it('offers a Cancel that really aborts the render', () => {
    const { cancelExport } = open();
    btn('export-audio-confirm').click();
    expect(btn('export-audio-abort').hidden).toBe(false);
    btn('export-audio-abort').click();
    expect(cancelExport).toHaveBeenCalledTimes(1);
  });

  it('cancels the render if the modal is closed any other way', () => {
    const { cancelExport } = open();
    btn('export-audio-confirm').click();
    // Escape — Modal's own binding. The modal is the render's surface, so it
    // must never be dismissed while leaving the render running.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(cancelExport).toHaveBeenCalledTimes(1);
  });

  it('does not cancel anything when closed before confirming', () => {
    const { cancelExport } = open();
    btn('export-audio-cancel').click();
    expect(cancelExport).not.toHaveBeenCalled();
  });

  it('unsubscribes from the clock when it closes', () => {
    const { tickListeners } = open();
    btn('export-audio-confirm').click();
    expect(tickListeners.size).toBe(1);
    btn('export-audio-abort').click();
    expect(tickListeners.size).toBe(0);
  });
});

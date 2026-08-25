// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRecordWindowLauncher, formatElapsed } from '../../src/ui/components/record-window';
import type { RecorderPhase } from '../../src/audio/recorder/recorder-controller';
import type { StudioApi } from '../../src/ui/studio-api';

/**
 * The RECORD window is a pure view over `RecorderController.phase`
 * (record-window.md REQ-2), so a scripted recorder is enough to drive every
 * state — and asserting against one is what proves the window holds no capture
 * state of its own.
 */
function harness(over: { exporting?: boolean } = {}) {
  let phase: RecorderPhase = 'idle';
  let seconds = 0;
  const listeners = new Set<(p: RecorderPhase) => void>();
  const emit = () => { for (const l of listeners) l(phase); };
  const calls: string[] = [];
  const rec = (name: string, next?: RecorderPhase) => () => {
    calls.push(name);
    if (next) { phase = next; emit(); }
  };

  const recorder = {
    get phase() { return phase; },
    isCapturing: () => phase === 'recording' || phase === 'paused',
    isExporting: () => over.exporting ?? false,
    capturedSeconds: () => seconds,
    onPhase: (fn: (p: RecorderPhase) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    startManual: rec('start', 'recording'),
    pauseManual: rec('pause', 'paused'),
    resumeManual: rec('resume', 'recording'),
    stopManual: rec('stop', 'review'),
    saveTake: vi.fn(async (f: string) => { calls.push(`save:${f}`); phase = 'idle'; emit(); }),
    discardTake: rec('discard', 'idle'),
  };

  const api = { recorder } as unknown as StudioApi;
  return {
    api,
    calls,
    setPhase: (p: RecorderPhase) => { phase = p; emit(); },
    setSeconds: (s: number) => { seconds = s; },
    recorder,
  };
}

const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const btn = (id: string) => byId(id) as HTMLButtonElement;
const visible = (id: string) => { const b = btn(id); return !!b && !b.hidden; };

beforeEach(() => { document.body.replaceChildren(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('formatElapsed', () => {
  it('is m:ss, floored, never negative', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(7.9)).toBe('0:07');
    expect(formatElapsed(64)).toBe('1:04');
    expect(formatElapsed(600)).toBe('10:00');
    expect(formatElapsed(-3)).toBe('0:00');
  });
});

describe('the Record window launcher', () => {
  it('keeps the song-record testid and opens a window (REQ-1)', async () => {
    const { api } = harness();
    const l = createRecordWindowLauncher(api, () => 'wav');
    document.body.appendChild(l.el);
    // The id is the stable handle: the help badge and song-mode REQ-13's layout
    // probe both anchor to it.
    expect(l.el.dataset.testid).toBe('song-record');
    expect(l.el.getAttribute('aria-label')).toBe('Open Record window');
    // The "opens a window" glyph is drawn, not typed (iconography.md REQ-1).
    expect(l.el.querySelector('svg.ui-icon')).not.toBeNull();

    expect(byId('record-window')).toBeNull();
    l.el.click();
    expect(byId('record-window')).toBeTruthy();
    // Toggles closed. Idle raises no dialog, but the guard still resolves on a
    // microtask — imperceptible, and the same path every close takes.
    l.el.click();
    await Promise.resolve();
    expect(byId('record-window').classList.contains('hidden')).toBe(true);
  });

  it('shows a capture running behind a CLOSED window (REQ-7)', () => {
    const { api, setPhase } = harness();
    const l = createRecordWindowLauncher(api, () => 'wav');
    document.body.appendChild(l.el);
    expect(l.el.classList.contains('on')).toBe(false);
    setPhase('recording');
    expect(l.el.classList.contains('on')).toBe(true); // never opened the window
    setPhase('idle');
    expect(l.el.classList.contains('on')).toBe(false);
  });
});

describe('the Record window phases (REQ-2)', () => {
  const open = (over?: { exporting?: boolean }) => {
    const h = harness(over);
    const l = createRecordWindowLauncher(h.api, () => 'wav');
    document.body.appendChild(l.el);
    l.el.click();
    return { ...h, launcher: l };
  };

  it('idle offers Record with Stop disabled', () => {
    open();
    expect(visible('record-toggle')).toBe(true);
    expect(btn('record-toggle').textContent).toBe('Record');
    expect(btn('record-stop').disabled).toBe(true);
    expect(visible('record-save')).toBe(false);
    expect(visible('record-discard')).toBe(false);
    expect(byId('record-timer').textContent).toBe('0:00');
  });

  it('drives the recorder through record → pause → resume → stop', () => {
    const { calls } = open();
    btn('record-toggle').click();
    expect(btn('record-toggle').textContent).toBe('Pause');
    expect(btn('record-stop').disabled).toBe(false);

    btn('record-toggle').click();
    expect(btn('record-toggle').textContent).toBe('Resume');

    btn('record-toggle').click();
    btn('record-stop').click();
    expect(calls).toEqual(['start', 'pause', 'resume', 'stop']);
  });

  it('says the transport keeps playing while the RECORDER is paused (REQ-3)', () => {
    const { setPhase } = open();
    setPhase('paused');
    expect(byId('record-status').textContent).toContain('PAUSED');
    expect(byId('record-status').textContent).toMatch(/transport is still playing/i);
    setPhase('recording');
    expect(btn('record-toggle').title).toMatch(/transport keeps playing/i);
  });

  it('swaps to Save / Discard in review, and Save names the format (REQ-2/REQ-10)', () => {
    const { setPhase, recorder } = open();
    setPhase('review');
    expect(visible('record-toggle')).toBe(false);
    expect(visible('record-stop')).toBe(false);
    expect(btn('record-save').textContent).toBe('Save as WAV');

    btn('record-fmt-mp3').click();
    expect(btn('record-save').textContent).toBe('Save as MP3');
    btn('record-save').click();
    expect(recorder.saveTake).toHaveBeenCalledWith('mp3');
  });

  it('pulses the dot only while recording (REQ-6)', () => {
    const { setPhase } = open();
    const dot = byId('record-status').firstElementChild!;
    const lit = () => [...dot.classList].some((c) => c.includes('live'));
    expect(lit()).toBe(false);
    setPhase('recording');
    expect(lit()).toBe(true);
    setPhase('paused');
    expect(lit()).toBe(false); // the pulse must never outlive the capture
  });

  it('reads the elapsed time off the recorder, not a stopwatch (REQ-4)', () => {
    const { setSeconds, setPhase } = open();
    setSeconds(64);
    setPhase('recording'); // any phase change repaints
    expect(byId('record-timer').textContent).toBe('1:04');
  });

  // REQ-4 regression: the window showed the PREVIOUS take's length once the
  // recorder went idle, which reads as a recording you still have.
  it('clears the timer when the recorder reports no take', () => {
    const { setSeconds, setPhase } = open();
    setSeconds(94);
    setPhase('review');
    expect(byId('record-timer').textContent).toBe('1:34');

    setSeconds(0); // what capturedSeconds() returns once idle
    setPhase('idle');
    expect(byId('record-timer').textContent).toBe('0:00');
  });

  // REQ-11: an export walks the SAME phases, so a phase-only render would show
  // "REC" and a climbing timer for a capture that isn't the user's.
  it('names an export as an export rather than showing it as your take', () => {
    const { setPhase, setSeconds } = open({ exporting: true });
    setSeconds(37);
    setPhase('recording'); // what an export pass does to the phase

    expect(byId('record-status').textContent).toMatch(/exporting the song/i);
    expect(byId('record-status').textContent).not.toMatch(/REC/);
    expect(byId('record-timer').textContent).toBe('0:00'); // no take of yours
    const dot = byId('record-status').firstElementChild!;
    expect([...dot.classList].some((c) => c.includes('live'))).toBe(false);

    for (const id of ['record-toggle', 'record-stop']) {
      expect(btn(id).disabled).toBe(true);
      expect(btn(id).title).toMatch(/exporting/i);
    }
    // …and never Save/Discard for a buffer the user never made.
    expect(visible('record-save')).toBe(false);
    expect(visible('record-discard')).toBe(false);
  });

  it('does not light the launcher for an export either (REQ-7/REQ-11)', () => {
    const h = harness({ exporting: true });
    const l = createRecordWindowLauncher(h.api, () => 'wav');
    document.body.appendChild(l.el);
    h.setPhase('recording'); // an export pass moves the same phase
    expect(l.el.classList.contains('on')).toBe(false);
  });

  it('seeds the format from the Song tab default without writing back (REQ-10)', () => {
    const h = harness();
    let songDefault: 'wav' | 'mp3' = 'mp3';
    const l = createRecordWindowLauncher(h.api, () => songDefault);
    document.body.appendChild(l.el);
    l.el.click();
    expect(btn('record-fmt-mp3').classList.contains('active')).toBe(true);

    // Overriding here must not reach back out to the Song tab's setting.
    btn('record-fmt-wav').click();
    expect(songDefault).toBe('mp3');
  });
});

describe('closing with a take in flight (REQ-8)', () => {
  const openWindow = (phase: RecorderPhase) => {
    const h = harness();
    const l = createRecordWindowLauncher(h.api, () => 'wav');
    document.body.appendChild(l.el);
    l.el.click();
    h.setPhase(phase);
    const win = byId('record-window');
    return { ...h, win, close: () => (win.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click() };
  };

  it('closes an idle window with no dialog at all', async () => {
    const { win, close } = openWindow('idle');
    close();
    await Promise.resolve();
    expect(document.querySelector('[data-testid="dialog-confirm"]')).toBeNull();
    expect(win.classList.contains('hidden')).toBe(true);
  });

  for (const phase of ['recording', 'paused', 'review'] as const) {
    it(`asks before closing while ${phase}, and cancelling keeps the take`, async () => {
      const { win, close, calls } = openWindow(phase);
      close();
      await Promise.resolve();

      const cancel = document.querySelector('[data-testid="dialog-cancel"]') as HTMLButtonElement;
      expect(cancel).toBeTruthy();
      cancel.click();
      await Promise.resolve();
      expect(win.classList.contains('hidden')).toBe(false); // still open
      expect(calls).not.toContain('discard');
    });
  }

  it('confirming discards the take and closes', async () => {
    const { win, close, calls } = openWindow('review');
    close();
    await Promise.resolve();
    (document.querySelector('[data-testid="dialog-confirm"]') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toContain('discard');
    expect(win.classList.contains('hidden')).toBe(true);
  });
});

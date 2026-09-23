// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openRecordSoundModal } from '../../src/ui/components/record-sound-modal';
import type { StudioApi } from '../../src/ui/studio-api';
import type { CapturedAudio } from '../../src/audio/recorder/node';

// The record path's mic session, so a take can be held mid-stop
// (sample-recorder.md REQ-the-editor-owns-its-teardown, v8). The tests above open with a
// source clip and never reach it.
const mic = vi.hoisted(() => ({
  resolveStop: null as ((c: import('../../src/audio/recorder/node').CapturedAudio) => void) | null,
  disposed: 0,
}));
vi.mock('../../src/audio/recorder/mic-capture', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/audio/recorder/mic-capture')>();
  return {
    ...real,
    openMicSession: async () => ({
      start: () => {},
      stop: () => new Promise((res) => { mic.resolveStop = res; }),
      dispose: () => { mic.disposed++; },
    }),
  };
});

/**
 * sample-recorder.md REQ-the-editor-owns-its-teardown. The bug this pins: the
 * editor builds seven `Dropdown`s, each of which registers four listeners
 * OUTSIDE its own subtree (`click`/`keydown` on `document`, `scroll`/`resize` on
 * `window`) and removes them only in `destroy()`. `cleanup()` disposed the
 * session, the scratch graph and the ResizeObserver but never the dropdowns, so
 * every open-and-close left 28 handlers running on every click and keystroke in
 * the app — and "Edit sample" sits on every loaded slot.
 *
 * Counting listeners rather than asserting on `destroy` spies is deliberate: it
 * is the property that actually matters, and it keeps holding if a control is
 * swapped for a different one that also owns global listeners.
 */

function clip(): CapturedAudio {
  const n = 4800;
  return { left: new Float32Array(n), right: new Float32Array(n), sampleRate: 48000 };
}

function harness() {
  const engine = {
    barTicks: 16,
    clock: { bpm: 120, sixteenthDuration: () => 0.125 },
    ctx: {
      currentTime: 0,
      sampleRate: 48000,
      destination: {},
      createBufferSource: () => ({
        connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(),
        buffer: null, playbackRate: { value: 1 },
      }),
    },
    patterns: { sampleNames: () => Array<string | null>(8).fill(null), setSampleName: vi.fn() },
    sampler: { buffers: () => Array<AudioBuffer | null>(8).fill(null), setBuffer: vi.fn() },
  } as unknown as StudioApi;
  return engine;
}

/** Tally add/remove per target so an imbalance names the event that leaked. */
function trackListeners(target: EventTarget, label: string) {
  const counts = new Map<string, number>();
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  const addSpy = vi.spyOn(target, 'addEventListener').mockImplementation(((t: string, ...rest: unknown[]) => {
    counts.set(t, (counts.get(t) ?? 0) + 1);
    return (add as (...a: unknown[]) => void)(t, ...rest);
  }) as typeof target.addEventListener);
  const removeSpy = vi.spyOn(target, 'removeEventListener').mockImplementation(((t: string, ...rest: unknown[]) => {
    counts.set(t, (counts.get(t) ?? 0) - 1);
    return (remove as (...a: unknown[]) => void)(t, ...rest);
  }) as typeof target.removeEventListener);
  return {
    label,
    /** Event types still holding more adds than removes. */
    outstanding: (): Record<string, number> =>
      Object.fromEntries([...counts].filter(([, n]) => n > 0)),
    restore: () => { addSpy.mockRestore(); removeSpy.mockRestore(); },
  };
}

describe('record-sound modal teardown (REQ-the-editor-owns-its-teardown)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    // The editor observes its waveform; jsdom has no ResizeObserver.
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const close = (): void => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  };

  it('removes every document and window listener it added', () => {
    const doc = trackListeners(document, 'document');
    const win = trackListeners(window, 'window');

    openRecordSoundModal(harness(), { slot: 0, source: clip() });
    close();

    expect(doc.outstanding()).toEqual({});
    expect(win.outstanding()).toEqual({});
    doc.restore();
    win.restore();
  });

  it('does not accumulate across repeated opens', () => {
    const doc = trackListeners(document, 'document');
    const win = trackListeners(window, 'window');

    // The "opened and closed twenty times" case from the spec, scaled down: any
    // per-open residue shows as a multiple here rather than a single stray.
    for (let i = 0; i < 5; i++) {
      openRecordSoundModal(harness(), { slot: 0, source: clip() });
      close();
    }

    expect(doc.outstanding()).toEqual({});
    expect(win.outstanding()).toEqual({});
    doc.restore();
    win.restore();
  });
});

describe('record-sound modal closed while a take finishes (v8, REQ-the-editor-owns-its-teardown)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  });
  afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

  it('builds no editor, and leaks nothing, when closed before the stop resolves (regression)', async () => {
    const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    const doc = trackListeners(document, 'document');
    const win = trackListeners(window, 'window');

    openRecordSoundModal(harness(), { slot: 0 });
    const rec = (): HTMLButtonElement =>
      document.querySelector<HTMLButtonElement>('[data-testid="mic-record-toggle"]')!;
    rec().click();          // open the mic, start the take
    await flush();
    rec().click();          // stop: the final batch is now in flight
    await flush();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); // close meanwhile
    mic.resolveStop!(clip()); // the take lands after the close
    await flush();

    expect(mic.disposed).toBeGreaterThan(0);
    // The bug: the editor — seven dropdowns, each with document/window
    // listeners — was built into the closed card, after its only cleanup.
    expect(document.querySelector('.dropdown')).toBeNull(); // the editor's controls
    expect(doc.outstanding()).toEqual({});
    expect(win.outstanding()).toEqual({});
    doc.restore();
    win.restore();
  });
});

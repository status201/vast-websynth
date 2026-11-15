// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  openRecordSoundModal as openStudioRaw, resetStudioMemory, MAX_TAKE_SECONDS, UNDO_DEPTH,
  type RecordSoundOptions,
} from '../../src/ui/components/record-sound-modal';
import type { StudioApi } from '../../src/ui/studio-api';
import type { CapturedAudio } from '../../src/audio/recorder/node';

/**
 * The sample studio (sample-recorder.md). Its mic session is mocked so a take
 * can be held mid-stop and its start time chosen; everything else is the real
 * studio over a stub engine.
 */
const mic = vi.hoisted(() => ({
  resolveStop: null as ((c: import('../../src/audio/recorder/node').CapturedAudio) => void) | null,
  disposed: 0,
  started: 0,
  startedAt: 0,
}));
vi.mock('../../src/audio/recorder/mic-capture', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/audio/recorder/mic-capture')>();
  return {
    ...real,
    openMicSession: async () => ({
      get startedAt() { return mic.startedAt; },
      start: () => { mic.started++; },
      stop: () => new Promise((res) => { mic.resolveStop = res; }),
      level: () => ({ peak: 0.1, rms: 0.05 }),
      dispose: () => { mic.disposed++; },
    }),
  };
});

const SR = 48000;

/** The studio with a stub for the header's Play — the only way it moves the transport. */
const toggleTransport = vi.fn();
function openStudio(engine: StudioApi, o: Omit<RecordSoundOptions, 'toggleTransport'> = {}): void {
  openStudioRaw(engine, { toggleTransport, ...o });
}

function clip(n = 4800): CapturedAudio {
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  // A ramp, so where a crop started is readable from the first sample.
  for (let i = 0; i < n; i++) { left[i] = i / n; right[i] = i / n; }
  return { left, right, sampleRate: SR };
}

const param = () => ({
  value: 0,
  setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(),
});

function harness() {
  const setBuffer = vi.fn();
  const ctx = {
    currentTime: 0,
    sampleRate: SR,
    destination: {},
    createBufferSource: () => ({
      connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(),
      buffer: null, playbackRate: { value: 1 },
    }),
    // The metronome's click (metronome.md REQ-the-click-is-outside-the-master-bus).
    createOscillator: () => ({
      type: 'sine', frequency: { value: 0 }, onended: null,
      connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(),
    }),
    createGain: () => ({ gain: param(), connect: vi.fn(), disconnect: vi.fn() }),
    // capturedToAudioBuffer — enough of an AudioBuffer to read back.
    createBuffer: (_ch: number, length: number, sampleRate: number) => {
      const data = [new Float32Array(length), new Float32Array(length)];
      return { length, sampleRate, getChannelData: (c: number) => data[c]! };
    },
  };
  const engine = {
    barTicks: 16,
    beatTicks: 4,
    clock: {
      bpm: 120,
      playing: false,
      step: 0,
      sixteenthDuration: () => 0.125,
      toggle: vi.fn(),
      onTick: () => () => {},
      onStart: () => () => {},
      onStop: () => () => {},
    },
    ctx,
    patterns: { sampleNames: Array<string | null>(8).fill(null), setSampleName: vi.fn() },
    sampler: { buffers: Array<AudioBuffer | null>(8).fill(null), setBuffer },
    clipPreview: { playing: false, startTime: 0, samples: 0, play: vi.fn(), stop: vi.fn() },
  };
  return { engine: engine as unknown as StudioApi, ctx, setBuffer };
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

const flush = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
const q = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.querySelector<T>(`[data-testid="${id}"]`);
const studioOpen = (): boolean => q('mic-close') !== null
  && !q('mic-close')!.closest('.hidden');
const escape = (): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
};
/** Answer the open confirm. */
const answer = async (yes: boolean): Promise<void> => {
  const id = yes ? 'dialog-confirm' : 'dialog-cancel';
  const btns = document.querySelectorAll<HTMLButtonElement>(`[data-testid="${id}"]`);
  btns[btns.length - 1]!.click();
  await flush();
};
const confirmShowing = (): boolean =>
  [...document.querySelectorAll('[data-testid="dialog-confirm"]')]
    .some((b) => !b.closest('.hidden'));

/** Open the Record screen and wait for the (mock) mic. */
async function openRecord(h = harness()) {
  openStudio(h.engine, { slot: 0 });
  await flush();
  return h;
}

/** Record a take of `c` and land on the Edit screen. */
async function recordTake(c = clip()): Promise<void> {
  q<HTMLButtonElement>('mic-record-toggle')!.click(); // start
  q<HTMLButtonElement>('mic-record-toggle')!.click(); // stop
  await flush();
  mic.resolveStop!(c);
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = '';
  resetStudioMemory();
  mic.resolveStop = null;
  mic.disposed = 0;
  mic.started = 0;
  mic.startedAt = 0;
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

describe('record-sound studio teardown (REQ-the-editor-owns-its-teardown)', () => {
  it('removes every document and window listener it added', () => {
    const doc = trackListeners(document, 'document');
    const win = trackListeners(window, 'window');

    openStudio(harness().engine, { slot: 0, source: clip() });
    escape(); // untouched audio closes without asking

    expect(doc.outstanding()).toEqual({});
    expect(win.outstanding()).toEqual({});
    doc.restore();
    win.restore();
  });

  it('does not accumulate across repeated opens', () => {
    const doc = trackListeners(document, 'document');
    const win = trackListeners(window, 'window');

    for (let i = 0; i < 5; i++) {
      openStudio(harness().engine, { slot: 0, source: clip() });
      escape();
    }

    expect(doc.outstanding()).toEqual({});
    expect(win.outstanding()).toEqual({});
    doc.restore();
    win.restore();
  });

  it('builds no editor, and leaks nothing, when closed before the stop resolves (regression)', async () => {
    const doc = trackListeners(document, 'document');
    const win = trackListeners(window, 'window');

    await openRecord();
    q<HTMLButtonElement>('mic-record-toggle')!.click(); // start the take
    q<HTMLButtonElement>('mic-record-toggle')!.click(); // stop: the final batch is now in flight
    await flush();
    escape();               // close meanwhile — a take in progress asks first
    expect(confirmShowing()).toBe(true);
    await answer(true);
    mic.resolveStop!(clip()); // the take lands after the close
    await flush();

    expect(mic.disposed).toBeGreaterThan(0);
    // The editor — its dropdowns hold document/window listeners — must not be
    // built into the closed card, after its only cleanup.
    expect(document.querySelector('.dropdown')).toBeNull();
    expect(doc.outstanding()).toEqual({});
    expect(win.outstanding()).toEqual({});
    doc.restore();
    win.restore();
  });
});

describe('nothing closes the studio by accident (REQ-nothing-closes-the-studio-by-accident)', () => {
  it('a backdrop click does nothing', async () => {
    await openRecord();
    await recordTake();
    const backdrop = q('mic-close')!.closest('[role="dialog"]')!.parentElement!;
    backdrop.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await flush();
    expect(studioOpen()).toBe(true);
    expect(confirmShowing()).toBe(false);
    q<HTMLButtonElement>('mic-load')!.click();
  });

  it('Escape with unsaved audio asks, and Keep editing keeps it', async () => {
    await openRecord();
    await recordTake();
    expect(q('rec-screen-edit')).not.toBeNull();

    escape();
    expect(confirmShowing()).toBe(true);
    await answer(false);
    expect(studioOpen()).toBe(true);
    expect(q('rec-screen-edit')).not.toBeNull();

    q<HTMLButtonElement>('mic-load')!.click(); // saved: now it closes
    expect(studioOpen()).toBe(false);
  });

  it('the ✕ asks too, and Discard closes', async () => {
    await openRecord();
    await recordTake();
    q<HTMLButtonElement>('mic-close')!.click();
    await flush();
    expect(confirmShowing()).toBe(true);
    await answer(true);
    expect(studioOpen()).toBe(false);
  });

  it('untouched audio closes straight away (edge)', () => {
    openStudio(harness().engine, { slot: 0, source: clip() });
    escape();
    expect(confirmShowing()).toBe(false);
    expect(studioOpen()).toBe(false);
  });

  it('a downloaded take closes without asking', async () => {
    const created = vi.fn(() => 'blob:x');
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = created;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
    await openRecord();
    await recordTake();
    q<HTMLButtonElement>('mic-save-wav')!.click();
    escape();
    expect(confirmShowing()).toBe(false);
    expect(studioOpen()).toBe(false);
  });
});

describe('a discarded take comes back (REQ-a-discarded-take-can-be-restored)', () => {
  it('offers the discarded take on the next open, as unsaved audio', async () => {
    const h = await openRecord();
    await recordTake(clip(9600));
    escape();
    await answer(true);
    expect(studioOpen()).toBe(false);

    await openRecord(h);
    const restore = q<HTMLButtonElement>('rec-restore');
    expect(restore).not.toBeNull();
    restore!.click();
    await flush();
    expect(q('rec-screen-edit')).not.toBeNull();
    expect(q('mic-status')!.textContent).toMatch(/Restored/);

    // Unsaved: closing asks again.
    escape();
    expect(confirmShowing()).toBe(true);
    await answer(false);
    q<HTMLButtonElement>('mic-load')!.click();
    expect(h.setBuffer).toHaveBeenCalledTimes(1);
    expect(h.setBuffer.mock.calls[0]![1].length).toBe(9600);
  });
});

describe('undo is a stack (REQ-undo-is-a-stack)', () => {
  it('walks several edits back and forward, inside its depth', async () => {
    openStudio(harness().engine, { slot: 0, source: clip() });
    const undo = q<HTMLButtonElement>('mic-undo')!;
    const redo = q<HTMLButtonElement>('mic-redo')!;
    expect(undo.disabled).toBe(true);
    expect(redo.disabled).toBe(true);

    for (let i = 0; i < 3; i++) {
      q<HTMLButtonElement>('mic-fx-reverse')!.click();
      await flush();
    }
    for (let i = 0; i < 3; i++) undo.click();
    expect(undo.disabled).toBe(true);
    expect(redo.disabled).toBe(false);
    redo.click();
    expect(undo.disabled).toBe(false);

    // A new edit clears Redo.
    q<HTMLButtonElement>('mic-fx-reverse')!.click();
    await flush();
    expect(redo.disabled).toBe(true);

    // Never deeper than UNDO_DEPTH.
    for (let i = 0; i < UNDO_DEPTH + 4; i++) {
      q<HTMLButtonElement>('mic-fx-reverse')!.click();
      await flush();
    }
    let undos = 0;
    while (!undo.disabled && undos < 100) { undo.click(); undos++; }
    expect(undos).toBe(UNDO_DEPTH);
  });
});

describe('the record screen (REQ-the-record-screen-shows-every-state)', () => {
  it('opens the mic with the screen and records on one press', async () => {
    await openRecord();
    const btn = q<HTMLButtonElement>('mic-record-toggle')!;
    expect(btn.dataset.state).toBe('ready');
    expect(q('mic-meter')).not.toBeNull();
    btn.click();
    expect(mic.started).toBe(1);
    expect(btn.dataset.state).toBe('recording');
    escape();
    await answer(true);
  });

  it('R records and stops while the Record screen shows', async () => {
    await openRecord();
    const press = (): void => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
    };
    press();
    expect(q<HTMLButtonElement>('mic-record-toggle')!.dataset.state).toBe('recording');
    press();
    await flush();
    mic.resolveStop!(clip());
    await flush();
    expect(q('rec-screen-edit')).not.toBeNull();
    q<HTMLButtonElement>('mic-load')!.click();
  });

  it('a take stops itself at the bound (REQ-a-take-is-bounded, edge)', async () => {
    const h = await openRecord();
    q<HTMLButtonElement>('mic-record-toggle')!.click();
    h.ctx.currentTime = MAX_TAKE_SECONDS + 0.5;
    await flush(120); // the watch runs every 50 ms
    expect(mic.resolveStop).not.toBeNull();
    mic.resolveStop!(clip());
    await flush();
    expect(q('rec-screen-edit')).not.toBeNull();
    expect(q('mic-status')!.textContent).toMatch(/limit/);
    q<HTMLButtonElement>('mic-load')!.click();
  });
});

describe('count-in (REQ-count-in-lands-the-take-on-a-downbeat)', () => {
  it('drops the pre-roll so the take begins on the counted downbeat', async () => {
    const h = await openRecord();
    q<HTMLInputElement>('mic-countin')!.checked = true;
    mic.startedAt = 0;
    const btn = q<HTMLButtonElement>('mic-record-toggle')!;
    btn.click();
    expect(btn.dataset.state).toBe('counting');

    // 120 BPM in 4/4: a beat is 0.5 s, the count one bar, after a 0.1 s lead.
    const downbeat = 0.1 + 4 * 0.5;
    h.ctx.currentTime = downbeat + 0.05;
    await flush(120);
    expect(btn.dataset.state).toBe('recording');

    btn.click();
    await flush();
    const total = SR * 4;
    mic.resolveStop!(clip(total));
    await flush();
    q<HTMLButtonElement>('mic-load')!.click();

    const buf = h.setBuffer.mock.calls[0]![1] as { length: number; getChannelData(c: number): Float32Array };
    const pre = Math.round(downbeat * SR);
    expect(buf.length).toBe(total - pre);
    // The ramp's value at the downbeat is the take's first sample.
    expect(buf.getChannelData(0)[0]).toBeCloseTo(pre / total, 5);
  });
});

describe('one primary action (REQ-one-primary-action-per-screen)', () => {
  it('a fresh recording aims at the first empty slot and is named for it', async () => {
    const h = harness();
    (h.engine.sampler.buffers as unknown as Array<unknown>)[0] = {};
    (h.engine.patterns.sampleNames as unknown as Array<string | null>)[0] = 'kick.wav';
    await openRecord(h);
    await recordTake();
    const load = q<HTMLButtonElement>('mic-load')!;
    expect(load.textContent).toMatch(/Load into S2/);
    load.click();
    expect(h.setBuffer.mock.calls[0]![0]).toBe(1);
    expect(h.engine.patterns.setSampleName).toHaveBeenCalledWith(1, 'recording-S2');
    expect(q('mic-load-toast')).not.toBeNull();
  });

  it('an edit offers to replace its own slot and keeps its name', () => {
    const h = harness();
    (h.engine.sampler.buffers as unknown as Array<unknown>)[2] = {};
    (h.engine.patterns.sampleNames as unknown as Array<string | null>)[2] = 'break.wav';
    openStudio(h.engine, { slot: 2, source: clip() });
    const load = q<HTMLButtonElement>('mic-load')!;
    expect(load.textContent).toMatch(/Replace S3/);
    load.click();
    expect(h.setBuffer.mock.calls[0]![0]).toBe(2);
    expect(h.engine.patterns.setSampleName).toHaveBeenCalledWith(2, 'break.wav');
  });
});

describe('the tools are tabs (REQ-the-tools-are-tabs)', () => {
  it('opens on Effects and shows one page at a time', () => {
    openStudio(harness().engine, { slot: 0, source: clip() });
    const visible = (id: string): boolean => q(`ppage-sample-${id}`)!.classList.contains('visible');
    expect(visible('effects')).toBe(true);
    expect(visible('chop')).toBe(false);
    q<HTMLButtonElement>('ptab-sample-stretch')!.click();
    expect(visible('stretch')).toBe(true);
    expect(visible('effects')).toBe(false);
    escape();
  });
});

describe('fixes found in review', () => {
  it('R does nothing while a confirmation sits over the studio', async () => {
    await openRecord();
    q<HTMLButtonElement>('mic-record-toggle')!.click(); // recording
    escape();                                            // "Stop and discard?" is up
    expect(confirmShowing()).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
    expect(q<HTMLButtonElement>('mic-record-toggle')!.dataset.state).toBe('recording');
    await answer(true);
  });

  it('a new take recorded from an opened slot is named as a fresh recording', async () => {
    const h = harness();
    (h.engine.sampler.buffers as unknown as Array<unknown>)[2] = {};
    (h.engine.patterns.sampleNames as unknown as Array<string | null>)[2] = 'break.wav';
    openStudio(h.engine, { slot: 2, source: clip() });
    q<HTMLButtonElement>('mic-rerecord')!.click(); // untouched: no question
    await flush();
    await recordTake();
    q<HTMLButtonElement>('mic-load')!.click();
    expect(h.engine.patterns.setSampleName).toHaveBeenCalledWith(2, 'recording-S3');
  });
});

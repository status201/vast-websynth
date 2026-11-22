// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  openRecordSoundModal, resetStudioMemory,
} from '../../src/ui/components/record-sound-modal';
import type { StudioApi } from '../../src/ui/studio-api';
import type { CapturedAudio } from '../../src/audio/recorder/node';

/**
 * The sample studio's Vocoder tab (vocoder.md). The mic session and the
 * metronome are mocked, so a take's timing and the click hold can be read; the
 * studio, the page and the DSP are real, over a stub engine whose preview
 * player keeps a `playing` flag.
 */
const mic = vi.hoisted(() => ({
  opened: 0,
  started: 0,
  disposed: 0,
  resolveStop: null as ((c: import('../../src/audio/recorder/node').CapturedAudio) => void) | null,
}));
vi.mock('../../src/audio/recorder/mic-capture', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/audio/recorder/mic-capture')>();
  return {
    ...real,
    openMicSession: async () => {
      mic.opened++;
      return {
        startedAt: 0,
        firstFrame: 0,
        inputLatency: () => 0,
        start: () => { mic.started++; },
        stop: () => new Promise((res) => { mic.resolveStop = res; }),
        level: () => ({ peak: 0.2, rms: 0.1 }),
        dispose: () => { mic.disposed++; },
      };
    },
  };
});

const metro = vi.hoisted(() => ({ click: true, setClick: [] as boolean[] }));
vi.mock('../../src/audio/metronome', () => ({
  createMetronome: () => ({
    acquire: () => () => {},
    get click() { return metro.click; },
    setClick: (on: boolean) => { metro.click = on; metro.setClick.push(on); },
    onBeat: () => () => {},
    beatDuration: () => 0.5,
    countIn: () => 0,
    cancelCountIn: () => {},
  }),
}));

const SR = 48000;
const toggleTransport = vi.fn();

function noise(n: number, seed: number): Float32Array {
  let s = seed;
  return Float32Array.from({ length: n }, () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 0x100000000) * 2 - 1;
  });
}
const clip = (n = 4800): CapturedAudio => ({ left: noise(n, 1), right: noise(n, 2), sampleRate: SR });

function fakeBuffer(n: number): AudioBuffer {
  const ch = [noise(n, 3), noise(n, 4)];
  return { length: n, sampleRate: SR, numberOfChannels: 2, getChannelData: (c: number) => ch[c]! } as unknown as AudioBuffer;
}

const param = () => ({
  value: 0,
  setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(),
});

function harness() {
  const ctx = {
    currentTime: 0,
    sampleRate: SR,
    destination: {},
    createGain: () => ({ gain: param(), connect: vi.fn(), disconnect: vi.fn() }),
    createBuffer: (_ch: number, length: number, sampleRate: number) => {
      const data = [new Float32Array(length), new Float32Array(length)];
      return { length, sampleRate, getChannelData: (c: number) => data[c]! };
    },
  };
  /** The audition player: what it last played, and whether it still plays. */
  const preview = {
    playing: false,
    startTime: 0,
    samples: 0,
    last: null as CapturedAudio | null,
    play: vi.fn((c: CapturedAudio) => {
      preview.playing = true;
      preview.startTime = ctx.currentTime;
      preview.samples = c.left.length;
      preview.last = c;
    }),
    stop: vi.fn(() => { preview.playing = false; }),
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
    sampler: { buffers: Array<AudioBuffer | null>(8).fill(null), setBuffer: vi.fn() },
    clipPreview: preview,
  };
  return { engine: engine as unknown as StudioApi, raw: engine, ctx, preview };
}

const flush = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
const q = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.querySelector<T>(`[data-testid="${id}"]`);
/** Open a dropdown (its options are built on open) and list them. */
const optionButtons = (id: string): HTMLButtonElement[] => {
  q(id)!.querySelector<HTMLButtonElement>('button')!.click();
  return [...q(id)!.querySelectorAll<HTMLButtonElement>('.dropdown-option')];
};

/** Open a clip in the editor on the Vocoder tab. */
function openOnVocoder(h: ReturnType<typeof harness>, c = clip()): void {
  openRecordSoundModal(h.engine, { slot: 0, source: c, toggleTransport });
  q<HTMLButtonElement>('ptab-sample-vocoder')!.click();
  // The toolbar's CLICK, turned on — the take must silence it and put it back.
  metro.click = true;
}

beforeEach(() => {
  document.body.innerHTML = '';
  resetStudioMemory();
  Object.assign(mic, { opened: 0, started: 0, disposed: 0, resolveStop: null });
  Object.assign(metro, { click: true, setClick: [] });
  toggleTransport.mockClear();
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

describe('the Vocoder tab (REQ-the-studio-hosts-a-vocoder-tab, REQ-audition-before-apply)', () => {
  it('waits for a voice, and disables the slots with no audio', () => {
    openOnVocoder(harness());
    expect(q('voc-page')).not.toBeNull();
    expect(q<HTMLButtonElement>('voc-apply')!.disabled).toBe(true);
    expect(q<HTMLButtonElement>('voc-audition')!.disabled).toBe(true);
    expect(q('voc-hint')!.textContent).toMatch(/Record a voice/);
    const slots = optionButtons('voc-source').filter((b) => b.textContent!.startsWith('S'));
    expect(slots.length).toBe(8);
    expect(slots.every((b) => b.disabled)).toBe(true);
  });

  it('applies a slot voice through the undo stack', async () => {
    const h = harness();
    h.raw.sampler.buffers[1] = fakeBuffer(4800);
    h.raw.patterns.sampleNames[1] = 'voice.wav';
    openOnVocoder(h);
    const s2 = optionButtons('voc-source').find((b) => b.textContent!.startsWith('S2'))!;
    expect(s2.disabled).toBe(false);
    s2.click();
    expect(q<HTMLButtonElement>('voc-apply')!.disabled).toBe(false);

    q<HTMLButtonElement>('voc-apply')!.click();
    await flush(60);
    expect(q('mic-status')!.textContent).toMatch(/^Vocode applied/);
    expect(q<HTMLButtonElement>('mic-undo')!.disabled).toBe(false);
    q<HTMLButtonElement>('mic-undo')!.click();
    expect(q('mic-status')!.textContent).toMatch(/^Undone/);
  });
});

describe('the voice take (REQ-the-voice-take-follows-the-carrier, REQ-the-voice-take-owns-its-teardown)', () => {
  it('stops the song, silences the click, plays the cue and keeps the voice', async () => {
    const h = harness();
    h.raw.clock.playing = true;
    openOnVocoder(h, clip(4800)); // 0.1 s — shorter than a bar, so the cue is the whole clip
    q<HTMLButtonElement>('voc-record')!.click();
    await flush();

    expect(toggleTransport).toHaveBeenCalledTimes(1);
    expect([mic.opened, mic.started]).toEqual([1, 1]);
    expect(metro.click).toBe(false);
    expect(h.preview.last!.left.length).toBe(9600); // the cue, then the carrier
    expect(q('voc-state')!.textContent).toMatch(/Get ready/);

    // The pass is heard from 0.1 s to 0.2 s; the take stops itself past it.
    h.ctx.currentTime = 0.15;
    await flush(80);
    expect(q('voc-state')!.textContent).toMatch(/Sing now/);
    h.ctx.currentTime = 2;
    await flush(80);
    expect(mic.resolveStop).not.toBeNull();
    mic.resolveStop!(clip(SR));
    await flush();

    expect(mic.disposed).toBe(1);
    expect(metro.click).toBe(true);
    expect(q<HTMLButtonElement>('voc-apply')!.disabled).toBe(false);
  });

  it('releases the mic when the studio closes mid-cue (regression)', async () => {
    const h = harness();
    openOnVocoder(h);
    q<HTMLButtonElement>('voc-record')!.click();
    await flush();
    expect(q('voc-state')!.textContent).toMatch(/Get ready/);
    const cleared = vi.spyOn(window, 'clearInterval');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    mic.resolveStop?.(clip(10));
    await flush();

    expect(mic.disposed).toBe(1);
    expect(cleared).toHaveBeenCalled();
    expect(metro.click).toBe(true);
  });

  it('cancels when the carrier stops before its pass is over (REQ-a-stopped-carrier-cancels-the-take)', async () => {
    const h = harness();
    openOnVocoder(h);
    q<HTMLButtonElement>('voc-record')!.click();
    await flush();
    h.ctx.currentTime = 0.15;
    await flush(80);
    expect(q('voc-state')!.textContent).toMatch(/Sing now/);

    h.preview.playing = false; // another audition, or the edit bar's Stop
    await flush(80);
    mic.resolveStop?.(clip(10));
    await flush();

    expect(mic.disposed).toBe(1);
    expect(q('voc-state')!.textContent).toMatch(/cancelled/);
    expect(q<HTMLButtonElement>('voc-apply')!.disabled).toBe(true);
  });
});

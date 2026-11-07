// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildSamplerPanel } from '../../src/ui/panels/sampler-panel';
import { PatternStore } from '../../src/state/patterns';
import { PatternUndo } from '../../src/state/pattern-undo';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { UiBridge } from '../../src/ui/ui-bridge';
import type { StudioApi } from '../../src/ui/studio-api';

/**
 * The sampler panel's two asynchronous slot writes, against the real panel.
 *  - sampler.md REQ-slots-are-filled-by-load-or-record (v13): the last file PICKED wins, not the
 *    last decode to finish.
 *  - time-stretch.md REQ-the-quick-fit-is-reversible (v3): the FIT toast's Undo reverts only the
 *    fit it offers, never a clip loaded since.
 */

/** A mono AudioBuffer stand-in with real samples, so FIT has something to stretch. */
function fakeBuffer(seconds: number, sampleRate = 48000): AudioBuffer {
  const length = Math.round(seconds * sampleRate);
  const data = new Float32Array(length).map((_, i) => Math.sin(i / 20) * 0.5);
  return {
    length, sampleRate, duration: length / sampleRate, numberOfChannels: 1,
    getChannelData: () => data,
  } as unknown as AudioBuffer;
}

function harness() {
  const bus = new ParamBus();
  registerDefaults(bus);
  const patterns = new PatternStore();
  const buffers: (AudioBuffer | null)[] = Array(8).fill(null);
  const bufferListeners = new Set<(s: number) => void>();
  const noop = () => () => {};
  const lane = () => ({ enabled: false, steps: [0], transpose: [0] });
  // decodeAudioData resolves when the TEST says so, in any order.
  const decodes: Array<(b: AudioBuffer) => void> = [];
  const engine = {
    patterns,
    barTicks: 16,
    clock: { bpm: 120, playing: false, step: 0, cue: 0, sixteenthDuration: () => 0.125, onTick: noop, onStart: noop, onStop: noop, onSeek: noop },
    // The playhead ruler's slice — read at build, never exercised here.
    sync: { onStatus: noop },
    recorder: { onPhase: noop },
    bankRender: { onState: noop },
    canSeek: () => true,
    seekTo: () => true,
    arrangement: {
      seqPlayBank: 0, drumPlayBank: 0, samplerPlayBank: 0, motionPlayBank: 0,
      seqResting: false, drumResting: false, samplerResting: false, motionResting: false,
      onChange: noop,
      songBars: () => 1,
      loopTicks: () => 0,
      seq: lane(), drum: lane(), sampler: lane(), motion: lane(),
      seqChainPos: 0, drumChainPos: 0, samplerChainPos: 0, motionChainPos: 0,
    },
    sampler: {
      buffers,
      setBuffer: (slot: number, b: AudioBuffer | null) => { buffers[slot] = b; bufferListeners.forEach((l) => l(slot)); },
      onBufferChange: (l: (s: number) => void) => { bufferListeners.add(l); return () => bufferListeners.delete(l); },
      triggerSlot: vi.fn(),
      onStep: noop,
      lane: { cells: 16, rate: 2 },
    },
    drums: { onStep: noop },
    seq: { onStep: noop },
    motion: { onStep: noop },
    ctx: {
      sampleRate: 48000,
      decodeAudioData: () => new Promise<AudioBuffer>((res) => { decodes.push(res); }),
      createBuffer: (ch: number, length: number, sampleRate: number) => {
        const chans = Array.from({ length: ch }, () => new Float32Array(length));
        return {
          length, sampleRate, duration: length / sampleRate, numberOfChannels: ch,
          getChannelData: (i: number) => chans[i]!,
          copyToChannel: (src: Float32Array, i: number) => chans[i]!.set(src),
        } as unknown as AudioBuffer;
      },
    },
  } as unknown as StudioApi;
  const panel = buildSamplerPanel(bus, engine, new PatternUndo(patterns), new UiBridge());
  document.body.appendChild(panel.el);
  return { engine, buffers, decodes, patterns, panel };
}

/** Choose a file on slot `slot`'s hidden input and fire its change. */
function pick(slot: number, name: string): void {
  const input = document.querySelector<HTMLInputElement>(`[data-testid="sampler-file-${slot}"]`)!;
  const file = new File([new Uint8Array(8)], name);
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('sampler panel slot writes', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(() => { document.body.innerHTML = ''; });

  it('refuses an oversized file without reading it (untrusted-input.md REQ-a-file-is-sized-before-it-is-read, regression)', async () => {
    const h = harness();
    const input = document.querySelector<HTMLInputElement>('[data-testid="sampler-file-0"]')!;
    const file = new File([new Uint8Array(8)], 'huge.wav', { type: 'audio/wav' });
    Object.defineProperty(file, 'size', { value: 2 * 1024 * 1024 * 1024 });
    const read = vi.spyOn(file, 'arrayBuffer');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await settle();
    expect(read).not.toHaveBeenCalled();
    expect(h.decodes).toHaveLength(0);
    expect(document.body.textContent).toContain('"huge.wav" is larger than');
  });

  it('the last file picked wins, whichever decode finishes last (REQ-slots-are-filled-by-load-or-record, regression)', async () => {
    const h = harness();
    const first = fakeBuffer(1);
    const second = fakeBuffer(2);
    pick(0, 'slow.wav');
    pick(0, 'fast.wav');
    await settle(); // both reads done; both decodes pending
    h.decodes[1]!(second); // the later pick decodes first…
    await settle();
    h.decodes[0]!(first);  // …and the earlier one lands after it
    await settle();
    // The bug: the earlier pick's late decode overwrote the one chosen after it.
    expect(h.buffers[0]).toBe(second);
    expect(h.patterns.sampleNames[0]).toBe('fast.wav');
  });

  it('FIT\'s Undo does not overwrite a clip loaded since (REQ-the-quick-fit-is-reversible, regression)', async () => {
    const h = harness();
    const original = fakeBuffer(1.9); // near a bar at 120 BPM, so FIT has a target
    h.engine.sampler.setBuffer(0, original);
    h.patterns.setSampleName(0, 'loop.wav');
    document.querySelector<HTMLButtonElement>('[data-testid="sampler-fit-0"]')!.click();
    await vi.waitFor(() => expect(h.buffers[0]).not.toBe(original), { timeout: 10_000 }); // the stretch is real DSP
    const fitted = h.buffers[0];

    // A new file lands in the slot while the fit's toast is still up.
    const newer = fakeBuffer(0.5);
    pick(0, 'newer.wav');
    await settle();
    h.decodes[0]!(newer);
    await settle();
    expect(h.buffers[0]).toBe(newer);

    // The bug: Undo put the pre-fit clip back, under the new file's name.
    document.querySelector<HTMLButtonElement>('[data-testid="fit-toast"] [data-testid="toast-action"]')!.click();
    expect(h.buffers[0]).toBe(newer);
    expect(fitted).not.toBe(newer);
  });

  it('FIT\'s Undo still restores the pre-fit clip when nothing replaced it', async () => {
    const h = harness();
    const original = fakeBuffer(1.9);
    h.engine.sampler.setBuffer(0, original);
    h.patterns.setSampleName(0, 'loop.wav'); // a loaded slot has a name, which is what shows FIT
    document.querySelector<HTMLButtonElement>('[data-testid="sampler-fit-0"]')!.click();
    await vi.waitFor(() => expect(h.buffers[0]).not.toBe(original), { timeout: 10_000 }); // the stretch is real DSP
    document.querySelector<HTMLButtonElement>('[data-testid="fit-toast"] [data-testid="toast-action"]')!.click();
    expect(h.buffers[0]).toBe(original);
  });
});

/** sampler.md REQ-a-filled-slot-offers-del-not-load: Del ejects a slot's file, never its steps. */
describe('sampler panel Del', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(() => { document.body.innerHTML = ''; });

  const btn = (id: string): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
  const shown = (id: string): boolean => btn(id).style.display !== 'none';
  const undoDel = (): void => btn('sampler-del-toast').querySelector<HTMLButtonElement>('[data-testid="toast-action"]')!.click();

  it('offers Load on an empty slot and Del on a filled one', () => {
    const h = harness();
    expect(shown('sampler-load-0')).toBe(true);
    expect(shown('sampler-del-0')).toBe(false);
    h.engine.sampler.setBuffer(0, fakeBuffer(0.5));
    h.patterns.setSampleName(0, 'kick.wav');
    expect(shown('sampler-load-0')).toBe(false);
    expect(shown('sampler-del-0')).toBe(true);
  });

  it('ejects name and buffer, keeps the steps, and Undo brings the same file back', () => {
    const h = harness();
    const buf = fakeBuffer(0.5);
    h.engine.sampler.setBuffer(0, buf);
    h.patterns.setSampleName(0, 'kick.wav');
    h.patterns.setSamplerCell(0, 4, { on: true });

    btn('sampler-del-0').click();
    expect(h.buffers[0]).toBeNull();
    expect(h.patterns.sampleNames[0]).toBeNull();
    expect(h.patterns.sampler[0]![4]!.on).toBe(true);
    expect(shown('sampler-load-0')).toBe(true);
    expect(shown('sampler-del-0')).toBe(false);

    undoDel();
    expect(h.buffers[0]).toBe(buf);
    expect(h.patterns.sampleNames[0]).toBe('kick.wav');
    expect(shown('sampler-del-0')).toBe(true);
  });

  it('removes a song\'s missing file (regression: only Clear ▾, which also wiped the steps, could)', () => {
    const h = harness();
    h.patterns.setSampleName(0, 'kick.wav'); // a song import: a name, no audio
    expect(btn('sampler-name-0').classList.contains('needs-reload')).toBe(true);
    expect(shown('sampler-del-0')).toBe(true);
    btn('sampler-del-0').click();
    expect(h.patterns.sampleNames[0]).toBeNull();
    expect(btn('sampler-name-0').classList.contains('needs-reload')).toBe(false);
    expect(shown('sampler-load-0')).toBe(true);
  });

  it('Undo leaves a file loaded since alone', async () => {
    const h = harness();
    h.engine.sampler.setBuffer(0, fakeBuffer(0.5));
    h.patterns.setSampleName(0, 'kick.wav');
    btn('sampler-del-0').click();
    const newer = fakeBuffer(1);
    pick(0, 'snare.wav');
    await settle();
    h.decodes[0]!(newer);
    await settle();
    undoDel();
    expect(h.buffers[0]).toBe(newer);
    expect(h.patterns.sampleNames[0]).toBe('snare.wav');
  });

  it('discards a decode still in flight (edge)', async () => {
    const h = harness();
    h.patterns.setSampleName(0, 'kick.wav');
    pick(0, 'snare.wav');
    await settle(); // the decode is pending
    btn('sampler-del-0').click();
    h.decodes[0]!(fakeBuffer(1));
    await settle();
    expect(h.buffers[0]).toBeNull();
    expect(h.patterns.sampleNames[0]).toBeNull();
  });

  it('a name without audio opens the picker; a loaded one auditions', () => {
    const h = harness();
    const input = btn('sampler-file-0') as unknown as HTMLInputElement;
    const open = vi.spyOn(input, 'click').mockImplementation(() => {});
    h.patterns.setSampleName(0, 'kick.wav');
    btn('sampler-name-0').click();
    expect(open).toHaveBeenCalledTimes(1);
    expect(h.engine.sampler.triggerSlot).not.toHaveBeenCalled();

    h.engine.sampler.setBuffer(0, fakeBuffer(0.5));
    btn('sampler-name-0').click();
    expect(h.engine.sampler.triggerSlot).toHaveBeenCalledWith(0, 0.9);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

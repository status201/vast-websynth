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

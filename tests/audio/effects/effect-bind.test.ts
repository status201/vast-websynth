// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ParamBus, registerDefaults } from '../../../src/state/params';
import { Distortion } from '../../../src/audio/effects/distortion';
import { Phaser } from '../../../src/audio/effects/phaser';
import { Reverb } from '../../../src/audio/effects/reverb';
import { Compressor } from '../../../src/audio/effects/compressor';
import {
  makeMockAudioContext,
  installMockAudioWorkletNode,
  MockAudioWorkletNode,
} from '../mock-audio-context';

function busWithDefaults(): ParamBus {
  const bus = new ParamBus();
  registerDefaults(bus);
  return bus;
}

const ctx = () => makeMockAudioContext() as unknown as AudioContext;

describe('Effect.bind — simple effects (self-wiring, ADR-008)', () => {
  it('subscribes its params and applies on change (immediate + later)', () => {
    const fx = new Distortion(ctx());
    const bus = busWithDefaults();
    const setBypass = vi.spyOn(fx, 'setBypass');
    const setDrive = vi.spyOn(fx, 'setDrive');

    fx.bind(bus, 'fx.dist');
    // subscribe fires immediately with the current value; fx.dist.on default 0 → bypassed
    expect(setBypass).toHaveBeenLastCalledWith(true);

    setDrive.mockClear();
    bus.set('fx.dist.drive', 0.9);
    expect(setDrive).toHaveBeenCalledWith(0.9);
  });

  it('binds the same effect class at a different prefix (bus variant)', () => {
    const synth = new Phaser(ctx());
    const drum = new Phaser(ctx());
    const bus = busWithDefaults();
    const synthRate = vi.spyOn(synth, 'setRate');
    const drumRate = vi.spyOn(drum, 'setRate');

    synth.bind(bus, 'fx.phaser');
    drum.bind(bus, 'fx.drum.phaser');
    synthRate.mockClear();
    drumRate.mockClear();

    bus.set('fx.drum.phaser.rate', 3);
    expect(drumRate).toHaveBeenCalledWith(3);
    expect(synthRate).not.toHaveBeenCalled();
  });

  it('drum reverb binds at fx.drum.reverb, boots bypassed, independent of the synth reverb', () => {
    const synth = new Reverb(ctx());
    const drum = new Reverb(ctx());
    const bus = busWithDefaults();
    const synthMix = vi.spyOn(synth, 'setMix');
    const drumMix = vi.spyOn(drum, 'setMix');
    const drumBypass = vi.spyOn(drum, 'setBypass');

    synth.bind(bus, 'fx.reverb');
    drum.bind(bus, 'fx.drum.reverb');
    // fx.drum.reverb.on defaults 0 → bypassed, so legacy songs/presets are unchanged
    expect(drumBypass).toHaveBeenLastCalledWith(true);

    synthMix.mockClear();
    drumMix.mockClear();
    bus.set('fx.drum.reverb.mix', 0.8);
    expect(drumMix).toHaveBeenCalledWith(0.8);
    expect(synthMix).not.toHaveBeenCalled();
  });
});

describe('Compressor.bind — index mapping', () => {
  beforeEach(() => { installMockAudioWorkletNode(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  // v4: the ratio is a CHOICE, so it is set rather than approached
  // (compressor.md REQ-ratio-and-release-are-indices). It used to be smoothed
  // like a knob: selecting 'ALL' from 20 crossed 50:1, 80:1, 95:1 on the way and
  // only reached exactly 100 after ~10 time constants — and the worklet gates
  // "all buttons in" on `ratio >= 100`, so the mode arrived ~1/3 s after the
  // click, having first run at ratios the UI never offers.
  it('snaps the discrete ratio index to the real ratio', () => {
    const comp = new Compressor(ctx(), 'fet');
    comp.attachWorklet();
    const bus = busWithDefaults();
    comp.bind(bus, 'fx.drum.comp', [4, 8, 12, 20, 100]);

    const node = MockAudioWorkletNode.instances[0]!;
    const ratio = node.parameters.get('ratio');
    ratio.setValueAtTime.mockClear();
    ratio.setTargetAtTime.mockClear();

    bus.set('fx.drum.comp.ratio', 4); // label 'ALL' → ratio 100

    expect(ratio.setValueAtTime).toHaveBeenCalledWith(100, 0);
    expect(ratio.setTargetAtTime).not.toHaveBeenCalled();
  });

  it('snaps autoRelease, which is a flag rather than a quantity', () => {
    const comp = new Compressor(ctx(), 'vca');
    comp.attachWorklet();
    const node = MockAudioWorkletNode.instances[0]!;
    const auto = node.parameters.get('autoRelease');
    auto.setValueAtTime.mockClear();
    auto.setTargetAtTime.mockClear();

    comp.setAutoRelease(true);

    expect(auto.setValueAtTime).toHaveBeenCalledWith(1, 0);
    expect(auto.setTargetAtTime).not.toHaveBeenCalled();
  });

  it('still smooths a continuous param, which would zipper if snapped', () => {
    const comp = new Compressor(ctx(), 'fet');
    comp.attachWorklet();
    const node = MockAudioWorkletNode.instances[0]!;
    const thr = node.parameters.get('threshold');
    thr.setTargetAtTime.mockClear();

    comp.setThreshold(-18);

    expect(thr.setTargetAtTime).toHaveBeenCalledWith(-18, 0, 0.02);
  });

  it('a master release index past the table means auto-release', () => {
    const comp = new Compressor(ctx(), 'vca');
    comp.attachWorklet();
    const bus = busWithDefaults();
    const setAuto = vi.spyOn(comp, 'setAutoRelease');

    comp.bind(bus, 'fx.master.comp', [2, 4, 10], [0.1, 0.3, 0.6, 1.2]);
    // fx.master.comp.release default index is 4 ('auto'); table length 4 → auto
    expect(setAuto).toHaveBeenLastCalledWith(true);
  });
});

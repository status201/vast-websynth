import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ParamBus, registerDefaults } from '../../../src/state/params';
import { Distortion } from '../../../src/audio/effects/distortion';
import { Phaser } from '../../../src/audio/effects/phaser';
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
});

describe('Compressor.bind — index mapping', () => {
  beforeEach(() => { installMockAudioWorkletNode(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('maps the discrete ratio index to the real ratio', () => {
    const comp = new Compressor(ctx(), 'fet');
    comp.attachWorklet();
    const bus = busWithDefaults();
    comp.bind(bus, 'fx.drum.comp', [4, 8, 12, 20, 100]);

    const node = MockAudioWorkletNode.instances[0]!;
    bus.set('fx.drum.comp.ratio', 4); // label 'ALL' → ratio 100
    expect(node.parameters.get('ratio').setTargetAtTime).toHaveBeenCalledWith(100, 0, 0.02);
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

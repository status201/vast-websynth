import { describe, it, expect, vi } from 'vitest';
import { DrumMachine } from '../../../src/audio/transport/drum-machine';
import { Arrangement } from '../../../src/audio/transport/arrangement';
import type { Performance } from '../../../src/audio/transport/performance';
import { PatternStore } from '../../../src/state/patterns';
import { TestClock } from './test-clock';
import { makeMockAudioContext } from '../mock-audio-context';

/** Mutable Performance-like stub (DrumMachine only reads mapStep + fillActive). */
function perfStub(mapStep: (s: number) => number = (s) => s) {
  return { mapStep, fillActive: false, setFill() {} } as unknown as Performance & { fillActive: boolean };
}

function build(perf = perfStub(), fxOversample = true) {
  const ctx = makeMockAudioContext();
  const clock = new TestClock();
  const patterns = new PatternStore();
  const arrangement = new Arrangement(patterns, clock);
  const drumBus = (ctx as unknown as AudioContext).createGain();
  const dm = new DrumMachine(
    ctx as unknown as AudioContext,
    clock,
    patterns,
    arrangement,
    perf as unknown as Performance,
    drumBus,
    fxOversample,
  );
  // Edit bank B (index 1) is empty — avoids the default groove seeded in bank A.
  patterns.setDrumEditBank(1);
  const spies = dm.tracks.map((t) => vi.spyOn(t, 'trigger'));
  return { ctx, clock, patterns, arrangement, perf, dm, spies };
}

describe('DrumMachine', () => {
  it('does not trigger anything while disabled', () => {
    const { clock, patterns, spies } = build();
    patterns.setDrumCell(0, 0, { on: true, velocity: 0.7 });
    clock.fireTick(0);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it('fires only the active cells of the play bank, with the cell velocity', () => {
    const { clock, patterns, dm, spies } = build();
    dm.setEnabled(true);
    patterns.setDrumCell(0, 0, { on: true, velocity: 0.7 }); // kick on step 0
    clock.fireTick(0);
    expect(spies[0]).toHaveBeenCalledWith(0, 0.7, undefined); // gate 1 → no choke
    expect(spies[1]).not.toHaveBeenCalled();
  });

  it('skips a muted track', () => {
    const { clock, patterns, dm, spies } = build();
    dm.setEnabled(true);
    patterns.setDrumCell(2, 0, { on: true, velocity: 0.9 });
    dm.setTrackMute(2, true);
    clock.fireTick(0);
    expect(spies[2]).not.toHaveBeenCalled();
  });

  it('reads the bank at the stutter-mapped step', () => {
    const { clock, patterns, dm, spies } = build(perfStub(() => 4));
    dm.setEnabled(true);
    patterns.setDrumCell(0, 4, { on: true, velocity: 0.8 }); // cell at the mapped index
    patterns.setDrumCell(0, 0, { on: true, velocity: 0.3 }); // raw step (should be ignored)
    clock.fireTick(0); // raw step 0 → mapStep → 4
    expect(spies[0]).toHaveBeenCalledTimes(1);
    expect(spies[0]).toHaveBeenCalledWith(0, 0.8, undefined);
  });

  it('plays ratchet sub-hits evenly spaced across the step', () => {
    const { clock, patterns, dm, spies } = build();
    dm.setEnabled(true);
    patterns.setDrumCell(0, 0, { on: true, velocity: 0.7, ratchet: 3 });
    clock.fireTick(0);
    const sub = clock.sixteenthDuration() / 3;
    expect(spies[0]).toHaveBeenCalledTimes(3);
    expect(spies[0]).toHaveBeenNthCalledWith(1, 0, 0.7, undefined);
    expect(spies[0]).toHaveBeenNthCalledWith(2, sub, 0.7, undefined);
    expect(spies[0]).toHaveBeenNthCalledWith(3, 2 * sub, 0.7, undefined);
  });

  it('chokes each hit at gate × sub-duration when gate < 1', () => {
    const { clock, patterns, dm, spies } = build();
    dm.setEnabled(true);
    patterns.setDrumCell(0, 0, { on: true, velocity: 0.7, gate: 0.5, ratchet: 2 });
    clock.fireTick(0);
    const sub = clock.sixteenthDuration() / 2;
    expect(spies[0]).toHaveBeenNthCalledWith(1, 0, 0.7, sub * 0.5);
    expect(spies[0]).toHaveBeenNthCalledWith(2, sub, 0.7, sub + sub * 0.5);
  });

  it('tie lets the last ratchet hit ring (no choke) past a shortened gate', () => {
    const { clock, patterns, dm, spies } = build();
    dm.setEnabled(true);
    patterns.setDrumCell(0, 0, { on: true, velocity: 0.7, gate: 0.25, ratchet: 2, tie: true });
    clock.fireTick(0);
    const sub = clock.sixteenthDuration() / 2;
    expect(spies[0]).toHaveBeenNthCalledWith(1, 0, 0.7, sub * 0.25);
    expect(spies[0]).toHaveBeenNthCalledWith(2, sub, 0.7, undefined);
  });

  it('skips the step when the probability roll fails, fires when it passes', () => {
    const { clock, patterns, dm, spies } = build();
    dm.setEnabled(true);
    patterns.setDrumCell(0, 0, { on: true, velocity: 0.7, prob: 0.5 });
    const rnd = vi.spyOn(Math, 'random');
    rnd.mockReturnValue(0.9); // > prob → skip
    clock.fireTick(0);
    expect(spies[0]).not.toHaveBeenCalled();
    clock.step = 0;
    rnd.mockReturnValue(0.1); // ≤ prob → fire
    clock.fireTick(0);
    expect(spies[0]).toHaveBeenCalledTimes(1);
    rnd.mockRestore();
  });

  it('plays the fill cascade instead of the pattern when fillActive', () => {
    const perf = perfStub();
    const { clock, patterns, dm, spies } = build(perf);
    dm.setEnabled(true);
    perf.fillActive = true;
    // A pattern cell that must NOT fire while the fill owns the step.
    patterns.setDrumCell(1, 0, { on: true, velocity: 0.9 });

    clock.step = 0; clock.fireTick(0);
    expect(spies[0]).toHaveBeenCalled(); // kick anchor on step 0

    clock.step = 12; clock.fireTick(0);
    expect(spies[4]).toHaveBeenCalled(); // low tom starts the roll at step 12

    clock.step = 15; clock.fireTick(0);
    expect(spies[6]).toHaveBeenCalled(); // high tom
    expect(spies[7]).toHaveBeenCalled(); // clap accent
  });

  it('notifies step listeners with the mapped index', () => {
    const { clock, dm } = build();
    dm.setEnabled(true);
    const steps: number[] = [];
    dm.onStep((s) => steps.push(s));
    clock.fireTicks(3);
    expect(steps).toEqual([0, 1, 2]);
  });

  it('builds a per-track channel: one waveshaper (drive) + one panner per track', () => {
    const { ctx, dm } = build();
    expect(ctx.createWaveShaper).toHaveBeenCalledTimes(dm.tracks.length);
    expect(ctx.createStereoPanner).toHaveBeenCalledTimes(dm.tracks.length);
  });

  it('setTrackPan ramps the per-track stereo panner', () => {
    const { ctx, dm } = build();
    const panner = ctx.createStereoPanner.mock.results[0]!.value; // track 0
    dm.setTrackPan(0, -0.5);
    expect(panner.pan.setTargetAtTime).toHaveBeenCalledWith(-0.5, expect.any(Number), expect.any(Number));
  });

  it('setTrackTone darkens the per-track lowpass toward 300 Hz', () => {
    const { ctx, dm } = build();
    // At construction the only biquads created are the 8 channel tone filters,
    // in track order (voices build their own biquads later, at trigger time).
    const tone = ctx.createBiquadFilter.mock.results[0]!.value; // track 0 tone
    dm.setTrackTone(0, 0); // fully dark
    expect(tone.frequency.setTargetAtTime).toHaveBeenCalledWith(300, expect.any(Number), expect.any(Number));
  });

  it('setTrackDrive installs a waveshaper curve', () => {
    const { ctx, dm } = build();
    const shaper = ctx.createWaveShaper.mock.results[0]!.value; // track 0
    dm.setTrackDrive(0, 0.5);
    expect(shaper.curve).toBeInstanceOf(Float32Array);
  });

  it('shapers only oversample while driven: none at drive 0, 2x above (REQ-11)', () => {
    const { ctx, dm } = build();
    const shaper = ctx.createWaveShaper.mock.results[0]!.value; // track 0
    expect(shaper.oversample).toBe('none'); // identity curve at boot
    dm.setTrackDrive(0, 0.5);
    expect(shaper.oversample).toBe('2x');
    dm.setTrackDrive(0, 0);
    expect(shaper.oversample).toBe('none');
  });

  it('a weak tier (fxOversample false) pins the shapers to none even when driven', () => {
    const { ctx, dm } = build(perfStub(), false);
    const shaper = ctx.createWaveShaper.mock.results[0]!.value;
    dm.setTrackDrive(0, 0.8);
    expect(shaper.oversample).toBe('none');
  });
});

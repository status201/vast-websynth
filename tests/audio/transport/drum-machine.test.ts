import { describe, it, expect, vi } from 'vitest';
import { DrumMachine } from '../../../src/audio/transport/drum-machine';
import type { Performance } from '../../../src/audio/transport/performance';
import { makeMockAudioContext } from '../mock-audio-context';
import { createPerfStub, makeTransportRig } from './rig';
import { LANE_RATES } from '../../../src/state/meter';

function build(perf = createPerfStub(), fxOversample = true) {
  const ctx = makeMockAudioContext();
  const { clock, patterns, arrangement } = makeTransportRig(perf);
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
    const { clock, patterns, dm, spies } = build(createPerfStub(() => 4));
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
    const perf = createPerfStub();
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

  // step-settings.md REQ-6/REQ-8 — micro moves the SOUND, not the grid.
  it('nudges a hit early or late without moving any other lane (v3)', () => {
    const { clock, patterns, dm, spies } = build();
    dm.setEnabled(true);
    patterns.setDrumCell(0, 0, { on: true, velocity: 0.7, micro: -6 }); // kick early
    patterns.setDrumCell(1, 0, { on: true, velocity: 0.7, micro: 6 });  // snare late
    patterns.setDrumCell(2, 0, { on: true, velocity: 0.7 });            // hat straight
    clock.fireTick(1);
    // A 16th at 120 BPM is 0.125 s; 6/24 of it is 0.03125 s.
    expect(spies[0]).toHaveBeenCalledWith(1 - 0.03125, 0.7, undefined);
    expect(spies[1]).toHaveBeenCalledWith(1 + 0.03125, 0.7, undefined);
    expect(spies[2]).toHaveBeenCalledWith(1, 0.7, undefined);
  });

  it('does not move the PLAYHEAD with the nudge (v3, REQ-8)', () => {
    const { clock, patterns, dm } = build();
    dm.setEnabled(true);
    patterns.setDrumCell(0, 0, { on: true, micro: 12 });
    patterns.setDrumCell(0, 1, { on: true, micro: -12 });
    const steps: number[] = [];
    dm.onStep((st) => steps.push(st));
    clock.fireTicks(3);
    // The grid the user sees is untouched — only the audio time moved.
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
    const { ctx, dm } = build(createPerfStub(), false);
    const shaper = ctx.createWaveShaper.mock.results[0]!.value;
    dm.setTrackDrive(0, 0.8);
    expect(shaper.oversample).toBe('none');
  });
});

/** Voice models (drum-machine.md REQ-11): swap the voice, keep the channel. */
describe('DrumMachine voice models', () => {
  it('setTrackModel swaps the voice and rewires it into the same channel head', () => {
    const { dm } = build();
    const old = dm.tracks[4]!; // L.Tom slot
    dm.setTrackTune(4, -5);
    dm.setTrackDecay(4, 0.24);
    dm.setTrackModel(4, 8); // Conga
    const next = dm.tracks[4]!;
    expect(next).not.toBe(old);
    expect((old.output as unknown as { disconnect: ReturnType<typeof vi.fn> }).disconnect).toHaveBeenCalled();
    // The new voice joined the graph (its output connected somewhere)…
    expect((next.output as unknown as { connect: ReturnType<typeof vi.fn> }).connect).toHaveBeenCalled();
  });

  it('cached tune/decay are replayed onto the swapped-in voice', () => {
    const { dm, clock, patterns } = build();
    dm.setEnabled(true);
    dm.setTrackTune(4, 12);
    dm.setTrackDecay(4, 0.1);
    dm.setTrackModel(4, 8); // Conga
    const spy = vi.spyOn(dm.tracks[4]!, 'trigger');
    patterns.setDrumCell(4, 0, { on: true, velocity: 0.9 });
    clock.fireTick(0);
    expect(spy).toHaveBeenCalled(); // the new voice is what the grid now fires
  });

  it('an unknown or unchanged model index is a no-op', () => {
    const { dm } = build();
    const v = dm.tracks[0]!;
    dm.setTrackModel(0, 0);   // unchanged
    dm.setTrackModel(0, 99);  // out of range
    expect(dm.tracks[0]).toBe(v);
  });
});

/**
 * The hat choke group — drum-machine.md REQ-12. Every track is an independent
 * voice here, so before this an open hat rang straight through the closed hats
 * on top of it; on an 808 the two share one voice.
 *
 * Asserted on the per-track choke gain's scheduled ramp, which is the mechanism:
 * `voice → choke → drive → …`, cut and restored inside one call.
 */
describe('DrumMachine hat choke group (REQ-12)', () => {
  /** Ramp targets scheduled on a track's choke gain, in call order. */
  function ramps(dm: DrumMachine, t: number): number[] {
    const g = chokeNode(dm, t);
    return (g.gain.linearRampToValueAtTime as unknown as { mock: { calls: unknown[][] } })
      .mock.calls.map((c) => c[0] as number);
  }

  /** Reach the private per-track choke gain without widening the public API. */
  function chokeNode(dm: DrumMachine, t: number) {
    const gains = (dm as unknown as { trackChokes: GainNode[] }).trackChokes;
    return gains[t]!;
  }

  function hats() {
    const rig = build();
    rig.dm.setEnabled(true);
    // Track 2 is C.Hat and track 3 is O.Hat by default (model = track index).
    return rig;
  }

  it('does nothing at all while drum.choke is off (ADR-006 default)', () => {
    const { clock, patterns, dm } = hats();
    patterns.setDrumCell(3, 0, { on: true }); // open hat
    patterns.setDrumCell(2, 0, { on: true }); // closed hat on the same step
    clock.fireTick(0);
    expect(ramps(dm, 3)).toEqual([]);
  });

  it('a closed hat cuts the open hat once enabled', () => {
    const { clock, patterns, dm } = hats();
    dm.setChokeEnabled(true);
    patterns.setDrumCell(2, 0, { on: true });
    clock.fireTick(0);
    // Ramped to 0 — the cut — and restored by a later setValueAtTime.
    expect(ramps(dm, 3)).toEqual([0]);
  });

  it('restores the gain, so the next open hat is at full level', () => {
    const { clock, patterns, dm } = hats();
    dm.setChokeEnabled(true);
    patterns.setDrumCell(2, 0, { on: true });
    clock.fireTick(0);
    const g = chokeNode(dm, 3);
    const set = (g.gain.setValueAtTime as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(set.at(-1)?.[0]).toBe(1);
    // …and the restore is scheduled after the fade, not before it.
    expect(set.at(-1)?.[1] as number).toBeGreaterThan(set.at(0)?.[1] as number);
  });

  it('never chokes itself, or a kick', () => {
    const { clock, patterns, dm } = hats();
    dm.setChokeEnabled(true);
    patterns.setDrumCell(2, 0, { on: true });
    clock.fireTick(0);
    expect(ramps(dm, 2)).toEqual([]); // the closed hat itself
    expect(ramps(dm, 0)).toEqual([]); // the kick
  });

  it('follows the voice MODEL, not the track index (REQ-11 makes models movable)', () => {
    const { clock, patterns, dm } = hats();
    dm.setChokeEnabled(true);
    // Move the open hat onto track 6 and take it off track 3.
    dm.setTrackModel(6, 3); // O.Hat
    dm.setTrackModel(3, 0); // that slot becomes a kick
    patterns.setDrumCell(2, 0, { on: true }); // closed hat fires
    clock.fireTick(0);
    expect(ramps(dm, 6)).toEqual([0]); // the relocated open hat is choked
    expect(ramps(dm, 3)).toEqual([]);  // the slot that is now a kick is not
  });

  it('chokes on every sub-hit of a ratcheted closed hat', () => {
    const { clock, patterns, dm } = hats();
    dm.setChokeEnabled(true);
    patterns.setDrumCell(2, 0, { on: true, ratchet: 3 });
    clock.fireTick(0);
    expect(ramps(dm, 3)).toEqual([0, 0, 0]);
  });
});

/**
 * The sidechain trigger (sidechain-ducking.md REQ-9). It reports hits that
 * *sounded*, at the absolute time they sound — which is what lets a ducker
 * schedule against the pattern without re-deriving mute, probability or
 * ratchets, and makes it impossible to pump on a step that stayed silent.
 */
describe('DrumMachine.onHit', () => {
  function hits() {
    const rig = build();
    const seen: Array<[number, number, number]> = [];
    rig.dm.onHit((track, when, velocity) => seen.push([track, when, velocity]));
    return { ...rig, seen };
  }

  it('reports the track, absolute time and velocity of a hit', () => {
    const { clock, patterns, dm, seen } = hits();
    dm.setEnabled(true);
    patterns.setDrumCell(0, 0, { on: true, velocity: 0.7 });
    clock.fireTick(0);
    expect(seen).toEqual([[0, 0, 0.7]]);
  });

  it('fires once per ratchet sub-hit, at distinct ascending times', () => {
    const { clock, patterns, dm, seen } = hits();
    dm.setEnabled(true);
    patterns.setDrumCell(0, 0, { on: true, velocity: 0.7, ratchet: 4 });
    clock.fireTick(0);
    expect(seen).toHaveLength(4);
    const times = seen.map(([, when]) => when);
    expect(times).toStrictEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(4);
  });

  it('does not fire for a muted track', () => {
    const { clock, patterns, dm, seen } = hits();
    dm.setEnabled(true);
    patterns.setDrumCell(2, 0, { on: true, velocity: 0.9 });
    dm.setTrackMute(2, true);
    clock.fireTick(0);
    expect(seen).toEqual([]);
  });

  it('does not fire for a step whose probability roll fails', () => {
    const { clock, patterns, dm, seen } = hits();
    dm.setEnabled(true);
    patterns.setDrumCell(0, 0, { on: true, velocity: 0.9, prob: 0 });
    clock.fireTick(0);
    expect(seen).toEqual([]);
  });

  it('does not fire while the machine is disabled', () => {
    const { clock, patterns, seen } = hits();
    patterns.setDrumCell(0, 0, { on: true, velocity: 0.9 });
    clock.fireTick(0);
    expect(seen).toEqual([]);
  });

  it('fires on a manual audition, so an auditioned pad pumps too', () => {
    const { dm, seen } = hits();
    dm.triggerTrack(3, 0.8);
    expect(seen).toEqual([[3, 0, 0.8]]);
  });

  it('does not fire for a track that has no voice', () => {
    const { dm, seen } = hits();
    dm.triggerTrack(99);
    expect(seen).toEqual([]);
  });

  /**
   * REQ-13 v8. The lane mute cuts the bus gain but leaves the pattern running,
   * so the machine has to stay quiet about hits it is still playing — otherwise
   * a ducker pumps to a kick nobody can hear.
   */
  // One tick per case: Arrangement advances the song position on every tick, so
  // firing step 0 twice can move the play bank out from under the assertion.
  it('stops reporting while the lane is inaudible, but keeps playing', () => {
    const { clock, patterns, dm, spies, seen } = hits();
    dm.setEnabled(true);
    patterns.setDrumCell(0, 0, { on: true, velocity: 0.7 });
    dm.setLaneAudible(false);

    clock.fireTick(0);
    expect(seen).toEqual([]);
    // Still playing — that is what makes un-mute instant.
    expect(spies[0]).toHaveBeenCalledTimes(1);
  });

  it('reports again once the lane is audible', () => {
    const { clock, patterns, dm, seen } = hits();
    dm.setEnabled(true);
    patterns.setDrumCell(0, 0, { on: true, velocity: 0.7 });
    dm.setLaneAudible(false);
    dm.setLaneAudible(true);

    clock.fireTick(0);
    expect(seen).toEqual([[0, 0, 0.7]]);
  });

  it('stops reporting auditions while the lane is inaudible', () => {
    const { dm, seen } = hits();
    dm.setLaneAudible(false);
    dm.triggerTrack(0, 0.9);
    expect(seen).toEqual([]);
  });

  it('stops reporting once the listener is disposed', () => {
    const { clock, patterns, dm } = build();
    dm.setEnabled(true);
    const seen: number[] = [];
    const off = dm.onHit((track) => seen.push(track));
    patterns.setDrumCell(0, 0, { on: true, velocity: 0.7 });
    clock.fireTick(0);
    off();
    clock.fireTick(0);
    expect(seen).toEqual([0]);
  });
});

describe('DrumMachine — meter (meter.md)', () => {
  const rateOf = (label: string): number => LANE_RATES.findIndex((x) => x.label === label);

  it('swings a half-rate lane on its own grid (REQ-16, regression)', () => {
    const { clock, patterns, dm, spies } = build();
    dm.setEnabled(true);
    dm.lane.setRate(rateOf('1/8')); // 2 ticks per cell — only ever even ticks
    clock.swing = 0.5;
    for (let c = 0; c < 4; c++) patterns.setDrumCell(0, c, { on: true, velocity: 1 });

    // The clock delays odd TICKS, which this lane never lands on. Left to the
    // clock the lane would play dead straight; it must swing its own odd CELLS.
    for (let s = 0; s < 8; s++) clock.fireTick(s * 0.125 + clock.swingOffset(s));
    const times = spies[0]!.mock.calls.map((c) => c[0] as number);
    expect(times).toHaveLength(4);
    // Straight cell times are 0, 0.25, 0.5, 0.75; odd cells are laid back by
    // swing × 0.5 × cellDur = 0.5 × 0.5 × 0.25 = 0.0625s.
    expect(times[0]).toBeCloseTo(0, 9);
    expect(times[1]).toBeCloseTo(0.25 + 0.0625, 9);
    expect(times[2]).toBeCloseTo(0.5, 9);
    expect(times[3]).toBeCloseTo(0.75 + 0.0625, 9);
  });

  it('leaves the default rate byte-identical under swing (REQ-16, regression)', () => {
    const { clock, patterns, dm, spies } = build();
    dm.setEnabled(true);
    clock.swing = 0.5;
    for (let c = 0; c < 4; c++) patterns.setDrumCell(0, c, { on: true, velocity: 1 });
    const emitted: number[] = [];
    for (let s = 0; s < 4; s++) {
      const when = s * 0.125 + clock.swingOffset(s);
      emitted.push(when);
      clock.fireTick(when);
    }
    // Whatever the clock emitted is exactly what sounded — no re-derivation.
    expect(spies[0]!.mock.calls.map((c) => c[0] as number)).toEqual(emitted);
  });

  it('lands the fill on the bar\u2019s own last step in 7/8 (REQ-9)', () => {
    const perf = createPerfStub();
    const { clock, dm, spies } = build(perf);
    dm.setEnabled(true);
    dm.lane.setBarTicks(14); // 7/8 -> a 14-cell lane
    perf.fillActive = true;
    for (let s = 0; s < 14; s++) clock.fireTick(s * 0.125);

    // Clap (track 7) accents the bar's last step: cell 13, not the 16-step 15.
    expect(spies[7]).toHaveBeenCalledTimes(1);
    expect(spies[7]!.mock.calls[0]![0]).toBeCloseTo(13 * 0.125, 9);
    // The L→M→H tom roll occupies the last quarter of the bar: 14 - round(14/4)
    // = cells 10..13, with H holding the extra cell exactly as it does in 4/4.
    const tomTimes = [4, 5, 6].map((t) => spies[t]!.mock.calls.map((c) => c[0] as number));
    expect(tomTimes[0]).toEqual([10 * 0.125]);
    expect(tomTimes[1]).toEqual([11 * 0.125]);
    expect(tomTimes[2]).toEqual([12 * 0.125, 13 * 0.125]);
    // The kick anchors each half-bar: cells 0 and round(14/2) = 7.
    expect(spies[0]!.mock.calls.map((c) => c[0] as number)).toEqual([0, 7 * 0.125]);
  });

  it('keeps the 16-step fill exactly as it was (REQ-9, regression)', () => {
    const perf = createPerfStub();
    const { clock, dm, spies } = build(perf);
    dm.setEnabled(true);
    perf.fillActive = true;
    for (let s = 0; s < 16; s++) clock.fireTick(s);

    // The pre-meter shape: kick on 0 and 8, toms L/M/H/H on 12..15, clap on 15.
    expect(spies[0]!.mock.calls.map((c) => c[0])).toEqual([0, 8]);
    expect(spies[4]!.mock.calls.map((c) => c[0])).toEqual([12]);
    expect(spies[5]!.mock.calls.map((c) => c[0])).toEqual([13]);
    expect(spies[6]!.mock.calls.map((c) => c[0])).toEqual([14, 15]);
    expect(spies[7]!.mock.calls.map((c) => c[0])).toEqual([15]);
  });
});

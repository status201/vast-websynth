import { rampTo, RAMP_MEDIUM } from './param-utils';
import { audibleLanes, type LaneFlags, type LaneId } from './transport/lane-mix';

/** The bit of the sequencer the lane mixer drives (mute = stop triggering). */
export interface LaneMuter {
  setMuted(b: boolean): void;
}

/**
 * The bit of the drum machine the lane mixer drives. Its bus gain going to 0 is
 * not enough on its own: the machine keeps playing (that is what makes un-mute
 * instant), so anything keyed off its hits would go on firing against drums
 * nobody can hear — a ducker pumping to a silent kick. It is told the audibility
 * verdict so it can stop *reporting* while still playing
 * (drum-machine.md REQ-13 v8).
 */
export interface LaneReporter {
  setLaneAudible(on: boolean): void;
}

/**
 * The Song-tab DJ mixer: mute/solo/volume across the three lanes
 * (sequencer / drums / sampler). Holds the per-lane volumes so mute/solo and the
 * volume knobs both resolve the bus gain. The audibility rule itself lives in the
 * pure `audibleLanes` helper (solo wins over mute), shared with the Song panel's
 * dim-when-silenced visual. Drums/sampler mute by cutting their bus gain (the
 * pattern keeps running, instant un-mute); the sequencer mutes by suppressing
 * triggering (live keys stay audible).
 */
export class LaneMixer {
  private readonly mute: LaneFlags = { seq: false, drum: false, sampler: false };
  private readonly solo: LaneFlags = { seq: false, drum: false, sampler: false };
  private drumVol = 0.85;
  private samplerVol = 0.85;

  constructor(
    private readonly ctx: AudioContext,
    private readonly seq: LaneMuter,
    private readonly drumBus: GainNode,
    private readonly samplerBus: GainNode,
    private readonly drums?: LaneReporter,
  ) {}

  setMute(lane: LaneId, on: boolean): void { this.mute[lane] = on; this.apply(); }
  setSolo(lane: LaneId, on: boolean): void { this.solo[lane] = on; this.apply(); }
  setDrumVol(v: number): void { this.drumVol = v; this.apply(); }
  setSamplerVol(v: number): void { this.samplerVol = v; this.apply(); }

  private apply(): void {
    const audible = audibleLanes(this.mute, this.solo);
    this.seq.setMuted(!audible.seq);
    rampTo(this.drumBus.gain, audible.drum ? this.drumVol : 0, this.ctx, RAMP_MEDIUM);
    rampTo(this.samplerBus.gain, audible.sampler ? this.samplerVol : 0, this.ctx, RAMP_MEDIUM);
    // Reported ⇔ audible. Reads the same `audible.drum` the bus gain does, so a
    // solo elsewhere silences the reports exactly as an explicit mute does.
    this.drums?.setLaneAudible(audible.drum);
  }
}

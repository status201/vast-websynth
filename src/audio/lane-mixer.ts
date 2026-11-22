import { rampTo, RAMP_MEDIUM } from './param-utils';
import { audibleLanes, type LaneFlags, type LaneId } from './transport/lane-mix';

/** The bit of the sequencer the lane mixer drives (mute = stop triggering). */
export interface LaneMuter {
  setMuted(b: boolean): void;
}

/**
 * The bit of the drum and sampler machines the lane mixer drives: the audibility
 * verdict, which ramps the lane gates their pattern hits pass through
 * (song-mode.md REQ-a-lane-mute-silences-the-pattern-not-the-hands). The machine
 * keeps playing behind a closed gate — that is what makes un-mute instant — so
 * the drums also stop *reporting* those hits, or a ducker would pump to a kick
 * nobody can hear (drum-machine.md REQ-every-sounded-hit-is-reported).
 */
export interface LaneGate {
  setLaneAudible(on: boolean): void;
}

/**
 * The Song-tab DJ mixer: mute/solo/volume across the three lanes
 * (sequencer / drums / sampler). Holds the per-lane volumes so mute/solo and the
 * volume knobs both reach the lanes. The audibility rule itself lives in the
 * pure `audibleLanes` helper (solo wins over mute), shared with the Song panel's
 * dim-when-silenced visual. Every lane silences its pattern and never the hands:
 * drums/sampler close the lane gates their pattern hits pass through (the
 * pattern keeps running, instant un-mute; auditions and pads play past them),
 * and the sequencer suppresses triggering (live keys stay audible). The buses
 * carry only the lane volume.
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
    private readonly drums: LaneGate,
    private readonly sampler: LaneGate,
  ) {}

  setMute(lane: LaneId, on: boolean): void { this.mute[lane] = on; this.apply(); }
  setSolo(lane: LaneId, on: boolean): void { this.solo[lane] = on; this.apply(); }
  setDrumVol(v: number): void { this.drumVol = v; this.apply(); }
  setSamplerVol(v: number): void { this.samplerVol = v; this.apply(); }

  private apply(): void {
    const audible = audibleLanes(this.mute, this.solo);
    this.seq.setMuted(!audible.seq);
    // The buses carry the lane volume only. Mute/solo closes the lanes' gates,
    // which only the pattern's hits pass through — an audition or a MIDI pad
    // plays past them (song-mode.md REQ-a-lane-mute-silences-the-pattern-not-the-hands).
    rampTo(this.drumBus.gain, this.drumVol, this.ctx, RAMP_MEDIUM);
    rampTo(this.samplerBus.gain, this.samplerVol, this.ctx, RAMP_MEDIUM);
    // Reported ⇔ audible: the drum gate and its hit reports read the same verdict,
    // so a solo elsewhere silences the reports exactly as an explicit mute does.
    this.drums.setLaneAudible(audible.drum);
    this.sampler.setLaneAudible(audible.sampler);
  }
}

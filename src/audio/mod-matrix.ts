import type { Voice } from './voice';
import { rampTo, RAMP_MEDIUM } from './param-utils';
import {
  MOD_ROWS, MOD_SRC, MOD_DST, MOD_DEST_SCALE, isPerVoiceSource, isBusWideDest,
} from '../state/mod-routing';

/**
 * The modulation matrix: six free routes, each one source into one summing
 * `AudioParam`, with its own bipolar depth.
 *
 * Spec: `specs/features/mod-matrix.md`. The boundary that keeps this from becoming a
 * third way to move a parameter is `specs/decisions/adr-017-modulation-in-graph.md`:
 * **modulation is a graph concern, automation is a bus concern.** Nothing in here runs
 * per frame — a route is a `GainNode`, and the summation is Web Audio's own.
 */

/** The global (non-per-voice) modulation sources the Engine owns. */
export interface ModSources {
  lfo1: AudioNode;
  lfo2: AudioNode;
  modWheel: AudioNode;
  random: AudioNode;
}

/** One route's live wiring, per voice (or the single bus-wide chain). */
interface Chain {
  gain: GainNode;
  /** What `gain` is currently connected to, so it can be undone without guessing. */
  wiredTo: AudioParam[];
  wiredFrom: AudioNode | null;
}

interface Row {
  src: number;
  dst: number;
  amt: number;
  /** Bumped on every re-patch so a stale timer cannot apply an outdated wiring. */
  gen: number;
}

export class ModMatrix {
  private readonly rows: Row[] = Array.from({ length: MOD_ROWS }, () => ({
    src: MOD_SRC.off, dst: MOD_DST.none, amt: 0, gen: 0,
  }));

  /** `perVoice[row][voiceIndex]` — the chain used for per-voice destinations. */
  private readonly perVoice: Chain[][] = Array.from({ length: MOD_ROWS }, () => []);
  /** `busWide[row]` — one chain for the whole synth, used by `pan`. */
  private readonly busWide: Chain[] = [];

  private readonly voices: Voice[] = [];
  private pan: AudioParam | null = null;

  constructor(private readonly ctx: AudioContext, private readonly sources: ModSources) {
    for (let r = 0; r < MOD_ROWS; r++) {
      this.busWide[r] = { gain: this.makeGain(), wiredTo: [], wiredFrom: null };
    }
  }

  /** The bus-wide destination, wired once by the Engine (the synth panner). */
  setPanTarget(param: AudioParam): void {
    this.pan = param;
  }

  /**
   * Give the matrix a voice. Called from the Engine's voice loop, in the same place
   * `connectLfoToVoice` already runs, so the fan-out is built once at boot.
   */
  connectVoice(v: Voice): void {
    const idx = this.voices.length;
    this.voices.push(v);
    for (let r = 0; r < MOD_ROWS; r++) {
      this.perVoice[r]![idx] = { gain: this.makeGain(), wiredTo: [], wiredFrom: null };
    }
  }

  setSource(row: number, src: number): void { this.patch(row, { src: Math.round(src) }); }
  setDest(row: number, dst: number): void { this.patch(row, { dst: Math.round(dst) }); }

  /**
   * Depth only — no rewiring, so this is safe to call as fast as a knob drags.
   * Bipolar: a negative amount inverts the route rather than needing an inverted source.
   */
  setAmount(row: number, amt: number): void {
    const r = this.rows[row];
    if (!r) return;
    r.amt = amt;
    this.applyGain(row);
  }

  // ---------- internals ----------

  private makeGain(): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = 0;
    return g;
  }

  /** Every chain a row currently owns — per-voice or bus-wide, never both. */
  private chainsOf(row: number): Chain[] {
    const r = this.rows[row]!;
    return isBusWideDest(r.dst) ? [this.busWide[row]!] : this.perVoice[row]!;
  }

  /**
   * Re-patch a row: mute, rewire while silent, unmute (REQ-1).
   *
   * `gen` guards the timer — two changes inside the mute window must settle on the
   * last one, not race. The mute is deliberate and audible only as a re-patch.
   */
  private patch(row: number, next: Partial<Pick<Row, 'src' | 'dst'>>): void {
    const r = this.rows[row];
    if (!r) return;
    if (next.src === r.src && next.dst === undefined) return;
    if (next.dst === r.dst && next.src === undefined) return;

    // Mute every chain the row owns *under its current destination*, before the
    // destination changes underneath us and we lose track of what to silence.
    for (const c of this.chainsOf(row)) rampTo(c.gain.gain, 0, this.ctx, RAMP_MEDIUM);

    if (next.src !== undefined) r.src = next.src;
    if (next.dst !== undefined) r.dst = next.dst;
    const gen = ++r.gen;

    // ~4 time constants of RAMP_MEDIUM: the gain is inaudible well before the rewire.
    window.setTimeout(() => {
      if (this.rows[row]?.gen !== gen) return;   // superseded by a later change
      this.rewire(row);
      this.applyGain(row);
    }, 40);
  }

  /** Disconnect whatever the row's chains hold, then connect what they should. */
  private rewire(row: number): void {
    const r = this.rows[row]!;

    // Tear down BOTH chain sets: the destination may have crossed the
    // per-voice/bus-wide line, in which case the other set is the stale one.
    for (const c of [...this.perVoice[row]!, this.busWide[row]!]) this.unwire(c);

    if (r.src === MOD_SRC.off || r.dst === MOD_DST.none) return;
    // REQ-7: a per-voice source cannot drive a bus-wide destination. The UI greys the
    // combination; this is the audio layer refusing to make mush if it ever slips past.
    if (isPerVoiceSource(r.src) && isBusWideDest(r.dst)) return;

    if (isBusWideDest(r.dst)) {
      const c = this.busWide[row]!;
      const from = this.globalSource(r.src);
      if (!from || !this.pan) return;
      from.connect(c.gain);
      c.wiredFrom = from;
      c.gain.connect(this.pan);
      c.wiredTo = [this.pan];
      return;
    }

    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i]!;
      const c = this.perVoice[row]![i];
      if (!c) continue;
      const from = isPerVoiceSource(r.src) ? voiceSource(v, r.src) : this.globalSource(r.src);
      if (!from) continue;
      from.connect(c.gain);
      c.wiredFrom = from;
      const targets = voiceTargets(v, r.dst);
      for (const t of targets) c.gain.connect(t);
      c.wiredTo = targets;
    }
  }

  private unwire(c: Chain): void {
    if (c.wiredFrom) {
      try { c.wiredFrom.disconnect(c.gain); } catch { /* already gone */ }
      c.wiredFrom = null;
    }
    for (const t of c.wiredTo) {
      try { c.gain.disconnect(t); } catch { /* already gone */ }
    }
    c.wiredTo = [];
  }

  private globalSource(src: number): AudioNode | null {
    switch (src) {
      case MOD_SRC.lfo1: return this.sources.lfo1;
      case MOD_SRC.lfo2: return this.sources.lfo2;
      case MOD_SRC.modWheel: return this.sources.modWheel;
      case MOD_SRC.random: return this.sources.random;
      default: return null;
    }
  }

  /** Depth in the destination's own unit, applied to every chain the row owns. */
  private applyGain(row: number): void {
    const r = this.rows[row]!;
    const live = r.src !== MOD_SRC.off && r.dst !== MOD_DST.none
      && !(isPerVoiceSource(r.src) && isBusWideDest(r.dst));
    const g = live ? r.amt * (MOD_DEST_SCALE[r.dst] ?? 0) : 0;
    for (const c of this.chainsOf(row)) rampTo(c.gain.gain, g, this.ctx, RAMP_MEDIUM);
  }
}

/** The per-voice source nodes. All emit roughly 0..1 or -1..1. */
function voiceSource(v: Voice, src: number): AudioNode | null {
  switch (src) {
    case MOD_SRC.filEnv: return v.filEnv.out;
    case MOD_SRC.ampEnv: return v.ampEnv.out;
    case MOD_SRC.velocity: return v.velocitySource;
    case MOD_SRC.key: return v.keySource;
    default: return null;
  }
}

/** The summing `AudioParam`s a destination names on one voice. */
function voiceTargets(v: Voice, dst: number): AudioParam[] {
  switch (dst) {
    case MOD_DST.cutoff: return [v.filter.cutoffNote];
    case MOD_DST.resonance: return [v.filter.resonance];
    // One route drives all three oscillators, so "pitch" means the voice's pitch.
    case MOD_DST.pitch: return [v.osc1.detuneParam, v.osc2.detuneParam, v.sub.detuneParam];
    case MOD_DST.shape: return [v.filter.shape];
    case MOD_DST.amp: return [v.tremolo.gain];
    case MOD_DST.drive: return [v.filter.drive];
    default: return [];
  }
}

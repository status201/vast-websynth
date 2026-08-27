import type { Arrangement } from './arrangement';
import type { Performance } from './performance';
import type { PatternStore } from '../../state/patterns';
import { SAMPLER_SLOT_COUNT } from '../../state/patterns';
import { chokeAt, forEachActiveHit } from './step-hits';
import { clamp01 } from '../../utils/math';
import type { TickSubscriber } from './tick-source';
import { ListenerSet } from '../../utils/listeners';
import { LaneMeter } from './lane-meter';
import { rampTo, RAMP_MEDIUM, toneCutoff } from '../param-utils';
import { reverseBuffer } from '../recorder/audio-buffer';

export type SamplerStepListener = (step: number) => void;

/** Click-free cut: ramp the per-hit gain to 0 over CHOKE_FADE, stop just after. */
const CHOKE_FADE = 0.005;
/**
 * Attack ramp on a slot's per-hit gain (sampler.md REQ-11).
 *
 * User audio is exactly the material we cannot assume anything about: a sample
 * whose first frame is not near zero used to start on a full-scale step, which is
 * a click on every hit. 0.5 ms is ~24 samples at 48 kHz — Web Audio ramps are
 * sample-accurate, so this is not rounded up to a render block. Enough to turn a
 * step into a slope, far too short to soften a transient: a chop's own attack is
 * orders of magnitude longer.
 */
const SAMPLER_ATTACK = 0.0005;

const CHOKE_STOP = 0.03;

/**
 * The shortest window a `start`/`end` pair may resolve to (sampler.md REQ-13).
 * A crossed or hairline pair clamps to this instead of dropping the hit — the same
 * choice REQ-11 made for a choke that resolved to zero.
 */
const MIN_WINDOW = 0.001;

/** `res` 0 is Q 0.7 — flat, and therefore a no-op (ADR-006). */
const RES_Q_MIN = 0.7;
const RES_Q_MAX = 12;

/** A 0..1 `res` knob mapped to the slot filter's Q. */
function resQ(res: number): number {
  return RES_Q_MIN + clamp01(res) * (RES_Q_MAX - RES_Q_MIN);
}

/**
 * Hits one slot may have in flight at once (sampler.md REQ-15).
 *
 * A guard rail, not a voicing decision: 16 covers a full second of the densest
 * pattern the grid can express (a 1/16 lane with 4x ratchets is 16 hits a
 * second), so ordinary playing never reaches it. A player who hears this working
 * has already lost.
 */
const MAX_SLOT_VOICES = 16;

/**
 * A hit still sounding, or still scheduled, carrying the ENVELOPE it was
 * scheduled with (sampler.md REQ-14).
 *
 * The shape is remembered rather than read back because a choke arriving
 * mid-ramp needs the gain's value at a *future* time, and `cancelAndHoldAtTime`
 * is not available everywhere this app runs. The envelope is straight lines, so
 * computing it is exact and needs nothing of the platform.
 */
interface Hit {
  src: AudioBufferSourceNode;
  g: GainNode;
  slot: number;
  /** Start, already clamped out of the past. */
  t0: number;
  atk: number;
  vel: number;
  /** 0 = no decay stage. */
  decay: number;
  /** When the source is already scheduled to stop; Infinity until one is. */
  stopAt: number;
}

/** A hit's scheduled gain at `when` — the reason {@link Hit} carries its shape. */
function gainAt(h: Hit, when: number): number {
  if (when <= h.t0) return 0;
  if (when < h.t0 + h.atk) return h.vel * ((when - h.t0) / h.atk);
  if (h.decay > 0) {
    const into = when - h.t0 - h.atk;
    return into >= h.decay ? 0 : h.vel * (1 - into / h.decay);
  }
  return h.vel;
}

/**
 * Multi-track sampler — structurally a sibling of the DrumMachine, but each
 * of the SAMPLER_SLOT_COUNT slots plays a user-loaded AudioBuffer one-shot
 * instead of a synthesized voice. Reads the sampler bank the Arrangement
 * selects each tick. Decoded buffers live here (not in PatternStore).
 *
 * Each slot carries a channel (vol/pan/tone/res, REQ-12) and a per-hit voice
 * window (pitch/start/end/rev/attack/decay, REQ-13). Every one of those defaults
 * to a no-op, and `play()` skips their branches entirely at those defaults, so a
 * slot nobody has touched sounds exactly as it did before they existed.
 */
export class SamplerMachine {
  /** The channel's volume stage — `sampler.t{i}.vol` (REQ-12). */
  readonly slotGains: GainNode[] = [];
  readonly buffers: (AudioBuffer | null)[] = Array(SAMPLER_SLOT_COUNT).fill(null);
  readonly muted: boolean[] = Array(SAMPLER_SLOT_COUNT).fill(false);

  // ---- Per-slot channel (REQ-12): in -> tone -> vol -> pan -> samplerBus ----
  /** Unity and inert today. It is the node REQ-14's group choke will cut, and it
   *  sits *upstream* of the filter so a cut tail cannot ring on through resonance. */
  private readonly slotIn: GainNode[] = [];
  private readonly slotTones: BiquadFilterNode[] = [];
  private readonly slotPans: StereoPannerNode[] = [];

  // ---- Per-slot voice window (REQ-13), read by `play()` at trigger time ----
  private readonly pitch: number[] = Array(SAMPLER_SLOT_COUNT).fill(0);
  private readonly startF: number[] = Array(SAMPLER_SLOT_COUNT).fill(0);
  private readonly endF: number[] = Array(SAMPLER_SLOT_COUNT).fill(1);
  private readonly rev: boolean[] = Array(SAMPLER_SLOT_COUNT).fill(false);
  private readonly attackS: number[] = Array(SAMPLER_SLOT_COUNT).fill(0);
  private readonly decayS: number[] = Array(SAMPLER_SLOT_COUNT).fill(0);
  /** Reversed copies, built on the first reversed hit and dropped by `setBuffer`.
   *  Kept when `rev` goes back off — re-reversing on a live toggle would stall the
   *  main thread mid-song (ADR-018). */
  private readonly revBuffers: (AudioBuffer | null)[] = Array(SAMPLER_SLOT_COUNT).fill(null);
  /** 0 = no group; slots sharing a group cut each other (REQ-14). */
  private readonly chokeGroup: number[] = Array(SAMPLER_SLOT_COUNT).fill(0);
  private readonly mono: boolean[] = Array(SAMPLER_SLOT_COUNT).fill(false);

  private enabled = false;
  private readonly stepListeners = new ListenerSet<[number]>();
  private readonly bufferListeners = new ListenerSet<[number]>();
  /** Hits still sounding (or still scheduled), so a transport stop can cut them
   *  (REQ-8). Drums self-terminate; a user sample is any length at all. */
  private readonly inFlight = new Set<Hit>();
  /** This machine's loop length + step rate (meter.md REQ-10/REQ-14). */
  readonly lane: LaneMeter;

  constructor(
    private readonly ctx: AudioContext,
    private readonly clock: TickSubscriber,
    private readonly patterns: PatternStore,
    private readonly arrangement: Arrangement,
    private readonly perf: Performance,
    private readonly samplerBus: GainNode,
  ) {
    this.lane = new LaneMeter(clock, (s) => perf.mapStep(s));
    for (let i = 0; i < SAMPLER_SLOT_COUNT; i++) {
      // The per-slot channel (REQ-12), shaped like the drum machine's per-track one.
      // Every node is built at its no-op setting, so a slot that is never touched
      // sounds exactly as it did before the channel existed.
      const input = this.ctx.createGain();
      const tone = this.ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = toneCutoff(1);  // open
      tone.Q.value = RES_Q_MIN;              // flat
      const g = this.ctx.createGain();
      g.gain.value = 1;                      // unity — what a slot has always been
      // Force the panner's input stereo. At pan 0 a StereoPannerNode passes a
      // STEREO input straight through, but applies equal-power gain to a MONO one
      // — so without this a mono sample would arrive 3 dB quieter than it did
      // before the channel existed, which is precisely the silent re-voicing
      // ADR-006 exists to prevent. Up-mixing here (L = R = input, unity) is what
      // the graph did downstream anyway, so stereo material is unaffected and the
      // filter upstream still runs mono for a mono clip.
      g.channelCount = 2;
      g.channelCountMode = 'explicit';
      g.channelInterpretation = 'speakers';
      const pan = this.ctx.createStereoPanner();

      input.connect(tone).connect(g).connect(pan).connect(this.samplerBus);
      this.slotIn.push(input);
      this.slotTones.push(tone);
      this.slotGains.push(g);
      this.slotPans.push(pan);
    }

    clock.onTick((step, when) => this.onTick(step, when));
  }

  setEnabled(on: boolean): void { this.enabled = on; }

  onStep(fn: SamplerStepListener): () => void {
    return this.stepListeners.add(fn);
  }

  /**
   * A slot's buffer was replaced or cleared. The single hook every slot-filling
   * path funnels through (Load, the record modal, ✎ re-edit, render-to-sampler,
   * project-zip import, load-undo, New) — `SampleAutosave` persists off it
   * without any caller knowing (sample-persistence.md REQ-2).
   */
  onBufferChange(fn: (slot: number) => void): () => void {
    return this.bufferListeners.add(fn);
  }

  setSlotMute(slot: number, muted: boolean): void {
    if (this.valid(slot)) this.muted[slot] = muted;
  }

  setBuffer(slot: number, buf: AudioBuffer | null): void {
    if (!this.valid(slot)) return;
    this.buffers[slot] = buf;
    // The reversed copy belongs to the buffer it was made from (REQ-13). Dropping
    // it here — the one convergence point every fill path already goes through
    // (REQ-6) — is what keeps "reversed" from playing the previous slot's audio.
    this.revBuffers[slot] = null;
    this.bufferListeners.emit(slot);
  }

  // ---- Per-slot channel (REQ-12) — ramped, so a knob drag never zippers ----

  setSlotVol(slot: number, v: number): void {
    const g = this.slotGains[slot];
    if (g) rampTo(g.gain, v, this.ctx, RAMP_MEDIUM);
  }

  setSlotPan(slot: number, p: number): void {
    const pan = this.slotPans[slot];
    if (pan) rampTo(pan.pan, p, this.ctx, RAMP_MEDIUM);
  }

  /** Brightness: `amt` 1 = open (no-op), lower darkens the per-slot lowpass. */
  setSlotTone(slot: number, amt: number): void {
    const f = this.slotTones[slot];
    if (f) rampTo(f.frequency, toneCutoff(amt), this.ctx, RAMP_MEDIUM);
  }

  /** Bite: `amt` 0 = flat (no-op), higher peaks the same filter. */
  setSlotRes(slot: number, amt: number): void {
    const f = this.slotTones[slot];
    if (f) rampTo(f.Q, resQ(amt), this.ctx, RAMP_MEDIUM);
  }

  // ---- Per-slot voice window (REQ-13) — plain fields, read per hit ----

  /** Semitones. Varispeed, so a pitched hit also changes length. */
  setSlotPitch(slot: number, semitones: number): void {
    if (this.valid(slot)) this.pitch[slot] = semitones;
  }

  setSlotStart(slot: number, frac: number): void {
    if (this.valid(slot)) this.startF[slot] = frac;
  }

  setSlotEnd(slot: number, frac: number): void {
    if (this.valid(slot)) this.endF[slot] = frac;
  }

  setSlotRev(slot: number, on: boolean): void {
    if (this.valid(slot)) this.rev[slot] = on;
  }

  setSlotAttack(slot: number, seconds: number): void {
    if (this.valid(slot)) this.attackS[slot] = seconds;
  }

  /** 0 = off: the sample plays its natural length. */
  setSlotDecay(slot: number, seconds: number): void {
    if (this.valid(slot)) this.decayS[slot] = seconds;
  }

  /** 0 = no group. Two slots sharing a group cut each other (REQ-14). */
  setSlotChokeGroup(slot: number, group: number): void {
    if (this.valid(slot)) this.chokeGroup[slot] = Math.max(0, Math.round(group));
  }

  /** Mono: a slot cuts its own previous hit instead of layering (REQ-14). */
  setSlotMono(slot: number, on: boolean): void {
    if (this.valid(slot)) this.mono[slot] = on;
  }

  /**
   * Fade one hit out and stop it, scheduled AT `when` (REQ-14).
   *
   * Not at `currentTime`: hits are scheduled up to a look-ahead ahead, so cutting
   * at "now" would silence the old hit up to 100 ms before the new one arrives —
   * a hole exactly where a choke is supposed to be seamless.
   */
  private cutHit(h: Hit, when: number): boolean {
    const at = Math.max(when, this.ctx.currentTime);
    // Already ending sooner: re-stopping would push its end LATER, because the
    // last `stop()` call is the one that counts. Reported, so the voice cap can
    // tell a hit it actually freed from one that was already on its way out.
    if (at + CHOKE_STOP >= h.stopAt) return false;
    h.g.gain.cancelScheduledValues(at);
    h.g.gain.setValueAtTime(gainAt(h, at), at);
    h.g.gain.linearRampToValueAtTime(0, at + CHOKE_FADE);
    h.src.stop(at + CHOKE_STOP);
    h.stopAt = at + CHOKE_STOP;
    return true;
  }

  private valid(slot: number): boolean {
    return slot >= 0 && slot < SAMPLER_SLOT_COUNT;
  }

  /** The slot's reversed copy, built on first use (REQ-13). */
  private reversedBuffer(slot: number, buf: AudioBuffer): AudioBuffer {
    const cached = this.revBuffers[slot];
    if (cached) return cached;
    const made = reverseBuffer(this.ctx, buf);
    this.revBuffers[slot] = made;
    return made;
  }

  /** Manual trigger (for UI auditioning). */
  triggerSlot(slot: number, velocity = 0.9): void {
    this.play(slot, this.ctx.currentTime, velocity);
  }

  private play(slot: number, when: number, velocity: number, chokeAt?: number): void {
    const buf = this.buffers[slot];
    const out = this.slotIn[slot];
    if (!buf || !out) return;
    const src = this.ctx.createBufferSource();
    const g = this.ctx.createGain();
    const vel = clamp01(velocity);
    // `when` can be in the past (step-settings.md REQ-9); the choke shifts by the
    // same delta as the start so a short gate keeps its LENGTH instead of
    // collapsing — or resolving to 0 and dropping the hit (sampler.md REQ-11).
    const t = Math.max(when, this.ctx.currentTime);
    const shift = t - when;

    // ---- The voice window (REQ-13) ----
    // Every branch below is skipped at the slot's defaults, so an untouched slot
    // takes the pre-v8 path exactly: no rate write, no start offset, no scheduled
    // stop. That is what makes ADR-006's promise here a code path, not a claim.
    const pitch = this.pitch[slot] ?? 0;
    const rate = pitch === 0 ? 1 : Math.pow(2, pitch / 12);
    if (pitch !== 0) src.playbackRate.value = rate;

    const dur = buf.duration;
    let startSec = clamp01(this.startF[slot] ?? 0) * dur;
    let endSec = clamp01(this.endF[slot] ?? 1) * dur;
    if (endSec < startSec + MIN_WINDOW) {
      endSec = Math.min(startSec + MIN_WINDOW, dur);
      startSec = Math.max(0, endSec - MIN_WINDOW);
    }
    const trimmed = startSec > 0 || endSec < dur;
    // The window is stated in FORWARD coordinates and mapped onto the reversed copy,
    // so the numbers keep meaning what the user sees on the waveform.
    const reversed = this.rev[slot] ?? false;
    src.buffer = reversed ? this.reversedBuffer(slot, buf) : buf;
    const offset = reversed ? dur - endSec : startSec;

    const atk = Math.max(this.attackS[slot] ?? 0, SAMPLER_ATTACK);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + atk);
    src.connect(g).connect(out);
    if (offset > 0) src.start(t, offset); else src.start(t);

    // ---- One cut, at whichever reason comes first (REQ-13) ----
    // The window's end, the step gate's choke, and the decay's end are all known
    // here, so the shortest is picked BEFORE anything is scheduled. Deciding late
    // would mean re-writing an automation curve already in flight, which needs
    // `cancelAndHoldAtTime` — not available everywhere this app runs.
    let hard: number | undefined;
    if (trimmed) hard = t + (endSec - startSec) / rate;
    if (chokeAt !== undefined) {
      const gate = chokeAt + shift;
      hard = hard === undefined ? gate : Math.min(hard, gate);
    }
    if (hard !== undefined) hard = Math.max(hard, t + atk);
    const decay = this.decayS[slot] ?? 0;
    const decayEnd = decay > 0 ? t + atk + decay : undefined;

    let hardStop: number | undefined;
    if (decayEnd !== undefined && (hard === undefined || decayEnd <= hard)) {
      // The decay is the tail: ramp to true zero and stop on arrival.
      g.gain.linearRampToValueAtTime(0, decayEnd);
      src.stop(decayEnd + CHOKE_STOP);
      hardStop = decayEnd + CHOKE_STOP;
    } else if (hard !== undefined) {
      if (decayEnd === undefined) {
        g.gain.setValueAtTime(vel, hard);
      } else {
        // Truncating a linear decay by ramping to its own value at the cut is exact.
        g.gain.linearRampToValueAtTime(Math.max(0, vel * (1 - (hard - t - atk) / decay)), hard);
      }
      g.gain.linearRampToValueAtTime(0, hard + CHOKE_FADE);
      src.stop(hard + CHOKE_STOP);
      hardStop = hard + CHOKE_STOP;
    }

    const hit: Hit = {
      src, g, slot, t0: t, atk, vel, decay,
      stopAt: hardStop ?? (decayEnd !== undefined ? decayEnd + CHOKE_STOP : Infinity),
    };

    // REQ-14 — resolved BEFORE this hit joins the set, so it never cuts itself.
    const group = this.chokeGroup[slot] ?? 0;
    if (group > 0) {
      for (const other of this.inFlight) {
        if ((this.chokeGroup[other.slot] ?? 0) === group) this.cutHit(other, t);
      }
    } else if (this.mono[slot]) {
      for (const other of this.inFlight) {
        if (other.slot === slot) this.cutHit(other, t);
      }
    }

    this.inFlight.add(hit);

    // REQ-15 — bounded polyphony. Oldest first: a Set preserves insertion order,
    // and the oldest hit is both nearest its own end and least likely to be the
    // one a listener is following.
    let live = 0;
    for (const h of this.inFlight) if (h.slot === slot) live++;
    for (const h of this.inFlight) {
      if (live <= MAX_SLOT_VOICES) break;
      if (h.slot !== slot || h === hit) continue;
      // Only a hit this call actually cut has been freed. A cut hit lingers in
      // the set for its fade, so counting those too would stop the sweep early
      // and let the slot drift back over the cap.
      if (this.cutHit(h, t)) live--;
    }

    src.onended = () => { this.inFlight.delete(hit); src.disconnect(); g.disconnect(); };
  }

  /**
   * Cut every hit still sounding, with the same short fade the gate choke uses so
   * the cut never clicks (REQ-8). The fade is on the per-hit gain, upstream of
   * `samplerBus`, so the FX tails ring out untouched — Stop silences the source,
   * not the room. A hit still scheduled inside the look-ahead simply never plays.
   *
   * Public because *when* to cut is the Engine's call, not the machine's: a stop
   * that ends a capture is deliberately rendering the tail and must not chop the
   * last bar's one-shots out of it.
   */
  stopAll(): void {
    const now = this.ctx.currentTime;
    for (const h of this.inFlight) {
      h.g.gain.cancelScheduledValues(now);
      h.g.gain.setValueAtTime(h.g.gain.value, now);
      h.g.gain.linearRampToValueAtTime(0, now + CHOKE_FADE);
      h.src.stop(now + CHOKE_STOP);
      h.stopAt = now + CHOKE_STOP;
    }
    // `onended` empties the set as each source actually stops.
  }

  private onTick(step: number, when: number): void {
    if (!this.enabled) return;
    this.lane.forEachHit(step, when, (idx, at, cellDur) => {
      this.stepListeners.emit(idx);

      // Arrangement rest bar: keep the playhead moving but trigger nothing.
      if (this.arrangement.samplerResting) return;

      // Sampler plays through drum fills (no fill behaviour of its own).
      const bank = this.patterns.samplerBank(this.arrangement.samplerPlayBank);
      forEachActiveHit(bank, idx, at, cellDur, this.muted, (s, h, cell) => {
        this.play(s, h.t, cell.velocity, chokeAt(cell, h));
      });
    });
  }
}

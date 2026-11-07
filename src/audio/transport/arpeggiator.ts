import type { ParamBus } from '../../state/params';
import type { SynthOutput } from './note-output';
import type { TickSubscriber } from './tick-source';
import { ScaleQuantizer } from './scale-quantizer';
import { LaneMeter } from './lane-meter';
import { MIDI_NOTE_MAX } from '../../state/limits';
import { LANE_RATES } from '../../state/meter';
import { ARP_RATE_LABELS } from '../../state/params';

/**
 * `arp.rate` index → the `LANE_RATES` row with the same label, so an arp at 1/8
 * runs on exactly the grid a 1/8 lane does (arpeggiator.md
 * REQ-the-arp-runs-on-a-lanes-grid). Resolved once; a label with no lane row
 * falls back to 1/16.
 */
const ARP_LANE_RATE: readonly number[] = ARP_RATE_LABELS.map((label) => {
  const i = LANE_RATES.findIndex((r) => r.label === label);
  return i >= 0 ? i : LANE_RATES.findIndex((r) => r.label === '1/16');
});

/**
 * Held-note arpeggiator. While enabled, presses on the keyboard/MIDI are
 * suppressed at the Engine level; the arp owns the playback schedule and
 * generates timed note events on each clock tick.
 */
export class Arpeggiator {
  private enabled = false;
  private pattern = 0;
  /**
   * Where the arp's hits fall: the same onsets, swing and cell length a lane at
   * this rate gets (meter.md REQ-coarser-skips-ticks-finer-fans-out,
   * REQ-swing-is-computed-on-the-lanes-grid). No stutter fold and no chain: the
   * arp follows held keys, not a pattern, so only its onsets are read.
   */
  private readonly lane: LaneMeter;
  private octaves = 1;
  private gate = 0.5;
  private heldOrder: number[] = []; // in press order
  private heldSet = new Set<number>();
  private direction = 1; // for up-down
  private cursor = 0;

  /** The note the arp last struck — released before the next one sounds. */
  private lastNote: number | null = null;

  /** True while the transport is running because the arp auto-started it. */
  private startedTransport = false;

  passthroughSuppressed = false;

  constructor(
    private readonly output: SynthOutput,
    bus: ParamBus,
    private readonly clock: TickSubscriber,
    private readonly scale: ScaleQuantizer = new ScaleQuantizer(),
  ) {
    this.lane = new LaneMeter(clock);
    this.setRate(2); // 1/16, the param's default
    bus.onNote((on, note) => {
      if (!this.enabled) return;
      if (on) {
        if (!this.heldSet.has(note)) {
          this.heldOrder.push(note);
          this.heldSet.add(note);
        }
        // Holding a key with the arp engaged starts the transport itself, so
        // you hear the arpeggio without separately pressing Play.
        this.maybeStartTransport();
      } else {
        this.heldSet.delete(note);
        const idx = this.heldOrder.indexOf(note);
        if (idx >= 0) this.heldOrder.splice(idx, 1);
        if (this.heldOrder.length === 0) {
          this.lastNote = null;
          this.cursor = 0;
          this.maybeStopTransport();
        }
      }
    });

    clock.onTick((step, when) => this.onTick(step, when));
    // If the transport stops by any other means (Play toggle, panic, export),
    // the arp no longer owns it — so a later key release won't stop it again.
    clock.onStop(() => { this.startedTransport = false; });
  }

  /** Start the transport when the arp gains its first held note. */
  private maybeStartTransport(): void {
    if (this.clock.playing) return; // already running → don't take ownership
    this.startedTransport = true;
    this.clock.start();
  }

  /** Stop the transport on key-release — but only if the arp started it. */
  private maybeStopTransport(): void {
    if (!this.startedTransport) return;
    this.startedTransport = false;
    this.clock.stop();
  }

  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    // While arp is on, the engine ignores direct key presses;
    // arp will drive playback itself.
    this.passthroughSuppressed = on;
    if (!on) {
      this.heldOrder = [];
      this.heldSet.clear();
      this.lastNote = null;
      this.maybeStopTransport(); // relinquish a transport the arp auto-started
    }
  }

  setPattern(p: number): void { this.pattern = Math.round(p); }
  setRate(r: number): void {
    const i = Number.isFinite(r) ? Math.round(r) : 2;
    this.lane.setRate(ARP_LANE_RATE[i] ?? ARP_LANE_RATE[2]!);
  }
  setOctaves(o: number): void { this.octaves = Math.max(1, Math.min(4, Math.round(o))); }
  setGate(g: number): void { this.gate = Math.max(0.05, Math.min(1, g)); }

  private onTick(step: number, when: number): void {
    if (!this.enabled || this.heldOrder.length === 0) return;
    // The lane's grid decides every onset: none on a tick a coarser rate skips,
    // two inside one tick at 1/32 (REQ-a-sub-16th-rate-schedules-its-own-hits),
    // and swing applied on the arp's own grid, so a 1/8 arp swings its off-beat
    // eighths instead of sitting dead straight under swung hats
    // (REQ-the-arp-runs-on-a-lanes-grid). The gate is a fraction of the cell, as
    // every machine's is.
    this.lane.forEachHit(step, when, (_cell, at, cellDur) => this.fire(at, cellDur));
  }

  /** Pick this step's note and schedule it for `when`, holding it for `stepDur`
   *  × gate. Advances the pattern cursor — one call is one arpeggiated note. */
  private fire(when: number, stepDur: number): void {
    // Build the full note pool (held notes × octave range), ordered low to high.
    // Chord memory widens the pool BEFORE stacking, and the key is applied AFTER it,
    // so the octave copies land in scale too (arpeggiator.md REQ-arp-pool-is-expanded-then-quantized). Expanding here
    // as well as in the engine's passthrough is required, not duplicated by accident:
    // REQ-arp-takes-over-the-note-stream means an engaged arp takes the note stream away from the engine entirely.
    const held = this.expand(this.heldOrder);
    const pool = this.stack([...held].sort((a, b) => a - b));
    if (pool.length === 0) return;

    let note: number;
    switch (this.pattern) {
      case 0: // up
        note = pool[this.cursor % pool.length]!;
        this.cursor++;
        break;
      case 1: // down
        note = pool[(pool.length - 1 - (this.cursor % pool.length))]!;
        this.cursor++;
        break;
      case 2: // up-down
        if (pool.length === 1) {
          note = pool[0]!;
        } else {
          // Re-clamp against the pool we are ABOUT to read. Every other pattern
          // wraps with `% pool.length`; this one indexes directly because the
          // bounce needs a real position — so a pool that shrank since the last
          // note (a key released) would otherwise read past the end, and
          // `pool[i]!` hands `undefined` to an AudioParam, which throws
          // (REQ-the-cursor-is-bounded-by-the-live-pool).
          if (this.cursor > pool.length - 1) { this.cursor = pool.length - 1; this.direction = -1; }
          if (this.cursor < 0) { this.cursor = 0; this.direction = 1; }
          note = pool[this.cursor]!;
          this.cursor += this.direction;
          if (this.cursor >= pool.length - 1) { this.cursor = pool.length - 1; this.direction = -1; }
          else if (this.cursor <= 0) { this.cursor = 0; this.direction = 1; }
        }
        break;
      case 3: // random
        note = pool[Math.floor(Math.random() * pool.length)]!;
        break;
      case 4: // as-played
        {
          const ordered = this.stack(held);
          note = ordered[this.cursor % ordered.length]!;
          this.cursor++;
        }
        break;
      default:
        note = pool[0]!;
    }

    // Release the previous arp note before triggering the next
    if (this.lastNote !== null) this.output.releaseNote(this.lastNote, when);

    const gateLen = stepDur * this.gate;
    this.output.playNote(note, 0.85, when);
    this.output.releaseNote(note, when + gateLen);
    this.lastNote = note;
  }

  /**
   * `notes` stacked over the octave range and quantized to the key, in that order
   * (REQ-arp-pool-is-expanded-then-quantized). A copy above MIDI 127 is dropped,
   * not clamped — clamping would stack repeated 127s into the pattern
   * (REQ-the-pool-stays-in-midi-range). Only if that leaves nothing does a held
   * note that quantized past the top still sound, at 127.
   */
  private stack(notes: readonly number[]): number[] {
    const out: number[] = [];
    for (let o = 0; o < this.octaves; o++) {
      for (const n of notes) {
        const q = this.scale.get(n + o * 12);
        if (q <= MIDI_NOTE_MAX) out.push(q);
      }
    }
    if (out.length === 0 && notes.length > 0) out.push(MIDI_NOTE_MAX);
    return out;
  }

  /**
   * Held notes widened through chord memory, preserving press order so `as-played`
   * still means what it says (chord-tools.md REQ-chord-memory-reaches-the-arp).
   *
   * Returns the source array itself when chord memory is inert, so the default path
   * allocates nothing beyond what `fire` already copies.
   */
  private expand(notes: readonly number[]): readonly number[] {
    if (!this.scale.chordActive) return notes;
    const out: number[] = [];
    for (const n of notes) for (const c of this.scale.chord(n)) out.push(c);
    return out;
  }
}

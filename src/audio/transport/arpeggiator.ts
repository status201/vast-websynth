import type { ParamBus } from '../../state/params';
import type { SynthOutput } from './note-output';
import type { TickSubscriber } from './tick-source';

// Dropdown labels live in ARP_PATTERN_LABELS / ARP_RATE_LABELS (state/params.ts).
const RATE_DIVISIONS = [4, 2, 1, 0.5]; // 16ths per step at each rate

/**
 * Held-note arpeggiator. While enabled, presses on the keyboard/MIDI are
 * suppressed at the Engine level; the arp owns the playback schedule and
 * generates timed note events on each clock tick.
 */
export class Arpeggiator {
  private enabled = false;
  private pattern = 0;
  private rateIdx = 2; // 16th
  private octaves = 1;
  private gate = 0.5;
  private heldOrder: number[] = []; // in press order
  private heldSet = new Set<number>();
  private direction = 1; // for up-down
  private cursor = 0;

  private lastTriggered: { note: number; when: number; release: number } | null = null;

  /** True while the transport is running because the arp auto-started it. */
  private startedTransport = false;

  passthroughSuppressed = false;

  constructor(
    private readonly output: SynthOutput,
    private readonly bus: ParamBus,
    private readonly clock: TickSubscriber,
  ) {
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
          this.lastTriggered = null;
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
      this.lastTriggered = null;
      this.maybeStopTransport(); // relinquish a transport the arp auto-started
    }
  }

  setPattern(p: number): void { this.pattern = Math.round(p); }
  setRate(r: number): void { this.rateIdx = Math.round(r); }
  setOctaves(o: number): void { this.octaves = Math.max(1, Math.min(4, Math.round(o))); }
  setGate(g: number): void { this.gate = Math.max(0.05, Math.min(1, g)); }

  private onTick(step: number, when: number): void {
    if (!this.enabled || this.heldOrder.length === 0) return;
    const division = RATE_DIVISIONS[this.rateIdx] ?? 1;
    // Trigger only on steps that fall on the chosen subdivision boundary
    if (division >= 1) {
      if (step % division !== 0) return;
    } else {
      // 1/32 — twice per 16th; we run on every tick AND a half-tick offset.
      // Approximation: just run every tick (clock is already 16ths) — keeps it sample-accurate enough.
    }

    // Build the full note pool (held notes × octave range), ordered low to high.
    const sorted = [...this.heldOrder].sort((a, b) => a - b);
    const pool: number[] = [];
    for (let o = 0; o < this.octaves; o++) {
      for (const n of sorted) pool.push(n + o * 12);
    }
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
          const ordered: number[] = [];
          for (let o = 0; o < this.octaves; o++) {
            for (const n of this.heldOrder) ordered.push(n + o * 12);
          }
          note = ordered[this.cursor % ordered.length]!;
          this.cursor++;
        }
        break;
      default:
        note = pool[0]!;
    }

    // Release the previous arp note before triggering the next
    if (this.lastTriggered) this.output.releaseNote(this.lastTriggered.note, when);

    const stepDur = this.clock.sixteenthDuration() * (division >= 1 ? division : 1);
    const gateLen = stepDur * this.gate;
    this.output.playNote(note, 0.85, when);
    const release = when + gateLen;
    this.output.releaseNote(note, release);
    this.lastTriggered = { note, when, release };
  }
}

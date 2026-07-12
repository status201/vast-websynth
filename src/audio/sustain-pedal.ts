/**
 * Sustain-pedal (MIDI CC64) note-off deferral — input-control.md REQ-8.
 *
 * Pure state machine, no imports: sits in the MIDI layer *before* the
 * `bus.noteOn`/`noteOff` funnel, so every bus consumer sees the deferral
 * (with the arpeggiator on, the pedal doubles as an arp latch — intended).
 * Half-pedalling is out of scope: value ≥ 64 is "down", anything below "up".
 */
export class SustainPedal {
  private pedalDown = false;
  /** Notes with a physical key currently down. */
  private readonly held = new Set<number>();
  /** Notes released while the pedal was down — note-off deferred. */
  private readonly sustained = new Set<number>();

  /** Track a note-on. A note retriggered while sustained is live again —
   *  its pending flush is cancelled so the new press can't be cut short. */
  noteOn(note: number): void {
    this.held.add(note);
    this.sustained.delete(note);
  }

  /** Track a note-off. Returns `true` when it should pass through to
   *  `bus.noteOff`, `false` when the pedal defers it. */
  noteOff(note: number): boolean {
    this.held.delete(note);
    if (!this.pedalDown) return true;
    this.sustained.add(note);
    return false;
  }

  /** Set the pedal state. Returns the notes whose deferred note-off must now
   *  fire (non-empty only on a down → up transition). */
  setPedal(down: boolean): number[] {
    this.pedalDown = down;
    if (down) return [];
    const flush = [...this.sustained];
    this.sustained.clear();
    return flush;
  }
}

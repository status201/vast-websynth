import type { Engine } from '../engine';
import type { Clock } from './clock';
import type { Arrangement } from './arrangement';
import type { Performance } from './performance';
import type { PatternStore } from '../../state/patterns';
import { SEQ_LENGTH } from '../../state/patterns';

export type StepListener = (step: number) => void;

/**
 * Monophonic 16-step note sequencer. Triggers the synth engine on each
 * active step. Keyboard input still passes through (it can layer on top).
 */
export class StepSequencer {
  private enabled = false;
  private lastPlayedNote = -1;
  private lastReleaseAt = 0;
  private readonly stepListeners = new Set<StepListener>();

  constructor(
    private readonly engine: Engine,
    private readonly clock: Clock,
    private readonly patterns: PatternStore,
    private readonly arrangement: Arrangement,
    private readonly perf: Performance,
  ) {
    clock.onTick((step, when) => this.onTick(step, when));
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on && this.lastPlayedNote >= 0) {
      this.engine.releaseNote(this.lastPlayedNote);
      this.lastPlayedNote = -1;
    }
  }

  onStep(fn: StepListener): () => void {
    this.stepListeners.add(fn);
    return () => { this.stepListeners.delete(fn); };
  }

  private onTick(step: number, when: number): void {
    if (!this.enabled) return;
    const idx = this.perf.mapStep(step) % SEQ_LENGTH;
    for (const l of this.stepListeners) l(idx);
    const s = this.patterns.seqBank(this.arrangement.seqPlayBank)[idx];
    if (!s || !s.on) return;

    // Release previous note before the next attack
    if (this.lastPlayedNote >= 0) this.engine.releaseNote(this.lastPlayedNote, when);

    const stepDur = this.clock.sixteenthDuration();
    const gateLen = stepDur * s.gate;
    this.engine.playNote(s.note, s.velocity, when);
    this.engine.releaseNote(s.note, when + gateLen);
    this.lastPlayedNote = s.note;
    this.lastReleaseAt = when + gateLen;
  }
}

import type { PatternStore } from '../../state/patterns';
import { SEQ_LENGTH, REST, clampChainStep } from '../../state/patterns';
import type { TickSubscriber } from './tick-source';

/**
 * Song arrangement: two independent chain lanes (sequencer and drums).
 *
 * Each lane is an ordered list of bank indices (e.g. A A B A → [0,0,1,0]).
 * While a lane is enabled the transport plays bank `steps[pos]`, advancing
 * `pos` by one every bar (every SEQ_LENGTH ticks). While a lane is disabled
 * its play bank simply follows that machine's UI edit bank (bar-quantised).
 *
 * Instantiated *before* the sequencer / drum machine so its clock tick
 * listener runs first and the play banks are settled before the machines
 * read them for the same tick.
 */
export interface ChainLane {
  enabled: boolean;
  steps: number[]; // bank indices
}

export class Arrangement {
  readonly seq: ChainLane = { enabled: false, steps: [0] };
  readonly drum: ChainLane = { enabled: false, steps: [0] };
  readonly sampler: ChainLane = { enabled: false, steps: [0] };

  seqPlayBank = 0;
  drumPlayBank = 0;
  samplerPlayBank = 0;

  // True while an enabled lane's current slot is a REST (an empty bar): the
  // machine plays silence this bar. See arrangement-rest.md.
  seqResting = false;
  drumResting = false;
  samplerResting = false;

  private seqPos = 0;
  private drumPos = 0;
  private samplerPos = 0;
  private expectFirstBar = true;
  private readonly changeListeners = new Set<() => void>();

  constructor(private readonly patterns: PatternStore, clock: TickSubscriber) {
    clock.onStart(() => {
      this.seqPos = 0;
      this.drumPos = 0;
      this.samplerPos = 0;
      this.expectFirstBar = true;
      this.recompute();
      this.notify();
    });

    clock.onTick((step) => {
      if (step % SEQ_LENGTH !== 0) return;
      if (this.expectFirstBar) {
        this.expectFirstBar = false;
        this.seqPos = 0;
        this.drumPos = 0;
        this.samplerPos = 0;
      } else {
        if (this.seq.enabled && this.seq.steps.length) {
          this.seqPos = (this.seqPos + 1) % this.seq.steps.length;
        }
        if (this.drum.enabled && this.drum.steps.length) {
          this.drumPos = (this.drumPos + 1) % this.drum.steps.length;
        }
        if (this.sampler.enabled && this.sampler.steps.length) {
          this.samplerPos = (this.samplerPos + 1) % this.sampler.steps.length;
        }
      }
      this.recompute();
      this.notify();
    });

    this.recompute();
  }

  get seqChainPos(): number { return this.seqPos; }
  get drumChainPos(): number { return this.drumPos; }
  get samplerChainPos(): number { return this.samplerPos; }

  setSeqChain(steps: number[], enabled: boolean): void {
    this.seq.steps = steps.length ? steps.map(clampChainStep) : [0];
    this.seq.enabled = enabled;
    this.seqPos = 0;
    this.recompute();
    this.notify();
  }

  setDrumChain(steps: number[], enabled: boolean): void {
    this.drum.steps = steps.length ? steps.map(clampChainStep) : [0];
    this.drum.enabled = enabled;
    this.drumPos = 0;
    this.recompute();
    this.notify();
  }

  setSamplerChain(steps: number[], enabled: boolean): void {
    this.sampler.steps = steps.length ? steps.map(clampChainStep) : [0];
    this.sampler.enabled = enabled;
    this.samplerPos = 0;
    this.recompute();
    this.notify();
  }

  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => { this.changeListeners.delete(fn); };
  }

  private notify(): void {
    for (const l of this.changeListeners) l();
  }

  private recompute(): void {
    const seq = resolveLane(this.seq, this.seqPos, this.patterns.seqEditBank);
    this.seqPlayBank = seq.playBank;
    this.seqResting = seq.resting;
    const drum = resolveLane(this.drum, this.drumPos, this.patterns.drumEditBank);
    this.drumPlayBank = drum.playBank;
    this.drumResting = drum.resting;
    const sampler = resolveLane(this.sampler, this.samplerPos, this.patterns.samplerEditBank);
    this.samplerPlayBank = sampler.playBank;
    this.samplerResting = sampler.resting;
  }
}

/**
 * Resolve a lane's play bank + resting state for the current bar. An enabled lane
 * plays its current slot; a REST slot yields `resting` (silence — the play bank is
 * a safe real index never read for triggering). A disabled lane follows the
 * machine's edit bank and never rests.
 */
function resolveLane(
  lane: ChainLane,
  pos: number,
  editBank: number,
): { playBank: number; resting: boolean } {
  if (!lane.enabled || !lane.steps.length) return { playBank: editBank, resting: false };
  const step = lane.steps[pos % lane.steps.length] ?? 0;
  if (step === REST) return { playBank: 0, resting: true };
  return { playBank: clampChainStep(step), resting: false };
}

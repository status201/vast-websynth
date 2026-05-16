import type { Clock } from './clock';
import type { PatternStore } from '../../state/patterns';
import { SEQ_LENGTH, BANK_COUNT } from '../../state/patterns';

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

function clampBank(i: number): number {
  return Math.max(0, Math.min(BANK_COUNT - 1, Math.round(i)));
}

export class Arrangement {
  readonly seq: ChainLane = { enabled: false, steps: [0] };
  readonly drum: ChainLane = { enabled: false, steps: [0] };
  readonly sampler: ChainLane = { enabled: false, steps: [0] };

  seqPlayBank = 0;
  drumPlayBank = 0;
  samplerPlayBank = 0;

  private seqPos = 0;
  private drumPos = 0;
  private samplerPos = 0;
  private expectFirstBar = true;
  private readonly changeListeners = new Set<() => void>();

  constructor(private readonly patterns: PatternStore, clock: Clock) {
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
    this.seq.steps = steps.length ? steps.map(clampBank) : [0];
    this.seq.enabled = enabled;
    this.seqPos = 0;
    this.recompute();
    this.notify();
  }

  setDrumChain(steps: number[], enabled: boolean): void {
    this.drum.steps = steps.length ? steps.map(clampBank) : [0];
    this.drum.enabled = enabled;
    this.drumPos = 0;
    this.recompute();
    this.notify();
  }

  setSamplerChain(steps: number[], enabled: boolean): void {
    this.sampler.steps = steps.length ? steps.map(clampBank) : [0];
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
    this.seqPlayBank = this.seq.enabled && this.seq.steps.length
      ? clampBank(this.seq.steps[this.seqPos % this.seq.steps.length] ?? 0)
      : this.patterns.seqEditBank;
    this.drumPlayBank = this.drum.enabled && this.drum.steps.length
      ? clampBank(this.drum.steps[this.drumPos % this.drum.steps.length] ?? 0)
      : this.patterns.drumEditBank;
    this.samplerPlayBank = this.sampler.enabled && this.sampler.steps.length
      ? clampBank(this.sampler.steps[this.samplerPos % this.sampler.steps.length] ?? 0)
      : this.patterns.samplerEditBank;
  }
}

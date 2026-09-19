import type { Machine, PatternStore } from '../../state/patterns';
import { REST, clampChainStep, clampTranspose } from '../../state/patterns';
import { DEFAULT_BAR_TICKS } from '../../state/meter';
import type { TickSubscriber } from './tick-source';

/**
 * Song arrangement: independent chain lanes (sequencer, drums, sampler, motion).
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
  /**
   * Semitone offset per slot, **parallel to `steps`** and always the same length
   * (arrangement.md REQ-a-seq-slot-carries-a-transpose). `0` — the value every existing path produces — means
   * "as written", so this is a no-op field for every song that predates it.
   *
   * Only the **seq** lane acts on it: drums and the sampler are unpitched and
   * motion carries parameters, not notes. The other three lanes keep the field
   * so there is one `ChainLane` type, and ignore it.
   */
  transpose: number[];
}

/** Alias of `PatternStore`'s `Machine`, so a lane and its machine are one union. */
export type LaneName = Machine;

const ALL_LANES: readonly LaneName[] = ['seq', 'drum', 'sampler', 'motion'];

export class Arrangement {
  readonly seq: ChainLane = { enabled: false, steps: [0], transpose: [0] };
  readonly drum: ChainLane = { enabled: false, steps: [0], transpose: [0] };
  readonly sampler: ChainLane = { enabled: false, steps: [0], transpose: [0] };
  readonly motion: ChainLane = { enabled: false, steps: [0], transpose: [0] };

  seqPlayBank = 0;
  drumPlayBank = 0;
  samplerPlayBank = 0;
  motionPlayBank = 0;

  /**
   * The semitone offset of the seq lane's current slot — what `StepSequencer`
   * adds to every note it triggers (sequencer.md REQ-every-note-is-shifted-by-the-slot-transpose). `0` whenever the lane
   * is disabled or resting, so the un-chained path is untouched.
   *
   * Recomputed in `recompute()` alongside the play banks, for the same reason
   * they are: the machines read it on the same tick and it must be settled first.
   */
  seqTranspose = 0;

  // True while an enabled lane's current slot is a REST (an empty bar): the
  // machine plays silence this bar. See arrangement-rest.md.
  seqResting = false;
  drumResting = false;
  samplerResting = false;
  motionResting = false;

  // The motion lane alone also resolves its neighbouring *bars*: the motion
  // curve's bar-line segment ramps between banks, so it needs to know what
  // played before and what plays next (motion-sequencer.md REQ-cross-bank-carry). The audio
  // lanes have no such continuity, hence no neighbour fields.
  motionPrevPlayBank = 0;
  motionNextPlayBank = 0;
  motionPrevResting = false;
  motionNextResting = false;

  private seqPos = 0;
  private drumPos = 0;
  private samplerPos = 0;
  private motionPos = 0;
  private expectFirstBar = true;
  private readonly changeListeners = new Set<() => void>();

  /**
   * Bar length in 16th ticks (meter.md REQ-bar-ticks-is-the-arrangement-bar-line). `DEFAULT_BAR_TICKS` is 4/4, so an
   * Arrangement nobody has told about the meter behaves exactly as it always
   * did. The Engine pushes changes here from `transport.beats`/`beatUnit`.
   */
  private barTicks = DEFAULT_BAR_TICKS;

  constructor(private readonly patterns: PatternStore, private readonly clock: TickSubscriber) {
    // Seek to the bar implied by the start step (0 for a plain start, nonzero
    // for a clock-sync Song-Position join — arrangement.md REQ-start-seeks-every-lane). Reading
    // clock.step here is safe: Clock.start seeds _step before firing onStart.
    clock.onStart(() => this.seekTo(this.clock.step));

    // A manual playhead move needs the identical re-base (arrangement.md REQ-a-mid-play-seek-re-seeks-every-lane).
    // Lane positions are counted *relatively* — +1 per bar line — so without
    // this a jump leaves every chain off by (bars jumped - 1) and keeps playing
    // the wrong banks for the rest of the song.
    clock.onSeek(() => this.seekTo(this.clock.step));

    clock.onTick((step) => {
      if (step % this.barTicks !== 0) return;
      if (this.expectFirstBar) {
        // Positions were set by onStart; just consume the flag (don't re-zero).
        this.expectFirstBar = false;
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
        if (this.motion.enabled && this.motion.steps.length) {
          this.motionPos = (this.motionPos + 1) % this.motion.steps.length;
        }
      }
      this.recompute();
      this.notify();
    });

    this.recompute();
  }

  /**
   * Re-base every lane onto the bar `step` implies. Shared by `clock.onStart`
   * and `clock.onSeek` (arrangement.md REQ-start-seeks-every-lane/REQ-a-mid-play-seek-re-seeks-every-lane) — the two moments the
   * absolute step number changes without a bar line having elapsed.
   */
  seekTo(step: number): void {
    const bar = Math.floor(step / this.barTicks);
    this.seqPos = laneSeek(this.seq, bar);
    this.drumPos = laneSeek(this.drum, bar);
    this.samplerPos = laneSeek(this.sampler, bar);
    this.motionPos = laneSeek(this.motion, bar);
    // A bar-aligned position suppresses the first boundary's increment (that
    // boundary IS this bar); a mid-bar one lets the next boundary — the genuine
    // next bar — advance.
    this.expectFirstBar = step % this.barTicks === 0;
    this.recompute();
    this.notify();
  }

  /**
   * How many bars the song runs before it repeats: the longest **enabled** lane,
   * or `0` when no lane is enabled (each caller applies its own fallback).
   *
   * `lanes` narrows which lanes count, because "how long is the song" has two
   * legitimate answers here. The transport scrubber
   * ([transport-window.md](../../../specs/features/transport-window.md)) asks
   * about all four; audio export asks only about the three audible ones, since
   * that is the length it has always rendered.
   */
  songBars(lanes: readonly LaneName[] = ALL_LANES): number {
    let bars = 0;
    for (const name of lanes) {
      const lane = this[name];
      if (lane.enabled && lane.steps.length > bars) bars = lane.steps.length;
    }
    return bars;
  }

  get seqChainPos(): number { return this.seqPos; }
  get drumChainPos(): number { return this.drumPos; }
  get samplerChainPos(): number { return this.samplerPos; }
  get motionChainPos(): number { return this.motionPos; }

  /**
   * @param transpose per-slot semitone offsets (arrangement.md REQ-a-seq-slot-carries-a-transpose). Omitted
   * by every caller that does not arrange pitch — including the whole pre-v7
   * corpus — in which case the lane keeps the offsets it already had, resized to
   * the new chain. That is what lets `◀ ▶ ✕` and the bank-add buttons keep
   * calling this with two arguments and still do the right thing.
   */
  /**
   * Set the bar length in 16th ticks (meter.md REQ-bar-ticks-is-the-arrangement-bar-line). Idempotent, so the
   * Engine can push it on any param change.
   *
   * A meter change moves every bar line, which makes the lane positions counted
   * against the old grid stale — so it re-bases through the same `seekTo` a
   * playhead jump uses (arrangement.md REQ-a-mid-play-seek-re-seeks-every-lane). Without that, switching to 7/8
   * mid-play leaves each chain on whatever slot the 4/4 grid had reached and the
   * next boundary double-advances.
   */
  setBarTicks(ticks: number): void {
    const n = Number.isFinite(ticks) ? Math.max(1, Math.round(ticks)) : DEFAULT_BAR_TICKS;
    if (n === this.barTicks) return;
    this.barTicks = n;
    this.seekTo(this.clock.step);
  }

  setSeqChain(steps: number[], enabled: boolean, transpose?: number[]): void {
    // NOT `steps.map(clampChainStep)` — Array.map passes the INDEX as the
    // second argument, which would silently become the bank bound.
    const n = this.laneBankCount('seq');
    this.seq.steps = steps.length ? steps.map((s) => clampChainStep(s, n)) : [0];
    this.seq.transpose = fitTranspose(transpose ?? this.seq.transpose, this.seq.steps.length);
    this.seq.enabled = enabled;
    this.seqPos = 0;
    this.recompute();
    this.notify();
  }

  setDrumChain(steps: number[], enabled: boolean): void {
    // NOT `steps.map(clampChainStep)` — Array.map passes the INDEX as the
    // second argument, which would silently become the bank bound.
    const n = this.laneBankCount('drum');
    this.drum.steps = steps.length ? steps.map((s) => clampChainStep(s, n)) : [0];
    this.drum.transpose = fitTranspose(this.drum.transpose, this.drum.steps.length);
    this.drum.enabled = enabled;
    this.drumPos = 0;
    this.recompute();
    this.notify();
  }

  setSamplerChain(steps: number[], enabled: boolean): void {
    // NOT `steps.map(clampChainStep)` — Array.map passes the INDEX as the
    // second argument, which would silently become the bank bound.
    const n = this.laneBankCount('sampler');
    this.sampler.steps = steps.length ? steps.map((s) => clampChainStep(s, n)) : [0];
    this.sampler.transpose = fitTranspose(this.sampler.transpose, this.sampler.steps.length);
    this.sampler.enabled = enabled;
    this.samplerPos = 0;
    this.recompute();
    this.notify();
  }

  setMotionChain(steps: number[], enabled: boolean): void {
    // NOT `steps.map(clampChainStep)` — Array.map passes the INDEX as the
    // second argument, which would silently become the bank bound.
    const n = this.laneBankCount('motion');
    this.motion.steps = steps.length ? steps.map((s) => clampChainStep(s, n)) : [0];
    this.motion.transpose = fitTranspose(this.motion.transpose, this.motion.steps.length);
    this.motion.enabled = enabled;
    this.motionPos = 0;
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

  /** That lane's machine's bank count — the bound every chain index clamps to. */
  private laneBankCount(name: LaneName): number {
    return this.patterns.bankCount(name);
  }

  /**
   * Does any lane's chain name `bank` of machine `m`? The other half of
   * `PatternStore.canRemoveBank` (banks.md REQ-a-bank-is-removed-only-when-unused):
   * the store owns emptiness, the arrangement owns whether anything still points
   * at it. Only the lane that plays that machine can, so this is a single lane's
   * question despite the name.
   */
  chainReferences(m: LaneName, bank: number): boolean {
    return this[m].steps.includes(bank);
  }

  private recompute(): void {
    const seq = resolveLane(this.seq, this.seqPos, this.patterns.seqEditBank, this.laneBankCount('seq'));
    this.seqPlayBank = seq.playBank;
    this.seqResting = seq.resting;
    // A disabled lane is live editing, not an arrangement, and a rest bar plays
    // nothing — neither has a slot whose transpose could mean anything (REQ-a-seq-slot-carries-a-transpose).
    this.seqTranspose = this.seq.enabled && !seq.resting
      ? this.seq.transpose[this.seqPos % (this.seq.transpose.length || 1)] ?? 0
      : 0;
    const drum = resolveLane(this.drum, this.drumPos, this.patterns.drumEditBank, this.laneBankCount('drum'));
    this.drumPlayBank = drum.playBank;
    this.drumResting = drum.resting;
    const sampler = resolveLane(this.sampler, this.samplerPos, this.patterns.samplerEditBank,
      this.laneBankCount('sampler'));
    this.samplerPlayBank = sampler.playBank;
    this.samplerResting = sampler.resting;
    const motionEdit = this.patterns.motionEditBank;
    const motionN = this.laneBankCount('motion');
    const motion = resolveLane(this.motion, this.motionPos, motionEdit, motionN);
    this.motionPlayBank = motion.playBank;
    this.motionResting = motion.resting;
    // `resolveLane` mods, so keep the index non-negative. A disabled lane returns
    // the edit bank for all three, which is exactly what plays.
    const len = this.motion.steps.length || 1;
    const before = resolveLane(this.motion, this.motionPos + len - 1, motionEdit, motionN);
    this.motionPrevPlayBank = before.playBank;
    this.motionPrevResting = before.resting;
    const after = resolveLane(this.motion, this.motionPos + 1, motionEdit, motionN);
    this.motionNextPlayBank = after.playBank;
    this.motionNextResting = after.resting;
  }
}

/**
 * A transpose array resized to exactly `len` — padded with 0, truncated when the
 * chain shrinks (arrangement.md REQ-a-seq-slot-carries-a-transpose).
 *
 * The invariant this exists to hold: `transpose.length === steps.length`, always.
 * Two parallel arrays are only safe while nothing can desynchronize them, so
 * every write goes through here rather than trusting its caller — including the
 * ones that pass a chain built by the UI's `[...lane.steps, i]` splices.
 * Padding with **0** is what makes a newly added slot a no-op.
 */
function fitTranspose(src: readonly number[], len: number): number[] {
  const out = new Array<number>(len);
  for (let i = 0; i < len; i++) out[i] = clampTranspose(src[i] ?? 0);
  return out;
}

/** Chain position for a lane at absolute bar `bar` — the wrapped slot index,
 *  or 0 for a disabled/empty lane (which just tracks its edit bank). */
function laneSeek(lane: ChainLane, bar: number): number {
  return lane.enabled && lane.steps.length ? bar % lane.steps.length : 0;
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
  bankCount: number,
): { playBank: number; resting: boolean } {
  if (!lane.enabled || !lane.steps.length) return { playBank: editBank, resting: false };
  const step = lane.steps[pos % lane.steps.length] ?? 0;
  if (step === REST) return { playBank: 0, resting: true };
  return { playBank: clampChainStep(step, bankCount), resting: false };
}

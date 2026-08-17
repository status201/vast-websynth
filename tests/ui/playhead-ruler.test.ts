// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { buildPlayheadRuler, AT_CLASS, CUE_CLASS } from '../../src/ui/components/playhead-ruler';
import { VisibilityGate } from '../../src/ui/panels/step-panel-scaffold';
import { SEQ_LENGTH } from '../../src/state/patterns';
import { TestClock } from '../audio/transport/test-clock';
import styles from '../../src/ui/styles/playhead-ruler.module.css';
import type { StudioApi } from '../../src/ui/studio-api';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { barTicks } from '../../src/state/meter';

/**
 * The ruler reads the *clock* rather than a machine's `onStep` — that is the
 * whole point of it (transport-position.md REQ-9) — plus `seekTo`/`canSeek`, the
 * three low-frequency hooks that decide whether seeking is allowed, and (v2) the
 * arrangement + play-bank accessors behind the readout (REQ-15).
 */
function harness(over: { canSeek?: boolean; bars?: number; bank?: number } = {}) {
  const clock = new TestClock();
  // A real bus: the ruler reads the meter params off it to size its strip
  // (meter.md REQ-8/REQ-11), and the registered defaults are 4/4 — so every
  // pre-meter assertion in this file still describes a 16-tick bar.
  const bus = new ParamBus();
  registerDefaults(bus);
  const seekTo = vi.fn((step: number) => {
    if (over.canSeek === false) return false;
    clock.fireSeek(step);
    return true;
  });
  const state = { bars: over.bars ?? 0, bank: over.bank ?? 0 };
  const arrangementListeners = new Set<() => void>();
  const api = {
    clock,
    seekTo,
    canSeek: () => over.canSeek !== false,
    sync: { onStatus: () => () => {} },
    recorder: { onPhase: () => () => {} },
    bankRender: { onState: () => () => {} },
    get barTicks() {
      return barTicks(bus.get('transport.beats'), bus.get('transport.beatUnit'));
    },
    arrangement: {
      songBars: () => state.bars,
      onChange: (fn: () => void) => {
        arrangementListeners.add(fn);
        return () => { arrangementListeners.delete(fn); };
      },
    },
  } as unknown as StudioApi;
  const hooks = {
    getBank: () => state.bank,
    onBankChange: (fn: () => void) => {
      arrangementListeners.add(fn);
      return () => { arrangementListeners.delete(fn); };
    },
  };
  /** Mutate the arrangement-ish state and notify, as the real one does. */
  const set = (patch: Partial<typeof state>): void => {
    Object.assign(state, patch);
    for (const l of [...arrangementListeners]) l();
  };
  return { clock, bus, api, seekTo, hooks, set };
}

const ticks = (el: HTMLElement): HTMLButtonElement[] =>
  [...el.querySelectorAll('button')] as HTMLButtonElement[];

/** Index of the tick carrying the live-playhead class, or -1. */
const litIndex = (el: HTMLElement): number =>
  ticks(el).findIndex((t) => t.classList.contains(AT_CLASS));
/** Index of the tick carrying the cue class, or -1 (v2, REQ-14). */
const cueIndex = (el: HTMLElement): number =>
  ticks(el).findIndex((t) => t.classList.contains(CUE_CLASS));

const labelOf = (ruler: { barEl: HTMLElement }, lane = 'drum'): HTMLElement =>
  ruler.barEl.querySelector<HTMLElement>(`[data-testid="ruler-${lane}-bar"]`)!;
const navOf = (ruler: { barEl: HTMLElement }, dir: 'prev' | 'next', lane = 'drum'): HTMLButtonElement =>
  ruler.barEl.querySelector<HTMLButtonElement>(`[data-testid="ruler-${lane}-bar-${dir}"]`)!;

describe('PlayheadRuler', () => {
  it('renders one tick per 16th, each with a stable testid', () => {
    const { api, bus, hooks } = harness();
    const ruler = buildPlayheadRuler(api, bus, 'drum', undefined, hooks);
    expect(ticks(ruler.cellsEl)).toHaveLength(SEQ_LENGTH);
    expect(ruler.cellsEl.querySelector('[data-testid="ruler-drum-0"]')).toBeTruthy();
    expect(ruler.cellsEl.querySelector('[data-testid="ruler-drum-15"]')).toBeTruthy();
    expect(labelOf(ruler)).toBeTruthy();
  });

  it('carries no grid of its own, so the panel’s class controls alignment', () => {
    const { api, bus, hooks } = harness();
    const ruler = buildPlayheadRuler(api, bus, 'seq', undefined, hooks);
    // The panel adds `drum.cells` / `seq.stepRow` itself; if the component
    // shipped its own grid the two would fight and the ticks would drift.
    expect(ruler.cellsEl.className).toBe('');
  });

  it('follows the clock while playing', () => {
    const { clock, api, bus, hooks } = harness();
    const ruler = buildPlayheadRuler(api, bus, 'drum', undefined, hooks);
    clock.fireStart();
    clock.fireTick(0);          // step 0
    expect(litIndex(ruler.cellsEl)).toBe(0);
    clock.step = 6;
    clock.fireTick(0);
    expect(litIndex(ruler.cellsEl)).toBe(6);
  });

  // --- The two marks (v2, REQ-14) ---
  it('shows a cue and NO playhead while stopped', () => {
    const { clock, api, bus, hooks } = harness();
    const ruler = buildPlayheadRuler(api, bus, 'drum', undefined, hooks);
    // Never run: the cue is 0 and nothing is playing.
    expect(litIndex(ruler.cellsEl)).toBe(-1);
    expect(cueIndex(ruler.cellsEl)).toBe(0);

    clock.fireStart();
    clock.step = 9;
    clock.fireTick(0);
    clock.fireStop();           // halted at 10, but nothing was ever cued
    // The strip must not look like it is playing when it is not.
    expect(litIndex(ruler.cellsEl)).toBe(-1);
    expect(cueIndex(ruler.cellsEl)).toBe(0);

    clock.fireSeek(SEQ_LENGTH * 2 + 5);
    expect(cueIndex(ruler.cellsEl)).toBe(5);
    expect(litIndex(ruler.cellsEl)).toBe(-1);
  });

  it('keeps the cue visible while playing, so Stop → Play is predictable', () => {
    const { clock, api, bus, hooks } = harness();
    const ruler = buildPlayheadRuler(api, bus, 'drum', undefined, hooks);
    clock.fireSeek(4);          // cue at 4
    clock.fireStart(4);
    clock.step = 11;
    clock.fireTick(0);
    expect(litIndex(ruler.cellsEl)).toBe(11);
    expect(cueIndex(ruler.cellsEl)).toBe(4);
  });

  it('lets one tick carry both marks when playback starts on the cue (edge)', () => {
    const { clock, api, bus, hooks } = harness();
    const ruler = buildPlayheadRuler(api, bus, 'drum', undefined, hooks);
    clock.fireSeek(6);
    clock.fireStart(6);
    clock.fireTick(0);
    const tick = ticks(ruler.cellsEl)[6]!;
    expect(tick.classList.contains(AT_CLASS)).toBe(true);
    expect(tick.classList.contains(CUE_CLASS)).toBe(true);
  });

  it('seeks within the CURRENT bar when a tick is clicked', () => {
    const { clock, api, bus, seekTo, hooks } = harness();
    const ruler = buildPlayheadRuler(api, bus, 'drum', undefined, hooks);
    clock.fireSeek(SEQ_LENGTH * 3); // bar 4 (0-indexed 3)
    ticks(ruler.cellsEl)[7]!.click();
    expect(seekTo).toHaveBeenLastCalledWith(SEQ_LENGTH * 3 + 7);
  });

  // --- Mode-aware readout (v2, REQ-15) ---
  it('names the bank while no chain is enabled, with no stepper', () => {
    const { api, bus, hooks, set } = harness({ bars: 0, bank: 1 });
    const ruler = buildPlayheadRuler(api, bus, 'drum', undefined, hooks);
    // A bar number here would be fiction: the song is one bank looping.
    expect(labelOf(ruler).textContent).toBe('Bank B');
    expect(navOf(ruler, 'prev').hidden).toBe(true);
    expect(navOf(ruler, 'next').hidden).toBe(true);

    // Follows a bank click with the transport STOPPED — the case that rules out
    // `Arrangement.<lane>PlayBank`, which is only recomputed on tick/seek/chain.
    set({ bank: 2 });
    expect(labelOf(ruler).textContent).toBe('Bank C');
  });

  it('wraps the bar at song length once a chain exists, and shows the stepper', () => {
    const { clock, api, bus, hooks, set } = harness({ bars: 4 });
    const ruler = buildPlayheadRuler(api, bus, 'drum', undefined, hooks);
    expect(labelOf(ruler).textContent).toBe('Bar 1/4');
    expect(navOf(ruler, 'next').hidden).toBe(false);

    // Absolute bar 6 is the arrangement's bar 3 — the one the Song scrubber
    // lights. v1 printed "Bar 6" here and disagreed with it.
    clock.fireSeek(SEQ_LENGTH * 6);
    expect(labelOf(ruler).textContent).toBe('Bar 3/4');

    set({ bars: 0 });
    expect(labelOf(ruler).textContent).toBe('Bank A');
    expect(navOf(ruler, 'next').hidden).toBe(true);
  });

  // --- Bar stepper (v2, REQ-16) ---
  it('steps a bar while preserving the 16th', () => {
    const { clock, api, bus, seekTo, hooks } = harness({ bars: 4 });
    const ruler = buildPlayheadRuler(api, bus, 'drum', undefined, hooks);
    clock.fireSeek(SEQ_LENGTH * 1 + 5); // bar 2, step 5
    navOf(ruler, 'next').click();
    // Shift+Arrow would zero the column here; this must not.
    expect(seekTo).toHaveBeenLastCalledWith(SEQ_LENGTH * 2 + 5);
    navOf(ruler, 'prev').click();
    expect(seekTo).toHaveBeenLastCalledWith(SEQ_LENGTH * 1 + 5);
  });

  it('clamps the stepper to the song, never below bar 1 or past the last bar', () => {
    const { clock, api, bus, seekTo, hooks } = harness({ bars: 4 });
    const ruler = buildPlayheadRuler(api, bus, 'drum', undefined, hooks);
    clock.fireSeek(3); // bar 1, step 3
    navOf(ruler, 'prev').click();
    expect(seekTo).toHaveBeenLastCalledWith(3); // clamped at bar 0, step kept

    clock.fireSeek(SEQ_LENGTH * 3 + 3); // the last bar of a 4-bar song
    navOf(ruler, 'next').click();
    expect(seekTo).toHaveBeenLastCalledWith(SEQ_LENGTH * 3 + 3);
  });

  it('shows the position even while the transport has never run', () => {
    const { api, bus, hooks } = harness();
    const ruler = buildPlayheadRuler(api, bus, 'sampler', undefined, hooks);
    // The grid highlight is blank here (no machine emits onStep while stopped);
    // the ruler is the surface that answers "where are we?".
    expect(cueIndex(ruler.cellsEl)).toBe(0);
    expect(labelOf(ruler, 'sampler').textContent).toBe('Bank A');
  });

  // --- Refusal honesty (v2, REQ-17) ---
  it('marks itself inert when seeking is refused, and stops promising a move', () => {
    const { api, bus, hooks } = harness({ canSeek: false, bars: 4 });
    const ruler = buildPlayheadRuler(api, bus, 'drum', undefined, hooks);
    expect(ruler.cellsEl.classList.contains(styles.off!)).toBe(true);
    expect(ruler.barEl.classList.contains(styles.off!)).toBe(true);
    const first = ticks(ruler.cellsEl)[0]!;
    expect(first.getAttribute('aria-disabled')).toBe('true');
    expect(first.title).not.toMatch(/Move the playhead to beat/);
    expect(navOf(ruler, 'next').getAttribute('aria-disabled')).toBe('true');
  });

  it('names the beat in a tick’s title, matching the numerals it prints', () => {
    const { api, bus, hooks } = harness();
    const ruler = buildPlayheadRuler(api, bus, 'drum', undefined, hooks);
    // The strip labels beats 1-4, so the tooltip must not talk in steps 1-16.
    expect(ticks(ruler.cellsEl)[0]!.title).toContain('beat 1');
    expect(ticks(ruler.cellsEl)[4]!.title).toContain('beat 2');
    expect(ticks(ruler.cellsEl)[15]!.title).toContain('beat 4');
  });

  // transport-position.md REQ-10 — same contract as the grid playhead.
  it('does no work while hidden, and re-syncs to the live step on reveal', () => {
    const { clock, api, bus, hooks } = harness();
    const gate = new VisibilityGate();
    const ruler = buildPlayheadRuler(api, bus, 'drum', gate, hooks);
    clock.fireStart();
    clock.fireTick(0);
    expect(litIndex(ruler.cellsEl)).toBe(0);

    gate.set(false);
    clock.step = 11;
    clock.fireTick(0);
    clock.fireTick(0);
    expect(litIndex(ruler.cellsEl)).toBe(0); // untouched while off screen

    gate.set(true);
    // The step playing NOW — read live from the clock — not the one it was
    // left on, and not a replay of the ticks it slept through.
    expect(litIndex(ruler.cellsEl)).toBe(clock.step % SEQ_LENGTH);
    expect(litIndex(ruler.cellsEl)).toBe(13);
  });

  it('unsubscribes on destroy', () => {
    const { clock, api, bus, hooks } = harness();
    const ruler = buildPlayheadRuler(api, bus, 'drum', undefined, hooks);
    ruler.destroy();
    clock.fireSeek(SEQ_LENGTH + 4);
    expect(cueIndex(ruler.cellsEl)).toBe(0); // no repaint after teardown
  });
});

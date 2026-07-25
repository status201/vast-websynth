// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { buildPlayheadRuler, AT_CLASS } from '../../src/ui/components/playhead-ruler';
import { VisibilityGate } from '../../src/ui/panels/step-panel-scaffold';
import { SEQ_LENGTH } from '../../src/state/patterns';
import { TestClock } from '../audio/transport/test-clock';
import styles from '../../src/ui/styles/playhead-ruler.module.css';
import type { StudioApi } from '../../src/ui/studio-api';

/**
 * The ruler reads the *clock* rather than a machine's `onStep` — that is the
 * whole point of it (transport-position.md REQ-9) — plus `seekTo`/`canSeek` and
 * the three low-frequency hooks that decide whether seeking is allowed.
 */
function harness(over: { canSeek?: boolean } = {}) {
  const clock = new TestClock();
  const seekTo = vi.fn((step: number) => {
    if (over.canSeek === false) return false;
    clock.fireSeek(step);
    return true;
  });
  const api = {
    clock,
    seekTo,
    canSeek: () => over.canSeek !== false,
    sync: { onStatus: () => () => {} },
    recorder: { onState: () => () => {} },
    bankRender: { onState: () => () => {} },
  } as unknown as StudioApi;
  return { clock, api, seekTo };
}

const ticks = (el: HTMLElement): HTMLButtonElement[] =>
  [...el.querySelectorAll('button')] as HTMLButtonElement[];

/** Index of the tick carrying the "you are here" class, or -1. */
const litIndex = (el: HTMLElement): number =>
  ticks(el).findIndex((t) => t.classList.contains(AT_CLASS));

describe('PlayheadRuler', () => {
  it('renders one tick per 16th, each with a stable testid', () => {
    const { api } = harness();
    const ruler = buildPlayheadRuler(api, 'drum');
    expect(ticks(ruler.cellsEl)).toHaveLength(SEQ_LENGTH);
    expect(ruler.cellsEl.querySelector('[data-testid="ruler-drum-0"]')).toBeTruthy();
    expect(ruler.cellsEl.querySelector('[data-testid="ruler-drum-15"]')).toBeTruthy();
    expect(ruler.barEl.dataset.testid).toBe('ruler-drum-bar');
  });

  it('carries no grid of its own, so the panel’s class controls alignment', () => {
    const { api } = harness();
    const ruler = buildPlayheadRuler(api, 'seq');
    // The panel adds `drum.cells` / `seq.stepRow` itself; if the component
    // shipped its own grid the two would fight and the ticks would drift.
    expect(ruler.cellsEl.className).toBe('');
  });

  it('follows the clock while playing', () => {
    const { clock, api } = harness();
    const ruler = buildPlayheadRuler(api, 'drum');
    clock.fireStart();
    clock.fireTick(0);          // step 0
    expect(litIndex(ruler.cellsEl)).toBe(0);
    clock.step = 6;
    clock.fireTick(0);
    expect(litIndex(ruler.cellsEl)).toBe(6);
  });

  it('shows the cue while stopped — where Play will begin, not where it halted', () => {
    const { clock, api } = harness();
    const ruler = buildPlayheadRuler(api, 'drum');
    clock.fireStart();
    clock.step = 9;
    clock.fireTick(0);
    clock.fireStop();           // stopped at step 10, but nothing was cued
    expect(litIndex(ruler.cellsEl)).toBe(0);

    clock.fireSeek(SEQ_LENGTH * 2 + 5);
    expect(litIndex(ruler.cellsEl)).toBe(5);
  });

  it('shows the position even while the transport has never run', () => {
    const { api } = harness();
    const ruler = buildPlayheadRuler(api, 'sampler');
    // The grid highlight is blank here (no machine emits onStep while stopped);
    // the ruler is the surface that answers "where are we?".
    expect(litIndex(ruler.cellsEl)).toBe(0);
    expect(ruler.barEl.textContent).toContain('1');
  });

  it('seeks within the CURRENT bar when a tick is clicked', () => {
    const { clock, api, seekTo } = harness();
    const ruler = buildPlayheadRuler(api, 'drum');
    clock.fireSeek(SEQ_LENGTH * 3); // bar 4 (0-indexed 3)
    ticks(ruler.cellsEl)[7]!.click();
    expect(seekTo).toHaveBeenLastCalledWith(SEQ_LENGTH * 3 + 7);
  });

  it('tracks the bar number', () => {
    const { clock, api } = harness();
    const ruler = buildPlayheadRuler(api, 'drum');
    expect(ruler.barEl.textContent).toBe('Bar 1');
    clock.fireSeek(SEQ_LENGTH * 5);
    expect(ruler.barEl.textContent).toBe('Bar 6');
  });

  it('marks itself inert when seeking is refused', () => {
    const { api } = harness({ canSeek: false });
    const ruler = buildPlayheadRuler(api, 'drum');
    expect(ruler.cellsEl.classList.contains(styles.off!)).toBe(true);
  });

  // transport-position.md REQ-10 — same contract as the grid playhead.
  it('does no work while hidden, and re-syncs to the live step on reveal', () => {
    const { clock, api } = harness();
    const gate = new VisibilityGate();
    const ruler = buildPlayheadRuler(api, 'drum', gate);
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
    const { clock, api } = harness();
    const ruler = buildPlayheadRuler(api, 'drum');
    ruler.destroy();
    clock.fireSeek(SEQ_LENGTH + 4);
    expect(litIndex(ruler.cellsEl)).toBe(0); // no repaint after teardown
  });
});

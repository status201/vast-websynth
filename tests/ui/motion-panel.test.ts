// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { buildMotionPanel } from '../../src/ui/panels/motion-panel';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { PatternStore, MOTION_TRACK_COUNT } from '../../src/state/patterns';
import type { StudioApi } from '../../src/ui/studio-api';
import type { XyPadStore } from '../../src/state/xy-pad';
import type { XyPadWindowController } from '../../src/ui/components/xy-pad-window';
import type { PatternUndo } from '../../src/state/pattern-undo';
import type { UiBridge } from '../../src/ui/ui-bridge';
import { installLocalStorageMock } from '../storage-mock';

/**
 * The Motion panel's cost gate — motion-sequencer.md REQ-the-ab-lane-repaint-is-gated-on-visibility,
 * runtime-performance.md REQ-no-work-for-offscreen-dom.
 *
 * A lane repaint clears and rebuilds an SVG polyline plus up to 16 circles and
 * re-levels 16 pads, *per lane*. `arrangement.onChange` fires every bar while
 * playing, so an un-gated repaint burns that on a panel nobody is looking at —
 * which is what the A/B lanes did until v14, while the XY graph beside them was
 * already gated.
 *
 * The panel only reaches for `engine.arrangement`, `engine.patterns`, `xy.get`
 * and `xy.onChange`; the other three collaborators are forwarded to
 * sub-components, never dereferenced here.
 */

/** Fire `arrangement.onChange` by hand — the per-bar signal, without a clock. */
function harness() {
  const bus = new ParamBus();
  registerDefaults(bus);
  const patterns = new PatternStore();

  const barListeners: Array<() => void> = [];
  const lane = () => ({ enabled: false, steps: [0], transpose: [0] });
  const arrangement = {
    seqPlayBank: 0, drumPlayBank: 0, samplerPlayBank: 0, motionPlayBank: 0,
    seqResting: false, drumResting: false, samplerResting: false, motionResting: false,
    // The four `ChainLane`s the lane controls read (`arrangement[lane].enabled`).
    seq: lane(), drum: lane(), sampler: lane(), motion: lane(),
    songBars: () => 0,
    onChange: (fn: () => void) => { barListeners.push(fn); return () => {}; },
  };
  // The playhead ruler and highlighter read the clock and the motion machine's
  // step signal; neither drives anything this spec asserts on.
  const off = () => () => {};
  const clock = {
    playing: false, step: 0, cue: 0,
    onTick: off, onSeek: off, onStart: off, onStop: off,
  };
  const motion = { onStep: off };
  // The ruler's seek buttons re-check their enablement on these three signals.
  const engine = {
    patterns, arrangement, clock, motion,
    canSeek: () => false,
    sync: { onStatus: off },
    recorder: { onPhase: off },
    bankRender: { onState: off },
  } as unknown as StudioApi;
  const xy = {
    get: () => ({ x: null, y: null }),
    onChange: () => () => {},
  } as unknown as XyPadStore;

  // The XY Pad launcher in the lane controls wires itself to the window's
  // open/close signal; nothing else here touches the controller.
  const xyWin = {
    toggle: () => {},
    onChange: () => () => {},
  } as unknown as XyPadWindowController;

  // The lane's Undo button reads its enablement and follows its change signal.
  const undo = {
    undo: () => {},
    canUndo: () => false,
    onChange: () => () => {},
  } as unknown as PatternUndo;

  const panel = buildMotionPanel(
    bus, engine, xy, xyWin, undo,
    {} as unknown as UiBridge,
  );
  /** One bar advances — every registered arrangement listener runs. */
  const advanceBar = (): void => { for (const fn of barListeners) fn(); };
  return { bus, patterns, panel, advanceBar };
}

/** Every lane's fold is read from storage at construction, so the file needs a
 *  clean one per test or one suite's clicks would set the next suite's folds. */
beforeEach(() => installLocalStorageMock());

/** The A lane's graph — rebuilt wholesale by that lane's repaint. */
const laneGraph = (el: HTMLElement): SVGElement =>
  el.querySelector<SVGElement>('[data-testid="motion-trk-0-graph"]')!;

describe('Motion panel lane repaint (REQ-the-ab-lane-repaint-is-gated-on-visibility)', () => {
  it('repaints no lane per bar while the tab is hidden', () => {
    const { patterns, panel, advanceBar } = harness();
    patterns.setMotionTrackParam(0, 'filter.cutoff');
    patterns.setMotionTrackStep(0, 0, { on: true, v: 0.2 });
    advanceBar();
    const drawn = laneGraph(panel.el).innerHTML;

    panel.gate.set(false);
    // Steps change under a hidden panel, and the bar keeps advancing.
    patterns.setMotionTrackStep(0, 4, { on: true, v: 0.9 });
    patterns.setMotionTrackStep(0, 8, { on: true, v: 0.4 });
    advanceBar();
    advanceBar();

    expect(laneGraph(panel.el).innerHTML).toBe(drawn); // nothing rebuilt
  });

  it('repaints once on reveal, showing the current steps', () => {
    const { patterns, panel, advanceBar } = harness();
    patterns.setMotionTrackParam(0, 'filter.cutoff');
    patterns.setMotionTrackStep(0, 0, { on: true, v: 0.2 });
    advanceBar();
    const stale = laneGraph(panel.el).innerHTML;

    panel.gate.set(false);
    patterns.setMotionTrackStep(0, 4, { on: true, v: 0.9 });
    advanceBar();
    expect(laneGraph(panel.el).innerHTML).toBe(stale);

    panel.gate.set(true);
    // The coalesced repaint lands on reveal, so the lane is never left stale.
    expect(laneGraph(panel.el).innerHTML).not.toBe(stale);
  });

  it('repaints nothing on reveal when nothing asked for one', async () => {
    const { patterns, panel, advanceBar } = harness();
    patterns.setMotionTrackParam(0, 'filter.cutoff');
    patterns.setMotionTrackStep(0, 0, { on: true, v: 0.2 });
    advanceBar();

    // A repaint rebuilds the graph's children, so counting childList mutations
    // counts repaints — the DOM after an unnecessary repaint is identical, so
    // comparing markup cannot tell one from none.
    let repaints = 0;
    const obs = new MutationObserver((records) => { repaints += records.length; });
    obs.observe(laneGraph(panel.el), { childList: true });
    const flush = () => new Promise((r) => setTimeout(r, 0));

    panel.gate.set(false);
    panel.gate.set(true);   // nothing changed while hidden
    await flush();
    expect(repaints).toBe(0);

    // …and the same reveal does repaint once something has asked for it.
    panel.gate.set(false);
    patterns.setMotionTrackStep(0, 12, { on: true, v: 0.7 });
    advanceBar();
    await flush();
    expect(repaints).toBe(0);   // still hidden

    panel.gate.set(true);
    await flush();
    expect(repaints).toBeGreaterThan(0);
    obs.disconnect();
  });

  it('still repaints per bar while the tab is shown', () => {
    const { patterns, panel, advanceBar } = harness();
    patterns.setMotionTrackParam(0, 'filter.cutoff');
    patterns.setMotionTrackStep(0, 0, { on: true, v: 0.2 });
    advanceBar();
    const before = laneGraph(panel.el).innerHTML;

    patterns.setMotionTrackStep(0, 6, { on: true, v: 0.95 });
    advanceBar();
    expect(laneGraph(panel.el).innerHTML).not.toBe(before);
  });
});

/** The XY lane's graph — the overlay `redrawGraph` rebuilds. */
const xyGraph = (el: HTMLElement): SVGElement =>
  el.querySelector<SVGElement>('[data-testid="motion-graph"]')!;
/** Where the first anchor's dot lands, as a fraction of a lane of `cells`. */
const dotCx = (el: SVGElement): string | null =>
  el.querySelector('circle')!.getAttribute('cx');
const centre = (step: number, cells: number): string => String(((step + 0.5) / cells) * 100);

describe('Motion panel draws on the lane, not the bank (REQ-the-motion-graph-follows-the-lane)', () => {
  it('re-projects the XY graph when the lane length changes', () => {
    const { bus, patterns, panel } = harness();
    patterns.setMotionStep(4, { on: true, x: 0.5, y: 0.75 });
    expect(dotCx(xyGraph(panel.el))).toBe(centre(4, 16));
    // Nine cells: the same anchor is now the lane's midpoint, over its own pad —
    // at sixteen it drew at 28.125%, inside cell 3 of the nine the grid shows.
    bus.set('motion.len', 9);
    expect(dotCx(xyGraph(panel.el))).toBe(centre(4, 9));
  });

  it('re-projects the A/B lanes on the same signal', () => {
    const { bus, patterns, panel } = harness();
    patterns.setMotionTrackParam(0, 'filter.cutoff');
    patterns.setMotionTrackStep(0, 4, { on: true, v: 0.75 });
    expect(dotCx(laneGraph(panel.el))).toBe(centre(4, 16));
    bus.set('motion.len', 9);
    expect(dotCx(laneGraph(panel.el))).toBe(centre(4, 9));
  });

  it('coalesces a meter change into the reveal repaint like every other redraw', () => {
    const { bus, patterns, panel } = harness();
    patterns.setMotionStep(4, { on: true, x: 0.5, y: 0.75 });
    const stale = xyGraph(panel.el).innerHTML;
    panel.gate.set(false);
    bus.set('motion.len', 9);
    expect(xyGraph(panel.el).innerHTML).toBe(stale);   // nothing rebuilt off-screen
    panel.gate.set(true);
    expect(dotCx(xyGraph(panel.el))).toBe(centre(4, 9));
  });
});


/**
 * The fold — motion-sequencer.md REQ-an-empty-motion-lane-starts-folded and
 * REQ-a-folded-motion-lane-does-no-repaint, over lane-fold.md's component.
 *
 * Read the fold off the button's `title` rather than off a CSS-Module class:
 * the title is what the user actually gets, and it does not depend on how the
 * bundler happens to hash `.folded`.
 */
const foldBtn = (el: HTMLElement, t: number): HTMLButtonElement =>
  el.querySelector<HTMLButtonElement>(`[data-testid="motion-trk-${t}-fold"]`)!;
const isFolded = (el: HTMLElement, t: number): boolean =>
  foldBtn(el, t).title === 'Show this lane';
const picker = (el: HTMLElement, t: number): HTMLElement =>
  el.querySelector<HTMLElement>(`[data-testid="motion-trk-${t}-param"]`)!;

describe('Motion panel lane fold (REQ-an-empty-motion-lane-starts-folded)', () => {
  it('folds every empty lane and leaves its header usable', () => {
    const { panel } = harness();
    for (let t = 0; t < MOTION_TRACK_COUNT; t++) {
      expect(isFolded(panel.el, t)).toBe(true);
      // The one thing a folded lane must keep: the control that assigns it.
      // Folding that away would make an empty lane impossible to fill
      // (ADR-014 law 2).
      const row = foldBtn(panel.el, t).closest('div');
      expect(row).not.toBeNull();
      expect(row!.contains(picker(panel.el, t))).toBe(true);
      expect(foldBtn(panel.el, t).disabled).toBe(false);
    }
  });

  it('opens a lane when a parameter is picked, and leaves it open when cleared', () => {
    const { patterns, panel } = harness();
    expect(isFolded(panel.el, 2)).toBe(true);

    patterns.setMotionTrackParam(2, 'filter.cutoff');
    expect(isFolded(panel.el, 2)).toBe(false);

    // Clearing is NOT a re-fold: the row would otherwise collapse under the
    // pointer just as the next parameter is about to be chosen.
    patterns.setMotionTrackParam(2, null);
    expect(isFolded(panel.el, 2)).toBe(false);
  });

  it('the caret toggles the lane and remembers the answer', () => {
    const { panel } = harness();
    foldBtn(panel.el, 1).click();
    expect(isFolded(panel.el, 1)).toBe(false);
    expect(localStorage.getItem('websynth.ui.collapsed.motiontrack.1')).toBe('0');

    foldBtn(panel.el, 1).click();
    expect(isFolded(panel.el, 1)).toBe(true);
    expect(localStorage.getItem('websynth.ui.collapsed.motiontrack.1')).toBe('1');
  });

  it('a song that fills lanes C and D does not arrive with them hidden', () => {
    const { patterns, panel } = harness();
    // A lane the user folded ON PURPOSE stays folded, whatever arrives in it.
    foldBtn(panel.el, 3).click();   // open
    foldBtn(panel.el, 3).click();   // and shut again — now stored as '1'

    patterns.restore({
      motionTracks: [[
        null,
        null,
        { param: 'fx.delay.mix', steps: patterns.motionTrack(2)!.steps.map((s, i) => ({ ...s, on: i === 0 })) },
        { param: 'fx.reverb.mix', steps: patterns.motionTrack(3)!.steps.map((s, i) => ({ ...s, on: i === 0 })) },
      ]],
    });

    expect(isFolded(panel.el, 2)).toBe(false);  // untouched, and now used
    expect(isFolded(panel.el, 3)).toBe(true);   // the user's own answer wins
  });
});

describe('Motion panel folded-lane cost (REQ-a-folded-motion-lane-does-no-repaint)', () => {
  it('repaints nothing while folded, then once on unfold', () => {
    // Fold lane B deliberately, so filling it cannot auto-reveal it.
    localStorage.setItem('websynth.ui.collapsed.motiontrack.1', '1');
    const { patterns, panel, advanceBar } = harness();
    expect(isFolded(panel.el, 1)).toBe(true);

    const graph = (): string =>
      panel.el.querySelector<SVGElement>('[data-testid="motion-trk-1-graph"]')!.innerHTML;
    const blank = graph();

    patterns.setMotionTrackParam(1, 'filter.cutoff');
    patterns.setMotionTrackStep(1, 0, { on: true, v: 0.2 });
    patterns.setMotionTrackStep(1, 8, { on: true, v: 0.9 });
    advanceBar();
    advanceBar();
    // The panel is SHOWN — this is the per-lane half of the gate, not the
    // per-panel one the suite above pins.
    expect(graph()).toBe(blank);

    foldBtn(panel.el, 1).click();
    expect(isFolded(panel.el, 1)).toBe(false);
    // The coalesced repaint lands on the unfold, so the lane is never stale.
    expect(graph()).not.toBe(blank);
  });

  it('an open lane still repaints per bar', () => {
    const { patterns, panel, advanceBar } = harness();
    patterns.setMotionTrackParam(0, 'filter.cutoff');   // auto-reveals lane A
    expect(isFolded(panel.el, 0)).toBe(false);
    patterns.setMotionTrackStep(0, 0, { on: true, v: 0.2 });
    advanceBar();
    const drawn = laneGraph(panel.el).innerHTML;

    patterns.setMotionTrackStep(0, 4, { on: true, v: 0.9 });
    advanceBar();
    expect(laneGraph(panel.el).innerHTML).not.toBe(drawn);
  });

  it('paints the header of a folded lane, so it cannot advertise stale state', () => {
    // The user folded lane C deliberately, so the song load below must leave it
    // folded — which is exactly the case where a gated header would start lying.
    localStorage.setItem('websynth.ui.collapsed.motiontrack.2', '1');
    const { patterns, panel } = harness();
    const row = (): HTMLElement => foldBtn(panel.el, 2).closest('div')!.parentElement!;
    const dimmed = (): boolean => /trackDim/.test(row().className);
    // A Dropdown shows its current value on its toggle button; the options live
    // in the menu beside it (dropdown.md).
    const shows = (): string => picker(panel.el, 2).querySelector('button')!.textContent!;

    expect(isFolded(panel.el, 2)).toBe(true);
    expect(shows()).toBe('— none —');
    expect(dimmed()).toBe(true);

    // A song arrives and assigns the lane, store-side — not through the picker,
    // which would `expand()` the lane and hide the bug.
    patterns.setMotionTrackParam(2, 'fx.delay.mix');

    expect(isFolded(panel.el, 2)).toBe(true);        // the user's answer still wins
    expect(shows()).toBe('fx.delay.mix');            // ...but the header tells the truth
    expect(dimmed()).toBe(false);
  });

  it('routes a per-lane signal to that lane alone', () => {
    // `emitAllMotionTracks` fires once PER LANE, so a handler that answered each
    // emission by repainting every lane would make a bank switch
    // MOTION_TRACK_COUNT² lane repaints — and with Follow on that is every bar.
    //
    // Compared by DOM MUTATION, not by markup: a wasted repaint of unchanged
    // data rebuilds the same nodes and would compare equal, which is precisely
    // the cost this pins. `takeRecords` reads the queue synchronously.
    const { patterns, panel } = harness();
    for (let t = 0; t < MOTION_TRACK_COUNT; t++) {
      patterns.setMotionTrackParam(t, 'filter.cutoff');
      patterns.setMotionTrackStep(t, 0, { on: true, v: 0.3 });
    }

    const observers = Array.from({ length: MOTION_TRACK_COUNT }, (_, t) => {
      const o = new MutationObserver(() => {});
      o.observe(
        panel.el.querySelector(`[data-testid="motion-trk-${t}-graph"]`)!,
        { childList: true, subtree: true },
      );
      return o;
    });

    patterns.setMotionTrackStep(1, 8, { on: true, v: 0.95 });

    const touched = observers.map((o) => o.takeRecords().length > 0);
    for (const o of observers) o.disconnect();
    expect(touched).toEqual([false, true, false, false]);
  });
});

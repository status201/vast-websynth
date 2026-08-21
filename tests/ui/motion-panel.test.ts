// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { buildMotionPanel } from '../../src/ui/panels/motion-panel';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { PatternStore } from '../../src/state/patterns';
import type { StudioApi } from '../../src/ui/studio-api';
import type { XyPadStore } from '../../src/state/xy-pad';
import type { XyPadWindowController } from '../../src/ui/components/xy-pad-window';
import type { PatternUndo } from '../../src/state/pattern-undo';
import type { UiBridge } from '../../src/ui/ui-bridge';

/**
 * The Motion panel's cost gate — motion-sequencer.md REQ-16b,
 * runtime-performance.md REQ-4.
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

/** The A lane's graph — rebuilt wholesale by that lane's repaint. */
const laneGraph = (el: HTMLElement): SVGElement =>
  el.querySelector<SVGElement>('[data-testid="motion-trk-0-graph"]')!;

describe('Motion panel lane repaint (REQ-16b)', () => {
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

describe('Motion panel draws on the lane, not the bank (REQ-24b)', () => {
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

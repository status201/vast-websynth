import { describe, it, expect, afterEach, vi } from 'vitest';
import { Knob } from '../../src/ui/components/knob';
import { ParamBus, registerDefaults } from '../../src/state/params';
import styles from '../../src/ui/styles/knob.module.css';

function bus() {
  const b = new ParamBus();
  registerDefaults(b);
  return b;
}

// The double-tap detector lives on the dial's pointerdown (two within 300 ms).
// A plain Event carries no clientY/pointerId, but the reset branch returns
// before the drag path reads them, and setPointerCapture is optional-chained.
function doubleTap(knob: Knob): void {
  const dial = knob.el.querySelector('.' + styles.dial!) as HTMLElement;
  dial.dispatchEvent(new Event('pointerdown'));
  dial.dispatchEvent(new Event('pointerdown'));
}

describe('Knob double-tap reset', () => {
  it('resets to the registered default when no preset/song is loaded', () => {
    const b = bus();
    const def = b.def('filter.cutoff')!.default; // 90
    const knob = new Knob({ bus: b, paramId: 'filter.cutoff' });
    b.set('filter.cutoff', 110);
    doubleTap(knob);
    expect(b.get('filter.cutoff')).toBe(def);
  });

  it('resets to the loaded preset value after a restore, not the global default', () => {
    const b = bus();
    const knob = new Knob({ bus: b, paramId: 'filter.cutoff' });
    b.restore({ 'filter.cutoff': 60 }); // preset load records the baseline
    b.set('filter.cutoff', 110);        // user drags the knob away
    doubleTap(knob);
    expect(b.get('filter.cutoff')).toBe(60);
    expect(b.get('filter.cutoff')).not.toBe(b.def('filter.cutoff')!.default);
  });
});

// The BPM knob dims + refuses input while slaved (midi-clock-sync REQ-14):
// setDisabled(true) blocks both a drag and the double-tap reset, and marks the
// control (opacity + aria-disabled); the bus value still repaints the dial.
describe('Knob setDisabled (slaved BPM knob)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('blocks drag and double-tap while disabled, then restores when re-enabled', () => {
    vi.spyOn(performance, 'now').mockReturnValue(10_000); // > 300 ms since lastTap=0 → drag branch
    const b = bus();
    const knob = new Knob({ bus: b, paramId: 'transport.bpm' });
    const start = b.get('transport.bpm');

    knob.setDisabled(true);
    expect(knob.el.classList.contains(styles.disabled!)).toBe(true);
    expect(knob.el.getAttribute('aria-disabled')).toBe('true');

    // A drag does nothing.
    const dial = knob.el.querySelector('.' + styles.dial!) as HTMLElement;
    dial.dispatchEvent(new MouseEvent('pointerdown', { clientY: 100 }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientY: 40 }));
    expect(b.get('transport.bpm')).toBe(start);

    // A double-tap reset is blocked too.
    b.set('transport.bpm', start + 10);
    doubleTap(knob);
    expect(b.get('transport.bpm')).toBe(start + 10);

    // Re-enabling restores input (double-tap now resets to the default).
    knob.setDisabled(false);
    expect(knob.el.classList.contains(styles.disabled!)).toBe(false);
    expect(knob.el.getAttribute('aria-disabled')).toBe('false');
    doubleTap(knob);
    expect(b.get('transport.bpm')).toBe(b.def('transport.bpm')!.default);
  });
});

// The drum tuning strip destroys + recreates Knobs on track change, so a Knob
// that leaks window listeners accumulates dead handlers over a session — the
// degrade-over-time crackle (drum-machine.md REQ-10). Drag listeners must be
// attached on pointerdown and removed on pointerup / destroy().
describe('Knob drag-listener lifecycle', () => {
  afterEach(() => vi.restoreAllMocks());

  const isPointer = (t: unknown): boolean =>
    t === 'pointermove' || t === 'pointerup' || t === 'pointercancel';
  const dialOf = (knob: Knob): HTMLElement =>
    knob.el.querySelector('.' + styles.dial!) as HTMLElement;
  const down = (dial: HTMLElement, clientY: number): void =>
    void dial.dispatchEvent(new MouseEvent('pointerdown', { clientY }));
  const winMove = (clientY: number): void =>
    void window.dispatchEvent(new MouseEvent('pointermove', { clientY }));
  const winUp = (): void => void window.dispatchEvent(new MouseEvent('pointerup'));

  it('adds no window pointer listeners on construction', () => {
    const add = vi.spyOn(window, 'addEventListener');
    new Knob({ bus: bus(), paramId: 'filter.cutoff' });
    expect(add.mock.calls.filter(([t]) => isPointer(t)).length).toBe(0);
  });

  it('window pointermove drives the bus only during an active drag', () => {
    vi.spyOn(performance, 'now').mockReturnValue(10_000); // > 300 ms since lastTap=0 → drag branch
    const b = bus();
    const knob = new Knob({ bus: b, paramId: 'filter.cutoff' });

    down(dialOf(knob), 100);
    winMove(50); // dragging up: value moves
    const dragged = b.get('filter.cutoff');
    expect(dragged).not.toBe(90);

    winUp();
    winMove(10); // released + detached: no further effect
    expect(b.get('filter.cutoff')).toBe(dragged);
  });

  it('destroy() removes the drag listeners it attached (balanced, no post-destroy writes)', () => {
    vi.spyOn(performance, 'now').mockReturnValue(10_000);
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const b = bus();
    const knob = new Knob({ bus: b, paramId: 'filter.cutoff' });

    down(dialOf(knob), 100); // attaches the 3 drag listeners
    knob.destroy();          // must remove them (even mid-drag)

    const added = add.mock.calls.filter(([t]) => isPointer(t)).length;
    const removed = remove.mock.calls.filter(([t]) => isPointer(t)).length;
    expect(added).toBeGreaterThan(0);
    expect(removed).toBe(added);

    const at = b.get('filter.cutoff');
    winMove(10); // detached handler must not write
    expect(b.get('filter.cutoff')).toBe(at);
  });
});

/**
 * Repaint guards (runtime-performance.md REQ-7). A knob is not only dragged: the
 * motion sequencer automates up to four params at frame rate, so `render` runs
 * ~60x/s per driven knob and most of those frames paint the same pixels.
 */
describe('Knob repaint guards', () => {
  function build() {
    const b = bus();
    const knob = new Knob({ bus: b, paramId: 'filter.cutoff', label: 'CUT' });
    const indicator = knob.el.querySelector<HTMLElement>('div > div')!;
    const arc = knob.el.querySelector('circle:nth-of-type(2)')!;
    return { b, knob, indicator, arc };
  }

  it('writes nothing when a repaint would produce identical output', () => {
    const { b, knob, indicator, arc } = build();
    b.set('filter.cutoff', 90);

    const setAttr = vi.spyOn(arc, 'setAttribute');
    const transforms: string[] = [];
    const styleSpy = vi.spyOn(indicator.style, 'setProperty');
    void styleSpy; // style.transform is a plain assignment; observe it below

    const beforeTransform = indicator.style.transform;
    const beforeLabel = knob.el.textContent;

    // A value the taper maps to the same rounded angle and the same label.
    b.set('filter.cutoff', 90 + 1e-9);
    expect(setAttr).not.toHaveBeenCalled();
    expect(indicator.style.transform).toBe(beforeTransform);
    expect(knob.el.textContent).toBe(beforeLabel);
    expect(transforms).toEqual([]);
  });

  it('still repaints on a real change, and lands exactly on the final value', () => {
    const { b, knob, arc } = build();
    const setAttr = vi.spyOn(arc, 'setAttribute');

    b.set('filter.cutoff', 40);
    const at40 = arc.getAttribute('stroke-dasharray');
    b.set('filter.cutoff', 120);
    const at120 = arc.getAttribute('stroke-dasharray');

    expect(setAttr).toHaveBeenCalled();
    expect(at120).not.toBe(at40);
    // The label tracks the final value, not a rounded-away intermediate.
    expect(knob.el.textContent).toContain(b.def('filter.cutoff')!.format!(120));
  });

  it('a fine automated sweep still ends on the true value (no drift)', () => {
    const { b, knob } = build();
    for (let i = 0; i <= 400; i++) b.set('filter.cutoff', 30 + (100 * i) / 400);
    expect(knob.el.textContent).toContain(b.def('filter.cutoff')!.format!(130));
  });
});

/**
 * Soft ceiling (knob-soft-ceiling.md). `lfo.rate` is registered 0.05..20 Hz but
 * the PWM path clamps it to 10 (oscillators.md REQ-9), so the top half of the
 * travel is dead while `dest === pulse`. The ceiling stops the arc there and
 * changes nothing else — these tests pin "nothing else" as hard as they pin the
 * arc, because a ceiling that quietly clamped the value would invalidate presets.
 */
describe('Knob soft ceiling', () => {
  afterEach(() => vi.restoreAllMocks());

  // Same geometry as the component: r=26, a 280° sweep.
  const DASH_ON = (2 * Math.PI * 26 * 280) / 360;
  // Where a 10 Hz ceiling lands on lfo.rate, derived from the param's own taper
  // (exp over 0.05..20, lfo.md REQ-8) rather than hardcoded — the point of the
  // assertion is "the ceiling tracks the taper", not one arithmetic result.
  const RATE_CEIL = Math.log(10 / 0.05) / Math.log(20 / 0.05); // ≈ 0.884
  // By class, not nth-of-type: the dead-region marker (v2) inserts a third
  // circle ahead of the value arc whenever a ceiling is set.
  const arcOf = (knob: Knob): Element => knob.el.querySelector('.' + styles.value!)!;
  const deadOf = (knob: Knob): Element | null => knob.el.querySelector('.' + styles.dead!);
  const dashLen = (el: Element): number =>
    parseFloat(el.getAttribute('stroke-dasharray')!.split(' ')[0]!);
  /** The lit portion of the arc, in the same units the component writes. */
  const litOf = (knob: Knob): number => dashLen(arcOf(knob));

  it('stops the arc at the ceiling while value, pointer and readout run on', () => {
    const b = bus();
    const knob = new Knob({ bus: b, paramId: 'lfo.rate', uiMax: 10 });
    const indicator = knob.el.querySelector<HTMLElement>('.' + styles.indicator!)!;
    b.set('lfo.rate', 20);

    // Arc caps at the 10 Hz position — a narrow dead band near the top of the
    // dial now the rate is exponentially tapered.
    expect(litOf(knob)).toBeCloseTo(DASH_ON * RATE_CEIL, 2);
    expect(litOf(knob)).toBeLessThan(DASH_ON);

    // Everything else still reports the true 20 Hz: full travel is +140°.
    expect(indicator.style.transform).toContain('rotate(140');
    expect(knob.el.textContent).toContain('20.00Hz');
    expect(b.get('lfo.rate')).toBe(20);
  });

  it('leaves a knob with no ceiling exactly as it was (regression)', () => {
    const b = bus();
    const knob = new Knob({ bus: b, paramId: 'lfo.rate' });
    b.set('lfo.rate', 20);
    expect(litOf(knob)).toBeCloseTo(DASH_ON, 2);
    expect(knob.el.dataset.uimax).toBeUndefined();
  });

  it('maps the ceiling through the param taper, not linearly', () => {
    // filter.resonance is power-tapered (curve 0.6) over 0..4.2, so a ceiling at
    // the numeric midpoint sits at 0.5^(1/0.6) ≈ 0.31 of the sweep, not at 0.5.
    const b = bus();
    const knob = new Knob({ bus: b, paramId: 'filter.resonance', uiMax: 2.1 });
    b.set('filter.resonance', 4.2);
    expect(litOf(knob)).toBeCloseTo(DASH_ON * Math.pow(0.5, 1 / 0.6), 2);
    expect(litOf(knob)).not.toBeCloseTo(DASH_ON * 0.5, 2);
  });

  it('set/clear repaints immediately and tracks data-uimax', () => {
    const b = bus();
    const knob = new Knob({ bus: b, paramId: 'lfo.rate' });
    b.set('lfo.rate', 20);
    expect(litOf(knob)).toBeCloseTo(DASH_ON, 2);

    // Applying a ceiling repaints at the current value — no param change needed.
    knob.setUiMax(10);
    expect(litOf(knob)).toBeCloseTo(DASH_ON * RATE_CEIL, 2);
    expect(knob.el.dataset.uimax).toBe('10');
    expect(b.get('lfo.rate')).toBe(20); // the value never moved

    knob.setUiMax(null);
    expect(litOf(knob)).toBeCloseTo(DASH_ON, 2);
    expect(knob.el.dataset.uimax).toBeUndefined();
    expect(deadOf(knob)).toBeNull(); // the marker goes with it
  });

  // v2, REQ-5. The dead band is ~32° once lfo.rate is exponentially tapered, and
  // at that size bare track reads as nothing at all — so it gets a positive mark.
  it('marks the dead region with an arc spanning ceiling to end of sweep', () => {
    const b = bus();
    const knob = new Knob({ bus: b, paramId: 'lfo.rate', uiMax: 10 });
    const dead = deadOf(knob)!;
    expect(dead).not.toBeNull();

    // Length is the remainder of the sweep above the ceiling...
    expect(dashLen(dead)).toBeCloseTo(DASH_ON * (1 - RATE_CEIL), 2);
    // ...and it starts where the value arc stops (negative offset delays it).
    expect(parseFloat(dead.getAttribute('stroke-dashoffset')!)).toBeCloseTo(-DASH_ON * RATE_CEIL, 2);

    // Painted under the value arc, so the two never fight over the same pixels.
    expect(dead.compareDocumentPosition(arcOf(knob)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('grows no extra element when there is no ceiling', () => {
    const b = bus();
    const knob = new Knob({ bus: b, paramId: 'lfo.rate' });
    expect(deadOf(knob)).toBeNull();
    expect(knob.el.querySelectorAll('circle').length).toBe(2); // track + value only
  });

  it('treats a ceiling at or above the registered max as no ceiling at all', () => {
    const b = bus();
    const knob = new Knob({ bus: b, paramId: 'lfo.rate', uiMax: 25 });
    b.set('lfo.rate', 20);
    expect(litOf(knob)).toBeCloseTo(DASH_ON, 2);
    expect(knob.el.dataset.uimax).toBeUndefined();
  });

  it('costs nothing to automate above the ceiling (REQ-7)', () => {
    const b = bus();
    const knob = new Knob({ bus: b, paramId: 'lfo.rate', uiMax: 10 });
    b.set('lfo.rate', 15);

    // Two further values, both above the ceiling: the arc is already maxed out,
    // so the guard should collapse them to zero writes.
    const setAttr = vi.spyOn(arcOf(knob), 'setAttribute');
    b.set('lfo.rate', 18);
    b.set('lfo.rate', 20);
    expect(setAttr).not.toHaveBeenCalled();
  });

  it('still lets a drag reach the true top of the range (REQ-2)', () => {
    vi.spyOn(performance, 'now').mockReturnValue(10_000); // skip the double-tap branch
    const b = bus();
    const knob = new Knob({ bus: b, paramId: 'lfo.rate', uiMax: 10 });
    const dial = knob.el.querySelector('.' + styles.dial!) as HTMLElement;

    b.set('lfo.rate', 10);
    dial.dispatchEvent(new MouseEvent('pointerdown', { clientY: 200 }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientY: 0 })); // full sweep up
    window.dispatchEvent(new MouseEvent('pointerup'));

    expect(b.get('lfo.rate')).toBe(20);
    expect(knob.el.textContent).toContain('20.00Hz');
  });
});

/**
 * The modulation range arc (specs/features/mod-matrix.md REQ-8): how far routes can
 * move this knob, drawn from the route params alone — no audio-thread readback.
 */
describe('Knob modulation range arc', () => {
  const arcs = (k: Knob): number => k.el.querySelectorAll('circle').length;
  /** The range arc itself — circles are [track, modRange, value], so index is a trap. */
  const band = (k: Knob): SVGCircleElement | null =>
    k.el.querySelector('.' + styles.modRange!);

  it('draws no arc, and subscribes to nothing, on an unmodulatable param', () => {
    const b = bus();
    const k = new Knob({ bus: b, paramId: 'master.volume' });
    // Track + value only. A knob nothing can modulate must cost nothing.
    expect(arcs(k)).toBe(2);
    b.set('mod.0.src', 1);
    b.set('mod.0.dst', 1);
    b.set('mod.0.amt', 1);
    expect(arcs(k)).toBe(2);
  });

  it('grows an arc when a route points at it, and drops it again', () => {
    const b = bus();
    const k = new Knob({ bus: b, paramId: 'filter.cutoff' });
    expect(arcs(k)).toBe(2);

    b.set('mod.0.src', 1);          // LFO 1
    b.set('mod.0.dst', 1);          // cutoff
    b.set('mod.0.amt', 0.5);
    expect(arcs(k)).toBe(3);

    // Built on demand, and removed again — not just hidden.
    b.set('mod.0.amt', 0);
    expect(arcs(k)).toBe(2);
  });

  it('appears for an LFO row too, not only a matrix row', () => {
    const b = bus();
    const k = new Knob({ bus: b, paramId: 'filter.cutoff' });
    b.set('lfo.dest', 1);           // cutoff
    b.set('lfo.amount', 0.5);
    expect(arcs(k)).toBe(3);
  });

  it('widens with depth', () => {
    const b = bus();
    const k = new Knob({ bus: b, paramId: 'filter.cutoff' });
    b.set('mod.0.src', 1);
    b.set('mod.0.dst', 1);
    b.set('mod.0.amt', 0.2);
    const narrow = band(k)!.getAttribute('stroke-dasharray');
    b.set('mod.0.amt', 0.8);
    const wide = band(k)!.getAttribute('stroke-dasharray');
    expect(wide).not.toBe(narrow);
    expect(parseFloat(wide!)).toBeGreaterThan(parseFloat(narrow!));
  });

  it('follows the knob value, since the band is centred on it', () => {
    const b = bus();
    const k = new Knob({ bus: b, paramId: 'filter.cutoff' });
    b.set('mod.0.src', 1);
    b.set('mod.0.dst', 1);
    b.set('mod.0.amt', 0.3);
    const before = band(k)!.getAttribute('stroke-dashoffset');
    b.set('filter.cutoff', 60);
    const after = band(k)!.getAttribute('stroke-dashoffset');
    expect(after).not.toBe(before);
  });

  it('stops widening once the band reaches the end of the dial (edge)', () => {
    const b = bus();
    const k = new Knob({ bus: b, paramId: 'filter.cutoff' });
    b.set('mod.0.src', 1);
    b.set('mod.0.dst', 1);
    b.set('mod.0.amt', 1);
    const full = parseFloat(band(k)!.getAttribute('stroke-dasharray')!);
    // The band is clamped into the dial, so it can never draw past the sweep.
    const sweep = 2 * Math.PI * 21 * (280 / 360);
    expect(full).toBeLessThanOrEqual(sweep + 0.01);
  });
});

/** REQ-11's live tick — only for sources the main thread already knows. */
describe('Knob modulation position marker', () => {
  const marker = (k: Knob): SVGCircleElement | null =>
    k.el.querySelector('.' + styles.modMarker!);

  it('appears for a mod-wheel route and tracks the wheel', () => {
    const b = bus();
    const k = new Knob({ bus: b, paramId: 'filter.resonance' });
    b.set('mod.0.src', 3);          // mod wheel
    b.set('mod.0.dst', 2);          // resonance
    b.set('mod.0.amt', 0.5);
    expect(marker(k)).not.toBeNull();

    const down = marker(k)!.getAttribute('stroke-dashoffset');
    b.set('master.modWheel', 1);
    expect(marker(k)!.getAttribute('stroke-dashoffset')).not.toBe(down);
  });

  it('shows even with the wheel down, so you can see where it will travel from', () => {
    const b = bus();
    const k = new Knob({ bus: b, paramId: 'filter.cutoff' });
    b.set('mod.0.src', 3);
    b.set('mod.0.dst', 1);
    b.set('mod.0.amt', 1);
    expect(b.get('master.modWheel')).toBe(0);
    expect(marker(k)).not.toBeNull();
  });

  it('stays absent for an audio-thread source, which has no knowable position', () => {
    const b = bus();
    const k = new Knob({ bus: b, paramId: 'filter.cutoff' });
    b.set('mod.0.src', 1);          // LFO 1 — lives on the audio thread
    b.set('mod.0.dst', 1);
    b.set('mod.0.amt', 1);
    expect(k.el.querySelector('.' + styles.modRange!)).not.toBeNull();  // band, yes
    expect(marker(k)).toBeNull();                                        // tick, no
  });

  it('is removed when the wheel route goes away', () => {
    const b = bus();
    const k = new Knob({ bus: b, paramId: 'filter.cutoff' });
    b.set('mod.0.src', 3);
    b.set('mod.0.dst', 1);
    b.set('mod.0.amt', 1);
    expect(marker(k)).not.toBeNull();
    b.set('mod.0.src', 0);          // off
    expect(marker(k)).toBeNull();
  });
});

/**
 * Sign colouring (mod-matrix.md REQ-13). Green is up, yellow is down — the direction
 * a control pushes, not how much of it.
 */
describe('Knob modulation direction colouring', () => {
  it('colours the band by the route sign, window or no window', () => {
    // The point of the colour: an inverted route is visible on the FILTER panel
    // without the matrix open.
    const b = bus();
    const k = new Knob({ bus: b, paramId: 'filter.resonance' });
    b.set('mod.0.src', 1);          // LFO 1
    b.set('mod.0.dst', 2);          // resonance
    b.set('mod.0.amt', 0.5);
    expect(k.el.className).toContain(styles.modPos!);

    b.set('mod.0.amt', -0.5);
    expect(k.el.className).toContain(styles.modNeg!);
    expect(k.el.className).not.toContain(styles.modPos!);
  });

  it('stays neutral when routes disagree, because "negative" would be a lie', () => {
    const b = bus();
    const k = new Knob({ bus: b, paramId: 'filter.cutoff' });
    b.set('mod.0.src', 1); b.set('mod.0.dst', 1); b.set('mod.0.amt', 0.5);
    b.set('mod.1.src', 4); b.set('mod.1.dst', 1); b.set('mod.1.amt', -0.5);
    expect(k.el.className).not.toContain(styles.modPos!);
    expect(k.el.className).not.toContain(styles.modNeg!);
  });

  it('leaves a knob own value arc alone, however negative it goes', () => {
    // Colour is spent on what position cannot say. A bipolar knob's own value is
    // already legible from its pointer, so ENV at -26st stays the faceplate amber.
    const b = bus();
    const k = new Knob({ bus: b, paramId: 'filter.envAmount' });
    b.set('filter.envAmount', -26);
    const cls = k.el.className;
    expect(cls).not.toContain(styles.modPos!);
    expect(cls).not.toContain(styles.modNeg!);
    // ...and nothing else got added either: the class list is just the root.
    expect(cls.trim()).toBe(styles.root!);
  });
});

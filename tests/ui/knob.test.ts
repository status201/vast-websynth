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

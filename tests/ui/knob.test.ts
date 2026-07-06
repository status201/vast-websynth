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

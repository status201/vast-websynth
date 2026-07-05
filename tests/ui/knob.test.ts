import { describe, it, expect } from 'vitest';
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

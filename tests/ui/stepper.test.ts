import { describe, it, expect, afterEach, vi } from 'vitest';
import { Stepper } from '../../src/ui/components/stepper';
import { ParamBus, registerDefaults } from '../../src/state/params';
import styles from '../../src/ui/styles/stepper.module.css';

function bus() {
  const b = new ParamBus();
  registerDefaults(b);
  return b;
}

const PARAM = 'fx.zoetrope.depth'; // 1..64, step 1, default 12
const MAGNETS = [1, 2, 4, 8, 16, 32, 64];

function build(magnets: readonly number[] | undefined = MAGNETS) {
  const b = bus();
  const stepper = new Stepper({ bus: b, paramId: PARAM, label: 'Depth', magnets });
  const box = stepper.el.querySelector('.' + styles.box!) as HTMLElement;
  return { b, stepper, box };
}

const down = (box: HTMLElement, clientY: number, shiftKey = false): void =>
  void box.dispatchEvent(new MouseEvent('pointerdown', { clientY, shiftKey }));
const move = (clientY: number, shiftKey = false): void =>
  void window.dispatchEvent(new MouseEvent('pointermove', { clientY, shiftKey }));
const up = (): void => void window.dispatchEvent(new MouseEvent('pointerup'));

describe('Stepper', () => {
  afterEach(() => vi.restoreAllMocks());

  it('mints a stable testid and shows the formatted value', () => {
    const { stepper, box } = build();
    expect(stepper.el.dataset.testid).toBe(`stepper-${PARAM}`);
    expect(box.textContent).toBe('12 cyc');
  });

  it('drags through whole values', () => {
    vi.spyOn(performance, 'now').mockReturnValue(10_000);
    const { b, box } = build([]); // no magnets — plain integer stepping
    down(box, 200);
    move(200 - 14 * 3); // 3 steps up
    expect(b.get(PARAM)).toBe(15);
    move(200 + 14 * 2); // 2 steps below the start
    expect(b.get(PARAM)).toBe(10);
    up();
  });

  it('snaps to a magnet when the drag lands within a step of it', () => {
    vi.spyOn(performance, 'now').mockReturnValue(10_000);
    const { b, box } = build();
    b.set(PARAM, 12);
    down(box, 200);
    move(200 - 14 * 3); // raw 15 — one step from the magnet at 16
    expect(b.get(PARAM)).toBe(16);
    up();
  });

  it('reaches values between magnets', () => {
    vi.spyOn(performance, 'now').mockReturnValue(10_000);
    const { b, box } = build();
    b.set(PARAM, 12);
    down(box, 200);
    move(200 - 14 * 8); // raw 20 — two clear of 16, not near 32
    expect(b.get(PARAM)).toBe(20);
    up();
  });

  it('clamps to the param range', () => {
    vi.spyOn(performance, 'now').mockReturnValue(10_000);
    const { b, box } = build();
    down(box, 200);
    move(200 - 14 * 500);
    expect(b.get(PARAM)).toBe(b.def(PARAM)!.max);
    move(200 + 14 * 500);
    expect(b.get(PARAM)).toBe(b.def(PARAM)!.min);
    up();
  });

  it('double-tap resets to the loaded baseline, not the global default', () => {
    const { b, box } = build();
    b.restore({ [PARAM]: 8 });
    b.set(PARAM, 40);
    box.dispatchEvent(new Event('pointerdown'));
    box.dispatchEvent(new Event('pointerdown'));
    expect(b.get(PARAM)).toBe(8);
  });

  it('attaches no window listeners until a drag starts, and balances on destroy', () => {
    vi.spyOn(performance, 'now').mockReturnValue(10_000);
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const isPointer = (t: unknown): boolean =>
      t === 'pointermove' || t === 'pointerup' || t === 'pointercancel';

    const { b, stepper, box } = build();
    expect(add.mock.calls.filter(([t]) => isPointer(t)).length).toBe(0);

    down(box, 200);
    stepper.destroy();

    const added = add.mock.calls.filter(([t]) => isPointer(t)).length;
    const removed = remove.mock.calls.filter(([t]) => isPointer(t)).length;
    expect(added).toBeGreaterThan(0);
    expect(removed).toBe(added);

    const at = b.get(PARAM);
    move(10); // detached handler must not write
    expect(b.get(PARAM)).toBe(at);
  });

  it('writes the readout only when the text actually changes', () => {
    const { b, box } = build();
    b.set(PARAM, 20);
    const spy = vi.spyOn(box, 'textContent', 'set');
    b.set(PARAM, 20);
    expect(spy).not.toHaveBeenCalled();
    b.set(PARAM, 21);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

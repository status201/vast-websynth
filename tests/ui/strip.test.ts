import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Strip } from '../../src/ui/components/strip';
import { ParamBus, registerDefaults } from '../../src/state/params';

function bus(): ParamBus {
  const b = new ParamBus();
  registerDefaults(b);
  return b;
}

const isPointer = (t: unknown): boolean =>
  t === 'pointermove' || t === 'pointerup' || t === 'pointercancel';

// Strip constructs a ResizeObserver, which jsdom does not provide — stub it.
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// Strip attaches the same window drag listeners as Knob; it is built once today
// so it does not leak in practice, but the lifecycle contract must hold so the
// pattern stays safe if a Strip is ever rebuilt (add-a-ui-component.md).
describe('Strip drag-listener lifecycle', () => {
  beforeEach(() => vi.stubGlobal('ResizeObserver', FakeResizeObserver));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('adds no window pointer listeners on construction', () => {
    const add = vi.spyOn(window, 'addEventListener');
    new Strip({ bus: bus(), paramId: 'filter.cutoff', label: 'X' });
    expect(add.mock.calls.filter(([t]) => isPointer(t)).length).toBe(0);
  });

  it('destroy() removes the drag listeners it attached on pointerdown', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const strip = new Strip({ bus: bus(), paramId: 'filter.cutoff', label: 'X' });

    strip.el.dispatchEvent(new MouseEvent('pointerdown', { clientY: 10 }));
    strip.destroy();

    const added = add.mock.calls.filter(([t]) => isPointer(t)).length;
    const removed = remove.mock.calls.filter(([t]) => isPointer(t)).length;
    expect(added).toBeGreaterThan(0);
    expect(removed).toBe(added);
  });
});

/** A pointer event from one finger — jsdom has no PointerEvent constructor. */
function finger(type: string, pointerId: number, init: MouseEventInit): MouseEvent {
  const e = new MouseEvent(type, { bubbles: true, ...init });
  Object.defineProperty(e, 'pointerId', { value: pointerId });
  return e;
}

// runtime-performance REQ-a-drag-follows-only-its-own-pointer (regression).
describe('Strip drag vs a second finger', () => {
  beforeEach(() => vi.stubGlobal('ResizeObserver', FakeResizeObserver));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('follows only the finger that grabbed it, and springs back on that finger only', () => {
    const b = bus();
    const strip = new Strip({ bus: b, paramId: 'filter.cutoff', label: 'X', springBack: true });
    // 122 px tall: clientY 11 is the top of travel, 111 the bottom.
    strip.el.getBoundingClientRect = () =>
      ({ top: 0, left: 0, height: 122, width: 20, bottom: 122, right: 20, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const def = b.def('filter.cutoff')!;

    strip.el.dispatchEvent(finger('pointerdown', 1, { clientY: 11 }));
    expect(b.get('filter.cutoff')).toBe(def.max);
    window.dispatchEvent(finger('pointermove', 2, { clientY: 111 }));
    expect(b.get('filter.cutoff')).toBe(def.max);
    window.dispatchEvent(finger('pointerup', 2, { clientY: 111 }));
    expect(b.get('filter.cutoff')).toBe(def.max); // no spring-back: finger 1 still holds it
    window.dispatchEvent(finger('pointerup', 1, { clientY: 11 }));
    expect(b.get('filter.cutoff')).toBe(def.default);
    strip.destroy();
  });
});

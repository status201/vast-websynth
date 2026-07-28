import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHoldButton, HOLD_MS } from '../../src/ui/components/hold-button';
import { ParamBus, registerDefaults } from '../../src/state/params';

function bus() {
  const b = new ParamBus();
  registerDefaults(b);
  return b;
}

const PARAM = 'fx.zoetrope.freeze';

/** performance.now() is the only clock the button reads; drive it directly. */
function clock(start = 10_000) {
  let t = start;
  vi.spyOn(performance, 'now').mockImplementation(() => t);
  return {
    advance(ms: number) { t += ms; },
  };
}

const press = (el: HTMLElement): void => void el.dispatchEvent(new Event('pointerdown'));
const release = (el: HTMLElement, type = 'pointerup'): void => void el.dispatchEvent(new Event(type));

describe('createHoldButton — latch mode', () => {
  afterEach(() => vi.restoreAllMocks());

  function build() {
    const b = bus();
    const btn = createHoldButton({
      mode: 'latch', bus: b, paramId: PARAM, label: 'Freeze', testId: 'zoetrope-freeze',
    });
    return { b, btn };
  }

  it('latches on a click and un-latches on the next one', () => {
    const c = clock();
    const { b, btn } = build();

    press(btn.el);
    c.advance(80);
    release(btn.el);
    expect(b.get(PARAM)).toBe(1);

    c.advance(500);
    press(btn.el);
    c.advance(80);
    release(btn.el);
    expect(b.get(PARAM)).toBe(0);
  });

  it('is momentary when held past the threshold', () => {
    const c = clock();
    const { b, btn } = build();

    press(btn.el);
    expect(b.get(PARAM)).toBe(1); // engages the instant it is pressed
    c.advance(HOLD_MS + 50);
    release(btn.el);
    expect(b.get(PARAM)).toBe(0);
  });

  it('releases on pointerleave and pointercancel too', () => {
    for (const type of ['pointerleave', 'pointercancel']) {
      const c = clock();
      const { b, btn } = build();
      press(btn.el);
      c.advance(HOLD_MS + 50);
      release(btn.el, type);
      expect(b.get(PARAM)).toBe(0);
      vi.restoreAllMocks();
    }
  });

  it('mirrors the param, so automation and preset loads light it', () => {
    clock();
    const { b, btn } = build();
    expect(btn.el.classList.contains('on')).toBe(false);
    b.set(PARAM, 1); // e.g. the motion sequencer
    expect(btn.el.classList.contains('on')).toBe(true);
    b.set(PARAM, 0);
    expect(btn.el.classList.contains('on')).toBe(false);
  });

  it('ignores a repeated pointerdown without a release', () => {
    const c = clock();
    const { b, btn } = build();
    press(btn.el);
    c.advance(HOLD_MS + 50);
    press(btn.el); // duplicate — must not restart the hold timer
    release(btn.el);
    expect(b.get(PARAM)).toBe(0);
  });

  it('stops mirroring after destroy', () => {
    clock();
    const { b, btn } = build();
    btn.destroy();
    b.set(PARAM, 1);
    expect(btn.el.classList.contains('on')).toBe(false);
  });
});

describe('createHoldButton — momentary mode', () => {
  afterEach(() => vi.restoreAllMocks());

  function build() {
    const events: string[] = [];
    const btn = createHoldButton({
      mode: 'momentary',
      label: 'Fill',
      testId: 'perf-fill',
      onPress: () => events.push('press'),
      onRelease: () => events.push('release'),
    });
    return { btn, events };
  }

  it('engages on down and releases on up, exactly once each', () => {
    const { btn, events } = build();
    press(btn.el);
    press(btn.el); // duplicate down
    expect(events).toEqual(['press']);
    expect(btn.el.classList.contains('on')).toBe(true);

    release(btn.el);
    release(btn.el); // duplicate up
    expect(events).toEqual(['press', 'release']);
    expect(btn.el.classList.contains('on')).toBe(false);
  });

  it('releases on pointerleave', () => {
    const { btn, events } = build();
    press(btn.el);
    release(btn.el, 'pointerleave');
    expect(events).toEqual(['press', 'release']);
  });
});

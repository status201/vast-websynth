import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createXyPad } from '../../src/ui/components/xy-pad';
import { toNorm, fromNorm } from '../../src/ui/components/taper';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { XyPadStore } from '../../src/state/xy-pad';

function mkBus(): ParamBus {
  const bus = new ParamBus();
  registerDefaults(bus);
  return bus;
}

const RECT = { left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON() {} };

/** Build a pad, append it, and give the surface a fixed 200x200 rect for drags. */
function mountPad(bus: ParamBus, xy: XyPadStore) {
  const pad = createXyPad(bus, xy);
  document.body.appendChild(pad.el);
  const surface = pad.el.querySelector('[data-testid="xypad-surface"]') as HTMLElement;
  surface.getBoundingClientRect = () => RECT as DOMRect;
  const dot = pad.el.querySelector('[data-testid="xypad-dot"]') as HTMLElement;
  return { pad, surface, dot };
}

/** Manual rAF harness — enqueue on request, flush on demand at a controllable clock. */
function installRaf() {
  let queue: Array<{ id: number; cb: FrameRequestCallback }> = [];
  let id = 0;
  let now = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queue.push({ id: ++id, cb }); return id; });
  vi.stubGlobal('cancelAnimationFrame', (h: number) => { queue = queue.filter((e) => e.id !== h); });
  vi.stubGlobal('performance', { now: () => now });
  return {
    setNow: (t: number) => { now = t; },
    flush: () => { const batch = queue; queue = []; for (const e of batch) e.cb(now); },
    /** Run the ramp to completion (one big time jump). */
    complete: () => { now = 1e6; const batch = queue; queue = []; for (const e of batch) e.cb(now); },
  };
}

describe('createXyPad', () => {
  const pads: Array<{ destroy(): void }> = [];
  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(() => { pads.forEach((p) => p.destroy()); pads.length = 0; vi.unstubAllGlobals(); });

  it('renders the surface, dot, hint and two assign dropdowns', () => {
    const bus = mkBus();
    const { pad } = mountPad(bus, new XyPadStore());
    pads.push(pad);
    expect(pad.el.querySelector('[data-testid="xypad-surface"]')).not.toBeNull();
    expect(pad.el.querySelector('[data-testid="xypad-dot"]')).not.toBeNull();
    expect(pad.el.querySelector('[data-testid="xypad-hint"]')).not.toBeNull();
    expect(pad.el.querySelector('[data-testid="xypad-assign-x"]')).not.toBeNull();
    expect(pad.el.querySelector('[data-testid="xypad-assign-y"]')).not.toBeNull();
  });

  it('dragging drives both assigned params through their tapers (Y inverted)', () => {
    const bus = mkBus();
    const { pad, surface } = mountPad(bus, new XyPadStore());
    pads.push(pad);

    // 75% across (x=150/200) and 75% UP (y=50/200 -> ny = 1 - 0.25 = 0.75).
    surface.dispatchEvent(new MouseEvent('pointerdown', { clientX: 150, clientY: 50 }));

    expect(bus.get('filter.cutoff')).toBe(fromNorm(bus.def('filter.cutoff')!, 0.75));
    expect(bus.get('filter.resonance')).toBe(fromNorm(bus.def('filter.resonance')!, 0.75)); // power taper honoured
  });

  it('springs both params back to their pre-gesture values on pointerup', () => {
    const raf = installRaf();
    const bus = mkBus();
    const { pad, surface } = mountPad(bus, new XyPadStore());
    pads.push(pad);
    const preCut = bus.get('filter.cutoff');
    const preRes = bus.get('filter.resonance');

    surface.dispatchEvent(new MouseEvent('pointerdown', { clientX: 180, clientY: 20 }));
    expect(bus.get('filter.cutoff')).not.toBe(preCut); // moved during the gesture

    surface.dispatchEvent(new MouseEvent('pointerup', {}));
    raf.complete();

    expect(bus.get('filter.cutoff')).toBe(preCut);
    expect(bus.get('filter.resonance')).toBe(preRes);
  });

  it('restarting a gesture mid-ramp keeps the ORIGINAL pre (not a half-sprung value)', () => {
    const raf = installRaf();
    const bus = mkBus();
    const { pad, surface } = mountPad(bus, new XyPadStore());
    pads.push(pad);
    const pre0 = bus.get('filter.cutoff');

    // Gesture 1 → release → advance the ramp only halfway.
    surface.dispatchEvent(new MouseEvent('pointerdown', { clientX: 200, clientY: 100 }));
    surface.dispatchEvent(new MouseEvent('pointerup', {}));
    raf.setNow(90); // half of the 180ms ramp
    raf.flush();
    const halfSprung = bus.get('filter.cutoff');
    expect(halfSprung).not.toBe(pre0); // genuinely mid-ramp

    // Gesture 2 starts before the ramp finished, then releases and completes.
    surface.dispatchEvent(new MouseEvent('pointerdown', { clientX: 20, clientY: 100 }));
    surface.dispatchEvent(new MouseEvent('pointerup', {}));
    raf.complete();

    // Back to the TRUE starting point, proving pre survived the flurry.
    expect(bus.get('filter.cutoff')).toBe(pre0);
  });

  it('two-finger scroll nudges the dot, and leaving the pad springs it back', () => {
    const raf = installRaf();
    const bus = mkBus();
    const { pad, surface } = mountPad(bus, new XyPadStore());
    pads.push(pad);
    const preCut = bus.get('filter.cutoff');
    const cutDef = bus.def('filter.cutoff')!;

    // deltaX 400 * K(1/400) = +1 in normalized space -> clamps X to its max.
    surface.dispatchEvent(new WheelEvent('wheel', { deltaX: 400, deltaY: 0 }));
    expect(bus.get('filter.cutoff')).toBe(fromNorm(cutDef, 1));

    // A wheel gesture ends when the pointer leaves the surface -> spring back.
    surface.dispatchEvent(new MouseEvent('pointerleave', {}));
    raf.complete();
    expect(bus.get('filter.cutoff')).toBe(preCut);
  });

  it('reassigning the X axis via the store re-subscribes the dot to the new param', () => {
    const bus = mkBus();
    const xy = new XyPadStore();
    const { pad, dot } = mountPad(bus, xy);
    pads.push(pad);

    xy.set({ x: 'lfo.rate' });
    const lfoDef = bus.def('lfo.rate')!;
    bus.set('lfo.rate', lfoDef.max);
    expect(dot.style.left).toBe(`${toNorm(lfoDef, lfoDef.max) * 100}%`); // = 100%

    // The former X param (filter.cutoff) no longer drives the dot.
    const leftNow = dot.style.left;
    bus.set('filter.cutoff', bus.def('filter.cutoff')!.min);
    expect(dot.style.left).toBe(leftNow);
  });
});

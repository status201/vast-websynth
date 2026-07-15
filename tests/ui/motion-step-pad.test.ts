import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MotionStepPad } from '../../src/ui/components/motion-step-pad';

const RECT = { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON() {} };

function mount(opts?: { beat?: boolean }) {
  const onSet = vi.fn();
  const onClear = vi.fn();
  const pad = new MotionStepPad({ beat: opts?.beat ?? false, onSet, onClear });
  document.body.appendChild(pad.el);
  pad.el.getBoundingClientRect = () => RECT as DOMRect;
  return { pad, onSet, onClear };
}

const down = (x: number, y: number) => new MouseEvent('pointerdown', { clientX: x, clientY: y });
const move = (x: number, y: number) => new MouseEvent('pointermove', { clientX: x, clientY: y });

describe('MotionStepPad', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('a pointerdown reports normalized coordinates with y up', () => {
    const { pad, onSet } = mount();
    pad.el.dispatchEvent(down(25, 75));
    expect(onSet).toHaveBeenCalledWith(0.25, 0.25); // 75px from top = 0.25 up
  });

  it('dragging keeps reporting until pointerup; clamped to 0..1', () => {
    const { pad, onSet } = mount();
    pad.el.dispatchEvent(down(50, 50));
    pad.el.dispatchEvent(move(150, -20)); // outside the rect
    expect(onSet).toHaveBeenLastCalledWith(1, 1);
    pad.el.dispatchEvent(new MouseEvent('pointerup'));
    pad.el.dispatchEvent(move(10, 10));
    expect(onSet).toHaveBeenCalledTimes(2); // no report after release
  });

  it('a fast second tap clears instead of setting', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { pad, onSet, onClear } = mount();
    pad.el.dispatchEvent(down(50, 50));
    vi.setSystemTime(1_000_150);
    pad.el.dispatchEvent(down(50, 50));
    expect(onSet).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('two slow taps both set', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { pad, onSet, onClear } = mount();
    pad.el.dispatchEvent(down(50, 50));
    vi.setSystemTime(1_001_000);
    pad.el.dispatchEvent(down(50, 50));
    expect(onSet).toHaveBeenCalledTimes(2);
    expect(onClear).not.toHaveBeenCalled();
  });

  it('setStep positions the dot at the literal coordinate and lights the pad', () => {
    const { pad } = mount();
    const dot = pad.el.querySelector('div') as HTMLElement;
    pad.setStep({ on: true, x: 0.25, y: 0.75 });
    expect(pad.el.classList.contains('on')).toBe(true);
    expect(dot.style.left).toBe('25%');
    expect(dot.style.top).toBe('25%'); // y up: 0.75 → 25% from the top
    pad.setStep({ on: false, x: 0.25, y: 0.75 });
    expect(pad.el.classList.contains('on')).toBe(false);
  });

  it('setPlaying toggles the global playing class', () => {
    const { pad } = mount();
    pad.setPlaying(true);
    expect(pad.el.classList.contains('playing')).toBe(true);
    pad.setPlaying(false);
    expect(pad.el.classList.contains('playing')).toBe(false);
  });
});

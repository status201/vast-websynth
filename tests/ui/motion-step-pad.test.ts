import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MotionStepPad, HOLD_MS, SNAP_STEPS, FINE_PX, type MotionGesture,
} from '../../src/ui/components/motion-step-pad';

const RECT = { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON() {} };

function mount(opts?: { beat?: boolean; mode?: 'xy' | 'level' }) {
  const onSet = vi.fn();
  const onClear = vi.fn();
  const onGesture = vi.fn();
  const pad = new MotionStepPad({
    beat: opts?.beat ?? false,
    ...(opts?.mode ? { mode: opts.mode } : {}),
    onSet,
    onClear,
    onGesture,
  });
  document.body.appendChild(pad.el);
  pad.el.getBoundingClientRect = () => RECT as DOMRect;
  return { pad, onSet, onClear, onGesture };
}

const down = (x: number, y: number, shiftKey = false): MouseEvent =>
  new MouseEvent('pointerdown', { clientX: x, clientY: y, shiftKey });
const move = (x: number, y: number, shiftKey = false): MouseEvent =>
  new MouseEvent('pointermove', { clientX: x, clientY: y, shiftKey });
const up = (): MouseEvent => new MouseEvent('pointerup');

/** The y a gesture last wrote. */
const lastY = (onSet: ReturnType<typeof vi.fn>): number =>
  onSet.mock.calls[onSet.mock.calls.length - 1]![1] as number;

describe('MotionStepPad (motion-sequencer.md REQ-23)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('deferred write + peek (REQ-23a)', () => {
    it('a press alone writes nothing — the commit waits for travel or release', () => {
      const { pad, onSet } = mount();
      pad.el.dispatchEvent(down(25, 75));
      expect(onSet).not.toHaveBeenCalled();
    });

    it('a tap commits the press position on release, y up', () => {
      const { pad, onSet } = mount();
      pad.el.dispatchEvent(down(25, 75));
      pad.el.dispatchEvent(up());
      expect(onSet).toHaveBeenCalledTimes(1);
      expect(onSet).toHaveBeenCalledWith(0.25, 0.25); // 75px from the top = 0.25 up
    });

    it('holding still for the peek window writes nothing, on press OR release', () => {
      const { pad, onSet, onGesture } = mount();
      pad.setLevel(true, 0.4);
      pad.el.dispatchEvent(down(50, 10)); // near the top: a write would land ~0.9
      vi.advanceTimersByTime(HOLD_MS + 10);
      expect(onSet).not.toHaveBeenCalled();

      // The readout shows what is THERE, not where the finger is.
      const peek = onGesture.mock.calls.map((c) => c[0] as MotionGesture | null)
        .find((g) => g?.mode === 'peek');
      expect(peek?.y).toBe(0.4);

      pad.el.dispatchEvent(up());
      expect(onSet).not.toHaveBeenCalled();
    });

    it('a peek is not half of a double-tap — the next press still sets', () => {
      const { pad, onSet, onClear } = mount();
      pad.el.dispatchEvent(down(50, 50));
      vi.advanceTimersByTime(HOLD_MS + 10);
      pad.el.dispatchEvent(up());
      vi.advanceTimersByTime(10);
      pad.el.dispatchEvent(down(50, 50));
      pad.el.dispatchEvent(up());
      expect(onClear).not.toHaveBeenCalled();
      expect(onSet).toHaveBeenCalledTimes(1);
    });

    it('travel past the slop starts a drag and cancels the pending peek', () => {
      const { pad, onSet } = mount();
      pad.el.dispatchEvent(down(50, 50));
      pad.el.dispatchEvent(move(80, 20));
      expect(onSet).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(HOLD_MS + 10); // the hold must not fire mid-drag
      pad.el.dispatchEvent(move(80, 10));
      expect(onSet).toHaveBeenCalledTimes(2);
      expect(lastY(onSet)).toBeCloseTo(0.9, 6);
    });

    it('a wobble inside the slop is still a press, not a drag', () => {
      const { pad, onSet } = mount();
      pad.el.dispatchEvent(down(50, 50));
      pad.el.dispatchEvent(move(52, 52));
      expect(onSet).not.toHaveBeenCalled();
      pad.el.dispatchEvent(up());
      expect(onSet).toHaveBeenCalledWith(0.5, 0.5); // the press position, not (52,52)
    });

    it('dragging keeps reporting until pointerup; clamped to 0..1', () => {
      const { pad, onSet } = mount();
      pad.el.dispatchEvent(down(50, 50));
      pad.el.dispatchEvent(move(150, -20)); // outside the rect
      expect(onSet).toHaveBeenLastCalledWith(1, 1);
      pad.el.dispatchEvent(up());
      pad.el.dispatchEvent(move(10, 10));
      expect(onSet).toHaveBeenCalledTimes(1); // no report after release
    });

    it('a fast second tap clears instead of setting', () => {
      const { pad, onSet, onClear } = mount();
      pad.el.dispatchEvent(down(50, 50));
      pad.el.dispatchEvent(up());
      vi.setSystemTime(1_000_150);
      pad.el.dispatchEvent(down(50, 50));
      expect(onSet).toHaveBeenCalledTimes(1);
      expect(onClear).toHaveBeenCalledTimes(1);
    });

    it('two slow taps both set', () => {
      const { pad, onSet, onClear } = mount();
      pad.el.dispatchEvent(down(50, 50));
      pad.el.dispatchEvent(up());
      vi.setSystemTime(1_001_000);
      pad.el.dispatchEvent(down(50, 50));
      pad.el.dispatchEvent(up());
      expect(onSet).toHaveBeenCalledTimes(2);
      expect(onClear).not.toHaveBeenCalled();
    });
  });

  describe('snap to a grid (REQ-23b)', () => {
    it('a coarse drag only ever writes multiples of 1/20', () => {
      const { pad, onSet } = mount();
      pad.el.dispatchEvent(down(50, 50));
      for (const y of [57, 43, 38, 21, 66, 4]) pad.el.dispatchEvent(move(50, y));
      for (const [x, v] of onSet.mock.calls as [number, number][]) {
        expect(Math.abs(x * SNAP_STEPS - Math.round(x * SNAP_STEPS))).toBeLessThan(1e-9);
        expect(Math.abs(v * SNAP_STEPS - Math.round(v * SNAP_STEPS))).toBeLessThan(1e-9);
      }
    });

    it('two drags that land near the same level produce the IDENTICAL number', () => {
      // The whole point: lane A and lane B have to be able to match exactly.
      const a = mount();
      const b = mount();
      a.pad.el.dispatchEvent(down(50, 50));
      a.pad.el.dispatchEvent(move(50, 39)); // 0.61 -> 0.60
      b.pad.el.dispatchEvent(down(50, 50));
      b.pad.el.dispatchEvent(move(50, 42)); // 0.58 -> 0.60
      expect(lastY(a.onSet)).toBe(lastY(b.onSet));
      expect(lastY(a.onSet)).toBe(0.6);
    });

    it('0 and 1 stay reachable', () => {
      const { pad, onSet } = mount();
      pad.el.dispatchEvent(down(50, 50));
      pad.el.dispatchEvent(move(50, 100));
      expect(lastY(onSet)).toBe(0);
      pad.el.dispatchEvent(move(50, 0));
      expect(lastY(onSet)).toBe(1);
    });
  });

  describe('Shift = fine, relative, unsnapped (REQ-23c)', () => {
    it('pressing with Shift does not jump to the pointer', () => {
      const { pad, onSet } = mount({ mode: 'level' });
      pad.setLevel(true, 0.4);
      pad.el.dispatchEvent(down(50, 10, true)); // 0.9 if it jumped
      pad.el.dispatchEvent(up());
      expect(lastY(onSet)).toBeCloseTo(0.4, 6);
    });

    it('Shift+drag nudges from the cell value at 1/FINE_PX per pixel, unsnapped', () => {
      const { pad, onSet } = mount({ mode: 'level' });
      pad.setLevel(true, 0.4);
      pad.el.dispatchEvent(down(50, 10, true));
      pad.el.dispatchEvent(move(50, -22, true)); // 32px up
      expect(lastY(onSet)).toBeCloseTo(0.4 + 32 / FINE_PX, 6); // 0.48 — not a snap stop
    });

    it('releasing Shift mid-drag re-anchors instead of jumping', () => {
      const { pad, onSet } = mount({ mode: 'level' });
      pad.el.dispatchEvent(down(50, 80));
      pad.el.dispatchEvent(move(50, 60));        // coarse absolute -> 0.40
      expect(lastY(onSet)).toBeCloseTo(0.4, 6);
      pad.el.dispatchEvent(move(50, 50, true));  // Shift on: re-anchor, hold 0.40
      expect(lastY(onSet)).toBeCloseTo(0.4, 6);
      pad.el.dispatchEvent(move(50, 30, true));  // 20px up at fine = +0.05
      expect(lastY(onSet)).toBeCloseTo(0.45, 6);
      // Shift off: the transition itself re-anchors, so it moves nothing.
      // Absolute mapping would have jumped to 0.70 here.
      pad.el.dispatchEvent(move(50, 30));
      expect(lastY(onSet)).toBeCloseTo(0.45, 6);
      pad.el.dispatchEvent(move(50, 20));        // 10px up at coarse = +0.10
      expect(lastY(onSet)).toBeCloseTo(0.55, 6);
    });
  });

  describe('the readout feed (REQ-22)', () => {
    it('reports press, then drag, then null on release', () => {
      const { pad, onGesture } = mount();
      pad.el.dispatchEvent(down(50, 50));
      pad.el.dispatchEvent(move(50, 20));
      pad.el.dispatchEvent(up());
      const modes = onGesture.mock.calls
        .map((c) => (c[0] as MotionGesture | null)?.mode ?? null);
      expect(modes[0]).toBe('press');
      expect(modes).toContain('drag');
      expect(modes[modes.length - 1]).toBeNull();
    });

    it('a press reports the cell value, since nothing has been written yet', () => {
      const { pad, onGesture } = mount({ mode: 'level' });
      pad.setLevel(true, 0.35);
      pad.el.dispatchEvent(down(50, 10));
      expect((onGesture.mock.calls[0]![0] as MotionGesture).y).toBe(0.35);
    });
  });

  describe('rendering', () => {
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

    it('the title names the gestures, not just the value', () => {
      const { pad } = mount();
      pad.setStep({ on: true, x: 0.25, y: 0.75 });
      expect(pad.el.title).toContain('0.25');
      expect(pad.el.title).toContain('Shift');
      expect(pad.el.title).toContain('hold to read');
    });

    it('setPlaying toggles the global playing class', () => {
      const { pad } = mount();
      pad.setPlaying(true);
      expect(pad.el.classList.contains('playing')).toBe(true);
      pad.setPlaying(false);
      expect(pad.el.classList.contains('playing')).toBe(false);
    });
  });
});

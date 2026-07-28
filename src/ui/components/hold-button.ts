import switchStyles from '../styles/switch.module.css';
import type { ParamBus } from '../../state/params';

/**
 * How long a press has to last before it counts as a hold rather than a click.
 * Short enough that nobody "clicks" by accident when they meant to hold, long
 * enough that a deliberate tap always latches.
 */
export const HOLD_MS = 300;

interface BaseOpts {
  label: string;
  testId: string;
  /** Defaults to the shared switch base; callers pass their own skin. */
  className?: string;
  title?: string;
}

export interface MomentaryOpts extends BaseOpts {
  mode: 'momentary';
  onPress: () => void;
  onRelease: () => void;
}

export interface LatchOpts extends BaseOpts {
  mode: 'latch';
  bus: ParamBus;
  paramId: string;
}

export type HoldButtonOptions = MomentaryOpts | LatchOpts;

export interface HoldButton {
  readonly el: HTMLButtonElement;
  destroy(): void;
}

/**
 * A button with two temporal behaviours (param-controls.md REQ-7/REQ-8).
 *
 * - `'momentary'` — down engages, up/leave/cancel releases. The DJ controls.
 * - `'latch'` — a *click* toggles the param, but *holding* past `HOLD_MS` makes
 *   it momentary and it releases on pointerup. So the same control can be set
 *   (Zoetrope's Freeze left on) or played (a stab of freeze), without a mode.
 *
 * In latch mode the lit state mirrors the param rather than the pointer, so a
 * preset load or motion automation lights it too.
 */
export function createHoldButton(opts: HoldButtonOptions): HoldButton {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = opts.className ?? switchStyles.root!;
  el.textContent = opts.label;
  el.dataset.testid = opts.testId;
  if (opts.title) el.title = opts.title;

  let unsubscribe: () => void = () => {};
  let down = false;
  let downAt = 0;
  let wasOn = false;

  const press = (e: Event): void => {
    e.preventDefault();
    if (down) return;
    down = true;
    downAt = performance.now();
    if (opts.mode === 'momentary') {
      if (!el.classList.contains('on')) {
        el.classList.add('on');
        opts.onPress();
      }
    } else {
      wasOn = opts.bus.get(opts.paramId) >= 0.5;
      // Engage immediately either way: a hold must sound from the instant it is
      // pressed, and a click that turns it off still reads as one gesture.
      if (!wasOn) opts.bus.set(opts.paramId, 1);
    }
  };

  const release = (): void => {
    if (!down) return;
    down = false;
    if (opts.mode === 'momentary') {
      if (el.classList.contains('on')) {
        el.classList.remove('on');
        opts.onRelease();
      }
      return;
    }
    const held = performance.now() - downAt >= HOLD_MS;
    // Held → always release. Clicked → toggle (off if it was already on).
    if (held || wasOn) opts.bus.set(opts.paramId, 0);
  };

  el.addEventListener('pointerdown', press);
  el.addEventListener('pointerup', release);
  el.addEventListener('pointerleave', release);
  el.addEventListener('pointercancel', release);

  if (opts.mode === 'latch') {
    unsubscribe = opts.bus.subscribe(opts.paramId, (v) => {
      el.classList.toggle('on', v >= 0.5);
    });
  }

  return {
    el,
    destroy(): void {
      unsubscribe();
      el.removeEventListener('pointerdown', press);
      el.removeEventListener('pointerup', release);
      el.removeEventListener('pointerleave', release);
      el.removeEventListener('pointercancel', release);
    },
  };
}

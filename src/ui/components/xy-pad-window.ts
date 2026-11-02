import type { ParamBus } from '../../state/params';
import type { XyPadStore } from '../../state/xy-pad';
import type { EffectiveXy } from '../../state/xy-effective';
import { FloatingWindow } from './floating-window';
import { createXyPad } from './xy-pad';
import {
  XY_PAD_SIZE_KEY, readSizePref, writeSizePref, clearSizePref,
} from '../../state/size-pref';

/** The pad's side (xy-pad.md REQ-the-pad-is-resizable): the default 240 px —
 *  also `.root`'s `var(--xy-size, 240px)` fallback, which CSS must spell out —
 *  up to four times it; the window caps it further to the viewport. */
const XY_PAD_SIDE_MIN = 240;
const XY_PAD_SIDE_MAX = XY_PAD_SIDE_MIN * 4;

/**
 * Single shared owner of the XY Pad floating window. The pad can be launched from
 * more than one place (the Song panel and the LIVE FX window), and both must
 * toggle the SAME window — never spawn a second one. This controller builds the
 * window (and pad) lazily on first open, keeps it alive across closes (so its live
 * axis assignment survives, matching the previous behaviour), and broadcasts open
 * state to every launcher button via `onChange`. See `specs/features/xy-pad.md`
 * and `specs/features/live-fx-window.md`.
 */
export interface XyPadWindowController {
  toggle(): void;
  isOpen(): boolean;
  /** Subscribe to open-state changes; returns an unsubscribe. Fires on toggle. */
  onChange(cb: (open: boolean) => void): () => void;
}

export function createXyPadWindowController(bus: ParamBus, xy: XyPadStore, effective?: EffectiveXy): XyPadWindowController {
  let win: FloatingWindow | null = null;
  const listeners = new Set<(open: boolean) => void>();
  const emit = (open: boolean): void => { for (const l of listeners) l(open); };

  function ensure(): FloatingWindow {
    if (win) return win;
    // Build the pad first so its gear can seed the window's title-bar slot.
    const pad = createXyPad(bus, xy, effective);
    const w: FloatingWindow = new FloatingWindow({
      title: 'XY Pad',
      testId: 'xypad-window',
      leading: pad.gear,
      resizable: {
        direction: 'down-right',
        cssVar: '--xy-size',
        bounds: () => ({ min: XY_PAD_SIDE_MIN, max: XY_PAD_SIDE_MAX }),
        measure: () => pad.el.offsetWidth,
        initial: readSizePref(XY_PAD_SIZE_KEY, XY_PAD_SIDE_MIN, XY_PAD_SIDE_MAX),
        step: 16,
        onCommit: (px) => writeSizePref(XY_PAD_SIZE_KEY, px),
        onReset: () => clearSizePref(XY_PAD_SIZE_KEY),
        label: 'XY Pad size',
        title: 'Drag to resize — double-click for the default size',
      },
      // Every close routes through here — the ✕ and the launcher toggle alike —
      // so it is the one place a live gesture can be ended. A wheel gesture
      // otherwise ends only on `pointerleave`, which a removed element never
      // fires, leaving both params swept (xy-pad.md REQ-wheel-nudges-the-dot).
      onClose: () => { pad.endGesture(); emit(false); },
    });
    win = w;
    w.body.insertBefore(pad.el, w.body.firstChild);
    // The assign row changes the window's height, so the room changes too.
    pad.gear.addEventListener('click', () => w.refreshSize());
    return w;
  }

  return {
    toggle(): void {
      const w = ensure();
      if (w.isOpen) { w.close(); return; } // close() -> onClose -> emit(false)
      w.open();
      emit(true);
    },
    isOpen(): boolean { return win?.isOpen ?? false; },
    onChange(cb): () => void {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
  };
}

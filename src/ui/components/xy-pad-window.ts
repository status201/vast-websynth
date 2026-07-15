import type { ParamBus } from '../../state/params';
import type { XyPadStore } from '../../state/xy-pad';
import type { EffectiveXy } from '../../state/xy-effective';
import { FloatingWindow } from './floating-window';
import { createXyPad } from './xy-pad';

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
    win = new FloatingWindow({
      title: 'XY Pad',
      testId: 'xypad-window',
      leading: pad.gear,
      onClose: () => emit(false),
    });
    win.body.appendChild(pad.el);
    return win;
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

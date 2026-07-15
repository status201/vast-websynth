import type { ParamBus } from './params';
import type { PatternStore } from './patterns';
import type { XyAssign, XyPadStore } from './xy-pad';

/**
 * The *effective* XY axis assignment: what the motion sequencer is actually
 * driving right now (motion-sequencer.md REQ-4). While `motion.on` is set, the
 * motion play bank's per-bank override wins per axis; otherwise (and for any
 * unset axis) it falls back to the XY Pad's base assignment. The XY Pad window
 * displays/drives THIS, so its labels and dot stay truthful as the chain moves
 * across banks; the pad's gear dropdowns keep editing the base `XyPadStore`.
 *
 * App-lifetime singleton (built once in app.ts); the subscriptions are never
 * torn down, matching the panels' own store subscriptions.
 */
export interface EffectiveXy {
  get(): XyAssign;
  /** Fires only when the effective pair actually changes; returns unsubscribe. */
  onChange(cb: (a: XyAssign) => void): () => void;
}

/** The slice of Arrangement this needs (structural, so tests can stub it). */
interface MotionLaneView {
  readonly motionPlayBank: number;
  onChange(fn: () => void): () => void;
}

export function createEffectiveXy(
  xy: XyPadStore,
  patterns: PatternStore,
  arrangement: MotionLaneView,
  bus: ParamBus,
): EffectiveXy {
  const resolve = (): XyAssign => {
    const base = xy.get();
    // A muted machine is inactive (motion-sequencer.md REQ-12) — base axes apply.
    if (bus.get('motion.on') < 0.5 || bus.get('motion.mute') >= 0.5) return base;
    const ov = patterns.motionAssign(arrangement.motionPlayBank);
    return { x: ov?.x ?? base.x, y: ov?.y ?? base.y };
  };

  let last = resolve();
  const listeners = new Set<(a: XyAssign) => void>();
  const refresh = (): void => {
    const next = resolve();
    if (next.x === last.x && next.y === last.y) return;
    last = next;
    for (const l of listeners) l({ ...next });
  };

  // Every input the resolution depends on: the base assignment, the play bank
  // (advances per bar / chain edits), the per-bank overrides (setMotionAssign
  // and song restore both fire the motion bank listeners), and the machine
  // on/off + mute params.
  xy.onChange(refresh);
  arrangement.onChange(refresh);
  patterns.onMotionBankChange(refresh);
  bus.subscribe('motion.on', refresh);
  bus.subscribe('motion.mute', refresh);

  return {
    get: () => ({ ...resolve() }),
    onChange(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
  };
}

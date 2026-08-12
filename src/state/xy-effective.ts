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

/**
 * The axes a motion bank drives: its per-bank override wins per axis, each unset
 * axis falls back to the XY Pad's base assignment (REQ-4). Shared by the resolver
 * below, the machine's bar-line carry gate and the Motion panel's graph — all
 * three must agree on which param a bank's anchors mean.
 */
export function motionAxesFor(
  patterns: PatternStore,
  bank: number,
  base: XyAssign,
): XyAssign {
  const ov = patterns.motionAssign(bank);
  return { x: ov?.x ?? base.x, y: ov?.y ?? base.y };
}

/**
 * `motionAxesFor` into a caller-owned holder, for the frame loop
 * (runtime-performance.md REQ-6). Same resolution rule, no allocation; the
 * returning form above stays the default everywhere a shared mutable holder
 * would be a hazard rather than a saving.
 */
export function motionAxesInto(
  patterns: PatternStore,
  bank: number,
  base: XyAssign,
  out: XyAssign,
): void {
  const ov = patterns.motionAssign(bank);
  out.x = ov?.x ?? base.x;
  out.y = ov?.y ?? base.y;
}

/**
 * Does `bank` drive exactly `axes`? Equivalent to comparing
 * `motionAxesFor(patterns, bank, base)` field-by-field against `axes`, without
 * building the intermediate object — the machine asks this twice per frame (once
 * per carry neighbour) and never needs the pair itself
 * (runtime-performance.md REQ-6). Kept beside `motionAxesFor` deliberately: the
 * two must resolve overrides the same way, so they have to be read together.
 */
export function motionAxesMatch(
  patterns: PatternStore,
  bank: number,
  base: XyAssign,
  axes: XyAssign,
): boolean {
  const ov = patterns.motionAssign(bank);
  return (ov?.x ?? base.x) === axes.x && (ov?.y ?? base.y) === axes.y;
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
    return motionAxesFor(patterns, arrangement.motionPlayBank, base);
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

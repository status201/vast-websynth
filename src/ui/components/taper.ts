import type { ParamDef } from '../../state/params';

// Pure value ↔ knob-position mappings for the parameter tapers. Kept out of the
// Knob component so the math is unit-testable (see tests/ui/taper.test.ts).
//
//   linear  — straight lerp across [min, max]
//   exp     — geometric; needs min > 0 (wide-range time/frequency knobs)
//   power   — v = min + (max-min)·c^curve; curve < 1 gives finer resolution
//             near max (e.g. filter.resonance near self-oscillation). Works at
//             min = 0, unlike exp.
//   discrete — handled as linear here; rounding is via def.step.

/** Value → normalized knob position in [0, 1]. */
export function toNorm(def: ParamDef, v: number): number {
  if (def.taper === 'exp' && def.min > 0) {
    return Math.log(v / def.min) / Math.log(def.max / def.min);
  }
  if (def.taper === 'power') {
    const c = (v - def.min) / (def.max - def.min);
    return Math.pow(Math.max(0, c), 1 / (def.curve ?? 1));
  }
  return (v - def.min) / (def.max - def.min);
}

/** Normalized knob position → value (clamped to [0, 1], then snapped to step). */
export function fromNorm(def: ParamDef, n: number): number {
  const c = Math.max(0, Math.min(1, n));
  let v: number;
  if (def.taper === 'exp' && def.min > 0) {
    v = def.min * Math.pow(def.max / def.min, c);
  } else if (def.taper === 'power') {
    v = def.min + Math.pow(c, def.curve ?? 1) * (def.max - def.min);
  } else {
    v = def.min + c * (def.max - def.min);
  }
  if (def.step) v = Math.round(v / def.step) * def.step;
  return v;
}

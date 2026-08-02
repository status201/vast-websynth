import type { ParamDef } from '../state/params';

/**
 * A parameter value as the user should read it: the discrete label if the param
 * has one, else the param's own `format` (`fmtHz`, `fmtMs`, … in `params.ts`),
 * else a plain number — no decimals once the magnitude reaches 100, where two
 * would be noise.
 *
 * Lifted out of `Knob`, which was its only caller until the motion sequencer's
 * per-lane readout needed the same answer (motion-sequencer.md REQ-22). Two
 * places describing one parameter differently is the drift this prevents.
 */
export function formatParam(def: ParamDef, v: number): string {
  if (def.taper === 'discrete' && def.labels) {
    return def.labels[Math.round(v - def.min)] ?? String(v);
  }
  if (def.format) return def.format(v);
  return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2);
}

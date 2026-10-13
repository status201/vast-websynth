/**
 * The master volume law — see `specs/features/input-control.md`.
 *
 * Pure, and in `state/` because **both layers read it**: the Engine sets the
 * master gain from it, and the `master.volume` knob formats its readout from it
 * (input-control.md REQ-the-volume-knob-reads-the-gain-it-applies). One function,
 * so the number on the knob and the level you hear cannot disagree — the role
 * `state/eq.ts` plays for the EQ's filters and its drawn curve.
 */

/**
 * The master gain for a volume and an expression (input-control.md REQ-cc11-is-expression):
 * both on the squared law the volume knob has always used, multiplied — so CC7
 * sets the level and CC11 rides inside it. Expression defaults to 1, which makes
 * this exactly `volume²`, the pre-v18 value.
 */
export function masterLevel(volume: number, expression: number): number {
  return volume * volume * expression * expression;
}

// The wave table the oscillators, the LFOs and the PWM driver index into — one
// definition, so a `*.wave` param value means the same shape everywhere.

/** `*.wave` index → Web Audio type. Append-only: a stored index must keep its shape. */
export const WAVE_TYPES: readonly OscillatorType[] = ['sine', 'triangle', 'sawtooth', 'square'];

/** A `*.wave` param value made a safe index into `WAVE_TYPES`. */
export function waveIndex(idx: number): number {
  const i = Math.round(idx);
  return i < 0 ? 0 : i > WAVE_TYPES.length - 1 ? WAVE_TYPES.length - 1 : i;
}

/** The one `*.wave` index pulse width applies to (oscillators.md REQ-oscillators-have-a-pulse-width). */
export const SQUARE_WAVE = 3;

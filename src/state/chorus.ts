/**
 * The chorus's MODE as one table (chorus.md REQ-the-chorus-mode-overrides-rate-and-depth):
 * each index's label and what it applies in place of the RATE and DEPTH knobs.
 * One table so the param's labels and the engine's values cannot drift apart —
 * an index is a stored value in every preset, song and share link, so the list
 * is append-only. Index 0 is FREE: no preset, the knobs rule.
 */
export const CHORUS_MODES: ReadonlyArray<{
  label: string;
  preset: { rate: number; depth: number } | null;
}> = [
  { label: 'FREE', preset: null },
  { label: 'I', preset: { rate: 0.5, depth: 0.5 } },     // slow and gentle
  { label: 'II', preset: { rate: 0.85, depth: 0.7 } },   // faster, deeper
  { label: 'I+II', preset: { rate: 8, depth: 0.12 } },   // fast, shallow shimmer
];

export const CHORUS_MODE_LABELS = CHORUS_MODES.map((m) => m.label);

/** The params a non-FREE mode overrides — the knobs the UI dims while it does. */
export const CHORUS_MODE_OVERRIDES: readonly string[] = ['rate', 'depth'];

/** What a stored `mode` value applies; `null` (FREE, or an unknown index) means the knobs. */
export function chorusModePreset(mode: number): { rate: number; depth: number } | null {
  return CHORUS_MODES[Math.round(mode)]?.preset ?? null;
}

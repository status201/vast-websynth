/**
 * Export-precision + default-sparse serialization for songs and presets.
 *
 * Pure and dependency-free. Optimization happens **only here**, at the
 * serialization boundary — live `ParamBus` / `PatternStore` state stays
 * full-precision (rounding `bus.set` would change the live instrument for zero
 * benefit; DSP cost is independent of a float's mantissa). See
 * `specs/decisions/adr-011-export-precision-and-default-sparse-serialization.md`.
 *
 * Two transforms, applied by `compactSongForExport` (and `roundParams` alone for
 * presets):
 *   1. Round every number to {@link EXPORT_SIG_FIGS} significant figures —
 *      inaudible (the UI shows ~2), but kills needless digits. Sig-figs, not
 *      fixed decimals, so tiny exp-taper values survive (attack 0.00003025, not 0).
 *   2. Drop step-cell fields equal to their *restore* default, so a dead drum cell
 *      collapses to `{ on: false }`. The asymmetry below is dictated by how
 *      `PatternStore.restore` re-expands each machine.
 *
 * The output is the *canonical compact* form: `fromJSON(toJSON(x))` deep-equals
 * `compactSongForExport(x)` (not raw `x`); full fidelity is restored by
 * `apply()` / `restore` spreading defaults back under the sparse cells. The
 * compaction is idempotent, so re-exporting an already-compact file is a no-op.
 */
import type { SongFile, ChainData } from './song';
import type { SeqStep, TriggerCell } from './patterns';
import { TRIGGER_CELL_DEFAULTS, SEQ_EXTRA_DEFAULTS } from './patterns';

/** Significant figures kept for every exported number. */
export const EXPORT_SIG_FIGS = 4;

/** Round to {@link EXPORT_SIG_FIGS} sig-figs; pass non-finite values through. */
export function roundNum(n: number): number {
  return Number.isFinite(n) ? Number(n.toPrecision(EXPORT_SIG_FIGS)) : n;
}

/** Round every value of a param snapshot (shared by song + preset export). */
export function roundParams(params: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(params)) out[k] = roundNum(v);
  return out;
}

/**
 * Seq step → sparse object. `restore` spreads only `SEQ_EXTRA_DEFAULTS`
 * (prob/ratchet/tie) and `apply` does not reset the store first, so on/note/
 * velocity/gate are **always** kept; only prob/ratchet/tie drop when default.
 */
function compactSeqStep(s: SeqStep): Record<string, unknown> {
  const out: Record<string, unknown> = {
    on: s.on,
    note: s.note,
    velocity: roundNum(s.velocity),
    gate: roundNum(s.gate),
  };
  const prob = roundNum(s.prob ?? SEQ_EXTRA_DEFAULTS.prob);
  if (prob !== SEQ_EXTRA_DEFAULTS.prob) out.prob = prob;
  const ratchet = s.ratchet ?? SEQ_EXTRA_DEFAULTS.ratchet;
  if (ratchet !== SEQ_EXTRA_DEFAULTS.ratchet) out.ratchet = ratchet;
  const tie = s.tie ?? SEQ_EXTRA_DEFAULTS.tie;
  if (tie !== SEQ_EXTRA_DEFAULTS.tie) out.tie = tie;
  return out;
}

/**
 * Drum/sampler cell → sparse object. `restore` spreads the full
 * `TRIGGER_CELL_DEFAULTS`, so keep `on` and drop every other default field —
 * a dead cell becomes `{ on: false }`.
 */
function compactTriggerCell(c: TriggerCell): Record<string, unknown> {
  const out: Record<string, unknown> = { on: c.on };
  const velocity = roundNum(c.velocity ?? TRIGGER_CELL_DEFAULTS.velocity);
  if (velocity !== TRIGGER_CELL_DEFAULTS.velocity) out.velocity = velocity;
  const gate = roundNum(c.gate ?? TRIGGER_CELL_DEFAULTS.gate);
  if (gate !== TRIGGER_CELL_DEFAULTS.gate) out.gate = gate;
  const prob = roundNum(c.prob ?? TRIGGER_CELL_DEFAULTS.prob);
  if (prob !== TRIGGER_CELL_DEFAULTS.prob) out.prob = prob;
  const ratchet = c.ratchet ?? TRIGGER_CELL_DEFAULTS.ratchet;
  if (ratchet !== TRIGGER_CELL_DEFAULTS.ratchet) out.ratchet = ratchet;
  const tie = c.tie ?? TRIGGER_CELL_DEFAULTS.tie;
  if (tie !== TRIGGER_CELL_DEFAULTS.tie) out.tie = tie;
  return out;
}

/** Chain lane — bank indices are integers; just clone (no rounding needed). */
function cloneChain(c: ChainData): ChainData {
  return { enabled: c.enabled, steps: [...c.steps] };
}

/**
 * The canonical compact form of a song, ready for `JSON.stringify`. Rounds
 * params, sparsifies every bank cell, and preserves the optional v2 fields'
 * presence (so a v1 file does not grow sampler keys).
 */
export function compactSongForExport(file: SongFile): Record<string, unknown> {
  const out: Record<string, unknown> = {
    format: file.format,
    version: file.version,
    name: file.name,
    params: roundParams(file.params),
    seqBanks: file.seqBanks.map((bank) => bank.map(compactSeqStep)),
    drumBanks: file.drumBanks.map((bank) => bank.map((row) => row.map(compactTriggerCell))),
    seqChain: cloneChain(file.seqChain),
    drumChain: cloneChain(file.drumChain),
  };
  if (file.samplerBanks !== undefined) {
    out.samplerBanks = file.samplerBanks.map((bank) => bank.map((row) => row.map(compactTriggerCell)));
  }
  if (file.samplerChain !== undefined) out.samplerChain = cloneChain(file.samplerChain);
  if (file.sampleNames !== undefined) out.sampleNames = [...file.sampleNames];
  return out;
}

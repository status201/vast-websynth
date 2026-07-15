/**
 * Structural validation for imported `.websynth.json` song files.
 *
 * Hand-rolled and dependency-free (ADR-003 — no runtime deps). It mirrors the
 * *additive* loader contract (ADR-007): strict on types / structure / ranges /
 * dimensions, but lenient on the optional per-step fields, so legacy v1 files
 * that `PatternStore.restore` happily defaults still pass here. Errors are
 * collected with a path prefix (e.g. `drumBanks[1][3][7].ratchet`) so the import
 * UI can tell the user *what* is wrong instead of a single generic message.
 *
 * The published JSON Schema at `public/schema/websynth-song.schema.json`
 * (served at `/schema/websynth-song.schema.json`) is the machine-readable mirror
 * of these same rules. This validator is the runtime source of truth; the schema
 * is documentation/tooling. Both are pinned to reality by the demo-conformance
 * tests (every demo must pass `validateSongFile`).
 */
import type { SongFile } from './song';
import { BANK_COUNT, REST, SEQ_LENGTH, DRUM_TRACK_COUNT, SAMPLER_SLOT_COUNT } from './patterns';

export type SongValidation =
  | { ok: true; file: SongFile }
  | { ok: false; errors: string[] };

/** Cap reported errors so a wildly-malformed file can't produce thousands of lines. */
const MAX_ERRORS = 50;

type AddError = (msg: string) => void;
type CellValidator = (path: string, value: unknown, add: AddError) => void;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A short, human-readable description of an unexpected value for error messages. */
function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  const t = typeof v;
  if (t === 'string') return `"${v as string}"`;
  if (t === 'number' || t === 'boolean') return String(v);
  return t; // 'object', 'undefined', 'function', …
}

/** Optional number in [0,1] — absent is fine (loader defaults it), present is checked. */
function checkUnit(path: string, v: unknown, add: AddError): void {
  if (v === undefined) return;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
    add(`${path} must be a number 0..1 (got ${describe(v)})`);
  }
}

function checkRatchet(path: string, v: unknown, add: AddError): void {
  if (v === undefined) return;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 4) {
    add(`${path} must be an integer 1..4 (got ${describe(v)})`);
  }
}

function checkBool(path: string, v: unknown, add: AddError, optional: boolean): void {
  if (v === undefined && optional) return;
  if (typeof v !== 'boolean') add(`${path} must be a boolean (got ${describe(v)})`);
}

/** Shared per-step settings — all optional on disk (additive versioning). */
function checkStepSettings(path: string, c: Record<string, unknown>, add: AddError): void {
  checkUnit(`${path}.velocity`, c.velocity, add);
  checkUnit(`${path}.gate`, c.gate, add);
  checkUnit(`${path}.prob`, c.prob, add);
  checkRatchet(`${path}.ratchet`, c.ratchet, add);
  checkBool(`${path}.tie`, c.tie, add, true);
}

const validateSeqStep: CellValidator = (path, value, add) => {
  if (!isObject(value)) { add(`${path} must be an object (got ${describe(value)})`); return; }
  checkBool(`${path}.on`, value.on, add, false);
  if (typeof value.note !== 'number' || !Number.isFinite(value.note)) {
    add(`${path}.note must be a finite number/MIDI note (got ${describe(value.note)})`);
  }
  checkStepSettings(path, value, add);
};

const validateTriggerCell: CellValidator = (path, value, add) => {
  if (!isObject(value)) { add(`${path} must be an object (got ${describe(value)})`); return; }
  checkBool(`${path}.on`, value.on, add, false);
  checkStepSettings(path, value, add);
};

/** 2-D bank grid: `banks × steps` of cells (the sequencer). */
function check2D(path: string, v: unknown, steps: number, cell: CellValidator, add: AddError): void {
  if (!Array.isArray(v)) { add(`${path} must be an array of ${BANK_COUNT} banks (got ${describe(v)})`); return; }
  if (v.length !== BANK_COUNT) add(`${path} must have ${BANK_COUNT} banks (got ${v.length})`);
  v.forEach((bank: unknown, b) => {
    if (!Array.isArray(bank)) { add(`${path}[${b}] must be an array of ${steps} steps (got ${describe(bank)})`); return; }
    if (bank.length !== steps) add(`${path}[${b}] must have ${steps} steps (got ${bank.length})`);
    bank.forEach((c: unknown, s) => cell(`${path}[${b}][${s}]`, c, add));
  });
}

/** 3-D bank grid: `banks × rows × steps` of cells (drum + sampler). */
function check3D(path: string, v: unknown, rows: number, steps: number, cell: CellValidator, add: AddError): void {
  if (!Array.isArray(v)) { add(`${path} must be an array of ${BANK_COUNT} banks (got ${describe(v)})`); return; }
  if (v.length !== BANK_COUNT) add(`${path} must have ${BANK_COUNT} banks (got ${v.length})`);
  v.forEach((bank: unknown, b) => {
    if (!Array.isArray(bank)) { add(`${path}[${b}] must be an array of ${rows} rows (got ${describe(bank)})`); return; }
    if (bank.length !== rows) add(`${path}[${b}] must have ${rows} rows (got ${bank.length})`);
    bank.forEach((row: unknown, t) => {
      if (!Array.isArray(row)) { add(`${path}[${b}][${t}] must be an array of ${steps} steps (got ${describe(row)})`); return; }
      if (row.length !== steps) add(`${path}[${b}][${t}] must have ${steps} steps (got ${row.length})`);
      row.forEach((c: unknown, s) => cell(`${path}[${b}][${t}][${s}]`, c, add));
    });
  });
}

function checkParams(v: unknown, add: AddError): void {
  if (!isObject(v)) { add(`params must be an object of name -> number (got ${describe(v)})`); return; }
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      add(`params.${k} must be a finite number (got ${describe(val)})`);
    }
  }
}

function checkChain(path: string, v: unknown, optional: boolean, add: AddError): void {
  if (v === undefined) { if (!optional) add(`${path} is required`); return; }
  if (!isObject(v)) { add(`${path} must be an object (got ${describe(v)})`); return; }
  checkBool(`${path}.enabled`, v.enabled, add, false);
  const steps = v.steps;
  if (!Array.isArray(steps)) { add(`${path}.steps must be an array (got ${describe(steps)})`); return; }
  if (steps.length < 1) add(`${path}.steps must have at least 1 entry`);
  steps.forEach((s: unknown, i) => {
    // A step is a bank index 0..BANK_COUNT-1 or the REST sentinel (an empty bar).
    const ok = typeof s === 'number' && Number.isInteger(s) && (s === REST || (s >= 0 && s <= BANK_COUNT - 1));
    if (!ok) {
      add(`${path}.steps[${i}] must be an integer 0..${BANK_COUNT - 1} or ${REST} (rest) (got ${describe(s)})`);
    }
  });
}

function checkSampleNames(v: unknown, add: AddError): void {
  if (!Array.isArray(v)) { add(`sampleNames must be an array of ${SAMPLER_SLOT_COUNT} entries (got ${describe(v)})`); return; }
  if (v.length !== SAMPLER_SLOT_COUNT) add(`sampleNames must have ${SAMPLER_SLOT_COUNT} entries (got ${v.length})`);
  v.forEach((n: unknown, i) => {
    if (n !== null && typeof n !== 'string') add(`sampleNames[${i}] must be a string or null (got ${describe(n)})`);
  });
}

/** v3 XY Pad axis assignment — each axis is a non-empty ParamBus id string. */
function checkXy(v: unknown, add: AddError): void {
  if (!isObject(v)) { add(`xy must be an object (got ${describe(v)})`); return; }
  for (const axis of ['x', 'y'] as const) {
    const id = v[axis];
    if (typeof id !== 'string' || id.length === 0) {
      add(`xy.${axis} must be a non-empty string (got ${describe(id)})`);
    }
  }
}

/** v4 motion step — an optional XY anchor; x/y checked only when present. */
const validateMotionStep: CellValidator = (path, value, add) => {
  if (!isObject(value)) { add(`${path} must be an object (got ${describe(value)})`); return; }
  checkBool(`${path}.on`, value.on, add, false);
  checkUnit(`${path}.x`, value.x, add);
  checkUnit(`${path}.y`, value.y, add);
};

/** v4 per-bank axis overrides — BANK_COUNT entries, each null or {x?, y?} of ids. */
function checkMotionAssigns(v: unknown, add: AddError): void {
  if (!Array.isArray(v)) { add(`motionAssigns must be an array of ${BANK_COUNT} entries (got ${describe(v)})`); return; }
  if (v.length !== BANK_COUNT) add(`motionAssigns must have ${BANK_COUNT} entries (got ${v.length})`);
  v.forEach((a: unknown, i) => {
    if (a === null) return;
    if (!isObject(a)) { add(`motionAssigns[${i}] must be null or an object (got ${describe(a)})`); return; }
    for (const axis of ['x', 'y'] as const) {
      const id = a[axis];
      if (id !== undefined && (typeof id !== 'string' || id.length === 0)) {
        add(`motionAssigns[${i}].${axis} must be a non-empty string (got ${describe(id)})`);
      }
    }
  });
}

/**
 * Validate a parsed value as a `SongFile`. Returns the (unchanged) value typed
 * as `SongFile` on success, or the list of human-readable errors on failure.
 */
export function validateSongFile(value: unknown): SongValidation {
  if (!isObject(value)) return { ok: false, errors: ['Song must be a JSON object.'] };

  const errors: string[] = [];
  const add: AddError = (msg) => { if (errors.length < MAX_ERRORS) errors.push(msg); };
  const o = value;

  if (o.format !== 'websynth-song') add(`format must be "websynth-song" (got ${describe(o.format)})`);
  if (o.version !== 1 && o.version !== 2 && o.version !== 3 && o.version !== 4) add(`version must be 1, 2, 3, or 4 (got ${describe(o.version)})`);
  if (typeof o.name !== 'string') add(`name must be a string (got ${describe(o.name)})`);

  checkParams(o.params, add);
  check2D('seqBanks', o.seqBanks, SEQ_LENGTH, validateSeqStep, add);
  check3D('drumBanks', o.drumBanks, DRUM_TRACK_COUNT, SEQ_LENGTH, validateTriggerCell, add);
  checkChain('seqChain', o.seqChain, false, add);
  checkChain('drumChain', o.drumChain, false, add);

  // v2 (optional) — only validated when present, so v1 files still pass.
  if (o.samplerBanks !== undefined) check3D('samplerBanks', o.samplerBanks, SAMPLER_SLOT_COUNT, SEQ_LENGTH, validateTriggerCell, add);
  if (o.samplerChain !== undefined) checkChain('samplerChain', o.samplerChain, true, add);
  if (o.sampleNames !== undefined) checkSampleNames(o.sampleNames, add);

  // v3 (optional) — XY Pad axis assignment; only validated when present.
  if (o.xy !== undefined) checkXy(o.xy, add);

  // v4 (optional) — motion sequencer; only validated when present.
  if (o.motionBanks !== undefined) check2D('motionBanks', o.motionBanks, SEQ_LENGTH, validateMotionStep, add);
  if (o.motionAssigns !== undefined) checkMotionAssigns(o.motionAssigns, add);
  if (o.motionChain !== undefined) checkChain('motionChain', o.motionChain, true, add);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, file: value as unknown as SongFile };
}

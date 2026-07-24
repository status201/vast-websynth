import { roundParams } from './serialize';
import type { Snapshot } from './preset';
import { PRESET_FORMAT, BANK_FORMAT, validatePresetPayload } from './preset-validate';
import type { PresetFile, PresetBankFile, PresetParse } from './preset-validate';

/**
 * Preset / bank **files** — `specs/features/presets.md` REQ-7..REQ-11.
 *
 * Deliberately pure: no `localStorage`, no DOM, no `ParamBus`. The whole import
 * decision is `planImport(incoming, existing, policy)`, a function of its
 * arguments alone, so the wizard's counts are unit-testable without a Storage
 * mock and the modal is left with nothing but rendering.
 *
 * The *format* itself (tags, file shapes, validation) lives one module down in
 * `preset-validate.ts`, which the authoring tools also need with a `ParamBus` in
 * hand — see `specs/features/preset-authoring.md`. It is re-exported here so
 * this module stays the one door for preset files.
 *
 * Vintage naming (REQ-7): a **preset** is one sound, a **bank** is a collection.
 * That is Roland (PATCH/BANK) and Yamaha (VOICE/32-VOICE BANK) usage; "patch"
 * is never used here for a collection.
 */

export { PRESET_FORMAT, BANK_FORMAT, validatePresetPayload } from './preset-validate';
export type { PresetFile, PresetBankFile, PresetParse } from './preset-validate';

export type ImportPolicy = 'rename' | 'overwrite' | 'skip';
export type ImportStatus = 'new' | 'identical' | 'conflict';

export interface ImportWrite {
  /** Name in the file. */
  source: string;
  /** Name it will be stored under (differs from `source` only when renamed). */
  target: string;
  status: ImportStatus;
}

export interface ImportPlan {
  /** Every incoming preset, in file order — the review list (REQ-10). */
  rows: ImportWrite[];
  /** The subset confirm will actually write. */
  writes: ImportWrite[];
  counts: { new: number; identical: number; conflict: number; writes: number };
}

/** Rounded-value equality — the same 4-sig-fig boundary `save()` writes at, so
 *  a stored preset and its re-imported file compare equal (REQ-8). */
export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  const ra = roundParams(a);
  const rb = roundParams(b);
  const ka = Object.keys(ra);
  if (ka.length !== Object.keys(rb).length) return false;
  return ka.every((k) => ra[k] === rb[k]);
}

export function buildPresetFile(name: string, snap: Snapshot): PresetFile {
  return { format: PRESET_FORMAT, version: 1, name, params: roundParams(snap) };
}

export function buildBankFile(name: string, entries: Record<string, Snapshot>): PresetBankFile {
  const presets: Record<string, Snapshot> = {};
  for (const [n, snap] of Object.entries(entries)) presets[n] = roundParams(snap);
  return { format: BANK_FORMAT, version: 1, name, presets };
}

/** `Song.download`'s sanitize idiom, so all three file families name alike. */
const safe = (name: string, fallback: string): string =>
  name.replace(/[^a-z0-9_-]+/gi, '_') || fallback;

export function presetFilename(name: string): string {
  return `${safe(name, 'preset')}.preset.websynth.json`;
}

export function bankFilename(name: string): string {
  return `${safe(name, 'bank')}.bank.websynth.json`;
}

/**
 * Parse a preset or bank **file**: JSON-decode, then validate. No `ParamBus` is
 * passed, so this is the *structural* layer only — a file written by a newer
 * build may carry ids this one has never seen, and `restore` ignores them
 * (see preset-validate.ts).
 */
export function parsePresetPayload(text: string): PresetParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: ['File is not valid JSON: ' + (e as Error).message] };
  }
  return validatePresetPayload(parsed);
}

/** Is this payload a preset/bank file? Used by the *song* importer to hand the
 *  user a pointer instead of a generic parse failure (REQ-11). */
export function describePresetPayload(text: string): 'preset' | 'bank' | null {
  try {
    const f = (JSON.parse(text) as { format?: unknown })?.format;
    if (f === PRESET_FORMAT) return 'preset';
    if (f === BANK_FORMAT) return 'bank';
  } catch { /* not JSON — not our problem */ }
  return null;
}

/** First free `name 2`, `name 3`, … avoiding both stored and already-planned names. */
function freeName(base: string, taken: Set<string>): string {
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Decide what an import would do, without doing any of it (REQ-10). `existing`
 * is the current store contents; a name absent from it is `new`, a name present
 * with the same rounded values is `identical` (a no-op under every policy —
 * re-importing your own export must not spawn "lead 2"), anything else is a
 * `conflict` resolved by `policy`.
 */
export function planImport(
  incoming: Record<string, Snapshot>,
  existing: Record<string, Snapshot>,
  policy: ImportPolicy,
): ImportPlan {
  const taken = new Set(Object.keys(existing));
  const rows: ImportWrite[] = [];

  for (const [source, snap] of Object.entries(incoming)) {
    const current = existing[source];
    if (current === undefined) {
      rows.push({ source, target: source, status: 'new' });
      taken.add(source);
      continue;
    }
    if (sameSnapshot(current, snap)) {
      rows.push({ source, target: source, status: 'identical' });
      continue;
    }
    const target = policy === 'rename' ? freeName(source, taken) : source;
    if (policy === 'rename') taken.add(target);
    rows.push({ source, target, status: 'conflict' });
  }

  const writes = rows.filter((r) =>
    r.status === 'new' || (r.status === 'conflict' && policy !== 'skip'));

  return {
    rows,
    writes,
    counts: {
      new: rows.filter((r) => r.status === 'new').length,
      identical: rows.filter((r) => r.status === 'identical').length,
      conflict: rows.filter((r) => r.status === 'conflict').length,
      writes: writes.length,
    },
  };
}

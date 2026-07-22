import { roundParams } from './serialize';
import type { Snapshot } from './preset';

/**
 * Preset / bank **files** — `specs/features/presets.md` REQ-7..REQ-11.
 *
 * Deliberately pure: no `localStorage`, no DOM, no `ParamBus`. The whole import
 * decision is `planImport(incoming, existing, policy)`, a function of its
 * arguments alone, so the wizard's counts are unit-testable without a Storage
 * mock and the modal is left with nothing but rendering.
 *
 * Vintage naming (REQ-7): a **preset** is one sound, a **bank** is a collection.
 * That is Roland (PATCH/BANK) and Yamaha (VOICE/32-VOICE BANK) usage; "patch"
 * is never used here for a collection.
 */

export const PRESET_FORMAT = 'websynth-preset';
export const BANK_FORMAT = 'websynth-preset-bank';

export interface PresetFile {
  format: typeof PRESET_FORMAT;
  version: 1;
  name: string;
  params: Snapshot;
}

export interface PresetBankFile {
  format: typeof BANK_FORMAT;
  version: 1;
  name: string;
  presets: Record<string, Snapshot>;
}

/** A parsed payload, collapsed to one shape: a preset is a one-entry bank. */
export type PresetParse =
  | { ok: true; kind: 'preset' | 'bank'; name: string; presets: Record<string, Snapshot> }
  | { ok: false; errors: string[] };

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

const isSnapshot = (v: unknown): v is Snapshot =>
  !!v && typeof v === 'object' && !Array.isArray(v) &&
  Object.values(v as Record<string, unknown>).every((n) => typeof n === 'number' && Number.isFinite(n));

/**
 * Parse a preset or bank payload. Errors say what was *expected* rather than
 * "invalid" (REQ-11) — these files share the `.websynth.json` tail with songs,
 * so a wrong-door mistake is the likely cause and the message should say so.
 */
export function parsePresetPayload(text: string): PresetParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: ['File is not valid JSON: ' + (e as Error).message] };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, errors: ['File is not a preset or bank (expected a JSON object).'] };
  }
  const obj = parsed as Record<string, unknown>;
  const format = obj['format'];

  if (format === PRESET_FORMAT) {
    const name = typeof obj['name'] === 'string' && obj['name'] ? obj['name'] : 'preset';
    if (!isSnapshot(obj['params'])) {
      return { ok: false, errors: ['Preset file has no valid `params` map of numbers.'] };
    }
    return { ok: true, kind: 'preset', name, presets: { [name]: obj['params'] } };
  }

  if (format === BANK_FORMAT) {
    const name = typeof obj['name'] === 'string' && obj['name'] ? obj['name'] : 'bank';
    const raw = obj['presets'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, errors: ['Bank file has no `presets` map.'] };
    }
    const presets: Record<string, Snapshot> = {};
    for (const [n, snap] of Object.entries(raw as Record<string, unknown>)) {
      if (!isSnapshot(snap)) return { ok: false, errors: [`Preset "${n}" is not a map of numbers.`] };
      presets[n] = snap;
    }
    if (Object.keys(presets).length === 0) {
      return { ok: false, errors: ['Bank file contains no presets.'] };
    }
    return { ok: true, kind: 'bank', name, presets };
  }

  // The most common wrong-door case gets its own sentence.
  if (format === 'websynth-song') {
    return { ok: false, errors: ['That is a song file — load it from the Song tab’s Import instead.'] };
  }
  return {
    ok: false,
    errors: [`Not a preset or bank file (expected "format": "${PRESET_FORMAT}" or "${BANK_FORMAT}").`],
  };
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

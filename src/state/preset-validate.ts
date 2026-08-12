import type { ParamBus } from './params';
import type { Snapshot } from './preset';
import { isPatchParam } from './preset-session';
import { MAX_ERRORS, isObject, describeValue, type AddError } from './validate-utils';

/**
 * The preset/bank **file format** and its validator —
 * `specs/features/preset-authoring.md`. Sibling of `song-validate.ts`, and pure
 * for the same reasons: no `localStorage`, no DOM, so the MCP server's Node
 * bundle can serve it (mcp-server.md REQ-4) and every rule is unit-testable.
 *
 * Two layers, and the difference matters:
 *
 * - **Structural** (no `bus`) — shape only, which is all the *app's* file import
 *   may demand. An id this build has never heard of might simply come from a
 *   newer version, and `ParamBus.restore` ignores it; rejecting the file would
 *   break forward compatibility for no gain.
 * - **Semantic** (with a `bus`) — additionally checks ids against the live
 *   registry and values against each `ParamDef`'s range. This is the *authoring*
 *   contract: an agent writing a sound wants "osc1.shape is not a parameter"
 *   now, not a silently-clamped patch later.
 *
 * `parsePresetPayload` (preset-file.ts) passes no bus; the MCP tools do.
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
  | {
      ok: true;
      kind: 'preset' | 'bank';
      name: string;
      presets: Record<string, Snapshot>;
      /** Non-fatal authoring notes (semantic layer only). */
      warnings?: string[];
    }
  | { ok: false; errors: string[] };

/**
 * One `{id: number}` map. Returns the snapshot, or null when the value is not
 * even a map. `bus` turns on the semantic layer.
 */
function checkSnapshot(
  path: string,
  raw: unknown,
  bus: ParamBus | undefined,
  add: AddError,
  warn: AddError,
): Snapshot | null {
  if (!isObject(raw)) {
    add(`${path} must be a map of parameter id -> number (got ${describeValue(raw)}).`);
    return null;
  }
  const snap: Snapshot = {};
  for (const [id, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      add(`${path}."${id}" must be a finite number (got ${describeValue(value)}).`);
      continue;
    }
    snap[id] = value;
    if (!bus) continue;

    const def = bus.def(id);
    if (!def) {
      add(`${path}."${id}" is not a parameter of this synth.`);
      continue;
    }
    if (value < def.min || value > def.max) {
      add(`${path}."${id}" must be ${def.min}..${def.max} (got ${value}).`);
    } else if (def.labels && def.labels.length > 0 && !Number.isInteger(value)) {
      // A choice parameter's value IS the index into its label list; a fraction
      // lands between two settings and behaves like neither.
      const map = def.labels.map((l, i) => `${i}=${l}`).join(' ');
      add(`${path}."${id}" is a choice parameter — use an integer index (${map}).`);
    }
    if (!isPatchParam(id)) {
      // Legal (a snapshot captures the whole bus) but rarely intended: loading
      // the preset would also move the tempo / a machine's state.
      warn(`${path}."${id}" is a song setting, not part of a sound — loading this preset would change it.`);
    }
  }
  return snap;
}

/**
 * Validate a parsed preset or bank payload. Errors say what was *expected*
 * rather than "invalid" (presets.md REQ-11) — these files share the
 * `.websynth.json` tail with songs, so a wrong-door mistake is the likely cause
 * and the message should say so.
 */
export function validatePresetPayload(value: unknown, bus?: ParamBus): PresetParse {
  if (!isObject(value)) {
    return { ok: false, errors: ['File is not a preset or bank (expected a JSON object).'] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const add: AddError = (msg) => { if (errors.length < MAX_ERRORS) errors.push(msg); };
  const warn: AddError = (msg) => { if (warnings.length < MAX_ERRORS) warnings.push(msg); };

  const format = value['format'];

  if (format === PRESET_FORMAT) {
    const name = typeof value['name'] === 'string' && value['name'] ? value['name'] : 'preset';
    const snap = checkSnapshot('params', value['params'], bus, add, warn);
    if (!snap) {
      // Keep the pre-existing one-liner for the "no params at all" case; the
      // per-key paths above cover everything more specific.
      return { ok: false, errors: ['Preset file has no valid `params` map of numbers.'] };
    }
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, kind: 'preset', name, presets: { [name]: snap }, ...(warnings.length ? { warnings } : {}) };
  }

  if (format === BANK_FORMAT) {
    const name = typeof value['name'] === 'string' && value['name'] ? value['name'] : 'bank';
    const raw = value['presets'];
    if (!isObject(raw)) return { ok: false, errors: ['Bank file has no `presets` map.'] };
    const presets: Record<string, Snapshot> = {};
    for (const [n, snap] of Object.entries(raw)) {
      const checked = checkSnapshot(`presets["${n}"]`, snap, bus, add, warn);
      if (checked) presets[n] = checked;
      else if (errors.length >= MAX_ERRORS) break;
    }
    if (Object.keys(presets).length === 0 && errors.length === 0) {
      return { ok: false, errors: ['Bank file contains no presets.'] };
    }
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, kind: 'bank', name, presets, ...(warnings.length ? { warnings } : {}) };
  }

  // The most common wrong-door case gets its own sentence.
  if (format === 'websynth-song' || format === 'websynth-song-author') {
    return { ok: false, errors: ['That is a song file — load it from the Song tab’s Import instead.'] };
  }
  return {
    ok: false,
    errors: [`Not a preset or bank file (expected "format": "${PRESET_FORMAT}" or "${BANK_FORMAT}").`],
  };
}

/**
 * Every **patch** parameter at its registered default — the blank canvas a
 * sound is authored over. Deliberately not the whole bus: filling in
 * `transport.bpm` or `seq.on` would make loading a preset silently rewrite the
 * song around it (see `isPatchParam`).
 */
export function defaultPatchParams(bus: ParamBus): Snapshot {
  const out: Snapshot = {};
  for (const id of bus.ids()) {
    if (!isPatchParam(id)) continue;
    const def = bus.def(id);
    if (def) out[id] = def.default;
  }
  return out;
}

/**
 * A sparse authored sound → the **complete** patch it means. Without this, a
 * 10-line authored preset would leave every unmentioned parameter at whatever
 * the previously loaded patch left behind — the same non-determinism the
 * factory presets avoid by always setting the full sound (presets.md REQ-2b).
 */
export function expandPresetParams(bus: ParamBus, params: Snapshot): Snapshot {
  return { ...defaultPatchParams(bus), ...params };
}

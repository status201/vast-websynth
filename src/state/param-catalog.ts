/**
 * The **structured** parameter catalogue — `paramTable()`'s machine-readable
 * twin. Both walk the live `ParamBus`, so neither can drift from
 * `registerDefaults()`; this one keeps the fields the prose table drops
 * (`taper`, `curve`, `unit`) and adds the sound-vs-song `patch` flag, so an
 * agent gets ranges it can compute against instead of comment text it must
 * parse. See specs/features/param-catalogue.md.
 *
 * Published by `scripts/gen-params.ts` as `public/params.json` and served over
 * MCP by `get_params`.
 *
 * Pure and import-free beyond `params.ts` + `preset-session.ts` +
 * `song-version.ts`: the MCP server bundles this module for Node, and importing
 * `song.ts` would drag its `import.meta.glob` demo registration along
 * (mcp-server.md REQ-4).
 */
import type { ParamBus, ParamId, Taper } from './params';
import { isPatchParam } from './preset-session';
import { SONG_VERSION } from './song-version';

/** The `format` tag of `public/params.json`. */
export const PARAMS_FORMAT = 'websynth-params';

/** The catalogue file's own format version — independent of the app's. */
export const PARAMS_VERSION = 1;

/**
 * One registered parameter. Mirrors `ParamDef` minus `format` (a render
 * function, not data); every optional field is **omitted** when unset rather
 * than emitted as `null`, so the JSON stays readable.
 */
export interface ParamCatalogEntry {
  id: ParamId;
  min: number;
  max: number;
  default: number;
  /** True = part of a SOUND (a preset); false = song-level (transport, machines). */
  patch: boolean;
  step?: number;
  taper?: Taper;
  curve?: number;
  unit?: string;
  /** Discrete value map — the stored value is the **index** into this list. */
  labels?: string[];
}

export interface ParamCatalog {
  format: typeof PARAMS_FORMAT;
  version: number;
  /** Which canonical song format this build writes — see `song-version.ts`. */
  songVersion: number;
  /** `params.length`, so a fetched file can sanity-check itself. */
  count: number;
  params: ParamCatalogEntry[];
}

/**
 * Snapshot the registry. Entries follow `bus.ids()` — registration order, which
 * groups them by section the way the synth is laid out.
 *
 * No app version is stamped: a release bump must not be able to redden
 * `npm run check:params`, and a version literal in a model-visible file drifts
 * silently (mcp-server.md REQ-5).
 */
export function buildParamCatalog(bus: ParamBus): ParamCatalog {
  const params: ParamCatalogEntry[] = [];
  for (const id of bus.ids()) {
    const d = bus.def(id);
    if (!d) continue; // ids() is keyed off defs, so unreachable — but the type is optional
    const entry: ParamCatalogEntry = {
      id,
      min: d.min,
      max: d.max,
      default: d.default,
      patch: isPatchParam(id),
    };
    if (d.step !== undefined) entry.step = d.step;
    if (d.taper !== undefined) entry.taper = d.taper;
    if (d.curve !== undefined) entry.curve = d.curve;
    if (d.unit !== undefined) entry.unit = d.unit;
    if (d.labels && d.labels.length) entry.labels = [...d.labels];
    params.push(entry);
  }
  return {
    format: PARAMS_FORMAT,
    version: PARAMS_VERSION,
    songVersion: SONG_VERSION,
    count: params.length,
    params,
  };
}

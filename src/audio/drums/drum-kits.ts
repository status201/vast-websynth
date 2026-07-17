/**
 * Factory drum kits + randomize. A "kit" is just a named table of per-track
 * scalar param values applied through the ParamBus — no new audio code, no new
 * persistence: it reuses `bus.set`, and every param it touches is already
 * captured by presets/songs. See `specs/features/drum-kits.md`.
 *
 * Track order matches DRUM_TRACKS: Kick, Snare, C.Hat, O.Hat, L/M/H Tom, Clap.
 */
import type { ParamBus } from '../../state/params';
import { DRUM_TRACK_COUNT } from '../../state/patterns';

/** The per-track scalar params a kit addresses (model swaps the voice — REQ-6). */
export const KIT_PARAMS = ['tune', 'decay', 'tone', 'drive', 'pan', 'vol', 'model'] as const;
export type KitParam = (typeof KIT_PARAMS)[number];
/** The subset randomize shuffles — timbre only, never the voice models. */
export const RANDOM_PARAMS = ['tune', 'decay', 'tone', 'drive', 'pan', 'vol'] as const;
type RandomParam = (typeof RANDOM_PARAMS)[number];

/**
 * Sparse per-track override table. Each array is indexed by track
 * (0..DRUM_TRACK_COUNT-1); any param omitted falls back to the registered
 * default in {@link applyKit}, so switching kits fully overwrites the previous.
 */
export type KitDef = Partial<Record<KitParam, number[]>>;

export const DRUM_KITS: Record<string, KitDef> = {
  // Default reproduces the registered defaults exactly (a no-op safety net).
  Default: {},
  '808': {
    tune: [-5, -2, 0, 0, -3, -1, 1, 0],
    decay: [0.9, 0.25, 0.04, 0.4, 0.4, 0.35, 0.3, 0.3],
    tone: [0.8, 0.9, 1, 1, 0.8, 0.85, 0.9, 0.9],
    drive: [0.1, 0.05, 0, 0, 0.05, 0.05, 0.05, 0.05],
    pan: [0, 0, -0.2, 0.2, -0.3, 0, 0.3, 0.15],
  },
  '909': {
    tune: [2, 1, 2, 1, 0, 1, 2, 1],
    decay: [0.35, 0.18, 0.03, 0.28, 0.25, 0.22, 0.2, 0.22],
    drive: [0.25, 0.2, 0.1, 0.1, 0.15, 0.15, 0.15, 0.2],
    pan: [0, 0, -0.15, 0.25, -0.3, 0, 0.3, -0.1],
  },
  LoFi: {
    tune: [-3, -4, -5, -3, -2, -1, 0, -3],
    decay: [0.45, 0.16, 0.04, 0.25, 0.3, 0.28, 0.26, 0.22],
    tone: [0.45, 0.4, 0.5, 0.5, 0.45, 0.45, 0.5, 0.45],
    drive: [0.5, 0.45, 0.3, 0.3, 0.4, 0.4, 0.4, 0.45],
    pan: [0, 0, -0.1, 0.1, -0.2, 0, 0.2, 0.1],
  },
  Acoustic: {
    tune: [-2, 0, 1, 0, -4, -1, 2, 0],
    decay: [0.5, 0.3, 0.05, 0.45, 0.5, 0.45, 0.4, 0.35],
    drive: [0, 0, 0, 0, 0, 0, 0, 0],
    pan: [0, -0.1, 0.3, 0.35, -0.4, -0.1, 0.4, 0.2],
  },
  Techno: {
    tune: [-2, 0, 3, 1, -1, 0, 2, 1],
    decay: [0.5, 0.2, 0.03, 0.2, 0.25, 0.22, 0.2, 0.2],
    tone: [0.85, 0.95, 1, 1, 0.9, 0.9, 0.95, 0.95],
    drive: [0.4, 0.3, 0.2, 0.25, 0.35, 0.35, 0.35, 0.3],
    pan: [0, 0, -0.25, 0.25, -0.3, 0, 0.3, -0.15],
  },
  // A percussion section over the same 8 slots (drum-kits.md REQ-6): kick stays
  // for a foundation; the rest become cowbell / shakers / congas / bongo / clave.
  // Models: 8=Conga 9=Bongo 10=Cowbell 11=Clave 12=Shaker (DRUM_MODEL_LABELS).
  Percussion: {
    model: [0, 10, 12, 12, 8, 8, 9, 11],
    //     kick cowbl shkr shkr conga conga bongo clave
    tune: [0, 0, 0, -3, -5, 0, 2, 0],       // low/high conga pair; darker 2nd shaker
    decay: [0.4, 0.2, 0.06, 0.14, 0.24, 0.2, 0.09, 0.06],
    pan: [0, 0.25, -0.35, 0.35, -0.25, 0.2, 0.45, -0.15],
    vol: [0.85, 0.7, 0.75, 0.7, 0.9, 0.9, 0.85, 0.8],
  },
};

/** Apply a named kit: every per-track param gets the kit value or its default. */
export function applyKit(bus: ParamBus, name: string): void {
  const kit = DRUM_KITS[name];
  if (!kit) return;
  for (let i = 0; i < DRUM_TRACK_COUNT; i++) {
    for (const p of KIT_PARAMS) {
      const id = `drum.t${i}.${p}`;
      const arr = kit[p];
      const v = arr && arr[i] !== undefined ? arr[i]! : (bus.def(id)?.default ?? 0);
      bus.set(id, v);
    }
  }
}

/** Musical sub-ranges for randomize — narrower than each param's full range. */
const RANDOM_RANGES: Record<RandomParam, (r: number) => number> = {
  tune: (r) => Math.round((r * 2 - 1) * 7), // ±7 semitones
  decay: (r) => 0.1 + r * 0.5, // 0.1..0.6 s
  tone: (r) => 0.4 + r * 0.6, // 0.4..1
  drive: (r) => r * 0.4, // 0..0.4
  pan: (r) => (r * 2 - 1) * 0.6, // ±0.6
  vol: (r) => 0.7 + r * 0.3, // 0.7..1
};

/**
 * Pure: roll a fresh kit's worth of param values from the musical sub-ranges.
 * `rand` is injectable so tests are deterministic.
 */
export function randomKitValues(rand: () => number = Math.random): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < DRUM_TRACK_COUNT; i++) {
    for (const p of RANDOM_PARAMS) out[`drum.t${i}.${p}`] = RANDOM_RANGES[p](rand());
  }
  return out;
}

/** Apply a randomized kit to the bus (clamped per-param by `bus.set`). */
export function randomizeKit(bus: ParamBus, rand: () => number = Math.random): void {
  for (const [id, v] of Object.entries(randomKitValues(rand))) bus.set(id, v);
}

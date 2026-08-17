import { DRUM_TRACK_COUNT, DRUM_TRACKS, SEQ_TRACK_COUNT, MOTION_TRACK_COUNT } from './patterns';
import {
  GRID_CELLS, LEN_FOLLOW, LANE_RATE_LABELS, DEFAULT_LANE_RATE,
  BEAT_UNIT_LABELS, MIN_BEATS, MAX_BEATS, DEFAULT_BEATS, DEFAULT_BEAT_UNIT,
} from './meter';
import { clamp, midiToHz } from '../utils/math';
import { SYNC_LABELS } from '../utils/tempo';
import { NOTE_LABELS, SCALE_LABELS, CHORD_LABELS } from '../utils/music';
import { MOD_ROWS, MOD_SOURCE_LABELS, MOD_DEST_LABELS } from './mod-routing';

export type ParamId = string;

export type Taper = 'linear' | 'exp' | 'power' | 'discrete';

export interface ParamDef {
  id: ParamId;
  min: number;
  max: number;
  default: number;
  step?: number;
  taper?: Taper;
  curve?: number; // exponent for the 'power' taper (curve < 1 = finer near max)
  unit?: string;
  format?: (v: number) => string;
  labels?: string[]; // for discrete taper
}

export type NoteListener = (on: boolean, note: number, velocity: number) => void;

export class ParamBus {
  private readonly defs = new Map<ParamId, ParamDef>();
  private readonly values = new Map<ParamId, number>();
  // Per-param "reset target" for the knob double-tap / drum Reset button. Set by
  // the active preset/song (load or save); cleared on resetDefaults(). Not
  // persisted — derived from whatever sound is active. See
  // specs/features/param-reset-baseline.md.
  private readonly baselines = new Map<ParamId, number>();
  private readonly listeners = new Map<ParamId, Set<(v: number) => void>>();
  private readonly noteListeners: NoteListener[] = [];
  private readonly changeListeners = new Set<(id: ParamId, v: number) => void>();
  private suppressChange = 0;

  register(def: ParamDef): void {
    this.defs.set(def.id, def);
    if (!this.values.has(def.id)) this.values.set(def.id, def.default);
  }

  registerMany(defs: ParamDef[]): void {
    for (const d of defs) this.register(d);
  }

  set(id: ParamId, value: number, silent = false): void {
    const def = this.defs.get(id);
    if (!def) {
      if (!this.values.has(id)) this.values.set(id, value);
      return;
    }
    const v = clamp(value, def.min, def.max);
    if (this.values.get(id) === v) return;
    this.values.set(id, v);
    if (!silent) {
      this.listeners.get(id)?.forEach((l) => l(v));
      // Global "something changed" signal. Suppressed during bulk applies
      // (restore/resetDefaults) so loading a preset/song isn't seen as an edit.
      if (this.suppressChange === 0) this.changeListeners.forEach((l) => l(id, v));
    }
  }

  get(id: ParamId): number {
    return this.values.get(id) ?? this.defs.get(id)?.default ?? 0;
  }

  def(id: ParamId): ParamDef | undefined {
    return this.defs.get(id);
  }

  subscribe(id: ParamId, listener: (v: number) => void): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    listener(this.get(id));
    return () => set!.delete(listener);
  }

  /** Global listener fired on any non-silent, non-bulk param change. */
  onChange(listener: (id: ParamId, v: number) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /**
   * Run `fn` with the global `onChange` signal suppressed — the machine is
   * writing, not the user. Per-param listeners still fire, so knobs, the XY pad
   * and the audio graph all track the value exactly as before; only the "the
   * user changed the sound" signal is withheld.
   *
   * This is the same suppression {@link restore}/{@link resetDefaults} use for a
   * bulk apply, exposed so the audio layer can reach it: the motion sequencer
   * writes at frame rate, and letting that reach `onChange` re-armed the session
   * autosave's debounce every frame — so it never elapsed and the session never
   * saved (see specs/features/runtime-performance.md REQ-5). Re-entrant, and
   * `finally`-guarded so a throwing `fn` cannot wedge the counter.
   *
   * Callers on a per-frame path should pass a **pre-bound** closure rather than
   * an inline arrow (REQ-6 — no allocation in a per-frame loop).
   */
  withoutChangeSignal(fn: () => void): void {
    this.suppressChange++;
    try {
      fn();
    } finally {
      this.suppressChange--;
    }
  }

  onNote(listener: NoteListener): () => void {
    this.noteListeners.push(listener);
    return () => {
      const idx = this.noteListeners.indexOf(listener);
      if (idx >= 0) this.noteListeners.splice(idx, 1);
    };
  }

  noteOn(note: number, velocity = 0.8): void {
    for (const l of this.noteListeners) l(true, note, velocity);
  }

  noteOff(note: number): void {
    for (const l of this.noteListeners) l(false, note, 0);
  }

  /** Snapshot for preset save. */
  snapshot(): Record<ParamId, number> {
    const out: Record<ParamId, number> = {};
    for (const [id, v] of this.values) out[id] = v;
    return out;
  }

  /** Restore from preset. Fires per-param listeners (so audio + UI update),
   *  but suppresses the global `onChange` signal — a bulk apply is not an edit.
   *  Also refreshes the reset baselines for the applied ids (merge). */
  restore(snapshot: Record<ParamId, number>): void {
    this.suppressChange++;
    try {
      for (const [id, v] of Object.entries(snapshot)) this.set(id, v);
    } finally {
      this.suppressChange--;
    }
    this.setBaselines(snapshot);
  }

  /** Reset every registered param to its default (fires per-param listeners;
   *  global `onChange` suppressed like {@link restore}). Clears all reset
   *  baselines — a fresh/New song has no preset value to return to. */
  resetDefaults(): void {
    this.suppressChange++;
    try {
      for (const def of this.defs.values()) this.set(def.id, def.default);
    } finally {
      this.suppressChange--;
    }
    // Drop ids with no definition. `set` keeps an unregistered id so a song from
    // a NEWER build round-trips its params (ADR-007) — but this loop used to walk
    // `defs`, so those ids were never cleared, and `snapshot()` walks `values`,
    // so they were re-serialized into every save and survived reload. A load or
    // New is exactly the point where nothing of the old song should remain.
    for (const id of this.values.keys()) {
      if (!this.defs.has(id)) this.values.delete(id);
    }
    this.baselines.clear();
  }

  /** Record these ids' values as the reset target (the double-tap baseline)
   *  without touching live values or firing listeners. Only *registered* ids are
   *  kept, clamped like {@link set}; ids absent from `snapshot` keep their prior
   *  baseline (a patch-only preset must not wipe song-set drum baselines). Called
   *  by preset/song load (via {@link restore}) and by the Save handlers. */
  setBaselines(snapshot: Record<ParamId, number>): void {
    for (const [id, v] of Object.entries(snapshot)) {
      const def = this.defs.get(id);
      if (def) this.baselines.set(id, clamp(v, def.min, def.max));
    }
  }

  /** The value {@link reset} would apply: the baseline if the active preset/song
   *  set one, else the registered default (0 for an unknown id). */
  resetValue(id: ParamId): number {
    const baseline = this.baselines.get(id);
    return baseline !== undefined ? baseline : this.defs.get(id)?.default ?? 0;
  }

  /** Reset a single param to its baseline (loaded/saved preset or song value) if
   *  one exists, else its registered default. Fires listeners like a normal
   *  edit. Backs the knob double-tap and the drum per-track Reset button. */
  reset(id: ParamId): void {
    this.set(id, this.resetValue(id));
  }

  ids(): ParamId[] {
    return [...this.defs.keys()];
  }
}

/* ---------- Default parameter definitions ---------- */

const fmtHz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)}k` : v.toFixed(0)) + 'Hz';
const fmtMs = (v: number) => (v >= 1 ? `${v.toFixed(2)}s` : `${(v * 1000).toFixed(0)}ms`);
const fmtPct = (v: number) => `${Math.round(v * 100)}%`;
const fmtSemi = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}st`;
const fmtPan = (v: number) =>
  Math.abs(v) < 0.005 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`;
const fmtCent = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}c`;
const fmtDb = (v: number) => `${(20 * Math.log10(Math.max(v, 0.001))).toFixed(1)}dB`;
const fmtDbRaw = (v: number) => `${v.toFixed(0)}dB`;
const fmtUs = (v: number) => (v < 0.001 ? `${(v * 1e6).toFixed(0)}µs` : fmtMs(v));
const fmtNoteFromCutoff = (note: number) => fmtHz(midiToHz(note));
/** Module-level, so both LFOs share one instance and their defs are identical
 *  by reference as well as by value (lfo.md REQ-10). */
const fmtLfoRate = (v: number) => v.toFixed(2) + 'Hz';

export const WAVE_LABELS = ['sine', 'triangle', 'saw', 'square'];
/** Append-only: an index here is a stored value in every preset, song and share
 *  link, so reordering silently rewrites saved patches (lfo.md REQ-3). */
export const LFO_DEST_LABELS = ['off', 'cutoff', 'pitch', 'amp', 'pulse', 'pan', 'shape'];
// `lfo.sync`'s labels are `SYNC_LABELS` from `utils/tempo`, used directly — the
// LFO no longer has a division list of its own now that the effects share one
// (tempo-lock.md REQ-8). Index 0 is free-running, and the array is append-only:
// an index here is a stored value in every preset, song and share link.
export const VOICING_LABELS = ['mono', 'poly'];
export const GLIDE_MODE_LABELS = ['off', 'always', 'legato'];
export const UNISON_LABELS = ['off', '2', '3', '4'];
// Re-exported so panels pull the key's labels from the same place as every other
// label array; the tables themselves are pure and live in utils
// (specs/features/scale-quantization.md).
export { NOTE_LABELS, SCALE_LABELS, CHORD_LABELS };
export const ARP_PATTERN_LABELS = ['up', 'down', 'updn', 'rand', 'play'];
export const ARP_RATE_LABELS = ['1/4', '1/8', '1/16', '1/32'];
export const DRUM_TRACK_LABELS = ['Kick', 'Snare', 'C.Hat', 'O.Hat', 'L.Tom', 'M.Tom', 'H.Tom', 'Clap'];
// Selectable voice algorithms (drum-machine.md REQ-11). The first 8 are the
// classic voices in track order — a track's default model is its own index —
// and the order must match MODEL_BUILDERS in drum-machine.ts.
export const DRUM_MODEL_LABELS = [...DRUM_TRACK_LABELS, 'Conga', 'Bongo', 'Cowbell', 'Clave', 'Shaker'];
// Selectable filter models (filter-models.md REQ-1). Append-only for the same
// reason as LFO_DEST_LABELS. Index 0 is the ladder, so files that predate the
// switch sound unchanged (ADR-006).
export const FILTER_MODEL_LABELS = ['ladder', 'poly'];

// The POLY pole-mix morph reads as four named anchors (filter-models.md REQ-6);
// the knob shows the one it is nearest, which is what a player needs to know.
const SHAPE_LABELS = ['LP24', 'LP12', 'BP12', 'HP24'];
const fmtFilterShape = (v: number) =>
  SHAPE_LABELS[Math.min(SHAPE_LABELS.length - 1, Math.round(v * 3))]!;

export function registerDefaults(bus: ParamBus): void {
  bus.registerMany([
    // ----- Voicing -----
    { id: 'voicing.mode', min: 0, max: 1, default: 1, step: 1, taper: 'discrete', labels: VOICING_LABELS },

    // ----- OSC 1 -----
    { id: 'osc1.wave', min: 0, max: 3, default: 2, step: 1, taper: 'discrete', labels: WAVE_LABELS },
    { id: 'osc1.octave', min: -2, max: 2, default: 0, step: 1, unit: 'oct' },
    { id: 'osc1.detune', min: -50, max: 50, default: 0, unit: 'c', format: fmtCent },
    { id: 'osc1.level', min: 0, max: 1, default: 0.7, format: fmtPct },
    // 0.5 IS a square wave, so the default is an exact no-op (oscillators.md REQ-5).
    { id: 'osc1.pulseWidth', min: 0.5, max: 0.95, default: 0.5, format: fmtPct },

    // ----- OSC 2 -----
    { id: 'osc2.wave', min: 0, max: 3, default: 2, step: 1, taper: 'discrete', labels: WAVE_LABELS },
    { id: 'osc2.octave', min: -2, max: 2, default: 0, step: 1, unit: 'oct' },
    { id: 'osc2.detune', min: -50, max: 50, default: 7, unit: 'c', format: fmtCent },
    { id: 'osc2.level', min: 0, max: 1, default: 0.5, format: fmtPct },
    { id: 'osc2.pulseWidth', min: 0.5, max: 0.95, default: 0.5, format: fmtPct },

    // ----- Sub oscillator -----
    { id: 'sub.wave', min: 0, max: 3, default: 0, step: 1, taper: 'discrete', labels: WAVE_LABELS },
    { id: 'sub.octave', min: -2, max: -1, default: -1, step: 1, unit: 'oct' },
    { id: 'sub.level', min: 0, max: 1, default: 0, format: fmtPct },

    // ----- Unison -----
    { id: 'unison.voices', min: 1, max: 4, default: 1, step: 1, taper: 'discrete', labels: UNISON_LABELS },
    { id: 'unison.detune', min: 0, max: 50, default: 12, unit: 'c', format: fmtCent },

    // ----- Analogue -----
    { id: 'analog.drift', min: 0, max: 1, default: 0, format: fmtPct },

    // ----- Mixer / extras -----
    { id: 'mixer.noise', min: 0, max: 1, default: 0, format: fmtPct },
    { id: 'mixer.glide', min: 0, max: 1, default: 0, format: fmtMs },
    { id: 'glide.mode', min: 0, max: 2, default: 1, step: 1, taper: 'discrete', labels: GLIDE_MODE_LABELS },

    // ----- Filter -----
    { id: 'filter.cutoff', min: 30, max: 130, default: 90, format: (v) => fmtNoteFromCutoff(v) },
    { id: 'filter.resonance', min: 0, max: 4.2, default: 0.5, taper: 'power', curve: 0.6, format: (v) => v.toFixed(2) },
    { id: 'filter.drive', min: 0.5, max: 6, default: 1.2, format: (v) => v.toFixed(2) + 'x' },
    { id: 'filter.envAmount', min: -48, max: 48, default: 24, format: fmtSemi },
    // How much of the filter envelope's depth velocity controls (envelopes.md
    // REQ-5). 0 is an exact no-op — the peak stays the hard-coded 1 the filter
    // envelope always used — so no existing preset or song changes (ADR-006).
    { id: 'filter.velAmount', min: 0, max: 1, default: 0, format: fmtPct },
    // Model + its morph (filter-models.md). Both default to a no-op: index 0 is
    // the ladder, shape 0 is a plain 4-pole low-pass.
    { id: 'filter.model', min: 0, max: FILTER_MODEL_LABELS.length - 1, default: 0, step: 1, taper: 'discrete', labels: FILTER_MODEL_LABELS },
    { id: 'filter.shape', min: 0, max: 1, default: 0, format: fmtFilterShape },
    // Note -> cutoff, in semitones (key-tracking.md). 0 = off.
    { id: 'filter.keytrack', min: 0, max: 1, default: 0, format: fmtPct },

    // ----- Amp envelope -----
    { id: 'env.amp.attack', min: 0.001, max: 4, default: 0.005, format: fmtMs },
    { id: 'env.amp.decay', min: 0.001, max: 4, default: 0.2, format: fmtMs },
    { id: 'env.amp.sustain', min: 0, max: 1, default: 0.8, format: fmtPct },
    { id: 'env.amp.release', min: 0.001, max: 6, default: 0.4, format: fmtMs },

    // ----- Filter envelope -----
    { id: 'env.fil.attack', min: 0.001, max: 4, default: 0.005, format: fmtMs },
    { id: 'env.fil.decay', min: 0.001, max: 4, default: 0.6, format: fmtMs },
    { id: 'env.fil.sustain', min: 0, max: 1, default: 0.2, format: fmtPct },
    { id: 'env.fil.release', min: 0.001, max: 6, default: 0.4, format: fmtMs },

    // ----- LFO 1 and LFO 2 -----
    // Both from one factory, so "identical to the first one" (lfo.md REQ-10) is
    // structural and cannot drift. Kept adjacent so the generated catalogue
    // (public/params.md) lists them together.
    ...lfoParams('lfo'),
    ...lfoParams('lfo2'),

    // ----- FX: Distortion -----
    ...distParams('fx.dist'),

    // ----- FX: Wah -----
    // Longhand: the wah is synth-only, so there is nothing for it to share with.
    { id: 'fx.wah.on', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] },
    { id: 'fx.wah.rate', min: 0.05, max: 10, default: 2.0, format: (v) => v.toFixed(2) + 'Hz' },
    { id: 'fx.wah.depth', min: 0, max: 1, default: 0.4, format: fmtPct },
    { id: 'fx.wah.q', min: 0.5, max: 20, default: 4, format: (v) => v.toFixed(1) },
    syncParam('fx.wah'),

    // ----- FX: Phaser -----
    ...phaserParams('fx.phaser', { depth: 0.5, mix: 0.5 }),

    // ----- FX: Delay -----
    ...delayParams('fx.delay'),

    // ----- FX: Reverb -----
    ...reverbParams('fx.reverb'),

    // ----- FX: Duck (last in the chain, so the reverb tail ducks too) -----
    ...duckParams('fx.duck'),

    // ----- Drum FX: Phaser -----
    ...phaserParams('fx.drum.phaser', { depth: 0.7, mix: 0.6 }),

    // ----- Drum FX: Delay -----
    ...delayParams('fx.drum.delay'),

    // ----- Drum FX: Reverb -----
    ...reverbParams('fx.drum.reverb'),

    // ----- Drum FX: Compressor (1176 FET style; ratio is an index) -----
    { id: 'fx.drum.comp.on', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] },
    { id: 'fx.drum.comp.threshold', min: -40, max: 0, default: -18, format: fmtDbRaw },
    { id: 'fx.drum.comp.ratio', min: 0, max: 4, default: 0, step: 1, taper: 'discrete', labels: ['4:1', '8:1', '12:1', '20:1', 'ALL'] },
    { id: 'fx.drum.comp.attack', min: 0.00002, max: 0.0008, default: 0.0002, taper: 'exp', format: fmtUs },
    { id: 'fx.drum.comp.release', min: 0.05, max: 1.1, default: 0.25, taper: 'exp', format: fmtMs },
    { id: 'fx.drum.comp.makeup', min: 0, max: 24, default: 0, format: fmtDbRaw },

    // ----- Sampler FX: Distortion -----
    ...distParams('fx.sampler.dist'),

    // ----- Sampler FX: Phaser -----
    ...phaserParams('fx.sampler.phaser', { depth: 0.7, mix: 0.5 }),

    // ----- Sampler FX: Delay -----
    ...delayParams('fx.sampler.delay'),

    // ----- Sampler FX: Reverb -----
    ...reverbParams('fx.sampler.reverb'),

    // ----- Sampler FX: Duck -----
    ...duckParams('fx.sampler.duck'),

    // ----- DJ filter (live performance sweep) -----
    { id: 'fx.djfilter', min: -1, max: 1, default: 0, format: (v) =>
        Math.abs(v) < 0.02 ? 'off' : v < 0 ? `LP ${Math.round(-v * 100)}%` : `HP ${Math.round(v * 100)}%` },

    // ----- Master FX: Compressor (SSL G bus VCA style; ratio/release are indices) -----
    { id: 'fx.master.comp.on', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] },
    { id: 'fx.master.comp.threshold', min: -40, max: 0, default: -12, format: fmtDbRaw },
    { id: 'fx.master.comp.ratio', min: 0, max: 2, default: 1, step: 1, taper: 'discrete', labels: ['2:1', '4:1', '10:1'] },
    { id: 'fx.master.comp.attack', min: 0.0001, max: 0.03, default: 0.01, taper: 'exp', format: fmtMs },
    { id: 'fx.master.comp.release', min: 0, max: 4, default: 4, step: 1, taper: 'discrete', labels: ['0.1s', '0.3s', '0.6s', '1.2s', 'auto'] },
    { id: 'fx.master.comp.makeup', min: 0, max: 12, default: 0, format: fmtDbRaw },

    // ----- Master -----
    { id: 'master.volume', min: 0, max: 1, default: 0.8, format: fmtDb },
    { id: 'master.pitchBend', min: -1, max: 1, default: 0, format: fmtSemi },
    { id: 'master.modWheel', min: 0, max: 1, default: 0, format: fmtPct },
    { id: 'keyboard.transpose', min: -2, max: 2, default: 0, step: 1, taper: 'discrete', format: (v) => v >= 0 ? `+${v}` : `${v}` },

    // ----- Transport -----
    { id: 'transport.bpm', min: 40, max: 240, default: 120, step: 1, format: (v) => `${v.toFixed(0)} bpm` },
    { id: 'transport.swing', min: 0, max: 1, default: 0, format: fmtPct },
    // Meter (specs/features/meter.md REQ-5, ADR-019). The pair resolves to a bar
    // length in 16th ticks: 4 beats × a quarter = 16 = 4/4, i.e. exactly what
    // every pre-meter song means, so the defaults are no-ops (ADR-006).
    { id: 'transport.beats', min: MIN_BEATS, max: MAX_BEATS, default: DEFAULT_BEATS, step: 1 },
    { id: 'transport.beatUnit', min: 0, max: BEAT_UNIT_LABELS.length - 1, default: DEFAULT_BEAT_UNIT, step: 1, taper: 'discrete', labels: [...BEAT_UNIT_LABELS] },

    // ----- Arpeggiator -----
    { id: 'arp.on', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] },
    { id: 'arp.pattern', min: 0, max: 4, default: 0, step: 1, taper: 'discrete', labels: ARP_PATTERN_LABELS },
    { id: 'arp.rate', min: 0, max: 3, default: 2, step: 1, taper: 'discrete', labels: ARP_RATE_LABELS },
    { id: 'arp.octaves', min: 1, max: 4, default: 1, step: 1 },
    { id: 'arp.gate', min: 0.05, max: 1, default: 0.5, format: fmtPct },

    // ----- Mod matrix (specs/features/mod-matrix.md, ADR-017) -----
    // Six free rows; LFO 1/2 are rows 0-1 and keep lfo.dest / lfo.amount (REQ-2).
    // src 0 = off, dst 0 = none, amt 0 = silent: all three are no-ops, so a preset
    // that predates the matrix loads unchanged (ADR-006).
    ...modMatrixParams(),

    // ----- Key / scale (specs/features/scale-quantization.md, chord-tools.md) -----
    // `scale.type` 0 is 'chromatic' and `chord.voicing` 0 is 'off': both are true
    // no-ops, so every preset and song predating these keys sounds identical (ADR-006).
    { id: 'scale.root', min: 0, max: 11, default: 0, step: 1, taper: 'discrete', labels: NOTE_LABELS },
    { id: 'scale.type', min: 0, max: SCALE_LABELS.length - 1, default: 0, step: 1, taper: 'discrete', labels: SCALE_LABELS },
    { id: 'chord.voicing', min: 0, max: CHORD_LABELS.length - 1, default: 0, step: 1, taper: 'discrete', labels: CHORD_LABELS },

    // ----- Sequencer -----
    { id: 'seq.on', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] },
    // Synth voice-bus volume. Defaults to 1 (no-op: the bus was always unity)
    // so existing presets/songs sound unchanged. Drives engine.voiceBus.gain.
    { id: 'seq.master', min: 0, max: 1, default: 1, format: fmtPct },
    // Song-tab DJ controls. Seq mute stops the sequencer triggering (live keys
    // stay audible); solo silences the other lanes. Defaults are no-ops.
    { id: 'seq.mute', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['on', 'mute'] },
    // Per-track mute (sequencer.md REQ-10) — the drum machine's per-track rule.
    // Default 0 is a no-op, so v1-v5 songs are unaffected (ADR-006).
    ...Array.from({ length: SEQ_TRACK_COUNT }, (_, t) => ({
      id: `seq.t${t}.mute`, min: 0, max: 1, default: 0, step: 1,
      taper: 'discrete' as const, labels: ['on', 'mute'],
    })),
    { id: 'seq.solo', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'solo'] },
    ...laneMeterParams('seq'),

    // ----- Drum machine -----
    { id: 'drum.on', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] },
    // Hat choke group (drum-machine.md REQ-12). Default OFF: switching it on
    // changes how an existing song sounds, which is exactly what ADR-006 says a
    // new param's default must not do.
    { id: 'drum.choke', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] },
    { id: 'drum.master', min: 0, max: 1, default: 0.85, format: fmtPct },
    { id: 'drum.mute', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['on', 'mute'] },
    { id: 'drum.solo', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'solo'] },
    ...laneMeterParams('drum'),

    // Per-track drum params (8 tracks)
    ...drumTrackParams(),

    // ----- Sampler -----
    { id: 'sampler.on', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] },
    { id: 'sampler.master', min: 0, max: 1, default: 0.85, format: fmtPct },
    { id: 'sampler.mute', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['on', 'mute'] },
    { id: 'sampler.solo', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'solo'] },
    ...laneMeterParams('sampler'),

    // Per-slot sampler params (8 slots)
    ...samplerTrackParams(),

    // ----- Motion sequencer (param automation; specs/features/motion-sequencer.md) -----
    { id: 'motion.on', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] },
    // Song-tab mute: active = motion.on && !motion.mute (motion-sequencer.md REQ-12).
    { id: 'motion.mute', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['on', 'mute'] },
    // slide = linear interpolation between anchors; step = jump-and-hold.
    // Mode is per lane (motion-sequencer.md REQ-2): this one drives the XY
    // lane, each track has its own below, so a bank can sweep one param while
    // stepping another. Same default, so nothing changes for existing songs.
    { id: 'motion.slide', min: 0, max: 1, default: 1, step: 1, taper: 'discrete', labels: ['step', 'slide'] },
    ...Array.from({ length: MOTION_TRACK_COUNT }, (_, t) => ({
      id: `motion.t${t}.slide`, min: 0, max: 1, default: 1, step: 1,
      taper: 'discrete' as const, labels: ['step', 'slide'],
    })),
    ...laneMeterParams('motion'),
  ]);
}

/** Memoized by {@link paramIds} — the id set never changes within a process. */
let paramIdCache: ReadonlySet<ParamId> | null = null;

/**
 * Every parameter id `registerDefaults` registers.
 *
 * For validators that must tell a real automation target from a typo
 * (`untrusted-input.md` REQ-12) without standing up an Engine or reaching for
 * the live bus — `song-validate.ts` runs in Node inside the MCP server and in
 * tests, where no Engine exists.
 *
 * Built **lazily**, not at module init: the validator sits on the boot path via
 * the share-link and session-restore routes, and `runtime-performance.md` REQ-1
 * counts work done before first paint. A song with no automation targets never
 * pays for this at all.
 */
export function paramIds(): ReadonlySet<ParamId> {
  if (!paramIdCache) {
    const bus = new ParamBus();
    registerDefaults(bus);
    paramIdCache = new Set(bus.ids());
  }
  return paramIdCache;
}

/**
 * One LFO's five params. Called once per prefix (`lfo`, `lfo2`) so the two LFOs
 * cannot drift apart in range, default, taper or label array — lfo.md REQ-10.
 *
 * Every default is a no-op: `amount` 0 and `dest` 0 (`off`) mean a patch that
 * predates a given LFO sounds exactly as it did (ADR-006), which is what lets
 * LFO 2 ship without a song-format version bump.
 */
/**
 * The mod matrix's six free rows (mod-matrix.md REQ-2/REQ-3). A factory for the same
 * reason `lfoParams` is one: six identical triples written out by hand is six chances
 * to typo an index.
 */
function modMatrixParams(): ParamDef[] {
  const out: ParamDef[] = [];
  for (let n = 0; n < MOD_ROWS; n++) {
    out.push(
      { id: `mod.${n}.src`, min: 0, max: MOD_SOURCE_LABELS.length - 1, default: 0, step: 1, taper: 'discrete', labels: MOD_SOURCE_LABELS },
      { id: `mod.${n}.dst`, min: 0, max: MOD_DEST_LABELS.length - 1, default: 0, step: 1, taper: 'discrete', labels: MOD_DEST_LABELS },
      // Bipolar (REQ-9): a negative amount inverts the route, so no source needs an
      // inverted twin. 0 is the no-op.
      { id: `mod.${n}.amt`, min: -1, max: 1, default: 0, format: fmtPct },
    );
  }
  return out;
}

/**
 * The on/off switch every insert effect carries. Its own helper because the
 * `step: 1, taper: 'discrete', labels: ['off', 'on']` triple was written out
 * once per effect per chain — fifteen identical copies.
 */
function fxOnParam(prefix: string): ParamDef {
  return { id: `${prefix}.on`, min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] };
}

/**
 * The tempo lock every rate/time knob carries (tempo-lock.md REQ-8), for the
 * same reason `fxOnParam` exists: nine identical copies otherwise.
 *
 * Index 0 is `free` — what every existing patch has, and an exact no-op: the
 * rate keeps its stored value and is merely overridden while synced (ADR-006).
 * `SYNC_LABELS` is append-only; an index here is a stored value in every preset,
 * song and share link, so reordering silently rewrites saved patches.
 */
function syncParam(prefix: string): ParamDef {
  return { id: `${prefix}.sync`, min: 0, max: SYNC_LABELS.length - 1, default: 0, step: 1, taper: 'discrete', labels: SYNC_LABELS };
}

/**
 * The four insert effects that appear on more than one chain (effects.md REQ-3/4/5).
 * Written once each and instantiated per prefix, so `fx.delay.*`, `fx.drum.delay.*`
 * and `fx.sampler.delay.*` cannot drift into three different delays — the same
 * reasoning `lfoParams` applies to LFO 1 and 2.
 *
 * Defaults that genuinely differ per chain are parameters of the factory, not
 * copies of it: the drum and sampler phasers ship deeper than the synth's, and
 * the drum phaser wetter still. Everything else is identical across chains and
 * is now identical by construction. **These values are the compatibility
 * surface** — a default is what every preset and song that predates a param
 * receives (ADR-006), so changing one here silently re-voices the entire corpus.
 */
function distParams(prefix: string): ParamDef[] {
  return [
    fxOnParam(prefix),
    { id: `${prefix}.drive`, min: 0, max: 1, default: 0.3, format: fmtPct },
    { id: `${prefix}.tone`, min: 200, max: 8000, default: 3000, format: fmtHz },
    { id: `${prefix}.mix`, min: 0, max: 1, default: 1, format: fmtPct },
  ];
}

function phaserParams(prefix: string, d: { depth: number; mix: number }): ParamDef[] {
  return [
    fxOnParam(prefix),
    { id: `${prefix}.rate`, min: 0.05, max: 5, default: 0.5, format: (v) => v.toFixed(2) + 'Hz' },
    { id: `${prefix}.depth`, min: 0, max: 1, default: d.depth, format: fmtPct },
    { id: `${prefix}.feedback`, min: 0, max: 0.9, default: 0.4, format: fmtPct },
    { id: `${prefix}.mix`, min: 0, max: 1, default: d.mix, format: fmtPct },
    syncParam(prefix),
  ];
}

function delayParams(prefix: string): ParamDef[] {
  return [
    fxOnParam(prefix),
    { id: `${prefix}.time`, min: 0.01, max: 1.5, default: 0.35, format: fmtMs },
    { id: `${prefix}.feedback`, min: 0, max: 0.95, default: 0.4, format: fmtPct },
    { id: `${prefix}.mix`, min: 0, max: 1, default: 0.3, format: fmtPct },
    syncParam(prefix),
  ];
}

/**
 * The trigger-keyed ducker (sidechain-ducking.md). `.on` off is the no-op that
 * leaves every existing patch alone (ADR-006), which is what frees the rest to
 * carry musical defaults. `.src` labels are the drum lanes plus `Any` **appended
 * last** — a discrete index is a stored value, so the list is append-only, and
 * index 0 is the lane that boots on the Kick model.
 */
function duckParams(prefix: string): ParamDef[] {
  return [
    fxOnParam(prefix),
    { id: `${prefix}.amount`, min: 0, max: 1, default: 0.7, format: fmtPct },
    { id: `${prefix}.attack`, min: 0.001, max: 0.1, default: 0.005, format: fmtMs },
    { id: `${prefix}.release`, min: 0.02, max: 1, default: 0.18, format: fmtMs },
    {
      id: `${prefix}.src`, min: 0, max: DRUM_TRACKS.length, default: 0, step: 1,
      taper: 'discrete', labels: [...DRUM_TRACKS, 'Any'],
    },
  ];
}

function reverbParams(prefix: string): ParamDef[] {
  return [
    fxOnParam(prefix),
    { id: `${prefix}.size`, min: 0, max: 1, default: 0.6, format: fmtPct },
    { id: `${prefix}.damp`, min: 0, max: 1, default: 0.4, format: fmtPct },
    { id: `${prefix}.mix`, min: 0, max: 1, default: 0.25, format: fmtPct },
  ];
}

function lfoParams(prefix: 'lfo' | 'lfo2'): ParamDef[] {
  return [
    // Exponentially tapered (lfo.md REQ-8): rate is heard in octaves, so equal
    // turns give equal ratios. Linear spent half the dial above 10 Hz and
    // crammed the useful sub-1 Hz region into its first ~5%. Stored values are
    // in Hz and unaffected — only the knob position they map to moves.
    { id: `${prefix}.rate`, min: 0.05, max: 20, default: 4, taper: 'exp', format: fmtLfoRate },
    { id: `${prefix}.amount`, min: 0, max: 1, default: 0, format: fmtPct },
    { id: `${prefix}.wave`, min: 0, max: 3, default: 0, step: 1, taper: 'discrete', labels: WAVE_LABELS },
    { id: `${prefix}.dest`, min: 0, max: LFO_DEST_LABELS.length - 1, default: 0, step: 1, taper: 'discrete', labels: LFO_DEST_LABELS },
    // Tempo lock (lfo.md REQ-9) — now the same def the effects get, so the LFO's
    // lock and theirs cannot drift apart (tempo-lock.md REQ-8).
    syncParam(prefix),
  ];
}

/**
 * One machine's loop length + step rate (meter.md REQ-10/REQ-14).
 *
 * Both defaults are no-ops (ADR-006): `LEN_FOLLOW` means "as many cells of this
 * rate as the bar holds", and the default rate is one cell per tick — together,
 * exactly the pre-meter 16-step bar. `len` is deliberately *not* clamped to a
 * minimum of 1: 0 is the follow sentinel, and a lane can never end up with zero
 * cells because `laneCells` clamps the resolved count.
 */
function laneMeterParams(prefix: string): ParamDef[] {
  return [
    { id: `${prefix}.len`, min: LEN_FOLLOW, max: GRID_CELLS, default: LEN_FOLLOW, step: 1,
      format: (v) => (v === LEN_FOLLOW ? 'bar' : `${v}`) },
    { id: `${prefix}.rate`, min: 0, max: LANE_RATE_LABELS.length - 1, default: DEFAULT_LANE_RATE,
      step: 1, taper: 'discrete', labels: [...LANE_RATE_LABELS] },
  ];
}

function samplerTrackParams(): ParamDef[] {
  const out: ParamDef[] = [];
  for (let i = 0; i < 8; i++) {
    out.push({ id: `sampler.t${i}.mute`, min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['on', 'mute'] });
  }
  return out;
}

function drumTrackParams(): ParamDef[] {
  const out: ParamDef[] = [];
  for (let i = 0; i < DRUM_TRACK_COUNT; i++) {
    out.push({ id: `drum.t${i}.vol`, min: 0, max: 1, default: 0.85, format: fmtPct });
    out.push({ id: `drum.t${i}.tune`, min: -24, max: 24, default: 0, step: 1, unit: 'st' });
    out.push({ id: `drum.t${i}.decay`, min: 0.02, max: 1.5, default: 0.3, format: fmtMs });
    // Per-track channel — all no-op at default (open / clean / centre).
    out.push({ id: `drum.t${i}.tone`, min: 0, max: 1, default: 1, format: fmtPct });
    out.push({ id: `drum.t${i}.drive`, min: 0, max: 1, default: 0, format: fmtPct });
    out.push({ id: `drum.t${i}.pan`, min: -1, max: 1, default: 0, format: fmtPan });
    out.push({ id: `drum.t${i}.mute`, min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['on', 'mute'] });
    // Voice model — defaults to the track's own classic voice, so files that
    // omit it (every pre-model song/preset) sound unchanged (REQ-11).
    out.push({ id: `drum.t${i}.model`, min: 0, max: DRUM_MODEL_LABELS.length - 1, default: i, step: 1, taper: 'discrete', labels: DRUM_MODEL_LABELS });
  }
  return out;
}

import { DRUM_TRACK_COUNT } from './patterns';

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
   *  but suppresses the global `onChange` signal — a bulk apply is not an edit. */
  restore(snapshot: Record<ParamId, number>): void {
    this.suppressChange++;
    try {
      for (const [id, v] of Object.entries(snapshot)) this.set(id, v);
    } finally {
      this.suppressChange--;
    }
  }

  /** Reset every registered param to its default (fires per-param listeners;
   *  global `onChange` suppressed like {@link restore}). */
  resetDefaults(): void {
    this.suppressChange++;
    try {
      for (const def of this.defs.values()) this.set(def.id, def.default);
    } finally {
      this.suppressChange--;
    }
  }

  ids(): ParamId[] {
    return [...this.defs.keys()];
  }
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
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
const fmtNoteFromCutoff = (note: number) => fmtHz(440 * Math.pow(2, (note - 69) / 12));

export const WAVE_LABELS = ['sine', 'triangle', 'saw', 'square'];
export const LFO_DEST_LABELS = ['off', 'cutoff', 'pitch', 'amp', 'pulse'];
export const VOICING_LABELS = ['mono', 'poly'];
export const GLIDE_MODE_LABELS = ['off', 'always', 'legato'];
export const UNISON_LABELS = ['off', '2', '3', '4'];
export const ARP_PATTERN_LABELS = ['up', 'down', 'updn', 'rand', 'play'];
export const ARP_RATE_LABELS = ['1/4', '1/8', '1/16', '1/32'];
export const DRUM_TRACK_LABELS = ['Kick', 'Snare', 'C.Hat', 'O.Hat', 'L.Tom', 'M.Tom', 'H.Tom', 'Clap'];

export function registerDefaults(bus: ParamBus): void {
  bus.registerMany([
    // ----- Voicing -----
    { id: 'voicing.mode', min: 0, max: 1, default: 1, step: 1, taper: 'discrete', labels: VOICING_LABELS },

    // ----- OSC 1 -----
    { id: 'osc1.wave', min: 0, max: 3, default: 2, step: 1, taper: 'discrete', labels: WAVE_LABELS },
    { id: 'osc1.octave', min: -2, max: 2, default: 0, step: 1, unit: 'oct' },
    { id: 'osc1.detune', min: -50, max: 50, default: 0, unit: 'c', format: fmtCent },
    { id: 'osc1.level', min: 0, max: 1, default: 0.7, format: fmtPct },

    // ----- OSC 2 -----
    { id: 'osc2.wave', min: 0, max: 3, default: 2, step: 1, taper: 'discrete', labels: WAVE_LABELS },
    { id: 'osc2.octave', min: -2, max: 2, default: 0, step: 1, unit: 'oct' },
    { id: 'osc2.detune', min: -50, max: 50, default: 7, unit: 'c', format: fmtCent },
    { id: 'osc2.level', min: 0, max: 1, default: 0.5, format: fmtPct },

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

    // ----- LFO -----
    { id: 'lfo.rate', min: 0.05, max: 20, default: 4, format: (v) => v.toFixed(2) + 'Hz' },
    { id: 'lfo.amount', min: 0, max: 1, default: 0, format: fmtPct },
    { id: 'lfo.wave', min: 0, max: 3, default: 0, step: 1, taper: 'discrete', labels: WAVE_LABELS },
    { id: 'lfo.dest', min: 0, max: 4, default: 0, step: 1, taper: 'discrete', labels: LFO_DEST_LABELS },

    // ----- FX: Distortion -----
    { id: 'fx.dist.on', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] },
    { id: 'fx.dist.drive', min: 0, max: 1, default: 0.3, format: fmtPct },
    { id: 'fx.dist.tone', min: 200, max: 8000, default: 3000, format: fmtHz },
    { id: 'fx.dist.mix', min: 0, max: 1, default: 1, format: fmtPct },

    // ----- FX: Wah -----
    { id: 'fx.wah.on', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] },
    { id: 'fx.wah.rate', min: 0.05, max: 10, default: 2.0, format: (v) => v.toFixed(2) + 'Hz' },
    { id: 'fx.wah.depth', min: 0, max: 1, default: 0.4, format: fmtPct },
    { id: 'fx.wah.q', min: 0.5, max: 20, default: 4, format: (v) => v.toFixed(1) },

    // ----- FX: Phaser -----
    { id: 'fx.phaser.on', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] },
    { id: 'fx.phaser.rate', min: 0.05, max: 5, default: 0.5, format: (v) => v.toFixed(2) + 'Hz' },
    { id: 'fx.phaser.depth', min: 0, max: 1, default: 0.5, format: fmtPct },
    { id: 'fx.phaser.feedback', min: 0, max: 0.9, default: 0.4, format: fmtPct },
    { id: 'fx.phaser.mix', min: 0, max: 1, default: 0.5, format: fmtPct },

    // ----- FX: Delay -----
    { id: 'fx.delay.on', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] },
    { id: 'fx.delay.time', min: 0.01, max: 1.5, default: 0.35, format: fmtMs },
    { id: 'fx.delay.feedback', min: 0, max: 0.95, default: 0.4, format: fmtPct },
    { id: 'fx.delay.mix', min: 0, max: 1, default: 0.3, format: fmtPct },

    // ----- FX: Reverb -----
    { id: 'fx.reverb.on', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] },
    { id: 'fx.reverb.size', min: 0, max: 1, default: 0.6, format: fmtPct },
    { id: 'fx.reverb.damp', min: 0, max: 1, default: 0.4, format: fmtPct },
    { id: 'fx.reverb.mix', min: 0, max: 1, default: 0.25, format: fmtPct },

    // ----- Drum FX: Phaser -----
    { id: 'fx.drum.phaser.on', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] },
    { id: 'fx.drum.phaser.rate', min: 0.05, max: 5, default: 0.5, format: (v) => v.toFixed(2) + 'Hz' },
    { id: 'fx.drum.phaser.depth', min: 0, max: 1, default: 0.7, format: fmtPct },
    { id: 'fx.drum.phaser.feedback', min: 0, max: 0.9, default: 0.4, format: fmtPct },
    { id: 'fx.drum.phaser.mix', min: 0, max: 1, default: 0.6, format: fmtPct },

    // ----- Drum FX: Delay -----
    { id: 'fx.drum.delay.on', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] },
    { id: 'fx.drum.delay.time', min: 0.01, max: 1.5, default: 0.35, format: fmtMs },
    { id: 'fx.drum.delay.feedback', min: 0, max: 0.95, default: 0.4, format: fmtPct },
    { id: 'fx.drum.delay.mix', min: 0, max: 1, default: 0.3, format: fmtPct },

    // ----- Drum FX: Compressor (1176 FET style; ratio is an index) -----
    { id: 'fx.drum.comp.on', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] },
    { id: 'fx.drum.comp.threshold', min: -40, max: 0, default: -18, format: fmtDbRaw },
    { id: 'fx.drum.comp.ratio', min: 0, max: 4, default: 0, step: 1, taper: 'discrete', labels: ['4:1', '8:1', '12:1', '20:1', 'ALL'] },
    { id: 'fx.drum.comp.attack', min: 0.00002, max: 0.0008, default: 0.0002, taper: 'exp', format: fmtUs },
    { id: 'fx.drum.comp.release', min: 0.05, max: 1.1, default: 0.25, taper: 'exp', format: fmtMs },
    { id: 'fx.drum.comp.makeup', min: 0, max: 24, default: 0, format: fmtDbRaw },

    // ----- Sampler FX: Distortion -----
    { id: 'fx.sampler.dist.on', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] },
    { id: 'fx.sampler.dist.drive', min: 0, max: 1, default: 0.3, format: fmtPct },
    { id: 'fx.sampler.dist.tone', min: 200, max: 8000, default: 3000, format: fmtHz },
    { id: 'fx.sampler.dist.mix', min: 0, max: 1, default: 1, format: fmtPct },

    // ----- Sampler FX: Phaser -----
    { id: 'fx.sampler.phaser.on', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] },
    { id: 'fx.sampler.phaser.rate', min: 0.05, max: 5, default: 0.5, format: (v) => v.toFixed(2) + 'Hz' },
    { id: 'fx.sampler.phaser.depth', min: 0, max: 1, default: 0.7, format: fmtPct },
    { id: 'fx.sampler.phaser.feedback', min: 0, max: 0.9, default: 0.4, format: fmtPct },
    { id: 'fx.sampler.phaser.mix', min: 0, max: 1, default: 0.5, format: fmtPct },

    // ----- Sampler FX: Delay -----
    { id: 'fx.sampler.delay.on', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] },
    { id: 'fx.sampler.delay.time', min: 0.01, max: 1.5, default: 0.35, format: fmtMs },
    { id: 'fx.sampler.delay.feedback', min: 0, max: 0.95, default: 0.4, format: fmtPct },
    { id: 'fx.sampler.delay.mix', min: 0, max: 1, default: 0.3, format: fmtPct },

    // ----- Sampler FX: Reverb -----
    { id: 'fx.sampler.reverb.on', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] },
    { id: 'fx.sampler.reverb.size', min: 0, max: 1, default: 0.6, format: fmtPct },
    { id: 'fx.sampler.reverb.damp', min: 0, max: 1, default: 0.4, format: fmtPct },
    { id: 'fx.sampler.reverb.mix', min: 0, max: 1, default: 0.25, format: fmtPct },

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

    // ----- Arpeggiator -----
    { id: 'arp.on', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] },
    { id: 'arp.pattern', min: 0, max: 4, default: 0, step: 1, taper: 'discrete', labels: ARP_PATTERN_LABELS },
    { id: 'arp.rate', min: 0, max: 3, default: 2, step: 1, taper: 'discrete', labels: ARP_RATE_LABELS },
    { id: 'arp.octaves', min: 1, max: 4, default: 1, step: 1 },
    { id: 'arp.gate', min: 0.05, max: 1, default: 0.5, format: fmtPct },

    // ----- Sequencer -----
    { id: 'seq.on', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] },
    // Synth voice-bus volume. Defaults to 1 (no-op: the bus was always unity)
    // so existing presets/songs sound unchanged. Drives engine.voiceBus.gain.
    { id: 'seq.master', min: 0, max: 1, default: 1, format: fmtPct },
    // Song-tab DJ controls. Seq mute stops the sequencer triggering (live keys
    // stay audible); solo silences the other lanes. Defaults are no-ops.
    { id: 'seq.mute', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['on', 'mute'] },
    { id: 'seq.solo', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'solo'] },

    // ----- Drum machine -----
    { id: 'drum.on', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] },
    { id: 'drum.master', min: 0, max: 1, default: 0.85, format: fmtPct },
    { id: 'drum.mute', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['on', 'mute'] },
    { id: 'drum.solo', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'solo'] },

    // Per-track drum params (8 tracks)
    ...drumTrackParams(),

    // ----- Sampler -----
    { id: 'sampler.on', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'on'] },
    { id: 'sampler.master', min: 0, max: 1, default: 0.85, format: fmtPct },
    { id: 'sampler.mute', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['on', 'mute'] },
    { id: 'sampler.solo', min: 0, max: 1, default: 0, step: 1, taper: 'discrete', labels: ['off', 'solo'] },

    // Per-slot sampler params (8 slots)
    ...samplerTrackParams(),
  ]);
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
  }
  return out;
}

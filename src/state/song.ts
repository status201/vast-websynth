/**
 * A complete song: every synth parameter + all sequencer/drum banks +
 * both chain lanes. Portable as a JSON file and storable in localStorage
 * slots (mirrors the Presets pattern in `preset.ts`).
 */
import type { ParamBus } from './params';
import type { PatternStore, SeqStep, DrumCell, SamplerStep } from './patterns';
import { SEQ_LENGTH, DRUM_TRACK_COUNT } from './patterns';
import type { Arrangement } from '../audio/transport/arrangement';

const STORAGE_PREFIX = 'websynth.song.';
const INDEX_KEY = 'websynth.song.index';

export interface ChainData {
  enabled: boolean;
  steps: number[];
}

export interface SongFile {
  format: 'websynth-song';
  version: 1 | 2;
  name: string;
  params: Record<string, number>;
  seqBanks: SeqStep[][];
  drumBanks: DrumCell[][][];
  seqChain: ChainData;
  drumChain: ChainData;
  // ---- v2: sampler (optional so v1 files still load) ----
  samplerBanks?: SamplerStep[][][];
  samplerChain?: ChainData;
  /** Filenames only — decoded audio is not embedded; user reloads files. */
  sampleNames?: (string | null)[];
}

export const Song = {
  capture(bus: ParamBus, patterns: PatternStore, arr: Arrangement, name: string): SongFile {
    const snap = patterns.snapshot();
    return {
      format: 'websynth-song',
      version: 2,
      name,
      params: bus.snapshot(),
      seqBanks: snap.seqBanks,
      drumBanks: snap.drumBanks,
      seqChain: { enabled: arr.seq.enabled, steps: [...arr.seq.steps] },
      drumChain: { enabled: arr.drum.enabled, steps: [...arr.drum.steps] },
      samplerBanks: snap.samplerBanks,
      samplerChain: { enabled: arr.sampler.enabled, steps: [...arr.sampler.steps] },
      sampleNames: [...patterns.sampleNames],
    };
  },

  apply(file: SongFile, bus: ParamBus, patterns: PatternStore, arr: Arrangement): void {
    bus.restore(file.params);
    patterns.restore({
      seqBanks: file.seqBanks,
      drumBanks: file.drumBanks,
      samplerBanks: file.samplerBanks,
      sampleNames: file.sampleNames,
    });
    arr.setSeqChain(file.seqChain?.steps ?? [0], file.seqChain?.enabled ?? false);
    arr.setDrumChain(file.drumChain?.steps ?? [0], file.drumChain?.enabled ?? false);
    arr.setSamplerChain(file.samplerChain?.steps ?? [0], file.samplerChain?.enabled ?? false);
  },

  toJSON(file: SongFile): string {
    return JSON.stringify(file, null, 2);
  },

  fromJSON(text: string): SongFile | null {
    try {
      const o = JSON.parse(text) as SongFile;
      if (o && o.format === 'websynth-song' && o.params && o.seqBanks && o.drumBanks) return o;
    } catch { /* fall through */ }
    return null;
  },

  download(file: SongFile): void {
    const blob = new Blob([Song.toJSON(file)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${file.name.replace(/[^a-z0-9_-]+/gi, '_') || 'song'}.websynth.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  readFile(f: File): Promise<SongFile | null> {
    return f.text().then((t) => Song.fromJSON(t));
  },

  // ---- localStorage slots ----

  list(): string[] {
    return [...new Set([...Object.keys(DEMO_SONGS), ...readIndex()])].sort();
  },

  saveSlot(name: string, file: SongFile): void {
    localStorage.setItem(STORAGE_PREFIX + name, Song.toJSON(file));
    const ix = readIndex();
    if (!ix.includes(name)) { ix.push(name); writeIndex(ix); }
  },

  loadSlot(name: string): SongFile | null {
    const raw = localStorage.getItem(STORAGE_PREFIX + name);
    if (raw) return Song.fromJSON(raw);
    return DEMO_SONGS[name] ?? null;
  },

  deleteSlot(name: string): void {
    localStorage.removeItem(STORAGE_PREFIX + name);
    writeIndex(readIndex().filter((n) => n !== name));
  },
};

function readIndex(): string[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch { return []; }
}

function writeIndex(ix: string[]): void {
  localStorage.setItem(INDEX_KEY, JSON.stringify(ix));
}

/* ---------------- Demo songs ---------------- */

function baseParams(): Record<string, number> {
  const p: Record<string, number> = {
    'voicing.mode': 1,
    'osc1.wave': 2, 'osc1.octave': 0, 'osc1.detune': 0, 'osc1.level': 0.7,
    'osc2.wave': 2, 'osc2.octave': 0, 'osc2.detune': 7, 'osc2.level': 0.5,
    'sub.wave': 0, 'sub.octave': -1, 'sub.level': 0,
    'unison.voices': 1, 'unison.detune': 12,
    'analog.drift': 0,
    'mixer.noise': 0, 'mixer.glide': 0, 'glide.mode': 1,
    'filter.cutoff': 90, 'filter.resonance': 0.5, 'filter.drive': 1.2, 'filter.envAmount': 24,
    'env.amp.attack': 0.005, 'env.amp.decay': 0.2, 'env.amp.sustain': 0.8, 'env.amp.release': 0.4,
    'env.fil.attack': 0.005, 'env.fil.decay': 0.6, 'env.fil.sustain': 0.2, 'env.fil.release': 0.4,
    'lfo.rate': 4, 'lfo.amount': 0, 'lfo.wave': 0, 'lfo.dest': 0,
    'fx.dist.on': 0, 'fx.dist.drive': 0.3, 'fx.dist.tone': 3000, 'fx.dist.mix': 1,
    'fx.wah.on': 0, 'fx.phaser.on': 0,
    'fx.delay.on': 0, 'fx.delay.time': 0.35, 'fx.delay.feedback': 0.4, 'fx.delay.mix': 0.3,
    'fx.reverb.on': 0, 'fx.reverb.size': 0.6, 'fx.reverb.damp': 0.4, 'fx.reverb.mix': 0.25,
    'fx.djfilter': 0,
    'master.volume': 0.8, 'master.pitchBend': 0, 'master.modWheel': 0,
    'transport.bpm': 120,
    'arp.on': 0, 'seq.on': 1, 'drum.on': 1, 'drum.master': 0.9,
  };
  for (let i = 0; i < DRUM_TRACK_COUNT; i++) {
    p[`drum.t${i}.vol`] = 0.85;
    p[`drum.t${i}.tune`] = 0;
    p[`drum.t${i}.decay`] = 0.3;
    p[`drum.t${i}.mute`] = 0;
  }
  return p;
}

function seqFromNotes(notes: (number | null)[], gate = 0.5, velocity = 0.85): SeqStep[] {
  return Array.from({ length: SEQ_LENGTH }, (_, i) => {
    const n = notes[i] ?? null;
    return { on: n !== null, note: n ?? 60, velocity, gate };
  });
}

function emptySeq(): SeqStep[] {
  return seqFromNotes(Array(SEQ_LENGTH).fill(null));
}

/** rows: map of track index → array of step indices that are ON. */
function drumFrom(rows: Record<number, number[]>): DrumCell[][] {
  const bank: DrumCell[][] = Array.from({ length: DRUM_TRACK_COUNT }, () =>
    Array.from({ length: SEQ_LENGTH }, () => ({ on: false, velocity: 0.85 } as DrumCell))
  );
  for (const [t, steps] of Object.entries(rows)) {
    for (const s of steps) {
      const cell = bank[Number(t)]?.[s];
      if (cell) cell.on = true;
    }
  }
  return bank;
}

function pad4Seq(a: SeqStep[], b: SeqStep[]): SeqStep[][] {
  return [a, b, a.map((s) => ({ ...s })), a.map((s) => ({ ...s }))];
}
function pad4Drum(a: DrumCell[][], b: DrumCell[][]): DrumCell[][][] {
  const copy = (g: DrumCell[][]) => g.map((r) => r.map((c) => ({ ...c })));
  return [a, b, copy(a), copy(a)];
}

// --- Knight Rider: relentless minor synth-bass ostinato with octave jumps ---
const KR_A = seqFromNotes(
  [36, 36, 48, 36, 36, 36, 48, 36, 39, 39, 51, 39, 34, 34, 46, 34], 0.4, 0.9);
const KR_B = seqFromNotes(
  [36, 36, 48, 36, 41, 41, 53, 41, 39, 39, 51, 39, 43, 43, 46, 48], 0.4, 0.9);
const KR_DRUM_A = drumFrom({
  0: [0, 6, 8, 14],                       // kick (galloping)
  1: [4, 12],                             // snare backbeat
  2: [0, 2, 4, 6, 8, 10, 12, 14],         // closed hat 8ths
});
const KR_DRUM_B = drumFrom({
  0: [0, 6, 8, 14], 1: [4, 12, 15],
  2: [0, 2, 4, 6, 8, 10, 12, 14], 3: [7],
});

// --- Zombie Nation / Kernkraft 400: the 4-bar A-minor hook. 8th-note grid
// (note on even steps), played as four distinct bars via the seq chain.
// MIDI: A4=69 C5=72 D5=74 E5=76 F5=77
// Bar 1: rest A  C  D  E  A  rest
// Bar 2: rest A  C  D  E  F  E   C
// Bar 3: D  rest rest C rest E  A
// Bar 4: (silent — melody drops out, drums carry the bar)
const ZN_1 = seqFromNotes(
  [null, null, 69, null, 72, null, 74, null, 76, null, 69, null, null, null, null, null], 0.9, 0.95);
const ZN_2 = seqFromNotes(
  [null, null, 69, null, 72, null, 74, null, 76, null, 77, null, 76, null, 72, null], 0.9, 0.95);
const ZN_3 = seqFromNotes(
  [74, null, null, null, null, null, 72, null, null, null, 76, null, 69, null, null, null], 0.9, 0.95);
const ZN_4 = seqFromNotes(
  [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null], 0.95, 0.95);
const ZN_DRUM_A = drumFrom({
  0: [0, 4, 8, 12],                       // four-on-the-floor
  7: [4, 12],                             // clap on the backbeat
  2: [0, 4, 8, 12],                       // closed hat on the beat
  3: [2, 6, 10, 14],                      // open hat offbeats
});
const ZN_DRUM_B = drumFrom({
  0: [0, 4, 8, 12], 7: [4, 12],
  2: [0, 2, 4, 6, 8, 10, 12, 14], 3: [2, 6, 10, 14], 1: [15],
});

// --- I Feel Love: hypnotic mono octave-pulse bass through a resonant ladder ---
const IFL_A = seqFromNotes(
  [45, 45, 57, 45, 45, 45, 57, 45, 45, 45, 57, 45, 45, 45, 57, 45], 0.5, 0.9);
const IFL_B = seqFromNotes(
  [45, 45, 57, 45, 48, 48, 60, 48, 52, 52, 64, 52, 50, 50, 62, 50], 0.5, 0.9);
const IFL_DRUM_A = drumFrom({
  0: [0, 4, 8, 12],                       // four-on-the-floor kick
  2: [0, 2, 4, 6, 8, 10, 12, 14],         // driving closed hats
  7: [4, 12],                             // clap backbeat
});
const IFL_DRUM_B = drumFrom({
  0: [0, 4, 8, 12], 2: [0, 2, 4, 6, 8, 10, 12, 14],
  3: [2, 6, 10, 14], 7: [4, 12], 1: [15], // + open-hat offbeats & pickup
});

// Drop-in demos: any *.json SongFile in ./demos is auto-registered at build
// time via Vite's static glob (no runtime fetch). Keyed by the file's `name`,
// ordered by filename, and spread *before* the hand-authored built-ins below
// so dropped-in songs lead the demo button row.
const DROPPED = import.meta.glob<SongFile>('./demos/*.json', {
  eager: true,
  import: 'default',
});
const droppedDemos: Record<string, SongFile> = {};
for (const path of Object.keys(DROPPED).sort()) {
  const song = DROPPED[path]!;
  droppedDemos[song.name] = song;
}

const BUILTIN_DEMOS: Record<string, SongFile> = {
  'Knight Rider': {
    format: 'websynth-song',
    version: 1,
    name: 'Knight Rider',
    params: {
      ...baseParams(),
      'voicing.mode': 0,            // mono
      'osc1.wave': 2, 'osc1.octave': -1, 'osc1.level': 0.8,
      'osc2.wave': 3, 'osc2.octave': -1, 'osc2.detune': -5, 'osc2.level': 0.45,
      'sub.wave': 0, 'sub.octave': -1, 'sub.level': 0.35,
      'mixer.glide': 0.05, 'glide.mode': 2,
      'filter.cutoff': 74, 'filter.resonance': 1.8, 'filter.drive': 1.6, 'filter.envAmount': 30,
      'env.amp.attack': 0.002, 'env.amp.decay': 0.18, 'env.amp.sustain': 0.55, 'env.amp.release': 0.12,
      'env.fil.attack': 0.002, 'env.fil.decay': 0.16, 'env.fil.sustain': 0.0, 'env.fil.release': 0.12,
      'fx.dist.on': 1, 'fx.dist.drive': 0.4, 'fx.dist.tone': 2600, 'fx.dist.mix': 0.5,
      'analog.drift': 0.15,
      'transport.bpm': 125,
    },
    seqBanks: pad4Seq(KR_A, KR_B),
    drumBanks: pad4Drum(KR_DRUM_A, KR_DRUM_B),
    seqChain: { enabled: true, steps: [0, 0, 1, 0] },   // A A B A
    drumChain: { enabled: true, steps: [0, 0, 0, 1] },
  },

  'Zombie Nation': {
    format: 'websynth-song',
    version: 1,
    name: 'Zombie Nation',
    params: {
      ...baseParams(),
      'voicing.mode': 0,            // mono lead
      // Dirty: saw + detuned square, fat unison beating, a little noise,
      // a driven resonant ladder and a distortion stage on top.
      'osc1.wave': 2, 'osc1.octave': 0, 'osc1.level': 0.85,
      'osc2.wave': 3, 'osc2.octave': 0, 'osc2.detune': 12, 'osc2.level': 0.65,
      'unison.voices': 3, 'unison.detune': 24,
      'mixer.noise': 0.06, 'mixer.glide': 0, 'glide.mode': 0,
      'filter.cutoff': 98, 'filter.resonance': 1.6, 'filter.drive': 2.8, 'filter.envAmount': 16,
      'env.amp.attack': 0.004, 'env.amp.decay': 0.25, 'env.amp.sustain': 0.65, 'env.amp.release': 0.14,
      'env.fil.attack': 0.004, 'env.fil.decay': 0.3, 'env.fil.sustain': 0.4, 'env.fil.release': 0.2,
      'fx.dist.on': 1, 'fx.dist.drive': 0.55, 'fx.dist.tone': 3000, 'fx.dist.mix': 0.85,
      'fx.delay.on': 1, 'fx.delay.time': 0.21, 'fx.delay.feedback': 0.3, 'fx.delay.mix': 0.22,
      'fx.reverb.on': 1, 'fx.reverb.size': 0.45, 'fx.reverb.damp': 0.5, 'fx.reverb.mix': 0.12,
      'analog.drift': 0.2,
      'transport.bpm': 130,
    },
    seqBanks: [ZN_1, ZN_2, ZN_3, ZN_4],
    drumBanks: pad4Drum(ZN_DRUM_A, ZN_DRUM_B),
    seqChain: { enabled: true, steps: [0, 1, 2, 3] },   // four distinct bars
    drumChain: { enabled: true, steps: [0, 0, 0, 1] },  // fill on bar 4
  },

  'I Feel Love': {
    format: 'websynth-song',
    version: 1,
    name: 'I Feel Love',
    params: {
      ...baseParams(),
      'voicing.mode': 0,            // mono
      'glide.mode': 0, 'mixer.glide': 0,            // staccato 16ths
      'osc1.wave': 2, 'osc1.octave': -1, 'osc1.level': 0.85,
      'osc2.wave': 3, 'osc2.octave': -1, 'osc2.detune': -7, 'osc2.level': 0.35,
      'sub.wave': 0, 'sub.octave': -1, 'sub.level': 0.4,
      'filter.cutoff': 60, 'filter.resonance': 1.5, 'filter.drive': 1.8,
      'filter.envAmount': 30,
      'env.amp.attack': 0.002, 'env.amp.decay': 0.16, 'env.amp.sustain': 0.5,
      'env.amp.release': 0.08,
      'env.fil.attack': 0.001, 'env.fil.decay': 0.18, 'env.fil.sustain': 0.15,
      'env.fil.release': 0.1,
      'lfo.rate': 0.5, 'lfo.amount': 0.25, 'lfo.wave': 0, 'lfo.dest': 1,
      'fx.delay.on': 1, 'fx.delay.time': 0.3, 'fx.delay.feedback': 0.32,
      'fx.delay.mix': 0.18,
      'fx.reverb.on': 1, 'fx.reverb.size': 0.4, 'fx.reverb.damp': 0.5,
      'fx.reverb.mix': 0.14,
      'analog.drift': 0.08,
      'transport.bpm': 125,
      'drum.master': 0.9,
    },
    seqBanks: pad4Seq(IFL_A, IFL_B),
    drumBanks: pad4Drum(IFL_DRUM_A, IFL_DRUM_B),
    seqChain: { enabled: true, steps: [0, 0, 0, 1] },   // A A A B
    drumChain: { enabled: true, steps: [0, 1] },
  },
};

// Drop-ins first (so "Apex Twin" precedes "Knight Rider"), then built-ins.
export const DEMO_SONGS: Record<string, SongFile> = {
  ...droppedDemos,
  ...BUILTIN_DEMOS,
};

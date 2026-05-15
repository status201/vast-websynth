/**
 * A complete song: every synth parameter + all sequencer/drum banks +
 * both chain lanes. Portable as a JSON file and storable in localStorage
 * slots (mirrors the Presets pattern in `preset.ts`).
 */
import type { ParamBus } from './params';
import type { PatternStore, SeqStep, DrumCell } from './patterns';
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
  version: 1;
  name: string;
  params: Record<string, number>;
  seqBanks: SeqStep[][];
  drumBanks: DrumCell[][][];
  seqChain: ChainData;
  drumChain: ChainData;
}

export const Song = {
  capture(bus: ParamBus, patterns: PatternStore, arr: Arrangement, name: string): SongFile {
    const snap = patterns.snapshot();
    return {
      format: 'websynth-song',
      version: 1,
      name,
      params: bus.snapshot(),
      seqBanks: snap.seqBanks,
      drumBanks: snap.drumBanks,
      seqChain: { enabled: arr.seq.enabled, steps: [...arr.seq.steps] },
      drumChain: { enabled: arr.drum.enabled, steps: [...arr.drum.steps] },
    };
  },

  apply(file: SongFile, bus: ParamBus, patterns: PatternStore, arr: Arrangement): void {
    bus.restore(file.params);
    patterns.restore({ seqBanks: file.seqBanks, drumBanks: file.drumBanks });
    arr.setSeqChain(file.seqChain?.steps ?? [0], file.seqChain?.enabled ?? false);
    arr.setDrumChain(file.drumChain?.steps ?? [0], file.drumChain?.enabled ?? false);
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

// --- Zombie Nation / Kernkraft 400: bouncy octave-popping saw lead ---
const ZN_A = seqFromNotes(
  [69, 81, 69, 69, 76, 69, 74, 69, 69, 81, 69, 69, 76, 74, 72, 71], 0.55, 0.95);
const ZN_B = seqFromNotes(
  [69, 81, 69, 69, 76, 69, 74, 69, 71, 72, 74, 76, 77, 76, 74, 72], 0.55, 0.95);
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

export const DEMO_SONGS: Record<string, SongFile> = {
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
      'osc1.wave': 2, 'osc1.octave': 0, 'osc1.level': 0.8,
      'osc2.wave': 2, 'osc2.octave': 0, 'osc2.detune': 9, 'osc2.level': 0.6,
      'unison.voices': 3, 'unison.detune': 16,
      'mixer.glide': 0, 'glide.mode': 0,
      'filter.cutoff': 104, 'filter.resonance': 0.8, 'filter.drive': 1.3, 'filter.envAmount': 14,
      'env.amp.attack': 0.004, 'env.amp.decay': 0.25, 'env.amp.sustain': 0.7, 'env.amp.release': 0.18,
      'env.fil.attack': 0.004, 'env.fil.decay': 0.3, 'env.fil.sustain': 0.4, 'env.fil.release': 0.2,
      'fx.delay.on': 1, 'fx.delay.time': 0.21, 'fx.delay.feedback': 0.3, 'fx.delay.mix': 0.22,
      'fx.reverb.on': 1, 'fx.reverb.size': 0.45, 'fx.reverb.damp': 0.5, 'fx.reverb.mix': 0.16,
      'analog.drift': 0.1,
      'transport.bpm': 130,
    },
    seqBanks: pad4Seq(ZN_A, ZN_B),
    drumBanks: pad4Drum(ZN_DRUM_A, ZN_DRUM_B),
    seqChain: { enabled: true, steps: [0, 0, 0, 1] },   // A A A B
    drumChain: { enabled: true, steps: [0, 1] },
  },
};

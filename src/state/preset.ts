import type { ParamBus } from './params';
import { roundParams } from './serialize';

const STORAGE_PREFIX = 'websynth.preset.';
const INDEX_KEY = 'websynth.preset.index';

export type Snapshot = Record<string, number>;

export interface FactoryBank {
  [name: string]: Snapshot;
}

const FACTORY: FactoryBank = {
  basic: {
    'osc1.wave': 2, 'osc1.octave': 0, 'osc1.detune': 0, 'osc1.level': 0.7,
    'osc2.wave': 2, 'osc2.octave': 0, 'osc2.detune': 7, 'osc2.level': 0.5,
    'mixer.noise': 0, 'mixer.glide': 0,
    'filter.cutoff': 95, 'filter.resonance': 0.6, 'filter.drive': 1.2, 'filter.envAmount': 20,
    'env.amp.attack': 0.005, 'env.amp.decay': 0.2, 'env.amp.sustain': 0.8, 'env.amp.release': 0.4,
    'env.fil.attack': 0.005, 'env.fil.decay': 0.5, 'env.fil.sustain': 0.2, 'env.fil.release': 0.4,
    'lfo.rate': 4, 'lfo.amount': 0, 'lfo.wave': 0, 'lfo.dest': 0,
    'fx.dist.on': 0, 'fx.wah.on': 0, 'fx.phaser.on': 0, 'fx.delay.on': 0, 'fx.reverb.on': 0,
    'master.volume': 0.8, 'voicing.mode': 1,
  },
  bass: {
    'osc1.wave': 2, 'osc1.octave': -1, 'osc1.detune': 0, 'osc1.level': 0.8,
    'osc2.wave': 3, 'osc2.octave': -1, 'osc2.detune': -7, 'osc2.level': 0.4,
    'mixer.noise': 0, 'mixer.glide': 0,
    'filter.cutoff': 72, 'filter.resonance': 1.6, 'filter.drive': 1.5, 'filter.envAmount': 30,
    'env.amp.attack': 0.002, 'env.amp.decay': 0.3, 'env.amp.sustain': 0.6, 'env.amp.release': 0.2,
    'env.fil.attack': 0.002, 'env.fil.decay': 0.18, 'env.fil.sustain': 0.0, 'env.fil.release': 0.2,
    'lfo.rate': 2, 'lfo.amount': 0, 'lfo.wave': 0, 'lfo.dest': 1,
    'fx.dist.on': 1, 'fx.dist.drive': 0.45, 'fx.dist.tone': 2500, 'fx.dist.mix': 0.5,
    'fx.delay.on': 0, 'fx.reverb.on': 0,
    'master.volume': 0.8, 'voicing.mode': 0,
  },
  lead: {
    'osc1.wave': 2, 'osc1.octave': 0, 'osc1.detune': -7, 'osc1.level': 0.7,
    'osc2.wave': 2, 'osc2.octave': 0, 'osc2.detune': 11, 'osc2.level': 0.6,
    'mixer.noise': 0, 'mixer.glide': 0.05,
    'filter.cutoff': 105, 'filter.resonance': 0.9, 'filter.drive': 1.3, 'filter.envAmount': 12,
    'env.amp.attack': 0.01, 'env.amp.decay': 0.3, 'env.amp.sustain': 0.85, 'env.amp.release': 0.3,
    'env.fil.attack': 0.01, 'env.fil.decay': 0.4, 'env.fil.sustain': 0.5, 'env.fil.release': 0.3,
    'lfo.rate': 5.5, 'lfo.amount': 0.2, 'lfo.wave': 0, 'lfo.dest': 2,
    'fx.delay.on': 1, 'fx.delay.time': 0.28, 'fx.delay.feedback': 0.35, 'fx.delay.mix': 0.25,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.5, 'fx.reverb.damp': 0.5, 'fx.reverb.mix': 0.2,
    'master.volume': 0.75, 'voicing.mode': 1,
  },
  pad: {
    'osc1.wave': 0, 'osc1.octave': 0, 'osc1.detune': -5, 'osc1.level': 0.6,
    'osc2.wave': 1, 'osc2.octave': 1, 'osc2.detune': 5, 'osc2.level': 0.6,
    'mixer.noise': 0.05, 'mixer.glide': 0,
    'filter.cutoff': 85, 'filter.resonance': 0.4, 'filter.drive': 1.0, 'filter.envAmount': 6,
    'env.amp.attack': 1.5, 'env.amp.decay': 1.0, 'env.amp.sustain': 1.0, 'env.amp.release': 2.5,
    'env.fil.attack': 1.0, 'env.fil.decay': 1.0, 'env.fil.sustain': 0.7, 'env.fil.release': 2.0,
    'lfo.rate': 0.3, 'lfo.amount': 0.3, 'lfo.wave': 0, 'lfo.dest': 1,
    'fx.phaser.on': 1, 'fx.phaser.rate': 0.2, 'fx.phaser.depth': 0.6, 'fx.phaser.feedback': 0.3,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.9, 'fx.reverb.damp': 0.3, 'fx.reverb.mix': 0.5,
    'master.volume': 0.7, 'voicing.mode': 1,
  },
  pluck: {
    'osc1.wave': 3, 'osc1.octave': 0, 'osc1.detune': 0, 'osc1.level': 0.7,
    'osc2.wave': 2, 'osc2.octave': 0, 'osc2.detune': 5, 'osc2.level': 0.3,
    'mixer.noise': 0.1, 'mixer.glide': 0,
    'filter.cutoff': 95, 'filter.resonance': 1.8, 'filter.drive': 1.2, 'filter.envAmount': 36,
    'env.amp.attack': 0.001, 'env.amp.decay': 0.18, 'env.amp.sustain': 0.0, 'env.amp.release': 0.25,
    'env.fil.attack': 0.001, 'env.fil.decay': 0.12, 'env.fil.sustain': 0.0, 'env.fil.release': 0.2,
    'lfo.rate': 4, 'lfo.amount': 0, 'lfo.wave': 0, 'lfo.dest': 0,
    'fx.delay.on': 1, 'fx.delay.time': 0.22, 'fx.delay.feedback': 0.45, 'fx.delay.mix': 0.3,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.4, 'fx.reverb.damp': 0.4, 'fx.reverb.mix': 0.25,
    'master.volume': 0.8, 'voicing.mode': 1,
  },
  wobble: {
    'osc1.wave': 2, 'osc1.octave': -1, 'osc1.detune': 0, 'osc1.level': 0.7,
    'osc2.wave': 3, 'osc2.octave': -1, 'osc2.detune': 9, 'osc2.level': 0.5,
    'mixer.noise': 0, 'mixer.glide': 0,
    'filter.cutoff': 70, 'filter.resonance': 2.6, 'filter.drive': 2.0, 'filter.envAmount': 0,
    'env.amp.attack': 0.005, 'env.amp.decay': 0.4, 'env.amp.sustain': 1.0, 'env.amp.release': 0.3,
    'env.fil.attack': 0.005, 'env.fil.decay': 0.4, 'env.fil.sustain': 0, 'env.fil.release': 0.2,
    'lfo.rate': 3.0, 'lfo.amount': 0.9, 'lfo.wave': 0, 'lfo.dest': 1,
    'fx.dist.on': 1, 'fx.dist.drive': 0.5, 'fx.dist.tone': 2200, 'fx.dist.mix': 0.6,
    'master.volume': 0.75, 'voicing.mode': 0,
  },
};

export const Presets = {
  factory(): FactoryBank { return FACTORY; },

  list(): string[] {
    const ix = readIndex();
    return [...new Set([...Object.keys(FACTORY), ...ix])].sort();
  },

  ensureFactoryPresets(): void {
    for (const [name, snap] of Object.entries(FACTORY)) {
      if (!localStorage.getItem(STORAGE_PREFIX + name)) {
        localStorage.setItem(STORAGE_PREFIX + name, JSON.stringify(snap));
      }
    }
    const ix = readIndex();
    let changed = false;
    for (const n of Object.keys(FACTORY)) {
      if (!ix.includes(n)) { ix.push(n); changed = true; }
    }
    if (changed) writeIndex(ix);
  },

  load(name: string): Snapshot | null {
    const raw = localStorage.getItem(STORAGE_PREFIX + name);
    if (!raw) return FACTORY[name] ?? null;
    try { return JSON.parse(raw) as Snapshot; }
    catch { return null; }
  },

  save(name: string, snap: Snapshot): void {
    // Round at the serialization boundary (same helper as song export) — clean
    // JSON, no audible change. capture() keeps live state full-precision.
    localStorage.setItem(STORAGE_PREFIX + name, JSON.stringify(roundParams(snap)));
    const ix = readIndex();
    if (!ix.includes(name)) { ix.push(name); writeIndex(ix); }
  },

  capture(bus: ParamBus): Snapshot {
    return bus.snapshot();
  },

  apply(bus: ParamBus, snap: Snapshot): void {
    bus.restore(snap);
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

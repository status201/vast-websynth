import type { ParamBus } from './params';
import { roundParams } from './serialize';
import { sameSnapshot } from './preset-file';
import { SlotStore } from './slot-store';
import { RESERVED_KEYS } from './limits';

const store = new SlotStore('websynth.preset.');

export type Snapshot = Record<string, number>;

export interface FactoryBank {
  [name: string]: Snapshot;
}

// Every factory preset sets the FULL sound — all osc/sub/unison/drift/mixer/
// glide/filter/env/LFO params plus every synth-FX `.on` flag — so switching
// between presets never leaks a param from the previous patch (REQ-2b).
const FACTORY: FactoryBank = {
  basic: {
    'osc1.wave': 2, 'osc1.octave': 0, 'osc1.detune': 0, 'osc1.level': 0.7,
    'osc2.wave': 2, 'osc2.octave': 0, 'osc2.detune': 7, 'osc2.level': 0.5,
    'sub.wave': 0, 'sub.octave': -1, 'sub.level': 0,
    'unison.voices': 1, 'unison.detune': 12, 'analog.drift': 0,
    'mixer.noise': 0, 'mixer.glide': 0, 'glide.mode': 1,
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
    'sub.wave': 0, 'sub.octave': -1, 'sub.level': 0,
    'unison.voices': 1, 'unison.detune': 12, 'analog.drift': 0,
    'mixer.noise': 0, 'mixer.glide': 0, 'glide.mode': 1,
    'filter.cutoff': 72, 'filter.resonance': 1.6, 'filter.drive': 1.5, 'filter.envAmount': 30,
    'env.amp.attack': 0.002, 'env.amp.decay': 0.3, 'env.amp.sustain': 0.6, 'env.amp.release': 0.2,
    'env.fil.attack': 0.002, 'env.fil.decay': 0.18, 'env.fil.sustain': 0.0, 'env.fil.release': 0.2,
    'lfo.rate': 2, 'lfo.amount': 0, 'lfo.wave': 0, 'lfo.dest': 1,
    'fx.dist.on': 1, 'fx.dist.drive': 0.45, 'fx.dist.tone': 2500, 'fx.dist.mix': 0.5,
    'fx.wah.on': 0, 'fx.phaser.on': 0, 'fx.delay.on': 0, 'fx.reverb.on': 0,
    'master.volume': 0.8, 'voicing.mode': 0,
  },
  lead: {
    'osc1.wave': 2, 'osc1.octave': 0, 'osc1.detune': -7, 'osc1.level': 0.7,
    'osc2.wave': 2, 'osc2.octave': 0, 'osc2.detune': 11, 'osc2.level': 0.6,
    'sub.wave': 0, 'sub.octave': -1, 'sub.level': 0,
    'unison.voices': 1, 'unison.detune': 12, 'analog.drift': 0,
    'mixer.noise': 0, 'mixer.glide': 0.05, 'glide.mode': 1,
    'filter.cutoff': 105, 'filter.resonance': 0.9, 'filter.drive': 1.3, 'filter.envAmount': 12,
    'env.amp.attack': 0.01, 'env.amp.decay': 0.3, 'env.amp.sustain': 0.85, 'env.amp.release': 0.3,
    'env.fil.attack': 0.01, 'env.fil.decay': 0.4, 'env.fil.sustain': 0.5, 'env.fil.release': 0.3,
    'lfo.rate': 5.5, 'lfo.amount': 0.2, 'lfo.wave': 0, 'lfo.dest': 2,
    'fx.dist.on': 0, 'fx.wah.on': 0, 'fx.phaser.on': 0,
    'fx.delay.on': 1, 'fx.delay.time': 0.28, 'fx.delay.feedback': 0.35, 'fx.delay.mix': 0.25,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.5, 'fx.reverb.damp': 0.5, 'fx.reverb.mix': 0.2,
    'master.volume': 0.75, 'voicing.mode': 1,
  },
  pad: {
    'osc1.wave': 0, 'osc1.octave': 0, 'osc1.detune': -5, 'osc1.level': 0.6,
    'osc2.wave': 1, 'osc2.octave': 1, 'osc2.detune': 5, 'osc2.level': 0.6,
    'sub.wave': 0, 'sub.octave': -1, 'sub.level': 0,
    'unison.voices': 1, 'unison.detune': 12, 'analog.drift': 0,
    'mixer.noise': 0.05, 'mixer.glide': 0, 'glide.mode': 1,
    'filter.cutoff': 85, 'filter.resonance': 0.4, 'filter.drive': 1.0, 'filter.envAmount': 6,
    'env.amp.attack': 1.5, 'env.amp.decay': 1.0, 'env.amp.sustain': 1.0, 'env.amp.release': 2.5,
    'env.fil.attack': 1.0, 'env.fil.decay': 1.0, 'env.fil.sustain': 0.7, 'env.fil.release': 2.0,
    'lfo.rate': 0.3, 'lfo.amount': 0.3, 'lfo.wave': 0, 'lfo.dest': 1,
    'fx.dist.on': 0, 'fx.wah.on': 0,
    'fx.phaser.on': 1, 'fx.phaser.rate': 0.2, 'fx.phaser.depth': 0.6, 'fx.phaser.feedback': 0.3,
    'fx.delay.on': 0,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.9, 'fx.reverb.damp': 0.3, 'fx.reverb.mix': 0.5,
    'master.volume': 0.7, 'voicing.mode': 1,
  },
  pluck: {
    'osc1.wave': 3, 'osc1.octave': 0, 'osc1.detune': 0, 'osc1.level': 0.7,
    'osc2.wave': 2, 'osc2.octave': 0, 'osc2.detune': 5, 'osc2.level': 0.3,
    'sub.wave': 0, 'sub.octave': -1, 'sub.level': 0,
    'unison.voices': 1, 'unison.detune': 12, 'analog.drift': 0,
    'mixer.noise': 0.1, 'mixer.glide': 0, 'glide.mode': 1,
    'filter.cutoff': 95, 'filter.resonance': 1.8, 'filter.drive': 1.2, 'filter.envAmount': 36,
    'env.amp.attack': 0.001, 'env.amp.decay': 0.18, 'env.amp.sustain': 0.0, 'env.amp.release': 0.25,
    'env.fil.attack': 0.001, 'env.fil.decay': 0.12, 'env.fil.sustain': 0.0, 'env.fil.release': 0.2,
    'lfo.rate': 4, 'lfo.amount': 0, 'lfo.wave': 0, 'lfo.dest': 0,
    'fx.dist.on': 0, 'fx.wah.on': 0, 'fx.phaser.on': 0,
    'fx.delay.on': 1, 'fx.delay.time': 0.22, 'fx.delay.feedback': 0.45, 'fx.delay.mix': 0.3,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.4, 'fx.reverb.damp': 0.4, 'fx.reverb.mix': 0.25,
    'master.volume': 0.8, 'voicing.mode': 1,
  },
  wobble: {
    'osc1.wave': 2, 'osc1.octave': -1, 'osc1.detune': 0, 'osc1.level': 0.7,
    'osc2.wave': 3, 'osc2.octave': -1, 'osc2.detune': 9, 'osc2.level': 0.5,
    'sub.wave': 0, 'sub.octave': -1, 'sub.level': 0,
    'unison.voices': 1, 'unison.detune': 12, 'analog.drift': 0,
    'mixer.noise': 0, 'mixer.glide': 0, 'glide.mode': 1,
    'filter.cutoff': 70, 'filter.resonance': 2.6, 'filter.drive': 2.0, 'filter.envAmount': 0,
    'env.amp.attack': 0.005, 'env.amp.decay': 0.4, 'env.amp.sustain': 1.0, 'env.amp.release': 0.3,
    'env.fil.attack': 0.005, 'env.fil.decay': 0.4, 'env.fil.sustain': 0, 'env.fil.release': 0.2,
    'lfo.rate': 3.0, 'lfo.amount': 0.9, 'lfo.wave': 0, 'lfo.dest': 1,
    'fx.dist.on': 1, 'fx.dist.drive': 0.5, 'fx.dist.tone': 2200, 'fx.dist.mix': 0.6,
    'fx.wah.on': 0, 'fx.phaser.on': 0, 'fx.delay.on': 0, 'fx.reverb.on': 0,
    'master.volume': 0.75, 'voicing.mode': 0,
  },
  // Basses — acoustic, electric, DnB reese, 303 acid.
  upright: {
    'osc1.wave': 1, 'osc1.octave': -1, 'osc1.detune': 0, 'osc1.level': 0.8,
    'osc2.wave': 0, 'osc2.octave': -1, 'osc2.detune': 0, 'osc2.level': 0.5,
    'sub.wave': 0, 'sub.octave': -1, 'sub.level': 0,
    'unison.voices': 1, 'unison.detune': 12, 'analog.drift': 0.05,
    'mixer.noise': 0.04, 'mixer.glide': 0.04, 'glide.mode': 2,
    'filter.cutoff': 64, 'filter.resonance': 0.3, 'filter.drive': 1.4, 'filter.envAmount': 14,
    'env.amp.attack': 0.003, 'env.amp.decay': 1.2, 'env.amp.sustain': 0.3, 'env.amp.release': 0.25,
    'env.fil.attack': 0.001, 'env.fil.decay': 0.25, 'env.fil.sustain': 0, 'env.fil.release': 0.3,
    'lfo.rate': 4, 'lfo.amount': 0, 'lfo.wave': 0, 'lfo.dest': 0,
    'fx.dist.on': 0, 'fx.wah.on': 0, 'fx.phaser.on': 0, 'fx.delay.on': 0, 'fx.reverb.on': 0,
    'master.volume': 0.8, 'voicing.mode': 0,
  },
  pbass: {
    'osc1.wave': 1, 'osc1.octave': -1, 'osc1.detune': 0, 'osc1.level': 0.8,
    'osc2.wave': 3, 'osc2.octave': -1, 'osc2.detune': 0, 'osc2.level': 0.3,
    'sub.wave': 0, 'sub.octave': -1, 'sub.level': 0,
    'unison.voices': 1, 'unison.detune': 12, 'analog.drift': 0,
    'mixer.noise': 0.02, 'mixer.glide': 0, 'glide.mode': 1,
    'filter.cutoff': 74, 'filter.resonance': 0.5, 'filter.drive': 1.8, 'filter.envAmount': 18,
    'env.amp.attack': 0.002, 'env.amp.decay': 0.7, 'env.amp.sustain': 0.5, 'env.amp.release': 0.12,
    'env.fil.attack': 0.001, 'env.fil.decay': 0.15, 'env.fil.sustain': 0.1, 'env.fil.release': 0.2,
    'lfo.rate': 4, 'lfo.amount': 0, 'lfo.wave': 0, 'lfo.dest': 0,
    'fx.dist.on': 0, 'fx.wah.on': 0, 'fx.phaser.on': 0, 'fx.delay.on': 0, 'fx.reverb.on': 0,
    'master.volume': 0.8, 'voicing.mode': 0,
  },
  reese: {
    'osc1.wave': 2, 'osc1.octave': -1, 'osc1.detune': -14, 'osc1.level': 0.7,
    'osc2.wave': 2, 'osc2.octave': -1, 'osc2.detune': 14, 'osc2.level': 0.7,
    'sub.wave': 0, 'sub.octave': -1, 'sub.level': 0.5,
    'unison.voices': 2, 'unison.detune': 22, 'analog.drift': 0.1,
    'mixer.noise': 0, 'mixer.glide': 0, 'glide.mode': 1,
    'filter.cutoff': 58, 'filter.resonance': 0.7, 'filter.drive': 2.2, 'filter.envAmount': 0,
    'env.amp.attack': 0.004, 'env.amp.decay': 0.3, 'env.amp.sustain': 1.0, 'env.amp.release': 0.15,
    'env.fil.attack': 0.005, 'env.fil.decay': 0.3, 'env.fil.sustain': 1.0, 'env.fil.release': 0.3,
    'lfo.rate': 2, 'lfo.amount': 0, 'lfo.wave': 0, 'lfo.dest': 1,
    'fx.dist.on': 1, 'fx.dist.drive': 0.4, 'fx.dist.tone': 1800, 'fx.dist.mix': 0.45,
    'fx.wah.on': 0, 'fx.phaser.on': 0, 'fx.delay.on': 0, 'fx.reverb.on': 0,
    'master.volume': 0.75, 'voicing.mode': 0,
  },
  acid: {
    'osc1.wave': 2, 'osc1.octave': -1, 'osc1.detune': 0, 'osc1.level': 0.85,
    'osc2.wave': 3, 'osc2.octave': -1, 'osc2.detune': 0, 'osc2.level': 0,
    'sub.wave': 0, 'sub.octave': -1, 'sub.level': 0,
    'unison.voices': 1, 'unison.detune': 12, 'analog.drift': 0,
    'mixer.noise': 0, 'mixer.glide': 0.055, 'glide.mode': 2,
    'filter.cutoff': 60, 'filter.resonance': 3.2, 'filter.drive': 2.5, 'filter.envAmount': 32,
    'env.amp.attack': 0.001, 'env.amp.decay': 0.25, 'env.amp.sustain': 0.6, 'env.amp.release': 0.08,
    'env.fil.attack': 0.001, 'env.fil.decay': 0.22, 'env.fil.sustain': 0, 'env.fil.release': 0.18,
    'lfo.rate': 4, 'lfo.amount': 0, 'lfo.wave': 0, 'lfo.dest': 0,
    'fx.dist.on': 1, 'fx.dist.drive': 0.55, 'fx.dist.tone': 3200, 'fx.dist.mix': 0.5,
    'fx.wah.on': 0, 'fx.phaser.on': 0,
    'fx.delay.on': 1, 'fx.delay.time': 0.375, 'fx.delay.feedback': 0.4, 'fx.delay.mix': 0.2,
    'fx.reverb.on': 0,
    'master.volume': 0.7, 'voicing.mode': 0,
  },
  // Keys — acoustic piano, electric piano, tonewheel organ, bells.
  piano: {
    'osc1.wave': 2, 'osc1.octave': 0, 'osc1.detune': -3, 'osc1.level': 0.55,
    'osc2.wave': 1, 'osc2.octave': 1, 'osc2.detune': 3, 'osc2.level': 0.35,
    'sub.wave': 0, 'sub.octave': -1, 'sub.level': 0,
    'unison.voices': 1, 'unison.detune': 12, 'analog.drift': 0,
    'mixer.noise': 0.02, 'mixer.glide': 0, 'glide.mode': 1,
    'filter.cutoff': 100, 'filter.resonance': 0.15, 'filter.drive': 1.0, 'filter.envAmount': 24,
    'env.amp.attack': 0.001, 'env.amp.decay': 3.0, 'env.amp.sustain': 0, 'env.amp.release': 0.3,
    'env.fil.attack': 0.001, 'env.fil.decay': 0.9, 'env.fil.sustain': 0.1, 'env.fil.release': 0.4,
    'lfo.rate': 4, 'lfo.amount': 0, 'lfo.wave': 0, 'lfo.dest': 0,
    'fx.dist.on': 0, 'fx.wah.on': 0, 'fx.phaser.on': 0, 'fx.delay.on': 0,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.35, 'fx.reverb.damp': 0.5, 'fx.reverb.mix': 0.12,
    'master.volume': 0.8, 'voicing.mode': 1,
  },
  rhodes: {
    'osc1.wave': 0, 'osc1.octave': 0, 'osc1.detune': 0, 'osc1.level': 0.8,
    'osc2.wave': 1, 'osc2.octave': 1, 'osc2.detune': 4, 'osc2.level': 0.16,
    'sub.wave': 0, 'sub.octave': -1, 'sub.level': 0,
    'unison.voices': 1, 'unison.detune': 12, 'analog.drift': 0,
    'mixer.noise': 0, 'mixer.glide': 0, 'glide.mode': 1,
    'filter.cutoff': 90, 'filter.resonance': 0.2, 'filter.drive': 1.0, 'filter.envAmount': 22,
    'env.amp.attack': 0.001, 'env.amp.decay': 2.2, 'env.amp.sustain': 0, 'env.amp.release': 0.35,
    'env.fil.attack': 0.001, 'env.fil.decay': 0.5, 'env.fil.sustain': 0.12, 'env.fil.release': 0.3,
    'lfo.rate': 2.5, 'lfo.amount': 0.60, 'lfo.wave': 0, 'lfo.dest': 3,
    'fx.dist.on': 0, 'fx.wah.on': 0, 'fx.phaser.on': 0, 'fx.delay.on': 0,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.4, 'fx.reverb.damp': 0.5, 'fx.reverb.mix': 0.15,
    'master.volume': 0.8, 'voicing.mode': 1,
  },
  b3: {
    'osc1.wave': 0, 'osc1.octave': 0, 'osc1.detune': 0, 'osc1.level': 0.8,
    'osc2.wave': 0, 'osc2.octave': 1, 'osc2.detune': 0, 'osc2.level': 0.45,
    'sub.wave': 0, 'sub.octave': -1, 'sub.level': 0.6,
    'unison.voices': 1, 'unison.detune': 12, 'analog.drift': 0,
    'mixer.noise': 0.02, 'mixer.glide': 0, 'glide.mode': 1,
    'filter.cutoff': 112, 'filter.resonance': 0.1, 'filter.drive': 1.5, 'filter.envAmount': 0,
    'env.amp.attack': 0.003, 'env.amp.decay': 0.05, 'env.amp.sustain': 1.0, 'env.amp.release': 0.02,
    'env.fil.attack': 0.001, 'env.fil.decay': 0.2, 'env.fil.sustain': 1.0, 'env.fil.release': 0.1,
    'lfo.rate': 6.8, 'lfo.amount': 0.02, 'lfo.wave': 0, 'lfo.dest': 2, 'fx.dist.on': 0, 
    'fx.wah.on': 1, 'fx.wah.rate':6.8, 'fx.wah.depth': 0.01, 'fx.wah.q': 4,  
    'fx.phaser.on': 0, 'fx.delay.on': 0,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.3, 'fx.reverb.damp': 0.5, 'fx.reverb.mix': 0.12,
    'master.volume': 0.75, 'voicing.mode': 1,
  },
  bells: {
    'osc1.wave': 0, 'osc1.octave': 0, 'osc1.detune': 0, 'osc1.level': 0.7,
    'osc2.wave': 0, 'osc2.octave': 2, 'osc2.detune': 5, 'osc2.level': 0.35,
    'sub.wave': 0, 'sub.octave': -1, 'sub.level': 0,
    'unison.voices': 1, 'unison.detune': 12, 'analog.drift': 0,
    'mixer.noise': 0, 'mixer.glide': 0, 'glide.mode': 1,
    'filter.cutoff': 110, 'filter.resonance': 0.6, 'filter.drive': 1.0, 'filter.envAmount': 10,
    'env.amp.attack': 0.001, 'env.amp.decay': 2.8, 'env.amp.sustain': 0, 'env.amp.release': 1.5,
    'env.fil.attack': 0.001, 'env.fil.decay': 1.5, 'env.fil.sustain': 0, 'env.fil.release': 1.0,
    'lfo.rate': 4, 'lfo.amount': 0, 'lfo.wave': 0, 'lfo.dest': 0,
    'fx.dist.on': 0, 'fx.wah.on': 0, 'fx.phaser.on': 0,
    'fx.delay.on': 1, 'fx.delay.time': 0.42, 'fx.delay.feedback': 0.45, 'fx.delay.mix': 0.28,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.8, 'fx.reverb.damp': 0.25, 'fx.reverb.mix': 0.4,
    'master.volume': 0.75, 'voicing.mode': 1,
  },
  // Ensemble/poly — string machine, synth brass.
  solina: {
    'osc1.wave': 2, 'osc1.octave': 0, 'osc1.detune': -6, 'osc1.level': 0.6,
    'osc2.wave': 2, 'osc2.octave': 0, 'osc2.detune': 6, 'osc2.level': 0.6,
    'sub.wave': 0, 'sub.octave': -1, 'sub.level': 0,
    'unison.voices': 3, 'unison.detune': 16, 'analog.drift': 0.2,
    'mixer.noise': 0, 'mixer.glide': 0, 'glide.mode': 1,
    'filter.cutoff': 96, 'filter.resonance': 0.2, 'filter.drive': 1.0, 'filter.envAmount': 0,
    'env.amp.attack': 0.3, 'env.amp.decay': 0.5, 'env.amp.sustain': 0.85, 'env.amp.release': 0.9,
    'env.fil.attack': 0.2, 'env.fil.decay': 0.5, 'env.fil.sustain': 0.6, 'env.fil.release': 0.6,
    'lfo.rate': 5.5, 'lfo.amount': 0.03, 'lfo.wave': 0, 'lfo.dest': 2,
    'fx.dist.on': 0, 'fx.wah.on': 0,
    'fx.phaser.on': 1, 'fx.phaser.rate': 0.3, 'fx.phaser.depth': 0.5, 'fx.phaser.feedback': 0.3, 'fx.phaser.mix': 0.35,
    'fx.delay.on': 0,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.7, 'fx.reverb.damp': 0.4, 'fx.reverb.mix': 0.3,
    'master.volume': 0.7, 'voicing.mode': 1,
  },
  brass: {
    'osc1.wave': 2, 'osc1.octave': 0, 'osc1.detune': 0, 'osc1.level': 0.75,
    'osc2.wave': 2, 'osc2.octave': 0, 'osc2.detune': 8, 'osc2.level': 0.55,
    'sub.wave': 0, 'sub.octave': -1, 'sub.level': 0,
    'unison.voices': 2, 'unison.detune': 12, 'analog.drift': 0.1,
    'mixer.noise': 0, 'mixer.glide': 0, 'glide.mode': 1,
    'filter.cutoff': 76, 'filter.resonance': 0.4, 'filter.drive': 1.8, 'filter.envAmount': 26,
    'env.amp.attack': 0.04, 'env.amp.decay': 0.2, 'env.amp.sustain': 0.9, 'env.amp.release': 0.25,
    'env.fil.attack': 0.06, 'env.fil.decay': 0.25, 'env.fil.sustain': 0.55, 'env.fil.release': 0.25,
    'lfo.rate': 5, 'lfo.amount': 0.01, 'lfo.wave': 0, 'lfo.dest': 2,
    'fx.dist.on': 0, 'fx.wah.on': 0, 'fx.phaser.on': 0, 'fx.delay.on': 0,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.5, 'fx.reverb.damp': 0.5, 'fx.reverb.mix': 0.15,
    'master.volume': 0.75, 'voicing.mode': 1,
  },
};

export const Presets = {
  factory(): FactoryBank { return FACTORY; },

  list(): string[] {
    return [...new Set([...Object.keys(FACTORY), ...store.readIndex()])].sort();
  },

  ensureFactoryPresets(): void {
    for (const [name, snap] of Object.entries(FACTORY)) {
      if (!store.readRaw(name)) store.writeRaw(name, JSON.stringify(snap));
    }
    const ix = store.readIndex();
    let changed = false;
    for (const n of Object.keys(FACTORY)) {
      if (!ix.includes(n)) { ix.push(n); changed = true; }
    }
    if (changed) store.writeIndex(ix);
  },

  /**
   * A stored snapshot, else the factory one of that name.
   *
   * Validated, not cast (untrusted-input.md REQ-8). The *import* path already
   * validates, so this only guards tampered/corrupt storage — but a string value
   * here survives `clamp` (`'abc' < 30` is false) and reaches an `AudioParam` as
   * `NaN`, which throws. Non-numeric entries are dropped rather than failing the
   * whole preset: a partially-readable sound still loads, and every id the bus
   * knows has a default underneath it (ADR-006).
   */
  load(name: string): Snapshot | null {
    const raw = store.readRaw(name);
    if (!raw) return FACTORY[name] ?? null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
      const snap: Snapshot = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (RESERVED_KEYS.includes(k)) continue;
        if (typeof v === 'number' && Number.isFinite(v)) snap[k] = v;
      }
      return snap;
    } catch { return null; }
  },

  save(name: string, snap: Snapshot): void {
    // Round at the serialization boundary (same helper as song export) — clean
    // JSON, no audible change. capture() keeps live state full-precision.
    store.writeRaw(name, JSON.stringify(roundParams(snap)));
    store.addToIndex(name);
  },

  capture(bus: ParamBus): Snapshot {
    return bus.snapshot();
  },

  apply(bus: ParamBus, snap: Snapshot): void {
    bus.restore(snap);
  },

  /**
   * Every preset the user actually made or changed — presets.md REQ-8. Derived,
   * never tracked: a name absent from `FACTORY` is user-made, and a factory name
   * counts when its stored snapshot differs from the factory definition. No
   * dirty flag is persisted, so this can never go stale or need migrating.
   */
  modified(): string[] {
    return Presets.list().filter((name) => {
      const stored = Presets.load(name);
      if (!stored) return false;
      const factory = FACTORY[name];
      return factory ? !sameSnapshot(factory, stored) : true;
    });
  },

  /** Snapshots for a list of names, skipping any that fail to load. */
  entries(names: readonly string[]): Record<string, Snapshot> {
    const out: Record<string, Snapshot> = {};
    for (const n of names) {
      const snap = Presets.load(n);
      if (snap) out[n] = snap;
    }
    return out;
  },
};

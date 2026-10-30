import { savedParams, type ParamBus } from './params';
import { roundParams } from './serialize';
import { sameSnapshot } from './preset-file';
import { SlotStore } from './slot-store';
import { RESERVED_KEYS } from './limits';
import { cleanName } from './names';
import { MOD_ROWS, MOD_SRC, MOD_DST } from './mod-routing';
import { inPreset } from './preset-session';

const store = new SlotStore('websynth.preset.');

export type Snapshot = Record<string, number>;

export interface FactoryBank {
  [name: string]: Snapshot;
}

/**
 * Every bank's starting point, spread first and then overridden (presets.md
 * REQ-a-factory-preset-sets-the-full-sound, v14). Spreading it makes every bank the full sound while
 * each one lists only what defines it, so a bank file stands on its own. (Since
 * v15 `Presets.apply` also resets what a preset omits, which is what protects
 * user presets; this keeps the factory banks explicit.)
 *
 * Two kinds of entry:
 * - **Off**: the oscillators' cross-modulation, sync and pulse widths, every
 *   mod-matrix row, every effect but the reverb. These are the params that slipped
 *   through one at a time before the loader reset; a route to `fm` left playing
 *   under the next preset was the loudest case.
 * - **Shared**: what at least half the banks already set to the same value (no
 *   sub, one unison voice, both LFOs parked). Factored out when the five
 *   cross-mod showcases pushed the entry chunk over its ceiling — resolved banks
 *   are identical to the spelled-out ones.
 *
 * `fx.reverb.on` stays in every bank: most have it on, but an effect that is on
 * by default would switch on, unasked, in a bank that forgot it. `osc2.syncPitch` and a row's `dst`/`amt` are inert while sync or the row is
 * off, so only a bank that engages them sets them.
 */
const PLAIN_VOICE: Snapshot = {
  // Off
  'osc1.pulseWidth': 0.5, 'osc2.pulseWidth': 0.5,
  'osc1.fm': 0, 'osc1.ring': 0, 'osc2.sync': 0,
  ...Object.fromEntries(Array.from({ length: MOD_ROWS }, (_, n) => [`mod.${n}.src`, MOD_SRC.off])),
  'fx.eq.on': 0, 'fx.dist.on': 0, 'fx.wah.on': 0, 'fx.phaser.on': 0, 'fx.flanger.on': 0, 'fx.chorus.on': 0,
  'fx.delay.on': 0, 'fx.duck.on': 0,
  // Shared
  'osc1.octave': 0, 'osc1.detune': 0,
  'sub.wave': 0, 'sub.octave': -1, 'sub.level': 0,
  'unison.voices': 1, 'unison.detune': 12, 'analog.drift': 0,
  'mixer.noise': 0, 'mixer.glide': 0, 'glide.mode': 1,
  'filter.model': 0, 'filter.shape': 0, 'filter.keytrack': 0,
  'env.fil.attack': 0.001,
  'lfo.rate': 4, 'lfo.amount': 0, 'lfo.wave': 0, 'lfo.dest': 0, 'lfo.sync': 0,
  'lfo2.rate': 4, 'lfo2.amount': 0, 'lfo2.wave': 0, 'lfo2.dest': 0, 'lfo2.sync': 0,
  'voicing.mode': 1,
};

// Every factory preset sets the FULL sound — all osc/sub/unison/drift/mixer/
// glide/filter/env/LFO params plus every synth-FX `.on` flag, most of them through
// PLAIN_VOICE — so switching between presets never leaks a param from the previous
// patch (REQ-a-factory-preset-sets-the-full-sound).
const FACTORY: FactoryBank = {
  basic: {
    ...PLAIN_VOICE,
    'osc1.wave': 2, 'osc1.level': 0.7,
    'osc2.wave': 2, 'osc2.octave': 0, 'osc2.detune': 7, 'osc2.level': 0.5,
    'filter.cutoff': 95, 'filter.resonance': 0.6, 'filter.drive': 1.2, 'filter.envAmount': 20,
    'env.amp.attack': 0.005, 'env.amp.decay': 0.2, 'env.amp.sustain': 0.8, 'env.amp.release': 0.4,
    'env.fil.attack': 0.005, 'env.fil.decay': 0.5, 'env.fil.sustain': 0.2, 'env.fil.release': 0.4,
    'fx.reverb.on': 0,
    'master.volume': 0.8,
  },
  bass: {
    ...PLAIN_VOICE,
    'osc1.wave': 2, 'osc1.octave': -1, 'osc1.level': 0.8,
    'osc2.wave': 3, 'osc2.octave': -1, 'osc2.detune': -7, 'osc2.level': 0.4,
    'filter.cutoff': 72, 'filter.resonance': 1.6, 'filter.drive': 1.5, 'filter.envAmount': 30,
    'env.amp.attack': 0.002, 'env.amp.decay': 0.3, 'env.amp.sustain': 0.6, 'env.amp.release': 0.2,
    'env.fil.attack': 0.002, 'env.fil.decay': 0.18, 'env.fil.sustain': 0.0, 'env.fil.release': 0.2,
    'lfo.rate': 2, 'lfo.dest': 1,
    'fx.dist.on': 1, 'fx.dist.drive': 0.45, 'fx.dist.tone': 2500, 'fx.dist.mix': 0.5,
    'fx.reverb.on': 0,
    'master.volume': 0.8, 'voicing.mode': 0,
  },
  lead: {
    ...PLAIN_VOICE,
    'osc1.wave': 2, 'osc1.detune': -7, 'osc1.level': 0.7,
    'osc2.wave': 2, 'osc2.octave': 0, 'osc2.detune': 11, 'osc2.level': 0.6,
    'mixer.glide': 0.05,
    'filter.cutoff': 105, 'filter.resonance': 0.9, 'filter.drive': 1.3, 'filter.envAmount': 12,
    'env.amp.attack': 0.01, 'env.amp.decay': 0.3, 'env.amp.sustain': 0.85, 'env.amp.release': 0.3,
    'env.fil.attack': 0.01, 'env.fil.decay': 0.4, 'env.fil.sustain': 0.5, 'env.fil.release': 0.3,
    'lfo.rate': 5.5, 'lfo.amount': 0.2, 'lfo.dest': 2,
    'fx.delay.on': 1, 'fx.delay.time': 0.28, 'fx.delay.feedback': 0.35, 'fx.delay.mix': 0.25, 'fx.delay.sync': 0,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.5, 'fx.reverb.damp': 0.5, 'fx.reverb.mix': 0.2,
    'master.volume': 0.75,
  },
  pad: {
    ...PLAIN_VOICE,
    'osc1.wave': 0, 'osc1.detune': -5, 'osc1.level': 0.6,
    'osc2.wave': 1, 'osc2.octave': 1, 'osc2.detune': 5, 'osc2.level': 0.6,
    'mixer.noise': 0.05,
    'filter.cutoff': 85, 'filter.resonance': 0.4, 'filter.drive': 1.0, 'filter.envAmount': 6,
    'env.amp.attack': 1.5, 'env.amp.decay': 1.0, 'env.amp.sustain': 1.0, 'env.amp.release': 2.5,
    'env.fil.attack': 1.0, 'env.fil.decay': 1.0, 'env.fil.sustain': 0.7, 'env.fil.release': 2.0,
    'lfo.rate': 0.3, 'lfo.amount': 0.3, 'lfo.dest': 1,
    'fx.phaser.on': 1, 'fx.phaser.rate': 0.2, 'fx.phaser.depth': 0.6, 'fx.phaser.feedback': 0.3, 'fx.phaser.sync': 0,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.9, 'fx.reverb.damp': 0.3, 'fx.reverb.mix': 0.5,
    'master.volume': 0.7,
  },
  pluck: {
    ...PLAIN_VOICE,
    'osc1.wave': 3, 'osc1.level': 0.7,
    'osc2.wave': 2, 'osc2.octave': 0, 'osc2.detune': 5, 'osc2.level': 0.3,
    'mixer.noise': 0.1,
    'filter.cutoff': 95, 'filter.resonance': 1.8, 'filter.drive': 1.2, 'filter.envAmount': 36,
    'env.amp.attack': 0.001, 'env.amp.decay': 0.18, 'env.amp.sustain': 0.0, 'env.amp.release': 0.25,
    'env.fil.decay': 0.12, 'env.fil.sustain': 0.0, 'env.fil.release': 0.2,
    'fx.delay.on': 1, 'fx.delay.time': 0.22, 'fx.delay.feedback': 0.45, 'fx.delay.mix': 0.3, 'fx.delay.sync': 0,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.4, 'fx.reverb.damp': 0.4, 'fx.reverb.mix': 0.25,
    'master.volume': 0.8,
  },
  wobble: {
    ...PLAIN_VOICE,
    'osc1.wave': 2, 'osc1.octave': -1, 'osc1.level': 0.7,
    'osc2.wave': 3, 'osc2.octave': -1, 'osc2.detune': 9, 'osc2.level': 0.5,
    'filter.cutoff': 70, 'filter.resonance': 2.6, 'filter.drive': 2.0, 'filter.envAmount': 0,
    'env.amp.attack': 0.005, 'env.amp.decay': 0.4, 'env.amp.sustain': 1.0, 'env.amp.release': 0.3,
    'env.fil.attack': 0.005, 'env.fil.decay': 0.4, 'env.fil.sustain': 0, 'env.fil.release': 0.2,
    'lfo.rate': 3.0, 'lfo.amount': 0.9, 'lfo.dest': 1,
    'fx.dist.on': 1, 'fx.dist.drive': 0.5, 'fx.dist.tone': 2200, 'fx.dist.mix': 0.6,
    'fx.reverb.on': 0,
    'master.volume': 0.75, 'voicing.mode': 0,
  },
  // Basses — acoustic, electric, DnB reese, 303 acid.
  upright: {
    ...PLAIN_VOICE,
    'osc1.wave': 1, 'osc1.octave': -1, 'osc1.level': 0.8,
    'osc2.wave': 0, 'osc2.octave': -1, 'osc2.detune': 0, 'osc2.level': 0.5,
    'analog.drift': 0.05,
    'mixer.noise': 0.04, 'mixer.glide': 0.04, 'glide.mode': 2,
    'filter.cutoff': 64, 'filter.resonance': 0.3, 'filter.drive': 1.4, 'filter.envAmount': 14,
    'env.amp.attack': 0.003, 'env.amp.decay': 1.2, 'env.amp.sustain': 0.3, 'env.amp.release': 0.25,
    'env.fil.decay': 0.25, 'env.fil.sustain': 0, 'env.fil.release': 0.3,
    'fx.reverb.on': 0,
    'master.volume': 0.8, 'voicing.mode': 0,
  },
  pbass: {
    ...PLAIN_VOICE,
    'osc1.wave': 1, 'osc1.octave': -1, 'osc1.level': 0.8,
    'osc2.wave': 3, 'osc2.octave': -1, 'osc2.detune': 0, 'osc2.level': 0.3,
    'mixer.noise': 0.02,
    'filter.cutoff': 74, 'filter.resonance': 0.5, 'filter.drive': 1.8, 'filter.envAmount': 18,
    'env.amp.attack': 0.002, 'env.amp.decay': 0.7, 'env.amp.sustain': 0.5, 'env.amp.release': 0.12,
    'env.fil.decay': 0.15, 'env.fil.sustain': 0.1, 'env.fil.release': 0.2,
    'fx.reverb.on': 0,
    'master.volume': 0.8, 'voicing.mode': 0,
  },
  reese: {
    ...PLAIN_VOICE,
    'osc1.wave': 2, 'osc1.octave': -1, 'osc1.detune': -14, 'osc1.level': 0.7,
    'osc2.wave': 2, 'osc2.octave': -1, 'osc2.detune': 14, 'osc2.level': 0.7,
    'sub.level': 0.5,
    'unison.voices': 2, 'unison.detune': 22, 'analog.drift': 0.1,
    'filter.cutoff': 58, 'filter.resonance': 0.7, 'filter.drive': 2.2, 'filter.envAmount': 0,
    'env.amp.attack': 0.004, 'env.amp.decay': 0.3, 'env.amp.sustain': 1.0, 'env.amp.release': 0.15,
    'env.fil.attack': 0.005, 'env.fil.decay': 0.3, 'env.fil.sustain': 1.0, 'env.fil.release': 0.3,
    'lfo.rate': 2, 'lfo.dest': 1,
    'fx.dist.on': 1, 'fx.dist.drive': 0.4, 'fx.dist.tone': 1800, 'fx.dist.mix': 0.45,
    'fx.reverb.on': 0,
    'master.volume': 0.75, 'voicing.mode': 0,
  },
  acid: {
    ...PLAIN_VOICE,
    'osc1.wave': 2, 'osc1.octave': -1, 'osc1.level': 0.85,
    'osc2.wave': 3, 'osc2.octave': -1, 'osc2.detune': 0, 'osc2.level': 0,
    'mixer.glide': 0.055, 'glide.mode': 2,
    'filter.cutoff': 60, 'filter.resonance': 3.2, 'filter.drive': 2.5, 'filter.envAmount': 32,
    'env.amp.attack': 0.001, 'env.amp.decay': 0.25, 'env.amp.sustain': 0.6, 'env.amp.release': 0.08,
    'env.fil.decay': 0.22, 'env.fil.sustain': 0, 'env.fil.release': 0.18,
    'fx.dist.on': 1, 'fx.dist.drive': 0.55, 'fx.dist.tone': 3200, 'fx.dist.mix': 0.5,
    'fx.delay.on': 1, 'fx.delay.time': 0.375, 'fx.delay.feedback': 0.4, 'fx.delay.mix': 0.2, 'fx.delay.sync': 0,
    'fx.reverb.on': 0,
    'master.volume': 0.7, 'voicing.mode': 0,
  },
  // Keys — acoustic piano, electric piano, tonewheel organ, bells.
  piano: {
    ...PLAIN_VOICE,
    'osc1.wave': 2, 'osc1.detune': -3, 'osc1.level': 0.55,
    'osc2.wave': 1, 'osc2.octave': 1, 'osc2.detune': 3, 'osc2.level': 0.35,
    'mixer.noise': 0.02,
    'filter.cutoff': 100, 'filter.resonance': 0.15, 'filter.drive': 1.0, 'filter.envAmount': 24,
    'env.amp.attack': 0.001, 'env.amp.decay': 3.0, 'env.amp.sustain': 0, 'env.amp.release': 0.3,
    'env.fil.decay': 0.9, 'env.fil.sustain': 0.1, 'env.fil.release': 0.4,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.35, 'fx.reverb.damp': 0.5, 'fx.reverb.mix': 0.12,
    'master.volume': 0.8,
  },
  rhodes: {
    ...PLAIN_VOICE,
    'osc1.wave': 0, 'osc1.level': 0.8,
    'osc2.wave': 1, 'osc2.octave': 1, 'osc2.detune': 4, 'osc2.level': 0.16,
    'filter.cutoff': 90, 'filter.resonance': 0.2, 'filter.drive': 1.0, 'filter.envAmount': 22,
    'env.amp.attack': 0.001, 'env.amp.decay': 2.2, 'env.amp.sustain': 0, 'env.amp.release': 0.35,
    'env.fil.decay': 0.5, 'env.fil.sustain': 0.12, 'env.fil.release': 0.3,
    'lfo.rate': 2.5, 'lfo.amount': 0.60, 'lfo.dest': 3,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.4, 'fx.reverb.damp': 0.5, 'fx.reverb.mix': 0.15,
    'master.volume': 0.8,
  },
  b3: {
    ...PLAIN_VOICE,
    'osc1.wave': 0, 'osc1.level': 0.8,
    'osc2.wave': 0, 'osc2.octave': 1, 'osc2.detune': 0, 'osc2.level': 0.45,
    'sub.level': 0.6,
    'mixer.noise': 0.02,
    'filter.cutoff': 112, 'filter.resonance': 0.1, 'filter.drive': 1.5, 'filter.envAmount': 0,
    'env.amp.attack': 0.003, 'env.amp.decay': 0.05, 'env.amp.sustain': 1.0, 'env.amp.release': 0.02,
    'env.fil.decay': 0.2, 'env.fil.sustain': 1.0, 'env.fil.release': 0.1,
    'lfo.rate': 6.8, 'lfo.amount': 0.02, 'lfo.dest': 2,
    'fx.wah.on': 1, 'fx.wah.rate': 6.8, 'fx.wah.depth': 0.01, 'fx.wah.q': 4, 'fx.wah.sync': 0,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.3, 'fx.reverb.damp': 0.5, 'fx.reverb.mix': 0.12,
    'master.volume': 0.75,
  },
  bells: {
    ...PLAIN_VOICE,
    'osc1.wave': 0, 'osc1.level': 0.7,
    'osc2.wave': 0, 'osc2.octave': 2, 'osc2.detune': 5, 'osc2.level': 0.35,
    'filter.cutoff': 110, 'filter.resonance': 0.6, 'filter.drive': 1.0, 'filter.envAmount': 10,
    'env.amp.attack': 0.001, 'env.amp.decay': 2.8, 'env.amp.sustain': 0, 'env.amp.release': 1.5,
    'env.fil.decay': 1.5, 'env.fil.sustain': 0, 'env.fil.release': 1.0,
    'fx.delay.on': 1, 'fx.delay.time': 0.42, 'fx.delay.feedback': 0.45, 'fx.delay.mix': 0.28, 'fx.delay.sync': 0,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.8, 'fx.reverb.damp': 0.25, 'fx.reverb.mix': 0.4,
    'master.volume': 0.75,
  },
  // Ensemble/poly — string machine, synth brass.
  solina: {
    ...PLAIN_VOICE,
    'osc1.wave': 2, 'osc1.detune': -6, 'osc1.level': 0.6,
    'osc2.wave': 2, 'osc2.octave': 0, 'osc2.detune': 6, 'osc2.level': 0.6,
    'unison.voices': 3, 'unison.detune': 16, 'analog.drift': 0.2,
    'filter.cutoff': 96, 'filter.resonance': 0.2, 'filter.drive': 1.0, 'filter.envAmount': 0,
    'env.amp.attack': 0.3, 'env.amp.decay': 0.5, 'env.amp.sustain': 0.85, 'env.amp.release': 0.9,
    'env.fil.attack': 0.2, 'env.fil.decay': 0.5, 'env.fil.sustain': 0.6, 'env.fil.release': 0.6,
    'lfo.rate': 5.5, 'lfo.amount': 0.03, 'lfo.dest': 2,
    'fx.phaser.on': 1, 'fx.phaser.rate': 0.3, 'fx.phaser.depth': 0.5, 'fx.phaser.feedback': 0.3, 'fx.phaser.mix': 0.35, 'fx.phaser.sync': 0,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.7, 'fx.reverb.damp': 0.4, 'fx.reverb.mix': 0.3,
    'master.volume': 0.7,
  },
  brass: {
    ...PLAIN_VOICE,
    'osc1.wave': 2, 'osc1.level': 0.75,
    'osc2.wave': 2, 'osc2.octave': 0, 'osc2.detune': 8, 'osc2.level': 0.55,
    'unison.voices': 2, 'analog.drift': 0.1,
    'filter.cutoff': 76, 'filter.resonance': 0.4, 'filter.drive': 1.8, 'filter.envAmount': 26,
    'env.amp.attack': 0.04, 'env.amp.decay': 0.2, 'env.amp.sustain': 0.9, 'env.amp.release': 0.25,
    'env.fil.attack': 0.06, 'env.fil.decay': 0.25, 'env.fil.sustain': 0.55, 'env.fil.release': 0.25,
    'lfo.rate': 5, 'lfo.amount': 0.01, 'lfo.dest': 2,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.5, 'fx.reverb.damp': 0.5, 'fx.reverb.mix': 0.15,
    'master.volume': 0.75,
  },

  // ---- POLY filter showcases (filter-models.md) ----
  // Each one leans on something the LADDER model cannot do. Flip the FILTER
  // model switch to LADDER on any of these to hear what it is buying.

  // The headline: an acid line at near-self-oscillating resonance that keeps
  // its bottom end. Under LADDER the same settings hollow the note out.
  ember: {
    ...PLAIN_VOICE,
    'osc1.wave': 2, 'osc1.octave': -1, 'osc1.level': 0.85,
    'osc2.wave': 3, 'osc2.octave': -1, 'osc2.detune': 0, 'osc2.level': 0,
    'sub.level': 0.25,
    'mixer.glide': 0.05, 'glide.mode': 2,
    'filter.cutoff': 56, 'filter.resonance': 3.8, 'filter.drive': 1.6, 'filter.envAmount': 34,
    'filter.model': 1, 'filter.keytrack': 0.35,
    'env.amp.attack': 0.001, 'env.amp.decay': 0.28, 'env.amp.sustain': 0.55, 'env.amp.release': 0.09,
    'env.fil.decay': 0.24, 'env.fil.sustain': 0, 'env.fil.release': 0.2,
    'fx.delay.on': 1, 'fx.delay.time': 0.375, 'fx.delay.feedback': 0.35, 'fx.delay.mix': 0.18, 'fx.delay.sync': 0,
    'fx.reverb.on': 0,
    'master.volume': 0.7, 'voicing.mode': 0,
  },

  // A band-pass pad with the LFO sweeping SHAPE, so the filter *type* breathes
  // between hollow and open. No low-pass-only filter can make this movement.
  vellum: {
    ...PLAIN_VOICE,
    'osc1.wave': 1, 'osc1.detune': -6, 'osc1.level': 0.6,
    'osc2.wave': 2, 'osc2.octave': 0, 'osc2.detune': 6, 'osc2.level': 0.5,
    'sub.level': 0.2,
    'unison.voices': 2, 'unison.detune': 16, 'analog.drift': 0.15,
    'mixer.noise': 0.04,
    'filter.cutoff': 82, 'filter.resonance': 1.4, 'filter.drive': 1.0, 'filter.envAmount': 8,
    'filter.model': 1, 'filter.shape': 0.62, 'filter.keytrack': 0.2,
    'env.amp.attack': 1.2, 'env.amp.decay': 1.0, 'env.amp.sustain': 1.0, 'env.amp.release': 2.2,
    'env.fil.attack': 0.9, 'env.fil.decay': 1.2, 'env.fil.sustain': 0.7, 'env.fil.release': 1.8,
    'lfo.rate': 0.18, 'lfo.amount': 0.5, 'lfo.dest': 6,
    'fx.delay.on': 1, 'fx.delay.time': 0.5, 'fx.delay.feedback': 0.3, 'fx.delay.mix': 0.2, 'fx.delay.sync': 0,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.9, 'fx.reverb.damp': 0.35, 'fx.reverb.mix': 0.45,
    'master.volume': 0.7,
  },

  // High-pass: the bass is gone, so what is left is all attack and glass. Full
  // key tracking keeps it equally thin the whole way up the keyboard.
  prism: {
    ...PLAIN_VOICE,
    'osc1.wave': 3, 'osc1.level': 0.7,
    'osc2.wave': 2, 'osc2.octave': 1, 'osc2.detune': 4, 'osc2.level': 0.35,
    'analog.drift': 0.05,
    'mixer.noise': 0.06,
    'filter.cutoff': 78, 'filter.resonance': 2.2, 'filter.drive': 1.2, 'filter.envAmount': 30,
    'filter.model': 1, 'filter.shape': 1, 'filter.keytrack': 0.8,
    'env.amp.attack': 0.002, 'env.amp.decay': 0.5, 'env.amp.sustain': 0.15, 'env.amp.release': 0.4,
    'env.fil.decay': 0.28, 'env.fil.sustain': 0, 'env.fil.release': 0.3,
    'fx.delay.on': 1, 'fx.delay.time': 0.28, 'fx.delay.feedback': 0.32, 'fx.delay.mix': 0.28, 'fx.delay.sync': 0,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.6, 'fx.reverb.damp': 0.4, 'fx.reverb.mix': 0.3,
    'master.volume': 0.72,
  },
  // Cross-modulation and sync showcases (presets.md REQ-factory-presets-span-the-instrument-families, v14).
  // Each leans on something the plain oscillators cannot do, and its A/B is one
  // knob to 0. The filter envelope drives the FM index or the sync sweep through
  // the mod matrix, so `filter.envAmount` stays small where it would also sweep
  // the cutoff over the same strike.
  tines: {
    ...PLAIN_VOICE,
    // FM electric piano: OSC 1 is a silent sine modulator at 1:1, the strike is
    // the index jumping and decaying (filter env -> fm), velocity adds bark.
    'osc1.wave': 0, 'osc1.level': 0,
    'osc2.wave': 0, 'osc2.octave': 0, 'osc2.detune': 0, 'osc2.level': 0.8,
    'osc1.fm': 0.35,
    'mod.0.src': MOD_SRC.filEnv, 'mod.0.dst': MOD_DST.fm, 'mod.0.amt': 0.28,
    'mod.1.src': MOD_SRC.velocity, 'mod.1.dst': MOD_DST.fm, 'mod.1.amt': 0.12,
    'filter.cutoff': 118, 'filter.resonance': 0.1, 'filter.drive': 1.0, 'filter.envAmount': 0,
    'env.amp.attack': 0.001, 'env.amp.decay': 2.6, 'env.amp.sustain': 0, 'env.amp.release': 0.45,
    'env.fil.decay': 0.9, 'env.fil.sustain': 0.08, 'env.fil.release': 0.4,
    'lfo.rate': 4.5, 'lfo.amount': 0.25, 'lfo.dest': 3,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.45, 'fx.reverb.damp': 0.5, 'fx.reverb.mix': 0.18,
    'master.volume': 0.8,
  },
  chime: {
    ...PLAIN_VOICE,
    // FM bell: the carrier sits two octaves up and 50 cents flat, so the
    // sidebands land between the harmonics. The index fades faster than the
    // ring, so the clang mellows into a purer tail; a quiet OSC 1 marks the pitch.
    'osc1.wave': 0, 'osc1.level': 0.12,
    'osc2.wave': 0, 'osc2.octave': 2, 'osc2.detune': -50, 'osc2.level': 0.6,
    'osc1.fm': 0.4,
    'mod.0.src': MOD_SRC.filEnv, 'mod.0.dst': MOD_DST.fm, 'mod.0.amt': 0.28,
    'filter.cutoff': 125, 'filter.resonance': 0.1, 'filter.drive': 1.0, 'filter.envAmount': 0,
    'env.amp.attack': 0.001, 'env.amp.decay': 4.0, 'env.amp.sustain': 0, 'env.amp.release': 2.5,
    'env.fil.decay': 1.2, 'env.fil.sustain': 0, 'env.fil.release': 1.2,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.8, 'fx.reverb.damp': 0.3, 'fx.reverb.mix': 0.35,
    'master.volume': 0.75,
  },
  growl: {
    ...PLAIN_VOICE,
    // FM bass: a triangle carrier under a sine modulator at 1:1, a fast index
    // decay for the snarl, OSC 1 audible for weight, mono with legato glide.
    'osc1.wave': 0, 'osc1.octave': -1, 'osc1.level': 0.35,
    'osc2.wave': 1, 'osc2.octave': -1, 'osc2.detune': 0, 'osc2.level': 0.7,
    'osc1.fm': 1.2,
    'mod.0.src': MOD_SRC.filEnv, 'mod.0.dst': MOD_DST.fm, 'mod.0.amt': 0.35,
    'mixer.glide': 0.04, 'glide.mode': 2,
    'filter.cutoff': 96, 'filter.resonance': 0.8, 'filter.drive': 2.0, 'filter.envAmount': 12,
    'env.amp.attack': 0.002, 'env.amp.decay': 0.4, 'env.amp.sustain': 0.7, 'env.amp.release': 0.12,
    'env.fil.decay': 0.25, 'env.fil.sustain': 0.15, 'env.fil.release': 0.15,
    'fx.dist.on': 1, 'fx.dist.drive': 0.3, 'fx.dist.tone': 3000, 'fx.dist.mix': 0.35,
    'fx.reverb.on': 0,
    'master.volume': 0.8, 'voicing.mode': 0,
  },
  clang: {
    ...PLAIN_VOICE,
    // Ring mod: a sine times a triangle an octave and 37 cents up, alone in the
    // mix (both LEVELs at 0), so every partial is a sum or a difference. The
    // sub carries the pitch the ring product hides.
    'osc1.wave': 0, 'osc1.level': 0,
    'osc2.wave': 1, 'osc2.octave': 1, 'osc2.detune': 37, 'osc2.level': 0,
    'osc1.ring': 0.8,
    'sub.level': 0.3,
    'filter.cutoff': 110, 'filter.resonance': 0.3, 'filter.drive': 1.0, 'filter.envAmount': 10,
    'env.amp.attack': 0.001, 'env.amp.decay': 1.4, 'env.amp.sustain': 0.15, 'env.amp.release': 0.6,
    'env.fil.decay': 0.6, 'env.fil.sustain': 0.2, 'env.fil.release': 0.5,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.6, 'fx.reverb.damp': 0.35, 'fx.reverb.mix': 0.25,
    'master.volume': 0.8,
  },
  tear: {
    ...PLAIN_VOICE,
    // Hard-sync lead: saw synced to saw, the filter envelope sweeping `sync` on
    // every note, LFO 2 drifting it slowly, and a touch of FM inside the pair.
    'osc1.wave': 2, 'osc1.level': 0.15,
    'osc2.wave': 2, 'osc2.octave': 0, 'osc2.detune': 0, 'osc2.level': 0.6,
    'osc2.sync': 1, 'osc2.syncPitch': 10,
    'osc1.fm': 0.4,
    'mod.0.src': MOD_SRC.filEnv, 'mod.0.dst': MOD_DST.sync, 'mod.0.amt': 0.45,
    'analog.drift': 0.05,
    'mixer.glide': 0.03, 'glide.mode': 2,
    'filter.cutoff': 100, 'filter.resonance': 0.6, 'filter.drive': 1.8, 'filter.envAmount': 14,
    'env.amp.attack': 0.003, 'env.amp.decay': 0.3, 'env.amp.sustain': 0.85, 'env.amp.release': 0.25,
    'env.fil.attack': 0.005, 'env.fil.decay': 0.7, 'env.fil.sustain': 0.25, 'env.fil.release': 0.3,
    'lfo2.rate': 0.3, 'lfo2.amount': 0.15, 'lfo2.dest': 7,
    'fx.delay.on': 1, 'fx.delay.time': 0.32, 'fx.delay.feedback': 0.3, 'fx.delay.mix': 0.2, 'fx.delay.sync': 0,
    'fx.reverb.on': 1, 'fx.reverb.size': 0.5, 'fx.reverb.damp': 0.4, 'fx.reverb.mix': 0.15,
    'master.volume': 0.75, 'voicing.mode': 0,
  },
};

/** `snap` without anything that is not part of a preset's sound. */
function soundOnly(snap: Snapshot): Snapshot {
  const out: Snapshot = {};
  for (const [id, v] of Object.entries(snap)) if (inPreset(id)) out[id] = v;
  return out;
}

/**
 * Whether a stored factory slot is an earlier release's seed rather than an edit
 * (presets.md REQ-an-older-factory-seed-is-refreshed): every entry it holds equals
 * the current definition, and it lacks some of the current keys. A Save captures
 * every sound param, so a user's own copy is never such a subset; a slot that differs
 * on any value is kept, since an edit and a retuned factory value look alike.
 */
function isOlderSeed(raw: string, current: Snapshot): boolean {
  let stored: unknown;
  try { stored = JSON.parse(raw); } catch { return false; }
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return false;
  const entries = Object.entries(stored as Record<string, unknown>);
  if (entries.length >= Object.keys(current).length) return false;
  return entries.every(([k, v]) => Object.prototype.hasOwnProperty.call(current, k) && current[k] === v);
}

export const Presets = {
  factory(): FactoryBank { return FACTORY; },

  list(): string[] {
    return [...new Set([...Object.keys(FACTORY), ...store.readIndex()])].sort();
  },

  ensureFactoryPresets(): void {
    for (const [name, snap] of Object.entries(FACTORY)) {
      const raw = store.readRaw(name);
      if (!raw || isOlderSeed(raw, snap)) store.writeRaw(name, JSON.stringify(snap));
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
   * Validated, not cast (untrusted-input.md REQ-deserialized-state-is-validated-never-cast). The *import* path already
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

  save(rawName: string, snap: Snapshot): void {
    // The store's own backstop (untrusted-input.md REQ-names-are-capped): every
    // caller already cleans, but no key over the cap can be written.
    const name = cleanName(rawName);
    // Round at the serialization boundary (same helper as song export) — clean
    // JSON, no audible change. capture() keeps live state full-precision.
    store.writeRaw(name, JSON.stringify(roundParams(snap)));
    store.addToIndex(name);
  },

  /**
   * Drop a stored preset (presets.md REQ-a-stored-preset-can-be-deleted). For a
   * user preset that is a delete; for an edited factory one it is a revert —
   * `load()` falls back to `FACTORY` once the slot is gone, and `list()` keeps
   * the factory name.
   */
  remove(name: string): void {
    store.remove(name);
  },

  /** Whether `name` is a factory preset (so removing it reverts, not deletes). */
  isFactory(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(FACTORY, name);
  },

  capture(bus: ParamBus): Snapshot {
    // The sound only (presets.md REQ-a-preset-is-only-a-sound), and never the
    // performer's hands (input-control.md REQ-cc11-is-expression).
    return soundOnly(savedParams(bus.snapshot()));
  },

  /**
   * Every sound param the preset omits goes to its default first, then the preset
   * — one bulk apply (REQ-loading-a-preset-starts-from-the-default-sound). A preset saved before a param
   * existed does not mention it, and every default is a no-op (ADR-006), so this is
   * what makes it sound as it did when saved instead of inheriting the last patch.
   */
  apply(bus: ParamBus, snap: Snapshot): void {
    const start: Snapshot = {};
    for (const id of bus.ids()) {
      const def = bus.def(id);
      if (def && inPreset(id)) start[id] = def.default;
    }
    // A file saved before REQ-a-preset-is-only-a-sound, or written by hand, may
    // carry the tempo, a machine's state or the key: they stay in the file, unapplied.
    bus.restore({ ...start, ...soundOnly(snap) });
  },

  /**
   * Every preset the user actually made or changed — presets.md REQ-modified-is-computed-not-tracked. Derived,
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

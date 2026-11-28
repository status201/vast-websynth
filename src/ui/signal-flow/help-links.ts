/**
 * Where each help topic sits on the signal-flow map (signal-flow-map.md
 * REQ-a-help-topic-shows-its-place): the ids of the poster's blocks ("spots",
 * named by the generator's layout) or zones that a topic's "Show in the signal
 * flow" frames and rings.
 *
 * A topic is listed only when it names something on the audio or control
 * path, and its ids share one area short of the whole poster (a link that
 * resolves to the overview shows nothing). Files, presets, the demo library,
 * Panic and Settings are about the app, not the sound, so they have no place
 * here. `tests/signal-flow/help-links.test.ts` checks every id against
 * `docs/signal-flow-zones.json`, so a renamed block fails the suite instead of
 * silently opening the overview.
 *
 * Type-only import: the badges read this table at boot, and it must not pull
 * the help copy along with it.
 */
import type { TopicId } from '../onboarding/help-content';

const SYNTH_FX = ['syn-eq', 'syn-dirt', 'syn-wah', 'syn-phaser', 'syn-flanger', 'syn-chorus', 'syn-delay', 'syn-reverb', 'syn-duck', 'syn-pan'];

export const SIGNAL_FLOW_LINKS: Partial<Record<TopicId, readonly string[]>> = {
  // Play, notes & time
  keyboard: ['kbd', 'qwerty'],
  transpose: ['kbd'],
  pitchBend: ['wheels'],
  modWheel: ['wheels'],
  'song.fx': ['livefx'],
  'motion.xy': ['motion'],
  key: ['key'],
  arp: ['arp'],
  transport: ['clock'],
  'transport.swing': ['clock'],
  meter: ['clock'],
  'transport.ruler.seq': ['seq'],
  'transport.ruler.drum': ['drums'],
  'transport.ruler.sampler': ['sampler'],
  'transport.ruler.motion': ['motion'],
  'transport.song': ['arrange'],
  song: ['arrange'],
  sync: ['sync'],
  'sync.wifi': ['wifi'],
  // The synth
  voicing: ['poly'],
  seq: ['seq'],
  'seq.prob': ['seq'],
  'seq.ratchet': ['seq'],
  'seq.tie': ['seq'],
  'seq.bend': ['seq', 'pitch'],
  'seq.chord': ['seq', 'poly'],
  motion: ['motion'],
  'motion.tracks': ['motion'],
  oscillators: ['osc1'],
  osc2: ['osc2'],
  subuni: ['sub', 'poly'],
  'unison.detune': ['poly'],
  mixer: ['mixer'],
  filter: ['filter'],
  'filter.cutoff': ['filter'],
  'filter.resonance': ['filter'],
  'filter.model': ['filter'],
  'filter.shape': ['filter'],
  'filter.envAmount': ['fenv', 'filter'],
  ampenv: ['aenv'],
  filterenv: ['fenv'],
  lfo: ['lfo1', 'lfo2', 'route'],
  'lfo.rate': ['lfo1'],
  'lfo2.rate': ['lfo2'],
  mod: ['route'],
  // Drums and sampler
  drums: ['drums'],
  sampler: ['sampler'],
  'sampler.pitch': ['sstrip0'],
  'sampler.window': ['sstrip0'],
  'sampler.env': ['sstrip1'],
  'sampler.tone': ['sstrip2'],
  'sampler.choke': ['sampler', 'sstrip1'],
  'seq.render': ['sampler'],
  // The FX rack (the synth's own fx.* topics; the drum and sampler racks have theirs)
  fx: SYNTH_FX,
  eq: ['syn-eq', 'drm-eq', 'smp-eq'],
  'eq.graph.seq': ['syn-eq'],
  'eq.knobs.seq': ['syn-eq'],
  'eq.graph.drums': ['drm-eq'],
  'eq.knobs.drums': ['drm-eq'],
  'eq.graph.sampler': ['smp-eq'],
  'eq.knobs.sampler': ['smp-eq'],
  'fx.dist': ['syn-dirt'],
  'fx.wah': ['syn-wah'],
  'fx.wah.rate': ['syn-wah'],
  'fx.phaser': ['syn-phaser'],
  'fx.phaser.rate': ['syn-phaser'],
  'fx.flanger': ['syn-flanger'],
  'fx.flanger.rate': ['syn-flanger'],
  'fx.chorus': ['syn-chorus'],
  'fx.delay': ['syn-delay'],
  'fx.delay.time': ['syn-delay'],
  'fx.reverb': ['syn-reverb'],
  'fx.duck': ['syn-duck', 'smp-duck'],
  'fx.drum.comp': ['drm-comp'],
  'fx.drum.comp.threshold': ['drm-comp'],
  'fx.drum.phaser.rate': ['drm-phaser'],
  'fx.drum.delay.time': ['drm-delay'],
  'fx.sampler.phaser.rate': ['smp-phaser'],
  'fx.sampler.flanger.rate': ['smp-flanger'],
  'fx.sampler.delay.time': ['smp-delay'],
  // Master
  'fx.master.comp': ['mcomp'],
  'fx.master.comp.threshold': ['mcomp'],
  'fx.master.limit': ['mlimit'],
  scope: ['scope'],
  'song.exportAudio': ['export'],
  'song.record': ['export'],
};

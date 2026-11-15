/**
 * Two blocks of the Engine's param wiring (architecture.md, ADR-008), lifted out
 * so `Engine.subscribeParams` reads as an outline: each binder subscribes one
 * family of params to the objects that own them, through a narrow targets
 * object — nothing here can reach the rest of the Engine.
 *
 * ORDER IS PART OF THE CONTRACT. `bus.subscribe` fires at once, so registration
 * order is boot order: each binder is a contiguous run of what was one function,
 * called from the same place in `subscribeParams`, and its own lines keep their
 * order. Moving a subscription between binders, or a binder within
 * `subscribeParams`, is a behaviour change, not a refactor.
 */
import type { ParamBus } from '../state/params';
import type { Voice } from './voice';
import type { Polyphony } from './polyphony';
import type { ScaleQuantizer } from './transport/scale-quantizer';
import type { OscPairPolicy } from './osc-pair-policy';
import type { Arpeggiator } from './transport/arpeggiator';
import type { StepSequencer } from './transport/sequencer';
import type { DrumMachine } from './transport/drum-machine';
import type { SamplerMachine } from './transport/sampler-machine';
import type { MotionMachine } from './transport/motion-machine';
import type { LaneMixer } from './lane-mixer';
import { DRUM_TRACK_COUNT, SEQ_TRACK_COUNT, MOTION_TRACK_COUNT, SAMPLER_SLOT_COUNT } from '../state/patterns';

export interface VoiceParamTargets {
  voices: readonly Voice[];
  polyphony: Polyphony;
  scale: ScaleQuantizer;
  pairs: OscPairPolicy;
}

/**
 * The synth voice: key and scale, both oscillators and their cross-modulation,
 * sync, sub, unison, drift, glide, triggers, mixer, filter and both envelopes.
 */
export function bindVoiceParams(bus: ParamBus, t: VoiceParamTargets): void {
  const { voices, polyphony, scale, pairs } = t;
  const all = (fn: (v: Voice, value: number) => void) =>
    (value: number) => { for (const v of voices) fn(v, value); };

  // Key / scale. `subscribe` fires immediately, so the table is built at boot and
  // rebuilt only on change — never per note (scale-quantization.md REQ-the-scale-mapping-is-a-lookup-table).
  bus.subscribe('scale.root', (v) => scale.setRoot(Math.round(v)));
  bus.subscribe('scale.type', (v) => scale.setScale(Math.round(v)));
  bus.subscribe('scale.extra', (v) => scale.setExtra(Math.round(v)));
  bus.subscribe('chord.voicing', (v) => scale.setChord(Math.round(v)));
  // Mono suppresses chord expansion — chord-tools.md REQ-mono-gates-the-live-chord-path.
  bus.subscribe('voicing.mode', (v) => scale.setPoly(v >= 0.5));

  // OSC 1
  bus.subscribe('osc1.wave', all((v, x) => v.osc1.setWave(x)));
  bus.subscribe('osc1.octave', all((v, x) => v.setOscOctave(1, x)));
  bus.subscribe('osc1.detune', all((v, x) => v.setOscTune(1, x)));
  bus.subscribe('osc1.level', all((v, x) => v.osc1.setLevel(x)));
  // Cross-modulation (cross-modulation.md): OSC 1 is the modulator.
  bus.subscribe('osc1.fm', (x) => pairs.setFmIndex(x));
  bus.subscribe('osc1.ring', all((v, x) => v.setRing(x)));

  // OSC 2
  bus.subscribe('osc2.wave', (x) => {
    // The predicate first, as for the width: switching to square under FM frees
    // the pair before the natives would pick up the standing width.
    pairs.setOsc2Wave(x);
    for (const v of voices) v.osc2.setWave(x);
  });
  bus.subscribe('osc2.octave', all((v, x) => v.setOscOctave(2, x)));
  bus.subscribe('osc2.detune', all((v, x) => v.setOscTune(2, x)));
  bus.subscribe('osc2.level', all((v, x) => v.osc2.setLevel(x)));

  // Oscillator sync (oscillator-sync.md). Every voice is told the mode even
  // before its pair exists: it stores it, and `attachSync` applies it once the
  // pair lands — until then the voice plays native.
  bus.subscribe('osc2.sync', (x) => {
    if (Math.round(x) !== 0) void pairs.ensureSync();
    for (const v of voices) v.setSyncMode(x);
  });
  bus.subscribe('osc2.syncPitch', all((v, x) => v.setSyncPitch(x)));

  // Sub oscillator
  bus.subscribe('sub.wave', all((v, x) => v.setSubWave(x)));
  bus.subscribe('sub.octave', all((v, x) => v.setSubOctave(x)));
  bus.subscribe('sub.level', all((v, x) => v.setSubLevel(x)));

  // Unison
  bus.subscribe('unison.voices', (x) => polyphony.setUnisonCount(x));
  bus.subscribe('unison.detune', (x) => polyphony.setUnisonDetune(x));

  // Analogue drift / glide mode
  bus.subscribe('analog.drift', (x) => polyphony.setDrift(x));
  bus.subscribe('glide.mode', (x) => polyphony.setGlideMode(x));
  // Mono single-trigger (voicing.md REQ-single-trigger-legatos-a-mono-line).
  bus.subscribe('env.amp.trigger', (v) => polyphony.setSingleTrigger('amp', v >= 0.5));
  bus.subscribe('env.fil.trigger', (v) => polyphony.setSingleTrigger('fil', v >= 0.5));

  // Mixer
  bus.subscribe('mixer.noise', all((v, x) => v.setNoiseLevel(x)));
  bus.subscribe('mixer.glide', all((v, x) => v.setGlide(x)));

  // Filter
  bus.subscribe('filter.cutoff', all((v, x) => v.setFilterCutoff(x)));
  bus.subscribe('filter.resonance', all((v, x) => v.setFilterResonance(x)));
  bus.subscribe('filter.drive', all((v, x) => v.setFilterDrive(x)));
  bus.subscribe('filter.envAmount', all((v, x) => v.setFilterEnvAmount(x)));
  bus.subscribe('filter.velAmount', all((v, x) => v.setFilterVelAmount(x)));
  bus.subscribe('filter.model', all((v, x) => v.setFilterModel(x)));
  bus.subscribe('filter.shape', all((v, x) => v.setFilterShape(x)));
  bus.subscribe('filter.keytrack', all((v, x) => v.setFilterKeytrack(x)));

  // Amp envelope
  bus.subscribe('env.amp.attack', all((v, x) => v.ampEnv.setAttack(x)));
  bus.subscribe('env.amp.decay', all((v, x) => v.ampEnv.setDecay(x)));
  bus.subscribe('env.amp.sustain', all((v, x) => v.ampEnv.setSustain(x)));
  bus.subscribe('env.amp.release', all((v, x) => v.ampEnv.setRelease(x)));

  // Filter envelope
  bus.subscribe('env.fil.attack', all((v, x) => v.filEnv.setAttack(x)));
  bus.subscribe('env.fil.decay', all((v, x) => v.filEnv.setDecay(x)));
  bus.subscribe('env.fil.sustain', all((v, x) => v.filEnv.setSustain(x)));
  bus.subscribe('env.fil.release', all((v, x) => v.filEnv.setRelease(x)));
}

export interface MachineParamTargets {
  arp: Arpeggiator;
  seq: StepSequencer;
  drums: DrumMachine;
  sampler: SamplerMachine;
  motion: MotionMachine;
  laneMixer: LaneMixer;
  polyphony: Polyphony;
  /** A seq track's pan moved — the engine stores it and decides the spread stage. */
  onSeqPan(track: number, v: number): void;
  /** `seq.master`: the synth voice bus level. */
  setSynthBusLevel(v: number): void;
}

/** The arpeggiator and the four step machines, plus the Song tab's lane mixer. */
export function bindMachineParams(bus: ParamBus, t: MachineParamTargets): void {
  const { arp, seq, drums, sampler, motion, laneMixer, polyphony } = t;

  // ----- Arpeggiator -----
  bus.subscribe('arp.on', (v) => arp.setEnabled(v >= 0.5));
  bus.subscribe('arp.pattern', (v) => arp.setPattern(v));
  bus.subscribe('arp.rate', (v) => arp.setRate(v));
  bus.subscribe('arp.octaves', (v) => arp.setOctaves(v));
  bus.subscribe('arp.gate', (v) => arp.setGate(v));

  // ----- Sequencer -----
  bus.subscribe('seq.on', (v) => seq.setEnabled(v >= 0.5));
  // Tracks 2-4 only sound in poly voicing (sequencer.md REQ-poly-voicing-gates-the-extra-tracks); each track
  // also has its own mute (REQ-per-track-mute), independent of the lane-wide seq.mute.
  bus.subscribe('voicing.mode', (v) => seq.setPolyphonic(v >= 0.5));
  // Legato or re-striking ties (sequencer.md REQ-a-tie-continues-the-note-without-retriggering, ADR-028).
  bus.subscribe('seq.tieMode', (v) => seq.setRestrikeTies(v >= 0.5));
  for (let i = 0; i < SEQ_TRACK_COUNT; i++) {
    const track = i;
    bus.subscribe(`seq.t${i}.mute`, (v) => seq.setTrackMuted(track, v >= 0.5));
    // Per-track pan (REQ-a-seq-track-carries-a-pan). Three jobs on one write:
    // the sequencer stamps it on the notes it schedules from now on, the voices
    // already sounding this track follow it live, and the spread stage decides
    // whether the panned edges belong in the graph at all.
    bus.subscribe(`seq.t${i}.pan`, (v) => {
      seq.setTrackPan(track, v);
      polyphony.setGroupPan(track, v);
      t.onSeqPan(track, v);
    });
  }
  // Synth voice-bus volume (independent of mute: seq mute stops triggering,
  // not the bus, so live keys keep playing at this level).
  bus.subscribe('seq.master', (v) => t.setSynthBusLevel(v));

  // ----- Song-tab lane mixer (mute + solo across all three machines) -----
  bus.subscribe('seq.mute', (v) => laneMixer.setMute('seq', v >= 0.5));
  bus.subscribe('drum.mute', (v) => laneMixer.setMute('drum', v >= 0.5));
  bus.subscribe('sampler.mute', (v) => laneMixer.setMute('sampler', v >= 0.5));
  bus.subscribe('seq.solo', (v) => laneMixer.setSolo('seq', v >= 0.5));
  bus.subscribe('drum.solo', (v) => laneMixer.setSolo('drum', v >= 0.5));
  bus.subscribe('sampler.solo', (v) => laneMixer.setSolo('sampler', v >= 0.5));

  // ----- Drums -----
  bus.subscribe('drum.on', (v) => drums.setEnabled(v >= 0.5));
  bus.subscribe('drum.choke', (v) => drums.setChokeEnabled(v >= 0.5));
  bus.subscribe('drum.master', (v) => laneMixer.setDrumVol(v));
  for (let i = 0; i < DRUM_TRACK_COUNT; i++) {
    const track = i;
    bus.subscribe(`drum.t${i}.vol`, (v) => drums.setTrackVolume(track, v));
    bus.subscribe(`drum.t${i}.tune`, (v) => drums.setTrackTune(track, v));
    bus.subscribe(`drum.t${i}.decay`, (v) => drums.setTrackDecay(track, v));
    bus.subscribe(`drum.t${i}.tone`, (v) => drums.setTrackTone(track, v));
    bus.subscribe(`drum.t${i}.drive`, (v) => drums.setTrackDrive(track, v));
    bus.subscribe(`drum.t${i}.pan`, (v) => drums.setTrackPan(track, v));
    bus.subscribe(`drum.t${i}.mute`, (v) => drums.setTrackMute(track, v >= 0.5));
    bus.subscribe(`drum.t${i}.model`, (v) => drums.setTrackModel(track, v));
  }

  // ----- Sampler -----
  bus.subscribe('sampler.on', (v) => sampler.setEnabled(v >= 0.5));
  bus.subscribe('sampler.master', (v) => laneMixer.setSamplerVol(v));
  for (let i = 0; i < SAMPLER_SLOT_COUNT; i++) {
    const slot = i;
    bus.subscribe(`sampler.t${i}.mute`, (v) => sampler.setSlotMute(slot, v >= 0.5));
    // The per-slot channel (sampler.md REQ-each-slot-has-a-channel) …
    bus.subscribe(`sampler.t${i}.vol`, (v) => sampler.setSlotVol(slot, v));
    bus.subscribe(`sampler.t${i}.pan`, (v) => sampler.setSlotPan(slot, v));
    bus.subscribe(`sampler.t${i}.tone`, (v) => sampler.setSlotTone(slot, v));
    bus.subscribe(`sampler.t${i}.res`, (v) => sampler.setSlotRes(slot, v));
    // … and its voice window (REQ-a-hit-plays-a-window-of-the-buffer).
    bus.subscribe(`sampler.t${i}.pitch`, (v) => sampler.setSlotPitch(slot, v));
    bus.subscribe(`sampler.t${i}.start`, (v) => sampler.setSlotStart(slot, v));
    bus.subscribe(`sampler.t${i}.end`, (v) => sampler.setSlotEnd(slot, v));
    bus.subscribe(`sampler.t${i}.rev`, (v) => sampler.setSlotRev(slot, v >= 0.5));
    bus.subscribe(`sampler.t${i}.attack`, (v) => sampler.setSlotAttack(slot, v));
    bus.subscribe(`sampler.t${i}.decay`, (v) => sampler.setSlotDecay(slot, v));
    // Choke group + mono (REQ-a-slot-can-cut-another-slot).
    bus.subscribe(`sampler.t${i}.choke`, (v) => sampler.setSlotChokeGroup(slot, v));
    bus.subscribe(`sampler.t${i}.poly`, (v) => sampler.setSlotMono(slot, v >= 0.5));
  }

  // ----- Motion sequencer -----
  bus.subscribe('motion.on', (v) => motion.setEnabled(v >= 0.5));
  bus.subscribe('motion.mute', (v) => motion.setMuted(v >= 0.5));
  bus.subscribe('motion.slide', (v) => motion.setSlide(v >= 0.5));
  // Each extra motion track interpolates on its own mode (REQ-set-steps-are-anchors).
  for (let i = 0; i < MOTION_TRACK_COUNT; i++) {
    const track = i;
    bus.subscribe(`motion.t${i}.slide`, (v) => motion.setTrackSlide(track, v >= 0.5));
  }
}

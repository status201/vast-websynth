// The copy of the in-app map's clickable areas (specs/features/signal-flow-map.md),
// written to docs/signal-flow-zones.json. Each zone's box comes from the layout
// that draws it (layout.mjs → defineZones), so moving a block moves its zone.
// The posters draw nothing for a zone.

export const ZONE_INTRO = 'Every path from a key press to the speakers, read left to right. '
  + 'Pick an area to zoom in, or follow the signal with Next.';

export const ZONE_TEXT = {
  play: ['Play', 'Everything you play the instrument with: the keys on screen and on your computer, MIDI gear, the wheels, the XY pad, Live FX and Wi-Fi sync. The microphone and audio files feed the sampler.'],
  'play-keys': ['Keyboards & MIDI', 'The on-screen keys, the computer keyboard and MIDI IN all send notes the same way. MIDI also brings pitch bend, the mod wheel, volume, sustain and its clock; channel 10 plays the sampler pads.'],
  'play-ctl': ['Controllers & sync', 'The wheels bend the pitch and add modulation. The XY pad and Live FX turn knobs for you (purple wires). Wi-Fi sync locks the clock to another device.'],
  'play-in': ['Sound in', 'The microphone records into the sample studio and is never heard live. Audio files load straight into a sampler slot.'],
  notes: ['Notes & time', 'What happens to a note before a machine plays it — scale, chords, the arpeggiator — and the clock that keeps every machine in time.'],
  'notes-keys': ['Key, chord & arpeggiator', 'KEY quantizes what you play to a scale; CHORD MEMORY turns one key into a chord. While the ARPEGGIATOR is on it takes over the live keys and plays them as a pattern.'],
  'notes-clock': ['Clock, song & automation', 'The CLOCK ticks in 16ths and drives every machine. SYNC follows or leads MIDI or a Wi-Fi peer; ARRANGEMENT chains banks into a song. The PARAMETER BUS is how anything that turns a knob reaches it.'],
  'notes-studio': ['Sample studio', 'Edits a recording before it becomes a sampler slot: crop, normalize, fade, filter, pitch, time-stretch, scratch and chop. Its clip preview goes straight to the output.'],
  machines: ['Machines & sound sources', 'What makes the sound: the synth with its sequencers, the drum machine and the sampler. Each ends in its own bus.'],
  synth: ['Synth', 'Notes from the keys, the arpeggiator or the step sequencer go to the voice allocator, which plays up to eight copies of the synth voice.'],
  seqs: ['Sequencers & polyphony', 'The STEP SEQUENCER plays four tracks of notes; the MOTION SEQUENCER automates knobs. POLYPHONY hands each note to a free voice, with unison, glide and voice stealing.'],
  voice: ['Synth voice', 'One voice, drawn in full: OSC 1, OSC 2 (with FM and sync), SUB and NOISE mix into the FILTER, then the VCA opened by the AMP ENV. Eight of these play at once.'],
  mod: ['Modulation', 'The control signals that move the voice: two LFOs, the 6-row MOD MATRIX, the S&H RANDOM source, the envelopes and your bend and mod wheels, all on one MOD BUS.'],
  drums: ['Drums', 'The drum machine: eight synthesized drum tracks, each through its own channel strip, into the drum bus.'],
  'drum-machine': ['Drum machine', 'Eight tracks of steps trigger eight drum voices, picked from 13 synthesized models and 7 kits. Each hit also tells the DUCK effects when to dip.'],
  'drum-channel': ['Drum channel', 'Every drum track has its own DRIVE, TONE, LEVEL and PAN, then all eight sum on the DRUM BUS.'],
  sampler: ['Sampler', 'The sampler machine: eight slots of recorded sound, each through its own channel strip, into the sampler bus.'],
  'sampler-machine': ['Sampler pads', 'Eight slots, each playing a one-shot recording, triggered by the sampler steps or MIDI channel 10. Slots fill from a file, the studio, or by rendering the synth.'],
  'sampler-channel': ['Sampler channel', 'Each slot plays a window of its recording at a pitch, shaped by a hit envelope, a tone filter, its level and pan, then sums on the SAMPLER BUS.'],
  fx: ['FX rack', 'Three insert chains, one per bus, lined up by effect. A bypassed effect is disconnected, so it costs nothing.'],
  'fx-synth': ['Synth effects', 'The full chain: EQ, DIRT, WAH, PHASER, FLANGER, CHORUS, DELAY, REVERB, DUCK and SYNTH PAN, in that order.'],
  'fx-inserts': ['How the insert chains work', 'The rules every chain shares: the fixed order, dry/wet crossfades, what each bus has and lacks, and how DUCK listens to drum hits instead of audio.'],
  'fx-drum': ['Drum effects', 'EQ, the FET COMP, PHASER, DELAY and REVERB. The drums are never ducked.'],
  'fx-sampler': ['Sampler effects', 'EQ, DIRT, PHASER, FLANGER, CHORUS, DELAY, REVERB and DUCK.'],
  master: ['Master & output', 'The three buses sum, pass the DJ FILTER, the MASTER COMP and the MASTER VOL, and leave as stereo.'],
  'master-chain': ['Master chain', 'PRE-MASTER sum → DJ FILTER → MASTER COMP → MASTER VOL → OUTPUT → L / R. The SCOPE and RECORD / EXPORT tap the signal on the way; the metronome and clip preview go straight out.'],
  'master-stereo': ['Where the signal turns stereo', 'The synth is mono until SPREAD, CHORUS, PING PONG, REVERB or SYNTH PAN; drums and sampler turn stereo at each channel\'s PAN.'],
  'master-offpath': ['Not on the audio path', 'Things that change the sound without being an effect: TAPE STOP, STUTTER, FILL, the microphone and RENDER TO SAMPLER.'],
  legend: ['Legend', 'How to read the map: what each wire carries, what the symbols mean, and which colour is which section.'],
  'legend-wires': ['Wires', 'The colour and line of a wire say what travels on it: audio (single = mono, double = stereo), notes, velocity, modulation, clock, drum hits, automation and sample data.'],
  'legend-symbols': ['Symbols', 'Σ adds signals, × multiplies them, the triangle is the VCA. Dashed frames repeat per voice or track; a lettered tag continues a wire elsewhere.'],
  'legend-sections': ['Section colours', 'The colour strip on every block says which section it belongs to.'],
};

// "Follow the signal": the order Prev / Next walks the leaf zones in.
export const TOUR_ORDER = [
  'play-keys', 'play-ctl', 'notes-keys', 'notes-clock', 'seqs', 'voice', 'mod', 'fx-synth', 'fx-inserts',
  'drum-machine', 'drum-channel', 'fx-drum', 'play-in', 'notes-studio', 'sampler-machine', 'sampler-channel',
  'fx-sampler', 'master-chain', 'master-stereo', 'master-offpath', 'legend-wires', 'legend-symbols', 'legend-sections',
];

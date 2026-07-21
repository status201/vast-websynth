// All the onboarding copy lives here (kept out of params.ts so the param model
// stays pure): the interactive tour script + the contextual help topics shown
// by the help-mode (i) badges.
import type { TourStep } from './tour';
import type { ParamBus } from '../../state/params';
import {
  renderTempoSync,
  renderFilterCutoff,
  renderFilterResonance,
  renderFilterEnvAmount,
  renderUnisonDetune,
  renderCompThreshold,
} from './help-widgets';

/** A loud, instantly-recognisable demo for the "load a demo" headline step. */
export const DEMO_FOR_TOUR = 'Night Rider';

function clickTestId(id: string): void {
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.click();
}

export const TOUR_STEPS: TourStep[] = [
  {
    title: 'Welcome to VAST G1-J5',
    body:
      'This is a real synthesizer — knobs, oscillators, the works. ' +
      "Don't worry, in about a minute you'll be making sound. Hit <strong>Next</strong>.",
  },
  {
    target: 'keyboard',
    title: 'Press a key — hear it',
    body:
      'Click any key below (or tap a letter row on your keyboard, like <strong>Z X C V</strong>). ' +
      'Notes play instantly — no setup, no Play button needed.',
    advanceOn: 'note',
  },
  {
    target: 'transport-play',
    title: 'Start & stop with Play',
    body:
      'This is the <strong>transport</strong>. Drum beats, sequences and songs only run while ' +
      "it's playing — it's separate from the keyboard on purpose, just like a real instrument.",
    placement: 'bottom',
  },
  {
    target: 'panel-song',
    title: 'Load a demo — listen',
    body:
      "Let's hear what this thing can do. Press <strong>Next</strong> and I'll load a full " +
      'demo song <em>and</em> start it for you. Turn your volume up a touch.',
    placement: 'top',
    precondition: () => clickTestId('tab-song'),
    action: (ctx) => {
      ctx.applyDemo(DEMO_FOR_TOUR);
      if (!ctx.engine.clock.playing) ctx.toggleTransport();
    },
  },
  {
    target: 'knob-filter.cutoff',
    title: 'Shape the sound',
    body:
      'While it plays, drag the <strong>CUTOFF</strong> knob up and down — that bright/dark ' +
      'sweep is the filter, the heart of a synth. Drag any knob to explore; double-click resets it.',
    placement: 'right',
  },
  {
    target: 'fx',
    title: 'Add effects',
    body:
      'Distortion, delay, reverb and more. Flip a switch to turn an effect on, then tweak its ' +
      'knobs. Great for turning a plain tone into something huge.',
    placement: 'top',
    precondition: (ctx) => ctx.expandFx(),
  },
  {
    target: 'panel-seq',
    title: 'Build your own patterns',
    body:
      'These tabs are where beats and melodies are made — the sequencer, drum machine and ' +
      'sampler. Click steps to switch them on; they play while the transport runs.',
    placement: 'top',
    precondition: () => clickTestId('tab-seq'),
  },
  {
    target: 'song-lane-seq',
    title: 'Arrange a full song',
    body:
      'Each machine gets a <strong>chain</strong> — a running order of banks (A B C D), one bar ' +
      'each, so your patterns become a track with an intro, a drop and a breakdown. Mute, solo ' +
      'and level every lane right here, like a DJ mixer.',
    placement: 'top',
    precondition: () => clickTestId('tab-song'),
  },
  {
    target: 'perf-stutter',
    title: 'Perform it live',
    body:
      'Now play the song like an instrument: <strong>Fill</strong>, <strong>Stutter</strong>, ' +
      '<strong>Drop</strong> and <strong>Tape Stop</strong> are momentary — hold one for a build, ' +
      'a glitch or a wobbly halt — and <strong>DJ FLT</strong> sweeps the whole mix. ' +
      "It's all live and nothing here can break your song.",
    placement: 'top',
    precondition: () => clickTestId('tab-song'),
  },
  {
    target: 'help-button',
    title: "That's it — go play",
    body:
      "You know enough to make noise. Stuck on a control? Click <strong>Help</strong> any time " +
      'to replay this tour or switch on the (i) badges that explain each section.',
    placement: 'bottom',
  },
];

// ---- Contextual help (the help-mode (i) badges) ----

/** Runtime handed to a dynamic (function) topic body so it can read/write live
 *  params and dismiss the modal (e.g. after a click-to-snap). */
export interface HelpContext {
  bus: ParamBus;
  close: () => void;
}

export interface HelpTopic {
  title: string;
  /** Static light HTML (trusted, authored copy), or a live DOM builder for
   *  BPM-aware / relationship badges (see help-widgets.ts). */
  body: string | ((ctx: HelpContext) => Node);
}

export type TopicId =
  | 'transport'
  | 'transport.swing'
  | 'voicing'
  | 'panic'
  | 'oscillators'
  | 'subuni'
  | 'mixer'
  | 'filter'
  | 'filter.cutoff'
  | 'filter.resonance'
  | 'filter.envAmount'
  | 'unison.detune'
  | 'ampenv'
  | 'filterenv'
  | 'lfo'
  | 'lfo.rate'
  | 'fx'
  | 'fx.dist'
  | 'fx.wah'
  | 'fx.wah.rate'
  | 'fx.phaser'
  | 'fx.phaser.rate'
  | 'fx.delay'
  | 'fx.delay.time'
  | 'fx.reverb'
  | 'fx.drum.comp'
  | 'fx.drum.comp.threshold'
  | 'fx.drum.phaser.rate'
  | 'fx.drum.delay.time'
  | 'fx.master.comp'
  | 'fx.master.comp.threshold'
  | 'fx.sampler.phaser.rate'
  | 'fx.sampler.delay.time'
  | 'arp'
  | 'seq'
  | 'seq.prob'
  | 'seq.ratchet'
  | 'seq.tie'
  | 'drums'
  | 'sampler'
  | 'motion'
  | 'song'
  | 'song.load'
  | 'song.save'
  | 'song.import'
  | 'song.export'
  | 'song.new'
  | 'song.exportAudio'
  | 'song.record'
  | 'sync'
  | 'sync.wifi'
  | 'keyboard'
  | 'pitchBend'
  | 'transpose'
  | 'modWheel'
  | 'scope';

export const HELP_TOPICS: Record<TopicId, HelpTopic> = {
  transport: {
    title: 'Transport (Play)',
    body:
      '<p>Play / Stop for the whole machine. The sequencer, drum machine, sampler and songs ' +
      'only advance while the transport is running — the keyboard does <em>not</em> need it, so ' +
      'you can always play notes by hand.</p>' +
      '<p>The <strong>BPM</strong> knob beside it sets the tempo in beats per minute. The little ' +
      'LED blinks in time so you can feel the beat.</p>',
  },
  'transport.swing': {
    title: 'Swing',
    body:
      '<p><strong>Swing</strong> lays the off-beat 16th-notes back a little, turning a stiff, ' +
      'straight pattern into a shuffling, human groove. At 0% the grid is dead straight; turn it ' +
      'up for more shuffle.</p>' +
      '<p>It lives on the clock, so it shapes <em>everything</em> at once — the sequencer, drums, ' +
      'sampler and arpeggiator all stay locked together.</p>',
  },
  voicing: {
    title: 'Mono / Poly',
    body:
      '<p>How many notes can sound at once.</p>' +
      '<p><strong>Poly</strong> plays chords — up to 8 notes together. Best for pads, keys and ' +
      'anything harmonic.</p>' +
      '<p><strong>Mono</strong> plays one note at a time, like a classic bass or lead synth. ' +
      'Mono is also what makes <strong>GLIDE</strong> slide musically from note to note.</p>',
  },
  panic: {
    title: 'Panic',
    body:
      '<p>An emergency “all notes off”. If a note ever sticks on (a hung MIDI note, a lost ' +
      'pointer, a runaway pattern), hit <strong>Panic</strong> to silence everything instantly ' +
      'and stop the transport. Harmless to press any time. The <strong>Esc</strong> key does the ' +
      'same thing.</p>',
  },
  oscillators: {
    title: 'Oscillators (OSC 1 & 2)',
    body:
      '<p>The raw tone generators — the source of the sound. There are two identical ones, ' +
      '<strong>OSC 1</strong> and <strong>OSC 2</strong>, so you can layer them.</p>' +
      '<ul>' +
      '<li><strong>Wave</strong> — the waveform (sine, triangle, saw, square). Saw is bright and ' +
      'buzzy; sine is pure and soft.</li>' +
      '<li><strong>OCT</strong> — shifts this oscillator up or down whole octaves.</li>' +
      '<li><strong>TUNE</strong> — fine pitch in semitones. Detune OSC 2 a little against OSC 1 ' +
      'for a thick, lively sound.</li>' +
      '<li><strong>LEVEL</strong> — how loud this oscillator is in the mix.</li>' +
      '</ul>',
  },
  subuni: {
    title: 'Sub & Unison',
    body:
      '<p><strong>Sub-oscillator</strong> — an extra oscillator that adds weight, usually an ' +
      'octave below. Set its <strong>wave</strong>, <strong>S.OCT</strong> (octave) and ' +
      '<strong>S.LVL</strong> (level) for body and bass.</p>' +
      '<p><strong>Unison</strong> stacks detuned copies of each voice for a huge, wide sound. ' +
      '<strong>UNISON</strong> sets how many copies; <strong>SPREAD</strong> sets how far they ' +
      'detune apart. 1 voice = off.</p>',
  },
  mixer: {
    title: 'Mixer & Glide',
    body:
      '<ul>' +
      '<li><strong>NOISE</strong> — blends in white noise. A touch adds breath; a lot makes wind ' +
      'and percussion.</li>' +
      '<li><strong>GLIDE</strong> — slides pitch from one note to the next (portamento). Most ' +
      'obvious in Mono voicing.</li>' +
      '<li><strong>DRIFT</strong> — gentle random pitch wander that mimics the warmth of analogue ' +
      'hardware.</li>' +
      '</ul>' +
      '<p>The mode switch sets <em>when</em> glide applies (always, or only when notes overlap).</p>',
  },
  filter: {
    title: 'Filter',
    body:
      '<p>The tone-shaping heart of a synth — it removes frequencies to make the sound darker or ' +
      'brighter.</p>' +
      '<ul>' +
      '<li><strong>CUTOFF</strong> — where the filter starts cutting (dark ↔ bright). The classic ' +
      'sweep.</li>' +
      '<li><strong>RESO</strong> — emphasises frequencies right at the cutoff for a vocal, ' +
      'whistling edge.</li>' +
      '<li><strong>DRIVE</strong> — pushes the filter harder for grit and warmth.</li>' +
      '<li><strong>ENV</strong> — how much the Filter envelope moves the cutoff (see Filter Env).</li>' +
      '</ul>',
  },
  'filter.cutoff': {
    title: 'Filter — Cutoff',
    body: renderFilterCutoff,
  },
  'filter.resonance': {
    title: 'Filter — Resonance',
    body: renderFilterResonance,
  },
  ampenv: {
    title: 'Amp Envelope (ADSR)',
    body:
      '<p>Shapes the <strong>volume</strong> of a note over time, from press to release:</p>' +
      '<ul>' +
      '<li><strong>A</strong>ttack — how fast it fades in (0 = instant, like a pluck; high = a ' +
      'slow swell).</li>' +
      '<li><strong>D</strong>ecay — how it falls from the peak down to the sustain level.</li>' +
      '<li><strong>S</strong>ustain — the level it holds while you keep the key down.</li>' +
      '<li><strong>R</strong>elease — how long it takes to fade out after you let go.</li>' +
      '</ul>',
  },
  filterenv: {
    title: 'Filter Envelope (ADSR)',
    body:
      '<p>The same A / D / S / R shape, but instead of volume it moves the <strong>filter ' +
      'cutoff</strong> over time — great for plucks that open bright then close, or slow sweeps.</p>' +
      "<p>How <em>strongly</em> it pushes the cutoff is set by the filter's <strong>ENV</strong> " +
      'knob; the ADSR knobs here set the shape of that movement.</p>',
  },
  lfo: {
    title: 'LFO',
    body:
      '<p>A Low-Frequency Oscillator — a slow, automatic “knob-wiggler” that adds movement.</p>' +
      '<ul>' +
      '<li><strong>Wave</strong> — the shape of the movement (sine for smooth, square for ' +
      'on/off).</li>' +
      '<li><strong>RATE</strong> — how fast it wiggles.</li>' +
      '<li><strong>AMT</strong> — how much it moves the target.</li>' +
      '<li><strong>Destination</strong> — what it modulates (e.g. pitch for vibrato, filter for ' +
      'wobble).</li>' +
      '</ul>',
  },
  fx: {
    title: 'Effects chain',
    body:
      '<p>A chain of five effects the synth runs through: <strong>Distortion → Wah → Phaser → ' +
      'Delay → Reverb</strong>. Each has an on/off switch and three knobs. Switch one on and ' +
      'tweak — they turn a plain tone into something spacious or gnarly. Click the (i) on each ' +
      'effect for details.</p>',
  },
  'fx.dist': {
    title: 'Distortion',
    body:
      '<p>Adds harmonics and grit, from gentle warmth to full fuzz.</p>' +
      '<ul><li><strong>DRIVE</strong> — how hard it is pushed.</li>' +
      '<li><strong>TONE</strong> — brightness of the distorted sound.</li>' +
      '<li><strong>MIX</strong> — blend of dry vs distorted.</li></ul>',
  },
  'fx.wah': {
    title: 'Wah',
    body:
      '<p>A sweeping filter that makes a vocal “wah” motion.</p>' +
      '<ul><li><strong>RATE</strong> — speed of the sweep.</li>' +
      '<li><strong>DEPTH</strong> — how far it sweeps.</li>' +
      '<li><strong>Q</strong> — sharpness of the peak (higher = more vocal).</li></ul>',
  },
  'fx.phaser': {
    title: 'Phaser',
    body:
      '<p>Creates a swirling, sweeping shimmer by phase-cancelling parts of the sound.</p>' +
      '<ul><li><strong>RATE</strong> — speed of the swirl.</li>' +
      '<li><strong>DEPTH</strong> — intensity of the effect.</li>' +
      '<li><strong>FB</strong> — feedback; more makes it more resonant and metallic.</li>' +
      '<li><strong>MIX</strong> — wet vs dry blend; the swirl is strongest around the middle.</li></ul>',
  },
  'fx.delay': {
    title: 'Delay',
    body:
      '<p>An echo of the sound.</p>' +
      '<ul><li><strong>TIME</strong> — gap between echoes.</li>' +
      '<li><strong>FB</strong> — feedback; how many times it repeats.</li>' +
      '<li><strong>MIX</strong> — how loud the echoes are vs the dry sound.</li></ul>',
  },
  'fx.reverb': {
    title: 'Reverb',
    body:
      '<p>Places the sound in a space, from a small room to a vast hall.</p>' +
      '<ul><li><strong>SIZE</strong> — how big the space feels.</li>' +
      '<li><strong>DAMP</strong> — how quickly the tail darkens (soft furnishings vs tile).</li>' +
      '<li><strong>MIX</strong> — wet vs dry blend.</li></ul>',
  },
  'fx.drum.comp': {
    title: 'Drum Compressor (1176 style)',
    body:
      '<p>A compressor evens out loudness — it turns peaks down so you can turn the whole ' +
      'thing up. This one is modelled on the <strong>UREI 1176</strong>, a FET studio classic ' +
      'famous for lightning-fast attack and aggressive punch: <em>the</em> drum compressor.</p>' +
      '<ul>' +
      '<li><strong>THR</strong> — level where compression starts. Lower = more squash.</li>' +
      '<li><strong>RATIO</strong> — how hard it clamps (4:1 … 20:1). <strong>ALL</strong> is the ' +
      'famous “all buttons in” mode: crushed, exploding drum room.</li>' +
      '<li><strong>ATK</strong> — microseconds! Fast flattens the hit; slower lets the initial ' +
      'crack punch through before the squash.</li>' +
      '<li><strong>REL</strong> — recovery speed; it also adapts to the material, like the ' +
      'hardware.</li>' +
      '<li><strong>GAIN</strong> — makeup volume to bring the squashed signal back up.</li>' +
      '</ul>' +
      '<p>The bar shows live <strong>gain reduction</strong>. Try THR low, RATIO ALL, fast ATK ' +
      'and watch it slam — it also adds a little FET grit as it works.</p>',
  },
  'fx.master.comp': {
    title: 'Master Compressor (SSL bus style)',
    body:
      '<p>Modelled on the <strong>SSL G-Series bus compressor</strong> — the “glue” on countless ' +
      'mixes. A clean VCA design with a gentle soft knee that pulls everything together so the ' +
      'whole song moves as one. It sits on the master bus, after the DJ filter.</p>' +
      '<ul>' +
      '<li><strong>THR</strong> — aim for 2–4 dB on the gain-reduction bar for classic glue.</li>' +
      '<li><strong>RATIO</strong> — 2:1 is the glue setting; 4:1 tighter; 10:1 slams.</li>' +
      '<li><strong>ATK</strong> — around 10–30 ms lets transients breathe through.</li>' +
      '<li><strong>REL</strong> — fixed times, or <strong>auto</strong> (the hardware’s trademark): ' +
      'fast after hits, slow under sustained level. Leave it on auto.</li>' +
      '<li><strong>GAIN</strong> — makeup volume.</li>' +
      '</ul>' +
      '<p>Use it subtly for a louder, denser, more “finished” mix — or hard, where it pumps ' +
      'musically with DJ filter sweeps and drops.</p>',
  },

  // ---- BPM-aware "sweet spots" (delays show ms, rates show Hz) ----
  'fx.delay.time': {
    title: 'Delay Time — sweet spots',
    body: (ctx) => renderTempoSync(ctx, 'fx.delay.time', 'time'),
  },
  'fx.drum.delay.time': {
    title: 'Drum Delay Time — sweet spots',
    body: (ctx) => renderTempoSync(ctx, 'fx.drum.delay.time', 'time'),
  },
  'fx.sampler.delay.time': {
    title: 'Sampler Delay Time — sweet spots',
    body: (ctx) => renderTempoSync(ctx, 'fx.sampler.delay.time', 'time'),
  },
  'lfo.rate': {
    title: 'LFO Rate — sync to tempo',
    body: (ctx) => renderTempoSync(ctx, 'lfo.rate', 'freq'),
  },
  'fx.wah.rate': {
    title: 'Wah Rate — sync to tempo',
    body: (ctx) => renderTempoSync(ctx, 'fx.wah.rate', 'freq'),
  },
  'fx.phaser.rate': {
    title: 'Phaser Rate — sync to tempo',
    body: (ctx) => renderTempoSync(ctx, 'fx.phaser.rate', 'freq'),
  },
  'fx.drum.phaser.rate': {
    title: 'Drum Phaser Rate — sync to tempo',
    body: (ctx) => renderTempoSync(ctx, 'fx.drum.phaser.rate', 'freq'),
  },
  'fx.sampler.phaser.rate': {
    title: 'Sampler Phaser Rate — sync to tempo',
    body: (ctx) => renderTempoSync(ctx, 'fx.sampler.phaser.rate', 'freq'),
  },

  // ---- Mutual-dependency explainers (live derived numbers) ----
  'filter.envAmount': {
    title: 'Filter — Env Amount',
    body: renderFilterEnvAmount,
  },
  'unison.detune': {
    title: 'Unison — Spread',
    body: renderUnisonDetune,
  },
  'fx.drum.comp.threshold': {
    title: 'Drum Compressor — Threshold',
    body: (ctx) => renderCompThreshold(ctx, 'fx.drum.comp'),
  },
  'fx.master.comp.threshold': {
    title: 'Master Compressor — Threshold',
    body: (ctx) => renderCompThreshold(ctx, 'fx.master.comp'),
  },

  arp: {
    title: 'Arpeggiator',
    body:
      '<p>Hold a chord and the arpeggiator plays its notes one after another as a pattern. ' +
      'Holding a key even <strong>starts the transport for you</strong>, so it sounds without ' +
      'pressing Play.</p>' +
      '<ul><li><strong>Pattern</strong> — order of the notes (up, down, up-down, random, ' +
      'as-played).</li>' +
      '<li><strong>Rate</strong> — note speed (1/4 … 1/32).</li>' +
      '<li><strong>Octaves</strong> — how many octaves it climbs through.</li>' +
      '<li><strong>Gate</strong> — how long each note is held.</li></ul>',
  },
  seq: {
    title: 'Sequencer',
    body:
      '<p>A 16-step melodic sequencer — it plays a repeating riff while the transport runs. Click ' +
      'a step to switch it on, then set its note (and velocity / gate for the selected step).</p>' +
      '<p>Each selected step also has <strong>Prob</strong>, <strong>Ratchet</strong> and ' +
      '<strong>Tie</strong> for variation, rolls and legato slides — flip on the (i) badges beside ' +
      'them for the details.</p>' +
      '<p><strong>Filling it fast:</strong> arm <strong>Step Input</strong> and play notes on the ' +
      'keyboard (or MIDI) — each lands in the selected step and the cursor advances on its own. ' +
      'Or <strong>scroll</strong> a step to change its pitch, and <strong>Shift</strong>+click ± / ' +
      'Shift+scroll to jump a whole octave.</p>' +
      '<p>It has four banks (<strong>A–D</strong>) you can fill with different riffs and chain ' +
      'together in Song mode. Switch the sequencer on with its <strong>on</strong> toggle.</p>',
  },
  'seq.prob': {
    title: 'Step Probability',
    body:
      '<p><strong>Prob</strong> is the chance the selected step fires each time the pattern comes ' +
      'round. At 100% it always plays; lower it and the step drops in and out at random, so the ' +
      'loop never repeats exactly.</p>' +
      '<p>Great for ghost notes, hats and fills that keep evolving on their own.</p>',
  },
  'seq.ratchet': {
    title: 'Ratchet',
    body:
      '<p><strong>Ratchet</strong> retriggers the step <strong>1–4 times</strong> inside its own ' +
      'slot — a quick roll or stutter on a single step. 1 is a normal hit; 4 fires four ' +
      'evenly-spaced sub-hits.</p>',
  },
  'seq.tie': {
    title: 'Tie / Slide',
    body:
      '<p><strong>Tie</strong> holds the step into the next one instead of releasing it, for ' +
      'smooth legato lines.</p>' +
      '<p>With <strong>glide</strong> turned up (and Mono voicing) the held note <em>slides</em> ' +
      'in pitch to the next step — the classic acid-bassline slide.</p>',
  },
  drums: {
    title: 'Drum Machine',
    body:
      '<p>A classic 16-step drum grid with eight tracks (kick, snare, hats, toms, clap). Click ' +
      'cells to place hits; each track has a <strong>mute</strong> and you can audition a sound ' +
      'by clicking its name. Runs while the transport plays.</p>' +
      '<p><strong>MASTER</strong> sets the kit volume, and there are dedicated drum effects. Four ' +
      'banks (<strong>A–D</strong>) chain together in Song mode.</p>',
  },
  sampler: {
    title: 'Sampler',
    body:
      '<p>Eight slots that each play your own sound as a one-shot on a 16-step grid. ' +
      '<strong>Load</strong> a WAV/MP3 into a slot, or use <strong>Record a sound</strong> to ' +
      'capture from your mic and edit it. The ✎ button re-opens a loaded sound in the editor.</p>' +
      '<p>Plays while the transport runs, with its own master and effects. Note: after loading a ' +
      'saved song you re-load the audio files (only their names are stored).</p>',
  },
  motion: {
    title: 'Motion sequencer',
    body:
      '<p>Automates the two knobs assigned to the <strong>XY Pad</strong> while the transport ' +
      'plays. Each of the 16 mini pads is an optional <em>anchor</em>: drag inside one to set an ' +
      'X/Y position for that step, double-click to clear it. <strong>SLIDE</strong> ramps ' +
      'smoothly between anchors; <strong>STEP</strong> jumps at each anchor and holds.</p>' +
      '<p><strong>Reading the graph:</strong> every dot stores <em>two</em> values (X and Y), but ' +
      'the overlay line can only trace one at a time. The <strong>Y / X</strong> toggle picks ' +
      'which one it shows — <strong>Y</strong> (the default) draws each anchor’s vertical ' +
      'position, <strong>X</strong> its horizontal position. The dots themselves never move; only ' +
      'the line is re-projected. The axes row below shows which parameter each axis drives.</p>' +
      '<p>In Song mode the Motion card chains banks like the other machines, and its ' +
      '<strong>Mute</strong> pauses automation — every driven knob returns to its resting value.</p>',
  },
  song: {
    title: 'Song mode',
    body:
      '<p>Arrange your patterns into a full track. Chain banks for the sequencer, drums and ' +
      'sampler, add live DJ-style FX (<strong>Fill, Stutter, Drop, Tape&nbsp;Stop</strong> and a ' +
      'sweepable DJ filter), and save / load / export songs.</p>' +
      '<p>The demo buttons load complete examples — remember to press <strong>Play</strong> ' +
      'afterwards to hear them.</p>' +
      '<p>Not sure what a button does? <strong>Save</strong>, <strong>Export</strong> and the ' +
      'audio <strong>Export Song</strong> are easy to mix up — each file button has its own (i) ' +
      'badge with the details.</p>',
  },
  'song.load': {
    title: 'Load',
    body:
      '<p>Loads the song chosen in the <strong>Slot</strong> dropdown back from your browser, ' +
      "replacing the current banks, chains and settings. Slots are the songs you've " +
      '<strong>Saved</strong> (plus the demos).</p>' +
      '<p>It only loads — your current unsaved work is discarded, so <strong>Save</strong> first ' +
      'if you want to return to it.</p>',
  },
  'song.save': {
    title: 'Save',
    body:
      '<p><strong>Save</strong> keeps the whole song. It asks for a name, then does two things: ' +
      'stores it in your browser so it appears in the <strong>Slot</strong> list (ready to ' +
      '<strong>Load</strong> later) <em>and</em> downloads a <strong>.json</strong> backup file.</p>' +
      '<p>This is the one to use to keep a song you are working on. By contrast, ' +
      '<strong>Export</strong> only downloads the file — it does <em>not</em> add a slot.</p>',
  },
  'song.import': {
    title: 'Import',
    body:
      '<p>Opens a song file from your computer — a <strong>.json</strong> song or a ' +
      '<strong>.websynth.zip</strong> project — one you or someone else <strong>Exported</strong> ' +
      'or <strong>Saved</strong> — loads it, and adds it to your <strong>Slot</strong> list so ' +
      'you can reach it again. A project zip also brings its sampler audio back into the slots.</p>' +
      '<p>It is the counterpart to <strong>Export</strong>: Export writes the file, Import reads ' +
      'it back in.</p>',
  },
  'song.export': {
    title: 'Export',
    body:
      '<p>Downloads the current song — the editable project (banks, chains, settings), ' +
      '<em>not</em> rendered audio. It asks which kind: <strong>Song (.json)</strong>, a compact ' +
      'file without sampler audio, or <strong>Project (.zip)</strong>, which bundles the song ' +
      'with every loaded sampler clip so it re-imports in one step. Good for sharing a song or ' +
      'backing it up outside the browser; bring either back with <strong>Import</strong>.</p>' +
      '<p>Two things it is <em>not</em>: unlike <strong>Save</strong> it does not add the song to ' +
      'your <strong>Slot</strong> list, and unlike <strong>Export Song</strong> (below) it does ' +
      'not render any sound.</p>',
  },
  'song.new': {
    title: 'New',
    body:
      '<p>Clears every bank and chain — sequencer, drums and sampler — back to empty so you can ' +
      'start a fresh song. It asks for confirmation first, as it cannot be undone.</p>' +
      '<p><strong>Save</strong> or <strong>Export</strong> anything you want to keep before ' +
      'pressing it.</p>',
  },
  'song.exportAudio': {
    title: 'Export Song (audio)',
    body:
      '<p>Renders the arrangement to an <strong>audio file</strong> you can play anywhere — pick ' +
      '<strong>WAV</strong> (lossless) or <strong>MP3</strong> with the Format switch. It plays ' +
      'one full pass of the longest chain, then downloads automatically.</p>' +
      '<p>This is the actual <em>sound</em>. To save the editable project instead, use ' +
      '<strong>Export</strong> (a <strong>.json</strong> file) up above.</p>',
  },
  'song.record': {
    title: 'Record',
    body:
      '<p>A free-form audio recorder. Press <strong>Record</strong> and it captures everything ' +
      'that plays — live notes, patterns, knob tweaks — to a <strong>WAV</strong> or ' +
      '<strong>MP3</strong> file (set the Format), starting the transport if it is stopped. Press ' +
      '<strong>Stop</strong> to finish and download.</p>' +
      '<p>Use it to grab a jam or a take; use <strong>Export Song</strong> for a clean, automatic ' +
      'render of the whole arrangement.</p>',
  },
  sync: {
    title: 'Sync (Master / Slave)',
    body:
      '<p>Lock this synth to another one so they play in step. One is the ' +
      '<strong>Master</strong> — its Play/Stop and tempo drive the other — and the other is the ' +
      '<strong>Slave</strong>, which follows. It speaks standard MIDI clock, so it also syncs ' +
      'with hardware gear.</p>' +
      '<ul>' +
      '<li><strong>USB-MIDI</strong> — connect the two over USB. On Android, put the device in ' +
      'its built-in <em>USB-MIDI peripheral</em> mode; on Windows, a virtual MIDI cable such as ' +
      '<strong>loopMIDI</strong> bridges two apps on one machine.</li>' +
      '<li>Pick <strong>Master</strong> on one instrument and <strong>Slave</strong> on the other. ' +
      'The status line shows the port count and the followed tempo.</li>' +
      '</ul>' +
      '<p>Your choice is remembered, but it only takes effect while something is actually ' +
      'connected — disconnect and it greys out to <em>armed</em>, the BPM knob comes back to ' +
      'you, and it picks up again by itself when the clock returns.</p>' +
      '<p>No cable? Use <strong>WiFi link…</strong> instead (see its own badge).</p>',
  },
  'sync.wifi': {
    title: 'WiFi sync (no cable)',
    body:
      '<p>Pair two devices over the same WiFi — no server, no account. It works when both are on ' +
      'the same network with <strong>client isolation off</strong> (some guest/public WiFi blocks ' +
      'device-to-device traffic).</p>' +
      '<ol>' +
      '<li>On one device press <strong>WiFi link…</strong> → <strong>Create link</strong>.</li>' +
      '<li>On the other press <strong>WiFi link…</strong> → <strong>Join a link</strong>, and give ' +
      'it the first device’s code (paste it, or <strong>scan the QR</strong> where your camera ' +
      'supports it).</li>' +
      '<li>Send the answer code back to the first device to finish. When both show ' +
      '<strong>Linked ✓</strong> you’re synced — set one to Master and the other to Slave.</li>' +
      '</ol>' +
      '<p>Cross-device WiFi needs the secure (HTTPS) site; two tabs on one computer work on ' +
      '<em>localhost</em>.</p>',
  },
  keyboard: {
    title: 'Keyboard',
    body:
      '<p>Click the on-screen keys to play, or use your computer keyboard: ' +
      '<strong>Z X C V…</strong> for the lower octave and <strong>Q W E R…</strong> for the upper. ' +
      'The <strong>←</strong> / <strong>→</strong> arrow keys shift octave.</p>' +
      '<p>Notes sound immediately, with or without the transport running.</p>',
  },
  pitchBend: {
    title: 'Pitch wheel',
    body:
      '<p>Drag up or down to bend the pitch of held notes, then release — it springs back to ' +
      'centre, just like the wheel on a hardware synth. Great for expressive lead lines. The ' +
      '<strong>.</strong> and <strong>/</strong> keys bend it too.</p>',
  },
  transpose: {
    title: 'Octave',
    body:
      '<p>Shifts the whole keyboard up or down in octaves, so you can reach low bass or high ' +
      'leads without running out of keys. It stays where you set it (no spring-back).</p>',
  },
  modWheel: {
    title: 'Mod wheel',
    body:
      '<p>Boosts the LFO on top of its Amount knob — pushing the wheel up deepens whatever ' +
      'the LFO is pointed at: <strong>wobble</strong> (cutoff), <strong>vibrato</strong> ' +
      '(pitch), <strong>tremolo</strong> (amp) or <strong>PWM movement</strong> (pulse).</p>' +
      '<p>If the LFO destination is off, the wheel does nothing — pick a destination first.</p>',
  },
  scope: {
    title: 'Wave / Spectrum view',
    body:
      '<p>A live visualiser of the sound. <strong>Wave</strong> shows the waveform like an ' +
      'oscilloscope (you can see the shape of the tone); <strong>Spectrum</strong> shows the ' +
      'frequency content (bass on the left, treble on the right). Click the button to switch.</p>' +
      '<p>The <strong>Mono/Stereo</strong> button splits the view: <strong>Stereo</strong> shows ' +
      'the <strong>L</strong> and <strong>R</strong> channels separately, so you can see stereo ' +
      'effects (reverb, delay, phaser) move the channels apart.</p>' +
      '<p>In <strong>Spectrum</strong> a dotted <strong>max-dB</strong> line is pushed up by the ' +
      'bars to mark the loudest level reached (0 dB at the top = clipping) — handy when riding the ' +
      'compressors. It holds the peak briefly, then falls back very slowly; ' +
      '<strong>click the graph</strong> to reset it.</p>' +
      '<p>It taps the signal <em>before</em> the volume knob, so the display stays steady whatever ' +
      'your volume.</p>',
  },
};

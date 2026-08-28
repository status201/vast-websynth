// All the onboarding copy lives here (kept out of params.ts so the param model
// stays pure): the interactive tour script + the contextual help topics shown
// by the ⓘ info badges.
import type { TourStep } from './tour';
import { UI_ICONS, iconLabel, type IconName } from '../components/ui-icons';
import type { ParamBus } from '../../state/params';
import {
  renderTempoSync,
  renderFilterCutoff,
  renderFilterResonance,
  renderFilterEnvAmount,
  renderUnisonDetune,
  renderCompThreshold,
} from './help-widgets';

/**
 * A control's glyph inside help copy, drawn rather than typed (iconography.md
 * REQ-1). `<strong>` because that is how this copy already marks a control's
 * name; the SVG is aria-hidden, so the label on the wrapper is what a screen
 * reader gets — without it the sentence would simply lose a word (REQ-3).
 */
const g = (name: IconName, label: string): string =>
  `<strong role="img" aria-label="${label}">${UI_ICONS[name]}</strong>`;

/** The Clear button, which wears a caret. Referred to in three topics. */
const CLEAR_BTN = `<strong>${iconLabel('caretDown', 'Clear', 'after')}</strong>`;

/** A loud, instantly-recognisable demo for the "load a demo" headline step. */
export const DEMO_FOR_TOUR = 'Night Rider';

function clickTestId(id: string): void {
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.click();
}

export const TOUR_STEPS: TourStep[] = [
  {
    title: 'Welcome to VAST G1-J8',
    body:
      'This is a real synthesizer — knobs, oscillators, the works. ' +
      "Don't worry, in about a minute you'll be making sound. Hit <strong>Next</strong>.",
  },
  {
    target: 'keyboard',
    title: 'Press a key — hear it',
    body:
      'Click any key below, or play the bottom two letter rows of your computer keyboard. ' +
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
    // Awaited: the tour demo is a drop-in, so it is fetched rather than bundled
    // (song-mode.md REQ-12) — starting the transport before it lands would play
    // whatever was loaded before, which for a first-time visitor is silence.
    action: async (ctx) => {
      await ctx.applyDemo(DEMO_FOR_TOUR);
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
    // Deliberately the DRUM grid, not the sequencer the previous step spotlights:
    // two steps sharing a target leave the spotlight rect unmoved, which reads as
    // "nothing happened". The demo loaded earlier has filled this grid, so the
    // gestures land on real content (onboarding.md REQ-13).
    target: 'panel-drums',
    title: 'Paint a pattern',
    body:
      'Tap a step to switch it on. <strong>Drag</strong> across several and they all follow — ' +
      'start on a lit step and the drag erases instead. <strong>Hold</strong> one to edit it ' +
      'without switching it off, and ' + CLEAR_BTN + ' wipes a row or the bank ' +
      '(Undo brings it back).',
    placement: 'top',
    precondition: () => clickTestId('tab-drums'),
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
    target: 'info-badges',
    title: "That's it — go play",
    body:
      'You know enough to make noise. Stuck on a control? This ' + g('info', 'Info badges') +
      ' button switches ' +
      'on the info badges — one on every section, each explaining what it does. Next to it, ' +
      '<strong>?</strong> replays this tour and lists the keyboard shortcuts.',
    placement: 'bottom',
  },
];

// ---- Contextual help (the copy behind the ⓘ info badges) ----

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

/**
 * The step-grid gesture vocabulary (step-grid-editing.md), shared verbatim by the
 * seq / drum / sampler topics. One constant, not three paraphrases: the gestures
 * are identical on all three grids, and copy that drifts between machines is
 * worse than none. Motion states its own variant — it has no tap-toggle and its
 * Clear ▾ lists lanes rather than a selected row (onboarding.md REQ-11).
 */
const GRID_GESTURES =
  '<p><strong>Editing faster:</strong> <strong>drag</strong> across the grid to paint a whole ' +
  'run at once — starting on a lit step erases instead of filling. <strong>Press and hold</strong> ' +
  'a step (or right-click it) to select it for editing <em>without</em> switching it off, and ' +
  '<strong>Delete</strong> clears the selected step. ' + CLEAR_BTN + ' wipes the whole bank ' +
  'or just the row you have selected, and <strong>Ctrl+Z</strong> undoes the last edit on the tab ' +
  'you are looking at — even a bulk clear comes back in one press.</p>';

/**
 * The playhead ruler above every machine grid (transport-position.md). One
 * constant behind four topic ids: the control is identical on all four tabs, so
 * four paraphrases of the same copy would only drift apart.
 */
const RULER_HELP: HelpTopic = {
  title: 'Playhead ruler',
  body:
    '<p>The strip above the grid is the <strong>transport position</strong>. Click any tick to ' +
    'move the playhead there — while the song is playing it jumps in time, and while it is ' +
    'stopped it sets where <strong>Play</strong> will start from.</p>' +
    '<p>There are <strong>two marks</strong>. A filled tick is the playhead, moving as the song ' +
    'plays. An <strong>outlined</strong> tick is the <em>cue</em> — where Play begins. So while ' +
    'stopped you see only the outline: that is your start point, and nothing is playing. Stop ' +
    'and Play again and you return to it.</p>' +
    '<p>The readout on the left says where you are. With no chains switched on, your song is ' +
    'one bank looping, so it names that bank — <strong>BANK A</strong> — matching the A/B/C/D ' +
    'buttons. Switch on a <strong>Chain</strong> and it becomes <strong>BAR 3/4</strong> with ' +
    g('chevronLeft', 'Previous bar') + ' ' + g('chevronRight', 'Next bar') +
    ' arrows that step a bar at a time, keeping the same ' +
    'step within the bar.</p>' +
    '<p>Unlike the lit step in the grid below it, this always tells you where you are — even ' +
    'when the transport is stopped, this machine is switched off, or you are editing one bank ' +
    'while another one plays.</p>' +
    '<p><strong>Home</strong> jumps back to the start, and <strong>Shift</strong> + ' +
    g('arrowLeft', 'Left arrow') + ' / ' + g('arrowRight', 'Right arrow') +
    ' steps one bar (from the top of the bar). The Song ' +
    'tab has a scrubber for the whole arrangement.</p>',
};

export type TopicId =
  | 'transport'
  | 'transport.swing'
  | 'meter'
  | 'voicing'
  | 'panic'
  | 'presets'
  | 'oscillators'
  | 'subuni'
  | 'mixer'
  | 'filter'
  | 'filter.cutoff'
  | 'filter.resonance'
  | 'filter.envAmount'
  | 'filter.model'
  | 'filter.shape'
  | 'unison.detune'
  | 'ampenv'
  | 'filterenv'
  | 'lfo'
  | 'lfo.rate'
  | 'lfo2.rate'
  | 'fx'
  | 'fx.dist'
  | 'fx.wah'
  | 'fx.wah.rate'
  | 'fx.phaser'
  | 'fx.phaser.rate'
  | 'fx.delay'
  | 'fx.delay.time'
  | 'fx.reverb'
  | 'fx.duck'
  | 'fx.drum.comp'
  | 'fx.drum.comp.threshold'
  | 'fx.drum.phaser.rate'
  | 'fx.drum.delay.time'
  | 'fx.master.comp'
  | 'fx.master.comp.threshold'
  | 'fx.sampler.phaser.rate'
  | 'fx.sampler.delay.time'
  | 'arp'
  | 'key'
  | 'seq'
  | 'seq.prob'
  | 'seq.ratchet'
  | 'seq.tie'
  | 'seq.chord'
  | 'seq.render'
  | 'drums'
  | 'sampler'
  | 'sampler.pitch'
  | 'sampler.window'
  | 'sampler.env'
  | 'sampler.tone'
  | 'sampler.choke'
  | 'motion'
  | 'motion.xy'
  | 'motion.tracks'
  // One ruler per machine tab, and only the visible tab's badge is on screen
  // (a hidden anchor measures 0×0 and its badge hides), so each lane needs its
  // own topic id — the ids differ, the copy does not. Same shape as the
  // per-machine fx.drum.* / fx.sampler.* topics.
  | 'transport.ruler.seq'
  | 'transport.ruler.drum'
  | 'transport.ruler.sampler'
  | 'transport.ruler.motion'
  | 'transport.song'
  | 'song'
  | 'song.fx'
  | 'mod'
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
  meter: {
    title: 'Meter (time signature)',
    body:
      '<p><strong>METER</strong> sets the song\'s time signature. Every machine follows it at ' +
      'once — pick <strong>7/8</strong> and the step grids redraw to fourteen columns, the ruler ' +
      'numbers seven beats, and the red accent columns move with them. There is nothing else to ' +
      'set up.</p>' +
      '<p>Each machine also has its own <strong>GRID</strong> pair in its header. Leave ' +
      '<strong>LEN</strong> on <em>BAR</em> and <strong>RATE</strong> on <em>1/16</em> and it ' +
      'simply follows the meter. Change them and that lane goes its own way: 12 steps under a ' +
      '16-step bar drift against each other and line back up every four bars, and a ' +
      '<em>triplet</em> rate plays three notes against the bar\'s two. The line beside the ' +
      'controls tells you which you have, so a lane that is off the bar never looks like a ' +
      'mistake.</p>' +
      '<p><strong>5/4</strong> and <strong>7/4</strong> are twenty and twenty-eight sixteenths — ' +
      'more steps than a grid has — so those set RATE to <em>1/8</em> and use ten or fourteen ' +
      'steps.</p>',
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
  presets: {
    title: 'Presets',
    body:
      '<p>A <strong>preset</strong> is one <em>sound</em> — every knob and switch on the synth, ' +
      'nothing else. (A <strong>song</strong>, over on the Song tab, is the whole arrangement: ' +
      'patterns, chains and a sound.) The dropdown flips through 16 factory sounds plus your own; ' +
      'pick one and play.</p>' +
      '<p>The <strong>Presets</strong> button is the one door for everything else:</p>' +
      '<ul>' +
      '<li><strong>Save current sound</strong> — keep what you are hearing under a name of your ' +
      'own, in this browser.</li>' +
      '<li><strong>Export preset</strong> — one sound as a file, to back up or send to someone.</li>' +
      '<li><strong>Export bank</strong> — many sounds in one file. It offers just the ones you ' +
      'have made or changed (worked out by comparing against the factory sounds), or all of them.</li>' +
      '<li><strong>Import</strong> — read either kind back in.</li>' +
      '</ul>' +
      '<p>Importing always shows you a <strong>review</strong> first, marking each incoming sound ' +
      'as new, identical to one you have, or a name clash — where you choose <em>keep both</em>, ' +
      '<em>overwrite</em> or <em>skip</em>. Nothing is written until you confirm, and the sound ' +
      'you are currently playing is never touched.</p>',
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
      '<li><strong>WIDTH</strong> — only shown on the <strong>square</strong> wave: the pulse ' +
      'width. At 50% it is a plain square; narrowing it thins the tone toward a reedy, ' +
      'hollow buzz. Point the LFO at <em>pulse</em> to sweep it for the classic PWM ' +
      'string/pad shimmer.</li>' +
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
      '<li><strong>SHAPE</strong> — morphs the filter type (POLY only). See below.</li>' +
      '<li><strong>KEYTRK</strong> — how much the note you play raises the cutoff, so the tone ' +
      'stays consistent up the keyboard.</li>' +
      '</ul>' +
      '<p>The switch at the top picks the filter <em>model</em> — two different circuits, ' +
      'same knobs:</p>' +
      '<ul>' +
      '<li><strong>LADDER</strong> — the classic. Warm and growly, and it thins out the bass as ' +
      'you raise RESO, which is exactly why it sounds the way it does.</li>' +
      '<li><strong>POLY</strong> — cleaner and glassier, and it <em>keeps</em> its bottom end when ' +
      'you crank RESO, so the resonance screams on top of a full sound instead of replacing it. ' +
      'It also unlocks the SHAPE knob.</li>' +
      '</ul>',
  },
  'filter.model': {
    title: 'Filter — Model',
    body:
      '<p>Two filters with genuinely different characters. Flip between them on the same patch — ' +
      'they are level-matched, so what you hear is character, not volume.</p>' +
      '<ul>' +
      '<li><strong>LADDER</strong> — 4-pole, saturating at every stage. Warm, compressed, ' +
      'growling. Raising RESO trades bass for the resonant peak.</li>' +
      '<li><strong>POLY</strong> — 4-pole with clean stages and the distortion moved into the ' +
      'resonance itself. Glassy and open; the bass stays put however far you push RESO, and ' +
      'the SHAPE knob turns it into a low-pass, band-pass or high-pass.</li>' +
      '</ul>' +
      '<p>Try it on a bass line: same patch, crank RESO, switch models.</p>',
  },
  'filter.shape': {
    title: 'Filter — Shape',
    body:
      '<p>Morphs the POLY filter through four shapes, so one knob changes <em>what kind</em> of ' +
      'filter it is rather than where it sits:</p>' +
      '<ul>' +
      '<li><strong>LP24</strong> — steep low-pass. Dark and solid, the default.</li>' +
      '<li><strong>LP12</strong> — gentler low-pass. More open, keeps some air.</li>' +
      '<li><strong>BP12</strong> — band-pass. Only frequencies near the cutoff survive: hollow, ' +
      'vocal, great for pads.</li>' +
      '<li><strong>HP24</strong> — high-pass. Bass removed: thin, glassy plucks.</li>' +
      '</ul>' +
      '<p>Point the LFO at <em>shape</em> (or automate it from the motion sequencer) to sweep ' +
      'between them. Greyed out under the LADDER model, which is low-pass only.</p>',
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
      'wobble, pan to sweep the sound between the speakers).</li>' +
      '</ul>' +
      '<p>There are <strong>two</strong>, on the <strong>1</strong> and <strong>2</strong> tabs ' +
      'above — so you can have a filter wobble <em>and</em> a vibrato at once. Each one takes a ' +
      'different destination: whichever one is in use is greyed out on the other tab. A tab ' +
      'lights up when its LFO is moving something, even while you are looking at the other.</p>' +
      '<p>The mod wheel adds depth to <strong>LFO 1</strong> only, so it stays a performance ' +
      'control for one thing rather than opening everything at once.</p>',
  },
  fx: {
    title: 'Effects chain',
    body:
      '<p>A chain of six effects the synth runs through: <strong>Distortion → Wah → Phaser → ' +
      'Delay → Reverb → Duck</strong>. Each has an on/off switch and a few knobs. Switch one on ' +
      'and tweak — they turn a plain tone into something spacious or gnarly. Click the (i) on ' +
      'each effect for details.</p>',
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
  'fx.duck': {
    title: 'Duck (sidechain)',
    body:
      '<p>Pulls the synth down out of the way each time a drum hits, then lets it swell back — ' +
      'the “pumping” of most dance music. It follows the drum pattern itself, so it only pumps ' +
      'while that drum is actually playing.</p>' +
      '<ul><li><strong>AMT</strong> — how far down it pulls.</li>' +
      '<li><strong>ATK</strong> — how fast it gets out of the way.</li>' +
      '<li><strong>REL</strong> — how long it takes to swell back; this one sets the groove.</li>' +
      '<li><strong>SRC</strong> — which drum triggers it (Kick is the classic), or Any.</li></ul>',
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
    title: 'LFO 1 Rate — sync to tempo',
    body: (ctx) => renderTempoSync(ctx, 'lfo.rate', 'freq'),
  },
  'lfo2.rate': {
    title: 'LFO 2 Rate — sync to tempo',
    body: (ctx) => renderTempoSync(ctx, 'lfo2.rate', 'freq'),
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
  key: {
    title: 'Key (scale & chords)',
    body:
      '<p>Pick a <strong>root</strong> and a <strong>scale</strong>, and every note the synth ' +
      'plays is nudged onto the nearest note of that key — the sequencer, the arpeggiator and ' +
      'the keyboard alike. Wrong notes stop being possible.</p>' +
      '<p>The keyboard picture is the map: <strong>orange</strong> is the root, ' +
      '<strong>yellow</strong> the notes of the chord, <strong>brown</strong> the rest of the ' +
      'scale, and dark keys are the notes now out of play.</p>' +
      '<p>Once you pick a scale, the <strong>keyboard at the bottom of the screen</strong> ' +
      'wears those same colours, faintly — so you can see the key under your fingers while ' +
      'you play, without coming back to this tab.</p>' +
      '<ul><li><strong>Scale</strong> — <em>chromatic</em> means "leave everything alone", so ' +
      'nothing changes until you choose a real scale.</li>' +
      '<li><strong>Chord memory</strong> — one held key sounds a whole chord from the scale, ' +
      'and the arpeggiator picks it up. Needs POLY voicing.</li></ul>' +
      '<p><strong>Your notes are never rewritten.</strong> This only changes what you hear, so ' +
      'switching back to <em>chromatic</em> restores your pattern exactly. To make it permanent, ' +
      'use <strong>Snap</strong> on the Sequencer tab.</p>',
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
      'It records only while this tab is open, into the bank you can see: leaving the tab switches ' +
      'it back off, and arming it turns <strong>Follow</strong> off so the song can\'t move your ' +
      'take to another bank. ' +
      'Or <strong>scroll</strong> a step to change its pitch, and <strong>Shift</strong>+click ± / ' +
      'Shift+scroll to jump a whole octave.</p>' +
      '<p><strong>Four tracks</strong> share each bank, so you can stack a chord or run a ' +
      'counter-line under the melody. Tracks 2–4 need <strong>Poly</strong> voicing — in Mono they ' +
      'dim and say so, and flipping back to Poly brings them straight back; nothing is ever ' +
      'rewritten. An empty track folds away to its header until you open it, and each has its own ' +
      '<strong>mute</strong>.</p>' +
      GRID_GESTURES +
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
  'seq.chord': {
    title: 'Chord (write a chord across the tracks)',
    body:
      '<p>Writes a whole chord into the selected step, one note per track — so the four ' +
      'sequencer tracks sound together as a chord. Pick a degree and it is written straight ' +
      'away; one <strong>Undo</strong> takes the whole chord back.</p>' +
      '<p>The degrees are built from the key you set on the <strong>Key</strong> tab, which is ' +
      'why the list is greyed out until you choose a scale. Roman numerals tell you the chord: ' +
      'capital <em>I</em> is major, small <em>ii</em> is minor, <em>vii°</em> is diminished.</p>' +
      '<p>The chord keeps each step\'s own velocity, gate and ratchet — it only sets the notes. ' +
      'Tracks 2–4 need <strong>POLY</strong> voicing to be heard.</p>',
  },
  'seq.render': {
    title: 'Import into sampler (Render)',
    body:
      '<p>Turns the sequencer bank you are looking at into a <strong>sample</strong>. It records ' +
      'one bar of it through the live synth and all its effects, then loads that recording into ' +
      'the sampler slot you picked above.</p>' +
      '<p>Why bother? The sampler then plays that riff on its own — so you are free to change the ' +
      'synth to a completely different sound and <strong>layer</strong> a bass under a lead, or a ' +
      'chord stab under a melody, with one synth.</p>' +
      '<p><strong>It plays the bar twice — that is on purpose.</strong> The first pass gets the ' +
      'reverb and delay ringing; only the <em>second</em> pass is kept, so those tails are already ' +
      'blended in at the start of the loop. Without it the sample would begin bone dry and chop ' +
      'the echo off at the end. So expect about two bars of playing before it lands, then the ' +
      'transport stops by itself.</p>' +
      '<p>The slot is named after what you rendered, like <strong>seq-A-120bpm</strong>. Play with ' +
      'it like any sample: put it on the sampler grid, retune it, or re-open it with ' +
      g('edit', 'Edit') + '.</p>' +
      '<p><strong>Button greyed out?</strong> Either the bank has no steps yet (there would be ' +
      'nothing to record), or the synth is slaved to an external MIDI clock — it needs to own the ' +
      'tempo to cut the bar exactly.</p>' +
      '<p>The recorded audio is <em>not</em> saved inside a song file (only the slot name is), the ' +
      'same as any loaded sample. Render it again after loading, or save it to disk from the ' +
      'slot’s ' + g('edit', 'Edit') + ' editor.</p>',
  },
  drums: {
    title: 'Drum Machine',
    body:
      '<p>A classic 16-step drum grid with eight tracks (kick, snare, hats, toms, clap). Click ' +
      'cells to place hits; each track has a <strong>mute</strong> and you can audition a sound ' +
      'by clicking its name. Runs while the transport plays.</p>' +
      GRID_GESTURES +
      '<p><strong>MASTER</strong> sets the kit volume, and there are dedicated drum effects. Four ' +
      'banks (<strong>A–D</strong>) chain together in Song mode.</p>',
  },
  sampler: {
    title: 'Sampler',
    body:
      '<p>Eight slots that each play your own sound as a one-shot on a 16-step grid. ' +
      '<strong>Load</strong> a WAV/MP3 into a slot, or use <strong>Record a sound</strong> to ' +
      'capture from your mic and edit it. The ' + g('edit', 'Edit') +
      ' button re-opens a loaded sound in the editor.</p>' +
      GRID_GESTURES +
      '<p>Select a slot and the strip below the grid becomes <em>that slot\'s</em> voice: ' +
      'tune it, trim it, reverse it, filter it, place it in the stereo field. The controls ' +
      'that need explaining carry their own badge while these are on.</p>' +
      '<p>In the editor you can also <strong>Chop</strong> a break into slices and spread them ' +
      'across the slots — the classic way to turn one bar of drums into eight playable hits.</p>' +
      '<p>A loop recorded at someone else\'s tempo can be made to fit yours. ' +
      '<strong>FIT</strong> on the slot row retimes it to the nearest bar length in one press, ' +
      'and offers <strong>Undo</strong> afterwards. The editor\'s <strong>Fit</strong> row lets ' +
      'you name the length yourself — one bar, or any count of sixteenths — and pick ' +
      '<em>Rhythmic</em> for drums and loops or <em>Tonal</em> for pads and sustained sounds. ' +
      'The pitch stays exactly where it was, which is what separates this from PITCH. ' +
      '<strong>Shift</strong> beside it does the opposite: it moves the pitch and leaves the ' +
      'length alone.</p>' +
      '<p>Open <strong>Scratch</strong> in the editor to draw a turntable gesture over the ' +
      'clip. The lower lane is the <em>speed</em> of the record: drag a point up and the ' +
      'needle runs faster and higher, drag it below the middle line and it runs backwards. ' +
      'The lane above it shows what will come out, laid over the sixteenths of your bar, so ' +
      'you can see the scratch land on the beat before you hear it. The thin band at the top ' +
      'is the <em>crossfader</em> — tap it to cut the sound out under a stroke, which is what ' +
      'turns a wobble into a scratch. Start from a preset (<em>Baby</em> is the classic short, ' +
      'short, long), roll a random one, hit <strong>Preview</strong> to hear it, and ' +
      '<strong>Scratch</strong> to print it into the clip. Undo takes it straight back.</p>' +
      '<p>Plays while the transport runs, with its own master and effects. A saved ' +
      '<strong>song</strong> stores only the slots\' filenames, so you re-load the audio after ' +
      'opening one; export a <strong>project</strong> instead and the audio travels with it.</p>',
  },

  'sampler.pitch': {
    title: 'Slot — Pitch',
    body:
      '<p>Tunes the slot up or down two octaves, by playing the sample <em>faster or ' +
      'slower</em> — so it changes the <strong>length</strong> as well as the note. Down an ' +
      'octave is twice as long: a chop that filled its step will now run past it, which is ' +
      'the sound, not a bug.</p>' +
      '<p>Pitch belongs to the <em>slot</em>, not to a step — every hit on that row is ' +
      'tuned the same. To hear two pitches at once, put the sample in two slots.</p>' +
      '<p>When you want one without the other, the sample editor separates them: ' +
      '<strong>Fit</strong> changes the length and leaves the pitch alone, ' +
      '<strong>Shift</strong> changes the pitch and leaves the length alone. Both rewrite the ' +
      'clip; this knob stays live and undoable.</p>',
  },

  'sampler.window': {
    title: 'Slot — Start & End',
    body:
      '<p>Chooses <em>which part</em> of the file plays, as a position from its beginning to ' +
      'its end. Pull <strong>START</strong> in to skip a slow attack; pull ' +
      '<strong>END</strong> back to cut a long tail.</p>' +
      '<p>With <strong>REV</strong> on the numbers keep meaning what you see on the waveform ' +
      '— START is still the front of the sound, so reversing does not turn your trim inside ' +
      'out.</p>' +
      '<p>Drag END below START and it holds at the shortest playable sliver rather than ' +
      'going silent, so a slot never stops responding.</p>',
  },

  'sampler.env': {
    title: 'Slot — Attack & Decay',
    body:
      '<p><strong>DECAY</strong> at 0 means <em>no envelope</em>: the sample plays to its ' +
      'natural end. Turn it up and the hit fades out over that time instead — how a long ' +
      'sound becomes a short, tight one without re-editing the file.</p>' +
      '<p><strong>ATK</strong> fades the hit <em>in</em>. Even at 0 there is a half-millisecond ' +
      'ramp: audio that does not begin at silence would otherwise click on every hit, and a ' +
      'sample you recorded is exactly the kind that does.</p>' +
      '<p>Whichever comes first wins — the END trim, the decay, or a shortened ' +
      '<strong>gate</strong> on the step itself.</p>',
  },

  'sampler.tone': {
    title: 'Slot — Tone & Res',
    body:
      '<p>A low-pass filter on this slot alone. <strong>TONE</strong> at 100% is fully open ' +
      '(off); lower it to take the top off a loop so it sits behind something brighter.</p>' +
      '<p><strong>RES</strong> at 0% is flat. Raising it peaks the filter right at the cutoff ' +
      '— the classic filtered-break sweep — and it gets loud fast, so ride ' +
      '<strong>VOL</strong> with it.</p>',
  },

  'sampler.choke': {
    title: 'Slot — Choke & Mono',
    body:
      '<p><strong>CHOKE</strong> puts the slot in one of four groups. Two slots in the same ' +
      'group cut each other off, so a closed hat stops an open one dead instead of the two ' +
      'ringing together — the same trick on an 808, and it works for any pair you like.</p>' +
      '<p><strong>MONO</strong> is the same idea aimed at itself: retriggering the slot cuts ' +
      'its own previous hit rather than layering. Off, hits stack.</p>' +
      '<p>The drum machine has a single CHOKE switch because it can tell a closed hat from an ' +
      'open one by its voice. A sampler slot holds whatever you put in it, so here you say ' +
      'which slots belong together.</p>',
  },
  motion: {
    title: 'Motion sequencer',
    body:
      '<p>Automates the two knobs assigned to the <strong>XY Pad</strong> while the transport ' +
      'plays. Each of the 16 mini pads is an optional <em>anchor</em>: drag inside one to set an ' +
      'X/Y position for that step, double-click to clear it. <strong>SLIDE</strong> ramps ' +
      'smoothly between anchors; <strong>STEP</strong> jumps at each anchor and holds. Each ' +
      'lane has its own SLIDE/STEP switch, so the XY sweep and the two extra tracks can ' +
      'differ.</p>' +
      '<p>Under the XY lane sit <strong>two more tracks</strong>, each driving a single ' +
      'parameter you choose yourself — and you choose it <em>per bank</em>, so bank A can ride the ' +
      'delay mix while bank B moves the drive. Drag a cell to set its level, double-click to clear ' +
      'it. Between the XY pair and these two, one bank can move up to <strong>four</strong> ' +
      'parameters at once — or move just these two and leave the XY Pad free for you to play ' +
      'live (using the XY lane is what costs you the pad).</p>' +
      '<p>There is no on/off tap here — a cell either holds a value or it does not — so ' +
      CLEAR_BTN + ' lists whichever lanes currently hold steps (XY, A, B) rather than ' +
      'a selected row. <strong>Ctrl+Z</strong> undoes the last edit, a bulk clear included.</p>' +
      '<p><strong>Reading the graph:</strong> every dot stores <em>two</em> values (X and Y), but ' +
      'the overlay line can only trace one at a time. The <strong>Y / X</strong> toggle picks ' +
      'which one it shows — <strong>Y</strong> (the default) draws each anchor’s vertical ' +
      'position, <strong>X</strong> its horizontal position. The dots themselves never move; only ' +
      'the line is re-projected. The row above the pads shows which parameter each axis ' +
      'drives.</p>' +
      '<p>In Song mode the Motion card chains banks like the other machines, and its ' +
      '<strong>Mute</strong> pauses automation — every driven knob returns to its resting value.</p>',
  },
  'motion.xy': {
    title: 'XY Pad lane',
    body:
      '<p>These 16 mini pads automate the <strong>two knobs the XY Pad is wired to</strong>. ' +
      'Drag inside a pad to drop an X/Y <em>anchor</em> for that step; double-click to clear it.</p>' +
      '<p>The value shows in the readout at the end of this row, and in a bubble above the pad ' +
      'while you drag. Drags land on <strong>steps of 0.05</strong>, so two lanes can be given ' +
      'exactly the same value; hold <strong>Shift</strong> for fine control in between. ' +
      '<strong>Hold a pad still</strong> to read what is in it without changing it.</p>' +
      '<p><strong>SLIDE</strong> ramps smoothly between anchors, <strong>STEP</strong> jumps at ' +
      'each and holds. The <strong>Y / X</strong> toggle only picks which axis the overlay line ' +
      'traces — the dots never move.</p>',
  },
  'motion.tracks': {
    title: 'Motion tracks A & B',
    body:
      '<p>Two extra lanes that each automate <strong>one parameter you choose</strong> — and you ' +
      'choose it <em>per bank</em> — so you can move two params here and keep the XY Pad ' +
      '<strong>free to play live</strong>, or add the XY lane on top for up to four in all.</p>' +
      '<p>Drag a cell up or down to set its level, double-click to clear it. Each lane has its own ' +
      '<strong>SLIDE / STEP</strong>, so it can move differently from the XY sweep and from the ' +
      'other track.</p>' +
      '<p>Giving A and B the <em>same</em> value is the common case, so drags land on ' +
      '<strong>steps of 0.05</strong> and each lane shows its value in the readout at the end of ' +
      'its row (plus a bubble above the cell while you drag). <strong>Hold a cell still</strong> ' +
      'to read it without changing it — that is how you check A before setting B. Hold ' +
      '<strong>Shift</strong> while dragging for fine, unsnapped control.</p>',
  },
  // One body, four ids — see RULER_HELP.
  'transport.ruler.seq': RULER_HELP,
  'transport.ruler.drum': RULER_HELP,
  'transport.ruler.sampler': RULER_HELP,
  'transport.ruler.motion': RULER_HELP,
  'transport.song': {
    title: 'Transport & song position',
    body:
      '<p>Where you are in the <strong>whole song</strong>, not just the bar. The readout is ' +
      '<strong>bar.step</strong>, and the numbered cells beside it are one per bar of your ' +
      'arrangement — click one to jump straight to that bar instead of playing from the top and ' +
      'waiting. ' + g('toStart', 'Back to the start') + ' goes back to the start.</p>' +
      '<p>Each cell lines up with a slot in the chains above, so cell&nbsp;3 and the third chip ' +
      'in a lane are the same bar.</p>' +
      '<p><strong>TRANSPORT</strong> opens all of this in a floating window — with Play/Stop ' +
      'as well — that keeps working on every other tab, so you can start, stop and relocate ' +
      'while designing a sound.</p>' +
      '<p>Moving the playhead is unavailable while an external clock is driving the transport, ' +
      'or while a song export or bank render is recording.</p>',
  },
  song: {
    title: 'Song mode',
    body:
      '<p>Arrange your patterns into a full track. Chain banks for the sequencer, drums, ' +
      'sampler and motion sequencer, add live DJ-style FX (<strong>Fill, Stutter, Drop, ' +
      'Tape&nbsp;Stop</strong> and a sweepable DJ filter), and save / load / export songs.</p>' +
      '<p>The demo buttons load complete examples — remember to press <strong>Play</strong> ' +
      'afterwards to hear them.</p>' +
      '<p>A bank button <em>appends</em> to the chain, so to put a bar somewhere else just ' +
      '<strong>drag the chip</strong> to where it belongs — a line shows the gap it will drop ' +
      'into. ' + g('triangleLeft', 'Move left') + ' and ' + g('triangleRight', 'Move right') +
      ' do the same one place at a time. On the ' +
      'sequencer lane a chip can also be <strong>transposed</strong>: select it and use ' +
      '<strong>−</strong> / <strong>+</strong> (or the mouse wheel over the chip), and it reads ' +
      '<strong>A+5</strong> in its own colour — one bank becomes a whole progression.</p>' +
      '<p>Not sure what a button does? <strong>Save</strong>, <strong>Export</strong> and the ' +
      'audio <strong>Export Song</strong> are easy to mix up — each file button has its own (i) ' +
      'badge with the details.</p>',
  },
  // Deliberately the sibling of `transport.song` above: same shape — what the
  // row is, then each control, then what the floating window adds, then where
  // it is reduced. The two rows sit next to each other, so their badges should
  mod: {
    title: 'Mod Matrix',
    body:
      '<p>Where movement comes from. Each row sends one <strong>source</strong> — an LFO, an ' +
      'envelope, the mod wheel, velocity, the note you played, or a random value — into one ' +
      '<strong>destination</strong>, by as much as you set. Eight rows, so several things can ' +
      'move at once, and two rows may share a destination: they simply add.</p>' +
      '<p>The first two rows are <strong>LFO 1</strong> and <strong>LFO 2</strong>. They are ' +
      'the same controls that live on the LFO panel, shown here beside the rest.</p>' +
      '<p><strong>Amount is bipolar.</strong> Past zero the route inverts — the source pushes ' +
      'its destination <em>down</em> instead of up. On the synth panels a modulated knob draws ' +
      'an inner arc over the range it can now reach: <strong>green</strong> for up, ' +
      '<strong>yellow</strong> for down. A mod-wheel route also shows a moving tick, so you ' +
      'can see where the wheel currently has it.</p>' +
      '<p>The destination list is short on purpose: these are the things the synth can move ' +
      '<em>as it plays a note</em>, at full audio rate, for free. To move anything else — an ' +
      'effect mix, a level, the tempo — use a <strong>Motion</strong> lane or the ' +
      '<strong>XY Pad</strong> instead.</p>',
  },
  // read as a pair (live-fx-window.md REQ-7).
  'song.fx': {
    title: 'Live FX',
    body:
      '<p>Hands on the <strong>whole song</strong> while it plays — the DJ moves you make on ' +
      'top of an arrangement rather than editing into it. Nothing here is recorded: the four ' +
      'buttons are <strong>momentary</strong>, so an effect lasts exactly as long as you hold ' +
      'it and the song is untouched when you let go.</p>' +
      '<p><strong>DJ&nbsp;FLT</strong> sweeps one filter across everything — left of centre ' +
      'takes the top off, right takes the bottom out, centre is off. <strong>Fill</strong> ' +
      'rolls the drums. <strong>Stutter</strong> loops the slice you are on, and the ' +
      '<strong>1 / 1/8 / 1/4</strong> buttons set how long that slice is. ' +
      '<strong>Drop</strong> dives the filter for a build. <strong>Tape&nbsp;Stop</strong> ' +
      'drags the tempo and the pitch down together, then winds back up on release. ' +
      '<strong>XY&nbsp;Pad</strong> opens the two-axis controller for whichever pair of ' +
      'parameters it is assigned.</p>' +
      '<p><strong>LIVE FX</strong> opens all of this in a floating window that keeps working ' +
      'on every other tab, so you can perform while a different tab is in front of you.</p>' +
      '<p>They need the transport running to do much — Fill and Stutter act on the steps as ' +
      'they play. While an external clock is driving the transport, Tape&nbsp;Stop bends the ' +
      'pitch only and leaves the tempo to the clock.</p>',
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
      '<p>Clears every bank and chain — sequencer, drums, sampler and motion — back to empty so ' +
      'you can start a fresh song. It asks for confirmation first, as it cannot be undone.</p>' +
      '<p><strong>Save</strong> or <strong>Export</strong> anything you want to keep before ' +
      'pressing it.</p>',
  },
  'song.exportAudio': {
    title: 'Export Song (audio)',
    body:
      '<p>Renders the arrangement to an <strong>audio file</strong> you can play anywhere. It opens ' +
      'a small dialog first, because there are three things worth choosing:</p>' +
      '<p><strong>Format</strong> — WAV (lossless) or MP3. <strong>Runs</strong> — how many times ' +
      'the song plays through, up to 10, for when one pass is too short to be a track. ' +
      '<strong>An empty bar at the end</strong> — leave this on and the recording keeps rolling for ' +
      'one silent bar after the last step, so a long reverb or delay <em>decays</em> instead of ' +
      'being chopped off mid-tail.</p>' +
      '<p>It renders in <em>real time</em> — the dialog shows how long that will take before you ' +
      'commit. This is the actual <em>sound</em>; to save the editable project instead, use ' +
      '<strong>Export</strong> (a <strong>.json</strong> file) up above.</p>',
  },
  'song.record': {
    title: 'Record',
    body:
      '<p>Opens the <strong>RECORD</strong> window, which captures everything that plays — live ' +
      'notes, patterns, knob tweaks. It floats above the app, so once it is open you can record ' +
      'while working on <em>any</em> tab. <strong>Shift + R</strong> opens and closes it from ' +
      'anywhere.</p>' +
      '<p><strong>Record</strong> starts the take (and the transport, if it is stopped) and a timer ' +
      'shows how much you have. <strong>Pause</strong> pauses the <em>recorder</em> — the music ' +
      'keeps playing, and the paused stretch is simply left out of the file, so you can drop out ' +
      'and punch back in.</p>' +
      '<p><strong>Stop</strong> ends the take but writes nothing yet: you then choose ' +
      '<strong>Save</strong> or <strong>Discard</strong>, so a fluffed take never lands in your ' +
      'downloads. Closing the window with a take still unsaved asks first.</p>' +
      '<p>Use it to grab a jam; use <strong>Export Song</strong> for a clean, automatic render of ' +
      'the whole arrangement.</p>',
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
      '<strong>' + iconLabel('check', 'Linked', 'after') + '</strong> you’re synced — ' +
      'set one to Master and the other to Slave.</li>' +
      '</ol>' +
      '<p>Cross-device WiFi needs the secure (HTTPS) site; two tabs on one computer work on ' +
      '<em>localhost</em>.</p>',
  },
  keyboard: {
    title: 'Keyboard',
    body:
      '<p>Click the on-screen keys to play, or use your computer keyboard: the bottom letter ' +
      'row is the lower octave, the top one the upper, with the sharps on the row above each — ' +
      'a piano laid over the keys. <strong>Help &amp; About</strong> draws the exact mapping for ' +
      'your keyboard layout. The ' + g('arrowLeft', 'Left arrow') + ' / ' +
      g('arrowRight', 'Right arrow') + ' arrow keys shift octave.</p>' +
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
      '(pitch), <strong>tremolo</strong> (amp), <strong>PWM movement</strong> (pulse) or ' +
      '<strong>auto-pan</strong> (pan).</p>' +
      '<p>If the LFO destination is off, the wheel does nothing — pick a destination first.</p>',
  },
  scope: {
    title: 'Wave / Spectrum view',
    body:
      '<p>A live visualiser of the sound. <strong>Wave</strong> shows the waveform like an ' +
      'oscilloscope (you can see the shape of the tone); <strong>Spectrum</strong> shows the ' +
      'frequency content (bass on the left, treble on the right). Click the button to switch.</p>' +
      '<p><strong>Wave</strong> auto-ranges like a scope’s volts/div knob, so a quiet song ' +
      'still draws a readable waveform instead of a flat line — a loud one still draws ' +
      'taller, but the height is not a level meter. For actual level, read the ' +
      '<strong>Spectrum</strong> max-dB line below.</p>' +
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

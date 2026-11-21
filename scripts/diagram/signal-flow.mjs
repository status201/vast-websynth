// Generate the illustrated signal-flow poster of VAST G1-J8.
//
//   node scripts/diagram/signal-flow.mjs        (or: npm run docs:diagram)
//
// Outputs (docs/):
//   signal-flow-light.svg   printed-manual look: paper, ink, colour only on wires
//   signal-flow-dark.svg    the app's own Dark palette (src/styles/theme.css)
//   signal-flow-zones.json  the clickable areas of the in-app map
//                           (specs/features/signal-flow-map.md)
//
// One layout, two palettes: every block, wire and label below is written once,
// and the two files differ only in the colours the renderer is handed. The SVG
// is self-contained — no fonts, images or links — so it renders the same in an
// <img>, on GitHub and offline. The app inlines it under a CSP with no inline
// styles, so every style is a presentation attribute (TEXT_STYLES) and every id
// starts sf-; assertCspSafe() refuses to write a file that breaks either.
//
// This is an *illustration*. The source of truth for the audio graph is
// specs/architecture.md ("Audio graph"); the facts drawn here were read from
// src/audio/engine.ts, src/audio/voice.ts, src/audio/effects/fx-chain.ts and
// src/state/params.ts. When the engine changes, update the layout and rerun.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VERSION = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;

// ─────────────────────────────────────────────────────────────── palettes ──

const PALETTES = {
  light: {
    bg: '#f4f0e6', region: '#fbf9f3', regionEdge: '#d9d0bd', band: '#f6f2e8',
    panel: '#ffffff', edge: '#3b342b', text: '#1d1a15', dim: '#4f473d', faint: '#8b8274',
    heading: '#1d1a15', headOp: 0.16, guide: '#d9d0bd',
    cat: {
      input: '#2f6db3', time: '#2e7d32', machine: '#a8740a', voice: '#cf4f0f',
      mod: '#d97706', fx: '#6a3fb5', master: '#b3261e', drum: '#8a5a12', sampler: '#0f766e',
    },
    wire: {
      audio: '#1565c0', stereo: '#1565c0', note: '#a87700', vel: '#8d6e3f', cv: '#e0570f',
      clock: '#2e7d32', trig: '#d32f2f', auto: '#7b3fbf', buf: '#7a7166',
    },
  },
  dark: {
    bg: '#0e0a06', region: '#15100b', regionEdge: '#3d2e1b', band: '#191310',
    panel: '#1f1a15', edge: '#5d4628', text: '#e8d8b6', dim: '#b9a58f', faint: '#8f7a63',
    heading: '#f4cd5e', headOp: 0.22, guide: '#3d2e1b',
    cat: {
      input: '#6ea8dc', time: '#6fb86a', machine: '#f4cd5e', voice: '#e8742e',
      mod: '#ffb051', fx: '#c58cff', master: '#ff6a52', drum: '#e0a458', sampler: '#4fc1b0',
    },
    wire: {
      audio: '#5ab0ff', stereo: '#5ab0ff', note: '#f4cd5e', vel: '#d6c09a', cv: '#ff8a3d',
      clock: '#6fcf7f', trig: '#ff5a4a', auto: '#c58cff', buf: '#a89372',
    },
  },
};

// Wire types: what travels on the wire. Width / dash are the same in both palettes.
const WT = {
  audio: { w: 4, dash: '', name: 'AUDIO (mono)' },
  stereo: { w: 9, dash: '', name: 'AUDIO (stereo)' },
  note: { w: 2.6, dash: '12 6', name: 'NOTE · GATE · TRIGGER' },
  vel: { w: 1.8, dash: '', name: 'VELOCITY' },
  cv: { w: 2.6, dash: '', name: 'MODULATION (CV)' },
  clock: { w: 2.8, dash: '1 7', name: 'CLOCK · SYNC' },
  trig: { w: 2.6, dash: '6 5', name: 'DRUM HIT → DUCK' },
  auto: { w: 2.4, dash: '12 5 2 5', name: 'PARAMETER AUTOMATION' },
  buf: { w: 5, dash: '', name: 'SAMPLE DATA (offline)' },
};

// Text and block styles, as presentation attributes rather than a <style> sheet:
// the app inlines this SVG under a CSP with no `style-src 'unsafe-inline'`
// (specs/features/signal-flow-map.md), which drops a <style> element and every
// style="" attribute. w weight · s size · f fill (a palette role) · ls letter
// spacing · it italic · mono monospace · stroke/sw a palette role and width.
const TEXT_STYLES = {
  blk: { f: 'panel', stroke: 'edge', sw: 1.6 },
  bt: { w: 700, s: 17, f: 'text', ls: 0.8 },
  btag: { w: 600, s: 11.5, mono: 1, ls: 0.4 },
  bl: { s: 13.4, f: 'dim' },
  blb: { w: 700, s: 13.4, f: 'text' },
  blf: { it: 1, s: 12.8, f: 'faint' },
  mk: { w: 700, s: 12.5, f: 'dim', ls: 0.5 },
  pl: { w: 700, s: 12.5, ls: 0.3 },
  'pl-l': { w: 800, s: 11.5, f: 'panel' },
  wl: { w: 700, s: 12, ls: 0.4 },
  nt: { it: 1, s: 13, f: 'faint' },
  sn: { w: 700, s: 12.5, f: 'text', ls: 0.6 },
  sn2: { s: 11.5, f: 'faint', ls: 0.4 },
  sig: { w: 700 },
  vca: { w: 800, s: 18, ls: 1 },
  vbadge: { w: 800, s: 15, f: 'panel', ls: 2 },
  bdg: { w: 800, s: 10.5, f: 'panel', ls: 0.6 },
  rn: { w: 800, s: 19, f: 'bg' },
  rt: { w: 800, s: 26, f: 'heading', ls: 2 },
  rs: { it: 1, s: 16, f: 'faint' },
  bandt: { w: 800, s: 18, ls: 6 },
  frt: { w: 800, s: 15, ls: 1.5 },
  colh: { w: 800, s: 15, f: 'faint', ls: 2 },
  ct: { w: 800, s: 17, ls: 1.5 },
  cl: { s: 15, f: 'dim' },
  cb: { w: 700, s: 15, f: 'text' },
  lr: { w: 800, s: 46, f: 'text' },
  out: { w: 800, s: 30, f: 'heading', ls: 3 },
  h1: { w: 900, s: 78, f: 'heading', ls: 3 },
  h2: { w: 300, s: 64, f: 'text', ls: 14 },
  h3: { s: 21, f: 'dim' },
  h4: { it: 1, s: 17, f: 'faint' },
  ver: { w: 700, s: 22, mono: 1, f: 'faint' },
  kt: { w: 600, s: 14, f: 'dim', ls: 0.4 },
  lgh: { w: 800, s: 15, f: 'faint', ls: 2 },
  ft: { it: 1, s: 14, f: 'faint' },
};

// ───────────────────────────────────────────────────────────────── zones ──
// The clickable areas of the in-app map (specs/features/signal-flow-map.md),
// written to docs/signal-flow-zones.json. The copy lives here; each zone's box
// is taken from the same layout values that draw it (see render()), so moving a
// block moves its zone. The posters draw nothing for a zone.

const ZONE_INTRO = 'Every path from a key press to the speakers, read left to right. '
  + 'Pick an area to zoom in, or follow the signal with Next.';

const ZONE_TEXT = {
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
const TOUR_ORDER = [
  'play-keys', 'play-ctl', 'notes-keys', 'notes-clock', 'seqs', 'voice', 'mod', 'fx-synth', 'fx-inserts',
  'drum-machine', 'drum-channel', 'fx-drum', 'play-in', 'notes-studio', 'sampler-machine', 'sampler-channel',
  'fx-sampler', 'master-chain', 'master-stereo', 'master-offpath', 'legend-wires', 'legend-symbols', 'legend-sections',
];

const W = 7300;
const H = 3760;
const HEAD = 34;   // block title band
const LINE = 18;   // body line pitch
const SANS = `'Segoe UI', 'Helvetica Neue', Arial, system-ui, sans-serif`;
const MONO = `ui-monospace, 'Cascadia Mono', Consolas, 'DejaVu Sans Mono', monospace`;

// ──────────────────────────────────────────────────────────────── helpers ──

const n = (v) => +v.toFixed(1);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const textW = (s, size) => s.length * size * 0.6;

function fpath(f, steps = 64) {
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const [x, y] = f(i / steps);
    d += `${i ? 'L' : 'M'}${n(x)} ${n(y)}`;
  }
  return d;
}

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// Rounded orthogonal path through points.
function rpath(pts, r = 14) {
  let d = `M${n(pts[0][0])} ${n(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const l1 = Math.hypot(x1 - x0, y1 - y0);
    const l2 = Math.hypot(x2 - x1, y2 - y1);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const ax = x1 + ((x0 - x1) / l1) * rr;
    const ay = y1 + ((y0 - y1) / l1) * rr;
    const bx = x1 + ((x2 - x1) / l2) * rr;
    const by = y1 + ((y2 - y1) / l2) * rr;
    d += ` L${n(ax)} ${n(ay)} Q${n(x1)} ${n(y1)} ${n(bx)} ${n(by)}`;
  }
  const [xe, ye] = pts[pts.length - 1];
  return `${d} L${n(xe)} ${n(ye)}`;
}

function clean(pts) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

// Move the first point d0 toward the second and the last d1 toward the one before.
function shorten(pts, d0, d1) {
  const p = pts.map((q) => [...q]);
  const mv = (a, b, d) => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 1e-6) return;
    const k = Math.min(d, l - 1) / l;
    a[0] += (b[0] - a[0]) * k;
    a[1] += (b[1] - a[1]) * k;
  };
  if (d0) mv(p[0], p[1], d0);
  if (d1) mv(p[p.length - 1], p[p.length - 2], d1);
  return p;
}

// ────────────────────────────────────────────────────────────────── icons ──

const stroke = (w) => `fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;
const ST = stroke(2.6);
const STT = stroke(1.6);
const FILL = 'fill="currentColor" fill-opacity="0.22" stroke="currentColor" stroke-width="2" stroke-linejoin="round"';

function icons() {
  const s = {};
  const sine = (x0, w, y0, a, cyc = 1, ph = 0) => fpath((t) => [x0 + w * t, y0 - a * Math.sin(2 * Math.PI * (cyc * t + ph))]);
  s.sine = ['0 0 80 48', `<path ${ST} d="${sine(4, 72, 24, 18)}"/>`];
  s.tri = ['0 0 80 48', `<path ${ST} d="M4 24 L22 6 L58 42 L76 24"/>`];
  s.saw = ['0 0 80 48', `<path ${ST} d="M4 40 L40 8 V40 L76 8 V40"/>`];
  s.square = ['0 0 80 48', `<path ${ST} d="M4 40 V8 H30 V40 H52 V8 H62 V40 H76"/>`];
  s.waves4 = ['0 0 212 44', [
    `<path ${ST} d="${sine(4, 42, 22, 16)}"/>`,
    `<path ${ST} d="M58 22 L68 6 L88 38 L98 22"/>`,
    `<path ${ST} d="M112 38 L132 6 V38 L152 6 V38"/>`,
    `<path ${ST} d="M166 38 V6 H180 V38 H194 V6 H200 V38 H208"/>`,
  ].join('')];
  seed = 11;
  s.noise = ['0 0 80 48', `<path ${stroke(1.8)} d="${fpath((t) => [4 + 72 * t, 24 + (rnd() - 0.5) * 38], 46)}"/>`];
  s.adsr = ['0 0 80 48', `<path ${STT} stroke-dasharray="3 4" d="M4 44 H76"/><path ${ST} d="M4 44 L18 5 L32 22 H58 L76 44"/>`
    + `<g fill="currentColor" font-family="${SANS}" font-size="8" font-weight="700" text-anchor="middle"><text x="10" y="40">A</text><text x="28" y="40">D</text><text x="45" y="40">S</text><text x="68" y="40">R</text></g>`];
  s.filter = ['0 0 80 48', `<path ${STT} d="M4 45 H76 M4 4 V45"/><path ${ST} d="M6 18 H36 C44 18 46 4 50 8 C55 13 60 36 76 42"/>`];
  s.eq = ['0 0 80 48', `<path ${STT} stroke-dasharray="3 4" d="M4 26 H76"/><path ${ST} d="M4 30 C10 30 12 14 20 14 S30 36 38 36 S48 18 56 18 S68 30 76 28"/>`
    + `<g fill="currentColor"><circle cx="20" cy="14" r="3"/><circle cx="38" cy="36" r="3"/><circle cx="56" cy="18" r="3"/></g>`];
  s.dirt = ['0 0 80 48', `<path ${STT} stroke-dasharray="3 4" d="M4 13 H76 M4 35 H76"/><path ${ST} d="${fpath((t) => [4 + 72 * t, 24 - 11 * Math.max(-1, Math.min(1, 1.9 * Math.sin(2 * Math.PI * 1.5 * t)))])}"/>`];
  s.wah = ['0 0 80 48', `<path ${ST} d="M4 42 C26 42 30 10 40 10 C50 10 54 42 76 42"/><path ${STT} d="M22 4 H58 M22 4 l6 -3 M22 4 l6 3 M58 4 l-6 -3 M58 4 l-6 3"/>`];
  s.phaser = ['0 0 80 48', `<path ${ST} d="${fpath((t) => [4 + 72 * t, 10 + 32 * Math.pow(Math.abs(Math.cos(Math.PI * 2 * t + Math.PI / 2)), 6)], 90)}"/>`];
  s.flanger = ['0 0 80 48', `<path ${ST} d="${fpath((t) => [4 + 72 * t, 42 - 32 * Math.abs(Math.cos(Math.PI * 5 * t))], 120)}"/>`];
  s.chorus = ['0 0 80 48', `<path ${ST} d="${sine(4, 72, 24, 15, 1.5)}"/><path ${ST} stroke-opacity="0.5" d="${sine(4, 72, 24, 15, 1.5, 0.12)}"/>`];
  s.delay = ['0 0 80 48', `<path ${STT} d="M4 44 H76"/><path ${stroke(5)} d="M10 44 V6 M26 44 V16 M42 44 V24 M58 44 V31 M72 44 V36"/>`];
  seed = 5;
  s.reverb = ['0 0 80 48', `<path ${STT} d="M4 44 H76"/><path ${stroke(1.4)} d="${Array.from({ length: 24 }, (_, i) => {
    const x = 8 + i * 2.8;
    const h = 38 * Math.exp(-i / 9) * (0.55 + 0.45 * rnd());
    return `M${n(x)} 44 V${n(44 - h)}`;
  }).join(' ')}"/><path ${ST} d="M8 6 C24 16 44 36 76 42"/>`];
  s.duck = ['0 0 80 48', `<path ${ST} d="M4 8 H12 L16 32 C22 32 26 8 36 8 H38 L42 32 C48 32 52 8 62 8 H76"/><g fill="currentColor"><path d="M12 46 l4 -7 l4 7 z"/><path d="M38 46 l4 -7 l4 7 z"/></g>`];
  s.pan = ['0 0 80 48', `<circle cx="40" cy="24" r="11" ${ST}/><path ${ST} d="M40 24 L46 15"/><path ${STT} d="M4 24 H24 M56 24 H76 M4 24 l6 -4 M4 24 l6 4 M76 24 l-6 -4 M76 24 l-6 4"/>`
    + `<g fill="currentColor" font-family="${SANS}" font-size="10" font-weight="700" text-anchor="middle"><text x="12" y="42">L</text><text x="68" y="42">R</text></g>`];
  s.comp = ['0 0 80 48', `<path ${ST} d="M10 42 A30 30 0 0 1 70 42"/><path ${STT} d="M16 30 l4 3 M26 20 l3 4 M40 15 v5 M54 20 l-3 4 M64 30 l-4 3"/><path ${stroke(3)} d="M40 42 L28 20"/><circle cx="40" cy="42" r="3" fill="currentColor"/>`
    + `<text x="58" y="40" fill="currentColor" font-family="${SANS}" font-size="9" font-weight="700">GR</text>`];
  s.dj = ['0 0 80 48', `<path ${STT} d="M4 45 H76"/><path ${ST} d="M4 12 H38 C48 12 50 34 56 44"/><path ${ST} stroke-opacity="0.55" d="M24 44 C30 34 32 12 42 12 H76"/>`];
  s.scope = ['0 0 80 48', `<rect x="3" y="3" width="74" height="42" rx="5" ${STT}/><path ${STT} stroke-opacity="0.4" d="M3 24 H77 M40 3 V45"/><path ${ST} d="${sine(8, 64, 24, 13, 2)}"/>`];
  s.speaker = ['0 0 64 64', `<path ${FILL} d="M8 22 H20 L36 8 V56 L20 42 H8 Z"/><path ${ST} d="M44 24 A12 12 0 0 1 44 40 M50 16 A22 22 0 0 1 50 48 M56 9 A32 32 0 0 1 56 55"/>`];
  s.piano = ['0 0 214 60', (() => {
    let g = '';
    for (let i = 0; i < 14; i++) g += `<rect x="${2 + i * 15}" y="2" width="15" height="56" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/>`;
    for (let o = 0; o < 2; o++) for (const k of [0, 1, 3, 4, 5]) g += `<rect x="${2 + o * 105 + k * 15 + 10}" y="2" width="10" height="34" rx="1.5" fill="currentColor"/>`;
    return g;
  })()];
  s.qwerty = ['0 0 214 60', (() => {
    let g = '';
    const lit = new Set(['0-1', '0-2', '0-4', '0-5', '0-6', '1-0', '1-1', '1-2', '1-3', '1-4', '1-5', '1-6']);
    for (let r = 0; r < 2; r++) for (let i = 0; i < 11; i++) {
      const x = 4 + r * 9 + i * 18.5;
      const y = 4 + r * 28;
      g += `<rect x="${n(x)}" y="${y}" width="15" height="22" rx="3" ${lit.has(`${r}-${i}`) ? FILL : STT}/>`;
    }
    return g;
  })()];
  s.din = ['0 0 64 56', `<circle cx="32" cy="28" r="24" ${ST}/><rect x="28" y="46" width="8" height="6" fill="currentColor"/>`
    + `<g fill="currentColor">${[180, 135, 90, 45, 0].map((a) => {
      const r = 15;
      const x = 32 + r * Math.cos((a * Math.PI) / 180);
      const y = 28 - r * Math.sin((a * Math.PI) / 180);
      return `<circle cx="${n(x)}" cy="${n(y)}" r="3"/>`;
    }).join('')}</g>`];
  s.wheels = ['0 0 80 56', `<rect x="18" y="4" width="16" height="48" rx="5" ${ST}/><rect x="46" y="4" width="16" height="48" rx="5" ${ST}/>`
    + `<path ${STT} d="M20 14 H32 M20 22 H32 M20 30 H32 M20 38 H32 M48 18 H60 M48 26 H60 M48 34 H60 M48 42 H60"/>`];
  s.xy = ['0 0 80 56', `<rect x="14" y="3" width="52" height="50" rx="4" ${ST}/><path ${STT} stroke-dasharray="2 4" d="M40 3 V53 M14 28 H66"/>`
    + `<path ${STT} d="M24 44 C30 30 40 34 52 16"/><circle cx="52" cy="16" r="5" fill="currentColor"/>`];
  s.livefx = ['0 0 80 56', `<rect x="8" y="4" width="28" height="22" rx="4" ${FILL}/><rect x="44" y="4" width="28" height="22" rx="4" ${STT}/><rect x="8" y="30" width="28" height="22" rx="4" ${STT}/><rect x="44" y="30" width="28" height="22" rx="4" ${STT}/>`
    + `<path fill="currentColor" d="M24 7 L15 17 H21 L18 24 L28 13 H22 Z"/>`];
  s.wifi = ['0 0 80 56', `<path ${ST} d="M14 22 A36 36 0 0 1 66 22 M22 31 A25 25 0 0 1 58 31 M30 40 A13 13 0 0 1 50 40"/><circle cx="40" cy="48" r="4" fill="currentColor"/>`];
  s.mic = ['0 0 80 56', `<rect x="30" y="2" width="20" height="32" rx="10" ${FILL}/><path ${ST} d="M22 24 A18 18 0 0 0 58 24 M40 42 V52 M30 53 H50"/>`];
  s.file = ['0 0 80 56', `<path ${ST} d="M22 2 H48 L60 14 V54 H22 Z M48 2 V14 H60"/><path ${STT} d="M28 34 V38 M33 28 V44 M38 31 V41 M43 24 V48 M48 30 V42 M53 33 V39"/>`];
  s.clock = ['0 0 80 56', `<circle cx="40" cy="28" r="24" ${ST}/><path ${ST} d="M40 28 V12 M40 28 L52 34"/>`
    + `<path ${STT} d="M40 6 v4 M62 28 h-4 M40 50 v-4 M18 28 h4"/>`];
  s.sync = ['0 0 80 56', `<path ${ST} d="M20 24 A20 20 0 0 1 58 18 M60 32 A20 20 0 0 1 22 38"/><path fill="currentColor" d="M58 8 L62 22 L49 19 Z M22 48 L18 34 L31 37 Z"/>`];
  s.arrange = ['0 0 80 56', (() => {
    const rows = [[[4, 22], [28, 22], [52, 24]], [[4, 34], [40, 36]], [[4, 14], [20, 14], [36, 14], [52, 24]], [[16, 30], [48, 28]]];
    return rows.map((r, i) => r.map(([x, w]) => `<rect x="${x}" y="${4 + i * 13}" width="${w - 3}" height="10" rx="2" ${i % 2 ? STT : FILL}/>`).join('')).join('');
  })()];
  s.metro = ['0 0 80 56', `<path ${FILL} d="M26 54 L34 4 H46 L54 54 Z"/><path ${ST} d="M40 46 L60 10"/><rect x="47" y="24" width="8" height="6" fill="currentColor" transform="rotate(-60 51 27)"/>`];
  s.chord = ['0 0 80 56', `<path ${STT} stroke-opacity="0.5" d="M6 12 H74 M6 22 H74 M6 32 H74 M6 42 H74"/>`
    + `<g fill="currentColor"><ellipse cx="34" cy="42" rx="7" ry="5"/><ellipse cx="34" cy="32" rx="7" ry="5"/><ellipse cx="34" cy="22" rx="7" ry="5"/></g><path ${ST} d="M41 42 V6"/>`];
  s.arp = ['0 0 80 56', `<path ${STT} stroke-opacity="0.5" d="M4 14 H76 M4 24 H76 M4 34 H76 M4 44 H76"/>`
    + `<g fill="currentColor">${[0, 1, 2, 3].map((i) => `<ellipse cx="${14 + i * 17}" cy="${46 - i * 10}" rx="6" ry="4.5"/>`).join('')}</g>`
    + `<path ${ST} d="${[0, 1, 2, 3].map((i) => `M${20 + i * 17} ${46 - i * 10} V${24 - i * 10 + 6}`).join(' ')}"/>`];
  s.seqgrid = ['0 0 80 56', (() => {
    const on = new Set(['0-0', '0-4', '1-2', '1-6', '2-1', '2-3', '2-5', '2-7', '3-0', '3-3', '3-6']);
    let g = '';
    for (let r = 0; r < 4; r++) for (let c = 0; c < 8; c++) g += `<rect x="${4 + c * 9.2}" y="${4 + r * 12.5}" width="7" height="10" rx="1.5" ${on.has(`${r}-${c}`) ? 'fill="currentColor"' : STT}/>`;
    return g;
  })()];
  s.drum = ['0 0 80 56', `<ellipse cx="40" cy="18" rx="26" ry="8" ${ST}/><path ${ST} d="M14 18 V42 A26 8 0 0 0 66 42 V18"/><path ${STT} d="M14 30 L66 30"/><path ${ST} d="M30 4 L52 16 M60 2 L46 14"/>`];
  s.pads = ['0 0 80 56', (() => {
    let g = '';
    for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) g += `<rect x="${4 + c * 19}" y="${4 + r * 25}" width="15" height="21" rx="3" ${r === 0 && c === 1 ? FILL : STT}/>`;
    return g;
  })()];
  s.motion = ['0 0 80 56', `<path ${ST} d="M4 46 C16 46 18 12 32 14 S48 40 56 36 S68 10 76 10"/><g fill="currentColor"><circle cx="4" cy="46" r="4"/><circle cx="32" cy="14" r="4"/><circle cx="56" cy="36" r="4"/><circle cx="76" cy="10" r="4"/></g>`];
  s.knobs = ['0 0 80 56', [14, 40, 66].map((x, i) => `<circle cx="${x}" cy="28" r="10" ${ST}/><path ${ST} d="M${x} 28 L${n(x + 9 * Math.sin([-2, 0.6, 2][i]))} ${n(28 - 9 * Math.cos([-2, 0.6, 2][i]))}"/>`).join('')];
  s.poly = ['0 0 80 56', [0, 1, 2].map((i) => `<rect x="${6 + i * 9}" y="${4 + i * 8}" width="46" height="30" rx="4" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-width="2"/>`).join('')
    + `<path ${ST} d="${sine(28, 34, 37, 7)}"/>`];
  s.matrix = ['0 0 80 56', `<path ${STT} stroke-opacity="0.6" d="M8 8 H72 M8 20 H72 M8 32 H72 M8 44 H72 M14 4 V50 M30 4 V50 M46 4 V50 M62 4 V50"/>`
    + `<g fill="currentColor"><circle cx="14" cy="20" r="4.5"/><circle cx="30" cy="8" r="4.5"/><circle cx="46" cy="44" r="4.5"/><circle cx="62" cy="32" r="4.5"/></g>`];
  s.random = ['0 0 80 48', `<path ${ST} d="M4 30 H16 V12 H28 V38 H40 V20 H52 V32 H64 V14 H76"/>`];
  s.vel = ['0 0 80 48', `<path ${stroke(5)} d="M10 44 V36 M24 44 V28 M38 44 V20 M52 44 V12 M66 44 V5"/>`];
  s.studio = ['0 0 80 56', `<path ${STT} d="${Array.from({ length: 22 }, (_, i) => {
    const x = 8 + i * 3;
    const a = 4 + 18 * Math.abs(Math.sin(i * 0.9)) * Math.exp(-i / 18);
    return `M${x} ${n(28 - a)} V${n(28 + a)}`;
  }).join(' ')}"/><path ${ST} d="M18 4 H12 V52 H18 M58 4 H64 V52 H58"/>`];
  s.record = ['0 0 80 56', `<circle cx="40" cy="28" r="22" ${ST}/><circle cx="40" cy="28" r="12" fill="currentColor"/>`];
  s.fader = ['0 0 80 56', `<path ${STT} d="M40 4 V52"/><rect x="28" y="18" width="24" height="12" rx="2" ${FILL}/><path ${STT} d="M22 10 H26 M22 24 H26 M22 38 H26 M22 50 H26"/>`];
  // Drum and sampler tiles.
  s.kick = ['0 0 56 48', `<circle cx="28" cy="24" r="20" ${ST}/><circle cx="28" cy="24" r="7" ${FILL}/>`];
  s.snare = ['0 0 56 48', `<ellipse cx="28" cy="15" rx="22" ry="6" ${ST}/><path ${ST} d="M6 15 V33 A22 6 0 0 0 50 33 V15"/><path ${STT} d="M10 24 L46 24 M14 30 L42 30"/>`];
  s.hatc = ['0 0 56 48', `<path ${ST} d="M6 22 Q28 12 50 22 M6 27 Q28 17 50 27"/><path ${STT} d="M28 4 V44"/>`];
  s.hato = ['0 0 56 48', `<path ${ST} d="M6 16 Q28 6 50 16 M6 32 Q28 22 50 32"/><path ${STT} d="M28 4 V44"/>`];
  s.tom = ['0 0 56 48', `<ellipse cx="28" cy="12" rx="18" ry="6" ${ST}/><path ${ST} d="M10 12 V36 A18 6 0 0 0 46 36 V12"/>`];
  s.clap = ['0 0 56 48', `<path ${FILL} d="M18 44 L12 18 Q12 12 18 13 L24 30 Z"/><path ${FILL} d="M38 44 L44 18 Q44 12 38 13 L32 30 Z"/><path ${STT} d="M28 4 V12 M18 6 L22 12 M38 6 L34 12"/>`];
  s.wavesm = ['0 0 56 48', `<path ${STT} d="${Array.from({ length: 16 }, (_, i) => {
    const x = 6 + i * 2.9;
    const a = 3 + 16 * Math.abs(Math.sin(i * 1.3 + 0.4)) * Math.exp(-i / 10);
    return `M${n(x)} ${n(24 - a)} V${n(24 + a)}`;
  }).join(' ')}"/>`];
  // The speaker's outer wave bulges past its viewBox: let it, rather than clip it flat.
  const OVERFLOW = new Set(['speaker']);
  return Object.entries(s)
    .map(([id, [vb, body]]) => `<symbol id="sf-i-${id}" viewBox="${vb}"${OVERFLOW.has(id) ? ' overflow="visible"' : ''}>${body}</symbol>`)
    .join('\n');
}

// ─────────────────────────────────────────────────────────────── renderer ──

function render(P) {
  // Zones of the in-app map: ZONE_TEXT's copy + a box from this layout.
  const Z = [];
  function zone(id, parent, r) {
    const t = ZONE_TEXT[id];
    if (!t) throw new Error(`no ZONE_TEXT for zone "${id}"`);
    if (parent) r = clip(r, Z.find((z) => z.id === parent)); // a child never pokes out of its parent
    Z.push({ id, ...(parent ? { parent } : {}), title: t[0], blurb: t[1], x: n(r.x), y: n(r.y), w: n(r.w), h: n(r.h) });
  }
  function clip(r, p) {
    if (!p) throw new Error('a zone parent must be registered before its children');
    const x0 = Math.max(r.x, p.x);
    const y0 = Math.max(r.y, p.y);
    return { x: x0, y: y0, w: Math.min(r.x + r.w, p.x + p.w) - x0, h: Math.min(r.y + r.h, p.y + p.h) - y0 };
  }
  // The union of some boxes — block ids or {x, y, w, h} — padded.
  function around(items, pad = 12) {
    const bs = items.map((it) => (typeof it === 'string' ? B[it] : it));
    const x0 = Math.min(...bs.map((b) => b.x)) - pad;
    const y0 = Math.min(...bs.map((b) => b.y)) - pad;
    const x1 = Math.max(...bs.map((b) => b.x + b.w)) + pad;
    const y1 = Math.max(...bs.map((b) => b.y + b.h)) + pad;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  const L = { regions: [], blocks: [], wires: [], over: [] };
  const B = {};

  // A TEXT_STYLES entry as presentation attributes in this palette.
  function st(name) {
    const t = TEXT_STYLES[name];
    if (!t) throw new Error(`unknown text style "${name}"`);
    let a = '';
    if (t.mono) a += ` font-family="${MONO}"`;
    if (t.it) a += ' font-style="italic"';
    if (t.w) a += ` font-weight="${t.w}"`;
    if (t.s) a += ` font-size="${t.s}"`;
    if (t.ls) a += ` letter-spacing="${t.ls}"`;
    if (t.f) a += ` fill="${P[t.f]}"`;
    if (t.stroke) a += ` stroke="${P[t.stroke]}" stroke-width="${t.sw}"`;
    return a.slice(1);
  }

  // ── blocks ──
  function mk(id, o) {
    const iconH = o.icon ? (o.iconH ?? 40) : 0;
    const pills = o.pills?.length ?? 0;
    const h = o.h ?? HEAD + (iconH ? iconH + 18 : 10) + (o.lines?.length ?? 0) * LINE + pills * 28 + 12;
    const b = { ...o, h, iconH };
    B[id] = b;
    return b;
  }
  const R = (b, dy) => [b.x + b.w, dy === undefined ? b.y + b.h / 2 : b.y + dy];
  const Lf = (b, dy) => [b.x, dy === undefined ? b.y + b.h / 2 : b.y + dy];
  const T = (b, dx) => [dx === undefined ? b.x + b.w / 2 : b.x + dx, b.y];
  const Bt = (b, dx) => [dx === undefined ? b.x + b.w / 2 : b.x + dx, b.y + b.h];
  // Centre y of body line i (0-based).
  const lineY = (b, i) => b.y + HEAD + (b.iconH ? b.iconH + 18 : 10) + i * LINE + 13 - 5;

  function stack(x, y, w, gap, list) {
    let yy = y;
    for (const [id, o] of list) {
      const b = mk(id, { x, y: yy, w, ...o });
      yy += b.h + gap;
    }
    return yy;
  }

  function useIcon(id, x, y, w, h, color) {
    return `<use href="#sf-i-${id}" xlink:href="#sf-i-${id}" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" color="${color}"/>`;
  }

  function pill(x, y, letter, label, type, anchor = 'start') {
    const c = P.wire[type];
    const fs = 12.5;
    const wTxt = label.length * fs * 0.66;
    const w = (letter ? 26 : 10) + wTxt + 12;
    const x0 = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x;
    let s = `<g><rect x="${n(x0)}" y="${n(y - 11)}" width="${n(w)}" height="22" rx="11" fill="${P.panel}" stroke="${c}" stroke-width="1.8"/>`;
    if (letter) {
      s += `<circle cx="${n(x0 + 12)}" cy="${n(y)}" r="8.5" fill="${c}"/>`;
      s += `<text x="${n(x0 + 12)}" y="${n(y + 4.2)}" ${st('pl-l')} text-anchor="middle">${esc(letter)}</text>`;
    }
    s += `<text x="${n(x0 + (letter ? 26 : 10))}" y="${n(y + 4.4)}" ${st('pl')} fill="${c}">${esc(label)}</text></g>`;
    return { svg: s, x0, x1: x0 + w, w };
  }

  function drawBlock(b) {
    const c = P.cat[b.cat];
    const { x, y, w, h } = b;
    const r = 9;
    let s = `<g>`;
    s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ${st('blk')}/>`;
    s += `<path d="M${x} ${y + HEAD} V${y + r} Q${x} ${y} ${x + r} ${y} H${x + w - r} Q${x + w} ${y} ${x + w} ${y + r} V${y + HEAD} Z" fill="${c}" fill-opacity="${P.headOp}"/>`;
    s += `<path d="M${x + 1} ${y + HEAD} H${x + w - 1}" stroke="${c}" stroke-width="1.6"/>`;
    s += edgeStrip(x, y, 5, HEAD, r, c);
    s += `<text x="${x + 14}" y="${y + 23}" ${st('bt')}>${esc(b.title)}</text>`;
    if (b.tag) s += `<text x="${x + w - 10}" y="${y + 22}" ${st('btag')} text-anchor="end" fill="${c}">${esc(b.tag)}</text>`;
    let cy = y + HEAD + 10;
    if (b.icon) {
      const iw = b.iconW ?? 66;
      const ix = b.iconAlign === 'left' ? x + 14 : x + (w - iw) / 2;
      s += useIcon(b.icon, ix, cy + 2, iw, b.iconH, c);
      cy += b.iconH + 8;
    }
    for (const raw of b.lines ?? []) {
      cy += LINE;
      let cls = 'bl';
      let t = raw;
      if (t.startsWith('**')) { cls = 'blb'; t = t.slice(2); }
      else if (t.startsWith('~')) { cls = 'blf'; t = t.slice(1); }
      s += `<text x="${x + 14}" y="${cy - 4}" ${st(cls)}>${esc(t)}</text>`;
    }
    for (const p of b.pills ?? []) {
      cy += 28;
      s += pill(x + 14, cy - 12, p[0], p[1], p[2]).svg;
    }
    for (const m of b.marks ?? []) {
      s += `<text x="${x + 14}" y="${m.y + 4.5}" ${st('mk')}>${esc(m.t)}</text>`;
    }
    if (b.badge) s += badge(x + w - 8, y + h - 8, b.badge, 'end-bottom');
    s += `</g>`;
    L.blocks.push(s);
  }

  // The section colour strip down a block's left edge, `w` wide, clipped to the
  // block's corner radius `r` (> w) at the top — and at the bottom too when it
  // runs the block's full height. Each corner is the matching piece of the
  // block's own quadratic corner, so the two outlines coincide.
  function edgeStrip(x, y, w, h, r, fill, roundBottom = false) {
    const t = Math.sqrt(w / r); // where the corner's curve reaches x + w
    const c = r * (1 - t); // that piece's control point, below the corner
    const a = r * (1 - t) ** 2; // how far below the corner the curve meets x + w
    let d = `M${x} ${n(y + r)} Q${x} ${n(y + c)} ${x + w} ${n(y + a)}`;
    d += roundBottom ? ` V${n(y + h - a)} Q${x} ${n(y + h - c)} ${x} ${n(y + h - r)}` : ` V${y + h} H${x}`;
    return `<path d="${d} Z" fill="${fill}"/>`;
  }

  function badge(x, y, label, pos = 'middle') {
    const fs = 11;
    const w = textW(label, fs) * 0.95 + 16;
    let x0 = x - w / 2;
    let y0 = y - 9;
    if (pos === 'end-bottom') { x0 = x - w; y0 = y - 18; }
    const c = P.wire.stereo;
    return `<g><rect x="${n(x0)}" y="${n(y0)}" width="${n(w)}" height="18" rx="9" fill="${c}"/>`
      + `<text x="${n(x0 + w / 2)}" y="${n(y0 + 13)}" ${st('bdg')} text-anchor="middle">${esc(label)}</text></g>`;
  }

  // ── wires ──
  function wire(type, pts, o = {}) {
    pts = clean(pts);
    const wt = WT[type];
    const c = P.wire[type];
    const h0 = o.h0 ?? (o.from === 'bus' ? 14 : 4);
    const h1 = o.h1 ?? (o.arrow === false ? 14 : 8);
    let s = `<path d="${rpath(shorten(pts, h0, h1))}" fill="none" stroke="${P.bg}" stroke-width="${wt.w + 8}" stroke-linecap="butt" stroke-linejoin="round"/>`;
    const dash = wt.dash ? ` stroke-dasharray="${wt.dash}"` : '';
    const cap = type === 'clock' ? 'round' : 'butt';
    const mk = o.arrow === false ? '' : ` marker-end="url(#sf-m-${type})"`;
    if (type === 'stereo') {
      s += `<path d="${rpath(pts)}" fill="none" stroke="${c}" stroke-width="${wt.w}" stroke-linejoin="round"${mk}/>`;
      s += `<path d="${rpath(shorten(pts, 0, o.arrow === false ? 0 : 16))}" fill="none" stroke="${P.bg}" stroke-width="3" stroke-linejoin="round"/>`;
    } else {
      const endPts = o.arrow === false ? pts : shorten(pts, 0, 0);
      s += `<path d="${rpath(endPts)}" fill="none" stroke="${c}" stroke-width="${wt.w}" stroke-linecap="${cap}" stroke-linejoin="round"${dash}${mk}/>`;
    }
    if (o.from === 'bus' || o.dot0) s += `<circle cx="${n(pts[0][0])}" cy="${n(pts[0][1])}" r="${type === 'stereo' ? 7 : 5}" fill="${c}"/>`;
    if (o.dot1) s += `<circle cx="${n(pts.at(-1)[0])}" cy="${n(pts.at(-1)[1])}" r="${type === 'stereo' ? 7 : 5}" fill="${c}"/>`;
    L.wires.push(s);
    if (o.label) {
      const [lx, ly] = o.at ?? midOfLongest(pts);
      label(lx, ly, o.label, type, o.anchor ?? 'middle');
    }
  }
  function midOfLongest(pts) {
    let best = 0;
    let at = pts[0];
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (l > best) { best = l; at = [(pts[i][0] + pts[i - 1][0]) / 2, (pts[i][1] + pts[i - 1][1]) / 2]; }
    }
    return at;
  }
  function label(x, y, t, type, anchor = 'middle') {
    const c = P.wire[type];
    const fs = 12;
    const w = textW(t, fs) * 0.9 + 14;
    const x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
    L.over.push(`<g><rect x="${n(x0)}" y="${n(y - 10)}" width="${n(w)}" height="20" rx="4" fill="${P.bg}" fill-opacity="0.92"/>`
      + `<text x="${n(x0 + w / 2)}" y="${n(y + 4.2)}" ${st('wl')} text-anchor="middle" fill="${c}">${esc(t)}</text></g>`);
  }
  function note(x, y, t, cls = 'nt', anchor = 'start') {
    L.over.push(`<text x="${n(x)}" y="${n(y)}" ${st(cls)} text-anchor="${anchor}">${esc(t)}</text>`);
  }
  function sum(x, y, r, sym, c, under = []) {
    let s = `<circle cx="${x}" cy="${y}" r="${r}" fill="${P.panel}" stroke="${c}" stroke-width="2.6"/>`;
    if (sym === 'Σ') s += `<text x="${x}" y="${y + r * 0.36}" text-anchor="middle" ${st('sig')} font-size="${n(r * 1.05)}" fill="${c}">Σ</text>`;
    if (sym === '×') {
      const k = r * 0.48;
      s += `<path d="M${x - k} ${y - k} L${x + k} ${y + k} M${x + k} ${y - k} L${x - k} ${y + k}" stroke="${c}" stroke-width="2.6" stroke-linecap="round"/>`;
    }
    under.forEach((t, i) => { s += `<text x="${x}" y="${y + r + 18 + i * 16}" text-anchor="middle" ${st(i ? 'sn2' : 'sn')}>${esc(t)}</text>`; });
    L.blocks.push(`<g>${s}</g>`);
  }

  // ── regions ──
  function region(x, y, w, h, num, title, sub, zoneId) {
    // The box itself, not its numbered heading above: an outline up there would
    // cross the header, and its label would cover the heading it duplicates.
    if (zoneId) zone(zoneId, null, { x, y, w, h });
    L.regions.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="20" fill="${P.region}" stroke="${P.regionEdge}" stroke-width="2"/>`);
    if (title) {
      L.regions.push(`<g><circle cx="${x + 20}" cy="${y - 26}" r="17" fill="${P.heading}"/><text x="${x + 20}" y="${y - 20}" text-anchor="middle" ${st('rn')}>${num}</text>`
        + `<text x="${x + 46}" y="${y - 17}" ${st('rt')}>${esc(title)}</text>${sub ? `<text x="${x + 66 + title.length * 21}" y="${y - 18}" ${st('rs')}>${esc(sub)}</text>` : ''}</g>`);
    }
  }
  function band(x, y, w, h, title, c, zoneId, parent) {
    if (zoneId) zone(zoneId, parent, { x, y, w, h });
    L.regions.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${P.band}" stroke="${c}" stroke-opacity="0.45" stroke-width="1.6" stroke-dasharray="8 6"/>`);
    L.regions.push(`<text transform="translate(${x + 26} ${y + h / 2}) rotate(-90)" text-anchor="middle" ${st('bandt')} fill="${c}">${esc(title)}</text>`);
  }

  // ════════════════════════════════════════════════════════════ LAYOUT ══

  // Regions
  region(40, 250, 490, 3010, '1', 'PLAY', 'keys · controllers · sound in', 'play');
  region(620, 250, 550, 3010, '2', 'NOTES & TIME', '', 'notes');
  region(1220, 250, 2580, 3010, '3', 'MACHINES & SOUND SOURCES', 'what makes sound, and what plays it', 'machines');
  region(3830, 250, 1870, 3010, '4', 'FX RACK', 'one insert chain per bus · bypassed = disconnected', 'fx');
  region(5740, 250, 1520, 3010, '5', 'MASTER & OUTPUT', '', 'master');
  band(1232, 262, 2556, 1384, 'SYNTH', P.cat.voice, 'synth', 'machines');
  band(1232, 1694, 2556, 758, 'DRUMS', P.cat.drum, 'drums', 'machines');
  band(1232, 2496, 2556, 752, 'SAMPLER', P.cat.sampler, 'sampler', 'machines');

  // ── 1 · PLAY ────────────────────────────────────────────────────────
  const IX = 60;
  const IW = 450;
  stack(IX, 290, IW, 24, [
    ['kbd', { cat: 'input', title: 'ON-SCREEN KEYBOARD', icon: 'piano', iconW: 250, iconH: 62,
      lines: ['C3–B5 · more octaves on wider screens', 'TRANSPOSE ±2 octaves', 'velocity 0.8 · glide across the keys'] }],
    ['qwerty', { cat: 'input', title: 'COMPUTER KEYBOARD', icon: 'qwerty', iconW: 250, iconH: 62,
      lines: ['Z S X D C V G B H N J M ,  →  C4 – C5', 'Q 2 W 3 E R 5 T 6 Y 7 U I  →  C5 – C6', '−  /  =  octave  ·  \'  /  /  pitch bend', 'Space play · F fill · Esc panic'] }],
    ['midi', { cat: 'input', title: 'MIDI IN', icon: 'din', iconW: 60, iconH: 52, tag: 'Web MIDI',
      lines: ['NOTES · velocity · chosen channel (not 10)', 'PITCH BEND · CC1 MOD · aftertouch', 'CC7 VOLUME · CC11 EXPRESSION', 'CC64 SUSTAIN · CC71 RES · CC74 CUTOFF', 'CHANNEL 10 · notes 36–43 → S1–S8', 'CLOCK · START / STOP · SONG POSITION'] }],
    ['wheels', { cat: 'input', title: 'BEND & MOD WHEELS', icon: 'wheels', iconW: 66, iconH: 46,
      lines: ['on-screen strips beside the keys', 'BEND springs back · MOD stays'] }],
    ['xy', { cat: 'input', title: 'XY PAD', icon: 'xy', iconW: 66, iconH: 48,
      lines: ['X → CUTOFF · Y → RESONANCE', 'both axes assignable to any knob', 'springs back on release'] }],
    ['livefx', { cat: 'input', title: 'LIVE FX', icon: 'livefx', iconW: 66, iconH: 46,
      lines: ['STUTTER 1 · 2 · 4 sixteenths', 'FILL (drums) · DROP · DJ FLT ±1', 'TAPE STOP: tempo → 20 BPM + bend'],
      pills: [['B', 'DJ FLT · DROP → DJ FILTER', 'auto']] }],
    ['wifi', { cat: 'input', title: 'WI-FI SYNC', icon: 'wifi', iconW: 66, iconH: 44, tag: 'WebRTC',
      lines: ['peer-to-peer clock over the LAN', 'paired by QR code or copy-paste'] }],
  ]);
  stack(IX, 2600, IW, 24, [
    ['mic', { cat: 'input', title: 'MICROPHONE', icon: 'mic', iconW: 66, iconH: 46,
      lines: ['raw: no echo-cancel, no AGC', 'recorded, never monitored'] }],
    ['file', { cat: 'input', title: 'AUDIO FILE', icon: 'file', iconW: 66, iconH: 46,
      lines: ['WAV · MP3 · project zip'] }],
  ]);

  // ── 2 · NOTES & TIME ────────────────────────────────────────────────
  const NX = 640;
  const NW = 510;
  stack(NX, 290, NW, 22, [
    ['key', { cat: 'time', title: 'KEY · CHORD', icon: 'chord', iconH: 36,
      lines: ['SCALE: 11 types · ROOT · EXTRA note', 'CHORD MEMORY: 8 voicings (poly only)', '~quantizes keys, arpeggiator and sequencer'] }],
    ['arp', { cat: 'time', title: 'ARPEGGIATOR', icon: 'arp', iconH: 36,
      lines: ['UP · DOWN · UP/DOWN · RANDOM · AS PLAYED', 'RATE 1/4 – 1/32 · OCTAVES 1–4 · GATE', 'owns the live keys while it is on', '~a held key starts the transport'] }],
    ['clock', { cat: 'time', title: 'CLOCK', icon: 'clock', iconH: 36, tag: 'transport',
      lines: ['BPM 40–240 · SWING', 'METER 2–12 beats of ¼ or ⅛', '~16th ticks, scheduled 100 ms ahead'],
      pills: [['C', '16ths → S&H RANDOM', 'clock']] }],
    ['sync', { cat: 'time', title: 'SYNC', icon: 'sync', iconH: 36,
      lines: ['OFF · MASTER · SLAVE', 'MIDI clock in / out, 24 PPQN', 'Wi-Fi peer clock'] }],
    ['arrange', { cat: 'time', title: 'ARRANGEMENT', icon: 'arrange', iconH: 36, tag: 'song mode',
      lines: ['4 chain lanes: SEQ · DRUM · SAMPLER · MOTION', 'banks A–P · one slot per bar', 'REST slots · transpose on the SEQ lane'] }],
    ['metro', { cat: 'time', title: 'METRONOME', icon: 'metro', iconH: 36,
      lines: ['clicks while the studio records', 'count-in · bypasses the master'],
      pills: [['D', 'CLICK → DIRECT OUT', 'audio']] }],
    ['params', { cat: 'time', title: 'PARAMETER BUS', icon: 'knobs', iconH: 36,
      lines: ['every knob on the instrument, by id', 'written by XY · MOTION · LIVE FX · MIDI CC', '~a machine moves the knob you would turn'],
      pills: [['', '⟿ moves any knob, anywhere', 'auto']] }],
  ]);
  mk('studio', { x: NX, y: 2600, w: NW, cat: 'sampler', title: 'SAMPLE STUDIO', icon: 'studio', iconH: 46, tag: 'offline edits',
    lines: ['CROP · REVERSE · NORMALIZE · GAIN · FADE', 'FILTER · OCTAVE · PITCH SHIFT', 'TIME-STRETCH to tempo (WSOLA / vocoder)', 'SCRATCH · CHOP across the pads'],
    pills: [['D', 'CLIP PREVIEW → DIRECT OUT', 'audio']] });

  // ── 3 · MACHINES ────────────────────────────────────────────────────
  const MX = 1270;
  const MW = 466;
  mk('seq', { x: MX, y: 530, w: MW, cat: 'machine', title: 'STEP SEQUENCER', icon: 'seqgrid', iconH: 46,
    lines: ['4 TRACKS × 16 steps · banks A–P', 'NOTE · VEL · GATE · PROBABILITY', 'RATCHET · TIE · MICRO · BEND', 'per-track PAN → voice SPREAD', '~tracks 2–4 sound in POLY only'] });
  mk('motion', { x: MX, y: B.seq.y + B.seq.h + 34, w: MW, cat: 'machine', title: 'MOTION SEQUENCER', icon: 'motion', iconH: 44,
    lines: ['XY lane + 4 parameter tracks A–D', 'SLIDE between points, or STEP', 'automates any knob, per bank'] });
  mk('poly', { x: 1800, y: 300, w: 310, h: 360, cat: 'voice', title: 'POLYPHONY', icon: 'poly', iconH: 46, tag: 'voice allocator',
    lines: ['8 VOICES · POLY or MONO', '~5 voices on the Weak performance tier', 'UNISON 1–4 · DETUNE 0–50¢', 'GLIDE off · always · legato', 'steals idle → releasing → oldest', 'ENV TRIGGER multi or single'],
    pills: [['G', 'GATE · VELOCITY → ENVs', 'note']] });

  // ── 3 · SYNTH VOICE (×8) ────────────────────────────────────────────
  const VF = { x: 2150, y: 262, w: 1540, h: 1370 };
  L.regions.push(`<rect x="${VF.x}" y="${VF.y}" width="${VF.w}" height="${VF.h}" rx="16" fill="${P.panel}" fill-opacity="0.35" stroke="${P.cat.voice}" stroke-width="2.2" stroke-dasharray="14 8"/>`);
  L.over.push(`<g><rect x="${VF.x + VF.w - 250}" y="${VF.y + VF.h - 46}" width="236" height="30" rx="15" fill="${P.cat.voice}"/>`
    + `<text x="${VF.x + VF.w - 132}" y="${VF.y + VF.h - 25}" text-anchor="middle" ${st('vbadge')}>ONE VOICE  ×8</text></g>`);
  note(VF.x + VF.w - 266, VF.y + VF.h - 26, 'one per voice · mono from oscillator to VCA', 'nt', 'end');

  mk('pitch', { x: 2170, y: 300, w: 120, h: 490, cat: 'mod', title: 'PITCH',
    lines: ['note', '+ glide', '+ unison', '+ bend', '+ drift', '+ LFO', '+ matrix', '+ step', '  bend', '', 'Σ → every', 'oscillator', '+ sync pair'] });
  const OX = 2330;
  const OW = 260;
  mk('osc1', { x: OX, y: 300, w: OW, h: 154, cat: 'voice', title: 'OSC 1', icon: 'waves4', iconW: 200, iconH: 40,
    lines: ['OCTAVE ±2 · TUNE ±50¢', 'WIDTH 50–95% (square)', '~FM and RING source'] });
  mk('osc2', { x: OX, y: 500, w: OW, h: 172, cat: 'voice', title: 'OSC 2', icon: 'waves4', iconW: 200, iconH: 40, tag: 'sync worklet',
    lines: ['OCTAVE ±2 · TUNE ±50¢ · WIDTH', 'SYNC off · HARD · SOFT', 'SYNC PITCH 0–48 st'] });
  mk('sub', { x: OX, y: 700, w: OW, h: 72, cat: 'voice', title: 'SUB', lines: ['−1 or −2 octaves · 4 waves'] });
  mk('noise', { x: OX, y: 800, w: OW, h: 118, cat: 'voice', title: 'NOISE', icon: 'noise', iconH: 36,
    lines: ['white · one shared loop'] });
  const oy = (b) => b.y + b.h / 2;
  const RING = { x: 2665, y: 480, r: 24 };
  mk('mixer', { x: 2710, y: 300, w: 140, h: 618, cat: 'voice', title: 'MIXER',
    marks: [{ y: oy(B.osc1), t: 'OSC 1' }, { y: RING.y, t: 'RING' }, { y: oy(B.osc2), t: 'OSC 2' }, { y: oy(B.sub), t: 'SUB' }, { y: oy(B.noise), t: 'NOISE' }] });
  mk('filter', { x: 2900, y: 470, w: 250, h: 300, cat: 'voice', title: 'FILTER', icon: 'filter', iconH: 44, tag: 'worklet',
    lines: ['**LADDER', '4-pole low-pass · self-oscillates', '**POLY  (SHAPE morphs)', 'LP24 → LP12 → BP12 → HP24', 'CUTOFF as a MIDI note · RES', 'DRIVE · KEYTRACK · VEL AMT'] });
  const AMOD = { x: 3240, y: 620, r: 22 };
  const VCA = { x0: 3320, x1: 3440, y: 620, hh: 66 };
  mk('spread', { x: 3480, y: 545, w: 180, h: 150, cat: 'voice', title: 'SPREAD',
    lines: ['per-track PAN', '~wired in only while', '~a track is off centre'], badge: '→ STEREO' });
  mk('fenv', { x: 2950, y: 822, w: 200, cat: 'mod', title: 'FILTER ENV', icon: 'adsr', iconH: 36,
    lines: ['A · D · S · R'], pills: [['G', 'GATE · VEL', 'note']] });
  mk('aenv', { x: 3290, y: 752, w: 220, cat: 'mod', title: 'AMP ENV', icon: 'adsr', iconH: 36,
    lines: ['peak = velocity'], pills: [['G', 'GATE · VEL', 'note']] });

  // Modulation row
  const BUSY = 1050;
  mk('lfo1', { x: 2170, y: 1096, w: 250, cat: 'mod', title: 'LFO 1', icon: 'sine', iconH: 34,
    lines: ['SINE · TRI · SAW · SQUARE', 'RATE 0.05–20 Hz or SYNC', 'AMOUNT (+ MOD WHEEL)'] });
  mk('lfo2', { x: 2170, y: B.lfo1.y + B.lfo1.h + 22, w: 250, cat: 'mod', title: 'LFO 2', icon: 'sine', iconH: 34,
    lines: ['SINE · TRI · SAW · SQUARE', 'RATE 0.05–20 Hz or SYNC', 'AMOUNT'] });
  mk('route', { x: 2460, y: 1096, w: 380, cat: 'mod', title: 'MOD ROUTING', icon: 'matrix', iconH: 40, tag: 'LFO DEST + MATRIX',
    lines: ['**LFO 1 / LFO 2 → one destination each', 'CUTOFF · PITCH · AMP · PULSE (PWM)', 'PAN · SHAPE · SYNC',
      '**MOD MATRIX · 6 rows · SRC → DST × AMT ±1', 'SRC  LFO 1 · LFO 2 · MOD WHEEL · RANDOM', '        FILTER ENV · AMP ENV · VELOCITY · KEY',
      'DST  CUTOFF · RES · PITCH · SHAPE · AMP', '        DRIVE · PAN · SYNC · FM',
      '**always on:  BEND ±2 st · DRIFT ±12¢ → PITCH'] });
  mk('rand', { x: 2880, y: 1096, w: 250, cat: 'mod', title: 'RANDOM', icon: 'random', iconH: 32, tag: 'S&H',
    lines: ['new value every 16th', 'smoothed'], pills: [['C', 'CLOCK 16ths', 'clock']] });
  mk('perf', { x: 2880, y: B.rand.y + B.rand.h + 22, w: 250, cat: 'mod', title: 'PERFORMANCE',
    lines: ['PITCH BEND ±2 st', 'MOD WHEEL · aftertouch', 'ANALOG DRIFT ±12¢', 'STEP BEND (sequencer)'] });
  mk('vnote', { x: 3180, y: 1096, w: 480, cat: 'voice', title: 'HOW A VOICE PLAYS',
    lines: ['note-on starts both envelopes; the oscillators run', 'continuously, the VCA opens and closes them', 'cutoff is a note number, so modulation adds', 'in semitones; keytrack centres on C4',
      'a voice rests once its tail is below −96 dB', '~every modulation enters through the MOD BUS'] });

  // ── 3 · DRUMS ───────────────────────────────────────────────────────
  mk('drums', { x: MX, y: 1760, w: MW, cat: 'drum', title: 'DRUM MACHINE', icon: 'drum', iconH: 46,
    lines: ['8 TRACKS × 16 steps · banks A–P', '13 synthesized models · 7 kits', 'VEL · GATE · PROB · RATCHET · MICRO', 'CHOKE: closed hat cuts the open hat', 'FILL from LIVE FX'] });
  const DT = [['kick', 'KICK'], ['snare', 'SNARE'], ['hatc', 'CLOSED HAT'], ['hato', 'OPEN HAT'], ['tom', 'LOW TOM'], ['tom', 'MID TOM'], ['tom', 'HIGH TOM'], ['clap', 'CLAP']];
  const TX = 1800;
  const TWD = 300;
  const tiles = (prefix, y0, list, cat, sub) => list.map(([ic, name], i) => {
    const b = { x: TX, y: y0 + i * 84, w: TWD, h: 70 };
    B[`${prefix}${i}`] = b;
    const c = P.cat[cat];
    L.blocks.push(`<g><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="9" ${st('blk')}/>${edgeStrip(b.x, b.y, 5, b.h, 9, c, true)}`
      + useIcon(ic, b.x + 14, b.y + 11, 56, 48, c)
      + `<text x="${b.x + 84}" y="${b.y + 30}" ${st('bt')}>${esc(name)}</text><text x="${b.x + 84}" y="${b.y + 51}" ${st('bl')}>${esc(sub)}</text></g>`);
    return b;
  });
  tiles('dt', 1730, DT, 'drum', 'TUNE ±24 st · DECAY · model');
  const strip = (id, y, title, cells, cat) => {
    const fr = { x: 2170, y: y - 48 - 85, w: 1490, h: 48 + 170 + 22 };
    B[id] = fr;
    L.regions.push(`<rect x="${fr.x}" y="${fr.y}" width="${fr.w}" height="${fr.h}" rx="14" fill="${P.panel}" fill-opacity="0.35" stroke="${P.cat[cat]}" stroke-width="2" stroke-dasharray="10 7"/>`);
    L.over.push(`<text x="${fr.x + 18}" y="${fr.y + 30}" ${st('frt')} fill="${P.cat[cat]}">${esc(title)}</text>`);
    const gap = 54;
    const cw = (fr.w - 40 - gap * (cells.length - 1)) / cells.length;
    return cells.map((c, i) => mk(`${id}${i}`, { x: fr.x + 20 + i * (cw + gap), y: fr.y + 48, w: cw, h: 170, cat, ...c }));
  };
  const dcells = strip('dstrip', 1922 + 118, 'CHANNEL  ×8 — one per drum track', [
    { title: 'DRIVE', icon: 'dirt', iconH: 40, tag: 'tanh', lines: ['soft saturation', '~2× oversampled when driven'] },
    { title: 'TONE', icon: 'filter', iconH: 40, lines: ['low-pass', 'darkens the hit'] },
    { title: 'LEVEL', icon: 'fader', iconH: 40, lines: ['VOL per track', 'MUTE per track'] },
    { title: 'PAN', icon: 'pan', iconH: 40, lines: ['stereo position'], badge: '→ STEREO' },
  ], 'drum');

  // ── 3 · SAMPLER ─────────────────────────────────────────────────────
  mk('sampler', { x: MX, y: 2540, w: MW, cat: 'sampler', title: 'SAMPLER', icon: 'pads', iconH: 46,
    lines: ['8 SLOTS × 16 steps · banks A–P', 'MIDI channel 10 · notes 36–43', 'up to 16 voices per slot', 'CHOKE groups 1–4 · POLY or MONO'] });
  tiles('st', 2520, Array.from({ length: 8 }, (_, i) => ['wavesm', `SLOT S${i + 1}`]), 'sampler', 'one-shot buffer');
  const scells = strip('sstrip', 2712 + 118, 'CHANNEL  ×8 — one per slot', [
    { title: 'PLAY WINDOW', icon: 'wavesm', iconW: 56, iconH: 40, lines: ['PITCH ±24 st (speed)', 'START · END · REVERSE'] },
    { title: 'HIT ENV', icon: 'adsr', iconH: 40, lines: ['ATTACK · DECAY', 'choke cuts it short'] },
    { title: 'TONE', icon: 'filter', iconH: 40, lines: ['low-pass + RES'] },
    { title: 'LEVEL', icon: 'fader', iconH: 40, lines: ['VOL · MUTE'] },
    { title: 'PAN', icon: 'pan', iconH: 40, lines: ['stereo position'], badge: '→ STEREO' },
  ], 'sampler');

  // ── 4 · FX RACK ─────────────────────────────────────────────────────
  const CX = (i) => 3880 + i * 180;
  const CW = 156;
  const COLS = ['EQ', 'DIRT · COMP', 'WAH', 'PHASER', 'FLANGER', 'CHORUS', 'DELAY', 'REVERB', 'DUCK', 'PAN'];
  COLS.forEach((t, i) => {
    L.regions.push(`<path d="M${CX(i) + CW / 2} 486 V3230" stroke="${P.guide}" stroke-width="1.5" stroke-dasharray="3 7"/>`);
    L.regions.push(`<text x="${CX(i) + CW / 2}" y="474" text-anchor="middle" ${st('colh')}>${esc(t)}</text>`);
  });
  const FX = {
    eq: { title: 'EQ', icon: 'eq', lines: ['HP 20 Hz – 2 kHz', '8 BANDS ±18 dB', 'LP 200 Hz – 20 kHz', 'WIDTH (Q)', '~off by default'] },
    dirt: { title: 'DIRT', icon: 'dirt', lines: ['DISTORTION', 'OVERDRIVE · FUZZ', 'DRIVE · TONE · MIX', '~4× oversampled'] },
    comp: { title: 'COMP', icon: 'comp', tag: 'FET', lines: ['1176-style', 'RATIO 4 · 8 · 12', '20 · ALL', 'THR · ATK · REL', 'MAKEUP'] },
    wah: { title: 'WAH', icon: 'wah', lines: ['auto-wah', 'RATE or SYNC', 'DEPTH · Q'] },
    phaser: { title: 'PHASER', icon: 'phaser', lines: ['4 all-pass stages', 'RATE or SYNC', 'DEPTH · FEEDBACK', 'MIX'] },
    flanger: { title: 'FLANGER', icon: 'flanger', tag: 'worklet', lines: ['RATE or SYNC', 'DEPTH · FEEDBACK', 'MIX'] },
    chorus: { title: 'CHORUS', icon: 'chorus', lines: ['Juno-style', 'FREE · I · II · I+II', 'RATE · DEPTH · MIX'], badge: '→ STEREO' },
    delay: { title: 'DELAY', icon: 'delay', lines: ['DIGITAL', 'PING PONG ⇄', 'TAPE · BBD', 'SPACE ECHO', 'REVERSE', 'TIME · FDBK · CHAR'] },
    reverb: { title: 'REVERB', icon: 'reverb', lines: ['convolution', 'stereo impulse', 'SIZE · DAMP · MIX'], badge: '→ STEREO' },
    duck: { title: 'DUCK', icon: 'duck', lines: ['keyed by drum hits', 'AMOUNT · ATTACK', 'RELEASE', 'KEY: a lane or ANY'] },
    pan: { title: 'SYNTH PAN', icon: 'pan', lines: ['auto-pan', 'LFO / MATRIX PAN', '~always stereo'] },
  };
  const ROWS = [
    { id: 'syn', y: 505, cells: ['eq', 'dirt', 'wah', 'phaser', 'flanger', 'chorus', 'delay', 'reverb', 'duck', 'pan'] },
    { id: 'drm', y: 1922, cells: ['eq', 'comp', null, 'phaser', null, null, 'delay', 'reverb', null, null] },
    { id: 'smp', y: 2712, cells: ['eq', 'dirt', null, 'phaser', 'flanger', 'chorus', 'delay', 'reverb', 'duck', null] },
  ];
  const RH = 236;
  for (const row of ROWS) {
    row.cells.forEach((k, i) => {
      if (k) {
        mk(`${row.id}-${k}`, { x: CX(i), y: row.y, w: CW, h: RH, cat: 'fx', iconH: 34, ...FX[k],
          badge: row.id === 'drm' || row.id === 'smp' ? undefined : FX[k].badge });
      } else {
        L.regions.push(`<rect x="${CX(i) + 10}" y="${row.y + 40}" width="${CW - 20}" height="${RH - 80}" rx="10" fill="none" stroke="${P.guide}" stroke-width="1.6" stroke-dasharray="5 6"/>`);
        L.over.push(`<text x="${CX(i) + CW / 2}" y="${row.y + RH - 50}" text-anchor="middle" ${st('blf')}>not on this bus</text>`);
      }
    });
  }

  // ── 5 · MASTER ──────────────────────────────────────────────────────
  const MY = 1700;
  const PRE = { x: 5800, y: MY, r: 30 };
  mk('dj', { x: 5880, y: MY - 110, w: 230, h: 220, cat: 'master', title: 'DJ FILTER', icon: 'dj', iconH: 40,
    lines: ['LOW-PASS → HIGH-PASS', 'DJ FLT ±1 sweeps one', 'DROP: LP dives to 160 Hz'], pills: [['B', 'from LIVE FX', 'auto']] });
  mk('mcomp', { x: 6160, y: MY - 110, w: 240, h: 220, cat: 'master', title: 'MASTER COMP', icon: 'comp', iconH: 40, tag: 'VCA',
    lines: ['SSL-style bus compressor', 'THRESHOLD −40 – 0 dB', 'RATIO 2 · 4 · 10', 'ATTACK 0.1–30 ms', 'RELEASE / AUTO · MAKEUP'] });
  mk('vol', { x: 6470, y: MY - 110, w: 210, h: 220, cat: 'master', title: 'MASTER VOL', icon: 'fader', iconH: 40,
    lines: ['VOLUME² × EXPRESSION²', 'MIDI CC7 · CC11', '~fades in at start-up'] });
  const DEST = { x: 6760, y: MY, r: 28 };
  mk('scope', { x: 6300, y: 1270, w: 260, cat: 'master', title: 'SCOPE', icon: 'scope', iconH: 40,
    lines: ['L / R analysers', 'before the master volume'] });
  mk('direct', { x: 6620, y: 1200, w: 280, cat: 'master', title: 'DIRECT OUT',
    lines: ['straight to the output:', 'no FX, no master, not exported'],
    pills: [['D', 'METRONOME click', 'audio'], ['D', 'CLIP PREVIEW (studio)', 'audio']] });
  mk('export', { x: 6560, y: 1930, w: 300, cat: 'master', title: 'RECORD / EXPORT', icon: 'record', iconH: 40,
    lines: ['WAV · MP3', 'SONG EXPORT · 1–10 passes', 'manual takes'] });
  const SPK = { x: 6950, L: 1530, R: 1760, s: 110 };

  // ════════════════════════════════════════════════════════════ WIRES ══
  // Corridor between PLAY and NOTES & TIME.
  const XO = 545; // bend / mod (cv)
  const XP = 562; // automation
  const XN = 580; // notes
  const XC = 596; // channel 10 notes
  const XS = 610; // clock / sync

  const keyIn = B.key.y + 80;
  wire('note', [R(B.kbd, keyIn - B.kbd.y), Lf(B.key, keyIn - B.key.y)], { label: 'NOTES', at: [XN - 40, keyIn - 16] });
  wire('note', [R(B.qwerty, lineY(B.qwerty, 0) - B.qwerty.y), [XN, lineY(B.qwerty, 0)], [XN, keyIn]], { arrow: false, h1: 0 });
  wire('note', [R(B.midi, lineY(B.midi, 0) - B.midi.y), [XN, lineY(B.midi, 0)], [XN, B.qwerty.y + 100]], { arrow: false, h1: 0, dot1: false });
  // bend / mod
  const bendY = 1666;
  wire('cv', [R(B.qwerty, lineY(B.qwerty, 2) - B.qwerty.y), [XO, lineY(B.qwerty, 2)], [XO, bendY], [Bt(B.perf)[0], bendY], Bt(B.perf)],
    { label: 'PITCH BEND · MOD WHEEL', at: [1000, bendY] });
  wire('cv', [R(B.midi, lineY(B.midi, 1) - B.midi.y), [XO, lineY(B.midi, 1)]], { arrow: false, h1: 0, dot1: true });
  wire('cv', [R(B.wheels), [XO, oy(B.wheels)]], { arrow: false, h1: 0, dot1: true });
  // automation → parameter bus
  const parIn = B.params.y + 70;
  wire('auto', [R(B.midi, lineY(B.midi, 2) - B.midi.y), [XP, lineY(B.midi, 2)], [XP, parIn], Lf(B.params, 70)], { label: 'CC', at: [XP - 3, lineY(B.midi, 2) + 60] });
  wire('auto', [R(B.midi, lineY(B.midi, 3) - B.midi.y), [XP, lineY(B.midi, 3)]], { arrow: false, h1: 0, dot1: true });
  wire('auto', [R(B.xy), [XP, oy(B.xy)]], { arrow: false, h1: 0, dot1: true });
  wire('auto', [R(B.livefx, 70), [XP, B.livefx.y + 70]], { arrow: false, h1: 0, dot1: true });
  // clock / sync in
  const syncIn = B.sync.y + 70;
  wire('clock', [R(B.midi, lineY(B.midi, 5) - B.midi.y), [XS, lineY(B.midi, 5)], [XS, syncIn], Lf(B.sync, 70)], { label: 'CLOCK', at: [XS - 2, syncIn + 40] });
  wire('clock', [R(B.wifi), [XS, oy(B.wifi)], [XS, syncIn + 20]], { arrow: false, h1: 0 });
  // channel 10 → sampler
  wire('note', [R(B.midi, lineY(B.midi, 4) - B.midi.y), [XC, lineY(B.midi, 4)], [XC, 2560], Lf(B.sampler, 20)],
    { label: 'MIDI CH 10 → SLOTS', at: [900, 2560] });
  // mic / file → studio, slots
  wire('audio', [R(B.mic), [B.studio.x, oy(B.mic)]], { label: 'MIC', at: [575, oy(B.mic) - 16] });
  const bufY = 3214;
  wire('buf', [Bt(B.studio), [Bt(B.studio)[0], bufY], [1950, bufY], [1950, B.st7.y + B.st7.h]], { label: 'WRITE A SLOT', at: [1500, bufY] });
  wire('buf', [Bt(B.file), [Bt(B.file)[0], bufY], [Bt(B.studio)[0] - 4, bufY]], { arrow: false, h1: 0, dot1: true, label: 'LOAD', at: [440, bufY] });
  wire('buf', [[2010, bufY], [1950, bufY]], { arrow: false, dot1: true, h0: 0 });
  L.over.push(pill(2010, bufY, 'R', 'RENDER: the synth after its FX', 'buf').svg);

  // Notes & time internals
  wire('note', [Bt(B.key, 255), T(B.arp, 255)], { label: 'chord-expanded', at: [NX + 270, (B.key.y + B.key.h + B.arp.y) / 2], anchor: 'start' });
  // live passthrough → polyphony
  const pLive = B.poly.y + 60;
  const pArp = B.poly.y + 170;
  const pSeq = B.poly.y + 280;
  wire('note', [R(B.key, pLive - B.key.y), Lf(B.poly, 60)], { label: 'LIVE  (muted while ARP is on)', at: [1470, pLive] });
  const arpOut = oy(B.arp);
  wire('note', [R(B.arp), [1180, arpOut], [1180, pArp], Lf(B.poly, 170)], { label: 'ARP', at: [1470, pArp] });
  wire('note', [R(B.seq, pSeq - B.seq.y), Lf(B.poly, 280)], { label: 'SEQ', at: [1768, pSeq - 16] });
  // clock bus
  const XK = 1200;
  const kOut = oy(B.clock);
  const kEnd = B.sampler.y + 120;
  wire('clock', [R(B.clock), [XK, kOut], [XK, kEnd], Lf(B.sampler, 120)], { label: 'CLOCK · BANK', at: [XK, 1440] });
  for (const [b, dy] of [[B.seq, 140], [B.motion, 60], [B.drums, 80]]) wire('clock', [[XK, b.y + dy], Lf(b, dy)], { from: 'bus' });
  wire('clock', [[XK, oy(B.metro)], R(B.metro)], { from: 'bus' });
  wire('clock', [R(B.arrange), [XK, oy(B.arrange)]], { arrow: false, dot1: true });
  wire('clock', [T(B.clock, 255), Bt(B.arp, 255)], { label: '16ths', at: [NX + 300, (B.arp.y + B.arp.h + B.clock.y) / 2], anchor: 'start' });
  wire('clock', [T(B.sync, 255), Bt(B.clock, 255)], { label: 'TEMPO · POSITION', at: [NX + 300, (B.clock.y + B.clock.h + B.sync.y) / 2], anchor: 'start' });
  // motion → parameter bus
  wire('auto', [Bt(B.motion, 120), [MX + 120, B.params.y + 120], R(B.params, 120)], { label: 'AUTOMATION', at: [MX + 120, B.motion.y + B.motion.h + 70] });

  // Polyphony → voice
  wire('note', [R(B.poly, 60), Lf(B.pitch, 60)], { label: 'NOTE', at: [2140, B.poly.y + 44] });
  // seq track pan → spread
  const tpY = 280;
  wire('cv', [R(B.seq, 40), [1768, B.seq.y + 40], [1768, tpY], [3570, tpY], T(B.spread, 90)], { label: 'TRACK PAN t1–t4', at: [3000, tpY] });

  // Voice audio
  const ox = OX + OW;
  for (const b of [B.osc1, B.osc2, B.sub]) wire('cv', [[B.pitch.x + B.pitch.w, oy(b)], [OX, oy(b)]]);
  wire('audio', [[ox, oy(B.osc1)], [B.mixer.x, oy(B.osc1)]]);
  wire('audio', [[ox, oy(B.osc2)], [B.mixer.x, oy(B.osc2)]]);
  wire('audio', [[ox, oy(B.sub)], [B.mixer.x, oy(B.sub)]]);
  wire('audio', [[ox, oy(B.noise)], [B.mixer.x, oy(B.noise)]]);
  wire('audio', [[RING.x, oy(B.osc1)], [RING.x, RING.y - RING.r]], { from: 'bus' });
  wire('audio', [[RING.x, oy(B.osc2)], [RING.x, RING.y + RING.r]], { from: 'bus' });
  wire('audio', [[RING.x + RING.r, RING.y], [B.mixer.x, RING.y]]);
  sum(RING.x, RING.y, RING.r, '×', P.wire.audio);
  // FM / SYNC between the oscillators
  wire('cv', [[OX + 70, B.osc1.y + B.osc1.h], [OX + 70, B.osc2.y]], { label: 'FM', at: [OX + 104, (B.osc1.y + B.osc1.h + B.osc2.y) / 2] });
  wire('cv', [[OX + 180, B.osc1.y + B.osc1.h], [OX + 180, B.osc2.y]], { label: 'SYNC', at: [OX + 220, (B.osc1.y + B.osc1.h + B.osc2.y) / 2] });
  // mixer Σ
  L.over.push(`<text x="${B.mixer.x + 100}" y="${oy(B.mixer) + 20}" text-anchor="middle" ${st('sig')} font-size="44" fill="${P.cat.voice}">Σ</text>`);
  note(B.mixer.x + 100, oy(B.mixer) + 44, '× 0.5', 'sn', 'middle');
  wire('audio', [[B.mixer.x + B.mixer.w, 620], [B.filter.x, 620]]);
  wire('audio', [[B.filter.x + B.filter.w, 620], [AMOD.x - AMOD.r, 620]]);
  sum(AMOD.x, AMOD.y, AMOD.r, '×', P.wire.audio);
  note(AMOD.x, AMOD.y - 32, 'AMP MOD', 'sn', 'middle');
  wire('audio', [[AMOD.x + AMOD.r, 620], [VCA.x0, 620]]);
  L.blocks.push(`<g><path d="M${VCA.x0} ${VCA.y - VCA.hh} L${VCA.x1} ${VCA.y} L${VCA.x0} ${VCA.y + VCA.hh} Z" fill="${P.panel}" stroke="${P.cat.voice}" stroke-width="2.6" stroke-linejoin="round"/>`
    + `<text x="${VCA.x0 + 40}" y="${VCA.y + 7}" text-anchor="middle" ${st('vca')} fill="${P.cat.voice}">VCA</text></g>`);
  wire('audio', [[VCA.x1, 620], Lf(B.spread, 75)], { label: '× 0.25', at: [VCA.x1 + 20, 600] });
  // Envelopes
  const vcaBottomAt = (x) => VCA.y + VCA.hh - ((x - VCA.x0) / (VCA.x1 - VCA.x0)) * VCA.hh;
  wire('cv', [T(B.aenv, 95), [B.aenv.x + 95, vcaBottomAt(B.aenv.x + 95)]], { label: 'GAIN', at: [B.aenv.x + 130, 712] });
  wire('cv', [T(B.fenv, 100), [B.fenv.x + 100, B.filter.y + B.filter.h]], { label: 'ENV AMT ±48 st', at: [B.fenv.x + 100, 796] });
  // Mod bus
  const panX = CX(9) + CW / 2;
  wire('cv', [[B.pitch.x + 60, BUSY], [panX, BUSY]], { arrow: false, h1: 0, h0: 0 });
  label(3400, BUSY, 'MOD BUS', 'cv');
  wire('cv', [T(B.route, 180), [B.route.x + 180, BUSY]], { arrow: false, dot1: true, label: 'every destination', at: [B.route.x + 270, BUSY + 23] });
  wire('cv', [[B.pitch.x + 60, BUSY], [B.pitch.x + 60, B.pitch.y + B.pitch.h]], { from: 'bus', h0: 0 });
  const RAIL = 2615;
  wire('cv', [[RAIL, BUSY], [RAIL, B.osc1.y + 125], [OX + OW, B.osc1.y + 125]], { from: 'bus' });
  wire('cv', [[RAIL, B.osc2.y + 140], [OX + OW, B.osc2.y + 140]], { from: 'bus' });
  label(RAIL + 2, B.osc2.y + 160, 'WIDTH · FM · SYNC', 'cv', 'end');
  wire('cv', [[2920, BUSY], [2920, B.filter.y + B.filter.h]], { from: 'bus' });
  label(2920, 1012, 'CUTOFF · RES · DRIVE · SHAPE', 'cv', 'end');
  wire('cv', [[AMOD.x, BUSY], [AMOD.x, AMOD.y + AMOD.r]], { from: 'bus', label: 'AMP', at: [AMOD.x, 990] });
  wire('cv', [[panX, BUSY], [panX, ROWS[0].y + RH]], { h0: 0, label: 'PAN', at: [panX, 900] });
  // Sources → routing
  wire('cv', [R(B.lfo1), [B.route.x, oy(B.lfo1)]]);
  wire('cv', [R(B.lfo2), [B.route.x, oy(B.lfo2)]]);
  wire('cv', [Lf(B.rand), [B.route.x + B.route.w, oy(B.rand)]]);
  wire('cv', [Lf(B.perf), [B.route.x + B.route.w, oy(B.perf)]]);
  // Envelopes → matrix
  const emY = 1074;
  wire('cv', [Bt(B.fenv, 60), [B.fenv.x + 60, emY], [B.route.x + 330, emY], T(B.route, 330)], { label: 'ENVs → MATRIX', at: [B.fenv.x - 20, emY + 1] });
  wire('cv', [Bt(B.aenv, 60), [B.aenv.x + 60, emY], [B.fenv.x + 60, emY]], { arrow: false, dot1: true });

  // Voice → voice bus
  const VB = { x: 3745, y: 620, r: 28 };
  wire('audio', [R(B.spread, 75), [VB.x - VB.r, 620]], { label: '×8 voices', at: [3712, 590] });
  sum(VB.x, VB.y, VB.r, 'Σ', P.wire.audio, ['VOICE BUS', 'SEQ MASTER']);

  // Drums
  const DMY = B.drums.y + 70;
  wire('trig', [T(B.drums, 230), [B.drums.x + 230, 1680], [CX(8) + CW / 2, 1680], [CX(8) + CW / 2, ROWS[0].y + RH]], { label: 'DRUM HITS — scheduled, no audio sidechain', at: [3200, 1680] });
  wire('trig', [[CX(8) + CW / 2, 1680], [CX(8) + CW / 2, ROWS[2].y]], { from: 'bus' });
  const fan = (src, tilePrefix, xBar, label0) => {
    const ys = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => oy(B[`${tilePrefix}${i}`]));
    const srcY = Math.min(Math.max(src.y + 70, ys[0]), ys[7]);
    wire('note', [R(src, srcY - src.y), [xBar, srcY]], { arrow: false, dot1: true, label: label0, at: [xBar - 2, srcY - 16], anchor: 'end' });
    wire('note', [[xBar, ys[0]], [xBar, ys[7]]], { arrow: false, h0: 0, h1: 0 });
    ys.forEach((y) => wire('note', [[xBar, y], [TX, y]], { from: 'bus', h0: 6 }));
  };
  fan(B.drums, 'dt', 1768, 'TRIG');
  const merge = (tilePrefix, fr, xBar, type) => {
    const ys = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => oy(B[`${tilePrefix}${i}`]));
    ys.forEach((y) => wire(type, [[TX + TWD, y], [xBar, y]], { arrow: false, h1: 0 }));
    wire(type, [[xBar, ys[0]], [xBar, ys[7]]], { arrow: false, h0: 0, h1: 0 });
    wire(type, [[xBar, fr.y + fr.h / 2], [fr.x, fr.y + fr.h / 2]], { from: 'bus', h0: 6 });
  };
  merge('dt', B.dstrip, 2136, 'audio');
  const chainCells = (cells, ymid, types) => cells.forEach((c, i) => { if (i) wire(types[i - 1], [[cells[i - 1].x + cells[i - 1].w, ymid], [c.x, ymid]]); });
  const dMid = B.dstrip.y + B.dstrip.h / 2 + 0;
  chainCells(dcells, B.dstrip0.y + 85, ['audio', 'audio', 'audio']);
  const DB = { x: 3745, y: ROWS[1].y + RH / 2, r: 28 };
  wire('stereo', [[B.dstrip3.x + B.dstrip3.w, B.dstrip0.y + 85], [B.dstrip.x + B.dstrip.w + 30, B.dstrip0.y + 85], [B.dstrip.x + B.dstrip.w + 30, DB.y], [DB.x - DB.r, DB.y]]);
  sum(DB.x, DB.y, DB.r, 'Σ', P.wire.audio, ['DRUM BUS', 'MASTER · MUTE · SOLO']);
  void dMid;

  // Sampler
  fan(B.sampler, 'st', 1768, 'TRIG');
  merge('st', B.sstrip, 2136, 'audio');
  chainCells(scells, B.sstrip0.y + 85, ['audio', 'audio', 'audio', 'audio']);
  const SB = { x: 3745, y: ROWS[2].y + RH / 2, r: 28 };
  wire('stereo', [[B.sstrip4.x + B.sstrip4.w, B.sstrip0.y + 85], [B.sstrip.x + B.sstrip.w + 30, B.sstrip0.y + 85], [B.sstrip.x + B.sstrip.w + 30, SB.y], [SB.x - SB.r, SB.y]]);
  sum(SB.x, SB.y, SB.r, 'Σ', P.wire.audio, ['SAMPLER BUS', 'MASTER · MUTE · SOLO']);

  // Rack rows
  const rowWire = (row, startX, ymid, typeAt) => {
    let prevX = startX;
    let segI = 0;
    row.cells.forEach((k, i) => {
      if (!k) return;
      const b = B[`${row.id}-${k}`];
      wire(typeAt(segI++, k), [[prevX, ymid], [b.x, ymid]]);
      prevX = b.x + b.w;
    });
    return prevX;
  };
  const synOut = rowWire(ROWS[0], VB.x + VB.r, VB.y, (i, k) => (['duck', 'pan'].includes(k) ? 'stereo' : 'audio'));
  const drmOut = rowWire(ROWS[1], DB.x + DB.r, DB.y, () => 'stereo');
  const smpOut = rowWire(ROWS[2], SB.x + SB.r, SB.y, () => 'stereo');
  // to pre-master
  wire('stereo', [[synOut, VB.y], [PRE.x, VB.y], [PRE.x, PRE.y - PRE.r]], { label: 'SYNTH', at: [5752, VB.y - 26] });
  wire('stereo', [[drmOut, DB.y], [PRE.x, DB.y], [PRE.x, PRE.y + PRE.r]], { label: 'DRUMS', at: [5752, DB.y - 26] });
  wire('stereo', [[smpOut, SB.y], [PRE.x, SB.y], [PRE.x, DB.y + 6]], { arrow: false, dot1: true, label: 'SAMPLER', at: [5752, SB.y - 26] });
  // render tap
  wire('buf', [[5718, VB.y], [5718, VB.y + 120]], { from: 'bus', h0: 10 });
  L.over.push(pill(5718, VB.y + 140, 'R', 'RENDER TO SAMPLER', 'buf', 'middle').svg);
  sum(PRE.x, PRE.y, PRE.r, 'Σ', P.wire.audio, []);
  note(PRE.x - 40, PRE.y + 4, 'PRE-MASTER', 'sn', 'end');
  // master chain
  wire('stereo', [[PRE.x + PRE.r, MY], [B.dj.x, MY]]);
  wire('stereo', [[B.dj.x + B.dj.w, MY], [B.mcomp.x, MY]]);
  wire('stereo', [[B.mcomp.x + B.mcomp.w, MY], [B.vol.x, MY]]);
  wire('stereo', [[B.scope.x + B.scope.w / 2, MY], [B.scope.x + B.scope.w / 2, B.scope.y + B.scope.h]], { from: 'bus', h0: 10, label: 'TAP', at: [B.scope.x + B.scope.w / 2 + 34, MY - 70] });
  wire('stereo', [[B.vol.x + B.vol.w, MY], [DEST.x - DEST.r, MY]]);
  wire('stereo', [[6720, MY], [6720, B.export.y]], { from: 'bus', h0: 10, label: 'TAP', at: [6756, MY + 110] });
  wire('stereo', [[DEST.x, B.direct.y + B.direct.h], [DEST.x, DEST.y - DEST.r]]);
  sum(DEST.x, DEST.y, DEST.r, 'Σ', P.wire.audio, []);
  note(DEST.x + 6, DEST.y + DEST.r + 20, 'OUTPUT', 'sn', 'start');
  // L / R
  const spl = 6840;
  wire('audio', [[DEST.x + DEST.r, MY], [spl, MY], [spl, SPK.L + SPK.s / 2], [SPK.x, SPK.L + SPK.s / 2]]);
  wire('audio', [[spl, MY], [spl, SPK.R + SPK.s / 2], [SPK.x, SPK.R + SPK.s / 2]], { from: 'bus' });
  for (const [ch, y] of [['L', SPK.L], ['R', SPK.R]]) {
    L.blocks.push(useIcon('speaker', SPK.x, y, SPK.s, SPK.s, P.cat.master));
    L.over.push(`<text x="${SPK.x + SPK.s + 40}" y="${y + SPK.s / 2 + 18}" ${st('lr')}>${ch}</text>`);
  }
  L.over.push(`<text x="${SPK.x - 10}" y="${SPK.R + SPK.s + 52}" ${st('out')}>STEREO OUT</text>`);
  L.over.push(`<text x="${SPK.x - 10}" y="${SPK.R + SPK.s + 78}" ${st('nt')}>speakers · headphones · audio interface</text>`);
  note(6800, MY - 300, '', 'nt');

  // ══════════════════════════════════════════════════════ notes & cards ══
  // A text card; returns its rectangle (height from the row count).
  const card = (r, title, rows, cat) => {
    const { x, y, w } = r;
    const h = 54 + rows.length * 24 + 10;
    const c = P.cat[cat];
    let s = `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${P.panel}" stroke="${c}" stroke-width="1.6"/>`;
    s += `<text x="${x + 20}" y="${y + 34}" ${st('ct')} fill="${c}">${esc(title)}</text>`;
    rows.forEach((r, i) => {
      const bold = r.startsWith('**');
      s += `<text x="${x + 20}" y="${y + 64 + i * 24}" ${st(bold ? 'cb' : 'cl')}>${esc(bold ? r.slice(2) : r)}</text>`;
    });
    L.blocks.push(`${s}</g>`);
    return { ...r, h };
  };
  const CARD_INSERTS = card({ x: 3880, y: 1110, w: 1450 }, 'HOW THE INSERT CHAINS WORK', [
    '**Every bus has its own chain, in a fixed order, read left to right.',
    'Each effect sits on a dry/wet crossfade; a bypassed effect is disconnected, so it costs nothing.',
    'EQ heads every chain (off by default): it shapes what DIRT drives and what the drum COMP hears.',
    'Only the SYNTH has WAH and SYNTH PAN · only the DRUMS have a COMP · the DRUMS are never ducked.',
    'DUCK listens to no audio: each drum hit schedules its dip at the moment the hit will sound.',
    'DELAY and the FX rates can lock to the tempo (SYNC); DELAY TYPE swaps the whole echo engine.',
  ], 'fx');
  const CARD_STEREO = card({ x: 5860, y: 300, w: 1370 }, 'WHERE THE SIGNAL TURNS STEREO', [
    '**The synth voice is mono from oscillator to VCA — eight voices sum to one channel.',
    'SPREAD makes it stereo only while a sequencer track is panned off centre.',
    'CHORUS (while on), DELAY in PING PONG and REVERB each add a second channel.',
    'SYNTH PAN always hands the master two channels, so the level never jumps.',
    'Drums and sampler are stereo from each channel\'s PAN onward.',
    '**Single blue line = mono · double blue line = stereo.',
  ], 'master');
  const CARD_OFFPATH = card({ x: 5860, y: 2330, w: 1370 }, 'NOT ON THE AUDIO PATH', [
    '**TAPE STOP ramps the tempo to 20 BPM and bends the synth down — automation, not an effect.',
    'STUTTER re-maps which step every machine plays; FILL swaps in a drum fill.',
    'The MICROPHONE only reaches the sample studio — it is never monitored.',
    'RENDER TO SAMPLER records the synth after its FX into a sampler slot.',
    'There is no limiter: MASTER COMP is the last dynamics stage.',
    'SCOPE reads the signal before MASTER VOL, so it does not shrink with the volume.',
  ], 'master');

  // ══════════════════════════════════════════════════════ title & legend ══
  const hdr = [];
  // The name as the faceplate sets it: VAST heavy, the model number light.
  hdr.push(`<text x="40" y="104" ${st('h1')}>VAST<tspan font-weight="400"> G1-J8</tspan></text>`);
  hdr.push(`<text x="640" y="104" ${st('h2')}>WEBSYNTH · SIGNAL FLOW</text>`);
  hdr.push(`<text x="42" y="150" ${st('h3')}>Every path from a key press to the speakers: notes and clock, the machines, eight synth voices, the drum machine and sampler, three insert chains and the master section.</text>`);
  hdr.push(`<text x="42" y="182" ${st('h4')}>Read left to right. The colour and line of a wire say what travels on it; a lettered tag (Ⓐ…) continues the wire at the tag with the same letter.</text>`);
  hdr.push(`<text x="${W - 40}" y="66" text-anchor="end" ${st('ver')}>v${esc(VERSION)}</text>`);
  // compact wire key, top right
  const keyTypes = ['audio', 'stereo', 'note', 'cv', 'clock', 'trig', 'auto', 'buf'];
  keyTypes.forEach((t, i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const x = 4520 + col * 680;
    const y = 114 + row * 46;
    hdr.push(keySample(x, y, t));
  });

  function keySample(x, y, t) {
    const wt = WT[t];
    const c = P.wire[t];
    const dash = wt.dash ? ` stroke-dasharray="${wt.dash}"` : '';
    let s = `<path d="M${x} ${y} H${x + 120}" stroke="${c}" stroke-width="${wt.w}"${dash} stroke-linecap="${t === 'clock' ? 'round' : 'butt'}" marker-end="url(#sf-m-${t})"/>`;
    if (t === 'stereo') s += `<path d="M${x} ${y} H${x + 104}" stroke="${P.bg}" stroke-width="3"/>`;
    s += `<text x="${x + 140}" y="${y + 5}" ${st('kt')}>${esc(wt.name)}</text>`;
    return s;
  }

  // bottom legend
  const LG = { x: 40, y: 3310, w: W - 80, h: 410 };
  const lg = [];
  lg.push(`<rect x="${LG.x}" y="${LG.y}" width="${LG.w}" height="${LG.h}" rx="20" fill="${P.region}" stroke="${P.regionEdge}" stroke-width="2"/>`);
  lg.push(`<text x="${LG.x + 30}" y="${LG.y + 48}" ${st('rt')}>LEGEND</text>`);
  lg.push(`<text x="${LG.x + 30}" y="${LG.y + 86}" ${st('lgh')}>WIRES — what travels on them</text>`);
  [...keyTypes.slice(0, 2), 'note', 'vel', 'cv', 'clock', 'trig', 'auto', 'buf'].forEach((t, i) => {
    const col = Math.floor(i / 3);
    const row = i % 3;
    lg.push(keySample(LG.x + 30 + col * 560, LG.y + 130 + row * 52, t));
  });
  const wireNotes = [
    'AUDIO — the sound itself, mono', 'AUDIO — two channels (left + right)', 'NOTE — which key, when it starts and stops',
    'VELOCITY — how hard', 'MODULATION — a control signal moving a knob', 'CLOCK — 16th-note ticks, tempo, song position',
    'DRUM HIT — the duck\'s key', 'AUTOMATION — a machine or controller turning a knob', 'SAMPLE DATA — a recording written into a slot',
  ];
  void wireNotes;
  // symbols
  const SX = LG.x + 1800;
  lg.push(`<text x="${SX}" y="${LG.y + 86}" ${st('lgh')}>SYMBOLS</text>`);
  const sym = (i, draw, text) => {
    const col = Math.floor(i / 3);
    const row = i % 3;
    const x = SX + col * 560;
    const y = LG.y + 130 + row * 52;
    lg.push(draw(x + 24, y));
    lg.push(`<text x="${x + 66}" y="${y + 5}" ${st('kt')}>${esc(text)}</text>`);
  };
  const c = P.wire.audio;
  sym(0, (x, y) => `<circle cx="${x}" cy="${y}" r="18" fill="${P.panel}" stroke="${c}" stroke-width="2.4"/><text x="${x}" y="${y + 7}" text-anchor="middle" ${st('sig')} font-size="20" fill="${c}">Σ</text>`, 'SUM / BUS — signals add up');
  sym(1, (x, y) => `<circle cx="${x}" cy="${y}" r="18" fill="${P.panel}" stroke="${P.wire.audio}" stroke-width="2.4"/><path d="M${x - 8} ${y - 8} L${x + 8} ${y + 8} M${x + 8} ${y - 8} L${x - 8} ${y + 8}" stroke="${P.wire.audio}" stroke-width="2.4"/>`, 'MULTIPLY — ring mod, gain modulation');
  sym(2, (x, y) => `<path d="M${x - 18} ${y - 18} L${x + 20} ${y} L${x - 18} ${y + 18} Z" fill="${P.panel}" stroke="${P.cat.voice}" stroke-width="2.4"/>`, 'VCA — amplifier opened by the envelope');
  sym(3, (x, y) => `<circle cx="${x}" cy="${y}" r="6" fill="${P.wire.cv}"/><path d="M${x - 24} ${y} H${x + 24}" stroke="${P.wire.cv}" stroke-width="2.6"/>`, 'JUNCTION — the wire splits here');
  sym(4, (x, y) => `<rect x="${x - 22}" y="${y - 14}" width="44" height="28" rx="6" fill="none" stroke="${P.guide}" stroke-width="1.6" stroke-dasharray="5 6"/>`, 'EMPTY SLOT — effect not on this bus');
  sym(5, (x, y) => badge(x + 10, y, '→ STEREO'), 'the signal becomes two channels here');
  sym(6, (x, y) => pill(x - 22, y, 'A', '', 'cv').svg, 'TAG — the wire continues at the same letter');
  sym(7, (x, y) => `<rect x="${x - 24}" y="${y - 16}" width="48" height="32" rx="10" fill="none" stroke="${P.cat.voice}" stroke-width="2" stroke-dasharray="9 6"/>`, 'FRAME — everything inside repeats per voice / track');
  sym(8, (x, y) => `<rect x="${x - 24}" y="${y - 16}" width="48" height="32" rx="6" ${st('blk')}/>${edgeStrip(x - 24, y - 16, 5, 32, 6, P.cat.fx, true)}`, 'BLOCK — colour strip shows its section');
  // section colours
  const CXS = SX + 1720;
  lg.push(`<text x="${CXS}" y="${LG.y + 86}" ${st('lgh')}>SECTIONS</text>`);
  [['input', 'PLAY'], ['time', 'NOTES & TIME'], ['machine', 'SEQUENCERS'], ['voice', 'SYNTH VOICE'], ['mod', 'MODULATION'], ['drum', 'DRUMS'], ['sampler', 'SAMPLER'], ['fx', 'EFFECTS'], ['master', 'MASTER']].forEach(([k, t], i) => {
    const col = Math.floor(i / 3);
    const row = i % 3;
    const x = CXS + col * 250;
    const y = LG.y + 130 + row * 52;
    lg.push(`<rect x="${x}" y="${y - 12}" width="34" height="24" rx="5" fill="${P.cat[k]}"/><text x="${x + 46}" y="${y + 5}" ${st('kt')}>${esc(t)}</text>`);
  });
  lg.push(`<text x="${LG.x + 30}" y="${LG.y + LG.h - 28}" ${st('ft')}>Generated by scripts/diagram/signal-flow.mjs (npm run docs:diagram) from the v${esc(VERSION)} engine. Source of truth: specs/architecture.md → "Audio graph".</text>`);

  // ═══════════════════════════════════════════════════════════ zones ══
  zone('play-keys', 'play', around(['kbd', 'qwerty', 'midi']));
  zone('play-ctl', 'play', around(['wheels', 'xy', 'livefx', 'wifi']));
  zone('play-in', 'play', around(['mic', 'file']));
  zone('notes-keys', 'notes', around(['key', 'arp']));
  zone('notes-clock', 'notes', around(['clock', 'sync', 'arrange', 'metro', 'params']));
  zone('notes-studio', 'notes', around(['studio']));
  zone('seqs', 'synth', around(['seq', 'motion', 'poly']));
  zone('voice', 'synth', { x: VF.x, y: VF.y, w: VF.w, h: BUSY + 20 - VF.y });
  zone('mod', 'synth', { x: VF.x, y: BUSY - 20, w: VF.w, h: VF.y + VF.h - BUSY + 20 });
  const tilesOf = (p) => Array.from({ length: 8 }, (_, i) => `${p}${i}`);
  const toBus = (fr, bus) => ({ x: fr.x - 10, y: fr.y - 10, w: bus.x + bus.r + 30 - fr.x, h: fr.h + 20 });
  zone('drum-machine', 'drums', around(['drums', ...tilesOf('dt')]));
  zone('drum-channel', 'drums', toBus(B.dstrip, DB));
  zone('sampler-machine', 'sampler', around(['sampler', ...tilesOf('st')]));
  zone('sampler-channel', 'sampler', toBus(B.sstrip, SB));
  const rackRow = (row) => ({ x: CX(0) - 30, y: row.y - 70, w: CX(COLS.length - 1) + CW + 30 - (CX(0) - 30), h: RH + 100 });
  zone('fx-synth', 'fx', rackRow(ROWS[0]));
  zone('fx-inserts', 'fx', around([CARD_INSERTS]));
  zone('fx-drum', 'fx', rackRow(ROWS[1]));
  zone('fx-sampler', 'fx', rackRow(ROWS[2]));
  zone('master-chain', 'master', around([{ x: PRE.x - 110, y: PRE.y - PRE.r, w: 110 + PRE.r, h: 2 * PRE.r }, 'dj', 'mcomp', 'vol', 'scope', 'direct', 'export',
    { x: SPK.x - 10, y: SPK.L, w: 7250 - SPK.x, h: SPK.R + SPK.s + 90 - SPK.L }]));
  zone('master-stereo', 'master', around([CARD_STEREO]));
  zone('master-offpath', 'master', around([CARD_OFFPATH]));
  zone('legend', null, LG);
  zone('legend-wires', 'legend', { x: LG.x, y: LG.y, w: SX - 40 - LG.x, h: LG.h });
  zone('legend-symbols', 'legend', { x: SX - 30, y: LG.y, w: CXS - SX, h: LG.h });
  zone('legend-sections', 'legend', { x: CXS - 30, y: LG.y, w: 3 * 250 + 90, h: LG.h });
  for (const id of TOUR_ORDER) {
    if (!Z.some((z) => z.id === id)) throw new Error(`tour stop "${id}" is not a zone`);
  }

  // Spots: every drawn block, by its layout id, with the leaf zone it sits in —
  // what a help topic's deep link rings on the map (signal-flow-map.md
  // REQ-a-help-topic-shows-its-place). Taken from the blocks, never listed by hand.
  const drawn = Object.entries(B).filter(([, b]) => b.cat && b.title !== undefined);
  const isLeaf = (z) => !Z.some((c) => c.parent === z.id);
  const SPOTS = drawn.map(([id, b]) => {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const home = Z
      .filter((z) => isLeaf(z) && cx >= z.x && cx <= z.x + z.w && cy >= z.y && cy <= z.y + z.h)
      .sort((p, q) => p.w * p.h - q.w * q.h)[0];
    if (!home) throw new Error(`block "${id}" lies in no zone`);
    return { id, title: b.title, zone: home.id, x: n(b.x), y: n(b.y), w: n(b.w), h: n(b.h) };
  });

  // ═══════════════════════════════════════════════════════════ assemble ══
  for (const [, b] of drawn) drawBlock(b);

  const markers = Object.keys(WT).map((t) => {
    const c = P.wire[t];
    const big = t === 'stereo' ? 1.5 : t === 'audio' || t === 'buf' ? 1.2 : 1;
    const w = n(14 * big);
    const h = n(11 * big);
    const fill = t === 'buf' ? `fill="${P.panel}" stroke="${c}" stroke-width="2"` : `fill="${c}"`;
    return `<marker id="sf-m-${t}" viewBox="0 0 ${w} ${h}" refX="${w - 1}" refY="${h / 2}" markerWidth="${w}" markerHeight="${h}" markerUnits="userSpaceOnUse" orient="auto"><path d="M1 1 L${w - 1} ${h / 2} L1 ${h - 1} Z" ${fill}/></marker>`;
  }).join('');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${SANS}" role="img" aria-labelledby="sf-title sf-desc">
<title id="sf-title">VAST G1-J8 — signal flow (v${esc(VERSION)})</title>
<desc id="sf-desc">Signal-flow diagram of the VAST G1-J8 web synthesizer: inputs, note and clock processing, sequencers, the synth voice with its oscillators, mixer, filter, VCA, envelopes, LFOs and modulation matrix, the drum machine and sampler channels, the three insert-effect chains, and the master section ending in a stereo output.</desc>
<!-- Generated by scripts/diagram/signal-flow.mjs — edit the script, not this file. -->
<defs>${markers}
${icons()}
</defs>
<rect width="${W}" height="${H}" fill="${P.bg}"/>
<g id="sf-regions">${L.regions.join('\n')}</g>
<g id="sf-blocks">${L.blocks.join('\n')}</g>
<g id="sf-wires">${L.wires.join('\n')}</g>
<g id="sf-labels">${L.over.join('\n')}</g>
<g id="sf-header">${hdr.join('\n')}</g>
<g id="sf-legend">${lg.join('\n')}</g>
</svg>
`;
  assertCspSafe(svg);
  return { svg, zones: { width: W, height: H, intro: ZONE_INTRO, zones: Z, tour: TOUR_ORDER, spots: SPOTS } };
}

// The app inlines these files (signal-flow-map.md), so they must stay inside its
// CSP and its id space — and a style passed as an attribute next to the same
// attribute written by hand would be a duplicate, which is an XML error.
function assertCspSafe(svg) {
  if (/<style|\sstyle="/.test(svg)) throw new Error('signal-flow: <style> or style="" would be dropped by the app CSP');
  for (const [, id] of svg.matchAll(/\sid="([^"]+)"/g)) {
    if (!id.startsWith('sf-')) throw new Error(`signal-flow: id "${id}" is not namespaced sf-`);
  }
  for (const [tag] of svg.matchAll(/<[a-zA-Z][^>]*>/g)) {
    const names = [...tag.matchAll(/\s([\w:-]+)="/g)].map((m) => m[1]);
    const dup = names.find((a, i) => names.indexOf(a) !== i);
    if (dup) throw new Error(`signal-flow: duplicate attribute ${dup} in ${tag.slice(0, 120)}`);
  }
}

// ─────────────────────────────────────────────────────────────────── main ──

/** Both posters and the zone manifest, in memory (tests read this). */
export function buildAll() {
  const out = {};
  let zones;
  for (const [name, palette] of Object.entries(PALETTES)) {
    const r = render(palette);
    out[name] = r.svg;
    zones = r.zones;
  }
  return { ...out, zones };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = buildAll();
  mkdirSync(resolve(ROOT, 'docs'), { recursive: true });
  for (const name of Object.keys(PALETTES)) {
    writeFileSync(resolve(ROOT, 'docs', `signal-flow-${name}.svg`), built[name]);
    console.log(`wrote docs/signal-flow-${name}.svg`);
  }
  writeFileSync(resolve(ROOT, 'docs', 'signal-flow-zones.json'), `${JSON.stringify(built.zones, null, 2)}\n`);
  console.log('wrote docs/signal-flow-zones.json');
}

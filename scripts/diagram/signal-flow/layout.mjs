// Where everything goes: every region, block, wire, card and legend entry of the
// poster, and the map zones taken from them. Read top to bottom it is the
// poster, left to right.
//
// The sections run in a fixed order (drawPoster) because draw order is stacking
// order within a layer — reorder them and the output changes even where the
// picture does not.
//
// This is an *illustration*: the facts were read from src/audio/engine.ts,
// src/audio/voice.ts, src/audio/effects/fx-chain.ts and src/state/params.ts.

import { W, WIRE_TYPES } from './theme.mjs';
import { esc } from './geometry.mjs';
import { R, Lf, T, Bt, Rl, oy, lineY } from './canvas.mjs';

// ─────────────────────────────────────────────────────────────── geometry ──

const IX = 60; // 1 · PLAY column
const IW = 450;
const NX = 640; // 2 · NOTES & TIME column
const NW = 510;
const MX = 1270; // 3 · machines column
const MW = 466;

// The synth voice (×8) frame, and what is drawn inside it.
const VF = { x: 2150, y: 262, w: 1540, h: 1370 };
const OX = 2330; // oscillator column
const OW = 260;
const RING = { x: 2665, y: 480, r: 24 };
const AMOD = { x: 3240, y: 620, r: 22 };
const VCA = { x0: 3320, x1: 3440, y: 620, hh: 66 };
const BUSY = 1050; // the MOD BUS
const RAIL = 2615; // the bus's drop to the oscillators

// Drum and sampler tiles.
const TX = 1800;
const TWD = 300;

// 4 · FX RACK: one column per effect, one row per bus.
const CX = (i) => 3880 + i * 180;
const CW = 156;
const RH = 236;
const COLS = ['EQ', 'DIRT · COMP', 'WAH', 'PHASER', 'FLANGER', 'CHORUS', 'DELAY', 'REVERB', 'DUCK', 'PAN'];
const ROWS = [
  { id: 'syn', y: 505, cells: ['eq', 'dirt', 'wah', 'phaser', 'flanger', 'chorus', 'delay', 'reverb', 'duck', 'pan'] },
  { id: 'drm', y: 1922, cells: ['eq', 'comp', null, 'phaser', null, null, 'delay', 'reverb', null, null] },
  { id: 'smp', y: 2712, cells: ['eq', 'dirt', null, 'phaser', 'flanger', 'chorus', 'delay', 'reverb', 'duck', null] },
];
const PAN_X = CX(9) + CW / 2;
const DUCK_X = CX(8) + CW / 2;

// The three buses, each feeding its rack row.
const VB = { x: 3745, y: 620, r: 28 };
const DB = { x: 3745, y: ROWS[1].y + RH / 2, r: 28 };
const SB = { x: 3745, y: ROWS[2].y + RH / 2, r: 28 };

// 5 · MASTER
const MY = 1700;
const PRE = { x: 5800, y: MY, r: 30 };
const DEST = { x: 6795, y: MY, r: 28 };
const SPK = { x: 6950, L: 1530, R: 1760, s: 110 };

// The legend along the bottom: wires · symbols · sections.
const LG = { x: 40, y: 3310, w: W - 80, h: 410 };
const SX = LG.x + 1800;
const CXS = SX + 1720;
/** Legend entry i of a three-row grid starting at x0, columns colW apart. */
const legendCell = (i, x0, colW) => [x0 + Math.floor(i / 3) * colW, LG.y + 130 + (i % 3) * 52];

// Wire endings that run into another wire rather than a block.
const MEET = { arrow: false, h1: 0 }; // into another wire's corner
const JOIN = { arrow: false, h1: 0, dot1: true }; // into a junction on another wire

// ═════════════════════════════════════════════════════════════════ poster ══

/** Draw the whole poster onto canvas `c`; returns the zone manifest's parts. */
export function drawPoster(c, version) {
  drawRegions(c);
  drawPlay(c);
  drawNotes(c);
  drawSynth(c);
  drawDrums(c);
  drawSampler(c);
  drawRack(c);
  drawMaster(c);

  wirePlay(c);
  wireNotes(c);
  wireVoice(c);
  wireDrumsAndSampler(c);
  wireRackAndMaster(c);

  const cards = drawCards(c);
  drawHeader(c, version);
  drawLegend(c, version);

  defineZones(c, cards);
  const drawn = c.drawnBlocks();
  const spots = c.zones.spots(drawn);
  c.drawBlocks();
  return { zones: c.zones.list, spots };
}

// ════════════════════════════════════════════════════════════════ blocks ══

function drawRegions({ P, region, band }) {
  region(40, 250, 490, 3010, '1', 'PLAY', 'keys · controllers · sound in', 'play');
  region(620, 250, 550, 3010, '2', 'NOTES & TIME', '', 'notes');
  region(1220, 250, 2580, 3010, '3', 'MACHINES & SOUND SOURCES', 'what makes sound, and what plays it', 'machines');
  region(3830, 250, 1870, 3010, '4', 'FX RACK', 'one insert chain per bus · bypassed = disconnected', 'fx');
  region(5740, 250, 1520, 3010, '5', 'MASTER & OUTPUT', '', 'master');
  band(1232, 262, 2556, 1384, 'SYNTH', P.cat.voice, 'synth', 'machines');
  band(1232, 1694, 2556, 758, 'DRUMS', P.cat.drum, 'drums', 'machines');
  band(1232, 2496, 2556, 752, 'SAMPLER', P.cat.sampler, 'sampler', 'machines');
}

// ── 1 · PLAY ──────────────────────────────────────────────────────────────
function drawPlay({ stack }) {
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
}

// ── 2 · NOTES & TIME ──────────────────────────────────────────────────────
function drawNotes({ stack, mk }) {
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
    lines: ['CROP · REVERSE · NORMALIZE · GAIN · FADE', 'FILTER · OCTAVE · PITCH SHIFT', 'TIME-STRETCH to tempo (WSOLA / phase)', 'SCRATCH · CHOP across the pads', 'VOCODER: a voice take shapes the clip'],
    pills: [['D', 'CLIP PREVIEW → DIRECT OUT', 'audio']] });
}

// ── 3 · SYNTH: sequencers, the voice (×8), modulation ─────────────────────
function drawSynth({ P, L, B, mk, st, note, frame }) {
  mk('seq', { x: MX, y: 530, w: MW, cat: 'machine', title: 'STEP SEQUENCER', icon: 'seqgrid', iconH: 46,
    lines: ['4 TRACKS × 16 steps · banks A–P', 'NOTE · VEL · GATE · PROBABILITY', 'RATCHET · TIE · MICRO · BEND', 'per-track PAN → voice SPREAD', '~tracks 2–4 sound in POLY only'] });
  mk('motion', { x: MX, y: B.seq.y + B.seq.h + 34, w: MW, cat: 'machine', title: 'MOTION SEQUENCER', icon: 'motion', iconH: 44,
    lines: ['XY lane + 4 parameter tracks A–D', 'SLIDE between points, or STEP', 'automates any knob, per bank'] });
  mk('poly', { x: 1800, y: 300, w: 310, h: 360, cat: 'voice', title: 'POLYPHONY', icon: 'poly', iconH: 46, tag: 'voice allocator',
    lines: ['8 VOICES · POLY or MONO', '~5 voices on the Weak performance tier', 'UNISON 1–4 · DETUNE 0–50¢', 'GLIDE off · always · legato', 'steals idle → releasing → oldest', 'ENV TRIGGER multi or single'],
    pills: [['G', 'GATE · VELOCITY → ENVs', 'note']] });

  // The voice frame.
  frame(VF, P.cat.voice, 2.2, '14 8', 16);
  L.over.push(`<g><rect x="${VF.x + VF.w - 250}" y="${VF.y + VF.h - 46}" width="236" height="30" rx="15" fill="${P.cat.voice}"/>`
    + `<text x="${VF.x + VF.w - 132}" y="${VF.y + VF.h - 25}" text-anchor="middle" ${st('vbadge')}>ONE VOICE  ×8</text></g>`);
  note(VF.x + VF.w - 266, VF.y + VF.h - 26, 'one per voice · mono from oscillator to VCA', 'nt', 'end');

  mk('pitch', { x: 2170, y: 300, w: 120, h: 490, cat: 'mod', title: 'PITCH',
    lines: ['note', '+ glide', '+ unison', '+ bend', '+ drift', '+ LFO', '+ matrix', '+ step', '  bend', '', 'Σ → every', 'oscillator', '+ sync pair'] });
  mk('osc1', { x: OX, y: 300, w: OW, h: 154, cat: 'voice', title: 'OSC 1', icon: 'waves4', iconW: 200, iconH: 40,
    lines: ['OCTAVE ±2 · TUNE ±50¢', 'WIDTH 50–95% (square)', '~FM and RING source'] });
  mk('osc2', { x: OX, y: 500, w: OW, h: 172, cat: 'voice', title: 'OSC 2', icon: 'waves4', iconW: 200, iconH: 40, tag: 'sync worklet',
    lines: ['OCTAVE ±2 · TUNE ±50¢ · WIDTH', 'SYNC off · HARD · SOFT', 'SYNC PITCH 0–48 st'] });
  mk('sub', { x: OX, y: 700, w: OW, h: 72, cat: 'voice', title: 'SUB', lines: ['−1 or −2 octaves · 4 waves'] });
  mk('noise', { x: OX, y: 800, w: OW, h: 118, cat: 'voice', title: 'NOISE', icon: 'noise', iconH: 36,
    lines: ['white · one shared loop'] });
  mk('mixer', { x: 2710, y: 300, w: 140, h: 618, cat: 'voice', title: 'MIXER',
    marks: [{ y: oy(B.osc1), t: 'OSC 1' }, { y: RING.y, t: 'RING' }, { y: oy(B.osc2), t: 'OSC 2' }, { y: oy(B.sub), t: 'SUB' }, { y: oy(B.noise), t: 'NOISE' }] });
  mk('filter', { x: 2900, y: 470, w: 250, h: 300, cat: 'voice', title: 'FILTER', icon: 'filter', iconH: 44, tag: 'worklet',
    lines: ['**GROWL', '4-pole low-pass · self-oscillates', '**SCREAM  (SHAPE morphs)', 'LP24 → LP12 → BP12 → HP24', 'CUTOFF as a MIDI note · RES', 'DRIVE · KEYTRACK · VEL AMT'] });
  mk('spread', { x: 3480, y: 545, w: 180, h: 150, cat: 'voice', title: 'SPREAD',
    lines: ['per-track PAN', '~wired in only while', '~a track is off centre'], badge: '→ STEREO' });
  mk('fenv', { x: 2950, y: 822, w: 200, cat: 'mod', title: 'FILTER ENV', icon: 'adsr', iconH: 36,
    lines: ['A · D · S · R'], pills: [['G', 'GATE · VEL', 'note']] });
  mk('aenv', { x: 3290, y: 752, w: 220, cat: 'mod', title: 'AMP ENV', icon: 'adsr', iconH: 36,
    lines: ['peak = velocity'], pills: [['G', 'GATE · VEL', 'note']] });

  // Modulation row, below the MOD BUS.
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
}

// Eight tiles down the tile column: one per drum track or sampler slot,
// registered as `${prefix}0` … `${prefix}7`.
function tiles({ P, L, B, st, useIcon, edgeStrip }, prefix, y0, list, cat, sub) {
  list.forEach(([ic, name], i) => {
    const b = { x: TX, y: y0 + i * 84, w: TWD, h: 70 };
    B[`${prefix}${i}`] = b;
    const c = P.cat[cat];
    L.blocks.push(`<g><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="9" ${st('blk')}/>${edgeStrip(b.x, b.y, 5, b.h, 9, c, true)}`
      + useIcon(ic, b.x + 14, b.y + 11, 56, 48, c)
      + `<text x="${b.x + 84}" y="${b.y + 30}" ${st('bt')}>${esc(name)}</text><text x="${b.x + 84}" y="${b.y + 51}" ${st('bl')}>${esc(sub)}</text></g>`);
  });
}

// A channel strip (×8) frame, registered as `id`, its cells as `${id}0` …
// spread evenly across it; returns the cells.
function strip({ P, L, B, mk, st, frame }, id, y, title, cells, cat) {
  const fr = { x: 2170, y: y - 48 - 85, w: 1490, h: 48 + 170 + 22 };
  B[id] = fr;
  frame(fr, P.cat[cat], 2, '10 7', 14);
  L.over.push(`<text x="${fr.x + 18}" y="${fr.y + 30}" ${st('frt')} fill="${P.cat[cat]}">${esc(title)}</text>`);
  const gap = 54;
  const cw = (fr.w - 40 - gap * (cells.length - 1)) / cells.length;
  return cells.map((cell, i) => mk(`${id}${i}`, { x: fr.x + 20 + i * (cw + gap), y: fr.y + 48, w: cw, h: 170, cat, ...cell }));
}

// ── 3 · DRUMS ─────────────────────────────────────────────────────────────
function drawDrums(c) {
  c.mk('drums', { x: MX, y: 1760, w: MW, cat: 'drum', title: 'DRUM MACHINE', icon: 'drum', iconH: 46,
    lines: ['8 TRACKS × 16 steps · banks A–P', '13 synthesized models · 7 kits', 'VEL · GATE · PROB · RATCHET · MICRO', 'CHOKE: closed hat cuts the open hat', 'FILL from LIVE FX'] });
  tiles(c, 'dt', 1730, [['kick', 'KICK'], ['snare', 'SNARE'], ['hatc', 'CLOSED HAT'], ['hato', 'OPEN HAT'], ['tom', 'LOW TOM'], ['tom', 'MID TOM'], ['tom', 'HIGH TOM'], ['clap', 'CLAP']],
    'drum', 'TUNE ±24 st · DECAY · model');
  strip(c, 'dstrip', 1922 + 118, 'CHANNEL  ×8 — one per drum track  ·  lane MUTE / SOLO gates the pattern here, never an audition', [
    { title: 'DRIVE', icon: 'dirt', iconH: 40, tag: 'tanh', lines: ['soft saturation', '~2× oversampled when driven'] },
    { title: 'TONE', icon: 'filter', iconH: 40, lines: ['low-pass', 'darkens the hit'] },
    { title: 'LEVEL', icon: 'fader', iconH: 40, lines: ['VOL per track', 'MUTE per track'] },
    { title: 'PAN', icon: 'pan', iconH: 40, lines: ['stereo position'], badge: '→ STEREO' },
  ], 'drum');
}

// ── 3 · SAMPLER ───────────────────────────────────────────────────────────
function drawSampler(c) {
  c.mk('sampler', { x: MX, y: 2540, w: MW, cat: 'sampler', title: 'SAMPLER', icon: 'pads', iconH: 46,
    lines: ['8 SLOTS × 16 steps · banks A–P', 'MIDI channel 10 · notes 36–43', 'up to 16 voices per slot', 'CHOKE groups 1–4 · POLY or MONO'] });
  tiles(c, 'st', 2520, Array.from({ length: 8 }, (_, i) => ['wavesm', `SLOT S${i + 1}`]), 'sampler', 'one-shot buffer');
  strip(c, 'sstrip', 2712 + 118, 'CHANNEL  ×8 — one per slot  ·  lane MUTE / SOLO gates the pattern here, never an audition or a pad', [
    { title: 'PLAY WINDOW', icon: 'wavesm', iconW: 56, iconH: 40, lines: ['PITCH ±24 st (speed)', 'START · END · REVERSE'] },
    { title: 'HIT ENV', icon: 'adsr', iconH: 40, lines: ['ATTACK · DECAY', 'choke cuts it short'] },
    { title: 'TONE', icon: 'filter', iconH: 40, lines: ['low-pass + RES'] },
    { title: 'LEVEL', icon: 'fader', iconH: 40, lines: ['VOL · MUTE'] },
    { title: 'PAN', icon: 'pan', iconH: 40, lines: ['stereo position'], badge: '→ STEREO' },
  ], 'sampler');
}

// ── 4 · FX RACK ───────────────────────────────────────────────────────────
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

function drawRack({ P, L, mk, st }) {
  COLS.forEach((t, i) => {
    L.regions.push(`<path d="M${CX(i) + CW / 2} 486 V3230" stroke="${P.guide}" stroke-width="1.5" stroke-dasharray="3 7"/>`);
    L.regions.push(`<text x="${CX(i) + CW / 2}" y="474" text-anchor="middle" ${st('colh')}>${esc(t)}</text>`);
  });
  for (const row of ROWS) {
    row.cells.forEach((k, i) => {
      if (k) {
        // Only the synth row turns stereo inside the rack; drums and sampler already are.
        mk(`${row.id}-${k}`, { x: CX(i), y: row.y, w: CW, h: RH, cat: 'fx', iconH: 34, ...FX[k],
          badge: row.id === 'syn' ? FX[k].badge : undefined });
      } else {
        L.regions.push(`<rect x="${CX(i) + 10}" y="${row.y + 40}" width="${CW - 20}" height="${RH - 80}" rx="10" fill="none" stroke="${P.guide}" stroke-width="1.6" stroke-dasharray="5 6"/>`);
        L.over.push(`<text x="${CX(i) + CW / 2}" y="${row.y + RH - 50}" text-anchor="middle" ${st('blf')}>not on this bus</text>`);
      }
    });
  }
}

// ── 5 · MASTER ────────────────────────────────────────────────────────────
function drawMaster({ mk }) {
  mk('dj', { x: 5862, y: MY - 110, w: 200, h: 220, cat: 'master', title: 'DJ FILTER', icon: 'dj', iconH: 40,
    lines: ['LOW-PASS → HIGH-PASS', 'DJ FLT ±1 sweeps one', 'DROP: LP dives to 160 Hz'], pills: [['B', 'from LIVE FX', 'auto']] });
  mk('mcomp', { x: 6097, y: MY - 110, w: 210, h: 220, cat: 'master', title: 'MASTER COMP', icon: 'comp', iconH: 40, tag: 'VCA',
    lines: ['SSL-style bus compressor', 'THRESHOLD −40 – 0 dB', 'RATIO 2 · 4 · 10', 'ATTACK 0.1–30 ms', 'RELEASE / AUTO · MAKEUP'] });
  mk('vol', { x: 6342, y: MY - 110, w: 180, h: 220, cat: 'master', title: 'MASTER VOL', icon: 'fader', iconH: 40,
    lines: ['VOLUME² × EXPRESSION²', 'MIDI CC7 · CC11', '~fades in at start-up'] });
  mk('mlimit', { x: 6557, y: MY - 110, w: 180, h: 220, cat: 'master', title: 'LIMITER', icon: 'limit', iconH: 40, tag: 'ON',
    lines: ['lookahead brickwall', 'DRIVE 0 – +12 dB', 'CEILING −6 – 0 dB', '~holds the output under it'] });
  mk('scope', { x: 6195, y: 1270, w: 260, cat: 'master', title: 'SCOPE', icon: 'scope', iconH: 40,
    lines: ['L / R analysers', 'before the master volume'] });
  mk('direct', { x: 6620, y: 1200, w: 280, cat: 'master', title: 'DIRECT OUT',
    lines: ['straight to the output:', 'no FX, no master, not exported'],
    pills: [['D', 'METRONOME click', 'audio'], ['D', 'CLIP PREVIEW (studio)', 'audio']] });
  mk('export', { x: 6560, y: 1930, w: 300, cat: 'master', title: 'RECORD / EXPORT', icon: 'record', iconH: 40,
    lines: ['WAV · MP3', 'SONG EXPORT · 1–10 passes', 'manual takes'] });
}

// ═════════════════════════════════════════════════════════════════ wires ══

// ── PLAY → NOTES & TIME, through the corridor between them ────────────────
const XO = 545; // bend / mod (cv)
const XP = 562; // automation
const XN = 580; // notes
const XC = 596; // channel 10 notes
const XS = 610; // clock / sync

function wirePlay({ B, wire, pill, L }) {
  const keyIn = B.key.y + 80;
  wire('note', [R(B.kbd, keyIn - B.kbd.y), Lf(B.key, keyIn - B.key.y)], { label: 'NOTES', at: [XN - 40, keyIn - 16] });
  wire('note', [Rl(B.qwerty, 0), [XN, lineY(B.qwerty, 0)], [XN, keyIn]], MEET);
  wire('note', [Rl(B.midi, 0), [XN, lineY(B.midi, 0)], [XN, B.qwerty.y + 100]], MEET);
  // bend / mod
  const bendY = 1666;
  wire('cv', [Rl(B.qwerty, 2), [XO, lineY(B.qwerty, 2)], [XO, bendY], [Bt(B.perf)[0], bendY], Bt(B.perf)],
    { label: 'PITCH BEND · MOD WHEEL', at: [1000, bendY] });
  wire('cv', [Rl(B.midi, 1), [XO, lineY(B.midi, 1)]], JOIN);
  wire('cv', [R(B.wheels), [XO, oy(B.wheels)]], JOIN);
  // automation → parameter bus
  const parIn = B.params.y + 70;
  wire('auto', [Rl(B.midi, 2), [XP, lineY(B.midi, 2)], [XP, parIn], Lf(B.params, 70)], { label: 'CC', at: [XP - 3, lineY(B.midi, 2) + 60] });
  wire('auto', [Rl(B.midi, 3), [XP, lineY(B.midi, 3)]], JOIN);
  wire('auto', [R(B.xy), [XP, oy(B.xy)]], JOIN);
  wire('auto', [R(B.livefx, 70), [XP, B.livefx.y + 70]], JOIN);
  // clock / sync in
  const syncIn = B.sync.y + 70;
  wire('clock', [Rl(B.midi, 5), [XS, lineY(B.midi, 5)], [XS, syncIn], Lf(B.sync, 70)], { label: 'CLOCK', at: [XS - 2, syncIn + 40] });
  wire('clock', [R(B.wifi), [XS, oy(B.wifi)], [XS, syncIn + 20]], MEET);
  // channel 10 → sampler
  wire('note', [Rl(B.midi, 4), [XC, lineY(B.midi, 4)], [XC, 2560], Lf(B.sampler, 20)],
    { label: 'MIDI CH 10 → SLOTS', at: [900, 2560] });
  // mic / file → studio, slots
  wire('audio', [R(B.mic), [B.studio.x, oy(B.mic)]], { label: 'MIC', at: [575, oy(B.mic) - 16] });
  const bufY = 3214;
  wire('buf', [Bt(B.studio), [Bt(B.studio)[0], bufY], [1950, bufY], [1950, B.st7.y + B.st7.h]], { label: 'WRITE A SLOT', at: [1500, bufY] });
  wire('buf', [Bt(B.file), [Bt(B.file)[0], bufY], [Bt(B.studio)[0] - 4, bufY]], { ...JOIN, label: 'LOAD', at: [440, bufY] });
  wire('buf', [[2010, bufY], [1950, bufY]], { arrow: false, dot1: true, h0: 0 });
  L.over.push(pill(2010, bufY, 'R', 'RENDER: the synth after its FX', 'buf').svg);
}

// ── NOTES & TIME → the machines; the clock bus ────────────────────────────
function wireNotes({ B, wire }) {
  wire('note', [Bt(B.key, 255), T(B.arp, 255)], { label: 'chord-expanded', at: [NX + 270, (B.key.y + B.key.h + B.arp.y) / 2], anchor: 'start' });
  // live passthrough → polyphony
  const pLive = B.poly.y + 60;
  const pArp = B.poly.y + 170;
  const pSeq = B.poly.y + 280;
  wire('note', [R(B.key, pLive - B.key.y), Lf(B.poly, 60)], { label: 'LIVE  (muted while ARP is on)', at: [1470, pLive] });
  wire('note', [R(B.arp), [1180, oy(B.arp)], [1180, pArp], Lf(B.poly, 170)], { label: 'ARP', at: [1470, pArp] });
  wire('note', [R(B.seq, pSeq - B.seq.y), Lf(B.poly, 280)], { label: 'SEQ', at: [1768, pSeq - 16] });
  // clock bus
  const XK = 1200;
  const kEnd = B.sampler.y + 120;
  wire('clock', [R(B.clock), [XK, oy(B.clock)], [XK, kEnd], Lf(B.sampler, 120)], { label: 'CLOCK · BANK', at: [XK, 1440] });
  for (const [b, dy] of [[B.seq, 140], [B.motion, 60], [B.drums, 80]]) wire('clock', [[XK, b.y + dy], Lf(b, dy)], { from: 'bus' });
  wire('clock', [[XK, oy(B.metro)], R(B.metro)], { from: 'bus' });
  wire('clock', [R(B.arrange), [XK, oy(B.arrange)]], { arrow: false, dot1: true });
  wire('clock', [T(B.clock, 255), Bt(B.arp, 255)], { label: '16ths', at: [NX + 300, (B.arp.y + B.arp.h + B.clock.y) / 2], anchor: 'start' });
  wire('clock', [T(B.sync, 255), Bt(B.clock, 255)], { label: 'TEMPO · POSITION', at: [NX + 300, (B.clock.y + B.clock.h + B.sync.y) / 2], anchor: 'start' });
  // motion → parameter bus
  wire('auto', [Bt(B.motion, 120), [MX + 120, B.params.y + 120], R(B.params, 120)], { label: 'AUTOMATION', at: [MX + 120, B.motion.y + B.motion.h + 70] });
}

// ── the synth voice, its modulation, and the voice bus ────────────────────
function wireVoice({ P, L, B, wire, label, note, sum, st }) {
  // Polyphony → voice
  wire('note', [R(B.poly, 60), Lf(B.pitch, 60)], { label: 'NOTE', at: [2140, B.poly.y + 44] });
  // seq track pan → spread
  const tpY = 280;
  wire('cv', [R(B.seq, 40), [1768, B.seq.y + 40], [1768, tpY], [3570, tpY], T(B.spread, 90)], { label: 'TRACK PAN t1–t4', at: [3000, tpY] });

  // Voice audio
  const ox = OX + OW;
  for (const b of [B.osc1, B.osc2, B.sub]) wire('cv', [[B.pitch.x + B.pitch.w, oy(b)], [OX, oy(b)]]);
  for (const b of [B.osc1, B.osc2, B.sub, B.noise]) wire('audio', [[ox, oy(b)], [B.mixer.x, oy(b)]]);
  wire('audio', [[RING.x, oy(B.osc1)], [RING.x, RING.y - RING.r]], { from: 'bus' });
  wire('audio', [[RING.x, oy(B.osc2)], [RING.x, RING.y + RING.r]], { from: 'bus' });
  wire('audio', [[RING.x + RING.r, RING.y], [B.mixer.x, RING.y]]);
  sum(RING.x, RING.y, RING.r, '×', P.wire.audio);
  // FM / SYNC between the oscillators
  const between = (B.osc1.y + B.osc1.h + B.osc2.y) / 2;
  wire('cv', [[OX + 70, B.osc1.y + B.osc1.h], [OX + 70, B.osc2.y]], { label: 'FM', at: [OX + 104, between] });
  wire('cv', [[OX + 180, B.osc1.y + B.osc1.h], [OX + 180, B.osc2.y]], { label: 'SYNC', at: [OX + 220, between] });
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
  wire('cv', [[B.pitch.x + 60, BUSY], [PAN_X, BUSY]], { arrow: false, h1: 0, h0: 0 });
  label(3400, BUSY, 'MOD BUS', 'cv');
  wire('cv', [T(B.route, 180), [B.route.x + 180, BUSY]], { arrow: false, dot1: true, label: 'every destination', at: [B.route.x + 270, BUSY + 23] });
  wire('cv', [[B.pitch.x + 60, BUSY], [B.pitch.x + 60, B.pitch.y + B.pitch.h]], { from: 'bus', h0: 0 });
  wire('cv', [[RAIL, BUSY], [RAIL, B.osc1.y + 125], [OX + OW, B.osc1.y + 125]], { from: 'bus' });
  wire('cv', [[RAIL, B.osc2.y + 140], [OX + OW, B.osc2.y + 140]], { from: 'bus' });
  label(RAIL + 2, B.osc2.y + 160, 'WIDTH · FM · SYNC', 'cv', 'end');
  wire('cv', [[2920, BUSY], [2920, B.filter.y + B.filter.h]], { from: 'bus' });
  label(2920, 1012, 'CUTOFF · RES · DRIVE · SHAPE', 'cv', 'end');
  wire('cv', [[AMOD.x, BUSY], [AMOD.x, AMOD.y + AMOD.r]], { from: 'bus', label: 'AMP', at: [AMOD.x, 990] });
  wire('cv', [[PAN_X, BUSY], [PAN_X, ROWS[0].y + RH]], { h0: 0, label: 'PAN', at: [PAN_X, 900] });
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
  wire('audio', [R(B.spread, 75), [VB.x - VB.r, 620]], { label: '×8 voices', at: [3712, 590] });
  sum(VB.x, VB.y, VB.r, 'Σ', P.wire.audio, ['VOICE BUS', 'SEQ MASTER']);
}

// ── drum machine and sampler: trigger fan-out, channel strips, buses ──────
const tileYs = (B, prefix) => Array.from({ length: 8 }, (_, i) => oy(B[`${prefix}${i}`]));

function wireDrumsAndSampler({ P, B, wire, sum }) {
  // A machine's triggers fanned out to its eight tiles, through a bar at xBar.
  const fan = (src, prefix, xBar, label0) => {
    const ys = tileYs(B, prefix);
    const srcY = Math.min(Math.max(src.y + 70, ys[0]), ys[7]);
    wire('note', [R(src, srcY - src.y), [xBar, srcY]], { arrow: false, dot1: true, label: label0, at: [xBar - 2, srcY - 16], anchor: 'end' });
    wire('note', [[xBar, ys[0]], [xBar, ys[7]]], { arrow: false, h0: 0, h1: 0 });
    ys.forEach((y) => wire('note', [[xBar, y], [TX, y]], { from: 'bus', h0: 6 }));
  };
  // The eight tiles' outputs merged through a bar at xBar into a strip frame.
  const merge = (prefix, fr, xBar, type) => {
    const ys = tileYs(B, prefix);
    ys.forEach((y) => wire(type, [[TX + TWD, y], [xBar, y]], MEET));
    wire(type, [[xBar, ys[0]], [xBar, ys[7]]], { arrow: false, h0: 0, h1: 0 });
    wire(type, [[xBar, fr.y + fr.h / 2], [fr.x, fr.y + fr.h / 2]], { from: 'bus', h0: 6 });
  };
  // A strip's cells chained left to right, then out (stereo) to its bus.
  const chain = (id, count, bus) => {
    const cells = Array.from({ length: count }, (_, i) => B[`${id}${i}`]);
    const ymid = cells[0].y + 85;
    cells.forEach((cell, i) => { if (i) wire('audio', [[cells[i - 1].x + cells[i - 1].w, ymid], [cell.x, ymid]]); });
    const last = cells.at(-1);
    const fr = B[id];
    wire('stereo', [[last.x + last.w, ymid], [fr.x + fr.w + 30, ymid], [fr.x + fr.w + 30, bus.y], [bus.x - bus.r, bus.y]]);
  };

  // Drums
  wire('trig', [T(B.drums, 230), [B.drums.x + 230, 1680], [DUCK_X, 1680], [DUCK_X, ROWS[0].y + RH]], { label: 'DRUM HITS — scheduled, no audio sidechain', at: [3200, 1680] });
  wire('trig', [[DUCK_X, 1680], [DUCK_X, ROWS[2].y]], { from: 'bus' });
  fan(B.drums, 'dt', 1768, 'TRIG');
  merge('dt', B.dstrip, 2136, 'audio');
  chain('dstrip', 4, DB);
  sum(DB.x, DB.y, DB.r, 'Σ', P.wire.audio, ['DRUM BUS', 'MASTER volume']);

  // Sampler
  fan(B.sampler, 'st', 1768, 'TRIG');
  merge('st', B.sstrip, 2136, 'audio');
  chain('sstrip', 5, SB);
  sum(SB.x, SB.y, SB.r, 'Σ', P.wire.audio, ['SAMPLER BUS', 'MASTER volume']);
}

// ── the rack rows, the master chain, the speakers ─────────────────────────
function wireRackAndMaster({ P, L, B, wire, note, sum, pill, st, useIcon }) {
  // A bus through the effects its row has, skipping the empty slots; returns
  // the x where the row's last effect lets go.
  const rowWire = (row, startX, ymid, typeOf) => {
    let prevX = startX;
    for (const k of row.cells) {
      if (!k) continue;
      const b = B[`${row.id}-${k}`];
      wire(typeOf(k), [[prevX, ymid], [b.x, ymid]]);
      prevX = b.x + b.w;
    }
    return prevX;
  };
  const synOut = rowWire(ROWS[0], VB.x + VB.r, VB.y, (k) => (['duck', 'pan'].includes(k) ? 'stereo' : 'audio'));
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
  wire('stereo', [[B.vol.x + B.vol.w, MY], [B.mlimit.x, MY]]);
  wire('stereo', [[B.scope.x + B.scope.w / 2, MY], [B.scope.x + B.scope.w / 2, B.scope.y + B.scope.h]], { from: 'bus', h0: 10, label: 'TAP', at: [B.scope.x + B.scope.w / 2 + 34, MY - 170] });
  wire('stereo', [[B.mlimit.x + B.mlimit.w, MY], [DEST.x - DEST.r, MY]]);
  wire('stereo', [[6752, MY], [6752, B.export.y]], { from: 'bus', h0: 10, label: 'TAP', at: [6788, MY + 110] });
  wire('stereo', [[DEST.x, B.direct.y + B.direct.h], [DEST.x, DEST.y - DEST.r]]);
  sum(DEST.x, DEST.y, DEST.r, 'Σ', P.wire.audio, []);
  note(DEST.x + 6, DEST.y + DEST.r + 20, 'OUTPUT', 'sn', 'start');
  // L / R
  const spl = 6872;
  wire('audio', [[DEST.x + DEST.r, MY], [spl, MY], [spl, SPK.L + SPK.s / 2], [SPK.x, SPK.L + SPK.s / 2]]);
  wire('audio', [[spl, MY], [spl, SPK.R + SPK.s / 2], [SPK.x, SPK.R + SPK.s / 2]], { from: 'bus' });
  for (const [ch, y] of [['L', SPK.L], ['R', SPK.R]]) {
    L.blocks.push(useIcon('speaker', SPK.x, y, SPK.s, SPK.s, P.cat.master));
    L.over.push(`<text x="${SPK.x + SPK.s + 40}" y="${y + SPK.s / 2 + 18}" ${st('lr')}>${ch}</text>`);
  }
  L.over.push(`<text x="${SPK.x - 10}" y="${SPK.R + SPK.s + 52}" ${st('out')}>STEREO OUT</text>`);
  L.over.push(`<text x="${SPK.x - 10}" y="${SPK.R + SPK.s + 78}" ${st('nt')}>speakers · headphones · audio interface</text>`);
}

// ═══════════════════════════════════════════════════════════ cards, header ══

function drawCards({ card }) {
  const inserts = card({ x: 3880, y: 1110, w: 1450 }, 'HOW THE INSERT CHAINS WORK', [
    '**Every bus has its own chain, in a fixed order, read left to right.',
    'Each effect sits on a dry/wet crossfade; a bypassed effect is disconnected, so it costs nothing.',
    'EQ heads every chain (off by default): it shapes what DIRT drives and what the drum COMP hears.',
    'Only the SYNTH has WAH and SYNTH PAN · only the DRUMS have a COMP · the DRUMS are never ducked.',
    'DUCK listens to no audio: each drum hit schedules its dip at the moment the hit will sound.',
    'DELAY and the FX rates can lock to the tempo (SYNC); DELAY TYPE swaps the whole echo engine.',
  ], 'fx');
  const stereo = card({ x: 5860, y: 300, w: 1370 }, 'WHERE THE SIGNAL TURNS STEREO', [
    '**The synth voice is mono from oscillator to VCA — eight voices sum to one channel.',
    'SPREAD makes it stereo only while a sequencer track is panned off centre.',
    'CHORUS (while on), DELAY in PING PONG and REVERB each add a second channel.',
    'SYNTH PAN always hands the master two channels, so the level never jumps.',
    'Drums and sampler are stereo from each channel\'s PAN onward.',
    '**Single blue line = mono · double blue line = stereo.',
  ], 'master');
  const offpath = card({ x: 5860, y: 2330, w: 1370 }, 'NOT ON THE AUDIO PATH', [
    '**TAPE STOP ramps the tempo to 20 BPM and bends the synth down — automation, not an effect.',
    'STUTTER re-maps which step every machine plays; FILL swaps in a drum fill.',
    'The MICROPHONE only reaches the sample studio — it is never monitored.',
    'RENDER TO SAMPLER records the synth after its FX into a sampler slot.',
    'RECORD / EXPORT taps after the LIMITER, so a take is what you heard.',
    'SCOPE reads the signal before MASTER VOL, so it does not shrink with the volume.',
  ], 'master');
  return { inserts, stereo, offpath };
}

// The header's wire key leaves out VELOCITY; the legend shows every type.
const KEY_TYPES = Object.keys(WIRE_TYPES).filter((t) => t !== 'vel');

function drawHeader({ L, st, keySample }, version) {
  const hdr = L.header;
  // The name as the faceplate sets it: VAST heavy, the model number light.
  hdr.push(`<text x="40" y="104" ${st('h1')}>VAST<tspan font-weight="400"> G1-J8</tspan></text>`);
  hdr.push(`<text x="640" y="104" ${st('h2')}>WEBSYNTH · SIGNAL FLOW</text>`);
  hdr.push(`<text x="42" y="150" ${st('h3')}>Every path from a key press to the speakers: notes and clock, the machines, eight synth voices, the drum machine and sampler, three insert chains and the master section.</text>`);
  hdr.push(`<text x="42" y="182" ${st('h4')}>Read left to right. The colour and line of a wire say what travels on it; a lettered tag (Ⓐ…) continues the wire at the tag with the same letter.</text>`);
  hdr.push(`<text x="${W - 40}" y="66" text-anchor="end" ${st('ver')}>v${esc(version)}</text>`);
  // compact wire key, top right: two rows of four
  KEY_TYPES.forEach((t, i) => hdr.push(keySample(4520 + (i % 4) * 680, 114 + Math.floor(i / 4) * 46, t)));
}

// ═════════════════════════════════════════════════════════════════ legend ══

function drawLegend({ P, L, st, keySample, badge, pill, edgeStrip }, version) {
  const lg = L.legend;
  lg.push(`<rect x="${LG.x}" y="${LG.y}" width="${LG.w}" height="${LG.h}" rx="20" fill="${P.region}" stroke="${P.regionEdge}" stroke-width="2"/>`);
  lg.push(`<text x="${LG.x + 30}" y="${LG.y + 48}" ${st('rt')}>LEGEND</text>`);

  // wires
  lg.push(`<text x="${LG.x + 30}" y="${LG.y + 86}" ${st('lgh')}>WIRES — what travels on them</text>`);
  Object.keys(WIRE_TYPES).forEach((t, i) => lg.push(keySample(...legendCell(i, LG.x + 30, 560), t)));

  // symbols
  lg.push(`<text x="${SX}" y="${LG.y + 86}" ${st('lgh')}>SYMBOLS</text>`);
  const sym = (i, draw, text) => {
    const [x, y] = legendCell(i, SX, 560);
    lg.push(draw(x + 24, y));
    lg.push(`<text x="${x + 66}" y="${y + 5}" ${st('kt')}>${esc(text)}</text>`);
  };
  const c = P.wire.audio;
  sym(0, (x, y) => `<circle cx="${x}" cy="${y}" r="18" fill="${P.panel}" stroke="${c}" stroke-width="2.4"/><text x="${x}" y="${y + 7}" text-anchor="middle" ${st('sig')} font-size="20" fill="${c}">Σ</text>`, 'SUM / BUS — signals add up');
  sym(1, (x, y) => `<circle cx="${x}" cy="${y}" r="18" fill="${P.panel}" stroke="${c}" stroke-width="2.4"/><path d="M${x - 8} ${y - 8} L${x + 8} ${y + 8} M${x + 8} ${y - 8} L${x - 8} ${y + 8}" stroke="${c}" stroke-width="2.4"/>`, 'MULTIPLY — ring mod, gain modulation');
  sym(2, (x, y) => `<path d="M${x - 18} ${y - 18} L${x + 20} ${y} L${x - 18} ${y + 18} Z" fill="${P.panel}" stroke="${P.cat.voice}" stroke-width="2.4"/>`, 'VCA — amplifier opened by the envelope');
  sym(3, (x, y) => `<circle cx="${x}" cy="${y}" r="6" fill="${P.wire.cv}"/><path d="M${x - 24} ${y} H${x + 24}" stroke="${P.wire.cv}" stroke-width="2.6"/>`, 'JUNCTION — the wire splits here');
  sym(4, (x, y) => `<rect x="${x - 22}" y="${y - 14}" width="44" height="28" rx="6" fill="none" stroke="${P.guide}" stroke-width="1.6" stroke-dasharray="5 6"/>`, 'EMPTY SLOT — effect not on this bus');
  sym(5, (x, y) => badge(x + 10, y, '→ STEREO'), 'the signal becomes two channels here');
  sym(6, (x, y) => pill(x - 22, y, 'A', '', 'cv').svg, 'TAG — the wire continues at the same letter');
  sym(7, (x, y) => `<rect x="${x - 24}" y="${y - 16}" width="48" height="32" rx="10" fill="none" stroke="${P.cat.voice}" stroke-width="2" stroke-dasharray="9 6"/>`, 'FRAME — everything inside repeats per voice / track');
  sym(8, (x, y) => `<rect x="${x - 24}" y="${y - 16}" width="48" height="32" rx="6" ${st('blk')}/>${edgeStrip(x - 24, y - 16, 5, 32, 6, P.cat.fx, true)}`, 'BLOCK — colour strip shows its section');

  // section colours
  lg.push(`<text x="${CXS}" y="${LG.y + 86}" ${st('lgh')}>SECTIONS</text>`);
  [['input', 'PLAY'], ['time', 'NOTES & TIME'], ['machine', 'SEQUENCERS'], ['voice', 'SYNTH VOICE'], ['mod', 'MODULATION'], ['drum', 'DRUMS'], ['sampler', 'SAMPLER'], ['fx', 'EFFECTS'], ['master', 'MASTER']].forEach(([k, t], i) => {
    const [x, y] = legendCell(i, CXS, 250);
    lg.push(`<rect x="${x}" y="${y - 12}" width="34" height="24" rx="5" fill="${P.cat[k]}"/><text x="${x + 46}" y="${y + 5}" ${st('kt')}>${esc(t)}</text>`);
  });
  lg.push(`<text x="${LG.x + 30}" y="${LG.y + LG.h - 28}" ${st('ft')}>Generated by scripts/diagram/signal-flow.mjs (npm run docs:diagram) from the v${esc(version)} engine. Source of truth: specs/architecture.md → "Audio graph".</text>`);
}

// ══════════════════════════════════════════════════════════════════ zones ══
// The top-level zones and the machine bands were registered as they were drawn
// (region / band); these are the leaves, from the same layout values.

function defineZones({ B, zones: { zone, around, checkTour } }, cards) {
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
  zone('fx-inserts', 'fx', around([cards.inserts]));
  zone('fx-drum', 'fx', rackRow(ROWS[1]));
  zone('fx-sampler', 'fx', rackRow(ROWS[2]));
  zone('master-chain', 'master', around([{ x: PRE.x - 110, y: PRE.y - PRE.r, w: 110 + PRE.r, h: 2 * PRE.r }, 'dj', 'mcomp', 'vol', 'mlimit', 'scope', 'direct', 'export',
    { x: SPK.x - 10, y: SPK.L, w: 7250 - SPK.x, h: SPK.R + SPK.s + 90 - SPK.L }]));
  zone('master-stereo', 'master', around([cards.stereo]));
  zone('master-offpath', 'master', around([cards.offpath]));
  zone('legend', null, LG);
  zone('legend-wires', 'legend', { x: LG.x, y: LG.y, w: SX - 40 - LG.x, h: LG.h });
  zone('legend-symbols', 'legend', { x: SX - 30, y: LG.y, w: CXS - SX, h: LG.h });
  zone('legend-sections', 'legend', { x: CXS - 30, y: LG.y, w: 3 * 250 + 90, h: LG.h });
  checkTour();
}

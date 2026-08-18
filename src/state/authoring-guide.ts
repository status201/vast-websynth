/**
 * The song-authoring guide + AI prompt builder. The guide documents the
 * compact authoring dialect (`websynth-song-author`, the recommended output
 * for AI agents — see specs/features/song-authoring-dialect.md) with the full
 * canonical format as an appendix, and embeds the live PARAMS table generated
 * from `ParamBus` so it can never drift from `registerDefaults()`.
 *
 * Pure and importable anywhere: only `params.ts` + `patterns.ts` + the
 * import-free `song-version.ts` (plus the equally pure
 * `preset-session`/`preset-validate` for the preset guide) — **never**
 * `song.ts`, whose `import.meta.glob` demo registration would poison
 * the MCP server's Node bundle. The ✨ AI Prompt modal
 * (`ui/components/ai-prompt.ts`) and the MCP server's `get_song_format` /
 * `get_preset_format` tools all serve this text.
 *
 * Every canonical `"version"` here interpolates `SONG_VERSION` — a literal in
 * this file is read by agents and drifts silently (the EXAMPLE SHAPE below sat
 * at 4 while the shape above it said 6). `tests/state/authoring-docs.test.ts`
 * now fails on any canonical example that names a different version.
 */
import type { ParamBus } from './params';
import { DRUM_TRACK_LABELS } from './params';
import { isPatchParam } from './preset-session';
import { PRESET_FORMAT, BANK_FORMAT } from './preset-validate';
import { SONG_VERSION } from './song-version';
import { MAX_CHAIN_TRANSPOSE } from './limits';
import {
  SEQ_LENGTH,
  SEQ_TRACK_COUNT,
  BANK_COUNT,
  BANK_LABELS,
  DRUM_TRACK_COUNT,
  SAMPLER_SLOT_COUNT,
} from './patterns';

/** Stand-in for the SONG REQUEST section when the user typed no brief. */
export const REQUEST_PLACEHOLDER =
  '[Describe the song you want — style, length, mood, structure, references…]';

/**
 * Resolve the origin the schema URLs are cited from. Explicit `origin` wins
 * (the MCP server passes one); otherwise the live `window.location.origin`,
 * guarded so the module stays safe to import outside a browser.
 */
function resolveOrigin(origin?: string): string {
  if (origin !== undefined) return origin;
  return typeof window !== 'undefined' && window.location ? window.location.origin : '';
}

/**
 * The live PARAMS table: one line per registered param with its range, default
 * and discrete value map. Generated from the bus so it can never drift from
 * `registerDefaults()`. `filter` narrows it — the preset guide passes
 * `isPatchParam` so a sound's table lists only the sound's parameters.
 */
export function paramTable(bus: ParamBus, filter?: (id: string) => boolean): string {
  return bus
    .ids()
    .filter((id) => (filter ? filter(id) : true))
    .map((id) => {
      const d = bus.def(id);
      if (!d) return `- "${id}"`;
      const range = `${d.min}..${d.max}`;
      const parts = [`range ${range}`, `default ${d.default}`];
      if (d.step !== undefined) parts.push(`step ${d.step}`);
      if (d.labels && d.labels.length) {
        parts.push(`values ${d.labels.map((l, i) => `${i}=${l}`).join(' ')}`);
      }
      return `- "${id}": number  // ${parts.join(', ')}`;
    })
    .join('\n');
}

/**
 * The format guide: OUTPUT RULES → QUICKSTART → the compact author format →
 * NOTES → live PARAMS table → the canonical full form as an appendix.
 */
export function buildAuthoringGuide(bus: ParamBus, origin?: string): string {
  const o = resolveOrigin(origin);
  const authorSchemaUrl = `${o}/schema/websynth-song-author.schema.json`;
  const schemaUrl = `${o}/schema/websynth-song.schema.json`;

  const params = paramTable(bus);

  const drumTracks = DRUM_TRACK_LABELS.map((l, i) => `${i}=${l}`).join(', ');

  return `OUTPUT RULES
- Respond with exactly ONE JSON object and nothing else — no markdown fences, no commentary, no questions.
- Use the COMPACT AUTHOR FORMAT below ("websynth-song-author"). A complete song is under ~80 lines — this is a short task; never bail out or summarize instead of answering.
- NEVER truncate the JSON or emit placeholder text such as "…"/"..." — the object must parse as-is.
- If output length is a concern, author 1-2 banks and repeat them via a chain string instead of writing more steps.
- The user imports the JSON via the synth's Song panel → Import; the app expands it into a full song.
- Machine-readable JSON Schemas (draft 2020-12): ${authorSchemaUrl} (author format) and ${schemaUrl} (full canonical format).

QUICKSTART — a complete, valid, importable song:
{
  "format": "websynth-song-author", "version": 1, "name": "Night Drive",
  "params": { "transport.bpm": 124, "voicing.mode": 0, "filter.cutoff": 66, "filter.resonance": 1.2 },
  "seq": [ { "notes": ["A2","A2","A3","A2","C3",null,"A2","G2","A2","A2","A3","A2","E3",null,"D3","C3"], "gate": 0.45, "velocity": 0.9 } ],
  "drums": [ { "kick": [0,4,8,12], "clap": [4,12], "chat": [2,6,10,14], "ohat": [{ "step": 15, "prob": 0.5 }] } ],
  "seqChain": "AAAA",
  "drumChain": "AAAA"
}

COMPACT AUTHOR FORMAT (recommended output)
{
  "format": "websynth-song-author",   // literal, required
  "version": 1,                        // literal, required
  "name": "string",                    // song title
  "params": { "<id>": number },        // OPTIONAL and SPARSE — set only what matters; omitted params keep their defaults (see PARAMS)
  "seq": [ SeqBank, … up to ${BANK_COUNT} ],   // a bank may be {"tracks": [notes, notes, …]} for chords        // melody banks ${BANK_LABELS.join('/')}; a missing bank is empty
  "drums": [ HitBank, … up to ${BANK_COUNT} ],      // drum banks
  "sampler": [ HitBank, … up to ${BANK_COUNT} ],    // OPTIONAL — sampler banks (slots play user-loaded audio files)
  "seqChain": Chain,                   // OPTIONAL — bar-by-bar bank order (omitted = just play bank A)
                                       //   letters may carry a transpose: "A A+5 A+7 A+3" (see TRANSPOSE)
  "seqTranspose": [0, 5, 7, 3],        // OPTIONAL — the same offsets for the non-string chain forms
  "drumChain": Chain,
  "samplerChain": Chain,
  "sampleNames": ["kick.wav", …],      // OPTIONAL — display names per sampler slot (max ${SAMPLER_SLOT_COUNT}; audio is NEVER embedded)
  "xy": { "x": "<param id>", "y": "<param id>" },   // OPTIONAL — XY-pad axis assignment
  "motion": [ MotionBank, … up to ${BANK_COUNT} ],  // OPTIONAL — motion sequencer (XY param automation over the bar)
  "motionChain": Chain,                // OPTIONAL — motion bank order per bar
  "motionTracks": [ [Track, Track], … ] // OPTIONAL — 2 extra 1-param tracks per motion bank
}

SeqBank — one bar of melody (${SEQ_LENGTH} sixteenth-note step cells; a bank is
always ${SEQ_LENGTH} cells, but how many of them a BAR is depends on the meter — see METER), any of these forms:
- Positional array of up to ${SEQ_LENGTH} entries, one per step; short arrays are rest-padded.
- { "tracks": [SeqBank, … up to ${SEQ_TRACK_COUNT}], "velocity"?, "gate"?, "prob"?, "ratchet"?, "tie"?, "micro"? }
  — simultaneous tracks, for chords and counter-lines. The first is track 1;
  tracks 2-4 sound only in POLY voicing ("voicing.mode": 1), so set that when you
  use them. Settings next to "tracks" apply to EVERY track, so a chord bank sets
  its gate once: { "tracks": [["C3"],["E3"],["G3"]], "gate": 0.9 }.
  Entry = null (rest) | MIDI number 0-127 | note name "A2"/"C#4"/"Db3" (C4 = 60)
        | { "note": <midi|name>, "velocity"?: 0-1, "gate"?: 0-1, "prob"?: 0-1, "ratchet"?: 1-4, "tie"?: bool, "micro"?: -12..12 }
- Bank-defaults form { "notes": [entries…], "velocity"?, "gate"?, "prob"?, "ratchet"?, "tie"?, "micro"? } —
  the bank-level settings apply to every sounded step (a per-entry object still overrides them).
Settings cascade bank -> track -> step; the nearest one wins.
Sounded-step defaults: velocity 0.85, gate 0.5, prob 1, ratchet 1, tie false, micro 0.

HitBank — one bar of triggers: an object mapping a track to its hits.
  Drum tracks: kick, snare, chat (closed hat), ohat (open hat), ltom, mtom, htom, clap — or "0".."7" (${drumTracks}).
  Sampler slots: "s1".."s${SAMPLER_SLOT_COUNT}" or "0".."${SAMPLER_SLOT_COUNT - 1}".
  Hit = step index 0-${SEQ_LENGTH - 1} | { "step": 0-${SEQ_LENGTH - 1}, "velocity"?: 0-1, "gate"?: 0-1, "prob"?: 0-1, "ratchet"?: 1-4, "tie"?: bool, "micro"?: -12..12 }.

MotionBank — one bar of XY param automation: anchors the synth moves through while playing.
  Either an anchor list [ { "step": 0-${SEQ_LENGTH - 1}, "x": 0-1, "y": 0-1 }, … ] or
  { "assign": { "x"?: "<param id>", "y"?: "<param id>" }, "steps": [ …anchors ] } to override,
  per bank, which two params the anchors drive (an unset axis inherits the song's "xy" assignment;
  x/y are the params' normalized 0..1 positions, like the XY pad surface).
  "motion.slide" chooses the XY lane's curve: 1 (default) ramps linearly between anchors (sweeps),
  0 jumps at each anchor and holds (param-lock stabs). A bank with no anchors automates nothing —
  e.g. a one-bar min→max→min cutoff sweep is [ {"step":0,"y":0,"x":0.5}, {"step":8,"y":1,"x":0.5}, {"step":15,"y":0,"x":0.5} ].

TRANSPOSE — a "seqChain" bank letter may carry "+n"/"-n" semitones (max ${MAX_CHAIN_TRANSPOSE}):
  "seqChain": "A A+5 A+7 A+3"  — one bank, four bars, a whole chord progression.
  This is the biggest lever in the format: there are only 4 banks of 16 steps, so
  without it a four-chord progression spends every bank and leaves nothing for a
  variation. Write ONE good bar and transpose it; save the other banks for a
  different part. It shifts the note the sequencer plays (clamped to 0-127), never
  the stored bank. Only "seqChain" is pitched — drums/sampler/motion chains reject
  a suffix, and so does a rest (".+5"). The array/object chain forms take a
  parallel "seqTranspose": [0,5,7,3] instead.

METER — the time signature, in "params". A bar is a number of sixteenth-note
  ticks, not a fixed ${SEQ_LENGTH}: "transport.beats" (2-12) x "transport.beatUnit"
  (0 = quarter-note beat, 1 = eighth) ticks. 4/4 = 16 is the default, so omit both
  for a normal song. 3/4 = { "transport.beats": 3 }, 7/8 = { "transport.beats": 7,
  "transport.beatUnit": 1 }. Every machine follows it — you do NOT set a length per
  machine to write in 3/4, just write 12 steps and leave the rest empty.
  POLYRHYTHM is the opt-in on top: "<m>.len" (0 = follow the bar, else 1-${SEQ_LENGTH} cells)
  and "<m>.rate" (step length; see /params.json for the list, default = 1/16) for m in
  seq/drum/sampler/motion. A lane whose length differs from the bar phases against it
  and re-aligns at the least common multiple — e.g. "drum.len": 12 under a 16-tick bar
  repeats every 4 bars. Use it deliberately; it is not how you write an odd meter.
  Bar longer than the grid: 5/4 is 20 ticks and 7/4 is 28, more cells than a bank has,
  so those meters need a coarser rate (5/4 = "<m>.rate" of 1/8 with "<m>.len": 10).

Chain — the song structure, one bank per bar, looped:
- a string of bank letters where "." or "-" is a silent bar: "AABA", "AAAB AAAC" (spaces ignored), or
- an array of bank indices where -1 is a silent bar: [0, 0, 1, 0], or
- the full { "enabled": bool, "steps": [indices] } object. The string/array shorthands imply enabled: true.

NOTES
- "filter.cutoff" is a MIDI NOTE NUMBER, not Hz. Filter env/LFO modulate it additively in semitones.
- Machines with hits turn on automatically ("seq.on"/"drum.on"/"sampler.on"/"motion.on" are set to 1
  when a bank has steps and you didn't set the param yourself); set e.g. "seq.on": 0 to keep one silent on load.
- For a resonant, moving filter (acid/disco bass), use high "filter.resonance", a fast "env.fil.decay",
  positive "filter.envAmount", and route the LFO to cutoff with "lfo.dest": 1.
- "lfo.dest": 5 is a stereo auto-pan on the whole synth channel (its FX tails sweep with it). Pair a slow
  "lfo.rate" with a sine wave for a wide drifting pad, or a square wave for hard L/R trance alternation.
- "lfo.dest": 4 is PWM. It only bites on oscillators set to the square wave ("osc1.wave"/"osc2.wave": 3),
  sweeps "osc1.pulseWidth"/"osc2.pulseWidth" upward from whatever you set them to (0.5 = plain square),
  and follows "lfo.rate" up to 10Hz. Slow rates (0.2-2) give the classic PWM string/pad shimmer.
- There are TWO LFOs: "lfo.*" and "lfo2.*", same params, same destinations, both off by default
  ("lfo2.dest": 0 and "lfo2.amount": 0). Use the second for a slow pad movement under a faster first —
  e.g. "lfo.dest": 1 for a filter wobble plus "lfo2.dest": 5 for a drifting auto-pan.
  Give them DIFFERENT destinations: the app itself won't let a player pick a destination the other LFO
  holds. A file that puts both on one destination still loads and simply sums them (which is louder
  modulation, not two movements) — except "lfo.dest": 4 (PWM), where LFO 1 wins and LFO 2 does nothing.
  The mod wheel adds depth to LFO 1 only.
- Use "prob" (< 1) for evolving hats/ghost notes, "ratchet" (2-4) for rolls, and "tie" + "mixer.glide"
  in Mono voicing ("voicing.mode": 0) for acid slides.
- Drum/sampler hits: "gate" < 1 chokes a hit early (tight/choked open hats, gated snares), "ratchet" 2-4
  makes rolls, "prob" < 1 makes ghost notes, and "tie" lets the last ratchet hit of a choked step ring out.
- "micro" (-12..12) nudges ONE step off the grid, in 1/24 of a step: negative = early (pushing, urgent),
  positive = late (laid back). This is per-step feel, not global swing ("transport.swing"). Small values
  are the musical ones — ±1..3 is a groove, ±8 is 1/3 of a step (a triplet placement), ±12 is half a step
  and deliberately drunk. A snare at "micro": 2 and hats at -1 is a classic behind-the-beat backbeat.
- Two bus compressors are available: "fx.drum.comp.*" (1176 FET style — punchy drums; ratio index 4 = ALL,
  the crushed all-buttons-in sound) and "fx.master.comp.*" (SSL G bus style — mix glue; release index 4 = auto).
  Their "ratio"/"release" params are discrete INDICES — see the value maps in PARAMS.
- Each drum track's VOICE is swappable via "drum.t{i}.model" (see its value map in PARAMS): models 8-12
  (Conga/Bongo/Cowbell/Clave/Shaker) turn tracks into a percussion section — great for latin/afro grooves.
  The track keys (kick/snare/chat/...) still address the same slots whatever voice is selected.
- A song is a STAGE SETUP for a player, not only a description of what sounds by itself. It is correct
  and often deliberate to set a param that makes no sound on playback: "arp.on": 1 arms the arpeggiator
  for whoever holds a key over the running song (the arp follows the keyboard/MIDI, never the sequencer),
  and an effect left bypassed or at "mix": 0 is staged for the XY pad or a motion lane to open up. Do not
  "fix" these by removing them; say in your reply what you armed and how to play it.
- An automation target — "xy", a per-bank "assign", or a "motionTracks" param — must name a REAL param id
  from PARAMS below. An id that does not exist is not an error, but nothing will move: validate_song
  reports it as a warning, so check those before you call a song done.

PARAMS (id, range, default, discrete value map)
${params}

APPENDIX — FULL CANONICAL FORMAT ("websynth-song")
Prefer the compact author format above. Emit this full form only when explicitly asked for it
or when editing a file the synth exported. Every grid must be written out to full size.

TOP-LEVEL SHAPE
{
  "format": "websynth-song",          // literal, required
  "version": ${SONG_VERSION},                        // ${SONG_VERSION} (5 lacks seq tracks 2-4; 4 also lacks the extra motion tracks; 3 also lacks the motion fields; 2 also lacks the XY Pad assignment; 1 also lacks the sampler fields)
  "name": "string",
  "params": { "<id>": number, ... },
  "seqBanks":  SeqStep[${BANK_COUNT}][${SEQ_LENGTH}],          // ${BANK_COUNT} banks, ${SEQ_LENGTH} steps each
  "drumBanks": DrumCell[${BANK_COUNT}][${DRUM_TRACK_COUNT}][${SEQ_LENGTH}],   // ${BANK_COUNT} banks, ${DRUM_TRACK_COUNT} tracks, ${SEQ_LENGTH} steps
  "seqChain":  { "enabled": boolean, "steps": number[] },   // bank order, indices 0..${BANK_COUNT - 1}, -1 = rest
  "drumChain": { "enabled": boolean, "steps": number[] },
  // ---- v2 sampler fields, all OPTIONAL ----
  "samplerBanks": SamplerStep[${BANK_COUNT}][${SAMPLER_SLOT_COUNT}][${SEQ_LENGTH}],
  "samplerChain": { "enabled": boolean, "steps": number[] },
  "sampleNames":  (string | null)[${SAMPLER_SLOT_COUNT}],
  // ---- v3 XY Pad field, OPTIONAL ----
  "xy": { "x": "<param id>", "y": "<param id>" },
  // ---- v4 motion sequencer fields, all OPTIONAL ----
  "motionBanks": MotionStep[${BANK_COUNT}][${SEQ_LENGTH}],
  "motionAssigns": (MotionAssign | null)[${BANK_COUNT}],   // per-bank axis override; null = inherit "xy"
  "motionChain": { "enabled": boolean, "steps": number[] },

  // ---- v5 extra motion tracks, OPTIONAL ----
  // Per bank, 2 more automation tracks that each drive ONE param of your choice —
  // so a bank can move up to 4 params, or move just these 2 and keep the XY Pad
  // free to play live (the XY lane is what costs you the pad).
  // A track is { "param": "<ParamBus id>", "steps": [{ "step": 0-15, "v": 0-1 }] }
  // or null. Same slide/step curve rules as the XY anchors, but each track has
  // its OWN mode param: "motion.t0.slide" / "motion.t1.slide" (1 = slide, default).
  "motionTracks": ((Track | null)[2])[${BANK_COUNT}],

  // ---- v6 sequencer tracks 2-4, OPTIONAL ----
  // Indexed by the REAL track number, so index 0 is always null (track 1 is
  // "seqBanks"). An unused track is null. Tracks 2-4 sound only in poly voicing.
  "seqTracks": ((SeqStep[${SEQ_LENGTH}] | null)[${SEQ_TRACK_COUNT}])[${BANK_COUNT}]
}

SeqStep  = { "on": boolean, "note": number /* MIDI 0-127 */, "velocity": number /* 0..1 */, "gate": number /* 0..1 of a step */,
             "prob": number /* 0..1, default 1 */, "ratchet": number /* 1-4, default 1 */, "tie": boolean /* default false */,
             "micro": number /* integer -12..12, 1/24 of a step; default 0 */ }
DrumCell = SamplerStep = { "on": boolean, "velocity": number /* 0..1 */, "gate": number /* 0..1; 1 = ring naturally (default) */,
             "prob": number /* 0..1, default 1 */, "ratchet": number /* 1-4, default 1 */, "tie": boolean /* default false */,
             "micro": number /* integer -12..12, 1/24 of a step; default 0 */ }
MotionStep = { "on": boolean, "x": number /* 0..1 */, "y": number /* 0..1 */ }   // a dead step is { "on": false }
MotionAssign = { "x"?: "<param id>", "y"?: "<param id>" }
On import, any omitted "gate"/"prob"/"ratchet"/"tie"/"micro" falls back to its default, so plain
{ "on", "velocity" } cells stay valid.

EXAMPLE SHAPE (illustrative — fill EVERY array to full size; "…" marks omissions, never output it)
{
  "format": "websynth-song",
  "version": ${SONG_VERSION},
  "name": "My Song",
  "params": { "mixer.glide": 0, "filter.cutoff": 60, "…": 0 },
  "seqBanks": [
    [ { "on": true, "note": 48, "velocity": 0.9, "gate": 0.5 },
      { "on": false, "note": 48 }, "… ${SEQ_LENGTH} steps total" ],
    "… ${BANK_COUNT} banks total"
  ],
  "drumBanks": [
    [ [ { "on": true }, { "on": false }, "… ${SEQ_LENGTH} steps total" ], "… ${DRUM_TRACK_COUNT} tracks total" ],
    "… ${BANK_COUNT} banks total"
  ],
  "seqChain":  { "enabled": false, "steps": [0] },
  "drumChain": { "enabled": false, "steps": [0] }
}
Cells are default-sparse: a seq step keeps "on"/"note"/"velocity"/"gate"; a dead drum/sampler cell is just { "on": false }.`;
}

/**
 * The **preset** authoring guide — `specs/features/preset-authoring.md`. A
 * preset is a sound, not a song: same PARAMS machinery, narrowed to the patch
 * parameters (`isPatchParam`), with the two file shapes and the sound-design
 * knowledge an agent needs to hit a named timbre. Served by the MCP server's
 * `get_preset_format`.
 */
export function buildPresetGuide(bus: ParamBus, origin?: string): string {
  const o = resolveOrigin(origin);
  const presetSchemaUrl = `${o}/schema/websynth-preset.schema.json`;
  const bankSchemaUrl = `${o}/schema/websynth-preset-bank.schema.json`;

  return `OUTPUT RULES
- Respond with exactly ONE JSON object and nothing else — no markdown fences, no commentary, no questions.
- A preset is a SOUND, not a song: oscillators, filter, envelopes, LFO, voicing and the synth insert FX.
  It carries no notes, no patterns and no tempo — those belong to a song file (ask for the song format).
- "params" is SPARSE: set only what shapes the sound you were asked for. Everything you omit is filled
  from the synth's own defaults on import, so the patch is always complete and never inherits leftovers
  from whatever was loaded before.
- NEVER truncate the JSON or emit placeholder text such as "…"/"..." — the object must parse as-is.
- The user imports it from the header's Preset button → Import, or by pasting it into the app.
- Machine-readable JSON Schemas (draft 2020-12): ${presetSchemaUrl} (one sound) and ${bankSchemaUrl} (many).

QUICKSTART — a complete, valid, importable preset:
{
  "format": "websynth-preset", "version": 1, "name": "Rubber Bass",
  "params": {
    "voicing.mode": 0, "glide.mode": 1, "mixer.glide": 0.04,
    "osc1.wave": 2, "osc1.octave": -1, "osc1.level": 0.85,
    "osc2.wave": 3, "osc2.octave": -1, "osc2.detune": -7, "osc2.level": 0.35,
    "filter.cutoff": 62, "filter.resonance": 2.4, "filter.drive": 1.8, "filter.envAmount": 30,
    "env.amp.attack": 0.002, "env.amp.decay": 0.25, "env.amp.sustain": 0.4, "env.amp.release": 0.15,
    "env.fil.attack": 0.001, "env.fil.decay": 0.2, "env.fil.sustain": 0, "env.fil.release": 0.15,
    "fx.dist.on": 1, "fx.dist.drive": 0.4, "fx.dist.mix": 0.4
  }
}

FILE SHAPES
Preset — one sound:
{ "format": "${PRESET_FORMAT}", "version": 1, "name": "string", "params": { "<id>": number } }
Bank — many sounds in one file (use this when asked for a set, a kit, or several patches):
{ "format": "${BANK_FORMAT}", "version": 1, "name": "string",
  "presets": { "<preset name>": { "<id>": number }, … } }

SOUND DESIGN NOTES
- "filter.cutoff" is a MIDI NOTE NUMBER (0..127), NOT Hz — 60 is middle C, +12 is an octave up. The
  filter envelope ("filter.envAmount", in semitones) and the LFO add to it in the same semitone space.
- The shape of a sound is mostly: waveforms + octaves, cutoff/resonance, and the two envelopes.
  Percussive (pluck/bass stab): tiny attack, short "env.fil.decay", "env.fil.sustain" 0, high
  "filter.envAmount". Sustained (pad/strings): long attacks and releases, sustain near 1, low envAmount.
- "voicing.mode": 0 = mono (one note at a time — basses, leads, acid), 1 = poly (chords, pads).
  Glide only bends between notes in mono: set "glide.mode" 1/2 and "mixer.glide" > 0.
- Fatten with "unison.voices"/"unison.detune", "analog.drift" (per-voice tuning wander), a detuned
  osc2, or "sub.level" for weight an octave down. "mixer.noise" adds breath/attack transient.
- EVERY synth insert effect is gated by its own ".on" flag — "fx.delay.time" does nothing while
  "fx.delay.on" is 0. Set the flag AND the parameters, and set unused effects' flags to 0 explicitly
  so the patch sounds the same wherever it is loaded.
- Acid: saw osc1, mono, high resonance (2.5+), short filter decay, high envAmount, some distortion.
  Reese: two detuned saws an octave down + sub. Rhodes/bells: sine osc + long decay, sustain 0.
- Only the parameters below belong in a preset. Song-level ids (transport/seq/drum/sampler/arp) are
  accepted but will move the user's song when the preset loads — leave them out.

PARAMS (id, range, default, discrete value map)
${paramTable(bus, isPatchParam)}`;
}

/**
 * Build the copyable AI prompt: intro + the user's creative brief (or a
 * bracketed placeholder) + the format guide. The parameter table inside the
 * guide is generated from the live ParamBus registry so it always matches
 * `registerDefaults()`.
 */
export function buildSongPrompt(bus: ParamBus, brief?: string): string {
  const request = brief && brief.trim() ? brief.trim() : REQUEST_PLACEHOLDER;
  return `You are generating a song file for the WebSynth (VAST G1-J8) browser synthesizer.

SONG REQUEST
${request}

${buildAuthoringGuide(bus)}`;
}

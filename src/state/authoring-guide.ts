/**
 * The song-authoring guide + AI prompt builder. The guide documents the
 * compact authoring dialect (`websynth-song-author`, the recommended output
 * for AI agents — see specs/features/song-authoring-dialect.md) with the full
 * canonical format as an appendix, and embeds the live PARAMS table generated
 * from `ParamBus` so it can never drift from `registerDefaults()`.
 *
 * Pure and importable anywhere: only `params.ts` + `patterns.ts` — **never**
 * `song.ts`, whose `import.meta.glob` demo registration would poison the MCP
 * server's Node bundle. The ✨ AI Prompt modal (`ui/components/ai-prompt.ts`)
 * and the MCP server's `get_song_format` tool both serve this text.
 */
import type { ParamBus } from './params';
import { DRUM_TRACK_LABELS } from './params';
import {
  SEQ_LENGTH,
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
 * The format guide: OUTPUT RULES → QUICKSTART → the compact author format →
 * NOTES → live PARAMS table → the canonical full form as an appendix.
 */
export function buildAuthoringGuide(bus: ParamBus, origin?: string): string {
  const o = resolveOrigin(origin);
  const authorSchemaUrl = `${o}/schema/websynth-song-author.schema.json`;
  const schemaUrl = `${o}/schema/websynth-song.schema.json`;

  const params = bus
    .ids()
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
  "seq": [ SeqBank, … up to ${BANK_COUNT} ],        // melody banks ${BANK_LABELS.join('/')}; a missing bank is empty
  "drums": [ HitBank, … up to ${BANK_COUNT} ],      // drum banks
  "sampler": [ HitBank, … up to ${BANK_COUNT} ],    // OPTIONAL — sampler banks (slots play user-loaded audio files)
  "seqChain": Chain,                   // OPTIONAL — bar-by-bar bank order (omitted = just play bank A)
  "drumChain": Chain,
  "samplerChain": Chain,
  "sampleNames": ["kick.wav", …],      // OPTIONAL — display names per sampler slot (max ${SAMPLER_SLOT_COUNT}; audio is NEVER embedded)
  "xy": { "x": "<param id>", "y": "<param id>" }   // OPTIONAL — XY-pad axis assignment
}

SeqBank — one bar of melody (${SEQ_LENGTH} sixteenth-note steps), either form:
- Positional array of up to ${SEQ_LENGTH} entries, one per step; short arrays are rest-padded.
  Entry = null (rest) | MIDI number 0-127 | note name "A2"/"C#4"/"Db3" (C4 = 60)
        | { "note": <midi|name>, "velocity"?: 0-1, "gate"?: 0-1, "prob"?: 0-1, "ratchet"?: 1-4, "tie"?: bool }
- Bank-defaults form { "notes": [entries…], "velocity"?, "gate"?, "prob"?, "ratchet"?, "tie"? } —
  the bank-level settings apply to every sounded step (a per-entry object still overrides them).
Sounded-step defaults: velocity 0.85, gate 0.5, prob 1, ratchet 1, tie false.

HitBank — one bar of triggers: an object mapping a track to its hits.
  Drum tracks: kick, snare, chat (closed hat), ohat (open hat), ltom, mtom, htom, clap — or "0".."7" (${drumTracks}).
  Sampler slots: "s1".."s${SAMPLER_SLOT_COUNT}" or "0".."${SAMPLER_SLOT_COUNT - 1}".
  Hit = step index 0-${SEQ_LENGTH - 1} | { "step": 0-${SEQ_LENGTH - 1}, "velocity"?: 0-1, "gate"?: 0-1, "prob"?: 0-1, "ratchet"?: 1-4, "tie"?: bool }.

Chain — the song structure, one bank per bar, looped:
- a string of bank letters where "." or "-" is a silent bar: "AABA", "AAAB AAAC" (spaces ignored), or
- an array of bank indices where -1 is a silent bar: [0, 0, 1, 0], or
- the full { "enabled": bool, "steps": [indices] } object. The string/array shorthands imply enabled: true.

NOTES
- "filter.cutoff" is a MIDI NOTE NUMBER, not Hz. Filter env/LFO modulate it additively in semitones.
- Turn the machines on: "seq.on" 1 when you author seq banks, "drum.on" 1 for drums (both default 1).
- For a resonant, moving filter (acid/disco bass), use high "filter.resonance", a fast "env.fil.decay",
  positive "filter.envAmount", and route the LFO to cutoff with "lfo.dest": 1.
- Use "prob" (< 1) for evolving hats/ghost notes, "ratchet" (2-4) for rolls, and "tie" + "mixer.glide"
  in Mono voicing ("voicing.mode": 0) for acid slides.
- Drum/sampler hits: "gate" < 1 chokes a hit early (tight/choked open hats, gated snares), "ratchet" 2-4
  makes rolls, "prob" < 1 makes ghost notes, and "tie" lets the last ratchet hit of a choked step ring out.
- Two bus compressors are available: "fx.drum.comp.*" (1176 FET style — punchy drums; ratio index 4 = ALL,
  the crushed all-buttons-in sound) and "fx.master.comp.*" (SSL G bus style — mix glue; release index 4 = auto).
  Their "ratio"/"release" params are discrete INDICES — see the value maps in PARAMS.

PARAMS (id, range, default, discrete value map)
${params}

APPENDIX — FULL CANONICAL FORMAT ("websynth-song")
Prefer the compact author format above. Emit this full form only when explicitly asked for it
or when editing a file the synth exported. Every grid must be written out to full size.

TOP-LEVEL SHAPE
{
  "format": "websynth-song",          // literal, required
  "version": 3,                        // 3 (2 lacks the XY Pad assignment; 1 also lacks the sampler fields)
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
  "xy": { "x": "<param id>", "y": "<param id>" }
}

SeqStep  = { "on": boolean, "note": number /* MIDI 0-127 */, "velocity": number /* 0..1 */, "gate": number /* 0..1 of a step */,
             "prob": number /* 0..1, default 1 */, "ratchet": number /* 1-4, default 1 */, "tie": boolean /* default false */ }
DrumCell = SamplerStep = { "on": boolean, "velocity": number /* 0..1 */, "gate": number /* 0..1; 1 = ring naturally (default) */,
             "prob": number /* 0..1, default 1 */, "ratchet": number /* 1-4, default 1 */, "tie": boolean /* default false */ }
On import, any omitted "gate"/"prob"/"ratchet"/"tie" falls back to its default, so plain
{ "on", "velocity" } cells stay valid.

EXAMPLE SHAPE (illustrative — fill EVERY array to full size; "…" marks omissions, never output it)
{
  "format": "websynth-song",
  "version": 3,
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
 * Build the copyable AI prompt: intro + the user's creative brief (or a
 * bracketed placeholder) + the format guide. The parameter table inside the
 * guide is generated from the live ParamBus registry so it always matches
 * `registerDefaults()`.
 */
export function buildSongPrompt(bus: ParamBus, brief?: string): string {
  const request = brief && brief.trim() ? brief.trim() : REQUEST_PLACEHOLDER;
  return `You are generating a song file for the WebSynth (VAST G1-J5) browser synthesizer.

SONG REQUEST
${request}

${buildAuthoringGuide(bus)}`;
}

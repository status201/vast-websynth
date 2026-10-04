# MIDI file reader (Standard MIDI File → an arranger's summary)

```yaml
id: midi-file-reader
status: implemented
version: 1
owner: tooling
related:
  - mcp-server            # the read_midi tool is its first consumer
  - untrusted-input       # a .mid is an ingest surface; its bounds live in limits.ts
  - song-authoring-dialect
  - meter
  - drum-machine          # the GM drum map names drum tracks and voice models
  - ../decisions/adr-003-no-runtime-dependencies
  - ../decisions/adr-015-untrusted-input-is-bounded
source:
  - src/state/midi-file.ts   # parseMidiFile + analyzeMidi (pure)
  - src/state/gm-names.ts    # GM program names + the GM drum map
  - src/state/limits.ts      # MAX_MIDI_* (REQ-a-midi-file-is-bounded)
```

## Background / Why

An agent turning a song into a websynth arrangement starts from a MIDI file far
more often than from a score. Doing that for *Eleanor Rigby* meant hand-writing an
SMF parser in a scratch script and then dumping every bar on a step grid, because
three things decide the arrangement and none can be seen without that dump: the
**form** (which bars repeat — the bank budget is 16), the **grid** (every onset on
an eighth means `seq.rate` 1/8 holds two bars per bank) and the **parts** (which
channel is which instrument and over what range). That half is mechanical and
belongs in code; arranging stays with the agent. This spec is the reader: a pure
parser plus an analysis shaped for an arranger. The MCP tool `read_midi`
([mcp-server](mcp-server.md) REQ-read-midi-reads-a-file-for-an-arranger) is its
first consumer; it lives in `src/state/` so the app can import a `.mid` later
without a second parser.

## Requirements

- **REQ-a-midi-parse-never-throws** — `parseMidiFile(bytes)` returns
  `{ok:true, file, warnings}` or `{ok:false, errors}` for **any** input and never
  throws. A `.mid` is untrusted ([untrusted-input](untrusted-input.md)
  REQ-the-untrusted-surfaces-are-enumerated): every chunk length, VLQ and event
  length is checked against the bytes that remain before it is read.

- **REQ-smf-format-0-and-1-are-read** — Formats 0 and 1 are read. Format 2
  (independent sequences) and SMPTE time division (the high bit of the division
  word) are refused with a named error. Unknown chunk types are skipped by their
  length. Within a track: running status, note-on velocity 0 as note-off, sysex
  (`F0`/`F7`) skipped by length, meta events read for tempo (`51`), time
  signature (`58`), track name (`03`) and end of track (`2F`), others skipped.
  A sysex or meta event cancels running status. Any other `F1`–`FE` status byte,
  or a data byte with no running status, ends the parse with an error naming the
  track and byte offset — never the bytes themselves.

- **REQ-notes-pair-per-channel-and-pitch** — A note is a note-on paired with the
  next note-off of the same channel and pitch in the same track. A second note-on
  for a pitch still sounding closes the first at the new onset. A note-off with
  nothing to close is ignored; a note still open at end of track is closed there.
  Each of those is counted into one `warnings` line, not one line per note.

- **REQ-a-midi-file-is-bounded** — Bounds in the parser, numbers in `limits.ts`
  ([untrusted-input](untrusted-input.md) REQ-the-limits-are-one-module):
  `MAX_MIDI_FILE_BYTES` (checked before parsing), `MAX_MIDI_TRACKS` (track chunks),
  `MAX_MIDI_BARS` (the analysis bar map — a file can place one note at tick 2²⁸
  and ask for millions of bars). Track names are cut to `MAX_MIDI_NAME_CHARS` and
  stripped of control characters: they are the one free-text field a file carries
  into an agent's context. A time-signature denominator past 1/64 or a numerator
  of 0 is ignored with a warning; a tempo of 0 µs/quarter likewise.

- **REQ-bars-follow-the-file-meter** — Bars are counted 1-based from tick 0 using
  the file's time signatures (4/4 when there is none). A bar's length is
  `ppq × 4 × num / den`; a signature change applies from the first bar line at or
  after its tick. Positions inside a bar are in **sixteenths** (fractional for
  triplets), the unit the sequencer grid and `seqChain` think in. Tempo and
  meter changes are reported by bar, and only where the value actually changes —
  exports re-state 4/4 on every track, which is not news to an arranger.

- **REQ-the-analysis-names-the-parts** — `analyzeMidi(file)` reports, per used
  channel (1-based, MIDI's own numbering): the GM instrument of its first program
  change (channel 10 is *drums*), note count, range as note names, maximum
  polyphony and its grid (REQ-the-grid-is-the-coarsest-that-holds-every-onset).
  For channel 10 it lists each GM drum note used, with its GM name and the
  websynth drum track or voice model that plays it (`kick`, `snare`, …,
  `model:Conga`), or `null` when nothing does.

- **REQ-the-grid-is-the-coarsest-that-holds-every-onset** — The grid of a channel,
  and of the song, is the **smallest** number of divisions per quarter, from
  `1, 2, 3, 4, 6, 8, 12, 16, 24`, on which every onset lands exactly. None fits →
  `free`, with the count of onsets off the 1/16 grid. The song-level result comes
  with a one-line **suggestion** for the sequencer: the `seq.rate` that grid needs
  and, at `seq.len` 16, how many bars one bank holds — the *Eleanor Rigby* finding
  (eighths → 2 bars per bank) as a rule rather than a discovery.

- **REQ-the-listing-is-a-window-of-bars** — The bar listing gives, per bar, per
  channel, tokens `pos:Name/len` (position and length in sixteenths, two decimals;
  `Name` is a note name, or the GM drum name on channel 10), ordered by position
  then pitch, high first. It covers `fromBar..toBar` (default: from the first
  sounding bar), at most `MAX_MIDI_SUMMARY_BARS` bars per call, optionally only
  some channels. A cut window says so and names the next bar to ask for.

- **REQ-repeats-are-grouped** — The analysis groups bars whose listing is
  identical across all (selected) channels — the groups an arranger maps onto one
  bank — and reports how many distinct non-empty bars the song has overall and per
  channel. Bars compare on **onsets and pitches only**: a performance's ragged
  releases, or a phrase played legato once and detached the next, are the same
  bank to an arranger, and any length tolerance has a boundary that splits two
  near-equal notes anyway.

## Technical design

### Contract / public interface

```ts
// src/state/midi-file.ts — pure: no DOM, no Node, no AudioContext
export function parseMidiFile(bytes: Uint8Array): MidiParse;
export function analyzeMidi(file: MidiFile, opts?: MidiAnalyzeOptions): MidiAnalysisResult;
// MidiAnalysisResult = MidiAnalysis | {ok:false, errors} — only REQ-a-midi-file-is-bounded's bar cap fails it

// src/state/gm-names.ts
export const GM_PROGRAMS: readonly string[];          // 128 names, index = program
export function gmDrum(note: number): GmDrum | null;  // GM percussion key map
```

### Data shapes

```yaml
MidiParse: "{ok:true, file: MidiFile, warnings: string[]} | {ok:false, errors: string[]}"
MidiFile:
  format: 0 | 1
  ppq: number
  trackNames: string[]                    # per track chunk, '' when unnamed
  tempos: "{tick, bpm}[]"                 # sorted; empty = 120
  meters: "{tick, num, den}[]"            # sorted; empty = 4/4
  programs: "{tick, channel, program}[]"  # channel 0-15 as on the wire
  notes: "{tick, dur, note, velocity, channel, track}[]"   # sorted by tick, then pitch
MidiAnalyzeOptions: { fromBar?: number, toBar?: number, channels?: number[] }   # channels 1-16
MidiAnalysis:
  ok: true
  format, ppq, bars: number, firstSoundingBar: number
  tempo: "{bpm, changes: {bar, bpm}[]}"
  meter: "{first: 'n/d', changes: {bar, meter}[]}"
  grid: "{divisions: number | 'free', label, offGrid16}"
  suggestion: string
  tracks: "{index, name, notes}[]"
  channels: "{channel, instrument, notes, range, maxPolyphony, grid, drums?: {note, name, count, websynth}[]}[]"
  distinctBars: "{all: number, byChannel: {[channel]: number}}"
  repeats: "{bars: number[]}[]"           # groups of 2+ identical non-empty bars
  window: "{fromBar, toBar, truncated, nextBar?}"
  listing: "{bar, meter?, channels: {[channel]: string}}[]"
GmDrum: { name: string, websynth: string | null }
```

### Layer touchpoints & ordering

`midi-file.ts` imports only `limits.ts` and `gm-names.ts` (its note names are a
local helper: the app's `noteName` lives in a UI module),
so the MCP song core can re-export it (mcp-server.md
REQ-song-core-entry-exports-only-pure-code). The byte cap is applied **before**
parsing; the bar cap while the bar map is built, before any per-bar work.

## Scenarios (BDD)

```gherkin
Scenario: A format-0 file with running status and velocity-0 note-offs (REQ-smf-format-0-and-1-are-read)
  Given a format-0 file whose note-offs are note-ons at velocity 0 under running status
  When it is parsed
  Then every note has the right start and duration, and there are no warnings
# pinned by: tests/state/midi-file.test.ts

Scenario: A format-1 file keeps its tempo, meter, names and programs (REQ-smf-format-0-and-1-are-read)
  Given a conductor track with tempo 138 and 3/4, and two named tracks with program changes
  Then tempos, meters, trackNames and programs are read, and notes carry their track index
# pinned by: tests/state/midi-file.test.ts

Scenario: Sysex and unknown chunks are skipped (REQ-smf-format-0-and-1-are-read)
# pinned by: tests/state/midi-file.test.ts

Scenario: Hostile and broken files are refused, never thrown (REQ-a-midi-parse-never-throws, REQ-a-midi-file-is-bounded)
  Given a truncated chunk, a 5-byte VLQ, format 2, SMPTE division, a data byte with no status,
        an over-size file, too many tracks, and random bytes
  When each is parsed
  Then each returns ok:false with a named error, and none throws
# pinned by: tests/state/midi-file.test.ts

Scenario: Overlaps and dangling notes are closed and counted (REQ-notes-pair-per-channel-and-pitch)
# pinned by: tests/state/midi-file.test.ts

Scenario: A note far in the future cannot inflate the bar map (REQ-a-midi-file-is-bounded)
  Given one note at tick 2^27 at ppq 96
  Then the analysis is refused for exceeding MAX_MIDI_BARS instead of building the map
# pinned by: tests/state/midi-file.test.ts

Scenario: A track name is cut and cleaned (REQ-a-midi-file-is-bounded)
# pinned by: tests/state/midi-file.test.ts

Scenario: Bars follow a meter change (REQ-bars-follow-the-file-meter)
  Given 4/4 for two bars, then 3/4
  Then bar 3 starts at 2 × 4 quarters and is 12 sixteenths long
# pinned by: tests/state/midi-file.test.ts

Scenario: Eighth-note material suggests two bars per bank (REQ-the-grid-is-the-coarsest-that-holds-every-onset)
  Given every onset on an eighth in 4/4
  Then the grid is 2 divisions, labelled 1/8, and the suggestion names seq.rate 1/8 and 2 bars per bank
  And one onset on a sixteenth makes it 4 (1/16), one on a triplet eighth makes it 6, an odd tick makes it free
# pinned by: tests/state/midi-file.test.ts

Scenario: Channel 10 is reported as drums with the websynth mapping (REQ-the-analysis-names-the-parts)
  Given notes 36, 38 and 42 on channel 10
  Then the channel's instrument is drums and the drums map them to kick, snare and chat
# pinned by: tests/state/midi-file.test.ts

Scenario: The listing is windowed and says where to continue (REQ-the-listing-is-a-window-of-bars)
  Given a file longer than MAX_MIDI_SUMMARY_BARS
  Then the listing stops at the cap, truncated is true and nextBar is the following bar
  And a channels filter lists only those channels
# pinned by: tests/state/midi-file.test.ts

Scenario: Repeated bars are grouped despite different releases (REQ-repeats-are-grouped)
  Given bars 1 and 3 with the same onsets and pitches but one note held twice as long in bar 3
  And bar 2 with one pitch changed
  Then bars 1 and 3 form one repeat group, bar 2 is in none, and distinctBars.all is 2
# pinned by: tests/state/midi-file.test.ts
```

## Tests & verification

- Unit: `tests/state/midi-file.test.ts` — files built byte by byte by a small SMF
  writer inside the test; no binary fixture is checked in. `npm test`.
- Through the tool: `tests/mcp/tools.test.ts` (mcp-server.md).
- Typecheck: `npm run typecheck`.

## Open questions / future

- An in-app **Import MIDI** that drafts banks from this analysis — the parser is
  in `src/state/` for that reason, but drafting an arrangement is a judgement
  call this spec deliberately leaves to the agent.
- Key-signature meta (`59`) is skipped; the grid and listing don't need it.

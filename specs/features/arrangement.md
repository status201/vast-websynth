# Arrangement (chain lanes)

```yaml
id: arrangement
status: implemented
version: 6   # v6: the bar is barTicks, not 16 (REQ-10) — meter.md
             # v5: per-slot transpose on the seq lane (REQ-8) — SongFile v7
owner: core
related:
  - architecture
  - transport
  - banks
  - song-mode
  - arrangement-rest
  - midi-clock-sync
  - transport-position
source:
  - src/audio/transport/arrangement.ts
  - src/state/patterns.ts
  - src/ui/panels/song-panel.ts
```

Four independent chain lanes (sequencer / drums / sampler / motion) that sequence
[banks](banks.md) into a song, one bank per bar. The motion lane drives the
[motion sequencer](motion-sequencer.md) (param automation, not audio) and behaves
identically to the audio lanes here.

## Background / Why

A song is built by ordering banks: e.g. `A A B A` → `[0,0,1,0]`. Each machine has
its own lane, advancing one slot per bar so the three can have different lengths
and phrasings. The lane chooses the **play bank** the machine reads; a *disabled*
lane simply tracks that machine's UI edit bank (bar-quantised), so turning a chain
off falls back to live editing. It is constructed **before** the machines so its
tick listener settles the play banks first.

## Requirements

- **REQ-1** — Lanes `seq`/`drum`/`sampler`/`motion`, each `{ enabled, steps: bankIndex[] }`.
- **REQ-2** — Advance one slot per bar (`step % SEQ_LENGTH === 0`); wrap on the
  lane length.
- **REQ-3** — A disabled lane's play bank follows that machine's edit bank.
- **REQ-4** (v3) — On `clock.onStart`, **seek** each lane to the bar implied by
  `clock.step` rather than always zeroing: `bar = floor(clock.step /
  SEQ_LENGTH)`, `pos = enabled && steps.length ? bar % steps.length : 0`, and
  `expectFirstBar = clock.step % SEQ_LENGTH === 0` (so a bar-aligned start
  suppresses the first boundary's increment, and a mid-bar start lets the next
  boundary — genuinely the next bar — increment). The `expectFirstBar` branch in
  `onTick` no longer re-zeros positions (onStart already set them). With a plain
  `start()` (`clock.step === 0`) this is **bit-identical to v2**: bar 0, pos 0,
  first bar plays slot 0. The nonzero case supports MIDI/WiFi clock-sync's
  Song-Position seek ([midi-clock-sync.md](midi-clock-sync.md) REQ-10). The
  Arrangement stores its ctor's `clock` to read `clock.step` in `onStart`.
- **REQ-5** — Constructed before the step machines so play banks are settled before
  the machines read them on the same tick.
- **REQ-6** — A chain step may be the `REST` sentinel (an always-empty bar); an
  enabled lane whose current step is `REST` exposes `*Resting = true` and its machine
  plays silence for that bar. See [arrangement-rest.md](arrangement-rest.md).
- **REQ-7** (v4) — **A mid-play seek re-seeks every lane.** REQ-4's body is
  extracted into `seekTo(step)` and called from **both** `clock.onStart` (as
  `seekTo(clock.step)`, unchanged behaviour) and the new `clock.onSeek`
  ([transport](transport.md) REQ-6). Without it, lane positions — which advance
  `+1` per bar line and are never derived from `clock.step` — end up off by
  (bars jumped − 1), and a seek landing exactly on a bar line double-advances,
  because `expectFirstBar` was not re-armed. The Arrangement subscribes `onSeek`
  in its constructor, so — like `onTick` — it runs before the machines'
  (REQ-5) and the play banks are settled by the time they read them.

- **REQ-8** (v5) — **A seq-lane slot carries a transpose.** `ChainLane` gains
  `transpose: number[]`, a **parallel** array of semitone offsets, one per slot,
  `0` meaning "as written". `seqTranspose` exposes the current slot's offset and
  the [sequencer](sequencer.md) adds it to every note it triggers (REQ-16 there).

  **Why the format needed this.** A chain slot was a bare bank index, and there
  are four banks of sixteen steps, so **four bars was the entire melodic
  vocabulary of any song** — a four-chord progression consumed every bank and
  left nothing for a variation. The strain shows in the shipped corpus: the
  `Nocturne` demo spends *both* of its motion automation tracks on
  `seq.t2.mute` / `seq.t3.mute` to fake instrumentation changes, using the
  parameter-automation machine as an arranger because there was not one. One bank
  plus `A A+5 A+7 A+3` is now a whole progression. Per-pattern transpose is the
  standard groove-box answer (Elektron, Roland MC, Polyend Tracker).

  Bounds and shape:
  - Offsets are integers in `±MAX_CHAIN_TRANSPOSE` (24 — two octaves, matching
    the `drum.t*.tune` range already in the registry).
  - `transpose` is **parallel to `steps`, not a field on each step**: `steps`
    keeps its exact `number[]` meaning, so every v1–v6 file round-trips through
    `compactSongForExport` byte-identically and no reader of `steps` changes.
  - It is **normalized to `steps.length`** on every write — padded with `0`,
    truncated when the chain shrinks — so the two arrays cannot drift. A slot
    added by any existing path therefore starts at `0`, i.e. a no-op (ADR-006's
    reasoning applied to a structural field).
  - **`seqChain` only.** Drums and sampler are unpitched (there is no per-slot
    sampler pitch to shift) and the motion lane carries parameters, not notes.
    A `transpose` on those lanes would be a control that does nothing — exactly
    the class of defect this stage set out to remove. The other three lanes
    accept the field structurally (one `ChainLane` type) and ignore it.
  - A `REST` slot's offset is meaningless but harmless; it is preserved rather
    than zeroed, so toggling a slot between rest and a bank does not lose the
    transpose the user set.

- **REQ-9** (v5) — **Transposition is applied at trigger, never to stored data.**
  The offset shifts the note the sequencer *plays*; `PatternStore` is untouched.
  So switching a slot's transpose can never damage a bank, and turning the chain
  off returns the bank to sounding exactly as written. The transposed note is
  clamped to `MIDI_NOTE_MIN..MAX` ([untrusted-input](untrusted-input.md) REQ-4)
  — a clamp, not a skip, because dropping notes at the edge of the range would
  make a transposed bar silently lose part of its line.

- **REQ-10** (v6) — **A bar is `barTicks`, not 16.** The bar line is
  `step % barTicks === 0` and a seek resolves `floor(step / barTicks)`, where
  `barTicks` comes from the meter ([meter](meter.md) REQ-6) and defaults to 16 —
  so a chain in 4/4 is bit-identical to v5. `setBarTicks` re-bases through the
  same `seekTo` a playhead jump uses (REQ-7): a meter change moves every bar
  line, and lane positions counted against the old grid are stale the moment it
  does. The four lanes still share one bar grid; per-lane *loop* lengths live on
  the machines instead ([meter](meter.md) REQ-10), which is what closes the
  "Open questions" note below.

## Technical design

### Contract / public interface

```yaml
Arrangement:  # src/audio/transport/arrangement.ts
  seq / drum / sampler / motion: ChainLane { enabled, steps: number[], transpose: number[] }
  seqPlayBank / drumPlayBank / samplerPlayBank / motionPlayBank: number   # read by the machines
  seqResting / drumResting / samplerResting / motionResting: boolean      # rest slot -> silence (arrangement-rest.md)
  seqTranspose: number      # v5: the CURRENT slot's semitone offset (0 when disabled/resting)
  setSeqChain(steps, enabled, transpose?) / setDrumChain(...) / setSamplerChain(...) / setMotionChain(...)
  seekTo(step): void        # v4: re-seek every lane to floor(step/SEQ_LENGTH),
                            # re-arm expectFirstBar, recompute + notify
  onChange(fn) -> unsubscribe
  # subscribes clock.onStart (seekTo(clock.step)) + clock.onSeek (v4)
  #          + clock.onTick (advance per bar)
ChainLane: { enabled: boolean, steps: number[], transpose: number[] }
  # steps ∈ { REST, 0..BANK_COUNT-1 }; transpose ∈ ±MAX_CHAIN_TRANSPOSE, same length as steps

# src/state/limits.ts
MAX_CHAIN_TRANSPOSE = 24    # ±2 octaves, matching drum.t*.tune's range
```

### Gesture inventory — a chain chip (ADR-014)

The chip already had one job (select a slot). Transpose is its second, so every
gesture it can receive is decided here, including the ones left unused.

| Gesture                | Outcome                                          | Precedent |
| ---------------------- | ------------------------------------------------ | --------- |
| tap / click            | select / deselect the slot (**unchanged**)       | existing |
| wheel over a chip      | ±1 semitone, **seq lane only**                   | `recipes/design-an-interaction.md`'s own worked example; Elektron per-pattern transpose |
| double-click a chip    | reset that slot to `+0`                          | knob double-tap resets to the loaded value (README → Controls) |
| `−` / `+` in the controls row | ±1 semitone on the selected slot; the **touch-reachable** path, since wheel is desktop-only and this app ships as an Android/iOS PWA | the row's existing `◀ ▶ ✕ Clear` idiom |
| Shift + wheel          | — Shift means **finer** everywhere here (knobs, motion pads) and a semitone is already the finest step; making it mean *coarser* would invert the app's own convention | — |
| drag a chip            | — reorder is `◀`/`▶`; a drag would fight selection | — |
| long-press / right-click | — nothing left to open; the chip has no third job | — |
| `Delete` / `⌫`         | — `✕` removes the selected slot. The step grids bind Delete to *clear a step*, a different object; binding it here to a different outcome would break law 2 | — |

Non-seq lanes receive **no** transpose gesture at all — not a disabled control, an
absent one — because there is nothing for it to do there (REQ-8).

### Layer touchpoints & ordering

```yaml
construction (engine): new Arrangement(patterns, clock) BEFORE
  new StepSequencer/DrumMachine/SamplerMachine
why: Arrangement.clock.onTick runs first -> *PlayBank settled before machines read
machines read: patterns.seqBank(arrangement.seqPlayBank) etc. each tick
bank clamp: clampBank -> 0..BANK_COUNT-1
transpose:   seq only. StepSequencer reads arrangement.seqTranspose at trigger
             time and shifts the note it plays (sequencer.md REQ-16); the stored
             SeqStep is never rewritten (REQ-9)
ui: src/ui/panels/song-panel.ts buildChainLane(...) -> setSeqChain/ setDrumChain/ setSamplerChain
persistence: captured/applied as ChainData in the SongFile (see song-mode.md)
```

## Scenarios (BDD)

```gherkin
Scenario: A chain plays banks bar by bar
  Given seqChain = { enabled: true, steps: [0,0,1,0] }
  When the transport plays 4 bars from the top
  Then the seq play bank is A, A, B, A across the four bars
# pinned by: tests/audio/transport/arrangement.test.ts

Scenario: A disabled lane follows the edit bank (edge)
  Given drumChain.enabled is false and the user edits drum bank C
  Then drumPlayBank tracks C (bar-quantised)
# pinned by: tests/audio/transport/arrangement.test.ts

Scenario: Positions reset on a plain start (v3 regression)
  When the transport restarts from step 0
  Then every lane plays its slot 0 on the first bar (bit-identical to v2)
# pinned by: tests/audio/transport/arrangement.test.ts

Scenario: A nonzero start seeks to the implied bar (v3)
  Given seqChain = { enabled: true, steps: [0,1,2] }
  When the clock starts from a bar-aligned nonzero step (bar 2)
  Then the seq lane plays slot 2 immediately and advances to slot 0 (wrap) next bar
  And a mid-bar nonzero start seeks to that bar and increments on the next boundary
# pinned by: tests/audio/transport/arrangement.test.ts

Scenario: A mid-play seek re-seeks the lanes (v4)
  Given seqChain = { enabled: true, steps: [0,0,1,0] } and the transport is playing
  When the clock is seeked to bar 2
  Then seqPlayBank is B immediately, and A on the next bar
# pinned by: tests/audio/transport/arrangement.test.ts

Scenario: A seek onto a bar line does not double-advance (v4, edge)
  Given an enabled chain and a seek to an exactly bar-aligned step
  Then that bar plays the slot the seek implies (expectFirstBar re-armed)
  And the NEXT bar line advances it by exactly one
# pinned by: tests/audio/transport/arrangement.test.ts

Scenario: One bank becomes a progression (v5, REQ-8)
  Given seqChain = { steps: [0,0,0,0], transpose: [0,5,7,3] } and bank A holds a line
  When the transport plays four bars
  Then bar 1 sounds as written and bars 2-4 sound 5, 7 and 3 semitones higher
  And bank A's stored notes are unchanged (REQ-9)
# pinned by: tests/audio/transport/arrangement.test.ts, tests/audio/transport/sequencer.test.ts

Scenario: transpose is kept the same length as steps (v5, REQ-8, edge)
  Given a chain of 4 slots with transposes [0,5,7,3]
  When setSeqChain is called with 2 steps
  Then transpose is [0,5] — truncated, never left longer than steps
  And growing the chain pads with 0, so a new slot is always a no-op
# pinned by: tests/audio/transport/arrangement.test.ts

Scenario: A transposed note stays inside the MIDI range (v5, REQ-9, edge)
  Given a step at note 120 and a slot transpose of +24
  Then the note sounds at 127, clamped — not dropped, and never out of range
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: A note tied across a bar line releases at the pitch it started (v5, REQ-9, edge)
  Given a step tied into the next bar, whose slot transposes differently
  When the bar line passes
  Then the ringing note is released at ITS OWN pitch, leaving no stuck voice
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: A pre-v7 song loads with every slot at +0 (v5, ADR-007)
  Given a v6 song file with no transpose arrays
  When it is loaded
  Then every seq slot transposes by 0 and the song sounds exactly as it did
# pinned by: tests/state/song.test.ts
```

## Tests & verification

- `tests/audio/transport/arrangement.test.ts`, `tests/audio/transport/sequencer.test.ts`
  (REQ-8/REQ-9), `tests/state/song-author.test.ts` (the `A+5` grammar),
  `e2e/song.spec.ts`, `e2e/chain-transpose.spec.ts` (the gesture inventory).
- `npm test` / `npm run e2e`.
- **By ear** ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md)):
  transpose changes what the instrument plays, and no test can tell you whether a
  progression is musical. Chain `A A+5 A+7 A+3` over a bank, play it, and listen
  for two things a green suite cannot catch — a tie across a bar line that clicks
  or hangs, and a bar that clamps at the top of the range.

## Open questions / future

- ~~Lanes share one bar grid (`SEQ_LENGTH`)~~ — they still share one grid, but it
  is now `barTicks` (REQ-10). Per-lane *phrasing* against that grid is a machine
  concern, not a chain one: [meter](meter.md) REQ-10 gives each machine its own
  loop length, which is the polymeter the note was reaching for.
- Per-**bank** or per-chain-slot meter (a song that changes signature mid-song)
  is still open; the advance math would have to integrate bar lengths rather
  than divide by one.

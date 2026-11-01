# Arrangement (chain lanes)

```yaml
id: arrangement
status: implemented
version: 10
owner: core
related:
  - architecture
  - transport
  - banks
  - song-mode
  - arrangement-rest
  - midi-clock-sync
  - transport-position
  - meter
source:
  - src/audio/transport/arrangement.ts
  - src/state/patterns.ts
  - src/ui/panels/song-panel.ts
```

Four independent chain lanes (sequencer / drums / sampler / motion) that sequence
[banks](banks.md) into a song, one bank per bar. The motion lane drives the
[motion sequencer](motion-sequencer.md) (automation, not audio) and behaves like the
others here.

## Background / Why

A song is an ordering of banks: `A A B A` → `[0,0,1,0]`. Each machine has its own lane,
advancing one slot per bar, so lanes can differ in length and phrasing. The lane picks
the **play bank** its machine reads; a *disabled* lane tracks that machine's UI edit
bank (bar-quantised), so turning a chain off falls back to live editing.

## Requirements

- **REQ-a-lane-is-enabled-plus-bank-steps** — Lanes `seq`/`drum`/`sampler`/`motion`,
  each `{ enabled, steps: bankIndex[], transpose: number[] }`.
- **REQ-a-chain-advances-one-slot-per-bar** — A lane advances one slot per bar line
  (`step % barTicks === 0`, REQ-an-arrangement-bar-is-bar-ticks) and wraps on its
  length.
- **REQ-a-disabled-lane-follows-the-edit-bank** — A disabled lane's play bank follows
  that machine's edit bank.
- **REQ-start-seeks-every-lane** (v3) — On `clock.onStart` each lane is **seeked** to
  the bar implied by `clock.step`: `bar = floor(step / barTicks)`, `pos = enabled &&
  steps.length ? bar % steps.length : 0`, and `expectFirstBar = step % barTicks === 0`,
  so a bar-aligned start does not increment on its first boundary and a mid-bar start
  increments on the next one. A plain `start()` plays slot 0 first. This is what
  sync's Song Position join relies on ([midi-clock-sync](midi-clock-sync.md)
  REQ-song-position-pointer-jumps-the-slave).
- **REQ-arrangement-is-built-before-the-machines** — It is constructed before the step
  machines, so its `onTick` / `onSeek` listeners run first and the play banks are
  settled before the machines read them on the same tick.
- **REQ-a-chain-step-may-be-a-rest** — A step may be the `REST` sentinel; an enabled
  lane on a `REST` step exposes `*Resting = true` and its machine is silent for that
  bar ([arrangement-rest](arrangement-rest.md)).
- **REQ-a-mid-play-seek-re-seeks-every-lane** (v4) — `seekTo(step)` holds
  REQ-start-seeks-every-lane's body and runs from both `clock.onStart` and
  `clock.onSeek` ([transport](transport.md) REQ-seek-moves-a-running-clock). Lane
  positions advance `+1` per bar line and are not derived from `clock.step`, so
  without it a seek leaves them off by (bars jumped − 1), and one landing on a bar line
  double-advances.
- **REQ-a-seq-slot-carries-a-transpose** (v5) — A seq slot carries a semitone offset:
  `transpose: number[]`, **parallel** to `steps`, `0` = as written. `seqTranspose` is
  the current slot's offset, which the [sequencer](sequencer.md) adds to every note it
  triggers (REQ-every-note-is-shifted-by-the-slot-transpose). One bank plus `A A+5 A+7
  A+3` is a progression, the groovebox answer (Elektron, MC, Polyend) to a chain of
  bare bank indexes.
  - Offsets are integers in `±MAX_CHAIN_TRANSPOSE` (24, matching `drum.t*.tune`).
  - Parallel, not a field per step, so `steps` keeps its `number[]` meaning and old
    files round-trip through `compactSongForExport` unchanged.
  - **Normalized to `steps.length`** on every write (padded with 0, truncated), so a
    new slot starts as a no-op (ADR-006).
  - **`seqChain` only.** Drums, sampler and motion accept the field structurally and
    ignore it; they get no transpose control at all.
  - A `REST` slot's offset is preserved, so toggling rest ↔ bank keeps it.
  - A write that omits `transpose` keeps the lane's offsets, fitted to the new
    length (right for the Chain toggle and reorders). **New and a lane's Clear pass
    `transpose: [0]` explicitly**, or a reset chain keeps slot 1's old offset.
- **REQ-transposition-is-applied-at-trigger** (v5) — The offset shifts the note the
  sequencer *plays*; `PatternStore` is never rewritten, so turning the chain off
  returns the bank as written. The note is **clamped**, not dropped, to
  `MIDI_NOTE_MIN..MAX` ([untrusted-input](untrusted-input.md)
  REQ-payload-values-are-bounded).
- **REQ-an-arrangement-bar-is-bar-ticks** (v6) — The bar is `barTicks` from the meter
  ([meter](meter.md) REQ-bar-ticks-is-the-arrangement-bar-line), default 16.
  `setBarTicks` re-bases through `seekTo`, since a meter change moves every bar line.
  The four lanes share one bar grid; per-lane loop lengths live on the machines
  ([meter](meter.md) REQ-each-machine-has-a-loop-length). A lane whose loop spans whole
  bars takes slot 0 as its phase origin via `loopTicks` ([meter](meter.md)
  REQ-a-multi-bar-lane-restarts-with-its-chain).
- **REQ-a-chip-is-dragged-to-its-place** (v7) — Dragging a chip between two others
  reorders the lane, on all four lanes.
  - The drag **moves** the slot (a splice). A one-position move equals `◀`/`▶`'s swap,
    so the two routes agree.
  - The slot's `transpose` travels with it. A drag commits **one**
    `set*Chain(steps, enabled, transpose)` call on drop, never one per frame.
  - Selection follows the moved slot.
  - A press becomes a drag only past the 6 px slop (`grid-gestures.ts`'s); under it it
    is a tap and selects.
  - A drop outside the lane's chip row, or a cancelled pointer, writes nothing; a drag
    never reaches another lane.
  - `◀`/`▶` stay, as the precise path that needs no pointing at a 28 px target.
- **REQ-a-chip-says-three-things-three-ways** (v7) — One channel per fact, so they
  compose (a transposed slot can be selected and playing at once):

  | Fact | Nature | Channel |
  | --- | --- | --- |
  | playing | transient | filled background + glow (`--accent`) |
  | selected | transient | border (`--accent-secondary`) |
  | transposed | intrinsic to the data | label colour + background tint (`--accent-good`) |

  Deliberate: don't give two facts one channel (selected and transposed once both set
  the border, so a transposed slot looked selected). Colour is never the only carrier
  ([machine-status](machine-status.md)): the offset is written on the chip (`A+5`) and
  in its `title`.
- **REQ-an-edit-keeps-the-lane-on-its-bar** (v9) — Editing a chain does not move the
  lane's playhead; it travels with its **slot**, as the transpose does.
  - Each edit passes `origin`: for every new slot, the index it held before, or `-1`
    if added. The caller builds it by applying its own splice/swap to an index array;
    nothing is inferred by comparing chains (ambiguous for `A A B A`).
  - The new position is the index whose `origin` is the old position, so appending or
    transposing leaves it, and moving the playing slot moves it.
  - If the playing slot is **removed**, the lane goes to the slot that followed it
    (wrapping to slot 1).
  - **No `origin`** means a replacement and resets to slot 1: song load, New, Clear,
    the Chain toggle, the engine's render pass.
  - A disabled lane's position stays 0.

## Technical design

### Contract / public interface

```yaml
Arrangement:  # src/audio/transport/arrangement.ts
  new Arrangement(patterns: PatternStore, clock: TickSubscriber)
  seq / drum / sampler / motion: ChainLane
  seqPlayBank / drumPlayBank / samplerPlayBank / motionPlayBank: number   # read by the machines
  seqResting / drumResting / samplerResting / motionResting: boolean      # rest slot -> silence
  seqTranspose: number      # the current slot's semitone offset (0 when disabled/resting)
  setSeqChain(steps, enabled, transpose?, origin?) / setDrumChain(steps, enabled, origin?)
  setSamplerChain(steps, enabled, origin?) / setMotionChain(steps, enabled, origin?)
                            # origin[i] = the pre-edit index of new slot i (-1 = added);
                            # given, the playhead follows its slot; omitted, it resets to 0
  seekTo(step): void        # re-seek every lane to floor(step / barTicks),
                            # re-arm expectFirstBar, recompute + notify
  setBarTicks(ticks): void  # from the meter; re-bases through seekTo
  songBars(lanes?): number  # longest ENABLED lane (transport-window.md)
  loopTicks(lane): number   # steps.length × barTicks, 0 when not chained (meter.md)
  chainReferences(lane, bank): boolean   # banks.md REQ-a-bank-is-removed-only-when-unused
  onChange(fn) -> unsubscribe
  # subscribes clock.onStart / clock.onSeek (seekTo(clock.step)) + clock.onTick (advance per bar)
ChainLane: { enabled: boolean, steps: number[], transpose: number[] }
  # steps ∈ { REST } ∪ 0..(that machine's bank count - 1); transpose ∈ ±MAX_CHAIN_TRANSPOSE,
  # same length as steps. The bound is PER LANE (banks.md REQ-bank-index-clamps).

# src/state/limits.ts
MAX_CHAIN_TRANSPOSE = 24    # ±2 octaves, matching drum.t*.tune's range
```

### Gesture inventory — a chain chip (ADR-014)

| Gesture | Outcome | Precedent |
| --- | --- | --- |
| tap / click | select / deselect the slot (a press under the 6 px slop) | existing |
| wheel over a chip | ±1 semitone per notch, **seq lane only**, by distance ([wheel-steps](wheel-steps.md) REQ-a-wheel-gesture-steps-by-distance) | Elektron per-pattern transpose |
| double-click a chip | reset that slot to `+0` | knob double-tap reset |
| `−` / `+` in the controls row | ±1 semitone on the selected slot; the touch path | the row's `◀ ▶ ✕ Clear` idiom |
| Shift + wheel | — Shift means *finer* everywhere, and a semitone is already the finest step | — |
| drag a chip | reorder the lane (REQ-a-chip-is-dragged-to-its-place) | DAW playlist reorder (Ableton, FL, Bitwig) |
| long-press / right-click | — the chip has no third job | — |
| `Delete` / `⌫` | — `✕` removes the slot; Delete clears a *step* on the grids, a different object (law 2) | — |

Non-seq lanes get **no** transpose gesture: absent, not disabled.

### Layer touchpoints & ordering

```yaml
construction (engine): new Arrangement(patterns, clock) BEFORE the machines
  (REQ-arrangement-is-built-before-the-machines)
machines read: patterns.seqBank(arrangement.seqPlayBank) etc. each tick
bank clamp: clampChainStep(step, patterns.bankCount(lane)) -> 0..count-1 (or REST);
            the count argument is REQUIRED (ADR-022)
transpose: seq only. StepSequencer reads arrangement.seqTranspose at trigger time
           (sequencer.md REQ-every-note-is-shifted-by-the-slot-transpose)
ui: src/ui/panels/song-panel.ts buildChainLane(...) -> set*Chain
reorder: src/ui/components/chip-reorder.ts attachChipReorder({ chips, onReorder }),
         one controller for all four lanes, re-attached by renderStructure() and disposed
         before each rebuild. It reports intent only and never reorders the DOM, so a drop
         and the onChange repaint cannot disagree.
persistence: ChainData in the SongFile (song-mode.md)
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

Scenario: Positions reset on a plain start (regression)
  When the transport restarts from step 0
  Then every lane plays its slot 0 on the first bar
# pinned by: tests/audio/transport/arrangement.test.ts

Scenario: A nonzero start seeks to the implied bar (REQ-start-seeks-every-lane)
  Given seqChain = { enabled: true, steps: [0,1,2] }
  When the clock starts from a bar-aligned nonzero step (bar 2)
  Then the seq lane plays slot 2 immediately and advances to slot 0 (wrap) next bar
  And a mid-bar nonzero start seeks to that bar and increments on the next boundary
# pinned by: tests/audio/transport/arrangement.test.ts

Scenario: A mid-play seek re-seeks the lanes (REQ-a-mid-play-seek-re-seeks-every-lane)
  Given seqChain = { enabled: true, steps: [0,0,1,0] } and the transport is playing
  When the clock is seeked to bar 2
  Then seqPlayBank is B immediately, and A on the next bar
# pinned by: tests/audio/transport/arrangement.test.ts

Scenario: A seek onto a bar line does not double-advance (REQ-a-mid-play-seek-re-seeks-every-lane, edge)
  Given an enabled chain and a seek to an exactly bar-aligned step
  Then that bar plays the slot the seek implies (expectFirstBar re-armed)
  And the NEXT bar line advances it by exactly one
# pinned by: tests/audio/transport/arrangement.test.ts

Scenario: One bank becomes a progression (REQ-a-seq-slot-carries-a-transpose)
  Given seqChain = { steps: [0,0,0,0], transpose: [0,5,7,3] } and bank A holds a line
  When the transport plays four bars
  Then bar 1 sounds as written and bars 2-4 sound 5, 7 and 3 semitones higher
  And bank A's stored notes are unchanged (REQ-transposition-is-applied-at-trigger)
# pinned by: tests/audio/transport/arrangement.test.ts, tests/audio/transport/sequencer.test.ts

Scenario: transpose is kept the same length as steps (REQ-a-seq-slot-carries-a-transpose, edge)
  Given a chain of 4 slots with transposes [0,5,7,3]
  When setSeqChain is called with 2 steps
  Then transpose is [0,5] — truncated, never left longer than steps
  And growing the chain pads with 0, so a new slot is always a no-op
# pinned by: tests/audio/transport/arrangement.test.ts

Scenario: New and Clear chain reset the transpose (REQ-a-seq-slot-carries-a-transpose, regression)
  Given a seq chain [A, B] with transposes [+5, +7]
  When the user confirms Clear on the seq lane, or New on the Song tab
  Then the chain is [A] at +0, not [A] at +5
# pinned by: tests/ui/song-panel-reset-transpose.test.ts

Scenario: A transposed note stays inside the MIDI range (REQ-transposition-is-applied-at-trigger, edge)
  Given a step at note 120 and a slot transpose of +24
  Then the note sounds at 127, clamped — not dropped, and never out of range
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: A note tied across a bar line releases at the pitch it started (REQ-transposition-is-applied-at-trigger, edge)
  Given a step tied into the next bar, whose slot transposes differently
  When the bar line passes
  Then the ringing note is released at ITS OWN pitch, leaving no stuck voice
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: A song without transpose arrays loads with every slot at +0 (ADR-007)
  Given a v6 song file with no transpose arrays
  When it is loaded
  Then every seq slot transposes by 0 and the song sounds exactly as it did
# pinned by: tests/state/song.test.ts

Scenario: A chip is dragged to a new place in the chain (REQ-a-chip-is-dragged-to-its-place)
  Given a chain of A B C D (a four-bank machine)
  When the user drags the D chip and drops it before the B chip
  Then the chain is A D B C, written with ONE setChain call
  And the dropped slot is the selected one
# pinned by: tests/ui/chip-reorder.test.ts, e2e/chain-reorder.spec.ts

Scenario: A dragged slot keeps its transpose (REQ-a-chip-is-dragged-to-its-place)
  Given a seq chain of A A+5 A+7 and the user drags the A+7 chip to the front
  Then the chain reads A+7 A A+5 — the offset moved WITH the slot, not with the
    position, so the progression is reordered rather than rewritten
# pinned by: tests/ui/chip-reorder.test.ts, e2e/chain-reorder.spec.ts

Scenario: A press that does not travel is still a tap (REQ-a-chip-is-dragged-to-its-place, edge)
  Given a chain chip
  When the pointer goes down and up having moved less than the slop threshold
  Then the slot is selected/deselected exactly as before and no reorder happens
# pinned by: tests/ui/chip-reorder.test.ts

Scenario: A cancelled or stray drop writes nothing (REQ-a-chip-is-dragged-to-its-place, edge)
  Given a drag in progress over a chain lane
  When the pointer is cancelled, or released away from every chip in that lane
  Then the chain is unchanged and no setChain call is made
# pinned by: tests/ui/chip-reorder.test.ts

Scenario: A drag never reaches another lane (REQ-a-chip-is-dragged-to-its-place, edge)
  Given the Song tab with all four lanes visible
  When a seq chip is dragged over the drum lane's chips and released
  Then neither chain changes — a bank index means a different bank per machine
# pinned by: tests/ui/chip-reorder.test.ts

Scenario: A transposed chip can still show that it is selected (REQ-a-chip-says-three-things-three-ways)
  Given a seq chain slot at +5, drawn with the transposed label colour
  When the user taps it
  Then it ALSO shows the selection border — the two facts use different
    channels, so neither hides the other
# pinned by: tests/ui/chip-states.test.ts

Scenario: Editing a playing chain keeps the lane on its bar (regression, REQ-an-edit-keeps-the-lane-on-its-bar)
  Given seqChain = { enabled: true, steps: [0,1,2,3] } playing its third slot (pos 2)
  When the user nudges a slot's transpose, or appends a bank
  Then the lane is still on pos 2 and plays the same bank
  When slot 0 is removed
  Then the lane is on pos 1, the same bar, one place earlier
  When the playing slot is dragged to the front
  Then the lane is on pos 0, still playing that bar
  When the playing slot itself is removed
  Then the lane is on the slot that followed it
# pinned by: tests/audio/transport/arrangement.test.ts, e2e/chain-transpose.spec.ts

Scenario: A replacement still resets the lane (REQ-an-edit-keeps-the-lane-on-its-bar, edge)
  Given a playing lane on pos 2
  When the chain is set without an origin (load, New, Clear, Chain toggle)
  Then the lane is on pos 0
# pinned by: tests/audio/transport/arrangement.test.ts
```

## Tests & verification

- `tests/audio/transport/arrangement.test.ts`, `tests/audio/transport/sequencer.test.ts`,
  `tests/state/song-author.test.ts` (the `A+5` grammar), `tests/ui/chip-reorder.test.ts`,
  `tests/ui/chip-states.test.ts`, `e2e/song.spec.ts`, `e2e/chain-transpose.spec.ts`,
  `e2e/chain-reorder.spec.ts` — `npm test` / `npm run e2e`.
- **By ear** (ADR-010): chain `A A+5 A+7 A+3` over a bank and listen for a tie across a
  bar line that clicks or hangs, and a bar that clamps at the top of the range.

## Open questions / future

- Per-bank or per-slot meter (a signature change mid-song): the advance math would have
  to integrate bar lengths rather than divide by one.

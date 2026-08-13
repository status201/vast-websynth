# Chord tools — diatonic writer & chord memory

```yaml
id: chord-tools
status: implemented
version: 1
owner: core
related:
  - architecture
  - scale-quantization
  - sequencer
  - arpeggiator
  - voicing
  - pattern-undo
source:
  - src/utils/music.ts                        # diatonicChord + degreeLabels (pure)
  - src/audio/transport/scale-quantizer.ts    # chord() for the live path
  - src/audio/transport/arpeggiator.ts        # the pool expands through chord memory
  - src/audio/engine.ts                       # keyboard/MIDI passthrough expansion
  - src/state/patterns.ts                     # writeSeqChord (one batched undo entry)
  - src/state/params.ts
  - src/ui/panels/seq-panel.ts                # the CHORD ▾ writer
  - src/ui/panels/key-panel.ts                # chord.voicing
```

Two ways to get real chords out of a one-note-per-step sequencer: an **editor action**
that writes a diatonic chord across the four tracks, and a **live chord memory** that
turns one held key into a chord. Both derive from the key set by
[scale-quantization](scale-quantization.md).

## Background / Why

`SeqStep.note` is a single MIDI integer — there is no chord in the data model and there
does not need to be one. [sequencer](sequencer.md) REQ-8 already added **four tracks per
bank** with the explicit intent that "a bank can hold a chord", and REQ-9 gates tracks
2–4 on poly voicing. So the native chord mechanism already exists; what was missing was
anything that *writes* one. Building the writer on `setSeqStep` instead of a new
`notes?: number[]` field means **no `SongFile` version bump, no `serialize.ts` change,
and no new runtime cost** — a chord is just four tracks that happen to agree.

Chords are built by **stacking scale degrees** (degree `d`, then `d+2`, `d+4`, `d+6`)
rather than from a table of chord qualities. That single rule yields the correct quality
for every degree for free — in a major scale `ii` comes out minor, `V` major and `vii`
diminished, because the scale's own interval pattern produces them — which is both the
cheapest implementation and the most musical one.

## Requirements

- **REQ-1** (chords are stacked scale degrees) — `diatonicChord` takes the chord's root
  *degree* and returns `[d, d+2, d+4, d+6]` in scale-degree space, wrapped by octave.
  There is **no chord-quality table**. For scales with fewer than seven tones
  (pentatonic, blues) the same rule applies — it means "stack every other scale tone",
  which is the honest generalization, not a special case.

- **REQ-2** (the writer patches, it does not replace) — writing a chord at step `i` sets
  `on` and `note` on tracks 1..n and leaves each target step's `velocity`, `gate`,
  `prob`, `ratchet` and `tie` untouched, so a chord written over a shaped step keeps its
  shape. A triad writes three tracks and sets track 4 `on: false` rather than leaving a
  stale fourth note ringing from a previous 7th.

- **REQ-3** (one gesture, one undo) — the writer mutates up to four steps and SNAP
  mutates up to 64, but each is **one** undo entry. Both reuse the existing whole-bank
  shape `{ kind: 'seq-copy', bank, before }` and the `emitMutate`-then-mutate-in-place
  idiom already used by `clearSeqCells` ([pattern-undo](pattern-undo.md)). Emitting one
  entry per cell would make a single click cost four Ctrl+Z.

- **REQ-4** (the store stays free of music theory) — `PatternStore.writeSeqChord(index,
  notes)` and `snapSeqBank(map)` take **plain data**: an array of notes, and a mapping
  function. The theory lives in `src/utils/music.ts` and the caller applies it. This
  keeps the store a data store ([ADR-004](../decisions/adr-004-patternstore-separate-from-parambus.md))
  and lets both operations be unit-tested without a scale.

- **REQ-5** (chord memory is diatonic, so it composes with the quantizer) — the live
  path builds its notes from the scale, so its output is already in-scale and the
  quantizer's pass over it is a no-op by
  [scale-quantization](scale-quantization.md) REQ-3. One code path, and the two features
  provably cannot fight. `chord.voicing` index **0 is `off`**, the no-op default
  ([ADR-006](../decisions/adr-006-no-op-param-defaults.md)); the off-switch is folded
  into the param rather than carried as a separate `chord.on`, following the
  `LFO_DEST_LABELS` idiom.

- **REQ-6** (chord memory reaches the arp) — the arp is driven by `bus.onNote` and does
  **not** route through the engine's passthrough ([arpeggiator](arpeggiator.md) REQ-1),
  so expansion happens in *both* consumers: the engine's passthrough and the arp's pool
  build, at the same place the `n + o * 12` octave stacking already happens. This is
  what lets one finger drive an arpeggiated progression.

- **REQ-7** (mono gates the live path, but not the writer) — while `voicing.mode` is
  mono, chord memory does **not** expand: four notes into one mono voice would sound
  only the last, which is worse than not expanding. The **writer** is not blocked in
  mono — the notes are data, they persist, and [sequencer](sequencer.md) REQ-9 already
  renders tracks 2–4 dimmed with a hint that switching to poly brings them back. Reuse
  that affordance; do not invent a second warning.

- **REQ-8** (both tools require a scale) — while `scale.type` is `chromatic` there are
  no degrees to stack, so the CHORD ▾ control is **disabled with the reason shown** and
  chord memory is inert. A disabled control that says why beats one that silently
  behaves differently in two modes ([ADR-014](../decisions/adr-014-dont-make-me-think.md)).
  Precedent: the LFO panel greys RATE while sync is on.

- **REQ-9** (degree labels show the real quality) — the writer's menu labels each degree
  with its Roman numeral cased by what the stacking actually produced (`I ii iii IV V vi
  vii°` in major, `i ii° III iv v VI VII` in minor) plus the concrete root name. The
  case and the `°` are **derived** from the returned intervals — a 3-semitone third is
  minor, a 6-semitone fifth diminished — not stored per scale, so a scale added to
  `SCALE_LABELS` labels itself correctly with no new data.

- **REQ-10** (the chord lands in the register you are editing) — the chord's root is the
  chosen degree in the octave containing the cursor step's current note, so writing a
  chord does not jump the line an octave. Track 1 takes the root and 2..4 the upper
  tones, ascending.

## Technical design

### Contract / public interface

```yaml
src/utils/music.ts:                                   # pure
  diatonicChord(anchor, root, scale, degrees: readonly number[], base = 0): number[]
#   `degrees` is the DEGREE-OFFSET array (e.g. [0,2,4] for a triad), not a count —
#   callers pass chordDegrees(voicing) or a literal. Returns notes ascending.
  degreeLabel(root, scale, degree): string                 # 'ii — Dm', cased per REQ-9

src/audio/transport/scale-quantizer.ts:
  ScaleQuantizer.chord(note): number[]   # honours chord.voicing + REQ-7; [note] when inert

src/state/patterns.ts:                                # theory-free (REQ-4)
  writeSeqChord(index: number, notes: readonly number[]): boolean
  snapSeqBank(map: (note: number) => number): boolean
```

### Data shapes (registry)

```yaml
chord.voicing: { discrete, labels: CHORD_LABELS, range: 0..4, default: 0 }  # 'off' = no-op
CHORD_LABELS: ['off', 'triad', '7th', 'sus4', 'power']
# sizes in scale degrees from the chord root:
#   triad -> [0, 2, 4]      7th -> [0, 2, 4, 6]
#   sus4  -> [0, 3, 4]      power -> [0, 4]   (root + 5th degree — two tones)
```

### Gesture inventory — the CHORD ▾ writer and SNAP (ADR-014)

Both controls sit in the seq panel beside the existing `− [C4] +` note stepper, which
already owns wheel for ±1 semitone. Every gesture they can receive is decided here,
including the ones deliberately left unused.

| Gesture | Outcome | Precedent |
| --- | --- | --- |
| tap `CHORD ▾` | open the degree menu | the lane's existing `Clear ▾` menu |
| pick a degree row | write the chord at the cursor step **immediately**, one undo entry | `Clear ▾` rows act on click; no confirm step |
| `Esc` / click-away | close without writing | `clear-menu.ts`, `dropdown.ts` |
| tap `SNAP` | bake the scale into the edit bank, one undo entry, toast with the count changed | the `Undo` button it sits beside |
| hover either while chromatic | the control is disabled and its `title` says a scale must be chosen (REQ-8) | LFO RATE greyed while sync is on |
| wheel | — the adjacent note stepper already means ±1 semitone on wheel; a second, different wheel meaning on a neighbouring control would be ambiguous (law 2) | — |
| double-click | — a single click already commits; a second meaning would be undiscoverable | — |
| drag | — there is nothing to drag; the target is always the grid cursor | — |
| `Delete` / `⌫` | — already bound to *clear the selected step* ([step-grid-editing](step-grid-editing.md)); rebinding it here would break law 2 | — |
| a confirm dialog before SNAP | — deliberately none: it is destructive but **one Ctrl+Z away**, and a dialog on an undoable action is the friction law 4 exists to remove | `Clear ▾` clears a whole bank with no dialog |

### Layer touchpoints & ordering

```yaml
engine (subscribeParams):
  chord.voicing -> quantizer.setChord(round(x))
  voicing.mode  -> quantizer.setPoly(v >= 0.5)     # REQ-7 gate for the live path
live expansion (both consumers, REQ-6):
  engine bus.onNote -> quantizer.chord(note) -> playNote per note; heldIn.set(raw, notes)
  arpeggiator.fire  -> pool built from quantizer.chord(held) before octave stacking
editor:
  seq-panel CHORD ▾ -> diatonicChord(...) -> patterns.writeSeqChord(cursor.selCol, notes)
  seq-panel SNAP    -> patterns.snapSeqBank((n) => quantizer.get(n))
```

### Persistence

`chord.voicing` persists as an ordinary param in the `params` bag — no file-format
change. Chords written by the writer persist as **ordinary step data**, indistinguishable
from hand-entered notes; nothing records that a chord tool produced them, and that is
deliberate — there is no chord object to keep in sync.

## Scenarios (BDD)

```gherkin
Scenario: Writing a degree stacks the right quality (REQ-1, REQ-9)
  Given scale.root is C and scale.type is major
  When the writer writes degree ii as a triad
  Then tracks 1-3 hold D, F and A
  And the menu labelled that degree minor
# pinned by: tests/utils/music.test.ts, tests/state/patterns-chord.test.ts

Scenario: A triad clears the fourth track (REQ-2, edge)
  Given step 0 already holds a 7th chord across four tracks
  When a triad is written at step 0
  Then track 4's step is off, not left ringing the old 7th
# pinned by: tests/state/patterns-chord.test.ts

Scenario: A written chord keeps each step's existing shape (REQ-2)
  Given step 0 on track 2 has velocity 0.3 and ratchet 3
  When a chord is written at step 0
  Then track 2's note and on change, and velocity and ratchet do not
# pinned by: tests/state/patterns-chord.test.ts

Scenario: One chord write is one undo (REQ-3)
  Given a chord is written across four tracks
  When Ctrl+Z is pressed once
  Then all four steps return to their previous state
# pinned by: tests/state/patterns-chord.test.ts

Scenario: Chord memory turns one key into a chord (REQ-5)
  Given scale is C major, chord.voicing is triad and voicing.mode is poly
  When C4 is held
  Then C4, E4 and G4 sound
# pinned by: tests/audio/engine-scale.test.ts

Scenario: Chord memory feeds the arp (REQ-6)
  Given the arp is enabled and chord.voicing is triad
  When one key is held and ticks are dispatched
  Then the arp cycles the chord's notes, not just the held one
# pinned by: tests/audio/transport/arpeggiator.test.ts

Scenario: Mono does not expand chord memory (REQ-7, edge)
  Given voicing.mode is mono and chord.voicing is triad
  When a key is held
  Then exactly one note sounds
# pinned by: tests/audio/engine-scale.test.ts

Scenario: Releasing a chord-memory key releases every note it started (REQ-5, regression)
  Given a chord is sounding from one held key
  When the key is released
  Then all of its notes are released and none hangs
# pinned by: tests/audio/engine-scale.test.ts

Scenario: Both tools are inert without a scale (REQ-8)
  Given scale.type is chromatic
  Then the CHORD ▾ control is disabled and says why
  And chord memory sounds a single note
# pinned by: tests/ui/key-panel.test.ts, tests/audio/engine-scale.test.ts

Scenario: The chord lands in the edited register (REQ-10)
  Given the cursor step holds C5
  When degree I is written
  Then the chord's root is C5, not C3
# pinned by: tests/utils/music.test.ts
```

## Tests & verification

- Unit: `tests/utils/music.test.ts`, `tests/state/patterns-chord.test.ts`,
  `tests/audio/engine-scale.test.ts`, `tests/audio/transport/arpeggiator.test.ts`,
  `tests/ui/key-panel.test.ts` — `npm test`
- E2E: `e2e/key.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`
- **By ear** ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md)) — chord
  quality is exactly the thing a passing test cannot confirm. Render with
  `npm run bench:audio` and listen for whether `ii` and `V` sound like the chords they
  are labelled, against a `chord.voicing: off` baseline.

## Open questions / future

- **Inversions and drop voicings** — the writer is root-position only. A `voicing`
  control (root / 1st / 2nd) would be additive and needs no new data.
- **A plain major triad in `chromatic` is blocked by REQ-8**, since there are no degrees without
  a scale. That is one dropdown away and the panel says so, but if it proves annoying
  the alternative is a fixed-interval fallback — at the cost of a second code path and
  a control that means two different things.

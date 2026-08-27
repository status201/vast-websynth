# Sample chop

```yaml
id: sample-chop
status: implemented
version: 1
owner: core
related:
  - sampler
  - sample-recorder
  - sample-persistence
  - project-export
  - dialog
  - toast
  - untrusted-input
source:
  - src/audio/recorder/buffer-dsp.ts        # sliceEqual / detectOnsets (pure)
  - src/ui/components/record-sound-modal.ts # the chop row, markers, Spread
  - src/audio/transport/sampler-machine.ts  # setBuffer — the one fill path
```

Chop a loaded break into slices and spread them across the sampler's slots, so a
one-bar loop becomes eight playable one-shots on the existing grid.

## Background / Why

The [sampler](sampler.md) plays whole files. A beatmaker's core move is the
opposite: take one long recording, cut it at the transients, and play the pieces
back in a different order. Without it the machine can only replay what it was
given, which is why it is the first thing missing from a sampler that has
everything else.

The [record/edit modal](sample-recorder.md) already owns the hard half — a canvas
waveform from `computePeaks`, draggable selection handles, preview playback,
undo — so chopping is a slice calculation plus a way to place the results.

**Where the slices go is the whole design.** The obvious shape is a per-step slice
index (`SamplerStep.slice`), and it was rejected. `SamplerStep` is exactly
`TriggerCell` today, and splitting the two types costs `serialize.ts`,
`song-validate.ts` and `song-author.ts` a sampler-only branch each — a song-format
change ([ADR-007](../decisions/adr-007-songfile-additive-versioning.md)) — to buy
each slice *less* control than the alternative. Slices go to **slots** instead
(the MPC's "chop to pads"): no format change, no new step field, and every slice
inherits the whole per-slot channel from [sampler](sampler.md) REQ-12/REQ-13 —
pitch it, reverse it, filter it, pan it, trim it further — and is sequenced on the
eight-lane grid that already exists.

## Requirements

- **REQ-1** — **Slices are real, short buffers, one per slot.** Spreading crops the
  audio and hands each piece to `SamplerMachine.setBuffer` — the single fill path
  ([sampler](sampler.md) REQ-6) — so [persistence](sample-persistence.md) and
  [project export](project-export.md) work with no knowledge of chopping.
  Deliberately **not** eight slots sharing one buffer with different start/end
  windows: `SampleAutosave` reconciles by `AudioBuffer` *reference identity*, so
  sharing would write eight copies of the whole break to IndexedDB and eight full
  WAVs into a project zip. Real slices total roughly the original's bytes.

  Slices then persist like any other slot: device-locally through
  [sample-persistence](sample-persistence.md), and — because a *song* stores only
  filenames while a **project zip** stores the audio
  ([project-export](project-export.md)) — a chopped kit travels intact by
  exporting the **project** rather than the song.

- **REQ-2** — **The chop divides the current selection, not the whole file.** The
  modal's rule is already "effects apply to the selection"; chopping follows it, so
  topping and tailing a break before cutting it is the same gesture it always was.

- **REQ-3** — **Two ways to place the cuts, and the markers are draggable after
  either.** `sliceEqual(n)` divides the selection evenly — what a clean one-bar
  loop wants. `detectOnsets` places them at transients — what a live recording
  wants. Neither is trusted to be right: every boundary can be dragged, because an
  onset detector that cannot be corrected is worse than no detector.

- **REQ-4** — **`detectOnsets` is pure and cheap.** Short-time RMS over a mono
  mixdown, peaks in the rising edge above a threshold, with a minimum spacing so a
  snare's body does not register as a second hit. It lives in `buffer-dsp.ts`
  beside `crop`/`normalize` — [sample-recorder](sample-recorder.md) already
  requires new edit operations to be pure and `AudioContext`-free, which is what
  makes this unit-testable against a synthetic click train.


- **REQ-5** — **No slice is ever spread into a slot that isn't there.** Spreading
  starts at the picker's slot and fills forward, so from S5 there is room for
  four. Two things enforce that, and **both are needed**:
  - the count dropdown lists only counts that fit, so an over-long chop cannot be
    *made* from the current slot; and
  - the picker can still **move after** a chop, so the fit is re-checked whenever
    it does. A chop that no longer fits **disables Spread and says why** — it is
    not quietly re-cut, and it is *not* clamped at spread time.

  Filtering the dropdown alone looks sufficient and is not: it left the label
  promising "4 slices → S6–S9" — naming a slot that does not exist — while Spread
  stayed live and wrote three. Refusing is the right answer over re-cutting,
  because the user chose that many slices; dropping the tail and merging it into
  the last slice are the same silent edit in different clothes.

- **REQ-6** — **Spreading is confirmed, then reversible.** It overwrites up to
  eight slots at once, so it asks first ([dialog](dialog.md)) naming what it will
  replace. Afterwards a [toast](toast.md) offers **Undo**, which restores every
  overwritten buffer *and* name together — the same contract
  `samplerSlotClearRow` provides for a single slot, and for the same reason: the
  pattern-undo stack carries steps only, so an audio mutation has to own its own
  reversal.

- **REQ-7** — **Slices are named for their origin.** `amen-break.wav` chopped four
  ways gives `amen-break 1/4` … `amen-break 4/4`, so the grid's row labels say
  what is in them and a saved song's `sampleNames` still describe the material
  after the audio is gone ([sampler](sampler.md) REQ-4).

- **REQ-8** — **A boundary lands at or *before* its onset, never after.** The
  rising-energy signal peaks one analysis frame *into* the attack — the frame
  holding a hit's first samples is only partly loud, so the next one shows the
  bigger jump — and cutting there saws the front off the slice's own transient.
  `detectOnsets` therefore walks back to the foot of the rise, capped at
  `ONSET_BACKOFF_FRAMES` so a slow swell cannot drag the cut into the previous
  slice. The error has to be **signed**: a few ms early costs a slice some lead-in
  silence, a few ms late costs it its attack, and only one of those is still a
  chop. A test asserting "within a few ms" passes either way, which is why the
  ones here assert the direction.

## Technical design

### Contract / public interface

```yaml
# src/audio/recorder/buffer-dsp.ts — pure, AudioContext-free
sliceEqual(a: CapturedAudio, n, from?, to?): number[]
  # n-1 interior boundaries, evenly spaced across [from, to). Never returns the
  # outer edges: a boundary list is what falls BETWEEN slices.
detectOnsets(a: CapturedAudio, opts?): number[]
  # opts: { from, to, maxSlices, minGapMs, threshold }
  # Interior boundaries at rising-energy peaks, same shape as sliceEqual so the
  # two are interchangeable at the call site.
sliceRanges(from, to, bounds): Array<[number, number]>
  # Boundaries -> consecutive [start, end) pairs. One definition, so the drawing,
  # the count and the crop cannot disagree.
```

### Data shapes

```yaml
# Modal-local state (nothing persists — a chop is an edit, not a document)
marks: number[]         # interior boundaries, absolute sample indices, ascending
chopCount: number       # 0 = no chop; else marks.length + 1
# Spread's undo record, held by the toast closure only
prev: Array<{ slot: number; buffer: AudioBuffer | null; name: string | null }>
```

### Layer touchpoints & ordering

```yaml
record-sound-modal.ts:
  chop row (below the cutoff row): Dropdown(counts) · Detect · Spread to slots
  markers drawn by `redraw`, dragged on the canvas — the hit test checks markers
    BEFORE the crop handles, which are separate DOM elements and keep priority
    where they overlap
  Spread: confirmDialog -> crop per range -> setBuffer + setSampleName -> close
          -> showToast({ actionLabel: 'Undo' })
buffer-dsp.ts: sliceEqual / detectOnsets / sliceRanges — no imports beyond types
```

### Persistence

Nothing. Marker positions live only while the modal is open: the *result* of a
chop is eight ordinary slots, and those persist by the routes they already had
([sample-persistence](sample-persistence.md), [project-export](project-export.md)).
Re-chopping needs the original file again, which is the same bargain every other
destructive edit in this modal already makes.

## Scenarios (BDD)

```gherkin
Scenario: Chop a break into four and play the pieces
  Given a 2 s loop is loaded in the editor
  When the user chooses 4 slices and presses Spread to slots
  Then slots 0..3 hold four consecutive quarters of the loop
  And each is named "<base> 1/4" … "<base> 4/4"
# pinned by: tests/audio/buffer-dsp.test.ts, e2e/sample-chop.spec.ts

Scenario: The chop divides the selection, not the file (REQ-2)
  Given the crop handles select the middle half of a recording
  When the user chops it into two
  Then the two slices together are that middle half — the topped and tailed
    audio is not chopped and not spread
# pinned by: tests/audio/buffer-dsp.test.ts

Scenario: Transient detection finds the hits (REQ-4)
  Given a click train with four hits at known offsets
  When detectOnsets runs
  Then it returns boundaries at those offsets and not between them
# pinned by: tests/audio/buffer-dsp.test.ts

Scenario: A boundary never cuts into the attack it marks (REQ-8, regression)
  Given a click train with four hits at known offsets
  When detectOnsets runs
  Then every boundary is at or before its hit, within ~25 ms
# pinned by: tests/audio/buffer-dsp.test.ts

Scenario: A long decay does not register as a second hit (REQ-4, edge)
  Given one hit whose tail rings for half a second
  When detectOnsets runs with the default minimum gap
  Then exactly one onset is reported
# pinned by: tests/audio/buffer-dsp.test.ts

Scenario: The count offered fits the slots remaining (REQ-5, edge)
  Given the slot picker is on S7
  When the chop count dropdown is opened
  Then it offers 2 only — never 8, which would drop six slices on the floor
# pinned by: e2e/sample-chop.spec.ts

Scenario: Moving the picker after a chop refuses rather than truncating (REQ-5, regression)
  Given the selection has been chopped into four
  When the slot picker is moved to S6, which has room for three
  Then Spread is disabled and the row says four slices need four slots
  And the row never names a slot past the last one
  And moving back to a slot with room re-enables it with all four intact
# pinned by: e2e/sample-chop.spec.ts

Scenario: Spreading asks first and can be undone (REQ-6)
  Given slots 0 and 1 already hold samples
  When the user spreads four slices over them and presses the toast's Undo
  Then both slots hold their previous audio and their previous names again
# pinned by: e2e/sample-chop.spec.ts

Scenario: Declining the confirmation changes nothing (REQ-6, edge)
  Given a chop is ready to spread
  When the user cancels the confirmation
  Then every slot is untouched and the modal stays open on the same chop
# pinned by: e2e/sample-chop.spec.ts
```

## Tests & verification

- Unit: `tests/audio/buffer-dsp.test.ts` — `sliceEqual`, `sliceRanges`,
  `detectOnsets` against synthetic material with known onsets.
- E2E: `e2e/sample-chop.spec.ts` — the chop row, the fitted count, spread, its
  confirmation and its undo.
- **By ear** ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md)): a chop
  is only right if the slices *start on the hit*. Render one with
  `npm run bench:audio -- --sample <break.wav> --slot 0 --hits 4` and listen for a
  clipped attack or a leading fragment of the previous hit — neither shows up in a
  passing test.

## Open questions / future

- **Chop at the grid** — dividing by the song's bar rather than by a count, so a
  break recorded at another tempo lands on the meter.
- **Per-step slice choice** — rejected for v1 (see Background); revisit only with
  a reason that outweighs a song-format change.
- **Re-chop without re-loading** — the original is discarded once slices are
  spread. Keeping it would mean holding a second copy of every chopped break.

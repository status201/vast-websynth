# Pattern banks (A–H)

```yaml
id: banks
status: implemented
version: 6   # v6: a machine owns its own bank count, 4..8, and the count IS the array
             #     length (REQ-a-machine-owns-its-bank-count, ADR-022)
             # v5: a bank stores 16 cells whatever the meter plays (REQ-bank-always-stores-sixteen-cells)
             # v4: the per-bank content dot is specified (REQ-content-dot-covers-every-lane) — it must count
             #     every lane the machine stores in that bank
owner: core
related:
  - architecture
  - sequencer
  - drum-machine
  - sampler
  - motion-sequencer
  - arrangement
source:
  - src/state/patterns.ts
  - src/ui/components/bank-bar.ts
  - src/ui/panels/step-panel-scaffold.ts
  - src/ui/panels/*-panel.ts
```

Four to eight banks per machine, each machine counting independently, with the
**edit bank vs play bank** split that lets you arrange/perform one pattern while
editing another.

## Background / Why

`PatternStore` holds banks for the sequencer, drums, sampler and motion. The UI
always edits the **edit bank**; the transport always plays the **play bank**,
which the [arrangement](arrangement.md) chooses and which may differ. That
separation is what makes live pattern switching and song chains possible without
the editor and the playhead fighting over one buffer.

The count was fixed at four, and four was tight enough to distort the design
around it. [arrangement](arrangement.md) REQ-a-seq-slot-carries-a-transpose says so directly — "four bars was the
entire melodic vocabulary of any song" — and [arrangement-rest](arrangement-rest.md)
REQ-rest-is-a-negative-sentinel exists so a lane can sit out a bar without spending one of the four.
Both are good features that were reached for partly because banks were scarce.
v6 removes the scarcity: a machine starts at four and the user adds a fifth
through an eighth on demand, per machine. Nothing about a four-bank song changes
— not its bytes, not its behaviour (ADR-022).

## Requirements

- **REQ-a-machine-exposes-edit-and-play-banks** — `seq`/`drum`/`sampler`/`motion`
  getters expose the edit bank; `seqBank(i)`/`drumBank(i)`/`samplerBank(i)`/
  `motionBank(i)` expose any bank for playback.
- **REQ-set-edit-bank-re-emits-steps** —
  `setSeqEditBank`/`setDrumEditBank`/`setSamplerEditBank` re-emit every step so
  panels repaint.
- **REQ-bank-copy-is-undoable** — Banks are copyable (`copySeqBank(from, to)`
  etc.). A copy is undoable: the destination bank's prior contents restore via
  the per-machine undo (see pattern-undo.md REQ-undo-restores-a-copied-bank).
- **REQ-bank-index-clamps** — Bank indices clamp to `0..count-1` of **that
  machine's own** count, never to a global constant.
- **REQ-follow-tracks-the-play-bank** — **Follow** toggle on the `BankBar`
  (`[Follow] [A|B|C|D …] [Copy]`), default **on**. While on, the edit bank tracks
  the play bank on every play-bank change (so the panel — and its playhead,
  which shows only when edit bank == play bank — follows the arrangement across
  banks). Turning it on syncs immediately; a manual click on a bank other than
  the playing one turns it off (click = editing intent). Session-only UI state,
  never persisted (not in presets/songs/localStorage). Inverse of
  [arrangement](arrangement.md) REQ-a-disabled-lane-follows-the-edit-bank (a *disabled* lane's play bank tracks the
  edit bank) — Follow is a natural no-op there. `BankBar` exposes the state as
  `get following` + `onFollowChange(fn)` so the panel can gate its rest overlay
  on it ([arrangement-rest](arrangement-rest.md) REQ-a-resting-machine-tab-shows-it — no overlay while the
  user is editing), plus a public `setFollowing(on)` so a panel can declare
  editing intent on the user's behalf: arming the sequencer's Step Input turns
  Follow **off** ([sequencer](sequencer.md) REQ-a-take-is-bank-pinned) so the arrangement cannot
  swap the edit bank mid-take. Same rule, same funnel as a manual bank click —
  it is not a new state, just a second way to reach it.
- **REQ-content-dot-covers-every-lane** (v4) — **Content dot.** Each bank button
  carries a dot that lights (`filled`) while that bank holds pattern data, so
  the user can see which banks are worth switching to without visiting each
  one. It is distinct from the red *now-playing* dot: a bank can be filled and
  not playing, or playing and empty. The predicate `hasContent(i)` must cover
  **every lane the machine stores in that bank** — the sequencer's four tracks,
  all drum/sampler rows, and, for motion, the XY anchors **and** both extra A/B
  tracks ([motion-sequencer](motion-sequencer.md) REQ-two-extra-tracks-per-bank/REQ-two-lanes-below-the-xy-lane); a lane left
  out renders a full bank as empty. Correspondingly `onContentChange(fn)` must
  subscribe to **every** mutation stream that can change that answer (motion
  needs `onMotionChange` *and* `onMotionTrackChange`), or the dot goes stale
  until the next repaint. Both live in one place per machine — `laneHooks()` in
  `ui/panels/step-panel-scaffold.ts` — so adding a lane to a machine means
  extending its entry there. `hasContent(i)` must answer **false** for an index
  past the machine's count rather than throwing: a `BankBar` can outlive a
  shrink by one repaint.

- **REQ-bank-always-stores-sixteen-cells** (v5) — **A bank always stores 16
  cells; the meter decides how many *play*.** Nothing about the bank shape moved
  when time signatures landed ([meter](meter.md) REQ-pattern-arrays-stay-grid-cells-long) — which is exactly what
  kept the validators, the published JSON schemas, the authoring dialect and
  every shipped demo untouched. Shortening a lane hides cells; it never clears
  them, so lengthening it again returns the steps as they were, and a bank
  copied while short copies whole.

- **REQ-a-machine-owns-its-bank-count** (v6) — **Each machine has its own bank
  count, `MIN_BANK_COUNT`..`MAX_BANK_COUNT` (4..8), and the count *is* the length
  of that machine's bank array.** There is no separate stored count, in the store
  or in the `SongFile` — a second copy of a number the arrays already carry is a
  second thing to keep honest, and the first malformed payload desyncs them
  (ADR-022). The four machines are independent: growing the sequencer does not
  grow the drum machine. `BANK_LABELS` is **derived** from `MAX_BANK_COUNT`, so a
  label can never go missing for a bank that exists; surfaces slice it by the
  machine's own count.

- **REQ-a-bank-is-added-on-demand** (v6) — **`addBank(machine)` appends one blank
  bank** to every parallel array that machine owns — for motion that is
  `motionBanks`, `motionAssigns` *and* `motionTrackBanks`, resized as one step —
  and returns false at the ceiling. It emits `onBankCountChange` and
  **no `PatternMutation`**: minting a blank bank destroys nothing, so there is no
  undo entry for it and none should be added. The `BankBar`'s `+` arm is the only
  UI that calls it, and it hides (rather than disables) at the ceiling.

- **REQ-a-bank-is-removed-only-when-unused** (v6) — **`removeBank(machine)` drops
  the machine's *highest* bank**, never the selected one, so no surviving bank is
  renumbered — chain slots, undo entries and the edit cursors are all bare
  indices and a renumbering would silently rewrite every one. It refuses unless
  the count is above `MIN_BANK_COUNT`, the highest bank has no content, and no
  chain lane references it; the `−` arm renders disabled with a tooltip naming
  which of those is false. Because a bank can be empty *because it was cleared*,
  and a clear is undoable, `removeBank` also **prunes undo entries naming that
  bank** ([pattern-undo](pattern-undo.md) REQ-undo-restores-a-copied-bank) — otherwise an undo restores into
  a bank that no longer exists. If the removed bank was the one being **edited**,
  the cursor moves and the machine **re-emits its bank** — the same repaint
  `setSeqEditBank` owes a panel, since the edit-bank signal alone repaints the
  `BankBar`'s dots and not the grid, which would go on painting a bank that is
  gone. A count is otherwise never decremented in place: a song load or New Song
  *replaces* it.

- **REQ-a-chain-reference-grows-the-machine** (v6) — **A chain that names a bank
  the incoming arrays do not carry grows the machine to fit**, up to
  `MAX_BANK_COUNT`, rather than clamping the reference down. `Song.apply` is the
  one place that reconciles the two, so it sizes each machine from
  `max(arrayLength, highestChainRef + 1, MIN_BANK_COUNT)` *before* handing to
  `restore()`, and nothing grows the store afterwards. The bar the chain names
  then plays an empty bank — silence, the same as a rest — rather than a pattern
  the author did not write. A reference above `MAX_BANK_COUNT - 1` cannot be
  honoured and still clamps.

- **REQ-an-omitted-bank-restores-blank** (v6) — **A bank, row or cell the
  incoming snapshot omits restores to its default, never to what the previous
  song left there.** `restore()` resizes each machine's arrays first, minting new
  banks from the shared builders, then fills authoritatively with
  `Object.assign(dst, DEFAULTS, src ?? {})` at all three nesting levels. With a
  fixed count this was latent; with a variable one, loading a 4-bank song after
  an 8-bank one would otherwise leave E–H holding the previous song's patterns.
  The edit-bank cursors are re-clamped **unconditionally** after the resize, not
  only when the snapshot carries one — a `SongFile` never carries them, so the
  conditional form never ran on the load path, and a cursor parked on H would
  index past a freshly-shrunk array on the next read.

  A section the snapshot **omits entirely** is the one exception, and it inherits
  *whole*: content and count together. That is what the sampler's documented
  inherit across a load already promised ([song-mode](song-mode.md)
  REQ-apply-resets-to-defaults-first) — a v1 file carrying no `samplerBanks` keeps
  the user's kit, so it must not quietly destroy banks E–H of it either. A caller's
  count may still **raise** an inherited length (a chain naming a bank past it),
  never lower it.

## Technical design

### Contract / public interface

```yaml
PatternStore:  # src/state/patterns.ts
  get seqEditBank / drumEditBank / samplerEditBank / motionEditBank: number
  seqBank(i) / drumBank(i) / samplerBank(i) / motionBank(i)   # any bank, for the transport
  setSeqEditBank(i) / setDrumEditBank(i) / setSamplerEditBank(i) / setMotionEditBank(i)  # re-emit steps
  setSeqStep(track, index, patch)   # track-indexed since v6's multi-track seq (sequencer.md REQ-song-file-v6-adds-seq-tracks)
  setDrumCell(t, s, patch) / setSamplerCell(slot, s, patch) / setMotionStep(index, patch)
  copySeqBank(from, to) / copyDrumBank(...) / copySamplerBank(...) / copyMotionBank(...)  # motion also copies its assign override
  onEditBankChange(fn) -> unsubscribe
  # --- v6, the per-machine count (REQ-a-machine-owns-its-bank-count) ---
  get seqBankCount / drumBankCount / samplerBankCount / motionBankCount: number
  bankCount(m: Machine): number        # the lane-keyed primitive; = that machine's array length
  canAddBank(m) / addBank(m): boolean
  canRemoveBank(m) / removeBank(m): boolean
  onBankCountChange(fn) -> unsubscribe
constants: MIN_BANK_COUNT = 4, MAX_BANK_COUNT = 8
           BANK_LABELS — DERIVED from MAX_BANK_COUNT, one label per possible bank
type Machine: 'seq' | 'drum' | 'sampler' | 'motion'   # Arrangement's LaneName aliases it
clampChainStep(i, bankCount): number   # bankCount is REQUIRED — a default is how a
                                       # lane-blind caller silently squashes a grown machine
```

### Layer touchpoints

```yaml
play vs edit:
  transport reads seqBank(arrangement.seqPlayBank)  (see arrangement.md)
  a DISABLED arrangement lane's play bank follows that machine's edit bank
ui: src/ui/components/bank-bar.ts (BankBar) — testid prefix per machine:
    bank-<seq|drum|sampler|motion>-<i>, bank-…-copy, bank-…-follow,
    bank-…-add, bank-…-remove            # v6 — same bank-<lane>-<verb> shape
content dot (REQ-content-dot-covers-every-lane):
  BankBar toggles a `filled` class per button from opts.hasContent(i) and
  re-renders on opts.onContentChange. Both are supplied per machine by
  laneHooks() in src/ui/panels/step-panel-scaffold.ts:
    seq     -> any step on, across all 4 tracks        (onSeqChange)
    drum    -> any cell on, across all rows            (onDrumChange)
    sampler -> any cell on, across all slots           (onSamplerChange)
    motion  -> any XY anchor on OR any A/B track step on
               (onMotionChange + onMotionTrackChange, disposers composed)
count (v6, REQ-a-machine-owns-its-bank-count):
  laneHooks() also supplies bankCount/addBank/removeBank/removeBlockedBy/onBankCountChange,
  so nothing outside that one switch learns which machine has how many.
  removeBlockedBy() returns the REASON as a string (or null), not a boolean, so the
  disabled arm can say which condition is false; BankBar puts it in both the tooltip
  and the aria-label, because a title is never announced.
  BankBar rebuilds its letter row on onBankCountChange — a SEPARATE signal from
  onEditBankChange, which fires on every bank click and would otherwise tear down
  the row (and the copy-armed state) mid-gesture.
  The Song tab's chain palette (ui/panels/song-panel.ts) slices the same count and
  rebuilds on the same signal. It has no + arm: growing is a machine-tab act.
follow (REQ-follow-tracks-the-play-bank):
  lives entirely inside BankBar — its opts (getEdit/setEdit/getPlay/onPlayChange)
  already suffice. Surface for the panels: `get following(): boolean`,
  `setFollowing(on): void` and `onFollowChange(fn): () => void` (fires on the
  button toggle, the auto-off from a manual non-playing bank click AND a panel's
  own setFollowing call, e.g. Step Input arming — all funnel through
  setFollowing). On play change while following and
  getPlay() != getEdit(), BankBar calls setEdit(getPlay()); the store re-emits
  (REQ-set-edit-bank-re-emits-steps) and the panels' playhead match check turns true by itself.
  Timing: Arrangement is built before the machines and notifies inside its
  clock tick, so the edit bank is switched before onStep fires that tick —
  the playhead carries across the bank change without a gap.
```

### Persistence

A machine's count is **not** a stored field. It is the length of that machine's
array in the `SongFile`, so a four-bank song is byte-identical to its pre-v6 form
and every v1–v7 file loads as a four-bank song ([song-mode](song-mode.md)
REQ-song-file-v8-widens-the-bank-count, ADR-022, ADR-007). The ordering inside
`Song.apply` is load-bearing: `restore()` runs **before** the chain setters, so a
chain is always re-clamped against freshly-sized arrays and can never outlive the
banks it names.

## Scenarios (BDD)

```gherkin
Scenario: Switching the edit bank repaints the grid
  Given the sequencer is showing bank A
  When the user selects bank B
  Then every step re-emits and the panel repaints with bank B's pattern
# pinned by: tests/state/patterns.test.ts, e2e/banks.spec.ts

Scenario: Copy A into C duplicates the pattern (edge)
  When the user copies bank A to bank C
  Then bank C's cells equal bank A's (deep copy, independent thereafter)
# pinned by: tests/state/patterns.test.ts, e2e/banks.spec.ts

Scenario: Editing while a different bank plays (Follow off)
  Given the arrangement plays bank B and Follow is off
  When the user edits bank A
  Then playback is unaffected and the view stays on bank A (edit bank != play bank)
# pinned by: tests/audio/transport/arrangement.test.ts

Scenario: Follow switches the edit bank with the arrangement
  Given Follow is on (the default) and a chain A,B is enabled
  When the arrangement advances the play bank to B
  Then the edit bank switches to B and the playhead stays visible
# pinned by: tests/ui/bank-bar.test.ts, e2e/banks.spec.ts

Scenario: Manual bank click while following disables Follow (edge)
  Given Follow is on and bank B is playing
  When the user clicks bank A
  Then bank A becomes the edit bank and Follow turns off (no snap-back next bar)
# pinned by: tests/ui/bank-bar.test.ts, e2e/banks.spec.ts

Scenario: A motion bank filled only in its A/B tracks shows as filled (v4, regression)
  Given motion bank B has no XY anchors but its A track holds steps
  Then bank B's dot is lit in the Motion tab's bank bar
  And editing a track step lights (or clears) the dot without a bank switch
# pinned by: tests/ui/step-panel-scaffold.test.ts, e2e/motion.spec.ts

Scenario: Turning Follow on syncs immediately (edge)
  Given Follow is off and the play bank differs from the edit bank
  When the user turns Follow on
  Then the edit bank jumps to the play bank at once (not at the next bar)
# pinned by: tests/ui/bank-bar.test.ts

Scenario: Adding a bank reveals exactly one more, per machine (v6)
  Given the Sequencer is at the default four banks
  When the user taps the bank bar's + arm
  Then the Sequencer shows five banks, A..E, and its arrays are five long
  And the Drum machine still shows four
  And tapping + four more times stops at eight with the arm hidden
# pinned by: tests/state/patterns.test.ts, tests/ui/bank-bar.test.ts, e2e/banks.spec.ts

Scenario: Removing a bank refuses while it is in use (v6, edge)
  Given the Sequencer has five banks and bank E holds steps
  Then the − arm is disabled and says so
  When the user clears bank E and no chain names it
  Then − is enabled, and using it returns the Sequencer to four banks
# pinned by: tests/state/patterns.test.ts, tests/ui/bank-bar.test.ts

Scenario: A four-bank song loads after an eight-bank one without residue (v6, regression)
  Given the Sequencer was grown to eight and every bank holds steps
  When a four-bank song is loaded
  Then the Sequencer has four banks and E..H are gone, not stale
  And an edit bank parked on H is re-clamped rather than indexing past the array
# pinned by: tests/state/patterns.test.ts, tests/state/song.test.ts

Scenario: Removing the bank being edited repaints the grid (v6, regression)
  Given the Sequencer has five banks and the user is editing the empty bank E
  When the − arm drops it
  Then the edit bank is D and the grid repaints as D
  And it does not go on showing E's cells until some unrelated event repaints it
# pinned by: tests/state/patterns.test.ts

Scenario: A file with no sampler section inherits the sampler whole (v6, regression)
  Given the Sampler was grown to six banks and bank F holds steps
  When a song carrying no sampler section at all is loaded
  Then the Sampler still has six banks and F still holds its steps
  And a sampler chain naming a bank past six would still have grown it
# pinned by: tests/state/patterns.test.ts

Scenario: A chain naming a bank the file omits grows the machine (v6)
  Given a song whose seqBanks is four long but whose seqChain names bank E
  When it is applied
  Then the Sequencer has five banks, E is blank, and the chain is unchanged
  And that bar plays silence rather than bank D
# pinned by: tests/state/song.test.ts, tests/audio/transport/arrangement.test.ts
```

## Tests & verification

- `tests/state/patterns.test.ts`, `tests/ui/bank-bar.test.ts`,
  `tests/ui/step-panel-scaffold.test.ts` (REQ-content-dot-covers-every-lane per-machine predicates),
  `tests/state/song.test.ts` (the resize/ordering regressions),
  `e2e/banks.spec.ts`.
- `npm test` / `npm run e2e`.

## Open questions / future

- **Raising the ceiling again** is one line — `MAX_BANK_COUNT` — plus whatever
  `tests/state/authoring-docs.test.ts` names, since it pins every bank dimension
  in both published schemas and `public/llms.txt` to the constants. Two things it
  cannot pin, and which want a human eye before the next raise: whether the
  machine header still fits (it already wraps at eight — see
  [responsive-machine-header](responsive-machine-header.md)), and whether one
  unwrapped row of letters is still the right shape past roughly ten banks, or
  whether the bar wants paging by then.

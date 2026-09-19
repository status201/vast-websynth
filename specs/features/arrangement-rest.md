# Arrangement rest slot ("empty bar")

```yaml
id: arrangement-rest
status: implemented
version: 3   # v3: playhead + per-tick overlay refresh are gated on panel visibility
owner: core
related:
  - architecture
  - arrangement
  - banks
  - song-mode
source:
  - src/state/patterns.ts                        # REST sentinel + clampChainStep
  - src/audio/transport/arrangement.ts           # rest-aware chain steps + *Resting flags
  - src/audio/transport/sequencer.ts             # resting guard (release tied voice)
  - src/audio/transport/drum-machine.ts          # resting guard
  - src/audio/transport/sampler-machine.ts       # resting guard
  - src/state/song-validate.ts                   # accept REST in chain steps
  - src/ui/components/rest-glyph.ts              # shared inline-SVG rest icon
  - src/ui/components/rest-overlay.ts            # machine-tab "resting" overlay
  - src/ui/panels/song-panel.ts                  # rest add-button + rest chip
  - src/ui/panels/seq-panel.ts                   # rest overlay wiring
  - src/ui/panels/drum-panel.ts                  # rest overlay wiring
  - src/ui/panels/sampler-panel.ts               # rest overlay wiring
  - src/ui/panels/motion-panel.ts                # rest overlay wiring (XY + both track lanes)
  - src/ui/panels/step-panel-scaffold.ts        # bankBarFor + wirePlayhead resting gate (REQ-a-resting-lane-plays-nothing/REQ-a-resting-machine-tab-shows-it)
  - src/ui/components/bank-bar.ts                # Follow state read by the overlay + resting dot recolour (REQ-a-resting-machine-tab-shows-it)
```

An arrangement-chain option that is **always an empty bar** ("rest"), so a
composer can make a lane sit out a bar without spending a [bank](banks.md) on
silence. It exists only in the Song-tab [arrangement](arrangement.md) builder.

## Background / Why

When this landed, each machine lane arranged exactly **4 banks (A B C D)**, and
the only way to make a lane play nothing for a bar was to sacrifice a bank and
fill it with an empty pattern — leaving 3 usable banks. Growing the count was
ruled out here as too costly. A rest is instead a **sentinel value carried in the
chain**, confined to the Song tab, so the banks stay fully usable and existing
songs are unaffected.

That premise has since changed and the conclusion has not. Banks are no longer
fixed at four — a machine grows on demand up to `MAX_BANK_COUNT`
([banks](banks.md) REQ-a-machine-owns-its-bank-count, ADR-022) — but a rest is
still the right tool for *play nothing*: it costs no bank, no memory and no
bytes, it reads as an intent rather than as an empty pattern someone forgot to
fill, and it works identically on a machine already at the ceiling. Scarcity was
one argument for the sentinel; it was never the only one.

## Requirements

- **REQ-rest-is-a-negative-sentinel** — `PatternStore` exports `REST` (a
  sentinel `< 0`, distinct from any bank index) and `clampChainStep(i, bankCount)`
  which returns `REST` when `i === REST` and otherwise clamps to
  `0..bankCount-1`. The count is a **required** argument, per that machine's own
  bank count — see [banks](banks.md) REQ-bank-index-clamps. Edit/play-bank access
  clamps the same way and is otherwise unchanged — an *edit* bank can never be a
  rest.

- **REQ-chain-steps-may-hold-rest** — `Arrangement` chain steps may hold `REST`;
  `setSeqChain` / `setDrumChain` / `setSamplerChain` / `setMotionChain` map
  incoming steps through `clampChainStep` (preserving `REST`), so `Song.apply`
  round-trips a rest.

- **REQ-arrangement-exposes-resting-flags** — `Arrangement` exposes `seqResting`
  / `drumResting` / `samplerResting` / `motionResting` booleans recomputed each
  bar in `recompute()`. A lane is resting **iff** it is enabled and its current
  chain step is `REST`. A disabled lane is never resting; when resting the
  lane's `*PlayBank` is a safe real index (0) that is never read for triggering.

- **REQ-a-resting-lane-plays-nothing** — When a lane is resting, its machine
  (`StepSequencer` / `DrumMachine` / `SamplerMachine` / `MotionMachine`)
  triggers/writes nothing for that bar; the sequencer additionally releases any
  note tied into the rest. The transport clock advances normally (positions
  still step internally). The machine tab's **playhead is hidden while resting**
  — `wirePlayhead` gates the highlight on the lane *not* resting, so it doesn't
  chase across a bank (index 0) that isn't playing under the rest overlay. A
  panel whose tab is not on screen skips both the highlight and the per-tick
  overlay refresh entirely and re-syncs on reveal
  ([step-grid-editing](step-grid-editing.md) REQ-an-offscreen-grid-repaints-nothing); the overlay's own
  `arrangement.onChange` subscription is **not** gated, so a hidden lane's rest
  state still tracks the bar — the gate only drops the redundant per-tick nudge.

- **REQ-chain-builder-has-a-rest-button** — The Song-tab chain builder has a
  rest add-button that appends `REST` and renders a `REST` chip with a rest
  glyph (`.rest` style, not a letter). Move / delete / clear operate on rest
  chips like any other slot.

- **REQ-a-resting-machine-tab-shows-it** — While a lane is resting, its machine
  tab (Seq / Drum / Sampler / Motion) overlays the step grid with a dimming
  backdrop + a large centered rest glyph; the overlay hides when the lane stops
  resting, its chain is disabled, or the panel's Bank **Follow** toggle is off —
  Follow off means editing intent ([banks](banks.md)
  REQ-follow-tracks-the-play-bank), and an overlay over the bank being edited
  discourages edits. The grid stays clickable underneath (overlay is
  `pointer-events: none`). The **Motion** tab has the XY lane plus
  `MOTION_TRACK_COUNT` single-param lanes; **each** is wrapped in its own
  overlay, so they all dim together off the shared `motionResting`. A folded
  lane ([motion-sequencer](motion-sequencer.md) REQ-an-empty-motion-lane-starts-folded) still carries its
  overlay — the fold hides the body, it does not unbuild it. The `ctrls`/header rows stay outside
  the dim (as the XY lane's axis header does), keeping the param pickers usable.

- **REQ-rest-survives-save-and-import** — A `REST` in a chain persists through
  save / load and passes import validation. Legacy songs (no `REST`) load
  unchanged; an older build that predates this feature clamps `REST` → bank A
  (graceful degradation, ADR-007).

- **REQ-resting-bank-bar-marks-itself** — While a lane is resting, the panel's
  Bank bar draws the current play bank's dot **amber** (the resting colour,
  matching the overlay) instead of the red "now-playing" colour — during a rest
  no bank is actually playing, so a red dot misreads. The edit bank stays
  selected (with Follow on it is synced to the play bank, so bank A remains
  highlighted and shown). The recolour is applied whenever the lane rests,
  independent of the Follow toggle.

## Technical design

### Contract / public interface

```yaml
patterns.ts:
  REST: number                       # sentinel, = -1
  clampChainStep(i: number): number  # REST passes through; else clampBank
Arrangement:                         # src/audio/transport/arrangement.ts
  seqResting / drumResting / samplerResting / motionResting: boolean   # read by the machines + UI
  # set*Chain now map through clampChainStep; recompute() sets *Resting alongside *PlayBank
rest-glyph.ts:
  restIcon(): string                 # inline <svg>, colour via currentColor (like wave-icons.ts)
rest-overlay.ts:
  buildRestOverlay(api: StudioApi, lane: 'seq'|'drum'|'sampler'|'motion',
                   opts?: { following?: () => boolean }):
    { el: HTMLElement; refresh(): void }   # el placed over a position:relative grid wrapper
  # visible iff resting && chain enabled && (opts.following?.() ?? true);
  # panels pass () => bankBar.following and refresh() on bankBar.onFollowChange
```

### Data shapes

The chain-step domain widens; the on-disk shape (`ChainData.steps: number[]`) is
unchanged, so no `SongFile.version` bump is needed.

```yaml
ChainData.steps: number[]   # each entry ∈ { REST(-1) } ∪ 0..MAX_BANK_COUNT-1
```

Back-compat (ADR-007 additive rule): new builds may write `-1`; an older build
reading it clamps `-1` → `0` (plays bank A instead of a rest) — a graceful, silent
degradation, never a crash. `song-validate` accepts `REST` alongside
`0..MAX_BANK_COUNT-1`.

### Layer touchpoints & ordering

```yaml
recompute (per bar): enabled lane -> raw = steps[pos]; if raw===REST { resting=true; playBank=0 }
                     else { resting=false; playBank=clampChainStep(raw) }
                     disabled lane -> resting=false; playBank = editBank   (unchanged)
machines: each onTick checks arrangement.<lane>Resting FIRST -> (seq releases tied voice) return
ui (song tab): buildChainLane add-row appends REST; renderStructure draws restIcon() + .rest chip
ui (machine tabs): step grid wrapped position:relative; buildRestOverlay(api, lane) appended;
                   refresh() driven by arrangement.onChange + the machine's onStep
                   (motion wraps every lane — XY + the single-param lanes — each its own overlay);
                   wirePlayhead gates the highlight on !laneHooks.getResting()
                     AND on the panel VisibilityGate (hidden => no per-tick work);
                   BankBar.render toggles a 'resting' root class (amber play-bank dot)
persistence: Song.capture/apply + serialize.cloneChain copy steps verbatim (no change)
```

## Visual aids

```
Song tab chain:   [ A ][ 𝄽 ][ B ]      ← middle slot is a rest chip
Machine tab while that rest bar plays:
   [ step grid, dimmed ]
   [        𝄽         ]   ← centered glyph, grid still editable underneath
```

## Scenarios (BDD)

```gherkin
Scenario: A rest bar plays silence but the transport keeps moving
  Given seqChain = { enabled: true, steps: [0, REST, 1] }
  When the transport plays bar 2 (the rest slot)
  Then seqResting is true and the sequencer triggers no note that bar
  And on bar 3 seqResting is false and bank B plays
# pinned by: tests/audio/transport/arrangement.test.ts, tests/audio/transport/sequencer.test.ts

Scenario: clampChainStep preserves the rest sentinel
  Given a chain step value of REST
  Then clampChainStep(REST, n) === REST for any n
  And clampChainStep(9, n) === n - 1
# pinned by: tests/state/patterns.test.ts

Scenario: A rest round-trips through save/load and validation
  Given a song whose drumChain.steps contains REST
  When it is serialized and re-parsed via Song.fromJSON(Song.toJSON(song))
  Then the drumChain still contains REST and import validation passes
# pinned by: tests/state/song.test.ts, tests/state/song-validate.test.ts

Scenario: A disabled lane is never resting (edge)
  Given seqChain.enabled is false and steps contains REST
  Then seqResting is false and seqPlayBank follows the seq edit bank
# pinned by: tests/audio/transport/arrangement.test.ts

Scenario: The Song tab adds and shows a rest chip
  Given the Song tab is open
  When the user clicks the seq rest add-button
  Then a rest chip (.rest) is appended to the seq chain
# pinned by: e2e/arrangement-rest.spec.ts

Scenario: The machine tab shows the rest overlay while resting
  Given a seq chain [A, rest] is enabled and playing
  When the rest bar plays and the Seq tab is open
  Then the rest overlay is visible over the step grid
# pinned by: e2e/arrangement-rest.spec.ts

Scenario: Follow off hides the overlay; re-enabling Follow mid-rest brings it back
  Given a lane is resting and its rest overlay is visible
  When the user turns the panel's Bank Follow toggle off
  Then the overlay hides (the user is editing — the grid must look editable)
  And turning Follow back on while the lane still rests shows the overlay again
# pinned by: tests/ui/rest-overlay.test.ts, e2e/arrangement-rest.spec.ts

Scenario: The playhead is hidden while a lane rests (REQ-a-resting-lane-plays-nothing)
  Given a seq chain [A, rest] is enabled and playing with Follow on
  When the rest bar plays and the Seq tab is open
  Then no step cell carries the playing highlight
  And on the next (non-rest) bar the playhead resumes sweeping bank A
# pinned by: e2e/arrangement-rest.spec.ts

Scenario: The bank dot is amber, not red, while resting (REQ-resting-bank-bar-marks-itself)
  Given a BankBar whose resting() reports true and play bank is A
  When it renders
  Then the bar root carries the "resting" class (CSS recolours A's playing dot amber)
  And bank A stays selected (active)
# pinned by: tests/ui/bank-bar.test.ts

Scenario: Every Motion lane dims while the motion lane rests (REQ-a-resting-machine-tab-shows-it)
  Given a motion chain [A, rest] is enabled and playing with Follow on
  When the rest bar plays and the Motion tab is open
  Then the XY lane and every single-param lane each show a rest overlay
# pinned by: e2e/motion.spec.ts
```

## Tests & verification

- Unit: `tests/state/patterns.test.ts`, `tests/audio/transport/arrangement.test.ts`,
  `tests/audio/transport/sequencer.test.ts` (+ drum/sampler),
  `tests/state/song.test.ts`, `tests/state/song-validate.test.ts`,
  `tests/ui/rest-overlay.test.ts` (Follow gating, REQ-a-resting-machine-tab-shows-it) — `npm test`
- E2E: `e2e/arrangement-rest.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`
- Dev-bridge assertions: `window.__synth.engine.arrangement.seqResting` (DEV only)

## Open questions / future

- A rest currently applies per lane per bar. A global "all lanes rest" shortcut
  could be added later but is out of scope.

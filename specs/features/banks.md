# Pattern banks (A/B/C/D)

```yaml
id: banks
status: implemented
version: 4   # v4: the per-bank content dot is specified (REQ-6) — it must count
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

Four banks (A/B/C/D) per machine, with the **edit bank vs play bank** split that
lets you arrange/perform one pattern while editing another.

## Background / Why

`PatternStore` holds `BANK_COUNT` (4) banks each for the sequencer, drums, and
sampler. The UI always edits the **edit bank**; the transport always plays the
**play bank**, which the [arrangement](arrangement.md) chooses and which may differ.
This separation is what makes live pattern switching and song chains possible
without the editor and the playhead fighting over one buffer.

## Requirements

- **REQ-1** — 4 banks per machine; `seq`/`drum`/`sampler`/`motion` getters expose
  the edit bank; `seqBank(i)`/`drumBank(i)`/`samplerBank(i)`/`motionBank(i)`
  expose any bank for playback.
- **REQ-2** — `setSeqEditBank`/`setDrumEditBank`/`setSamplerEditBank` re-emit every
  step so panels repaint.
- **REQ-3** — Banks are copyable (`copySeqBank(from, to)` etc.). A copy is
  undoable: the destination bank's prior contents restore via the per-machine
  undo (see pattern-undo.md REQ-6).
- **REQ-4** — Bank indices clamp to `0..BANK_COUNT-1`.
- **REQ-5** — **Follow** toggle on the `BankBar` (`[Follow] [A|B|C|D] [Copy]`),
  default **on**. While on, the edit bank tracks the play bank on every
  play-bank change (so the panel — and its playhead, which shows only when
  edit bank == play bank — follows the arrangement across banks). Turning it
  on syncs immediately; a manual click on a bank other than the playing one
  turns it off (click = editing intent). Session-only UI state, never
  persisted (not in presets/songs/localStorage). Inverse of
  [arrangement](arrangement.md) REQ-3 (a *disabled* lane's play bank tracks
  the edit bank) — Follow is a natural no-op there. `BankBar` exposes the state
  as `get following` + `onFollowChange(fn)` so the panel can gate its
  rest overlay on it ([arrangement-rest](arrangement-rest.md) REQ-6 — no
  overlay while the user is editing), plus a public `setFollowing(on)` so a panel
  can declare editing intent on the user's behalf: arming the sequencer's Step
  Input turns Follow **off** ([sequencer](sequencer.md) REQ-6) so the arrangement
  cannot swap the edit bank mid-take. Same rule, same funnel as a manual bank
  click — it is not a new state, just a second way to reach it.
- **REQ-6** (v4) — **Content dot.** Each bank button carries a dot that lights
  (`filled`) while that bank holds pattern data, so the user can see which of
  A–D are worth switching to without visiting each one. It is distinct from the
  red *now-playing* dot: a bank can be filled and not playing, or playing and
  empty. The predicate `hasContent(i)` must cover **every lane the machine
  stores in that bank** — the sequencer's four tracks, all drum/sampler rows,
  and, for motion, the XY anchors **and** both extra A/B tracks
  ([motion-sequencer](motion-sequencer.md) REQ-13/REQ-16); a lane left out
  renders a full bank as empty. Correspondingly `onContentChange(fn)` must
  subscribe to **every** mutation stream that can change that answer (motion
  needs `onMotionChange` *and* `onMotionTrackChange`), or the dot goes stale
  until the next repaint. Both live in one place per machine — `laneHooks()` in
  `ui/panels/step-panel-scaffold.ts` — so adding a lane to a machine means
  extending its entry there.

## Technical design

### Contract / public interface

```yaml
PatternStore:  # src/state/patterns.ts
  get seqEditBank / drumEditBank / samplerEditBank / motionEditBank: number
  seqBank(i) / drumBank(i) / samplerBank(i) / motionBank(i)   # any bank, for the transport
  setSeqEditBank(i) / setDrumEditBank(i) / setSamplerEditBank(i) / setMotionEditBank(i)  # re-emit steps
  setSeqStep(index, patch) / setDrumCell(t, s, patch) / setSamplerCell(slot, s, patch) / setMotionStep(index, patch)
  copySeqBank(from, to) / copyDrumBank(...) / copySamplerBank(...) / copyMotionBank(...)  # motion also copies its assign override
  onEditBankChange(fn) -> unsubscribe
constant: BANK_COUNT = 4
```

### Layer touchpoints

```yaml
play vs edit:
  transport reads seqBank(arrangement.seqPlayBank)  (see arrangement.md)
  a DISABLED arrangement lane's play bank follows that machine's edit bank
ui: src/ui/components/bank-bar.ts (BankBar) — testid prefix per machine:
    bank-<seq|drum|sampler|motion>-<i>, bank-…-copy, bank-…-follow
content dot (REQ-6):
  BankBar toggles a `filled` class per button from opts.hasContent(i) and
  re-renders on opts.onContentChange. Both are supplied per machine by
  laneHooks() in src/ui/panels/step-panel-scaffold.ts:
    seq     -> any step on, across all 4 tracks        (onSeqChange)
    drum    -> any cell on, across all rows            (onDrumChange)
    sampler -> any cell on, across all slots           (onSamplerChange)
    motion  -> any XY anchor on OR any A/B track step on
               (onMotionChange + onMotionTrackChange, disposers composed)
follow (REQ-5):
  lives entirely inside BankBar — its opts (getEdit/setEdit/getPlay/onPlayChange)
  already suffice. Surface for the panels: `get following(): boolean`,
  `setFollowing(on): void` and `onFollowChange(fn): () => void` (fires on the
  button toggle, the auto-off from a manual non-playing bank click AND a panel's
  own setFollowing call, e.g. Step Input arming — all funnel through
  setFollowing). On play change while following and
  getPlay() != getEdit(), BankBar calls setEdit(getPlay()); the store re-emits
  (REQ-2) and the panels' playhead match check turns true by itself.
  Timing: Arrangement is built before the machines and notifies inside its
  clock tick, so the edit bank is switched before onStep fires that tick —
  the playhead carries across the bank change without a gap.
```

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
```

## Tests & verification

- `tests/state/patterns.test.ts`, `tests/ui/bank-bar.test.ts`,
  `tests/ui/step-panel-scaffold.test.ts` (REQ-6 per-machine predicates),
  `e2e/banks.spec.ts`.
- `npm test` / `npm run e2e`.

## Open questions / future

- `BANK_COUNT` is 4; raising it touches the store arrays, the `BankBar`, and the
  arrangement chain editors.

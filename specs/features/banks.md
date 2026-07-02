# Pattern banks (A/B/C/D)

```yaml
id: banks
status: implemented
version: 2
owner: core
related:
  - architecture
  - sequencer
  - drum-machine
  - sampler
  - arrangement
source:
  - src/state/patterns.ts
  - src/ui/components/bank-bar.ts
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

- **REQ-1** — 4 banks per machine; `seq`/`drum`/`sampler` getters expose the edit
  bank; `seqBank(i)`/`drumBank(i)`/`samplerBank(i)` expose any bank for playback.
- **REQ-2** — `setSeqEditBank`/`setDrumEditBank`/`setSamplerEditBank` re-emit every
  step so panels repaint.
- **REQ-3** — Banks are copyable (`copySeqBank(from, to)` etc.).
- **REQ-4** — Bank indices clamp to `0..BANK_COUNT-1`.
- **REQ-5** — **Follow** toggle on the `BankBar` (`[Follow] [A|B|C|D] [Copy]`),
  default **on**. While on, the edit bank tracks the play bank on every
  play-bank change (so the panel — and its playhead, which shows only when
  edit bank == play bank — follows the arrangement across banks). Turning it
  on syncs immediately; a manual click on a bank other than the playing one
  turns it off (click = editing intent). Session-only UI state, never
  persisted (not in presets/songs/localStorage). Inverse of
  [arrangement](arrangement.md) REQ-3 (a *disabled* lane's play bank tracks
  the edit bank) — Follow is a natural no-op there.

## Technical design

### Contract / public interface

```yaml
PatternStore:  # src/state/patterns.ts
  get seqEditBank / drumEditBank / samplerEditBank: number
  seqBank(i) / drumBank(i) / samplerBank(i)        # any bank, for the transport
  setSeqEditBank(i) / setDrumEditBank(i) / setSamplerEditBank(i)   # re-emit steps
  setSeqStep(index, patch) / setDrumCell(t, s, patch) / setSamplerCell(slot, s, patch)
  copySeqBank(from, to) / copyDrumBank(...) / copySamplerBank(...)
  onEditBankChange(fn) -> unsubscribe
constant: BANK_COUNT = 4
```

### Layer touchpoints

```yaml
play vs edit:
  transport reads seqBank(arrangement.seqPlayBank)  (see arrangement.md)
  a DISABLED arrangement lane's play bank follows that machine's edit bank
ui: src/ui/components/bank-bar.ts (BankBar) — testid prefix per machine:
    bank-<seq|drum|sampler>-<i>, bank-…-copy, bank-…-follow
follow (REQ-5):
  lives entirely inside BankBar — its opts (getEdit/setEdit/getPlay/onPlayChange)
  already suffice; panels are unchanged. On play change while following and
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

Scenario: Turning Follow on syncs immediately (edge)
  Given Follow is off and the play bank differs from the edit bank
  When the user turns Follow on
  Then the edit bank jumps to the play bank at once (not at the next bar)
# pinned by: tests/ui/bank-bar.test.ts
```

## Tests & verification

- `tests/state/patterns.test.ts`, `tests/ui/bank-bar.test.ts`, `e2e/banks.spec.ts`.
- `npm test` / `npm run e2e`.

## Open questions / future

- `BANK_COUNT` is 4; raising it touches the store arrays, the `BankBar`, and the
  arrangement chain editors.

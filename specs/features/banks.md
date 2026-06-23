# Pattern banks (A/B/C/D)

```yaml
id: banks
status: implemented
version: 1
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
    bank-<seq|drum|sampler>-<i>, bank-…-copy
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

Scenario: Editing while a different bank plays
  Given the arrangement plays bank B
  When the user edits bank A
  Then playback is unaffected (edit bank != play bank)
# pinned by: tests/audio/transport/arrangement.test.ts
```

## Tests & verification

- `tests/state/patterns.test.ts`, `tests/ui/bank-bar.test.ts`, `e2e/banks.spec.ts`.
- `npm test` / `npm run e2e`.

## Open questions / future

- `BANK_COUNT` is 4; raising it touches the store arrays, the `BankBar`, and the
  arrangement chain editors.

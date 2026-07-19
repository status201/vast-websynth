# Per-machine pattern undo

```yaml
id: pattern-undo
status: implemented
version: 1
owner: websynth
related:
  - architecture
  - song-mode          # loads clear the stacks (bulk restore)
  - banks              # bank copies are undoable
  - session-autosave   # song-level undo; complementary, never overlapping
source:
  - src/state/patterns.ts        # onMutate / onBulkRestore hooks
  - src/state/undo.ts            # generic UndoHistory<T>
  - src/state/pattern-undo.ts    # PatternUndo controller
  - src/ui/components/undo-button.ts
  - src/ui/panels/seq-panel.ts
  - src/ui/panels/drum-panel.ts
  - src/ui/panels/sampler-panel.ts
  - src/ui/panels/motion-panel.ts
  - src/ui/shortcuts.ts          # Ctrl/Cmd+Z routing
  - src/ui/ui-bridge.ts          # undoActiveMachine
  - src/ui/components/tabs.ts    # activeId getter
```

## Background / Why

Editing a step grid was irreversible: a mis-click, a fat-fingered paint over a
per-step setting, or a bank Copy over the wrong slot silently destroyed work.
Each machine (seq / drum / sampler / motion) now carries an undo stack for its
grid edits — a panel Undo button plus Ctrl/Cmd+Z scoped to the active machine
tab. Song-level destruction (loads) is covered separately by the
`session-autosave` toast; the two layers never overlap: a load *clears* the
machine stacks.

## Requirements

- **REQ-1** — Four independent undo stacks (seq/drum/sampler/motion), depth 50,
  undo-only (no redo — predictability over power).
- **REQ-2** — Capture happens at the `PatternStore` mutation entry points via a
  new `onMutate` hook, so every caller (panel clicks, `StepSettingsEditor`,
  the seq note dial, motion pads, `BankBar` copies) is covered without
  per-call-site wiring. Captured `before` state is always a **clone** — the
  store mutates cells in place.
- **REQ-3** — Pre-state cloning is skipped entirely when no `onMutate`
  listener is registered (zero cost for headless/store-only users).
- **REQ-4** — Same-target edits within a refreshing 400 ms window coalesce
  into one undo step (oldest `before` wins) — a slider drag, note-dial drag,
  or motion-pad drag is ONE undo. Known quirk: double-toggling one cell
  within the window coalesces to a net no-op entry. Bank copies never
  coalesce.
- **REQ-5** — Undo applies into the **bank the change was made in**: if the
  edit bank moved since, undo switches it back first, so the revert is always
  visible. Application goes through the standard setters (normal listeners
  repaint panels and arm the session autosave).
- **REQ-6** — Bank Copy is undoable: the destination bank's full prior
  contents restore (motion copies also restore the per-bank axis override).
- **REQ-7** — `PatternStore.restore()` fires a new `onBulkRestore` hook;
  `PatternUndo` clears **all** stacks on it. Song load / import / New / boot
  recovery / session-undo therefore reset machine undo (stale banks would
  otherwise lie).
- **REQ-8** — `PatternUndo` ignores mutations it applies itself (an
  `applying` latch), so undo never records undo.
- **REQ-9** — UI: an Undo button per machine panel header (testids
  `undo-seq` / `undo-drum` / `undo-sampler` / `undo-motion`), disabled while
  that stack is empty.
- **REQ-10** — Ctrl/Cmd+Z triggers undo for the **active machine tab** only
  (tab ids seq/drums/sampler/motion); inert on the Arp/Song tabs, inside
  editable fields (native text undo preserved), and with Shift/Alt held.
  `preventDefault` only when an undo actually ran.
- **REQ-11** — `setSampleName` is deliberately NOT captured: undoing a slot
  name without its decoded buffer would lie about what plays. Sample identity
  rides the session-level undo (session-autosave.md REQ-8).

## Technical design

### Contract / public interface

```ts
// state/patterns.ts (additions)
export type PatternMutation =
  | { kind: 'seq';     bank: number; index: number; before: SeqStep }
  | { kind: 'drum';    bank: number; track: number; step: number; before: DrumCell }
  | { kind: 'sampler'; bank: number; slot: number;  step: number; before: SamplerStep }
  | { kind: 'motion';  bank: number; index: number; before: MotionStep }
  | { kind: 'motion-assign'; bank: number; before: MotionAssign | null }
  | { kind: 'seq-copy';     bank: number; before: SeqStep[] }
  | { kind: 'drum-copy';    bank: number; before: DrumCell[][] }
  | { kind: 'sampler-copy'; bank: number; before: SamplerStep[][] }
  | { kind: 'motion-copy';  bank: number; before: MotionStep[]; beforeAssign: MotionAssign | null };
onMutate(fn: (m: PatternMutation) => void): () => void;
onBulkRestore(fn: () => void): () => void;   // fired at the start of restore()

// state/undo.ts
export class UndoHistory<T> {
  constructor(opts?: { depth?: number /* 50 */; coalesceMs?: number /* 400 */ });
  push(entry: T, coalesceKey?: string, now?: number): void;
  pop(): T | undefined;      // resets the coalesce window
  clear(): void;
  get size(): number;
  onChange(fn: () => void): () => void;   // fires when size changes
}

// state/pattern-undo.ts
export type UndoMachine = 'seq' | 'drum' | 'sampler' | 'motion';
export class PatternUndo {
  constructor(patterns: PatternStore, opts?: { depth?: number; coalesceMs?: number });
  canUndo(m: UndoMachine): boolean;
  undo(m: UndoMachine): void;   // no-op when empty
  clearAll(): void;
  onChange(fn: () => void): () => void;
}

// ui/components/undo-button.ts
export function createUndoButton(undo: PatternUndo, machine: UndoMachine): HTMLButtonElement;

// ui/ui-bridge.ts (addition) — returns whether an undo ran
undoActiveMachine = (): boolean => false;
```

### Layer touchpoints & ordering

- `main.ts` constructs `PatternUndo(engine.patterns)` next to the other pure
  state (session/xy) — it is NOT part of `StudioApi` — and threads it through
  `mountApp` → `buildPatternRow` → the four machine panels; it also joins the
  dev-only `__synth` bridge for E2E.
- `app.ts` (`buildPatternRow`) assigns `bridge.undoActiveMachine` mapping
  `TabContainer.activeId` (new getter) → machine; `shortcuts.ts` handles
  Ctrl/Cmd+Z **before** its generic modifier bail-out.
- Coalesce keys: `seq:<bank>:<index>`, `drum:<bank>:<track>:<step>`,
  `sampler:<bank>:<slot>:<step>`, `motion:<bank>:<index>`,
  `motion-assign:<bank>`; copies pass no key.
- `restore()` fires `onBulkRestore` and never emits `onMutate` (it writes
  cells directly, bypassing the setters) — that separation is what keeps
  song loads out of machine undo by construction.

### Persistence

None. Undo stacks are session-only, in-memory, and cleared by any bulk
restore. Deliberately not persisted.

## Scenarios (BDD)

```gherkin
Scenario: a mis-clicked step is one Undo away
  Given a drum cell toggled on by mistake
  When the user clicks the drum panel's Undo (or Ctrl+Z on the drum tab)
  Then the cell returns to its prior state
# pinned by: tests/state/pattern-undo.test.ts, e2e/pattern-undo.spec.ts

Scenario: a slider drag is a single undo step
  Given a StepSettingsEditor velocity drag emitting many set() calls
  When the user undoes once
  Then the cell's settings return to their pre-drag values
# pinned by: tests/state/pattern-undo.test.ts (coalescing)

Scenario: undo follows the change to its bank
  Given an edit made in bank A and the edit bank now on B
  When the user undoes
  Then the edit bank switches back to A and the cell reverts there
# pinned by: tests/state/pattern-undo.test.ts, e2e/pattern-undo.spec.ts

Scenario: bank copy is undoable
  Given bank B holding a pattern and Copy A→B performed
  When the user undoes
  Then bank B's prior pattern (and, for motion, its axis override) is back
# pinned by: tests/state/pattern-undo.test.ts

Scenario: a song load clears machine undo
  Given non-empty undo stacks
  When any song apply runs PatternStore.restore()
  Then every machine stack is empty and the Undo buttons disable
# pinned by: tests/state/pattern-undo.test.ts, e2e/pattern-undo.spec.ts

Scenario: Ctrl+Z in a text field keeps native undo
  Given focus inside the sampler's name input
  When the user presses Ctrl+Z
  Then the field's native undo runs and no pattern undo fires
# pinned by: tests/ui/shortcuts.test.ts
```

## Tests & verification

- Unit: `tests/state/undo.test.ts`, `tests/state/pattern-undo.test.ts`,
  `tests/state/patterns.test.ts` (onMutate/onBulkRestore),
  `tests/ui/shortcuts.test.ts` — `npm test`
- E2E: `e2e/pattern-undo.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`
- Dev-bridge assertions: `window.__synth.patternUndo.canUndo('drum')` (DEV only)

## Open questions / future

- Redo (Ctrl+Shift+Z) — deliberately out; revisit only on real demand.
- Undo for arrangement-chain edits (per-lane) — separate surface, separate
  spec if wanted.

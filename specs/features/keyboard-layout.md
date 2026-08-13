# Keyboard layout (QWERTY / AZERTY / QWERTZ / Dvorak)

```yaml
id: keyboard-layout
status: implemented
version: 1
owner: core
related:
  - architecture
  - input-control     # the note maps this feeds
  - onboarding        # the About diagram this labels
source:
  - src/state/keyboard-layout.ts
  - src/ui/shortcuts.ts
  - src/ui/components/about-shortcuts.ts  # the key list + the layout gear picker
```

Which characters the physical keys produce, so the computer-keyboard note
mapping lands where the player's fingers are.

## Background / Why

The note rows are matched on `e.key` — the *character* the key produces. That is
only correct on QWERTY. On AZERTY the key in the bottom-left prints **W**, so it
hits `UPPER`'s `w: 14` and sounds a D an octave up instead of the bottom C; the
row's `M` moves to the home row and `,` becomes `;`. QWERTZ swaps Y and Z.
Dvorak moves nearly everything. The instrument was silently wrong for a large
part of Europe, and the About modal's keyboard diagram
([onboarding](onboarding.md) REQ-17c) confidently drew letters that were not on
the user's keys.

This facility supplies **one table per layout, `code → character`**. Everything
else is derived from it, so the bindings and the picture of the bindings cannot
disagree — the same reason [input-control](input-control.md) REQ-3 derives the
diagram from the note maps rather than restating them.

A `code → character` table is also exactly the shape
`navigator.keyboard.getLayoutMap()` returns, so detection is a drop-in rather
than a parallel code path.

## Requirements

- **REQ-1** — A layout is a `code → character` table covering the codes the app
  binds. `LAYOUTS` holds one per supported id: `qwerty` (US/UK — they differ only
  in symbols nothing binds), `azerty` (FR), `qwertz` (DE/CH), `dvorak`.
- **REQ-2** — The stored preference is `'auto' | LayoutId` under
  `websynth.keyboard.layout`, read through the `websynth.*` try/catch convention
  (`state/sync-mode.ts` is the template): an absent, unparseable or throwing
  read yields the default, never an exception. `'auto'` is the default and
  resolves through detection.
- **REQ-3** — **Detection is a hint; the picker is the escape hatch.**
  `detectLayout()` feature-detects `navigator.keyboard?.getLayoutMap` (async,
  Chromium-only) and discriminates on a few codes — `KeyQ → 'a'` ⇒ azerty,
  `KeyZ → 'y'` ⇒ qwertz, `KeyZ → ';'` ⇒ dvorak, `KeyZ → 'z'` ⇒ qwerty. An
  **unrecognised** map yields `null` — it does not fall through to qwerty — as do
  an absent API and a rejected promise; `'auto'` then falls back to `qwerty`. The
  same framing as [performance-mode](performance-mode.md)'s tier detection: a
  wrong guess must always be overridable, never sticky.
- **REQ-4** — Changing the layout takes effect **immediately**, with no reload:
  `onLayoutChange(cb)` returns an unsubscribe, and both consumers (the note maps
  and the About diagram's labels) re-derive on it.
- **REQ-5** — **Scope: the note keys only.** `F` (drum fill), `Shift`+`R` and
  `Ctrl/Cmd`+`Z` keep their `e.key` letters and fixed labels. `Ctrl`+`Z`
  especially: undo is an OS-level convention that follows the *character*, not
  the position, so remapping it by layout would break the convention it borrows.
  The pitch-bend pair stays on `e.code` ([input-control](input-control.md)
  REQ-12) and is unaffected.
- **REQ-6** — **Known residual risk.** Because bindings resolve through
  characters rather than `e.code`, a wrong picker selection — or no detection at
  all, which is every Firefox and Safari user — means wrong notes. Matching
  positions directly could not be wrong in that way. This is an accepted
  trade-off for a picker whose selection is visible and instantly reversible;
  revisit if support requests say otherwise.

## Technical design

### Contract / public interface

```ts
// src/state/keyboard-layout.ts
export type LayoutId = 'qwerty' | 'azerty' | 'qwertz' | 'dvorak';
export type LayoutPref = 'auto' | LayoutId;

export const LAYOUTS: Record<LayoutId, { label: string; keys: Record<string, string> }>;

export function readLayoutPref(): LayoutPref;          // default 'auto'
export function writeLayoutPref(p: LayoutPref): void;  // notifies REQ-4 listeners
export function resolveLayout(): LayoutId;             // 'auto' -> detected ?? 'qwerty'
export function detectLayout(): Promise<LayoutId | null>;
export function primeDetection(): Promise<void>;       // caches for resolveLayout()
export function onLayoutChange(cb: () => void): () => void;
export function labelFor(code: string): string;        // active layout's character
export function resetDetectionForTests(): void;        // drops the cache; tests only
```

`resolveLayout()` is synchronous because callers render synchronously;
`primeDetection()` is awaited once at boot so the cache is warm before the first
paint. Until it resolves, `'auto'` reads as `qwerty`.

### Layer touchpoints & ordering

```yaml
boot: main.ts awaits primeDetection() before mounting the UI
state: keyboard-layout.ts owns the pref + the tables; no ParamBus involvement —
  this is device setup, never captured into a preset or song (sync-mode precedent)
ui/shortcuts.ts: composes NOTE_ROWS (code -> semitone) with the active
  table into LOWER/UPPER (character -> semitone); rebuilds on onLayoutChange and
  releases every held note first, or a remap strands whatever is down
ui/components/about-shortcuts.ts: the gear picker writes the pref; caps carrying data-code
  relabel in place (structure is layout-independent, only labels move)
```

### Persistence

```yaml
websynth.keyboard.layout: 'auto' | 'qwerty' | 'azerty' | 'qwertz' | 'dvorak'
```

Cleared by Restore Factory Settings, which wipes all origin-local storage
([factory-reset](factory-reset.md)) — deliberate: a factory device should
re-detect rather than inherit someone else's choice.

## Scenarios (BDD)

```gherkin
Scenario: AZERTY puts the bottom C under the key that prints W
  Given the layout is azerty
  When the user presses the key producing "w"
  Then bus.noteOn fires for the lower octave's C
  And the key producing "z" is KeyW, which the UPPER row maps — it plays note 74
     (the upper octave's D), not nothing and not a C
# pinned by: tests/ui/shortcuts.test.ts

Scenario: Switching layout mid-hold cannot strand a note (edge)
  Given a note key is held down
  When the layout changes
  Then that note receives its noteOff before the maps are rebuilt
# pinned by: tests/ui/shortcuts.test.ts

Scenario: A bad or absent stored value reads as the default (failure)
  Given websynth.keyboard.layout holds "klingon", or localStorage throws
  Then readLayoutPref() returns 'auto' and nothing throws
# pinned by: tests/state/keyboard-layout.test.ts

Scenario: Detection is optional
  Given navigator.keyboard is undefined, or getLayoutMap() rejects
  Then detectLayout() resolves to null and 'auto' behaves as qwerty
# pinned by: tests/state/keyboard-layout.test.ts

Scenario: The diagram relabels with the layout (REQ-4)
  Given the About modal is open on qwerty, showing naturals Z X C V B N M ,
  When the user picks AZERTY in the gear's select
  Then the naturals rank reads W X C V B N , ; without the modal reopening
# pinned by: tests/ui/about.test.ts
```

## Tests & verification

- `tests/state/keyboard-layout.test.ts` — the store, detection and its absence.
- `tests/ui/shortcuts.test.ts` — remapped note keys, mid-hold release.
- `tests/ui/about.test.ts` — the gear reveal and the relabel.
- By ear: switch to AZERTY and confirm the key under **W** sounds the bottom C.

## Open questions / future

- Only the codes the app binds are tabulated. A layout whose *symbol* keys move
  (AZERTY's digit row is unshifted punctuation) is covered for the note rows but
  the tables are not a general keyboard model — don't grow them into one.
- If REQ-6's risk shows up in practice, the fix is to match note keys on
  `e.code` and demote the picker to labelling only.

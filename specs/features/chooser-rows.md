# Chooser rows (the card buttons inside a dialog)

```yaml
id: chooser-rows
status: implemented
version: 1
owner: core
related:
  - css-cascade-layers
  - project-export
  - presets
  - audio-export
  - runtime-performance
source:
  - src/ui/components/chooser.ts
  - src/ui/styles/chooser.module.css
```

## Background / Why

Three dialogs ask the user to pick from a short list of described choices: the
Export chooser (Song / Project), the Preset manager's home step (Save, Export,
Import, Delete) and, for its label-plus-control rows, the Export audio dialog.
Each built the same card button by hand (a title over a one-line description),
and the Preset manager's stylesheet was a copy of the Export one, kept in step only
by a comment saying the row visuals followed the Export dialog's. Two copies of one look
drift: they already disagreed on hover, and the Export audio dialog reached into
the Export chooser's stylesheet for its rows. This spec is the one component they
all build from.

## Requirements

- **REQ-one-chooser-row-builder** — A described choice in a dialog is built by
  `chooserRow(title, desc, testId)`: a `<button type="button">` holding a title
  span over a description span, carrying the given `data-testid`. The list that
  holds them is `chooserRows()`. No dialog hand-builds the card or copies its
  rules; the classes live in `chooser.module.css` only.

- **REQ-a-chooser-row-shows-hover-selection-and-disabled** — One stylesheet, one
  set of states, the same in every dialog: hovering an enabled row outlines it in
  the accent colour; a row carrying the global `.on` class (a radio-style pick,
  like the Export chooser's kind) is outlined *and* tinted, so a selection still
  reads when the pointer is elsewhere; a disabled row is dimmed and shows the
  not-allowed cursor, and hovering it changes nothing.

- **REQ-option-rows-pair-a-label-with-a-control** — A row of the form "LABEL:
  [control]" (Export's *Clips*, Export audio's *Runs* and *Format*, the Preset
  manager's *Bank* and import policy) is `optionRow(label, control)`, and a dialog's
  small italic aside is `chooserNote(text)`. Same reason: three dialogs had them
  as copies.

- **REQ-chooser-styles-ride-with-the-dialogs** — Every dialog that uses the
  chooser is deferred (`import()` on its trigger), so `chooser.module.css` loads in
  a shared lazy chunk, never at boot
  ([runtime-performance](runtime-performance.md) REQ-boot-cost-matches-the-request). It is one `@layer
  components` block ([css-cascade-layers](css-cascade-layers.md)). A dialog's own
  module may add a class to a chooser element (Export audio spaces its last row)
  from the same layer; it wins by a more specific selector (`.body .fmtLast`),
  never by which stylesheet happened to load last.

## Technical design

### Contract / public interface

```ts
// src/ui/components/chooser.ts — DOM builders only, no state, no listeners
export function chooserRows(): HTMLDivElement;                                  // the column of rows
export function chooserRow(title: string, desc: string, testId: string): HTMLButtonElement;
export function optionRow(label: string, control: HTMLElement): HTMLDivElement; // "LABEL: [control]"
export function chooserNote(text = ''): HTMLParagraphElement;                   // the italic aside
```

The caller owns behaviour: it adds the click listener, toggles `.on` and sets
`disabled`. The builders return plain elements so a dialog's render function keeps
doing exactly what it did.

### Layer touchpoints & ordering

```yaml
src/ui/components/export-song-modal.ts:   chooserRows, chooserRow (kind rows, .on), optionRow (Clips), chooserNote
src/ui/components/preset-manager-modal.ts: chooserRows, chooserRow (home doors), optionRow (Bank, policy), chooserNote
src/ui/components/export-audio-modal.ts:  optionRow (Runs, Format), chooserNote
```

The removed `export-song-modal.module.css` held only chooser classes. The
Preset manager's own module keeps only its review and delete steps.

## Gesture inventory

| Gesture | On | Result |
| --- | --- | --- |
| Click / tap | an enabled row | the dialog's own handler runs (pick, open a step, save) |
| Click / tap | a disabled row | nothing: the button is `disabled` |
| Enter / Space | a focused row | the same as a click (a native button) |
| Hover | an enabled row | accent outline only, no selection |

## Scenarios (BDD)

```gherkin
Scenario: Every chooser row is the same card (REQ-one-chooser-row-builder)
  When chooserRow builds a row
  Then it is a button of type "button" with the testid it was given
  And it holds the title then the description, each in its own chooser class
# pinned by: tests/ui/chooser.test.ts

Scenario: An option row pairs its label with the control it was given (REQ-option-rows-pair-a-label-with-a-control)
  When optionRow builds "Clips:" around a segmented control
  Then the row holds the label first and that very control second
# pinned by: tests/ui/chooser.test.ts

Scenario: The three dialogs look as they did (REQ-chooser-styles-ride-with-the-dialogs)
  Given cascade fingerprints of modal-export, modal-export-audio and modal-preset-manager
    taken before the change, on both vite dev and the build
  When they are compared after it
  Then nothing differs
# pinned by: npm run cascade:fingerprint (--filter modal-, both servers)
```

## Tests & verification

- Unit: `tests/ui/chooser.test.ts`; the dialogs' own suites
  (`tests/ui/preset-manager-modal.test.ts`, the export e2e) keep passing on their
  testids.
- Cascade: `npm run cascade:fingerprint` against a pre-change baseline on both
  servers, and `npm run cascade:conflicts`.
- By eye: hover the Export chooser's rows (the hover outline is new there; the
  fingerprint captures no hover).

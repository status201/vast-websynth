# Dialog (confirm / prompt / alert)

```yaml
id: dialog
status: implemented
version: 5   # v5: REQ-9 — an alert may carry a Copy button offering the FULL
             #     text of what it reports, so a truncated error list is no
             #     longer destroyed by dismissing the dialog
             # v4: REQ-6's "one dialog at a time" is now enforced, not assumed
             #     — a closing dialog is reaped when the next one opens
             # v3: REQ-8 — chooseDialog, for a question whose answers are two
             #     positive actions rather than yes/no
owner: core
related:
  - architecture
  - failure-report
  - ../recipes/add-a-modal-dialog.md
source:
  - src/ui/components/dialog.ts
  - src/ui/styles/dialog.module.css
```

## Background / Why

The app used the browser's native `prompt()` / `confirm()` / `alert()` for
naming a preset/song, confirming a destructive wipe, and reporting an import
error. Native dialogs are unstyled, inconsistent with the instrument's look, and
un-testable through the component surface. Worse, several destructive actions had
**no** guard at all — the Song tab's per-lane **Clear** button reset an
arrangement chain on a single mis-click. This facility replaces every native
dialog with one styled, promise-returning helper set, and gives destructive
actions a "You sure?" step. It is a thin layer over the existing
[`Modal`](../recipes/add-a-modal-dialog.md) (`src/ui/components/modal.ts`) — it
reuses that lifecycle (backdrop, centred card, fade, Escape-to-close,
backdrop-click-to-close) rather than reinventing it.

## Requirements

- **REQ-1** — Three `async` helpers replace the native dialogs, each **composing
  `Modal`** (no re-implementation of backdrop / fade / Escape / backdrop-click):
  `confirmDialog → Promise<boolean>`, `promptDialog → Promise<string | null>`,
  `alertDialog → Promise<void>`. Each builds a fresh single-use `Modal`, appends
  a message paragraph (its own `.message`, from `dialog.module.css` — **not**
  `Modal.metaClass`), an optional single-line input
  (prompt only), and an actions row of `createButton`s
  (`src/ui/components/button.ts`), then `open()`s it.
- **REQ-2** — The returned promise **settles exactly once**. The affirmative
  action resolves the *confirm* value; **any** dismissal — the Cancel button,
  Escape, or a backdrop click — resolves the *cancel* value. A `settled` latch
  makes double-close (e.g. affirmative → `modal.close()` → `onClose`) resolve a
  single time, mirroring `Modal.onClose` firing once.
- **REQ-3** — Cancel semantics mirror the natives they replace so callers are a
  drop-in: `confirmDialog` cancel → `false`; `promptDialog` cancel → `null`;
  `promptDialog` confirm → the input's current string (which **may be empty**, so
  callers keep their existing `if (!name) return` empty-guard, exactly like
  native `prompt`); `alertDialog` resolves `undefined` on OK/dismiss.
- **REQ-4** — `confirmDialog`'s `danger?` option renders the affirmative button
  in a destructive (red) style for wipes (the per-lane Clear, Song New). Default
  is the neutral style.
- **REQ-5** — Focus + keyboard: on open, `confirmDialog`/`alertDialog` autofocus
  the affirmative button; `promptDialog` focuses the input and selects its text.
  **Enter** confirms (prompt: an input keydown handler; confirm/alert: the
  focused affirmative button activates on Enter). **Escape** cancels (owned by
  `Modal`, which beats the global panic handler).
- **REQ-6** — Stable `data-testid`s for E2E (a single dialog is open at a time):
  the affirmative button is `dialog-confirm`, the dismiss button is
  `dialog-cancel`, the prompt field is `dialog-input`, an alert's optional copy
  button is `dialog-copy` *(v5)*.

  *(v4)* "A single dialog is open at a time" was an **assumption** here, and it
  did not hold. These helpers settle their promise *before* `modal.close()`, so
  the caller resumes while the answered dialog is still mounted for its ~200 ms
  fade. A caller that answers one dialog and raises another inside that window —
  the demo-shadow question in [song-mode](song-mode.md) REQ-15 does exactly
  that, twice in a row — had two dialogs mounted, so `dialog-cancel` and every
  `dialog-choice-*` id matched **two** nodes and the E2E driving it failed
  intermittently on a strict-mode violation. The testids were never ambiguous by
  design; the lifecycle simply let a dead dialog linger. Fixed in `Modal`, where
  the fade lives, rather than here: `open()` reaps anything still fading
  ([add-a-modal-dialog](../recipes/add-a-modal-dialog.md) v4), so the invariant
  this REQ has always claimed is now true for every modal, not just dialogs.
- **REQ-7** *(v2)* — `confirmDialog`'s optional `detail?: string` renders a
  second paragraph below the message, in **italics** and slightly muted
  (`.detail`, `data-testid="dialog-detail"`) — supporting copy under the main
  question (e.g. [factory-reset](factory-reset.md)'s “Everything not saved will
  be lost.”). Omitted → no extra element.
- **REQ-8** *(v3)* — **`chooseDialog → Promise<string | null>`** — a fourth
  helper for the question `confirmDialog` cannot ask honestly: one whose answers
  are **two positive actions**, not yes/no. Squeezing "load the demo or your own
  song?" into a confirm would make one of the two answers `false`, which is the
  same value Escape and a backdrop click produce — so a dismissal would silently
  *do* something. `chooseDialog` takes `choices: {id, label, danger?}[]` (2+),
  resolves the chosen **id**, and resolves **`null` on every dismissal**, so
  "neither" stays expressible. The last choice is the affirmative: it is focused
  on open (REQ-5) and is the one Enter takes. An optional `cancelLabel` renders a
  leading dismiss button resolving `null` too, for when the escape hatch should
  be visible rather than keyboard-only. Everything else — settle-once (REQ-2),
  `detail` (REQ-7), Modal composition (REQ-1) — is unchanged.
- **REQ-9** *(v5)* — **An alert may offer its full text on the clipboard.**
  `alertDialog`'s optional `copyable?: string` adds a second button
  (`dialog-copy`, label from `copyLabel?`, default `'Copy errors'`) beside OK,
  which writes that string via the shared `copyText` / `flashCopied`
  (`src/ui/clipboard.ts`) — the same helpers Copy Link and Copy report use.
  Four rules make it worth having:
  1. **The payload is passed in, never scraped from the rendered message.** The
     reason the button exists is that the message is *shorter than the truth*:
     the import-error alert renders 8 of up to 50 validator messages
     ([song-mode](song-mode.md) REQ-18) and the rest exist nowhere else once the
     dialog closes. Callers build the string with
     [`buildFailureReport`](failure-report.md), which sees the whole array.
  2. **Copying does not close the dialog and does not settle the promise** — it
     is an aside, not an answer (the rule [song-share-link](song-share-link.md)
     REQ-5 already sets for Copy Link). The user copies, reads on, then dismisses.
  3. **Focus stays on `dialog-confirm`**, so Enter still dismisses (REQ-5) and
     the copy button is reached by Tab.
  4. **Without `copyable` the alert is unchanged**: one full-width button using
     `Modal.closeBtnClass`. With it, the layout switches to the shared
     `.actions` row every other dialog kind already uses. `copyText` resolves
     `false` rather than throwing on an insecure origin or a denied permission,
     and `flashCopied` then reads `Press Ctrl+C` — the dialog degrades, never
     breaks.

## Technical design

### Contract / public interface

```yaml
dialog:   # src/ui/components/dialog.ts — four functions over Modal, not a class
  confirmDialog(opts: ConfirmOptions): Promise<boolean>       # true=affirmative, false=cancel
  promptDialog(opts: PromptOptions): Promise<string | null>   # value=affirmative, null=cancel
  alertDialog(opts: AlertOptions): Promise<void>              # resolves on OK / dismiss
  chooseDialog(opts: ChooseOptions): Promise<string | null>   # id=chosen, null=dismissed (v3)

ConfirmOptions:
  title: string
  message: string
  detail?: string              # italic muted second paragraph below the message (v2)
  confirmLabel?: string        # default 'OK'
  cancelLabel?: string         # default 'Cancel'
  danger?: boolean             # red affirmative button (default false)

PromptOptions:
  title: string
  message?: string             # optional label line above the input
  defaultValue?: string        # pre-filled + text-selected on open
  placeholder?: string
  confirmLabel?: string        # default 'OK'
  cancelLabel?: string         # default 'Cancel'

AlertOptions:
  title: string
  message: string
  okLabel?: string             # default 'OK'
  copyable?: string            # v5 — full text behind a Copy button; omitted -> no button
  copyLabel?: string           # v5 — default 'Copy errors'

ChooseOptions:                 # v3
  title: string
  message: string
  detail?: string              # same italic muted paragraph as ConfirmOptions
  choices: Choice[]            # 2+, in button order; the LAST is the affirmative
  cancelLabel?: string         # omitted -> no dismiss button (Escape/backdrop still work)

Choice:
  id: string                   # what the promise resolves to
  label: string
  danger?: boolean             # red button, same style as ConfirmOptions.danger
```

### Layer touchpoints & ordering

```yaml
DOM (inside Modal.body): [ <p .message>,        # dialog.module.css, not modal's .meta (confirm/choose, optional) <p .detail dialog-detail>,
                           (prompt only) <input .input dialog-input>,
                           <div .actions> [ dialog-cancel?, dialog-confirm ] ]
                         # choose: <div .actions> [ dialog-cancel?, dialog-choice-<id>... ]
lifecycle: new Modal({ title, onClose: () => resolveOnce(cancelValue) }); modal.open()
resolve:
  affirmative btn -> resolveOnce(confirmValue); modal.close()
  cancel btn      -> modal.close()   # its onClose resolves cancelValue
  Escape / backdrop -> Modal.close() -> onClose -> resolveOnce(cancelValue)
  settled latch   -> resolveOnce ignores all calls after the first
focus/keys: after open(), affirmative btn.focus() (confirm/alert/choose) or input.focus()+select()
            (prompt); prompt input keydown Enter -> affirmative path
alert:      no copyable -> single full-width affirmative button (reuse Modal.closeBtnClass)
            copyable    -> shared .actions row [ dialog-copy, dialog-confirm ]   # v5
            either way: no cancel btn; dialog-confirm keeps focus
            dialog-copy -> flashCopied(btn, label, copyText(copyable)); NO close, NO resolve
choose:     cancelValue is null; each choice btn -> resolveOnce(id); modal.close()
            the LAST choice is the affirmative (focused) — order buttons so the
            likelier / least destructive answer sits there
```

Callers that adopt this facility (native → helper):

```yaml
src/ui/panels/song-panel.ts:
  per-lane Clear  -> confirmDialog({ danger:true, confirmLabel:'Clear' })  # NEW guard;
                     skipped when the chain is already just [0] (nothing to lose)
  Song Save       -> promptDialog   (was prompt('Song name:'))
  Song New        -> confirmDialog({ danger:true })  (was confirm('Clear all banks and chains?'))
  Import errors   -> alertDialog + copyable (v5; the full list, not the shown 8)
  import/demo/clip failures -> alertDialog + copyable   # failure-report.md REQ-5
src/ui/app.ts:            Preset Save  -> promptDialog   (was prompt('Preset name:'))
src/ui/panels/sampler-panel.ts: decode error -> alertDialog + copyable (was alert('Unsupported…'))
src/main.ts:              boot-failure alert() stays NATIVE (app graph never
                          initialised — must not depend on healthy app DOM/CSS)
```

### Why this composes `Modal` (and is not a new modal)

`Modal` already owns the *modal-ness* — backdrop that captures clicks, the fade,
and the Escape handler that `stopImmediatePropagation`s to beat the panic
handler. `dialog.ts` adds only the confirm/prompt/alert/choose **layout + a
resolved promise**. Contrast [`FloatingWindow`](floating-window.md), which is
non-modal and deliberately leaves Escape alone.

## Scenarios (BDD)

```gherkin
Scenario: Confirm resolves true on the affirmative button
  Given a confirmDialog is open
  When the user clicks the confirm button
  Then the promise resolves true and the dialog closes
# pinned by: tests/ui/dialog.test.ts

Scenario: Confirm resolves false on cancel, Escape, or backdrop click
  Given a confirmDialog is open
  When the user cancels (Cancel button, Escape, or backdrop click)
  Then the promise resolves false and the dialog closes
# pinned by: tests/ui/dialog.test.ts

Scenario: Prompt returns the entered text, or null on cancel
  Given a promptDialog is open with a default value
  When the user edits the field and clicks confirm
  Then the promise resolves the field's current string
  And cancelling instead resolves null
# pinned by: tests/ui/dialog.test.ts

Scenario: Enter confirms a prompt
  Given a promptDialog is open
  When the user presses Enter in the input
  Then the promise resolves the field's value
# pinned by: tests/ui/dialog.test.ts

Scenario: Choose resolves the id of the clicked choice (v3, REQ-8)
  Given a chooseDialog is open with choices "demo" and "mine"
  When the user clicks the "mine" button
  Then the promise resolves "mine" and the dialog closes
# pinned by: tests/ui/dialog.test.ts

Scenario: Choose resolves null when dismissed — neither action runs (v3, REQ-8)
  Given a chooseDialog is open with two positive choices
  When the user presses Escape, clicks the backdrop, or clicks the dismiss button
  Then the promise resolves null
  And no choice id can be mistaken for a dismissal
# pinned by: tests/ui/dialog.test.ts

Scenario: Answering a dialog and immediately raising another leaves one (v4, REQ-6)
  Given a dialog has just been answered and is still playing its close fade
  When the caller opens a second dialog straight away
  Then only the second dialog is in the document
  And each dialog testid matches exactly one element
# pinned by: tests/ui/dialog.test.ts, e2e/song.spec.ts

Scenario: The promise settles exactly once
  Given any dialog is open
  When it is confirmed and then closed again
  Then the promise resolves a single time
# pinned by: tests/ui/dialog.test.ts

Scenario: An alert offers its full text on the clipboard (v5, REQ-9)
  Given an alertDialog opened with a copyable string longer than its message
  When the user clicks dialog-copy
  Then the whole copyable string is written to the clipboard, not the message
  And the button flashes its copied state
# pinned by: tests/ui/dialog.test.ts, e2e/song-link.spec.ts

Scenario: Copying is an aside, not an answer (v5, REQ-9)
  Given an alertDialog with a copyable string is open
  When the user clicks dialog-copy
  Then the dialog stays open and the promise has not settled
  And clicking dialog-confirm afterwards still resolves it
# pinned by: tests/ui/dialog.test.ts

Scenario: An alert without copyable is unchanged (v5, REQ-9)
  Given an alertDialog opened without a copyable string
  Then it has one full-width button and no dialog-copy element
# pinned by: tests/ui/dialog.test.ts

Scenario: Confirm renders an optional italic detail line
  Given a confirmDialog opened with a detail string
  Then a second paragraph (dialog-detail) shows that text below the message
  And a confirmDialog without detail renders no such element
# pinned by: tests/ui/dialog.test.ts

Scenario: The Song tab Clear button asks before wiping a chain
  Given a lane chain with several steps
  When the user clicks Clear and confirms
  Then the chain resets to a single step; cancelling leaves it unchanged
# pinned by: e2e/song.spec.ts

Scenario: Save (song/preset) names via the custom prompt, not a native dialog
  Given the Song or Preset Save button
  When the user clicks it, types a name in dialog-input, and clicks dialog-confirm
  Then the song/preset is saved under that name
# pinned by: e2e/song.spec.ts, e2e/presets.spec.ts, e2e/xy-pad.spec.ts

Scenario: Song New confirms via the custom dialog before clearing
  Given an edited song
  When the user clicks New and clicks dialog-confirm
  Then all banks and chains are cleared
# pinned by: e2e/song.spec.ts
```

## Tests & verification

- Unit: `tests/ui/dialog.test.ts` — `npm test` (mirrors `tests/ui/modal.test.ts`:
  reset `document.body` per test, `vi.useFakeTimers()` for the 200 ms fade).
- E2E: `e2e/song.spec.ts`, `e2e/presets.spec.ts`, `e2e/xy-pad.spec.ts` — the Save
  flows fill `dialog-input` + click `dialog-confirm`; Song New clicks
  `dialog-confirm` — `npm run e2e`.
- Typecheck: `npm run typecheck`.

## Open questions / future

- Scope is intentionally tight (per the change that introduced this): guard the
  Clear button + convert the existing native dialogs only. Other unguarded
  destructive actions (Load / Import / Demo whole-session replace, the ✕
  chain-step remove, same-name overwrite) could adopt `confirmDialog` later.

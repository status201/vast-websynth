# Failure report (copyable diagnostics)

```yaml
id: failure-report
status: implemented
version: 3   # v3: REQ-6 — the truncated message an alert shows is built here
             #     too, so the line naming the Copy button cannot drift
             # v2: REQ-5 covers every import-failure SURFACE, not only the
             #     alerts — the preset wizard's inline strip emits one too
owner: core
related:
  - dialog
  - song-mode
  - presets
  - debug-panel
  - untrusted-input
source:
  - src/ui/failure-report.ts
```

## Background / Why

A failed import reports itself exactly once, in a modal, and then the text is
gone. The song validator collects up to `MAX_ERRORS` (50) path-prefixed messages
(`src/state/validate-utils.ts`), but the **Import failed** dialog renders only the
first eight and closes the rest behind `…and N more`. Those messages exist nowhere
else — no console, no log — so dismissing the dialog destroys the only diagnosis
the app ever produced, and the `<p>` they live in is not usefully selectable
inside a modal card.

This is the builder that turns a failure into one pasteable block of text. It is
the *data* half of the copy affordance; the button that offers it is
[dialog](dialog.md) REQ-9. It follows the precedent set by the Debug panel's
**Copy report** ([debug-panel](debug-panel.md) REQ-7): the payload is assembled
from the values the code already holds, **never scraped from the rendered DOM**,
so what lands on the clipboard is complete even when the view is truncated.

## Requirements

- **REQ-1** — `buildFailureReport` takes the **complete** message array and
  returns a single string. It never truncates, never re-orders, and never reads
  the DOM. A surface that shows the user a shortened list still passes the whole
  array here — the divergence between what is *shown* and what is *copied* is the
  entire point of the facility.
- **REQ-2** — The report opens with a context header, so a paste into a chat
  window or an issue identifies itself without further questions:
  1. `VAST G1-J8 <__APP_VERSION__> — <title>` (the title is the dialog's own,
     so the report says which failure it is),
  2. an ISO-8601 timestamp (`new Date().toISOString()`),
  3. `file: <name>` — **omitted entirely** when the caller has no file or link
     name to give,
  4. a count line, then a blank line, then the messages as `• ` bullets.
- **REQ-3** — The count line is honest about the producer's own cap. It reads
  `1 error:` / `N errors:`, and gains ` (validator cap reached)` when the caller
  passes `capped: true` — which the song-import surface derives from
  `errors.length >= MAX_ERRORS`. Without it a 50-error report would claim to be
  complete when the validator had in fact stopped walking the payload.
- **REQ-4** — The builders are **pure and synchronous**: same inputs, same
  string, apart from the timestamp. They perform no clipboard write and raise no
  dialog — callers hand the result to `alertDialog`'s `copyable` (dialog REQ-9),
  which owns the `copyText` / `flashCopied` mechanics from `src/ui/clipboard.ts`.
  That purity is why the *composition* of "build the message, build the report,
  raise the alert" lives at its call site rather than here.
- **REQ-5** *(v2: surface, not alert)* — Every import-failure **surface** in the
  app emits one, so a user who hits any of them has the same recourse — including
  the preset wizard's inline error strip ([presets](presets.md) REQ-16), which is
  a `div` in a `Modal` rather than an `alertDialog` and so reuses `copyText` /
  `flashCopied` directly with its own testid. The emitting surfaces are the table
  under "Layer touchpoints" below; a *signpost* alert that carries no diagnosis
  (the wrong-door "That is a preset file" notice) deliberately does not.
- **REQ-6** *(v3)* — **The truncated message is built here too.**
  `failureMessage(lead, errors)` bullets the first 8 and, when more remain, adds
  the line that **names the Copy button** — the promise [song-mode](song-mode.md)
  REQ-18 makes. It is one function because two hand-written copies drift, and a
  drifted copy points the user at a control by a name it no longer has. `isCapped`
  is shared for the same reason: every caller derived `errors.length >=
  MAX_ERRORS` identically, so it is derived once.

  What is deliberately *not* shared is the `alertDialog({...})` call. It is
  configuration, not logic — title, lead sentence and label differ per surface —
  and pulling it in here would make this module depend on the dialog it exists to
  feed (REQ-4).

## Technical design

### Contract / public interface

```yaml
failure-report:   # src/ui/failure-report.ts — pure functions, no state
  buildFailureReport(r: FailureReport): string
  buildFailureReportFor(title, message, file?): string   # single-message sugar
  failureMessage(lead: string, errors: string[]): string # v3 — what the ALERT shows
  isCapped(errors: string[]): boolean                    # v3 — errors.length >= MAX_ERRORS

FailureReport:
  title: string      # the dialog's own title — becomes the report's first line
  file?: string      # offending file / link name; omitted -> no `file:` line
  errors: string[]   # EVERY message, uncapped by whatever the view renders
  capped?: boolean   # the producer stopped at its own cap (default false)
```

### Data shapes

The rendered string, for a 50-error song import of `night-drive.json`:

```text
VAST G1-J8 2.11.2 — Import failed
2026-09-04T14:22:07.118Z
file: night-drive.json
50 errors (validator cap reached):

• format must be "websynth-song" (got "nope")
• version must be one of 1,2,3,4,5,6,7 (got undefined)
• drumBanks[1][3][7].ratchet must be an integer 1..4
…every remaining message, none dropped
```

A single-message failure collapses to the same shape with `1 error:` and one
bullet.

### Layer touchpoints & ordering

`__APP_VERSION__` is a Vite `define` (`vite.config.ts`), `declare`d per-file
across the codebase; this module centralises that declaration for the whole
failure path.

```yaml
via alertDialog copyable (dialog REQ-9):
  src/ui/panels/song-panel.ts:
    showImportErrors      -> every validator message, capped flag from MAX_ERRORS
    'Import failed' (apply threw) -> the exception message
    'Some clips failed'   -> the undecodable clip names
    'Demo failed to load' -> showDemoFailure: the parse's whole error array;
                             the catch's exception message otherwise  # song-mode REQ-18 v25
  src/ui/panels/sampler-panel.ts:
    'Load failed'         -> the decode message
  src/main.ts:
    'Could not load the shared song' -> the exception message
via copyText/flashCopied on an inline control:            # v2
  src/ui/components/preset-manager-modal.ts:
    preset-import-copy    -> every message the preset validator produced,
                             for both the file picker and the paste door
not an emitter:
  song-panel 'That is a <preset|bank> file'  # a signpost, not a diagnosis
```

## Scenarios (BDD)

```gherkin
Scenario: The report carries every message, not the truncated view (REQ-1)
  Given an import that produced 50 validator errors
  And a dialog that renders only the first 8 of them
  When the report is built from the error array
  Then all 50 messages appear in the returned string
# pinned by: tests/ui/failure-report.test.ts

Scenario: The header identifies the failure without further questions (REQ-2)
  Given a report built with a title and a file name
  Then the first line names the app version and the title
  And an ISO timestamp and a "file:" line follow it
  And a report built without a file name has no "file:" line
# pinned by: tests/ui/failure-report.test.ts

Scenario: The line naming the Copy button is written once (v3, REQ-6)
  Given more errors than an alert shows
  When failureMessage builds what the alert renders
  Then it bullets the first 8 and names Copy errors for the rest
  And an alert with 8 or fewer adds no such line
# pinned by: tests/ui/failure-report.test.ts

Scenario: The count line admits when the validator stopped early (REQ-3)
  Given a report built with capped true
  Then the count line says "(validator cap reached)"
  And an uncapped single-message report reads "1 error:"
# pinned by: tests/ui/failure-report.test.ts
```

## Tests & verification

- Unit: `tests/ui/failure-report.test.ts` — `npm test`.
- E2E: `e2e/song-link.spec.ts` — a bad share-link payload, then read back the
  clipboard and assert it holds an error the dialog never showed — `npm run e2e`.
- Typecheck: `npm run typecheck`.

## Open questions / future

- *(closed in v2)* The Preset Import wizard's inline error strip rendered
  `errors[0]` only. It now lists every message and carries its own copy control —
  [presets](presets.md) REQ-16.

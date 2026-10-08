# Paste import (song / preset JSON from an AI reply)

```yaml
id: paste-import
status: implemented
version: 3   # v3: REQ-the-paste-dialog-loads-on-click — the Paste dialog (and the fragment) load with the click
             # v2: a file dropped on the window takes the same routes (REQ-a-dropped-file-takes-the-paste-routes)
owner: ui
related:
  - song-mode
  - ai-prompt
  - presets
  - song-authoring-dialect
  - dialog
  - ../decisions/adr-014-dont-make-me-think
source:
  - src/state/paste-payload.ts               # pure: extractJson + classifyPayload
  - src/ui/components/paste-import.ts        # the fragment + its modal wrapper
  - src/ui/clipboard.ts                      # readClipboardText (shared helper)
  - src/ui/panels/song-panel.ts              # the Song row's Paste button
  - src/ui/components/ai-prompt.ts           # embeds the fragment as step 3
  - src/ui/components/preset-manager-modal.ts # initialImport → straight to review
  - src/ui/ui-bridge.ts                      # openPresetImport late-bound seam
```

A **paste** door for song and preset JSON: the same import pipelines the file
picker drives, fed from the clipboard instead of a file.

## Background / Why

Every import surface before this one needs *bytes from somewhere*: the
`song-import` file input, the installed PWA's `launchQueue`, and `#song=` share
links ([song-mode](song-mode.md), [pwa-install](pwa-install.md),
[song-share-link](song-share-link.md)). AI agents, though, answer in chat: they
reliably emit JSON — the ✨ AI Prompt's OUTPUT RULES see to that
([ai-prompt](ai-prompt.md)) — but almost never offer it as a download. The user
was left to paste the reply into a text editor, save it with the right
extension, and only then import it. Three steps of clerical work between "the AI
answered" and "I hear it".

So the paste door is built where the JSON actually arrives: inside the ✨ AI
Prompt modal, as the step after *Copy Prompt*. It is **also** reachable from a
Paste button in the Song row, because a payload that arrives some other way (a
teammate's chat message, a gist) deserves the same door and a feature reachable
from exactly one modal is a feature nobody finds.

Two properties carry the whole design:

- **Tolerance.** Agents wrap JSON in ```` ```json ```` fences and top-and-tail it
  with prose ("Here's your song! …Let me know if…"). Refusing that input would
  make the feature useless in the one situation it exists for, so the payload is
  *extracted* before it is parsed.
- **No second pipeline.** Paste classifies and routes; it never validates or
  applies anything itself. A song goes through `SongPanel.importBytes` — the
  exact path the file input uses — so error dialogs, the undo toast, the slot
  save and the Play cue all come free. A preset/bank goes into the existing
  import wizard's review step ([presets](presets.md) REQ-preset-import-is-a-two-step-wizard), so the conflict
  policy and counts are the ones already specified.

That second property is also the answer to [presets](presets.md) REQ-a-malformed-preset-is-refused-with-a-reason's
wrong-door problem. The file input can only *point* at the other door ("that is a
preset file — open it from Preset ▸ Import"). Paste has no such excuse: both
formats arrive through one textarea, so it simply routes.

## Requirements

- **REQ-extraction-comes-before-parsing** — **Extraction before parsing.**
  `extractJson(text)` returns the JSON body of a pasted reply, or `null`. It
  prefers the contents of the first fenced code block (```` ``` ```` with an
  optional language tag) and otherwise takes the whole text, then slices from
  the first `{` to the **last** `}`. Leading and trailing prose therefore never
  reaches the parser.
- **REQ-classification-is-pure-and-total** — **Classification is pure and
  total.** `classifyPayload(text)`
  returns exactly one of `song` | `author` | `preset` | `bank` | `unknown`, plus
  the extracted `json`, the payload's `name`, and (for presets/banks) a `count`.
  Routing keys off the `format` tag: `websynth-song`, `websynth-song-author`
  (`AUTHOR_FORMAT`), `websynth-preset` (`PRESET_FORMAT`),
  `websynth-preset-bank` (`BANK_FORMAT`).
- **REQ-a-missing-format-tag-is-inferred** — **A missing `format` tag is
  inferred, not rejected.** A JSON object carrying `seqBanks`/`drumBanks`
  classifies as `song`, and one carrying `seq`/`drums` as `author`, with
  `assumed: true`. The status line says the tag is missing and that loading will
  check it — the real validator then produces the precise error. An agent that
  drops one field must not hit a dead end.
- **REQ-unknown-always-carries-a-reason** — **`unknown` always carries a
  `reason`**, and the reason names what is wrong: no JSON found,
  malformed/incomplete JSON, no `format` field, or an unrecognized `format`
  value (quoting it). The status line shows it verbatim
  ([ADR-014](../decisions/adr-014-dont-make-me-think.md) law 1: never
  "invalid").
- **REQ-one-paste-fragment-two-placements** — **One fragment, two placements.**
  `buildPasteImport(opts)` returns a self-contained element (label, textarea
  `paste-input`, status line `paste-status`, *Paste from clipboard*
  `paste-read-clipboard`, confirm `paste-confirm`). `openPasteImportModal(opts)`
  wraps that same fragment in the shared `Modal` (`paste-modal`, wide card). The
  ✨ AI Prompt modal embeds the fragment inline as its third step. There is
  exactly one implementation.
- **REQ-paste-status-updates-live** — **Live feedback.** The status line and the
  confirm button's **label** re-render on every `input`: the label states the
  action it will take (`Load song`, `Review 4 presets`), and the button is
  **disabled** while the classification is `unknown`. Nothing is applied until
  it is pressed.
- **REQ-paste-confirm-routes-by-kind** — **Routing.** Confirm sends
  `song`/`author` to `onSong(TextEncoder().encode(json), 'pasted-song.json')` —
  i.e. `SongPanel.importBytes`, unchanged — and `preset`/`bank` to
  `onPresets(parsePresetPayload(json))`, the existing pure parser, which the
  preset manager opens **straight into its review step**. Paste itself never
  writes a preset, applies a song, or shows a validation error.
- **REQ-a-refused-load-leaves-the-text** — **A refused load leaves the text
  alone.** `onSong` resolves to whether the song applied; on `false` (validation
  failed — the import path has already shown its own error dialog) the modal
  stays open with the pasted text intact, so the user can fix a line rather than
  paste again. On success the host closes (`onDone`).
- **REQ-clipboard-read-is-a-convenience** — **Clipboard read is a convenience,
  never a dependency.** `readClipboardText()` resolves to `null` when the API is
  missing or permission is denied (Safari/Firefox without a user gesture), and
  the button then does nothing visible — the textarea is always the supported
  path.

- **REQ-a-dropped-file-takes-the-paste-routes** (v2) — **A file dropped on the
  window imports through the same routes.** Desktop users drag files; until v2 a
  file dropped on the app was handled by the *browser*, which navigates the tab
  to it — throwing the session away. `installFileDrop` (`src/ui/file-drop.ts`),
  installed by the Song panel with the Paste button's own routes, now claims
  every file drop (`preventDefault`, even a refused one) and routes the first
  file by kind:
  - a **`.zip`** → `SongPanel.importBytes`, exactly as Import → a project;
  - **`.json`/`.txt`** → `classifyPayload`: a song or author song →
    `importBytes`; a preset or bank → the preset manager's review step
    (REQ-paste-confirm-routes-by-kind); anything else → a toast carrying the
    classifier's reason (REQ-unknown-always-carries-a-reason);
  - an **audio** file → a toast saying audio loads into a sampler slot;
  - anything else → a toast naming the file.

  The size is checked **before the file is read**: JSON over
  `MAX_SONG_JSON_BYTES`, a zip over `MAX_ZIP_TOTAL_BYTES` is refused from
  `File.size` alone, by the same `oversizedFileMessage` the Import button and the
  `launchQueue` ask (untrusted-input.md REQ-a-file-is-sized-before-it-is-read).
  While a file is over the window an overlay (`file-drop-overlay`) says what a
  drop will do; it takes no pointer events and has no transition. While a dialog
  is open the drop is claimed and ignored, as the shortcuts are.

- **REQ-the-paste-dialog-loads-on-click** — **The Paste dialog loads on click**
  (v3, [runtime-performance](runtime-performance.md)
  REQ-boot-cost-matches-the-request). The Song row's Paste button `import()`s
  `paste-import.ts` through `loadSurface`, and the AI Prompt modal reaches the
  fragment through its own lazy body, so neither door costs boot. The file drop
  (REQ-a-dropped-file-takes-the-paste-routes) never needed the fragment and stays
  eager. The chunk is warmed on idle — pasting a song is an offline task.

## Technical design

### Contract / public interface

```yaml
# src/state/paste-payload.ts — PURE (no DOM, no song.ts)
extractJson(text: string): string | null
classifyPayload(text: string): PasteClassification

# src/ui/components/paste-import.ts
buildPasteImport(opts: PasteImportOptions): { el: HTMLElement; focus(): void }
openPasteImportModal(opts: PasteImportOptions): void
PasteImportOptions:
  onSong:    (bytes: Uint8Array, name: string) => Promise<boolean>
  onPresets: (parse: PresetParse) => void
  onDone?:   () => void          # host closes itself after a successful hand-off

# src/ui/clipboard.ts
readClipboardText(): Promise<string | null>

# src/ui/ui-bridge.ts
openPresetImport: (parse: PresetParse) => void    # late-bound in shell/header.ts

# src/ui/components/preset-manager-modal.ts
PresetManagerOptions.initialImport?: PresetParse  # opens on the review step
```

### Data shapes

```yaml
PasteKind: song | author | preset | bank | unknown
PasteClassification:
  kind: PasteKind
  json?: string      # the extracted body — present whenever kind != unknown
  name?: string      # the payload's own name
  count?: number     # presets in the payload (1 for a preset file)
  assumed?: true     # REQ-a-missing-format-tag-is-inferred — kind inferred from keys, no format tag
  reason?: string    # REQ-unknown-always-carries-a-reason — only when kind == unknown
```

### Layer touchpoints & ordering

```yaml
song-panel:   Paste button -> openPasteImportModal({ onSong: importBytes,
                onPresets: bridge.openPresetImport })
ai-prompt:    createAiPromptButton(bus, { onSong, onPresets }) -> the same
                fragment inline as step 3; onDone closes the AI modal
header.ts:    bridge.openPresetImport = (parse) => openPresetManagerModal({
                bus, session, onPresetsChanged, initialImport: parse })
```

`openPresetImport` goes through `UiBridge` because the preset manager is owned by
the header (`buildHeader`, where the preset dropdown that must refresh lives) and
the Paste button by the Song panel — the same late-bound seam as `showTab` /
`importSongBytes`. The Song panel never imports the preset manager.

### Persistence

None. The pasted text is transient in-DOM and is deliberately not autosaved: what
lands in storage is whatever the song/preset import path writes, exactly as if it
had come from a file.

## Scenarios (BDD)

```gherkin
Scenario: A dropped file imports through the paste routes (v2, REQ-a-dropped-file-takes-the-paste-routes)
  Given the app is open with no dialog
  When a song .json is dropped on the window
  Then it imports exactly as Import would, and the tab does not navigate away
  When a preset bank .json is dropped
  Then the preset manager opens on its review step
  When a .wav, a .pdf, or a JSON with no websynth format is dropped
  Then a toast says why nothing was imported
  And a .json larger than the song cap is refused without being read
# pinned by: tests/ui/file-drop.test.ts, e2e/paste-import.spec.ts

Scenario: A fenced AI reply loads as a song
  Given an author-dialect song wrapped in a ```json fence with prose around it
  When it is pasted and the confirm button pressed
  Then the JSON between the braces is imported like a file
  And the song is applied with its undo toast
# pinned by: tests/state/paste-payload.test.ts, e2e/paste-import.spec.ts

Scenario: The status line names what was recognized
  Given a bank payload holding 4 sounds
  When it is pasted
  Then the status line names the bank and its 4 presets
  And the confirm button reads "Review 4 presets"
# pinned by: tests/ui/paste-import.test.ts

Scenario: A bank routes into the preset review step, not the song importer
  Given a websynth-preset-bank payload
  When the confirm button is pressed
  Then onPresets receives the parsed presets
  And the preset manager opens on its review step
# pinned by: tests/ui/paste-import.test.ts, e2e/paste-import.spec.ts

Scenario: A song with no format tag is inferred, not refused (edge)
  Given a JSON object with seqBanks and drumBanks but no format field
  When it is pasted
  Then it classifies as a song with assumed set
  And the status line says the tag is missing and load will check it
# pinned by: tests/state/paste-payload.test.ts

Scenario: Truncated JSON is refused with a reason (edge)
  Given a reply the agent cut off mid-object
  When it is pasted
  Then the classification is unknown with a malformed-JSON reason
  And the confirm button is disabled
# pinned by: tests/state/paste-payload.test.ts, tests/ui/paste-import.test.ts

Scenario: A failed import keeps the pasted text (edge)
  Given a well-formed payload the song validator rejects
  When the confirm button is pressed and onSong resolves false
  Then the textarea still holds the text and onDone is not called
# pinned by: tests/ui/paste-import.test.ts
```

## Tests & verification

- Unit: `tests/state/paste-payload.test.ts` (extraction + every classification),
  `tests/ui/paste-import.test.ts` (status line, disabled confirm, routing),
  `tests/ui/ai-prompt.test.ts` (the embedded step 3), `tests/ui/file-drop.test.ts`
  (v2 — the dropped-file routes and the size gate) — `npm test`
- E2E: `e2e/paste-import.spec.ts` (a fenced song pasted through `song-paste`
  applies; a bank reaches `preset-import-review`; v2: a dropped file imports and
  the tab does not navigate away) — `npm run e2e`
- Typecheck: `npm run typecheck`

## Open questions / future

- Accept a **project zip** by paste (base64) — the clipboard carries text only,
  so this needs a wire format that does not exist yet.
- ~~Drag-and-drop a file onto the app window~~ — v2, REQ-a-dropped-file-takes-the-paste-routes.
  Dropping an **audio** file only explains where audio goes; dropping one onto a
  sampler slot to load it would be the natural next door, and needs a per-slot
  drop target the grid does not have.

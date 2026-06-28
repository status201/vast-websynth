# AI Prompt (generate a song with AI)

```yaml
id: ai-prompt
status: implemented
version: 1
owner: ui
related:
  - song-mode
  - architecture
source:
  - src/ui/components/ai-prompt.ts        # createAiPromptButton, buildModal, buildSongPrompt
  - src/ui/styles/modal.module.css        # .aiText / .aiBrief / .aiActions
  - src/ui/panels/song-panel.ts           # mounts the ✨ AI Prompt button in the io row
```

## Background / Why

A song file (`.websynth.json`) is a large, structured JSON document. The **✨ AI
Prompt** button in the Song panel hands the user a ready-to-copy prompt that
describes the format precisely enough for any AI agent to author a valid song,
which the user then imports via Song → Import. The prompt is generated **live**
from `ParamBus` + the structural constants so it can never drift from
`registerDefaults()`.

The first version embedded an entire demo song (minified) as a worked example,
which dominated the textarea, and pointed AIs at a relative schema path that only
resolves inside the app. This version keeps the prompt short, lets the user state
their creative brief inline, and emits an absolute, host-resolved schema URL that
an external agent can actually fetch.

## Requirements

- **REQ-1** — The modal has an editable **"Describe your song"** field at the top,
  seeded only as `placeholder` text (a Rockit-style example). Its value is injected
  into a `SONG REQUEST` section at the top of the copyable prompt, updating **live**
  as the user types.
- **REQ-2** — When the brief is empty/whitespace, `SONG REQUEST` shows a bracketed
  placeholder line (e.g. `[Describe the song you want — …]`) — **not** the example
  text. Copying without typing must never inject the example.
- **REQ-3** — The prompt cites the published JSON Schema as an **absolute** URL:
  `<origin>/schema/websynth-song.schema.json`, where `<origin>` is the live
  `window.location.origin`. Resolution is guarded so the function stays safe to
  import in a non-browser context (falls back to the bare path).
- **REQ-4** — The prompt embeds only a concise, illustrative **EXAMPLE SHAPE**
  skeleton (with `…` ellipses) — not a full song. It demonstrates default-sparse
  cells: seq cells keep `on/note/velocity/gate`; trigger (drum/sampler) dead cells
  collapse to `{ "on": false }`; arrays must be filled to full size. The prompt
  text must **not** reference the modal's example buttons.
- **REQ-5** — The PARAMS table (one line per `ParamBus` id with range/default/value
  map) and the NOTES/tips section are generated live and kept as the format
  reference; the modal's **Copy Example JSON** / **Download Example** buttons still
  return the full built-in "I Feel Love" demo.

## Technical design

### Contract / public interface

- `createAiPromptButton(bus: ParamBus): HTMLButtonElement` — the `✨ AI Prompt`
  button + lazily-built modal (reuses the `Modal` lifecycle classes + Escape/
  backdrop close, like `record-sound-modal`).
- `buildSongPrompt(bus: ParamBus, brief?: string): string` — pure prompt builder.
  `brief` is the user's creative request; omitted/blank → bracketed placeholder.
  Exported and unit-tested directly.

Modal wiring: an editable brief `<textarea>` (`.aiBrief`) sits above the read-only
prompt `<textarea>` (`.aiText`); an `input` listener rebuilds the prompt value via
`buildSongPrompt(bus, brief.value)`. **Copy Prompt** copies the live prompt value
(so the brief is always included). **Copy Example JSON** / **Download Example** use
`Song.toJSON` / `Song.download` of `DEMO_SONGS['I Feel Love']`.

### Prompt shape (sections, in order)

```
intro line (VAST G1-J5)
SONG REQUEST        <- brief or bracketed placeholder (REQ-1/2)
OUTPUT RULES        <- includes the absolute schema URL (REQ-3)
TOP-LEVEL SHAPE     <- field-by-field, from structural constants
SeqStep / DrumCell  <- cell type definitions + default fallbacks
NOTES               <- musical tips (kept verbatim) (REQ-5)
PARAMS              <- live bus.ids()/bus.def() dump (REQ-5)
EXAMPLE SHAPE       <- abbreviated skeleton with … (REQ-4)
```

### Layer touchpoints & ordering

- `src/ui/components/ai-prompt.ts` — all behaviour. Imports `Song`/`DEMO_SONGS`
  (state/song), `DRUM_TRACK_LABELS` (state/params), and `SEQ_LENGTH`/`BANK_COUNT`/
  `BANK_LABELS`/`DRUM_TRACK_COUNT`/`SAMPLER_SLOT_COUNT` (state/patterns).
- `src/ui/styles/modal.module.css` — `.aiBrief` (small editable textarea) + a small
  label, matching `.aiText` tokens.
- `src/ui/panels/song-panel.ts` — appends `createAiPromptButton(bus)` to the io row
  (unchanged by this version).

### Persistence

None. The brief is transient in-DOM; it is deliberately **not** persisted and never
enters `ParamBus`, presets, or songs.

## Scenarios (BDD)

```gherkin
Scenario: Absolute, host-resolved schema link
  Given the app is served from an origin
  When buildSongPrompt(bus) is generated
  Then it cites "<origin>/schema/websynth-song.schema.json" as an absolute URL

Scenario: A creative brief is injected into SONG REQUEST
  Given a brief "in the style of Rockit, 12-bar loop with breaks"
  When buildSongPrompt(bus, brief) is generated
  Then the brief text appears under the SONG REQUEST heading

Scenario: An empty brief yields a placeholder, not the example
  When buildSongPrompt(bus, "") is generated
  Then SONG REQUEST shows a bracketed "[Describe …]" placeholder
  And it does not contain the Rockit example text

Scenario: The prompt no longer embeds a full song
  When buildSongPrompt(bus) is generated
  Then it contains the EXAMPLE SHAPE skeleton marker with "…"
  And it is far shorter than Song.toJSON(DEMO_SONGS['I Feel Love'])
# pinned by: tests/ui/ai-prompt.test.ts
```

## Tests & verification

- Unit: `tests/ui/ai-prompt.test.ts` — `npm test`
- Typecheck: `npm run typecheck`
- Manual: dev server → Song panel → ✨ AI Prompt — type in the brief and watch the
  `SONG REQUEST` section update; confirm the schema line is a full `http(s)://…`
  URL; confirm the example buttons still return the full demo.

## Open questions / future

- Optionally let the brief seed from the current loaded song's name/mood.
- A one-click "open in <AI tool>" deep link.

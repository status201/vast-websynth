# AI Prompt (generate a song with AI)

```yaml
id: ai-prompt
status: implemented
version: 3
owner: ui
related:
  - song-mode
  - song-authoring-dialect
  - architecture
  - webrtc-sync
source:
  - src/state/authoring-guide.ts          # buildAuthoringGuide + buildSongPrompt (pure, no song.ts)
  - src/ui/components/ai-prompt.ts        # createAiPromptButton, buildModal (re-exports buildSongPrompt)
  - src/ui/clipboard.ts                   # copyText / flashCopied (shared clipboard util)
  - src/ui/styles/modal.module.css        # .aiText / .aiBrief / .aiActions
  - src/ui/panels/song-panel.ts           # mounts the ✨ AI Prompt button in the io row
  - public/schema/websynth-song-author.schema.json  # author-dialect schema (cited by the prompt)
  - public/llms.txt                       # discovery pointer for crawling agents
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
resolves inside the app. Version 2 kept the prompt short, let the user state
their creative brief inline, and emitted an absolute, host-resolved schema URL.

Version 3 makes the **compact authoring dialect** (see
[song-authoring-dialect.md](song-authoring-dialect.md)) the recommended output:
only the strongest LLMs reliably emit the full canonical grids, while the dialect
is ~40 lines. The prompt-building logic moved to the pure
`src/state/authoring-guide.ts` (importing only `params.ts`/`patterns.ts`, never
`song.ts`) so the MCP server's Node bundle can serve the same guide;
`ai-prompt.ts` keeps the modal and re-exports `buildSongPrompt`.

## Requirements

- **REQ-1** — The modal has an editable **"Describe your song"** field at the top,
  seeded only as `placeholder` text (a Rockit-style example). Its value is injected
  into a `SONG REQUEST` section at the top of the copyable prompt, updating **live**
  as the user types.
- **REQ-2** — When the brief is empty/whitespace, `SONG REQUEST` shows a bracketed
  placeholder line (e.g. `[Describe the song you want — …]`) — **not** the example
  text. Copying without typing must never inject the example.
- **REQ-3** — The prompt cites **both** published JSON Schemas as **absolute**
  URLs: `<origin>/schema/websynth-song-author.schema.json` (author dialect) and
  `<origin>/schema/websynth-song.schema.json` (canonical), where `<origin>` is
  the live `window.location.origin`. Resolution lives in `authoring-guide.ts`
  and is guarded so the module stays safe to import outside a browser (falls
  back to the bare path); `buildAuthoringGuide` also accepts an explicit
  `origin` for non-browser callers (the MCP server).
- **REQ-4** — The prompt teaches the **authoring dialect as the recommended
  output**: a complete QUICKSTART example (valid, importable) plus the compact
  format reference lead the prompt; the canonical full form (TOP-LEVEL SHAPE,
  cell types, and the `…`-elided **EXAMPLE SHAPE** skeleton) is demoted to an
  appendix. The prompt text must **not** reference the modal's example buttons.
- **REQ-5** — The PARAMS table (one line per `ParamBus` id with range/default/value
  map) and the NOTES/tips section are generated live and kept as the format
  reference; the modal's **Copy Example JSON** / **Download Example** buttons still
  return the full built-in "I Feel Love" demo.
- **REQ-7** — The OUTPUT RULES are anti-give-up guardrails for weaker agents:
  respond with exactly ONE JSON object and no prose; a compact song is under
  ~80 lines; NEVER truncate or emit placeholders; if length is a concern,
  author 1–2 banks and repeat them via a chain.
- **REQ-8** — `public/llms.txt` gives crawling agents the app intro, both format
  names + schema URLs, the grid dimensions and drum track names, and points at
  the in-app AI Prompt for the live PARAMS table (which is bus-generated and
  would drift if duplicated).
- **REQ-6** — The modal card composes the base `.card` (height-capped to `86vh`,
  internally scrollable) **with** the `.cardWide` width variant — the same
  composition the reusable `Modal` helper uses. So on small/short viewports the card
  fits the screen and scrolls internally; the title and every action (incl. Close)
  stay reachable. On phones the prompt/brief textareas are shortened so the actions
  come into reach with little scrolling.

## Technical design

### Contract / public interface

- `buildAuthoringGuide(bus: ParamBus, origin?: string): string` — pure format
  guide (OUTPUT RULES → QUICKSTART → author format → NOTES → PARAMS → canonical
  appendix), in `src/state/authoring-guide.ts`. `origin` defaults to
  `window.location.origin` when available, else `''`.
- `buildSongPrompt(bus: ParamBus, brief?: string): string` — pure prompt builder:
  intro + `SONG REQUEST` (the brief, or a bracketed placeholder) + the guide.
  Lives in `authoring-guide.ts`; re-exported from `ai-prompt.ts` for the UI/tests.
- `createAiPromptButton(bus: ParamBus): HTMLButtonElement` — the `✨ AI Prompt`
  button + lazily-built modal (reuses the `Modal` lifecycle classes + Escape/
  backdrop close, like `record-sound-modal`).

Modal wiring: an editable brief `<textarea>` (`.aiBrief`) sits above the read-only
prompt `<textarea>` (`.aiText`); an `input` listener rebuilds the prompt value via
`buildSongPrompt(bus, brief.value)`. **Copy Prompt** copies the live prompt value
(so the brief is always included). **Copy Example JSON** / **Download Example** use
`Song.toJSON` / `Song.download` of `DEMO_SONGS['I Feel Love']`.

The ad-hoc card must carry both classes —
`card.className = ${Modal.cardClass} ${Modal.cardWideClass}` — so it inherits the
base `.card` cap/scroll (REQ-6); `.cardWide` wins on width by source order.

### Prompt shape (sections, in order)

```
intro line (VAST G1-J5)
SONG REQUEST          <- brief or bracketed placeholder (REQ-1/2)
OUTPUT RULES          <- anti-give-up guardrails + both absolute schema URLs (REQ-3/7)
QUICKSTART            <- a complete, valid author-dialect song (REQ-4)
COMPACT AUTHOR FORMAT <- the recommended dialect, field-by-field (REQ-4)
NOTES                 <- musical tips (REQ-5)
PARAMS                <- live bus.ids()/bus.def() dump (REQ-5)
APPENDIX (canonical)  <- TOP-LEVEL SHAPE, cell types, EXAMPLE SHAPE skeleton with … (REQ-4)
```

Everything from OUTPUT RULES down is `buildAuthoringGuide`; `buildSongPrompt`
prepends the intro + SONG REQUEST.

### Layer touchpoints & ordering

- `src/state/authoring-guide.ts` — the prompt/guide text. Imports
  `DRUM_TRACK_LABELS` (state/params) and `SEQ_LENGTH`/`BANK_COUNT`/`BANK_LABELS`/
  `DRUM_TRACK_COUNT`/`SAMPLER_SLOT_COUNT` (state/patterns). It must **never**
  import `song.ts` (whose `import.meta.glob` demo registration would poison the
  MCP server's Node bundle — same constraint as `song-author.ts`).
- `src/ui/components/ai-prompt.ts` — the modal. Imports `buildSongPrompt` from
  the guide (and re-exports it), plus `Song`/`DEMO_SONGS` (state/song) for the
  example buttons. The clipboard helpers `copyText` / `flashCopied` are imported
  from the shared `src/ui/clipboard.ts` (extracted verbatim so the WiFi pair
  modal can reuse them — see [webrtc-sync.md](webrtc-sync.md)).
- `src/ui/styles/modal.module.css` — `.aiBrief` (small editable textarea) + a small
  label, matching `.aiText` tokens.
- `src/ui/panels/song-panel.ts` — appends `createAiPromptButton(bus)` to the io row
  (unchanged by this version).

### Persistence

None. The brief is transient in-DOM; it is deliberately **not** persisted and never
enters `ParamBus`, presets, or songs.

## Scenarios (BDD)

```gherkin
Scenario: Absolute, host-resolved schema links (both formats)
  Given the app is served from an origin
  When buildSongPrompt(bus) is generated
  Then it cites "<origin>/schema/websynth-song-author.schema.json" as an absolute URL
  And it cites "<origin>/schema/websynth-song.schema.json" as an absolute URL

Scenario: The dialect leads, with anti-give-up guardrails
  When buildSongPrompt(bus) is generated
  Then the QUICKSTART example uses format "websynth-song-author"
  And the OUTPUT RULES say to respond with exactly ONE JSON object
  And they forbid truncation/placeholder output
  And the author-dialect sections appear before the canonical appendix

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

Scenario: Modal stays usable on a small screen
  When the AI Prompt modal is opened
  Then its dialog card carries both the base "card" and "cardWide" classes
  And so it is height-capped and scrolls internally (Close stays reachable)
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

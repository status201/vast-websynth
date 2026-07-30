# Specs — Spec-Driven Development for VAST G1-J5

This folder is the **architectural source of truth** for the synth. Specs are
written for both humans and AI agents to read, so an agent can act from a current,
authoritative description instead of re-deriving intent from stale code snapshots.

We are trying **Spec-Driven Development (SDD)**: the spec comes first and the code
is treated as a (re-generatable) consequence of it. In practice that means two
things in this repo:

1. **Document** the load-bearing architecture that already exists, so it stops
   living only in people's heads.
2. **Spec-first for new work** — write/review the spec for a new feature *before*
   generating the code that implements it.

> The package/repo is `websynth`; the product is presented in-app as
> **VAST G1-J5**. Same thing.

## What a good spec contains

Every spec aims to cover, in roughly this order:

- **Background / the "why"** — the context behind the "what", so a reader (or
  agent) can reason ahead about the steps you'll need.
- **Requirements** — the technical design broken into discrete, numbered pieces
  (`REQ-1`, `REQ-2`, …), not a vague one-liner.
- **Technical design** — the public **contract/interface**, the **data shapes**,
  the **layer touchpoints** (what collaborates and in what order), and
  **persistence** (storage keys, file format, and what is *deliberately not*
  persisted).
- **Visual aids** — a diagram where it helps, plus a list of tools/libraries with
  **explicit version numbers**.
- **Scenarios** — what good looks like, what failure looks like, and the edge
  cases, written as **BDD/Gherkin** (see below).
- **Tests & verification** — which suites pin the behaviour and how to run them.

> This is the **feature** shape (the *what*). **Recipes** (`recipes/`) follow a
> leaner *playbook* shape — Background → Steps → Gotchas → Scenarios (BDD) → Tests,
> dropping Requirements / Technical-design / Visual-aids — so copy
> `recipes/_recipe-template.md`, not the feature template. **ADRs** (`decisions/`)
> use their own Context → Decision → Alternatives → Consequences shape
> (`decisions/_adr-template.md`).

## This repo is not a typical web app — concept mapping

The general SDD literature assumes a backend with a database and a REST API. This
codebase has **neither** (vanilla TypeScript, Web Audio, zero runtime
dependencies). So the usual spec ingredients map onto what *this* repo actually
has:

| General SDD concept   | VAST G1-J5 equivalent                                                              |
| --------------------- | --------------------------------------------------------------------------------- |
| Database schema       | The `ParamBus` registry (`ParamDef`) for scalars; `PatternStore` step grids       |
| API contract          | Module public interfaces — `ParamBus`, `Engine`, `Song`, `Arrangement`; and the AudioWorklet `port.postMessage` message contracts |
| Persistence / model   | The `SongFile` JSON schema + `localStorage` keys (`websynth.song.*`, `websynth.preset.*`) |
| System diagram        | The audio-graph topology (voices → FX buses → master)                             |

See [`architecture.md`](architecture.md) for the system-wide version of all four.

## Format rules

LLMs process tokenized text, so format affects accuracy *and* cost. Keep `specs/`
a **lean compiled instruction set, not a dumping ground** — every needless newline
and indent costs tokens and latency.

- **Markdown headers** for narrative / instructions.
- **Flat YAML** (in a fenced ```` ```yaml ```` block) for structured config and for
  any schema nested **more than ~3 levels deep** — YAML parses more reliably than
  JSON/XML for deep nesting. Prefer flat key paths over deep trees.
- Reference code **by symbol name** (`registerDefaults`, `Engine.subscribeParams`,
  `Song.apply`) and file path, **not** by line number — line numbers rot.
- **Specs are where the detail lives.** `CLAUDE.md` is a routing map (what to read
  when you touch a given area) plus the few directory-scoped conventions files it
  points at (`src/ui/CLAUDE.md`, `e2e/CLAUDE.md`); it deliberately does **not**
  restate architecture. So a detail belongs in the governing spec, not in
  `CLAUDE.md` — and a spec should link to `architecture.md` for the system-wide
  contracts rather than re-deriving them, while staying standalone enough to read
  on its own.

## BDD — scenarios in Gherkin

Behaviour is specified as `Scenario / Given / When / Then`. This forces
**State → Action → Outcome** thinking and removes guesswork about what "done"
means. Every scenario should name the **test that pins it**, so the spec stays
backed by a green check:

```gherkin
Scenario: Cutoff knob updates the live filter
  Given the audio engine is running
  When the user drags the CUTOFF knob to note 100
  Then bus.get('filter.cutoff') returns 100
  And every voice's ladder filter tracks the new cutoff
# pinned by: tests/state/params.test.ts, e2e/controls.spec.ts
```

## Spec lifecycle

Each spec carries a `status` in its metadata block:

- `draft` — being written / under review; not yet built.
- `active` — agreed and being implemented.
- `implemented` — shipped; the spec now documents what exists and is the source of
  truth for future changes.

For **new** features: write the spec as `draft`, get a human to catch logic flaws
*before* an agent generates code, then move it to `active`/`implemented`.

## Decisions (ADRs) — the "why" layer

Feature specs capture the **what** and recipes the **how**, but the *why* behind a
cross-cutting architectural choice — and crucially, **which alternatives were
rejected and the trade-off accepted** — lived only implicitly in prose. That's
what makes a deliberate constraint indistinguishable from an accident, and invites
someone to "fix" a thing that was chosen on purpose.

`decisions/` holds **Architecture Decision Records**: one short, immutable record
per decision, structured Context → Decision → Alternatives → Consequences. Copy
[`decisions/_adr-template.md`](decisions/_adr-template.md) to start one
(`adr-NNN-<slug>.md`, numbered contiguously); [`decisions/README.md`](decisions/README.md)
is the index. An ADR's `status` is its own
decision lifecycle — `proposed | accepted | superseded by adr-XXX | deprecated` —
**not** the `draft | active | implemented` of a feature spec. ADRs are
append-only: to change a decision, write a new ADR that supersedes the old one
rather than rewriting it. Each ADR's `related:` links to the specs it governs, and
[`architecture.md`](architecture.md) → "Key decisions" links back to the ADRs.

## Procedure by change type

**Spec-before-code**: a change that edits production code (`src/**`,
`public/worklets/**`) must create/update a spec in the *same* change — the SDD
hooks + CI enforce this (see "Enforcement & exemptions"). By kind of change:

**Feature / any behaviour change**
1. **Spec first** — create/update `specs/features/<name>.md` from
   `features/_feature-template.md` (`status: draft`): background, requirements
   (`REQ-n`), contract, data shapes,
   BDD scenarios.
2. **Review** — a human reads the spec (plan-approval / PR). `status: active`.
3. **Implement** the code to satisfy the spec.
4. **Test** — add tests mapping to each Gherkin scenario.
5. **Reconcile** — `status: implemented`; the spec matches what shipped.

**Bug fix** — find the governing spec. If it's wrong/missing, fix the spec first;
if the code merely diverged from a correct spec, add a **regression scenario**
capturing the bug. Then implement the fix + a test mapping to that scenario.

**Refactor (no behaviour change)** — the spec is the invariant; keep its contract +
scenarios green. Only edit the spec if a public **contract** changes.

**Trivial** — typos, comments, formatting, pure renames, dep bumps, and
test/style/doc edits need no spec (see exemptions below).

The `/feature`, `/fix`, and `/spec` slash commands run these flows.

## Enforcement & exemptions

SDD is enforced by `scripts/sdd-guard.mjs`, wired as Claude Code hooks
(`.claude/settings.json`) and a CI check (`.github/workflows/sdd.yml`):

- **PreToolUse** blocks an `Edit`/`Write` to production code when no spec changed.
- **Stop** blocks finishing a turn whose diff changed production code without specs.
- **CI** fails a PR with the same rule (also catches non-Claude agents + direct
  commits).

**Exempt automatically** (no spec needed): everything outside `src/` /
`public/worklets/`, plus `*.md`, `*.css` / `src/ui/styles/**`, `src/vendor/**`,
and `src/state/demos/**` (demo songs are data drop-ins, not code — see
`recipes/add-a-demo-song.md`).

**Explicit bypass** for a rare trivial *production* change: `touch .sdd-skip`
(a gitignored sentinel) locally, or put `[skip-sdd]` in a commit message / add the
`skip-sdd` PR label for CI.

> The guard checks that a spec *changed*, not that it is *good* — spec quality is
> the human review gate. A companion check, `scripts/spec-lint.mjs`
> (`npm run spec:lint`), validates spec *structure*: a metadata block, `id`
> matching the filename, a valid `status`, that `# pinned by:` paths resolve, and
> that every spec/ADR is listed in this folder map **and** the `decisions/` index.
> It runs in CI (PRs **and** pushes to `main`) **and** unconditionally as a local
> `Stop` hook (blocking the finish on a malformed spec — it lints even when the
> turn ended with everything committed, since a clean tree says nothing about the
> committed specs). Hooks can be disabled by editing `.claude/settings.json`, so
> CI is the real cross-tool backstop.

## Folder map

```
specs/
  README.md            ← you are here (the method)
  architecture.md      ← system-wide source of truth (read this first)
  features/            ← one spec per feature
    _feature-template.md ·  copy this to start a new feature spec
    # — synth sound engine —
    oscillators.md     ·  osc1/osc2/sub + noise mixer (sound sources)
    ladder-filter.md   ·  the resonant ladder filter (canonical scalar example)
    envelopes.md       ·  amp + filter ADSR
    lfo.md             ·  LFO + mod wheel
    voicing.md         ·  poly/mono, unison, glide, drift, pitch bend
    # — effects —
    effects.md         ·  distortion/wah/phaser/delay/reverb insert chain
    compressor.md      ·  the FET/VCA worklet compressors (message contract)
    fx-group.md        ·  shared header FX-group UI (knobs hide while bypassed)
    fx-patch-decoration.md · unpatched-cable scenery in the empty FX grid cell
    # — transport & sequencing —
    transport.md       ·  the look-ahead clock
    transport-position.md · moving the playhead (seek, position ruler, Home/Shift+arrows)
    transport-window.md · the Song-panel transport row + its floating window
    arpeggiator.md     ·  held-note arp + transport ownership
    sequencer.md       ·  the 16-step synth sequencer
    drum-machine.md    ·  8-track synth drums
    drum-kits.md       ·  factory kit presets + randomize + per-track reset
    sampler.md         ·  8-slot one-shot sampler
    step-settings.md   ·  per-step vel/gate/prob/ratchet/tie + hit math
    step-grid-editing.md ·  the shared grid gesture model (tap/paint/hold, Clear ▾)
    banks.md           ·  A/B/C/D banks, edit-vs-play bank
    pattern-undo.md    ·  per-machine step-grid undo (button + scoped Ctrl+Z)
    arrangement.md     ·  the four chain lanes
    motion-sequencer.md ·  XY param automation machine (anchors, slide/step)
    arrangement-rest.md ·  the always-empty "rest" chain slot
    performance.md     ·  live DJ FX (stutter/fill/drop/tape-stop)
    midi-clock-sync.md ·  master/slave transport sync over MIDI real-time (24 PPQN)
    webrtc-sync.md     ·  serverless WebRTC DataChannel WiFi sync (LAN, QR/paste pairing)
    xy-pad.md          ·  assignable momentary XY controller (spring-back)
    # — songs & persistence —
    song-mode.md       ·  the cross-cutting integration feature
    untrusted-input.md ·  the trust boundary: payload limits, ranges, consent (cross-cutting)
    song-authoring-dialect.md ·  compact input-only song format for AI agents (expanded on import)
    song-share-link.md ·  #song=/#songUrl= hash links + the export modal's Copy Link
    mcp-server.md      ·  zero-dep stdio MCP server for song authoring/validation
    project-export.md  ·  song + sampler audio in one .websynth.zip (zero-dep zip codec)
    session-autosave.md ·  working-session autosave + load-undo toast safety net
    sample-persistence.md ·  sampler clips in IndexedDB, so audio survives a reload
    presets.md         ·  sound snapshots (param-only)
    preset-authoring.md ·  AI preset/bank guide + validator + sparse→full expansion (MCP)
    param-reset-baseline.md ·  knob double-tap resets to the loaded preset/song value
    ai-prompt.md       ·  copyable prompt that has an AI generate a song file
    paste-import.md    ·  paste song/preset JSON (AI reply) instead of importing a file
    # — audio I/O —
    audio-export.md    ·  WAV/MP3 capture of the master (phases, runs, tail bar)
    record-window.md   ·  floating record transport: pause, timer, save-or-discard
    sample-recorder.md ·  mic record + buffer editor
    render-to-sampler.md ·  resample a seq bank into a sampler slot (bar-exact)
    # — UI / UX —
    dropdown.md        ·  shared dropdown component (popover menu, scroll+focus to selection)
    dialog.md          ·  shared confirm/prompt/alert dialog (replaces the native ones)
    toast.md           ·  transient bottom-center notification with one action (Undo)
    floating-window.md ·  reusable non-modal draggable window (no backdrop/Escape + minimise)
    live-fx-window.md  ·  floating "LIVE FX" window: DJ controls reachable off the Song tab
    responsive-header.md ·  mobile hamburger menu + header cluster reflow
    responsive-machine-header.md ·  pattern panel control row: wrap + FX cluster
    responsive-synth-panels.md ·  4-knob panels: 2x2 desktop, single row on tablets
    machine-status.md  ·  on/muted/off LEDs in the tab bar + Song-tab title links
    input-control.md   ·  keyboard, computer-key shortcuts, MIDI
    testids.md         ·  the stable `data-testid` contract + full catalogue
    onboarding.md      ·  guided tour + help mode
    play-button-blink.md ·  Play LED states: beat blink, idle attract pulse, demo cue
    empty-play-hint.md ·  "nothing to play" modal on empty Play + persisted opt-out
    tempo-sync-help.md ·  BPM "sweet spots" + relationship help badges (click-to-snap)
    performance-mode.md ·  device-scoped audio-quality setting (buffer/voices/scope)
    runtime-performance.md ·  app-wide cost contract (boot budget, gesture-scoped listeners, automation≠edit)
    ios-audio.md       ·  iOS silent-switch unlock (media-backed context) + interruption re-arm
    audio-lifecycle.md ·  click-free start, foreground re-arm, screen-off dropout recovery
    media-session.md   ·  Android keep-alive: silent loop + MediaSession so the OS sees a player
    pwa-install.md     ·  installed-app experience: wake lock, fullscreen, file handling, offline SW
    debug-panel.md     ·  reusable About-modal Debug section (live runtime readouts)
    factory-reset.md   ·  About-modal "Restore to Factory Settings" (clear all local data + reload)
    scope.md           ·  wave/spectrum live visualizer + mono/stereo split
  recipes/             ← repeatable how-tos / playbooks
    _recipe-template.md       ·  copy this to start a new recipe
    add-a-parameter.md       ·  the 3-edit pattern for any new scalar param
    design-an-interaction.md ·  gesture inventory → precedent → wiring → undo
    add-an-effect.md         ·  a bypass-able insert effect on a bus
    add-an-audioworklet.md   ·  a new audio-thread DSP node + wrapper
    add-a-ui-component.md     ·  a hand-built DOM component
    add-a-panel.md            ·  a tab panel (StudioApi facade + TabContainer)
    add-a-modal-dialog.md     ·  a single-use Modal dialog (backdrop + Escape)
    add-a-floating-window.md  ·  a non-modal draggable window launcher
    add-a-transport-module.md ·  a clock-driven scheduler (onTick + absolute when)
    add-a-demo-song.md        ·  a drop-in demo SongFile (data only)
    add-a-drum-voice.md       ·  a new synthesised drum track
    add-a-factory-preset.md   ·  a built-in sound preset
    add-a-tour-step.md        ·  a guided-tour / help step
    evolve-the-song-format.md ·  bump the SongFile version, stay back-compat
    write-a-test.md           ·  unit (Vitest) + E2E (Playwright) conventions
    verify-audio-by-ear.md    ·  render a take through the real graph, listen, measure
  decisions/           ← Architecture Decision Records (the "why")
    README.md                                 ·  the ADR index (number / title / status)
    _adr-template.md                          ·  copy this to start a new ADR
    adr-000-spec-driven-development.md        ·  why specs lead code (enforced)
    adr-001-parambus-over-redux.md            ·  one scalar bus, not a framework
    adr-002-audioworklet-compressor.md        ·  custom worklet over the native node
    adr-003-no-runtime-dependencies.md        ·  vanilla TS + the Web platform
    adr-004-patternstore-separate-from-parambus.md ·  grids aren't scalars
    adr-005-cutoff-as-midi-note.md            ·  semitone-additive modulation
    adr-006-no-op-param-defaults.md           ·  new params can't change old sounds
    adr-007-songfile-additive-versioning.md   ·  the song format only grows
    adr-008-components-self-wire-params.md     ·  effects self-wire (Effect.bind)
    adr-009-ui-depends-on-studio-api-facade.md ·  UI sees a narrow StudioApi facade
    adr-010-musical-stable-cheap-dsp.md        ·  DSP worklets: musical, stable, cheap
    adr-011-export-precision-and-default-sparse-serialization.md ·  compact export at the boundary
    adr-012-true-bypass-disconnects.md         ·  bypassed FX disconnect their processed path
    adr-013-authoring-dialect-input-only.md    ·  the authoring dialect is input-only
    adr-014-dont-make-me-think.md              ·  interaction design: six ordered UX laws
    adr-015-untrusted-input-is-bounded.md      ·  bound every payload; no listener wedges the clock
```

> Coverage note: the feature set above documents the current system. New features
> get their own spec (copy `features/_feature-template.md`) as they're built — keep the folder lean,
> not exhaustive-for-its-own-sake. Smaller single-function extension points (a new
> `encode` format, a `buffer-dsp` op, an LFO destination) are noted inline in the
> relevant feature spec's "Open questions" rather than as separate recipes.

## Writing a new spec

1. For a feature, copy [`features/_feature-template.md`](features/_feature-template.md)
   to `features/<feature>.md`; for a repeatable how-to, copy
   [`recipes/_recipe-template.md`](recipes/_recipe-template.md) to `recipes/<recipe>.md`.
2. Fill the metadata block, then the sections top-to-bottom. Delete sections that
   genuinely don't apply (e.g. no worklet → drop the worklet-contract subsection).
3. Write scenarios in Gherkin and name the tests that pin them.
4. Keep it lean. If a section is empty, cut it rather than leaving a heading.

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
- Don't restate things that belong in code comments or `CLAUDE.md` verbatim; link
  to them. Specs are standalone enough to read on their own, but they should not
  duplicate the entire conventions list — point at it.

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

## Procedure by change type

**Spec-before-code**: a change that edits production code (`src/**`,
`public/worklets/**`) must create/update a spec in the *same* change — the SDD
hooks + CI enforce this (see "Enforcement & exemptions"). By kind of change:

**Feature / any behaviour change**
1. **Spec first** — create/update `specs/features/<name>.md` from `_template.md`
   (`status: draft`): background, requirements (`REQ-n`), contract, data shapes,
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
`public/worklets/`, plus `*.md`, `*.css` / `src/ui/styles/**`, and `src/vendor/**`.

**Explicit bypass** for a rare trivial *production* change: `touch .sdd-skip`
(a gitignored sentinel) locally, or put `[skip-sdd]` in a commit message / add the
`skip-sdd` PR label for CI.

> The guard checks that a spec *changed*, not that it is *good* — spec quality is
> the human review gate. Hooks can be disabled by editing `.claude/settings.json`,
> so CI is the real cross-tool backstop.

## Folder map

```
specs/
  README.md            ← you are here (the method)
  _template.md         ← copy this to start a new spec
  architecture.md      ← system-wide source of truth (read this first)
  features/            ← one spec per feature
    # — synth sound engine —
    oscillators.md     ·  osc1/osc2/sub + noise mixer (sound sources)
    ladder-filter.md   ·  the resonant ladder filter (canonical scalar example)
    envelopes.md       ·  amp + filter ADSR
    lfo.md             ·  LFO + mod wheel
    voicing.md         ·  poly/mono, unison, glide, drift, pitch bend
    # — effects —
    effects.md         ·  distortion/wah/phaser/delay/reverb insert chain
    compressor.md      ·  the FET/VCA worklet compressors (message contract)
    # — transport & sequencing —
    transport.md       ·  the look-ahead clock
    arpeggiator.md     ·  held-note arp + transport ownership
    sequencer.md       ·  the 16-step synth sequencer
    drum-machine.md    ·  8-track synth drums
    sampler.md         ·  8-slot one-shot sampler
    step-settings.md   ·  per-step vel/gate/prob/ratchet/tie + hit math
    banks.md           ·  A/B/C/D banks, edit-vs-play bank
    arrangement.md     ·  the three chain lanes
    performance.md     ·  live DJ FX (stutter/fill/drop/tape-stop)
    # — songs & persistence —
    song-mode.md       ·  the cross-cutting integration feature
    presets.md         ·  sound snapshots (param-only)
    # — audio I/O —
    audio-export.md    ·  WAV/MP3 capture of the master
    sample-recorder.md ·  mic record + buffer editor
    # — UI / UX —
    input-control.md   ·  keyboard, computer-key shortcuts, MIDI
    onboarding.md      ·  guided tour + help mode
  recipes/             ← repeatable how-tos / playbooks
    add-a-parameter.md       ·  the 3-edit pattern for any new scalar param
    add-an-effect.md         ·  a bypass-able insert effect on a bus
    add-an-audioworklet.md   ·  a new audio-thread DSP node + wrapper
    add-a-ui-component.md     ·  a hand-built DOM component
    add-a-demo-song.md        ·  a drop-in demo SongFile (data only)
    add-a-drum-voice.md       ·  a new synthesised drum track
    add-a-factory-preset.md   ·  a built-in sound preset
    add-a-tour-step.md        ·  a guided-tour / help step
    evolve-the-song-format.md ·  bump the SongFile version, stay back-compat
    write-a-test.md           ·  unit (Vitest) + E2E (Playwright) conventions
```

> Coverage note: the feature set above documents the current system. New features
> get their own spec (copy `_template.md`) as they're built — keep the folder lean,
> not exhaustive-for-its-own-sake. Smaller single-function extension points (a new
> `encode` format, a `buffer-dsp` op, an LFO destination) are noted inline in the
> relevant feature spec's "Open questions" rather than as separate recipes.

## Writing a new spec

1. Copy [`_template.md`](_template.md) to `features/<feature>.md` (or
   `recipes/<recipe>.md`).
2. Fill the metadata block, then the sections top-to-bottom. Delete sections that
   genuinely don't apply (e.g. no worklet → drop the worklet-contract subsection).
3. Write scenarios in Gherkin and name the tests that pin them.
4. Keep it lean. If a section is empty, cut it rather than leaving a heading.

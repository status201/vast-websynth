# CLAUDE.md

Guidance for working in this repo. This file is a **map**, not the reference —
the architecture lives in `specs/`, and every detail below is one link away.
`README.md` is the user-facing overview.

## Working here — SDD is enforced

`specs/` is the architectural source of truth. A change that edits production code
(`src/**`, `public/worklets/**`) must create/update a spec under `specs/` in the
**same** change. This is enforced, not advisory: `scripts/sdd-guard.mjs` runs as a
`PreToolUse` hook (blocks the `Edit`/`Write`), a `Stop` hook (blocks finishing the
turn) and a CI job. A blocked edit is the gate working — write the spec first.

- **New feature / behaviour change** → `/feature` (spec → review → implement →
  test → reconcile `status: implemented`).
- **Bug fix** → `/fix` (fix the governing spec, or add a regression scenario to it).
- **Spec only, no code** → `/spec`.
- **Refactor** → keep the spec's contract + scenarios green; edit the spec only if
  a public contract changed.

Exempt (no spec needed): anything outside `src/` + `public/worklets/`, plus
`*.md`, `*.css` / `src/ui/styles/**`, `src/vendor/**`, and `src/state/demos/**`
(demo songs are data drop-ins). For a genuinely trivial *production* tweak:
`touch .sdd-skip` locally, or `[skip-sdd]` in a commit / the `skip-sdd` PR label
in CI. `npm run spec:lint` checks spec *structure* and also runs as a `Stop` hook.

Full procedure: `specs/README.md` → "Procedure by change type".

## What this is

A Web Audio synthesizer (+ drum machine, sampler, motion sequencer) in **vanilla
TypeScript** — no framework, **zero runtime dependencies**, Vite + `tsc` only. The
three vendored libraries under `src/vendor/` (`lamejs`, `qr`, `jsqr`) are not npm
packages; see ADR-003. Product name in-app: **VAST G1-J8**; package/repo:
`websynth`. Same thing.

## Read first

| File | What it holds |
| --- | --- |
| `specs/architecture.md` | System-wide contracts: ParamBus/Engine, layer surfaces, the four event flows, audio graph, persistence keys, global conventions |
| `specs/README.md` | The SDD method + an annotated map of every spec |
| `specs/decisions/README.md` | The ADR index — *why* things are the way they are |

Feature specs are standalone and restate the conventions they rely on, so reading
one is usually enough.

## Commands

Scripts are in `package.json`. Only the non-obvious ones need saying:

- `npm run typecheck` is the primary gate (strict + `noUncheckedIndexedAccess`, so
  expect `arr[i]!` assertions throughout — match that style).
- **Anything that changes how the instrument *sounds* is verified by listening**,
  not by a green suite. `npm run bench:audio` renders through the real engine;
  ADR-010 ranks *musical* first and nothing automated covers it. Two traps (both
  learned the hard way — always A/B a bypassed baseline; mute the lanes you aren't
  testing) are in `specs/recipes/verify-audio-by-ear.md`.
- Tests: `specs/recipes/write-a-test.md` (Vitest in jsdom + Playwright, the mock
  `AudioContext`, the storage mock, why tests live outside `src/`). There is no
  linter.
- `npm run release` never touches git/GitHub — it bumps, builds, zips and *prints*
  the publish commands. Arguments, flags and the publish flow: `DEPLOYMENT.md`.
- `npm run clean:demos` / `check:demos` keep `src/state/demos-index.json` in sync;
  `check:demos` fails the build if it drifts.

## Invariants you'll trip over if you don't look them up

Four one-line pointers — the rules whose violation typecheck won't catch:

- **UI and audio never call each other.** A control writes `bus.set(...)`; the
  Engine `bus.subscribe(...)`s. → `specs/architecture.md` REQ-1, ADR-001.
- **Filter cutoff is a MIDI note number, not Hz** — keep modulation additive in
  semitone space. → ADR-005.
- **A new param must default to a no-op**, or it changes every existing preset.
  → ADR-006.
- **A sound change isn't verified until it has been heard.** → ADR-010.
- **Anything a payload can reach must be bounded, and no clock listener may
  throw its way out.** → `features/untrusted-input.md`, ADR-015.

## Where to look

Keyed by the code you're touching (`specs/README.md`'s folder map is the same
material keyed by feature name).

| Touching | Read |
| --- | --- |
| `src/state/params.ts` — a new param | `recipes/add-a-parameter.md`, ADR-001, ADR-006 |
| `src/state/patterns.ts` | `features/banks.md`, `features/step-settings.md`, ADR-004 |
| `src/state/song*.ts`, `src/state/serialize.ts` | `features/song-mode.md`, `recipes/evolve-the-song-format.md`, ADR-007/011/013 |
| `src/state/preset*.ts` | `features/presets.md`, `features/preset-authoring.md`, `recipes/add-a-factory-preset.md` |
| `src/state/demos/` | `recipes/add-a-demo-song.md` (data drop-in — SDD-exempt) |
| `src/audio/engine.ts` | `specs/architecture.md`, ADR-008, ADR-009 |
| context start / background / resume | `features/audio-lifecycle.md`, `features/ios-audio.md`, `features/media-session.md` |
| `src/audio/effects/` | `features/effects.md`, `recipes/add-an-effect.md`, ADR-012 |
| `src/audio/compressor/` | `features/compressor.md`, ADR-002 |
| `src/audio/transport/` | `features/transport.md`, `transport-position.md`, `arrangement.md`, `sequencer.md`, `drum-machine.md`, `sampler.md`, `motion-sequencer.md`, `performance.md`, `recipes/add-a-transport-module.md` |
| `src/audio/transport/sync/` | `features/midi-clock-sync.md`, `features/webrtc-sync.md` |
| `src/audio/recorder/` | `features/audio-export.md`, `record-window.md`, `sample-recorder.md`, `render-to-sampler.md` |
| `public/worklets/` | ADR-010, `recipes/add-an-audioworklet.md`, `features/ladder-filter.md`, `features/compressor.md` |
| `src/ui/` (any) | `src/ui/CLAUDE.md`, `recipes/add-a-ui-component.md`, `add-a-panel.md`, `add-a-modal-dialog.md`, `add-a-floating-window.md`, ADR-009 |
| any **new gesture** | ADR-014 + `recipes/design-an-interaction.md` — every interactive control owes a gesture inventory in its spec |
| any **new ingest surface** (a link, file, paste, peer or MCP arg) | `features/untrusted-input.md` + ADR-015 — bounds live in the validator, byte budgets in the codec, and `src/state/limits.ts` is the only place they're written down |
| anything **per-frame, per-tick or at boot** | `features/runtime-performance.md` (the app-wide cost contract), `features/performance-mode.md` |
| `tests/`, `e2e/` | `recipes/write-a-test.md`, `features/testids.md`, `e2e/CLAUDE.md` |
| `scripts/mcp/` | `features/mcp-server.md` |

## Directory-scoped guidance

These load automatically when you work in those directories:

- **`e2e/CLAUDE.md`** — Playwright conventions (dialog/download handling, the
  fake-media-device flags, environment-bound specs). The testid catalogue itself is
  `specs/features/testids.md`.
- **`src/ui/CLAUDE.md`** — CSS Module conventions and their gotchas.

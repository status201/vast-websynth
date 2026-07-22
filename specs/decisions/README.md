# Decisions — Architecture Decision Records

`decisions/` records the **why** behind cross-cutting architectural choices — and,
crucially, *which alternatives were rejected and the trade-off accepted* — so a
deliberate constraint isn't mistaken for an accident. Each ADR is one short,
immutable record structured **Context → Decision → Alternatives → Consequences**
(see [`../README.md`](../README.md) → "Decisions (ADRs)").

ADRs are **append-only**: to change a decision, write a *new* ADR that supersedes
the old one rather than rewriting it. An ADR's `status` is its own lifecycle —
`proposed | accepted | superseded by adr-XXX | deprecated` — not the
`draft | active | implemented` of a feature spec.

## Index

| ADR | Title | Status |
| --- | ----- | ------ |
| [000](adr-000-spec-driven-development.md) | Spec-Driven Development as the working method | accepted |
| [001](adr-001-parambus-over-redux.md) | `ParamBus` over a state framework (Redux/Zustand) | accepted |
| [002](adr-002-audioworklet-compressor.md) | A custom AudioWorklet compressor over the native node | accepted |
| [003](adr-003-no-runtime-dependencies.md) | Zero runtime dependencies (vanilla TS + the Web platform) | accepted |
| [004](adr-004-patternstore-separate-from-parambus.md) | `PatternStore` separate from `ParamBus` | accepted |
| [005](adr-005-cutoff-as-midi-note.md) | Filter cutoff as a MIDI note number, not Hz | accepted |
| [006](adr-006-no-op-param-defaults.md) | No-op defaults for new parameters | accepted |
| [007](adr-007-songfile-additive-versioning.md) | `SongFile` additive versioning | accepted |
| [008](adr-008-components-self-wire-params.md) | Components self-wire their params; Engine coordinates | accepted |
| [009](adr-009-ui-depends-on-studio-api-facade.md) | The UI depends on a `StudioApi` facade, not the concrete Engine | accepted |
| [010](adr-010-musical-stable-cheap-dsp.md) | DSP worklets favour *musical, stable, cheap* over physical accuracy | accepted |
| [011](adr-011-export-precision-and-default-sparse-serialization.md) | Export precision & default-sparse serialization | accepted |
| [012](adr-012-true-bypass-disconnects.md) | Bypassed effects disconnect their processed path (true bypass) | accepted |
| [013](adr-013-authoring-dialect-input-only.md) | The song authoring dialect is input-only (never persisted/exported) | accepted |
| [014](adr-014-dont-make-me-think.md) | Interaction design follows *"Don't Make Me Think"* (six ordered laws) | accepted |

New ADRs copy [`_adr-template.md`](_adr-template.md) to `adr-NNN-<slug>.md`, numbered
contiguously. Keep this index and the folder map in [`../README.md`](../README.md) in
sync when adding one.

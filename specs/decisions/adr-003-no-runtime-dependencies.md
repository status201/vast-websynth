# ADR-003 — Zero runtime dependencies (vanilla TS + the Web platform)

```yaml
id: adr-003-no-runtime-dependencies
status: accepted
date: 2026-05-15
deciders: core
related:
  - ../architecture
  - ../recipes/add-a-ui-component
```

> ADR `status` is its own decision lifecycle (`proposed | accepted | superseded
> by adr-XXX | deprecated`), distinct from a feature spec's lifecycle.

## Context / Forces

This is a long-lived hobby/portfolio synth that should still build and run years
from now with no maintenance churn. The Web platform already provides everything
the app is *about* — Web Audio for the graph, the DOM for the UI — so a framework
or audio library would mostly add surface area between us and the primitives we
want direct control over. Dependencies also bring a supply-chain attack surface
and a steady stream of upgrade work that a solo project can't absorb.

## Decision

We take **no npm runtime dependencies**: `package.json` has no `dependencies`
block; build tooling is Vite + `tsc` only. The UI is hand-built DOM
(`document.createElement`, components in `src/ui/components/`), and the audio is
raw Web Audio nodes + our own AudioWorklets. The few third-party runtime
components are **vendored** as source under `src/vendor/` (each with a
hand-written or shipped `.d.ts` + `LICENSE`) — pinned and in-tree, explicitly
*not* npm dependencies:

- **`lamejs`** (MIT) — MP3 encoder for audio export (`src/vendor/lamejs/`).
- **`qrcode-generator`** (MIT) — QR *encoder* for WiFi-sync pairing
  (`src/vendor/qr/`).
- **`jsQR`** (**Apache-2.0**) — QR *decoder* for the WiFi-sync scan fallback
  where the platform `BarcodeDetector` is absent (`src/vendor/jsqr/`).

Apache-2.0 is permissive and license-compatible with the MIT-vendored code; each
vendored library keeps its own `LICENSE` in-tree.

## Alternatives considered

- **React / Vue / Svelte** — rejected: a framework runtime + build coupling for an
  app whose DOM is small and hand-tuned; it would also obscure the direct
  node-by-node control the audio code relies on.
- **An audio library (Tone.js, etc.)** — rejected: heavy, and it hides the audio
  graph — but the audio graph *is* the product here; we want to author it
  directly.
- **`npm i lamejs`** — rejected in favour of vendoring the source, so the version
  is pinned, auditable, and immune to registry churn or a compromised release.

## Consequences

- **Good:** the app builds with just Vite + `tsc`, has a tiny supply-chain
  surface, a small bundle, and near-zero upgrade churn; we own every line that
  ships.
- **Trade-off:** more boilerplate — hand-built DOM components (see
  [`recipes/add-a-ui-component`](../recipes/add-a-ui-component.md)) instead of JSX,
  and vendored code (`lamejs`) is maintained in-tree rather than via `npm update`.

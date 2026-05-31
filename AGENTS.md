# AGENTS.md

This file contains project guidance for opencode. For detailed conventions,
architecture notes, and gotchas, **read `CLAUDE.md`** — it is the canonical
reference for this project.

## Quick reference

### Commands
```bash
npm run dev        # dev server (vite --host)
npm run typecheck  # tsc --noEmit — verify changes
npm run build      # tsc --noEmit && vite build
npm test           # vitest run — unit tests (jsdom)
```

### What this is
A Web Audio synthesizer in vanilla TypeScript. No framework, no runtime
dependencies. Build tooling is Vite + `tsc` only. `lamejs` is vendored under
`src/vendor/lamejs/`.

### Architecture (tl;dr)
- **`ParamBus`** (`state/params.ts`) — single source of truth for every scalar
  parameter. UI calls `bus.set(...)`; `Engine` subscribes.
- **`Engine`** (`audio/engine.ts`) — owns AudioContext, 8-voice pool, FX chain,
  transport modules. Note events: `bus.onNote` → `playNote` / `releaseNote`.
- **`PatternStore`** (`state/patterns.ts`) — non-scalar state (step grids),
  separate listener mechanism.
- **`Song`** (`state/song.ts`) — `capture`/`apply` full song state.

Audio graph: `voices → voiceBus → FX chain (distortion → wah → phaser → delay → reverb) → preMaster → analyser → master → destination`. Drum bus & sampler bus join at preMaster (bypass synth FX).

### Project layout
```
src/
  main.ts            boot: create Engine + ParamBus, mount UI
  audio/             AudioContext graph, voice, FX, drums, transport, recorder
  state/             ParamBus, PatternStore, preset, song
  ui/                hand-built DOM components + panels
  ui/styles/         CSS Modules (*.module.css)
public/worklets/     ladder-filter.js (audio thread, no TS imports)
```

### CSS Module conventions
All component/panel styling is in `src/ui/styles/*.module.css`. Global CSS is
only `src/styles/base.css` (reset), `theme.css` (custom properties), and
`layout.css` (`.app` grid). See `CLAUDE.md` for detailed gotchas.

### Branding
In-app: **"VAST G1-J5"**; package/repo name: `websynth`.

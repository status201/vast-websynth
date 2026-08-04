# AGENTS.md

Project guidance for opencode and other non-Claude agents. **Read `CLAUDE.md`
first** — it is the routing map for this repo, and everything below points at the
same places it does.

## What this is

A Web Audio synthesizer (+ drum machine, sampler, motion sequencer) in vanilla
TypeScript. No framework, **zero runtime dependencies**; Vite + `tsc` only. Three
libraries are *vendored* under `src/vendor/` (`lamejs`, `qr`, `jsqr`) — see
`specs/decisions/adr-003-no-runtime-dependencies.md`.

In-app the product is **VAST G1-J8**; the package/repo is `websynth`. Same thing.

## Spec-Driven Development is enforced

A change that edits production code (`src/**`, `public/worklets/**`) must
create/update a spec under `specs/` in the *same* change. `scripts/sdd-guard.mjs`
enforces this via Claude Code hooks **and** a CI job, so it applies to every agent
and to direct commits. Exempt: anything outside `src/` + `public/worklets/`, plus
`*.md`, `*.css`, `src/vendor/**` and `src/state/demos/**`. Bypass a genuinely
trivial production tweak with `touch .sdd-skip` (local) or `[skip-sdd]` in the
commit message (CI).

## Where everything is

| File | What it holds |
| --- | --- |
| `CLAUDE.md` | The map: commands, invariants, and a "code area → spec" routing table |
| `specs/architecture.md` | System-wide contracts, audio graph, event flows, conventions |
| `specs/README.md` | The SDD method + an annotated map of all 100 specs |
| `specs/decisions/README.md` | ADR index (the *why*) |
| `src/ui/CLAUDE.md` | CSS Module conventions |
| `e2e/CLAUDE.md` | Playwright conventions |
| `DEPLOYMENT.md` | Build, host and release |

Commands live in `package.json`; `npm run typecheck` is the primary gate.

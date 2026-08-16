# ADR-018 — Audio-graph memory is committed for the session, not reclaimed on bypass

```yaml
id: adr-018-audio-graph-memory-is-committed-not-reclaimed
status: accepted
date: 2026-08-16
deciders: core
related:
  - ../features/runtime-performance
  - ../features/effects
  - ../features/oscillators
  - adr-010-musical-stable-cheap-dsp
  - adr-012-true-bypass-disconnects
```

> ADR `status` is its own decision lifecycle and is **not** the feature-spec
> `draft | active | implemented`. A decision is `proposed`, then `accepted`; a
> later ADR can mark it `superseded by adr-XXX` or `deprecated`. Records are
> append-only — supersede, don't rewrite.

## Context / Forces

A memory investigation (2026-08-16, prompted by the tab sitting at 170–250 MB and a
demo pushing it higher) established that the allocations that move Chrome's tab
memory here are **native Blink objects, not JS**: 45 s of playback grew the renderer
by hundreds of MB while `JSHeapUsedSize` moved from 9.1 to 9.2 MB. A heap snapshot
sees none of it.

Two native costs were measured in isolation, and they pull in opposite directions
from [ADR-012](adr-012-true-bypass-disconnects.md)'s *cheap*:

- **`PeriodicWave`** — ~670 KB each, independent of the harmonic count (the table
  size follows the sample rate). Building the PWM duty bank eagerly cost ~86 MB.
  *This one was fixed* — entries are now built per width on first use
  ([oscillators](../features/oscillators.md) REQ-6b,
  [runtime-performance](../features/runtime-performance.md) REQ-2).
- **`ConvolverNode`** — ~5 MB at a 0.4 s IR, ~13.5 MB at 2.5 s, ~19 MB at 4 s.
  `Reverb`'s constructor assigns an IR unconditionally, so the three FX chains
  commit roughly **30 MB at boot** whether or not any reverb is ever switched on,
  and ADR-012's bypass disconnects the edges without releasing the kernel.

`convolver.buffer = null` **does** release it — 30.9 MB of 40.5 MB came back in a
direct test. So the ~30 MB is genuinely reclaimable, and the question is whether to
reclaim it. ADR-012 already rejected "null the convolver buffer" on *ergonomic*
grounds (N bespoke mechanisms instead of one wrapper-level one); this ADR re-examines
it on *memory* grounds, with numbers, and reaches the same answer for a better reason.

## Decision

**Native audio-graph memory is committed for the session. A bypassed effect gives
back its CPU, not its memory.**

Concretely: `BypassWrapper` disconnects (ADR-012) and nothing releases an inner
node's native state. `Reverb` keeps its `ConvolverNode`'s kernel from construction
until the page goes away.

The measurement that settles it is the **rebuild** cost, which lands synchronously on
the main thread when the reverb is switched back on: **7.7 ms at the 1.5 s default,
11 ms at 2.5 s, and up to 42 ms at 4 s.** This is a single-threaded audio app where a
main-thread stall shows up as an audible glitch
([runtime-performance](../features/runtime-performance.md), Background) — so the
trade is *~30 MB against a hitch on a user gesture, in a running song*. Memory is the
cheaper thing to spend. Releasing it was weighed and declined.

The rule generalises past reverb, and that is why it is an ADR rather than a note:
any future "free the native buffer while it is off" proposal — wave tables, decoded
`AudioBuffer`s, worklet state — is answered here first, and must show that
reacquisition is either off the main thread or off the audible path.

## Alternatives considered

- **Release the convolver kernel on bypass (`buffer = null`)** — rejected: buys
  ~10–13 MB per bypassed chain and pays 7.7–42 ms of main-thread FFT setup on
  re-enable. A player toggling reverb mid-song is exactly when a glitch is least
  acceptable, and it is a gesture made *while listening*.
- **Release only chains that are off when a song loads** — rejected: narrower and
  safer (the hitch lands during a load that is already busy), but it makes the cost
  of switching a reverb on depend on invisible history — the first toggle hitches,
  later ones do not. An instrument whose controls have inconsistent latency is worse
  than one that is uniformly slightly fatter ([ADR-014](adr-014-dont-make-me-think.md)).
- **Rebuild the kernel ahead of time on an idle callback** — rejected for now: it
  restores the memory it was meant to save the moment the callback runs, so it only
  helps a session that never touches reverb at all. Revisit only with evidence that
  such sessions are common *and* memory-constrained.
- **Shorten the IR bank so every kernel is cheaper** — rejected: that is a sound
  change ([ADR-010](adr-010-musical-stable-cheap-dsp.md)), not a memory fix. The
  weak tier already caps IR *duration* via `reverbIrMaxS`
  ([performance-mode](../features/performance-mode.md) REQ-11), which is the
  right lever and is already pulled where it matters.
- **Do nothing at all and record nothing** — rejected: the ~30 MB is real and
  re-findable, so without this record the next investigation re-derives it and
  re-proposes the same fix.

## Consequences

- **Good:** switching an effect on is always cheap and always the same cost; no
  bespoke per-effect teardown paths; ADR-012 keeps being the single bypass
  mechanism. The genuinely disproportionate native cost — the eager duty bank —
  was fixed instead, where laziness is bit-identical and costs nothing.
- **Trade-off:** the idle footprint carries ~30 MB of reverb kernels for chains that
  are usually off, and a session that never enables a reverb pays it in full. On a
  ~400 MB footprint that is under 10 %, and it does not grow.
- **Accepted non-finding:** the large growth seen when playback starts is *not* a
  leak and *not* song-specific. It plateaus within ~20 s and stays flat over three
  minutes while node creation climbs linearly (drum one-shots, correctly disposed
  per ADR-012's wrapper and `disposeAfter`). Attempts to attribute it by ablation
  failed: run-to-run spread on the renderer's working set reached 28–205 MB for
  *identical* work, and turning two different features off each "explained" more
  than half of a total they could not both own. **Working-set deltas during active
  audio are not a measurement instrument at this granularity** — isolated
  micro-benchmarks (one node type, one page) are, and are what produced every
  number in this ADR.

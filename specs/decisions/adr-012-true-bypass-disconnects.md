# ADR-012 — Bypassed effects disconnect their processed path (true bypass)

```yaml
id: adr-012-true-bypass-disconnects
status: accepted
date: 2026-07-02
deciders: core
related:
  - ../features/effects
  - ../features/compressor
  - adr-010-musical-stable-cheap-dsp
```

> ADR `status` is its own decision lifecycle (`proposed | accepted | superseded
> by adr-XXX | deprecated`), distinct from a feature spec's lifecycle.

## Context / Forces

`BypassWrapper` originally kept the processed path **permanently connected** and
realised bypass purely as a dry/wet crossfade (effects.md REQ-2 v2 said
"rather than a graph reconnect" explicitly). That is click-free, but the Web
Audio renderer keeps pulling any subgraph that is reachable from the
destination — so every bypassed effect still ran its full DSP. With all FX
"off" (the default), that was **3 ConvolverNodes** convolving 1.5 s stereo
impulse responses, **2 WaveShapers at 4× oversampling**, 3 phaser networks, a
wah, 3 delays and **2 compressor worklets**, all burning audio-thread CPU for
silence. On mobile (the Pixel-8a crackle investigation) this idle cost is a
large fraction of the whole render budget — a direct violation of ADR-010's
*cheap*.

## Decision

Bypass stays a crossfade for **audibility**, and additionally becomes a
**delayed graph disconnect** for **cost**:

- `setBypass(true)` ramps wet→0 as before, then after a delay much longer than
  the ramp (`DISCONNECT_DELAY_MS = 150` ≫ the ~10 ms `RAMP_MEDIUM` time
  constant) disconnects **only the wrapper's own two edges**:
  `input → processedIn` and `processedOut → wet`. The processed subgraph
  becomes unreachable from the destination and the renderer stops running it.
- `setBypass(false)` cancels any pending disconnect, **reconnects both edges
  first**, then runs the existing crossfade ramp.
- The wrapper never disconnects while wet > 0, and rapid toggles are safe via
  timer cancellation.
- Only the wrapper's own edges are touched: `Compressor.attachWorklet()`
  splices `processedIn → node → processedOut` *inside* the processed path, and
  those internal edges are never disconnected — attach works even while
  bypassed-and-disconnected.

**Tail semantics (decided):** bypassing already silences the tail immediately
(wet ramps to 0), so cutting a delay/reverb tail at disconnect time is
*audibly identical* to the previous behaviour. A paused convolver/delay holds
stale buffer content; on re-enable a ≤ tail-length remnant could theoretically
sound — accepted, because it is at wet-mix level, under a fresh ramp, after a
deliberate user toggle. If it ever bites, the fix is holding wet at zero for
one tail-length after reconnect.

## Alternatives considered

- **Keep the pure crossfade (status quo)** — rejected: pays the full DSP cost
  of every effect forever; the dominant idle audio-thread load on mobile.
- **Disconnect immediately on bypass** — rejected: clicks; the wet ramp needs
  ~70 ms to fall below audibility.
- **Per-effect enable/disable of inner nodes** (e.g. null the convolver
  buffer) — rejected: N bespoke mechanisms instead of one wrapper-level one,
  and some nodes (WaveShaper oversampling) have no "off" switch.
- **`suspend()`-style processing flags in worklets only** — insufficient:
  native nodes (Convolver, WaveShaper, Biquad) have no such flag; only a graph
  disconnect stops them.

## Consequences

- **Good:** with all FX off, the convolvers, oversampled shapers, phasers,
  delays and compressor worklets cost zero audio-thread CPU; toggling remains
  click-free; no per-effect code changes (all effects inherit via
  `BypassWrapper`).
- **Trade-off:** a bypassed delay/reverb no longer "keeps ringing" internally
  (it never audibly did — wet was 0); LFO-bearing effects (phaser/wah) resume
  at a different LFO phase after re-enable, which is musically irrelevant.
- effects.md REQ-2 is rewritten by this ADR (v3); the "no graph reconnect"
  wording of v2 is superseded.
```

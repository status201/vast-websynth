# ADR-019 — The bar is a tick count, not a time signature

```yaml
id: adr-019-the-bar-is-a-tick-count
status: accepted
date: 2026-08-17
deciders: core
related:
  - ../features/meter
  - ../features/transport
  - ../features/arrangement
  - ../features/sequencer
  - ../features/drum-machine
  - ../features/sampler
  - ../features/motion-sequencer
```

> ADR `status` is its own decision lifecycle and is **not** the feature-spec
> `draft | active | implemented`. A decision is `proposed`, then `accepted`; a
> later ADR can mark it `superseded by adr-XXX` or `deprecated`. Records are
> append-only — supersede, don't rewrite.

## Context / Forces

The instrument was locked to 4/4, but not by a decision: `SEQ_LENGTH = 16`
(`state/patterns.ts`) was a single constant doing **three unrelated jobs** — how
many cells a pattern holds, how long a bar is, and how many columns the UI draws.
Wherever a bar was needed, code wrote `step % SEQ_LENGTH`.

Four forces shaped the fix. **Musicality**: 3/4, 7/8 and a lane that fights the
bar are ordinary musical requests, and a groovebox player already knows the
length + rate model from Elektron, Roland and Polyend hardware. **Stability**:
the transport is a look-ahead scheduler that must survive `seek`, MIDI Song
Position, a WiFi peer and a dropout ([transport](../features/transport.md)
REQ-6/REQ-9) — anything that accumulates its own position drifts under all four.
**Cost**: the tick loop runs for every machine on every 16th, and
[runtime-performance](../features/runtime-performance.md) budgets it.
**Compatibility**: 19 shipped demos, a published JSON schema, a share-link format
and an MCP authoring dialect all encode 16-step banks
([ADR-007](adr-007-songfile-additive-versioning.md)).

## Decision

**Meter is a bar length measured in 16th-note ticks, and every machine's playback
window is `(length in cells × ticks per cell)` — both derived, never stored on
the pattern.** The pattern grid stays exactly 16 cells.

- The **clock is unchanged**: still a monotonic 16th pulse
  (`transport/clock.ts`). It has no concept of a bar and gains none.
- **`state/meter.ts`** names the three jobs apart: `GRID_CELLS` (cells per
  pattern), `barTicks(beats, unitIdx)` (bar length), and `LANE_RATES` (ticks per
  cell). `transport.beats` + `transport.beatUnit` on the `ParamBus` are the only
  stored meter state.
- **A lane's cell index is a pure function of `clock.step`** —
  `Performance.stepIndex(step, len, rate)` for the three trigger machines,
  the same arithmetic inline for motion. No accumulator, so `seek`, Song
  Position, WiFi sync and dropout recovery all keep working with no new state.
- **Rates finer than a 16th fan their sub-hits out inside one tick** with
  absolute `when` offsets — the technique `Arpeggiator` has used since
  [arpeggiator](../features/arpeggiator.md) REQ-6, not a new mechanism.
- Meter and lane settings ride in the SongFile's open `params` map with
  no-op defaults ([ADR-006](adr-006-no-op-param-defaults.md)), so `SONG_VERSION`,
  the schemas, the validators and every demo are untouched.

The consequence to state plainly: because the grid stays 16 cells, **5/4 (20
ticks) and 7/4 (28) are reachable at 1/8 resolution, not 1/16.** That is a
deliberate trade, not an oversight.

## Alternatives considered

- **A `{numerator, denominator}` time signature field** — rejected: a signature
  is a *notation*, and every consumer would immediately convert it back to a tick
  count anyway. It also cannot express the thing players actually want (a 12-tick
  lane under a 16-tick bar), so it would need a second, redundant mechanism
  beside it.
- **Growing the grid to 32 cells with pages** — rejected *for now*, not on
  principle. It is the only way to get 5/4 at 1/16 resolution, but it doubles
  every pattern array across 4 banks × (4 seq tracks + 8 drum + 8 sampler +
  motion), forces `minItems/maxItems` schema changes, a `SONG_VERSION` bump, an
  authoring-dialect change and a migration for all 19 demos — and it adds a
  paging mode to four grids. Deferred until this model has proven itself
  musically; it composes cleanly on top (`GRID_CELLS` is the only constant it
  changes).
- **Storing a `length` on each pattern/bank** — rejected: it makes the
  played window part of the *document*, so it must be validated, versioned,
  migrated and expressed in the authoring dialect. A `ParamBus` scalar with a
  no-op default buys the same behaviour with none of that
  ([ADR-004](adr-004-patternstore-separate-from-parambus.md) draws the line at
  structural data; a playback window is not structure).
- **Raising the clock to 48 or 96 PPQN so triplets are on-grid** — rejected: it
  is the "correct" answer and it touches everything. Every consumer of
  `clock.step` (recorder bounds, MIDI 24-PPQN mapping, the ruler, the
  arrangement, stutter) assumes step == 16th, and the arp already proves sub-tick
  fan-out is sample-accurate at zero structural cost.
- **A per-lane phase accumulator (`pos = (pos + 1) % len`)** — rejected: it is
  the obvious implementation and it is the unstable one. `Arrangement` uses that
  shape for chain slots and needed `seekTo` (REQ-7) to repair it after a jump; a
  pure function of `clock.step` needs no repair at all.
- **Leaving swing at the clock's 16th grid** — rejected: a lane at 1/8 fires
  only on even ticks, which the clock never delays, so a slower lane would
  silently play dead straight under swung hats. Swing is computed on the lane's
  own grid instead.

## Consequences

- **Good:** 3/4, 6/8, 7/8, 5/8, 9/8 and 12/8 at full 16th resolution; polymeter
  and true polyrhythm from the same two controls; no format bump, no schema
  change, no demo migration; the tick cost is a couple of integer ops per lane;
  the clock, the worklets and the audio graph are untouched.
- **Trade-off:** 5/4 and 7/4 cost a resolution halving (10 or 14 cells at 1/8).
  A bar longer than `GRID_CELLS × 4` ticks cannot be filled by any single lane at
  any rate. Meter is **global to the song** — it cannot change per bank or per
  chain slot. And because a lane index is derived from an unbounded `clock.step`,
  the transport's old 16-bit wrap had to go ([transport](../features/transport.md)
  REQ-10): it was only ever phase-safe for bar lengths dividing 65536, i.e. powers
  of two.

# Arpeggiator

```yaml
id: arpeggiator
status: implemented
version: 4  # v4: the pool is chord-expanded and key-quantized (REQ-8)
            # v3: 1/32 actually plays 1/32 (REQ-6); `arp.on` in a saved song is
            #     an *armed* control, by design, and is documented as one (REQ-7)
            # v2: the tab carries a status LED for `arp.on` (REQ-5)
owner: core
related:
  - architecture
  - transport
  - voicing
  - machine-status
  - scale-quantization
  - chord-tools
source:
  - src/audio/transport/arpeggiator.ts
  - src/audio/transport/scale-quantizer.ts   # REQ-8
  - src/state/params.ts
  - src/audio/engine.ts
  - src/ui/panels/arp-panel.ts
  - src/ui/machine-status.ts   # readArpStatus / subscribeArpStatus (REQ-5)
```

A held-note arpeggiator that owns note triggering while engaged and can auto-start
the transport.

## Background / Why

When the arp is on, raw key/MIDI presses shouldn't sound directly — the arp must
own the schedule and emit timed notes on each clock tick. So the engine suppresses
note passthrough (`passthroughSuppressed`) and the arp tracks held notes itself.
For playability, **holding a key with the arp engaged starts the transport**, and
releasing the last key stops it again (only if the arp was what started it).

## Requirements

- **REQ-1** — While enabled, key/MIDI presses are suppressed at the engine; the arp
  generates timed notes on `clock.onTick`.
- **REQ-2** — Held notes are tracked in **press order**; patterns reorder them.
- **REQ-3** — Holding a key auto-starts the transport; releasing the last key
  auto-stops it — but only if the arp started it (`startedTransport`).
- **REQ-4** — If the transport stops by other means (Play, panic, export), the arp
  resets its auto-start ownership.
- **REQ-5 (armed is visible from outside the tab, v2)** — The Arpeggiator tab
  carries a status LED lit by `arp.on`. Because REQ-1 means an engaged arp takes
  the keyboard away from direct playing and REQ-3 means a held key can start the
  transport, "is the arp armed?" is a live-performance question that must be
  answerable without opening the tab. The lamp is the tab-bar indicator owned by
  [machine-status](machine-status.md) REQ-10 — two states only (`on`/`off`), and
  the arp deliberately stays out of `MachineId`; that spec holds the detail.

- **REQ-6 (every rate plays its own rate, v3)** — The clock ticks in **16ths**, so
  a rate finer than 1/16 cannot be one-hit-per-tick. `1/32` used to fall into an
  `else` branch that fired once per tick with a comment conceding the
  approximation, which made it **audibly identical to 1/16** — the control was in
  the dropdown, changed nothing, and said nothing. A division below 1 now
  schedules `round(1 / division)` evenly-spaced hits from the single tick, each at
  `when + i * sixteenth * division`, with the gate measured against that shorter
  step. `when` is sample-accurate and the scheduler works ahead, so a sub-16th hit
  lands exactly as precisely as a tick-aligned one. The rule is general, not a
  1/32 special case: a finer rate added to `RATES` needs no new branch.

- **REQ-7 (`arp.on` in a song is armed, not broken, v3)** — A song may save
  `arp.on: 1` while carrying no arp notes of its own. The arp is driven by
  `bus.onNote` — the keyboard and MIDI — and the [sequencer](sequencer.md) does
  **not** route through it, so on autonomous playback an armed arp sounds nothing
  until someone holds a key. **This is the design, not a defect**: a saved song is
  a *stage setup for a player*, not only a description of what sounds by itself,
  and `arp.on` is an invitation to play over the running song (`Tosti` and the
  `1973` project demo both ship this way). The same reading covers an effect saved
  bypassed or at `mix: 0`, waiting for the XY pad or a motion lane
  ([effects](effects.md), [motion-sequencer](motion-sequencer.md)). Nothing here
  is to be "fixed" by making the sequencer feed the arp; what was missing was
  saying so, which is why this REQ exists and why the authoring guide states it.

- **REQ-8 (the pool is chord-expanded, then key-quantized, v4)** — `fire()` builds its
  pool from the held set. Two transforms now sit on that build: each held note is
  expanded through chord memory ([chord-tools](chord-tools.md) REQ-6), and every entry
  is quantized to the key **after** the `n + o * 12` octave stacking, so stacked octaves
  land in scale too ([scale-quantization](scale-quantization.md) REQ-4).

  Expansion has to happen **here as well as** in the engine's passthrough, not instead
  of it: REQ-1 means an engaged arp takes the note stream away from the engine entirely,
  so an expansion that only lived in the passthrough would leave the arp playing single
  notes. That duplication is the direct consequence of REQ-1 owning note triggering, and
  it is what lets one finger drive an arpeggiated progression.

  Release safety comes free from the existing shape: `lastTriggered` already stores the
  note that was played, so the quantized note is what gets released
  ([scale-quantization](scale-quantization.md) REQ-6). Both transforms are early returns
  at their defaults (`chromatic`, `chord.voicing: off`), so v4 is inaudible until a key
  is chosen.

## Technical design

### Contract / public interface

```yaml
Arpeggiator:  # src/audio/transport/arpeggiator.ts
  passthroughSuppressed: boolean      # engine reads this to gate note passthrough
  setEnabled(on) / setPattern(i) / setRate(i) / setOctaves(n) / setGate(g)
  # subscribes to bus.onNote (held set) and clock.onTick (schedule)
PATTERNS: ['up','down','up-down','random','as-played']
RATES:    ['1/4','1/8','1/16','1/32']  -> divisions [4,2,1,0.5] sixteenths/step
```

### Data shapes (registry)

```yaml
arp.on:      { discrete, labels: [off, on], default: 0 }
arp.pattern: { discrete, labels: ARP_PATTERN_LABELS, range: 0..4, default: 0 }
arp.rate:    { discrete, labels: ARP_RATE_LABELS, range: 0..3, default: 2 }   # 1/16
arp.octaves: { range: 1..4, default: 1 }
arp.gate:    { range: 0.05..1, default: 0.5 }
```

### Layer touchpoints

```yaml
engine (subscribeParams):
  arp.on -> arp.setEnabled(v >= 0.5); arp.pattern/rate/octaves/gate -> setters
note ownership: when enabled, engine routes nothing from bus.onNote to voices;
  the arp's own bus.onNote listener fills the held set
ui: src/ui/panels/arp-panel.ts
```

## Scenarios (BDD)

```gherkin
Scenario: Holding a key auto-starts the arp transport
  Given arp.on is 1 and the transport is stopped
  When the user holds a key
  Then the transport starts and the arp plays the held note(s)
# pinned by: tests/audio/transport/arpeggiator.test.ts, e2e/arp.spec.ts

Scenario: Releasing the last key stops the transport it started (edge)
  Given the arp auto-started the transport
  When the last held key is released
  Then the transport stops and ownership resets
# pinned by: tests/audio/transport/arpeggiator.test.ts, e2e/arp.spec.ts

Scenario: Play toggled manually is not auto-stopped (ownership)
  Given the transport was started by the Play button (not the arp)
  When the last arp key is released
  Then the transport keeps running
# pinned by: tests/audio/transport/arpeggiator.test.ts

Scenario: The tab LED shows whether the arp is armed (v2, REQ-5)
  Given the Arpeggiator tab is not the active tab
  When arp.on goes to 1
  Then tab-arp's LED lights, without the tab being opened
# pinned by: e2e/machine-status.spec.ts

Scenario: 1/32 plays twice per 16th (v3, REQ-6)
  Given arp.on is 1, arp.rate is 1/32 and one key is held
  When a single clock tick is dispatched
  Then two notes are scheduled, the second a half-sixteenth after the first
  And each note's gate is measured against the 1/32 step, not the 1/16
# pinned by: tests/audio/transport/arpeggiator.test.ts

Scenario: 1/32 is audibly different from 1/16 (v3, REQ-6, regression)
  Given the same held key and the same number of ticks
  When the rate is 1/32 rather than 1/16
  Then twice as many notes are scheduled
  # the bug: both rates fired once per tick, so the dropdown entry did nothing
# pinned by: tests/audio/transport/arpeggiator.test.ts

Scenario: An armed arp in a loaded song sounds nothing until a key is held (v3, REQ-7)
  Given a song saved with arp.on 1 and no key held
  When the transport runs
  Then the arp emits no notes
  And holding a key arpeggiates over the running song
# pinned by: tests/audio/transport/arpeggiator.test.ts

Scenario: Stacked octaves are quantized too (v4, REQ-8)
  Given an active key and arp.octaves is 2
  When a held note is arpeggiated
  Then the octave-stacked copies are in the key, not just the base note
# pinned by: tests/audio/transport/arpeggiator.test.ts

Scenario: One held key arpeggiates a whole chord (v4, REQ-8)
  Given chord.voicing is triad and one key is held
  When ticks are dispatched
  Then the arp cycles the chord's notes rather than repeating the single held note
# pinned by: tests/audio/transport/arpeggiator.test.ts
```

## Tests & verification

- `tests/audio/transport/arpeggiator.test.ts`, `e2e/arp.spec.ts`.
- `npm test` / `npm run e2e`.

## Open questions / future

- The arp and [sequencer](sequencer.md) both suppress passthrough; only one should
  own triggering at a time (engine arbitrates).

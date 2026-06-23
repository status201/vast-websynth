# Arpeggiator

```yaml
id: arpeggiator
status: implemented
version: 1
owner: core
related:
  - architecture
  - transport
  - voicing
source:
  - src/audio/transport/arpeggiator.ts
  - src/state/params.ts
  - src/audio/engine.ts
  - src/ui/panels/arp-panel.ts
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
```

## Tests & verification

- `tests/audio/transport/arpeggiator.test.ts`, `e2e/arp.spec.ts`.
- `npm test` / `npm run e2e`.

## Open questions / future

- The arp and [sequencer](sequencer.md) both suppress passthrough; only one should
  own triggering at a time (engine arbitrates).

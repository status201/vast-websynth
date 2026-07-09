# MIDI clock sync (Master/Slave transport sync)

```yaml
id: midi-clock-sync
status: implemented
version: 1
owner: core
related:
  - architecture
  - input-control
  - transport
  - performance
source:
  - src/state/sync-mode.ts
  - src/audio/transport/sync/sync-types.ts
  - src/audio/transport/sync/bpm-estimator.ts
  - src/audio/transport/sync/sync-master.ts
  - src/audio/transport/sync/sync-slave.ts
  - src/audio/transport/sync/sync-controller.ts
  - src/audio/midi-sync-transport.ts
  - src/audio/transport/clock.ts
  - src/audio/engine.ts
  - src/audio/midi.ts
  - src/ui/components/sync-section.ts
  - src/ui/panels/song-panel.ts
```

## Background / Why

Two instances of the synth (e.g. an Android tablet and a Windows laptop connected
over USB, the tablet in Android's built-in USB-MIDI peripheral mode) should play
in lock-step: one instance is the **Master** (its transport start/stop and tempo
drive the other), the other the **Slave**. The wire protocol is standard MIDI
System Real-Time — 0xFA Start, 0xFB Continue, 0xFC Stop, 0xF8 Timing Clock at
24 PPQN — the same protocol hardware synths have interoperated with for decades,
so the feature also syncs with/from hardware gear for free. The sync logic is
transport-agnostic (a `SyncTransport` interface); Web MIDI is the v1 transport,
and a future WebRTC DataChannel transport (WiFi sync) plugs in without touching
the timing code.

## Requirements

- **REQ-1** — Sync mode is `off | master | slave`, a **device-scoped** setting
  persisted at `localStorage['websynth.midisync']` (perf-mode precedent). It is
  deliberately **not** a `ParamBus` param, so it never enters presets or songs.
- **REQ-2** — Master broadcasts 0xFA on any clock start and 0xFC on any stop
  (whatever the source: Play button, arp auto-start, recorder, panic — it hooks
  `clock.onStart`/`onStop`), and 0xF8 pulses at 24 PPQN while playing.
  Pulses are timestamped from the look-ahead tick times on the **unswung** grid
  (MIDI clock is straight; a slave applies its own shuffle): the master acts on
  even 16th ticks only (never swung) and emits 12 pulses spanning two 16ths.
  No pulses are sent while stopped (v1).
- **REQ-3** — Slave: incoming 0xFA/0xFB (re)starts the local clock **from
  step 0** — a restart even if already playing, so bars realign; 0xFC stops it.
  Local transport controls (Play button, arp auto-start) remain live in every
  mode — a slave with no master attached is still a fully playable instrument.
- **REQ-4** — Slave tempo-follow: tempo is estimated from 0xF8 inter-pulse
  timing over a rolling window of 24 intervals (≈ one beat) smoothed with an
  EMA, and written via `clock.setBpm()` **directly, never `bus.set`**
  (the bus clamps 40..240 vs the clock's 20..400; bus writes would be captured
  into saved songs; and the `transport.bpm` subscription would loop). Writes
  are throttled (≥ 250 ms apart and ≥ 0.5 BPM change). While slaved, the
  engine's `transport.bpm → clock.setBpm` subscription is gated; on leaving
  slave mode the clock is restored to the knob's bus value. The estimator
  accepts pulses even while stopped, so hardware masters that send continuous
  clock warm it before the first start.
- **REQ-5** — Slave phase correction via `Clock.nudge(seconds)` (the only Clock
  API addition: shifts the future step grid, clamped ±0.05 s, no-op when
  stopped): the smoothed pulse-vs-local-grid error is applied as a nudge of at
  most ±10 ms, at most once per beat, with a 5 ms deadband — inaudible
  corrections that bound drift over long plays.
- **REQ-6** — Stall tolerance: if no pulse arrives for > 1 s while slaved and
  playing, the slave **keeps playing at the last tempo** (a USB hiccup must not
  kill a performance) and reports `stalled` in its status; 0xFC still stops it.
  The estimator resets across inter-pulse gaps > 250 ms so a stall never
  poisons the tempo estimate.
- **REQ-7** — Dependency inversion: the sync core (`SyncMaster`/`SyncSlave`/
  `SyncController`) depends only on the `SyncTransport` interface and injected
  time-domain converters; `MidiSyncTransport` is one implementation.
  `midi.ts` remains the **sole owner** of the shared `MIDIAccess`
  (`onmidimessage`/`onstatechange` are single-assignment properties) and feeds
  real-time bytes (≥ 0xF8) to the transport **before** the `& 0xf0` status
  mask; they never reach note/CC handling. Incoming sync messages are ignored
  unless mode is `slave`; broadcasting happens only while `master` (so
  cross-wired ports cannot loop).
- **REQ-8** — A "Sync" section in the Song panel (via `StudioApi.sync`): a
  three-way Off/Master/Slave segmented control plus a status line (port counts,
  followed BPM, stalled). Stable testids: `sync-mode-off/master/slave`,
  `sync-status`.
- **REQ-9** — Graceful degradation: no Web MIDI (or a denied permission) shows
  "MIDI unavailable" in the status; mode switching stays allowed but inert
  (`SyncController` works before/without `attachTransport`); zero errors.

## Technical design

### Contract / public interface

```yaml
# src/state/sync-mode.ts
SyncMode: "'off' | 'master' | 'slave'"
readSyncMode(): SyncMode          # default 'off'; bad stored values -> 'off'
writeSyncMode(m): void            # try/catch, non-fatal (perf-mode pattern)

# src/audio/transport/sync/sync-types.ts
SyncMessage: "{type:'start'} | {type:'continue'} | {type:'stop'} | {type:'pulse'}"
SyncTransport:
  send(msg, atMs?): void          # atMs in the performance.now() domain
  onMessage(cb(msg, receivedAtMs)): unsubscribe
  ports(): "{ ins: number; outs: number }"
  onPortsChange(cb): unsubscribe
SyncStatus:
  mode: SyncMode
  ports: "{ins, outs} | null"     # null = no transport attached
  playing: boolean
  followedBpm: "number | null"    # slave only
  stalled: boolean                # slave only

# src/audio/transport/sync/bpm-estimator.ts (pure)
PulseBpmEstimator:
  addPulse(atMs): void            # gap > gapResetMs clears the window first
  bpm: "number | null"            # null until window full; EMA-smoothed
  reset(): void

# src/audio/transport/sync/sync-master.ts
SyncMaster(clock, send, toPerfMs):
  enable(): void                  # hooks onStart/onStop/onTick; start now if playing
  disable(): void                 # unhooks; sends stop if playing

# src/audio/transport/sync/sync-slave.ts
SyncSlave(clock, { localBpm, toAudioTime }):
  enable() / disable(): void      # disable restores clock.setBpm(localBpm())
  handleMessage(msg, receivedAtMs): void
  followedBpm: "number | null"
  stalled: boolean
  onChange(cb): unsubscribe       # status repaint hook

# src/audio/transport/sync/sync-controller.ts
SyncController(clock, { toPerfMs, toAudioTime, localBpm, persist? }):
  mode: SyncMode
  setMode(m): void                # tear down old role, build new, persist, emit
  attachTransport(t): void        # late-called by initMIDI; re-applies mode
  status: SyncStatus
  onStatus(cb): unsubscribe

# src/audio/midi-sync-transport.ts
MidiSyncTransport(access) implements SyncTransport:
  handleRealtimeByte(byte, timeStampMs): void   # fed by midi.ts
  refreshPorts(): void                          # fed by midi.ts onstatechange
  # send: one status byte ([0xFA|0xFB|0xFC|0xF8]) to EVERY output, output.send([b], atMs)

# src/audio/transport/clock.ts (addition)
Clock.nudge(seconds): void        # nextStepTime += clamp(s, ±0.05); no-op stopped

# src/ui/components/sync-section.ts
buildSyncSection(sync: SyncController): HTMLElement
```

### Data shapes

Slave tuning constants (single `const` block in `sync-slave.ts` /
`bpm-estimator.ts`, field-adjustable):

```yaml
estimatorWindow: 25 timestamps    # 24 intervals ~= one beat at 24 PPQN
emaAlpha: 0.25
gapResetMs: 250                   # estimator window reset across gaps
bpmWriteThrottleMs: 250           # AND >= 0.5 BPM delta
nudgeMaxS: 0.010                  # per correction
nudgeMinIntervalBeats: 1
nudgeDeadbandS: 0.005
stallMs: 1000                     # checked inside a clock.onTick subscription
```

Time domains: MIDI timestamps (`MIDIOutput.send`, `MIDIMessageEvent.timeStamp`)
are `performance.now()`-domain; `Clock` schedules in AudioContext time. The
converters are injected into the core:
`toPerfMs = (t) => performance.now() + (t - ctx.currentTime) * 1000` and its
inverse — the core never touches `performance`/`ctx` directly (unit-testable).

### Layer touchpoints & ordering

- `Engine.init()` constructs `SyncController` immediately **before**
  `subscribeParams()` so the gated `transport.bpm` subscription
  (`if (this.sync.mode !== 'slave')`) can read it safely.
- `main.ts` is unchanged: `initMIDI(engine, bus)` still runs post-gesture
  (input-control REQ-6); it builds `MidiSyncTransport(access)` and calls
  `engine.sync.attachTransport(t)`. `onstatechange` also calls
  `t.refreshPorts()`.
- `midi.ts handleMessage`: `data[0]! >= 0xf8` branch **before** the `& 0xf0`
  mask (0xF8 & 0xF0 = 0xF0 would mis-dispatch) forwards to the transport and
  returns.
- The Song panel appends `buildSyncSection(engine.sync)` after its Audio
  section; the UI reaches the controller via `StudioApi.sync` (ADR-009).
- Master/Performance interplay: Tape Stop ramps the clock BPM — the master's
  pulse spacing follows naturally, so a slave follows the tape stop.

### Persistence

- `websynth.midisync` — the mode string, `try/catch` on read/write.
- Deliberately NOT persisted anywhere else: never in `ParamBus`, presets, or
  song files. The followed BPM is never written to `transport.bpm`.

## Scenarios (BDD)

```gherkin
Scenario: Master start emits Start then evenly spaced clock pulses
  Given sync mode is master and the transport starts at 120 BPM
  Then a 'start' message is sent, followed by 'pulse' messages
  And consecutive pulse timestamps are spaced 60000 / (120 * 24) ms apart
  And pulses are scheduled from even 16th ticks only (unswung grid)
# pinned by: tests/audio/transport/sync/sync-master.test.ts

Scenario: Slave converges on the master tempo
  Given sync mode is slave and steady pulses arrive at 140 BPM
  When two beats of pulses have arrived
  Then the local clock BPM is within 0.5 of 140
# pinned by: tests/audio/transport/sync/sync-slave.test.ts

Scenario: Jittered pulses do not make the tempo flap (edge)
  Given pulses at 120 BPM with up to ±3 ms of jitter
  Then the estimated BPM stays within 120 ± 1
  And BPM writes are throttled (>= 250 ms apart, >= 0.5 BPM delta)
# pinned by: tests/audio/transport/sync/bpm-estimator.test.ts, sync-slave.test.ts

Scenario: Start while already playing realigns to step 0
  Given a slave whose clock is already playing
  When a 'start' message arrives
  Then the clock restarts from step 0
# pinned by: tests/audio/transport/sync/sync-slave.test.ts

Scenario: Pulse stall keeps the music playing (failure)
  Given a slave playing at a followed tempo
  When no pulse arrives for more than 1 s
  Then the clock keeps playing at the last tempo and status reports stalled
  And a later 'stop' message still stops the clock
# pinned by: tests/audio/transport/sync/sync-slave.test.ts

Scenario: Mode gates everything (edge)
  Given sync mode is off (or master)
  When 'start'/'pulse' messages arrive
  Then the local clock is not started and no BPM is written
# pinned by: tests/audio/transport/sync/sync-controller.test.ts

Scenario: Leaving slave mode restores the local tempo
  Given a slave following 140 BPM while the BPM knob reads 120
  When the mode is switched to off
  Then the clock BPM is restored to the knob's 120
# pinned by: tests/audio/transport/sync/sync-controller.test.ts

Scenario: Sync UI is present and the mode persists (no MIDI ports in CI)
  Given the app booted in headless Chromium (no MIDI ports)
  Then the Song tab shows the Off/Master/Slave control and a status line
  When Slave is clicked and the page reloads
  Then Slave is still selected
# pinned by: e2e/sync.spec.ts
```

## Tests & verification

- Unit: `tests/state/sync-mode.test.ts`,
  `tests/audio/transport/sync/{bpm-estimator,sync-master,sync-slave,sync-controller}.test.ts`,
  `tests/audio/midi-sync-transport.test.ts` (fake `MIDIAccess` in
  `tests/audio/fake-midi-access.ts`), `tests/audio/transport/clock.test.ts`
  (nudge), `tests/ui/sync-section.test.ts` — `npm test`
- E2E: `e2e/sync.spec.ts` (UI presence + persistence only; headless Chromium
  has no MIDI ports) — `npm run e2e`
- Typecheck: `npm run typecheck`
- Manual: two `localhost:5173` tabs + a virtual MIDI loopback (e.g. loopMIDI);
  cross-device needs HTTPS (Web MIDI is secure-context-only; same constraint
  as mic capture).

## Open questions / future

- **WiFi transport (v2)**: a WebRTC DataChannel `SyncTransport` sending the
  same 4-variant messages as JSON; signaling (QR / copy-paste offer-answer) is
  the real work. The `SyncMessage` union can grow variants (e.g. song position)
  without breaking the interface.
- **Song Position Pointer (0xF2)**: enabling master mid-play sends 0xFA
  immediately — the slave joins at bar 0 while the master may be mid-arrangement.
- **Idle clock**: some hardware sends 0xF8 continuously while stopped; the
  master doesn't (v1) — a second idle timer's grid wouldn't match the real
  clock at start. The slave copes (starts at the local knob tempo, converges
  in ~1–2 beats) and benefits from continuous-clock hardware masters.
- **Slave + local Tape Stop**: incoming pulses re-assert the followed tempo
  within ~250 ms, effectively overriding Tape Stop's clock ramp while slaved
  (the pitch ramp still sounds). Option: gate the Performance clock ramp when
  slaved.
- **BPM knob while slaved** shows the local (restore) value, not the audible
  tempo; the status line disambiguates.

# MIDI clock sync (Master/Slave transport sync)

```yaml
id: midi-clock-sync
status: implemented
version: 2
owner: core
related:
  - architecture
  - input-control
  - transport
  - performance
  - arrangement
  - webrtc-sync
source:
  - src/state/sync-mode.ts
  - src/audio/transport/sync/sync-types.ts
  - src/audio/transport/sync/bpm-estimator.ts
  - src/audio/transport/sync/sync-master.ts
  - src/audio/transport/sync/sync-slave.ts
  - src/audio/transport/sync/sync-controller.ts
  - src/audio/midi-sync-transport.ts
  - src/audio/transport/clock.ts
  - src/audio/transport/arrangement.ts
  - src/audio/transport/performance.ts
  - src/audio/engine.ts
  - src/audio/midi.ts
  - src/ui/components/sync-section.ts
  - src/ui/components/knob.ts
  - src/ui/app.ts
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
  (`SyncController` works before/without any transport added); zero errors.

## v2 additions

v2 ticks off v1's open questions and adds the WiFi transport
(`webrtc-sync.md`). The requirements below **extend or supersede** the v1
clauses noted inline. The `SyncMessage` union grows two variants (`tempo`,
`songposition`); MIDI drops both to the wire only where a byte exists.

- **REQ-10 — Song Position Pointer (0xF2).** A slave joining mid-song jumps to
  the right bar instead of restarting at 0. `SyncMessage` grows
  `{type:'songposition', beat}` where `beat = clock.step & 0x3fff` (1 MIDI beat
  = 6 clocks = one 16th). MIDI both directions: `midi.ts` routes a leading
  `0xF2` (System Common, 3 bytes, before the `& 0xf0` mask) to
  `MidiSyncTransport.handleSongPosition(((d2)<<7)|d1, ts)`; `send` maps
  `songposition → [0xf2, beat & 0x7f, (beat>>7) & 0x7f]`. **Master:**
  `announceTo(send)` sends `tempo` while stopped, and `tempo` + `songposition` +
  `continue` while playing; `enable()` mid-play calls `announceTo(broadcast)`
  instead of v1's bare `start` (supersedes REQ-2's mid-play `start`).
  **Slave:** `songposition` stores `pendingBeat`; `start` sets `pendingBeat = 0`
  and starts at 0 (v1 behaviour); `continue` calls `clock.start(pendingBeat)`.
  `resetFollowState(startStep)` records `startStep`, and the phase-step mapping
  becomes `(startStep + pulse/6) & 0xffff` (v1 hardcoded pulse 0 ↔ step 0).
  **Clock:** `start(fromStep = 0)` seeds `_step = fromStep & 0xffff` before
  firing start listeners (see transport.md). **Arrangement** seeks to the bar
  implied by `clock.step` on start (see arrangement.md). **Regression: plain
  `start()` / `Clock.start(0)` behaves exactly as v1** (bar 0, pos 0).
- **REQ-11 — Idle clock.** While enabled and **stopped**, the master keeps
  sending timestamped `pulse`s so slaves' tempo estimates stay warm before the
  first Start (supersedes REQ-2's "no pulses while stopped"). `SyncMaster`'s
  ctor gains `opts?: { timer?: TickTimer; nowMs?: () => number }` (defaults
  `defaultTickTimer()` / `performance.now`, injectable for tests). The idle
  timer fires every **100 ms**; each wakeup schedules pulses covering
  `(lastScheduledMs, nowMs + 200]` at `sixteenthDuration()/6 × 1000` ms spacing,
  plus a **2 s** `tempo` heartbeat. It starts on `enable()`-while-stopped and on
  `onStop`, and stops on `onStart` and `disable()`. The idle grid is
  discontinuous with the played grid at Start — accepted (slave phase counting
  restarts on Start; only the estimator benefits). Idle `0xF8` also reaches MIDI
  hardware — standard behaviour.
- **REQ-12 — Explicit tempo message.** `SyncMessage` grows `{type:'tempo',
  bpm}`. The master emits it on `enable()`, on every `onStart`, on even ticks
  when `|bpm − lastSent| ≥ 0.1`, every 2 s while stopped (idle heartbeat), and
  in `announceTo`. `MidiSyncTransport.send` **early-returns for `'tempo'`** (no
  MIDI byte). The slave, on `'tempo'`, calls `clock.setBpm(bpm)` (skips if
  `|Δ| < 0.05`) and records `lastTempoMsgAtMs`; while a tempo message is fresh
  (`TEMPO_MSG_FRESH_MS = 2500`) the pulse estimator keeps running but its
  BPM-write path is suppressed — so an explicit-tempo (WiFi) master wins and a
  pulse-only (MIDI) master automatically falls back when tempo messages stop.
- **REQ-13 — Tape-stop gate.** While slaved, Tape Stop skips its clock-BPM ramp
  (the pitch-bend ramp still sounds). `Performance` gains a public settable
  predicate `clockRampAllowed: () => boolean` (default `() => true`); both the
  per-frame `clock.setBpm(...)` and the final restore `clock.setBpm(origBpm)`
  are wrapped in `if (this.clockRampAllowed())` (an ungated restore would stomp
  the followed tempo with the knob value). Engine wires
  `perf.clockRampAllowed = () => this.sync.mode !== 'slave'` right after sync
  construction (see performance.md).
- **REQ-14 — BPM-knob slaved indicator.** `Knob.setDisabled(on)` toggles a
  `disabled` style class + `aria-disabled` and early-returns in `onPointerDown`
  (blocks drag **and** double-tap reset). `app.ts` captures the BPM knob and
  subscribes `engine.sync.onStatus` → `setDisabled(mode === 'slave')` with a
  tooltip "Tempo follows the sync master while slaved".
- **REQ-15 — Multi-transport + links status.** MIDI and WiFi coexist:
  `SyncController.addTransport(id, t)` replaces `attachTransport` (a `Map` keyed
  by `TransportId = 'midi' | 'wifi'`; same id replaces + unsubscribes). Sends
  broadcast to every transport; incoming from any is gated as before. When a
  transport's `outs` goes 0 → >0 while master, the controller calls
  `master.announceTo` targeting **only that transport** (REQ-10). `SyncStatus`
  replaces `ports` with `links: Array<{id, ins, outs}>`. The status line reads
  `MIDI unavailable` / `No MIDI ports` / `N in · M out`, plus ` · WiFi: linked`
  / ` · WiFi: not linked`; slave suffixes (following/stalled) unchanged. See
  `webrtc-sync.md` for the WiFi transport itself.

## Technical design

### Contract / public interface

```yaml
# src/state/sync-mode.ts
SyncMode: "'off' | 'master' | 'slave'"
readSyncMode(): SyncMode          # default 'off'; bad stored values -> 'off'
writeSyncMode(m): void            # try/catch, non-fatal (perf-mode pattern)

# src/audio/transport/sync/sync-types.ts
TransportId: "'midi' | 'wifi'"
SyncMessage: "{type:'start'} | {type:'continue'} | {type:'stop'} | {type:'pulse'} | {type:'tempo', bpm} | {type:'songposition', beat}"
SyncTransport:
  send(msg, atMs?): void          # atMs in the performance.now() domain
  onMessage(cb(msg, receivedAtMs)): unsubscribe
  ports(): "{ ins: number; outs: number }"
  onPortsChange(cb): unsubscribe
SyncStatus:
  mode: SyncMode
  links: "Array<{ id: TransportId; ins: number; outs: number }>"   # v2: replaces `ports`; [] = no transport added
  playing: boolean
  followedBpm: "number | null"    # slave only
  stalled: boolean                # slave only

# src/audio/transport/sync/bpm-estimator.ts (pure)
PulseBpmEstimator:
  addPulse(atMs): void            # gap > gapResetMs clears the window first
  bpm: "number | null"            # null until window full; EMA-smoothed
  reset(): void

# src/audio/transport/sync/sync-master.ts
SyncMaster(clock, send, toPerfMs, opts?: { timer?, nowMs? }):
  enable(): void                  # hooks onStart/onStop/onTick; announceTo now if playing; idle clock if stopped
  disable(): void                 # unhooks; stops idle clock; sends stop if playing
  announceTo(send): void          # v2: targeted join — tempo (+songposition+continue while playing)

# src/audio/transport/sync/sync-slave.ts
SyncSlave(clock, { localBpm, toAudioTime }):
  enable() / disable(): void      # disable restores clock.setBpm(localBpm())
  handleMessage(msg, receivedAtMs): void   # v2: adds 'tempo' + 'songposition'; 'continue' -> start(pendingBeat)
  followedBpm: "number | null"
  stalled: boolean
  onChange(cb): unsubscribe       # status repaint hook

# src/audio/transport/sync/sync-controller.ts
SyncController(clock, { toPerfMs, toAudioTime, localBpm, persist? }):
  mode: SyncMode
  setMode(m): void                # tear down old role, build new, persist, emit
  addTransport(id, t): void       # v2: replaces attachTransport; Map keyed by TransportId (same id replaces)
  status: SyncStatus
  onStatus(cb): unsubscribe

# src/audio/midi-sync-transport.ts
MidiSyncTransport(access) implements SyncTransport:
  handleRealtimeByte(byte, timeStampMs): void   # fed by midi.ts (>= 0xF8)
  handleSongPosition(beat, timeStampMs): void   # v2: fed by midi.ts for 0xF2
  refreshPorts(): void                          # fed by midi.ts onstatechange
  # send: [0xFA|0xFB|0xFC|0xF8] to EVERY output; songposition -> [0xF2,lsb,msb]; 'tempo' early-returns (no byte)

# src/audio/transport/clock.ts (additions)
Clock.nudge(seconds): void        # nextStepTime += clamp(s, ±0.05); no-op stopped
Clock.start(fromStep = 0): void   # v2: seeds _step = fromStep & 0xffff before firing onStart

# src/ui/components/sync-section.ts
buildSyncSection(sync: SyncController, rtc: WebRtcSyncTransport): HTMLElement  # v2: WiFi link button + links status

# src/ui/components/knob.ts (addition)
Knob.setDisabled(on): void        # v2: dims + aria-disabled + blocks drag/double-tap (BPM knob while slaved)
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
tempoMsgFreshMs: 2500             # v2: while a 'tempo' msg is this fresh, suppress pulse-estimate writes
```

Master idle-clock + tempo constants (`sync-master.ts`, v2):

```yaml
idleWakeMs: 100                   # idle timer wakeup cadence while stopped
idleHorizonMs: 200                # schedule pulses covering (lastScheduled, now + 200]
tempoHeartbeatMs: 2000            # idle 'tempo' emission spacing
tempoSendMinDelta: 0.1            # emit 'tempo' on even ticks when |bpm - lastSent| >= this
```

Time domains: MIDI timestamps (`MIDIOutput.send`, `MIDIMessageEvent.timeStamp`)
are `performance.now()`-domain; `Clock` schedules in AudioContext time. The
converters are injected into the core:
`toPerfMs = (t) => performance.now() + (t - ctx.currentTime) * 1000` and its
inverse — the core never touches `performance`/`ctx` directly (unit-testable).

### Layer touchpoints & ordering

- `Engine.init()` constructs `SyncController` immediately **before**
  `subscribeParams()` so the gated `transport.bpm` subscription
  (`if (this.sync.mode !== 'slave')`) can read it safely. Immediately after, it
  constructs `this.rtcSync = new WebRtcSyncTransport()` and calls
  `this.sync.addTransport('wifi', this.rtcSync)` (v2; see webrtc-sync.md), and
  wires the tape-stop gate `this.perf.clockRampAllowed = () => this.sync.mode
  !== 'slave'`.
- `initMIDI(engine, bus)` runs post-gesture (input-control REQ-6); it builds
  `MidiSyncTransport(access)` and calls `engine.sync.addTransport('midi', sync)`
  (v2; was `attachTransport`). `onstatechange` also calls `sync.refreshPorts()`.
- `midi.ts handleMessage`: `data[0]! >= 0xf8` branch **before** the `& 0xf0`
  mask (0xF8 & 0xF0 = 0xF0 would mis-dispatch) forwards to the transport and
  returns. v2 adds an explicit `data[0] === 0xf2` route **after** the ≥0xF8
  branch and before the mask → `sync.handleSongPosition(((d2)<<7)|d1, ts)`.
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

v2 scenarios:

```gherkin
Scenario: Plain start() regression — bit-identical to v1
  Given a master and a slave
  When the master starts from step 0 (Clock.start(), no fromStep)
  Then the slave starts at step 0 and the Arrangement seeks to bar 0 / pos 0
# pinned by: tests/audio/transport/clock.test.ts, tests/audio/transport/arrangement.test.ts, tests/audio/transport/sync/sync-slave.test.ts

Scenario: Master announce mid-play sends tempo + song position + continue
  Given a master playing mid-arrangement at bar N
  When it becomes master (enable while playing) or a new transport link opens
  Then announceTo sends 'tempo', 'songposition' (beat = step & 0x3fff), then 'continue'
   And it does NOT send a bare 'start' (no restart to bar 0)
# pinned by: tests/audio/transport/sync/sync-master.test.ts, sync-controller.test.ts

Scenario: Slave continue starts at beat N and phase-locks
  Given a slave that received songposition beat N then continue
  Then clock.start(N * 6) seeds the step and the Arrangement seeks to bar N
   And offset pulses phase-lock against (startStep + pulse/6)
# pinned by: tests/audio/transport/sync/sync-slave.test.ts

Scenario: Idle pulses warm a stopped slave's estimator
  Given a master enabled while stopped
  Then it emits timestamped pulses on a 100 ms idle timer + a 2 s tempo heartbeat
   And a slave receiving them reports a followedBpm before any start
# pinned by: tests/audio/transport/sync/sync-master.test.ts, sync-slave.test.ts

Scenario: Tempo message beats pulse estimation, falls back when stale
  Given a slave receiving explicit 'tempo' messages
  Then clock BPM tracks the tempo message (pulse-estimate writes suppressed while fresh)
  When tempo messages stop for over TEMPO_MSG_FRESH_MS
  Then pulse-estimate BPM writes resume (MIDI-only fallback)
# pinned by: tests/audio/transport/sync/sync-slave.test.ts

Scenario: MIDI transport carries song position but drops tempo
  Given a MidiSyncTransport
  When send({type:'songposition', beat}) and send({type:'tempo', bpm}) are called
  Then songposition emits [0xF2, lsb, msb] to every output and tempo emits no byte
   And an incoming 0xF2 (via handleSongPosition) surfaces a 'songposition' message
# pinned by: tests/audio/midi-sync-transport.test.ts

Scenario: Tape stop while slaved ramps pitch only; release keeps the followed tempo
  Given a slaved instance following a master tempo
  When Tape Stop is engaged and released (clockRampAllowed() === false)
  Then the clock BPM is never ramped or restored by Performance
   And the pitch-bend ramp still runs
# pinned by: tests/audio/transport/performance.test.ts

Scenario: BPM knob refuses input while slaved
  Given the BPM knob
  When setDisabled(true) is applied (slave mode)
  Then a pointer-drag and a double-tap both leave the value unchanged
# pinned by: tests/ui/knob.test.ts

Scenario: WiFi link opens mid-play announces to the new link only
  Given a master playing with a MIDI slave locked
  When a second transport's outs go 0 → >0
  Then announceTo targets only the newly opened transport (MIDI slave hears nothing new)
# pinned by: tests/audio/transport/sync/sync-controller.test.ts

Scenario: Links status replaces ports (WiFi suffix)
  Given MIDI + WiFi transports added
  Then status.links lists both, and the status line appends "WiFi: linked/not linked"
# pinned by: tests/ui/sync-section.test.ts, e2e/sync.spec.ts
```

## Tests & verification

- Unit: `tests/state/sync-mode.test.ts`,
  `tests/audio/transport/sync/{bpm-estimator,sync-master,sync-slave,sync-controller}.test.ts`,
  `tests/audio/midi-sync-transport.test.ts` (fake `MIDIAccess` in
  `tests/audio/fake-midi-access.ts`), `tests/audio/transport/clock.test.ts`
  (nudge + `start(fromStep)`), `tests/audio/transport/arrangement.test.ts`
  (nonzero-start seek + start(0) regression),
  `tests/audio/transport/performance.test.ts` (tape-stop gate),
  `tests/ui/{sync-section,knob}.test.ts` — `npm test`. The v2 WiFi transport,
  offset estimator, signaling codec and pair modal are tested under
  `webrtc-sync.md`.
- E2E: `e2e/sync.spec.ts` (UI presence + persistence + WiFi status/link button;
  headless Chromium has no MIDI ports) — `npm run e2e`
- Typecheck: `npm run typecheck`
- Manual: two `localhost:5173` tabs + a virtual MIDI loopback (e.g. loopMIDI);
  cross-device needs HTTPS (Web MIDI is secure-context-only; same constraint
  as mic capture).

## Open questions / future

v2 resolved every v1 open question: **WiFi transport** shipped as
`webrtc-sync.md` (WebRTC DataChannel `SyncTransport`, coexisting with MIDI);
**Song Position Pointer** (REQ-10) so a mid-play join seeks to the right bar;
**idle clock** (REQ-11) so a stopped master keeps warming slaves;
**Tape-stop gate** (REQ-13) so a slaved Tape Stop ramps pitch only; and the
**BPM-knob slaved indicator** (REQ-14) so the disabled knob signals the tempo is
external. Remaining future ideas:

- **Note forwarding (v3)**: forward note-on/off over the wire so a slave voices
  the master's keyboard/pattern, not just its transport. The `SyncMessage` union
  can grow variants without breaking the transport interface.
- **Configurable STUN (WiFi)**: opt-in STUN to cross simple NATs while keeping
  the serverless promise (see `webrtc-sync.md`).
- **BPM knob while slaved** still holds the local (restore) value under the
  disabled dim; the status line's followed-BPM disambiguates.

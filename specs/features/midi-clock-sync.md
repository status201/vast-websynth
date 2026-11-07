# MIDI clock sync (Master/Slave transport sync)

```yaml
id: midi-clock-sync
status: implemented
version: 10
owner: core
related:
  - architecture
  - input-control
  - transport
  - transport-position
  - transport-loop
  - performance
  - arrangement
  - meter
  - webrtc-sync
  - ../decisions/adr-024-a-sync-join-is-timed-by-its-first-pulse
source:
  - src/state/sync-mode.ts
  - src/audio/transport/sync/sync-types.ts
  - src/audio/transport/sync/bpm-estimator.ts
  - src/audio/transport/sync/sync-roles.ts      # the lazy module behind both roles
  - src/audio/transport/sync/sync-master.ts
  - src/audio/transport/sync/sync-slave.ts
  - src/audio/transport/sync/sync-controller.ts
  - src/audio/transport/sync/midi-sync-transport.ts
  - src/audio/transport/clock.ts
  - src/audio/transport/arrangement.ts
  - src/audio/transport/performance.ts
  - src/audio/engine.ts
  - src/audio/midi.ts                 # sole owner of MIDIAccess; resolves it to main.ts
  - src/ui/components/sync-section.ts
  - src/ui/components/knob.ts
  - src/ui/shell/header.ts
  - src/ui/panels/song-panel.ts
```

Two instances (say a tablet in USB-MIDI peripheral mode and a laptop) play in
lock-step. The **Master**'s start/stop and tempo drive the **Slave**. The wire is
standard MIDI System Real-Time (0xFA Start, 0xFB Continue, 0xFC Stop, 0xF8 Clock at
24 PPQN, plus 0xF2 Song Position), so hardware syncs too. The core is
transport-agnostic: Web MIDI is one `SyncTransport`, and the WiFi one is
[webrtc-sync](webrtc-sync.md).

## Background / Why

The protocol is decades old and every piece of gear speaks it. The hard parts are
timing: the master's look-ahead runs ahead of what sounds, Web MIDI's scheduled
sends can be overtaken by later unscheduled ones, and delivery is bursty. A join
is therefore timed by its **first pulse**, never by when a message arrived
([ADR-024](../decisions/adr-024-a-sync-join-is-timed-by-its-first-pulse.md)). A
cable can also vanish mid-performance, so the persisted *selection* never holds the
instrument hostage: only a live link makes a role run.

## Requirements

### Selection, role and link

- **REQ-sync-mode-is-device-scoped** — Sync mode is `off | master | slave`, a
  **device-scoped** setting at `localStorage['websynth.midisync']`. It is not a
  `ParamBus` param, so it never enters presets or songs.
- **REQ-selected-mode-versus-active-role** — `SyncController.mode` is the persisted
  **selection**. `SyncController.activeMode` is the role **actually running**, never
  persisted:

  ```
  mode 'off'    -> 'off'
  mode 'master' -> some link has outs > 0                     ? 'master' : 'off'
  mode 'slave'  -> some link has ins > 0
                   AND (a message arrived < linkIdleMs ago
                        OR clock.playing)                     ? 'slave'  : 'off'
  ```

  The master/slave lifecycle and every "are we slaved?" consumer key off
  `activeMode`: the gated `transport.bpm → clock.setBpm` subscription, the BPM knob,
  Tape Stop's ramp, render-to-sampler's refusal and the empty-play hint. An armed
  selection is still painted as selected, but greyed.
- **REQ-link-liveness-beats-port-presence** — Ports alone are too weak a signal: a
  virtual cable keeps its port after the peer quits. So a slave needs an input
  port **and** a message within `linkIdleMs` (3000 ms, past the 100 ms idle pulses
  and 2 s heartbeat). A `TickTimer` watchdog polls every `watchdogWakeMs` (500 ms)
  while `mode === 'slave'`, and it re-evaluates on `clock.onStart`/`onStop`,
  `addTransport` and `onPortsChange`. `clock.playing` defers the silence-based
  release, so a USB hiccup never yanks the tempo; `ins === 0` releases at once.
  Incoming messages are gated on the **selection**, never on `activeMode`, because
  a message is what re-arms the role. The role is rebuilt *before* that message is
  handled. A master needs an output port, which also stops its idle clock
  broadcasting into the void.
- **REQ-the-sync-roles-load-with-the-mode** (v10) — `SyncMaster`/`SyncSlave` live in
  one lazy module, `sync-roles.ts` ([runtime-performance](runtime-performance.md)
  REQ-boot-cost-matches-the-request). The controller imports it whenever the
  selection is not `'off'` (at construction and on `setMode`). Until it lands,
  `desiredActiveRole()` resolves to `'off'` (armed but inert). A message meanwhile
  still refreshes liveness. A failed import is logged and retried on the next
  `setMode`, `addTransport` or port change (operation-scoped,
  [lazy-load-failure](lazy-load-failure.md)
  REQ-lazy-scope-is-surfaces-not-operations). `SyncControllerOptions.roles` injects
  it synchronously for tests. It is idle-warmed at boot (`main.ts` `warmDeferred`).
- **REQ-tempo-handoff-on-release** — An **automatic** release while `clock.playing`
  writes the followed tempo to `transport.bpm` once (`setLocalBpm`) *before*
  `SyncSlave.disable()`. So the restore lands on the same value, the tempo never
  jumps, and the knob tells the truth. An **explicit** `setMode` change snaps back to
  the knob's value.
- **REQ-the-sync-core-is-transport-agnostic** — `SyncMaster` / `SyncSlave` /
  `SyncController` depend only on `SyncTransport` and injected time converters.
  `midi.ts` is the **sole owner** of `MIDIAccess` (its handlers are
  single-assignment). It feeds real-time bytes (≥ 0xF8) to the transport **before**
  the `& 0xf0` mask, so they never reach note/CC handling. `initMIDI` resolves the
  handle (or `null`), so `main.ts` can bind the [debug panel](debug-panel.md)'s
  port row. Broadcasting happens only in `master`, so cross-wired ports cannot
  loop.
- **REQ-midi-and-wifi-coexist** — `SyncController.addTransport(id, t)` keeps a `Map`
  by `TransportId = 'midi' | 'wifi'` (same id replaces). Sends broadcast to every
  transport. When one transport's `outs` goes 0 → >0 while master, the controller
  announces to **that transport only**. `SyncStatus.links` is `{id, ins, outs}[]`.

### Master

- **REQ-master-broadcasts-start-and-stop** — It hooks `clock.onStart`/`onStop`,
  whatever the source (Play, arp auto-start, recorder, Panic). Every 16th tick emits
  **its own six pulses** from its unswung time `when − clock.swingOffset(step)`,
  because MIDI clock is straight and a slave applies its own shuffle. No parity
  rule: a seek by an odd step count neither drops nor doubles pulses, and a start
  from an odd cue clocks its first 16th.
- **REQ-the-master-keeps-an-idle-clock** — While enabled and **stopped**, the master
  sends timestamped `pulse`s so slaves' estimates are warm before the first Start.
  The idle timer (`idleWakeMs` 100) schedules pulses covering `(lastScheduledMs,
  nowMs + idleHorizonMs]` at `sixteenthDuration()/6` spacing, plus a `tempo`
  heartbeat every 2 s. It starts on `enable()`-while-stopped and on `onStop`, and
  stops on `onStart` and `disable()`. `SyncMaster`'s ctor takes `opts?: { timer?,
  nowMs?, flush? }`.
- **REQ-an-explicit-tempo-message** — `{type:'tempo', bpm}` is sent on `enable()`,
  every `onStart`, any tick where `|bpm − lastSent| ≥ 0.1`, the idle heartbeat and
  `announceTo`. MIDI has no byte for it, so `MidiSyncTransport.send` drops it.
- **REQ-master-flush-is-best-effort** — `MIDIOutput.send(data, atMs)` queues
  future-timestamped bytes, and an untimestamped byte sent later **overtakes** them.
  So a Start would arrive ahead of the queued idle tail, which interleaved stale
  pulses into the run and sent a MIDI slave a beat ahead. `SyncTransport.flush?()`
  cancels scheduled-but-unsent messages. `MidiSyncTransport` does `output.clear()`
  on each output in `try/catch`, since Chromium may not implement it. The master
  calls it **before** `start` and **before** `stop`, never around `announceTo`,
  which would cancel run pulses other locked slaves need. WebRTC sends immediately
  and omits it. Timestamping 0xFA past the queued tail was rejected: it delays the
  start by up to `idleHorizonMs`.
- **REQ-a-midi-master-announces-its-seek** — `SyncController` subscribes
  `clock.onSeek`. So every jump (a user seek or a [loop](transport-loop.md) wrap,
  [transport](transport.md) REQ-a-step-router-can-redirect-the-next-step) announces
  `songposition` + `continue` once, over every transport, while
  `activeMode === 'master'`. It never sends `start`, which would put slaves at bar 0.
- **REQ-a-local-start-joins-rather-than-restarts** — The start listener reads
  `clock.step`, seeded before `onStart` (transport REQ-start-seeds-the-step). Step
  `0` sends `start`. Any other step (a Pause → Play, a cue) sends `songposition`
  (`step & 0x3fff`) + `continue`. That is MIDI's own vocabulary: Continue resumes
  from the last Song Position. The flush and trailing `tempo` apply to both.
- **REQ-a-join-is-timed-by-its-first-pulse** (v8) — **Master:** `start`, and
  `songposition` + `continue` (from a start, seek, wrap or an announce to a new
  peer) are scheduled `JOIN_LEAD_MS` (1 ms) before the first pulse at the new
  position, `toPerfMs(clock.nextStepAt) − JOIN_LEAD_MS` (transport.md
  REQ-a-jump-can-be-scheduled). Web MIDI then delivers it after every pre-jump pulse
  and before the first post-jump one, which is what a hardware slave counts from.
  **Slave:** the new position's first step sounds at the first pulse at or after
  the join: at the message's own `at` + `JOIN_LEAD_MS` when the transport carries one
  ([webrtc-sync](webrtc-sync.md) REQ-a-join-carries-its-time), otherwise at the
  first pulse timed at or after the message. Until then the join is pending, and a
  `stop` cancels it. A remote `at` is clamped to `MAX_SYNC_JOIN_LEAD_MS`
  ([untrusted-input](untrusted-input.md)). A stopped slave starts with that
  first-step time (transport.md REQ-a-start-can-name-its-first-step-time). A master
  that sends no clock never starts a slave.

### Slave

- **REQ-slave-restarts-from-zero-on-start** — A `start` (re)starts the local clock
  **from step 0**, timed by REQ-a-join-is-timed-by-its-first-pulse, so bars realign.
  `stop` stops it. A slave already *following* this master jumps in place
  (REQ-a-following-slave-jumps-in-place). Local transport controls stay live in every
  mode: a slave with no master is still a playable instrument.
- **REQ-song-position-pointer-jumps-the-slave** — `songposition` (`beat = step &
  0x3fff`, 1 MIDI beat = one 16th) stores `pendingBeat`, and `continue` starts at
  it. `start` sets it to 0. `resetFollowState(startStep)` records `startStep`, and
  the phase mapping is `startStep + pulse/6`. `midi.ts` routes a leading `0xF2`
  (after the ≥ 0xF8 branch, before the mask) to `handleSongPosition(((d2)<<7)|d1,
  ts)`; `send` maps it to `[0xf2, beat & 0x7f, (beat>>7) & 0x7f]`. `Clock.start(0)`
  and a plain `start()` behave as bar 0, pos 0, and the
  [Arrangement](arrangement.md) seeks to the bar implied by `clock.step`.
- **REQ-a-following-slave-jumps-in-place** (v8) — Once a slave's clock was started by
  a join (and not stopped or restarted locally since), a further `start`/`continue`
  is `clock.seekAt(step, firstStepAt)` on its phase-locked grid. There is no
  restart and no settle. Pulse numbering follows the jump at its time: earlier pulses
  count in the old run, the first at or after it is pulse 0, recorded grid times at
  or after it are renumbered, and older ones are dropped (a looped bar reuses
  numbers). Over MIDI the join arrives as the jump is due, so `seekAt` catches up the
  look-ahead. A locally started slave (unknown phase) still restarts. The recorded
  grid holds **every** step at its unswung time, since a jump can put pulse 0 on an
  odd step.
- **REQ-slave-follows-tempo-from-pulses** — Tempo is estimated from 0xF8 intervals
  over a rolling 24-interval window with an EMA. It is written by `clock.setBpm()`
  **directly, never `bus.set`**: the bus clamps 40..240 against the clock's 20..400,
  would capture it into songs, and would loop. Writes are throttled (≥ 250 ms and ≥
  0.5 BPM). While slaved the `transport.bpm → clock.setBpm` subscription is gated.
  The estimator accepts pulses while stopped, so an idle or hardware clock warms it.
  While a `tempo` message is fresh (`TEMPO_MSG_FRESH_MS` 2500) the pulse estimate's
  writes are suppressed, so a WiFi master wins and a MIDI-only one falls back
  (REQ-an-explicit-tempo-message). A `tempo` within 0.05 BPM is skipped.
- **REQ-phase-correction-uses-nudge** — `Clock.nudge(seconds)` shifts the future grid
  (clamped ±0.05 s, a no-op when stopped, and a non-finite correction is ignored —
  a NaN grid time would stop the transport's drain until the next stop). The smoothed pulse-vs-grid error is
  applied as at most ±10 ms, at most once per beat, with a 5 ms deadband.
- **REQ-a-post-start-settle-window** — After a join *starts* a stopped slave, pulses
  are **ignored** for `startSettleBaseMs (300) + 12 pulse intervals` from the join's
  first step. That covers any in-flight scheduled span plus jitter. Only stall
  bookkeeping runs. The estimator is deliberately **not** interval-gated: Web MIDI
  delivery is bursty, and a "too close" heuristic biased tempo low (a 111 BPM master
  read as ~76). The window-span math is burst-immune, so contamination is excluded by
  *time*. After the settle the estimator's `gapResetMs` clears its window (the EMA
  survives), and the first pulse **anchors** the counter (REQ-sync-phase-re-anchor).
  From a cold pulse-only master, lock is delayed ~0.5–0.8 s; with the idle clock or a
  `tempo` message it costs nothing.
- **REQ-sync-phase-re-anchor** — The numbering is provably skewed when (a) the
  smoothed error exceeds `max(reanchorRatio (0.75) × pulse interval, reanchorMinS
  (0.015))`, or (b) `phaseMissReanchor` (2) consecutive pulses map to a step with no
  recorded tick. The look-ahead guarantees a tick precedes its pulse. The slave then
  recomputes the counter from the pulse's arrival against the nearest recorded step
  (`round((t − rec.when) / pulseS)` pulses from `(rec.step − startStep) × 6`), and
  clears `phaseErr` and the nudge budget. The first pulse after a settle always
  anchors. Counting stays primary; the re-anchor is the bounded self-heal, accurate to
  ± half a pulse.
- **REQ-a-stalled-pulse-stream-is-tolerated** — No pulse for > 1 s while playing: the
  slave **keeps playing at the last tempo** and reports `stalled`; `stop` still stops
  it. The estimator resets across gaps > 250 ms, so a stall never poisons the tempo.
- **REQ-a-slave-refuses-to-seek-locally** — While `activeMode === 'slave'`,
  `Engine.seekTo` returns `false` and `canSeek()` is `false`, so every surface
  disables itself. A local jump would invalidate the `tickTimes` mapping. As with
  Tape Stop, local transport *controls* stay live, but local *position* does not.

### Wire limits and the surfaces

- **REQ-midi-cannot-carry-a-meter** (v6) — MIDI real-time has no time-signature
  message, so `send` drops `meter` as it drops `tempo`. Song Position counts 16ths
  and stays correct, but peers in different meters number bars differently. WiFi
  carries it ([webrtc-sync](webrtc-sync.md) REQ-the-wire-carries-the-time-signature);
  over MIDI, set the same signature on both. `TICK_MEMORY` (16) is a look-ahead
  window, not a bar.
- **REQ-tape-stop-is-gated-while-slaved** — `perf.clockRampAllowed = () =>
  sync.activeMode !== 'slave'`, so a slaved Tape Stop bends pitch only and never
  writes or restores the clock BPM ([performance](performance.md)
  REQ-a-clock-ramp-gate-predicate). A selected-but-unlinked slave still ramps.
- **REQ-the-bpm-knob-shows-slaved** — `Knob.setDisabled(on)` adds a `disabled` class
  + `aria-disabled` and blocks drag **and** double-tap. `shell/header.ts` sets it
  from `engine.sync.onStatus` as `activeMode === 'slave'`, with the tooltip "Tempo
  follows the sync master while slaved".
- **REQ-a-sync-section-in-the-song-panel** — The Song panel's "Sync" section
  (`StudioApi.sync`) has an Off/Master/Slave segmented control and a status line.
  Testids: `sync-mode-off/master/slave`, `sync-status`. The status reads `MIDI
  unavailable` / `No MIDI ports` / `N in · M out`, plus ` · WiFi: linked|not
  linked`, plus the slave's following/stalled.
- **REQ-an-armed-sync-section** — A selected-but-inactive mode carries `armed` beside
  `active` (selected, not lit), and the status says why: `Slave armed — no link`,
  `Slave armed — no clock`, `Master armed — nothing connected`. The armed BPM knob is
  enabled and explains itself.
- **REQ-no-web-midi-degrades-gracefully** — No Web MIDI (or a denied permission)
  shows "MIDI unavailable". Mode switching stays allowed and inert, and nothing
  errors.

## Technical design

### Contract / public interface

```yaml
# src/state/sync-mode.ts
SyncMode: "'off' | 'master' | 'slave'"
readSyncMode(): SyncMode          # default 'off'; bad stored values -> 'off'
writeSyncMode(m): void            # try/catch, non-fatal

# src/audio/transport/sync/sync-types.ts
TransportId: "'midi' | 'wifi'"
SyncMessage: "{type:'start', at?} | {type:'continue', at?} | {type:'stop'} | {type:'pulse'} | {type:'tempo', bpm} | {type:'meter', beats, unit} | {type:'songposition', beat}"
JOIN_LEAD_MS: 1
SyncTransport:
  send(msg, atMs?): void          # atMs in the performance.now() domain
  onMessage(cb(msg, receivedAtMs)): unsubscribe
  ports(): "{ ins: number; outs: number }"
  onPortsChange(cb): unsubscribe
  flush?(): void                  # best-effort cancel of scheduled-but-unsent messages
SyncStatus:
  mode: SyncMode                  # the persisted selection
  activeMode: SyncMode            # the role actually running ('off' while armed)
  links: "Array<{ id: TransportId; ins: number; outs: number }>"   # [] = no transport added
  playing: boolean
  followedBpm: "number | null"    # slave only
  stalled: boolean                # slave only

# src/audio/transport/sync/bpm-estimator.ts (pure)
PulseBpmEstimator:
  addPulse(atMs): void            # gap > gapResetMs clears the window first
  bpm: "number | null"            # null until window full; EMA-smoothed
  reset(): void

# src/audio/transport/sync/sync-master.ts
SyncMaster(clock, send, toPerfMs, opts?: { timer?, nowMs?, flush? }):
  enable(): void                  # hooks onStart/onStop/onTick; announceTo now if playing; idle clock if stopped
  disable(): void                 # unhooks; stops idle clock; sends stop if playing
  announceTo(send): void          # targeted join — tempo (+songposition+continue while playing)

# src/audio/transport/sync/sync-slave.ts
SyncSlave(clock, { localBpm, toAudioTime }):
  enable() / disable(): void      # disable restores clock.setBpm(localBpm())
  handleMessage(msg, receivedAtMs): void
  followedBpm: "number | null"
  stalled: boolean
  onChange(cb): unsubscribe       # status repaint hook

# src/audio/transport/sync/sync-controller.ts
SyncController(clock, { toPerfMs, toAudioTime, localBpm, persist?,
                        setLocalBpm?, nowMs?, watchdogTimer?, roles? }):
  mode: SyncMode                  # the persisted selection
  activeMode: SyncMode            # the running role
  setMode(m): void                # persist, re-derive the role (explicit: no tempo adopt), emit
  addTransport(id, t): void       # Map keyed by TransportId (same id replaces)
  announcePosition(): void        # while master, fan announceTo over every transport;
                                  # subscribed to clock.onSeek (not called by Engine.seekTo)
  status: SyncStatus
  onStatus(cb): unsubscribe

# src/audio/transport/sync/midi-sync-transport.ts
MidiSyncTransport(access) implements SyncTransport:
  handleRealtimeByte(byte, timeStampMs): void   # fed by midi.ts (>= 0xF8)
  handleSongPosition(beat, timeStampMs): void   # fed by midi.ts for 0xF2
  refreshPorts(): void                          # fed by midi.ts onstatechange
  # send: [0xFA|0xFB|0xFC|0xF8] to EVERY output; songposition -> [0xF2,lsb,msb]; tempo/meter -> no byte

# src/audio/transport/clock.ts (the sync-facing surface)
Clock.nudge(seconds): void        # nextStepTime += clamp(s, ±0.05); no-op stopped
Clock.start(fromStep = 0, firstStepAt?): void   # seeds _step before onStart (clamped 0..MAX_STEP)
Clock.seekAt(step, at): void      # a jump on the unchanged grid at audio time `at`
Clock.nextStepAt: number          # grid time of the next emitted step — what a master's join is timed against
# Clock.seek/onSeek is a LOCAL gesture: a slave refuses it, a master announces it.
# Incoming songposition is applied through the join (start when stopped, seekAt when following).

# src/ui/components/sync-section.ts
buildSyncSection(sync: SyncController, rtc: WifiLink): HTMLElement  # + WiFi link button

# src/ui/components/knob.ts
Knob.setDisabled(on): void        # dims + aria-disabled + blocks drag/double-tap
```

### Data shapes

Slave tuning constants (`sync-slave.ts` / `bpm-estimator.ts`):

```yaml
estimatorWindow: 25 timestamps    # 24 intervals ~= one beat at 24 PPQN
emaAlpha: 0.25
gapResetMs: 250                   # estimator window reset across gaps
bpmWriteThrottleMs: 250           # AND >= 0.5 BPM delta
nudgeMaxS: 0.010                  # per correction
nudgeMinIntervalBeats: 1
nudgeDeadbandS: 0.005
stallMs: 1000                     # checked inside a clock.onTick subscription
tempoMsgFreshMs: 2500             # while a 'tempo' msg is this fresh, suppress pulse-estimate writes
startSettleBaseMs: 300            # + 12 pulse intervals — post-start pulse-ignore span
reanchorRatio: 0.75               # |phaseErr| beyond this × pulse interval -> re-anchor
reanchorMinS: 0.015               # re-anchor floor so jitter spikes can't trigger it
phaseMissReanchor: 2              # consecutive unmeasurable pulses -> re-anchor
phaseAlpha: 0.25                  # phase-error smoothing
tempoWriteMinDelta: 0.05          # ignore a 'tempo' within this of the last written BPM
tickMemory: 16                    # recorded grid times (steps) — a look-ahead window
```

Master idle-clock + tempo constants (`sync-master.ts`):

```yaml
idleWakeMs: 100                   # idle timer wakeup cadence while stopped
idleHorizonMs: 200                # schedule pulses covering (lastScheduled, now + 200]
tempoHeartbeatMs: 2000            # idle 'tempo' emission spacing
tempoSendMinDelta: 0.1            # emit 'tempo' on a tick when |bpm - lastSent| >= this
```

Link-liveness constants (`sync-controller.ts`):

```yaml
linkIdleMs: 3000                  # no sync message for this long -> the slave link is dead
watchdogWakeMs: 500               # TickTimer poll cadence while mode is 'slave'
```

Time domains: MIDI timestamps are `performance.now()`-domain, while `Clock`
schedules in AudioContext time. The converters are injected
(`toPerfMs = (t) => performance.now() + (t - ctx.currentTime) * 1000` and its
inverse), so the core never touches `performance`/`ctx` (unit-testable).

### Layer touchpoints & ordering

- `Engine.init()` constructs `SyncController` **before** `subscribeParams()`, so the
  gated `transport.bpm` subscription can read `activeMode`. It passes
  `setLocalBpm: (b) => this.bus.set('transport.bpm', b)`. Then it builds
  `this.rtcSync = new WifiSyncTransport()` (the lazy facade,
  [webrtc-sync](webrtc-sync.md) REQ-the-wifi-transport-loads-at-pairing), calls
  `addTransport('wifi', …)`, and wires `this.perf.clockRampAllowed`.
- `initMIDI(engine, bus)` runs post-gesture (input-control
  REQ-midi-access-follows-a-gesture). It builds `MidiSyncTransport(access)` and calls
  `engine.sync.addTransport('midi', sync)`. `onstatechange` calls
  `sync.refreshPorts()`.
- `midi.ts handleMessage`: the `data[0]! >= 0xf8` branch comes **before** the
  `& 0xf0` mask (0xF8 & 0xF0 = 0xF0 would mis-dispatch). `0xf2` is routed next.
- The Song panel appends `buildSyncSection(engine.sync, …)` via `StudioApi.sync`
  (ADR-009).
- Tape Stop ramps the clock BPM on a master; the pulse spacing follows, so a slave
  follows the tape stop.

### Persistence

- `websynth.midisync` — the mode string, `try/catch` on read/write.
- Nothing else: never in `ParamBus`, presets or songs. The followed BPM reaches
  `transport.bpm` only through REQ-tempo-handoff-on-release, never while following.

## Scenarios (BDD)

```gherkin
Scenario: Master start emits Start then evenly spaced clock pulses
  Given sync mode is master and the transport starts at 120 BPM
  Then a 'start' message is sent, followed by 'pulse' messages
  And consecutive pulse timestamps are spaced 60000 / (120 * 24) ms apart
  And each 16th tick schedules its own six pulses on the unswung grid
# pinned by: tests/audio/transport/sync/sync-master.test.ts

Scenario: A seek to the other parity neither drops nor doubles pulses (REQ-master-broadcasts-start-and-stop, regression)
  Given the master is playing, with swing on
  When the playhead is seeked by an odd number of steps, right after an even step or right after an odd one
  Then the pulse stream stays a straight 24 PPQN with exactly six pulses per 16th, no gap and no doubled pulse
  And a start from an odd cue clocks its first 16th
# pinned by: tests/audio/transport/sync/sync-master.test.ts

Scenario: Slave converges on the master tempo
  Given sync mode is slave and steady pulses arrive at 140 BPM
  When two beats of pulses have arrived after the post-start settle window (pulses while stopped need no settle)
  Then the local clock BPM is within 0.5 of 140
# pinned by: tests/audio/transport/sync/sync-slave.test.ts

Scenario: Jittered pulses do not make the tempo flap (edge)
  Given pulses at 120 BPM with up to ±3 ms of jitter
  Then the smoothed estimate stays within 120 ± 1; a single first-window write may reach ±1.5 (2·jitter over a one-beat span)
  And BPM writes are throttled (>= 250 ms apart, >= 0.5 BPM delta)
# pinned by: tests/audio/transport/sync/bpm-estimator.test.ts, sync-slave.test.ts

Scenario: Start while already playing realigns to step 0
  Given a slave whose clock is already playing, following this master
  When a 'start' message and its first pulse arrive
  Then the clock jumps to step 0 on that pulse, on its unchanged grid
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

Scenario: A plain start() starts at bar 0
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
# pinned by: tests/audio/transport/sync/midi-sync-transport.test.ts

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

Scenario: Stale in-flight pulses after Start do not skew tempo or phase (REQ-a-post-start-settle-window, regression)
  Given a slave warmed by idle pulses at 120 BPM
  When 'start' arrives followed by ~200 ms of stale idle-grid pulses interleaved with the real run pulses
  Then the settle window drops the whole contaminated span: no post-start BPM write strays from 120
  And the summed phase nudges stay within ±30 ms
  And the first pulse after the settle re-anchors the counter from arrival time
# pinned by: tests/audio/transport/sync/sync-slave.test.ts

Scenario: Estimator re-locks after a hard tempo jump (edge)
  Given an estimator locked at 60 BPM
  When the pulse spacing jumps instantly to 200 BPM (tape-stop release shape)
  Then the window slides through and the estimate re-locks near 200
# pinned by: tests/audio/transport/sync/bpm-estimator.test.ts

Scenario: Skewed pulse numbering self-heals by re-anchoring (edge)
  Given a playing slave whose measured phase error exceeds 0.75 pulse intervals (stale or lost pulses)
  Then the pulse counter is re-derived from arrival time against the recorded local grid
  And subsequent corrections are jitter-sized (no persistent early/late hold)
# pinned by: tests/audio/transport/sync/sync-slave.test.ts

Scenario: Master flushes scheduled sends around start/stop
  Given a master with an idle clock running
  When the local transport starts (or stops)
  Then flush is invoked before the 'start' (or 'stop') send, and never around announceTo
# pinned by: tests/audio/transport/sync/sync-master.test.ts

Scenario: MIDI transport flush clears every output, tolerating unsupported clear()
  Given a MidiSyncTransport with two outputs, one whose clear() throws
  When flush() is called
  Then the other output's clear() is still invoked and nothing propagates
# pinned by: tests/audio/transport/sync/midi-sync-transport.test.ts

Scenario: Slave with a link but no traffic is armed, not active (regression)
  Given sync mode is slave and a transport reports 1 input port
  When no sync message has arrived
  Then activeMode is 'off' and the BPM knob / transport.bpm subscription are live
# pinned by: tests/audio/transport/sync/sync-controller.test.ts

Scenario: An incoming message arms the role before it is handled
  Given a slave-selected controller whose activeMode is 'off'
  When a 'start' message arrives
  Then the role activates first and the same message still starts the clock
# pinned by: tests/audio/transport/sync/sync-controller.test.ts

Scenario: Losing the wire releases the role
  Given a slave following a master over a transport
  When the transport's input ports drop to 0 (cable pulled / DataChannel closed)
  Then activeMode returns to 'off' while mode stays 'slave'
  And the clock BPM is back under the knob's control
# pinned by: tests/audio/transport/sync/sync-controller.test.ts, e2e/sync.spec.ts

Scenario: Clock silence releases only once stopped (REQ-a-stalled-pulse-stream-is-tolerated)
  Given a slave whose master stopped sending (a lingering virtual MIDI port)
  When linkIdleMs passes while the clock is playing
  Then the role stays active and playback keeps its tempo
  When the clock stops and linkIdleMs passes
  Then the role releases
# pinned by: tests/audio/transport/sync/sync-controller.test.ts

Scenario: An automatic release while playing hands the tempo over without a jump
  Given a slave playing at a followed 140 BPM while the knob reads 120
  When the link is lost
  Then 140 is written once to transport.bpm and the clock keeps running at 140
  But an explicit setMode('off') still snaps back to the knob's 120 (REQ-slave-follows-tempo-from-pulses)
# pinned by: tests/audio/transport/sync/sync-controller.test.ts

Scenario: Master with no outputs is armed, and a link opening announces once
  Given sync mode is master and every transport reports 0 outputs
  Then activeMode is 'off' and nothing is broadcast (no idle clock)
  When a transport's outputs go 0 -> >0
  Then the role activates and the join is announced exactly once
# pinned by: tests/audio/transport/sync/sync-controller.test.ts

Scenario: An armed mode stays selected and says why
  Given sync mode is slave with no link
  Then the Slave segment is still marked active, plus an `armed` class
  And the status line reads "Slave armed — no link"
# pinned by: tests/ui/sync-section.test.ts, e2e/sync.spec.ts

Scenario: A master announces a local playhead seek (REQ-a-midi-master-announces-its-seek)
  Given sync mode is master and the transport is playing
  When the user moves the playhead
  Then songposition + continue are broadcast to every transport
  And `start` is NOT sent (it would realign slaves to bar 0)
# pinned by: tests/audio/transport/sync/sync-controller.test.ts

Scenario: A slave refuses a local playhead seek (REQ-a-slave-refuses-to-seek-locally)
  Given activeMode is 'slave'
  When Engine.seekTo is called
  Then it returns false, clock.step is unchanged, and canSeek() is false
  But the local Play button and arp auto-start still work (REQ-slave-restarts-from-zero-on-start)
# pinned by: tests/audio/engine-seek.test.ts

Scenario: A master resuming mid-song joins slaves there (REQ-a-local-start-joins-rather-than-restarts)
  Given sync mode is master and the clock starts from step 52 (a pause, or a cue)
  Then songposition (beat 52) and continue are sent — and start is NOT
  And a start from step 0 still sends start
# pinned by: tests/audio/transport/sync/sync-master.test.ts

Scenario: Every clock seek announces once — a loop wrap included (REQ-a-midi-master-announces-its-seek)
  Given sync mode is master
  When clock.onSeek fires, whether from Engine.seekTo or a loop wrap
  Then announcePosition runs once, and Engine.seekTo does not add a second call
# pinned by: tests/audio/transport/sync/sync-controller.test.ts, tests/audio/engine-seek.test.ts

Scenario: A slave stays in step through a master's loop wraps (REQ-a-following-slave-jumps-in-place, regression)
  Given a master and a slave linked over MIDI timing, both playing in step
  When the master loops one bar several times
  Then the slave plays the master's step at every sampled beat, within the link latency
   And over WiFi timing it does too
# pinned by: tests/audio/transport/sync/sync-loopback.test.ts

Scenario: A slave starts on a hardware master's first pulse (REQ-a-join-is-timed-by-its-first-pulse, regression)
  Given a master that sends Start and then clock pulses straight away
  Then the slave's step 0 sounds on the first pulse, and every later step on its pulse
# pinned by: tests/audio/transport/sync/sync-loopback.test.ts

Scenario: A master times its join just before the first pulse at the new position (REQ-a-join-is-timed-by-its-first-pulse)
  Given a playing master whose next step sounds at T
  When it announces a seek
  Then songposition and continue are scheduled at T − JOIN_LEAD_MS, after every pre-jump pulse
# pinned by: tests/audio/transport/sync/sync-master.test.ts

Scenario: A join waits for its first pulse, and a stop cancels it (REQ-a-join-is-timed-by-its-first-pulse, edge)
  Given a stopped slave that receives start with no time on it
  Then it does not start until a pulse at or after the start arrives, and then starts on it
   And a stop before that pulse leaves it stopped
   And a remote at more than MAX_SYNC_JOIN_LEAD_MS ahead is clamped to it
# pinned by: tests/audio/transport/sync/sync-slave.test.ts

Scenario: A locally started slave still restarts on a join (REQ-a-following-slave-jumps-in-place, edge)
  Given a slave whose clock the user started with Play, not a join
  When a start arrives
  Then it stops and restarts on the start's first pulse, rather than jumping a grid of unknown phase
# pinned by: tests/audio/transport/sync/sync-slave.test.ts

Scenario: A non-finite phase correction is ignored (REQ-phase-correction-uses-nudge, regression)
  Given a running clock
  When a correction of NaN arrives
  Then the future grid is unchanged and the transport keeps ticking
# pinned by: tests/audio/transport/clock.test.ts
```

## Tests & verification

- Unit: `tests/state/sync-mode.test.ts`,
  `tests/audio/transport/sync/{bpm-estimator,sync-master,sync-slave,sync-controller,midi-sync-transport}.test.ts`
  (fake `MIDIAccess` in `tests/audio/fake-midi-access.ts`),
  `tests/audio/transport/clock.test.ts`, `tests/audio/transport/arrangement.test.ts`,
  `tests/audio/transport/performance.test.ts`, `tests/ui/{sync-section,knob}.test.ts`
  — `npm test`. The WiFi transport is tested under [webrtc-sync](webrtc-sync.md).
- End to end: `tests/audio/transport/sync/sync-loopback.test.ts` — two real Clocks, a
  real master and slave, and a wire that delivers like Web MIDI or a DataChannel. It
  is the only test joining the two halves.
- E2E: `e2e/sync.spec.ts`. Headless Chromium has no MIDI ports, which makes it the
  proof of the armed state: selecting Slave must leave the BPM knob live.
- Manual: two `localhost:5173` tabs + a virtual MIDI loopback (e.g. loopMIDI).
  Cross-device needs HTTPS (Web MIDI is secure-context-only).

## Open questions / future

- **Note forwarding**: forward note-on/off so a slave voices the master's keyboard.
  The `SyncMessage` union can grow without breaking the interface.
- **Configurable STUN (WiFi)**, see [webrtc-sync](webrtc-sync.md).
- **The BPM knob while slaved** holds the local (restore) value under the dim; the
  status line's followed BPM disambiguates.
- **Per-port routing**: sends broadcast to every MIDI output, and liveness is a
  whole-transport question, so a slave cannot say *which* input it follows.

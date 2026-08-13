# MIDI clock sync (Master/Slave transport sync)

```yaml
id: midi-clock-sync
status: implemented
version: 5
owner: core
related:
  - architecture
  - input-control
  - transport
  - transport-position
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
  - src/audio/midi.ts                 # sole owner of MIDIAccess; resolves it to main.ts
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
  mask; they never reach note/CC handling. `initMIDI` **resolves** the handle
  (or `null` when unavailable/denied) so `main.ts` — not the audio layer, which
  must never import UI — can bind the [debug panel](debug-panel.md)'s port-count
  row. Incoming sync messages are ignored
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

- **REQ-10** — **Song Position Pointer (0xF2).** A slave joining mid-song jumps to
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
- **REQ-11** — **Idle clock.** While enabled and **stopped**, the master keeps
  sending timestamped `pulse`s so slaves' tempo estimates stay warm before the
  first Start (supersedes REQ-2's "no pulses while stopped"). `SyncMaster`'s
  ctor gains `opts?: { timer?: TickTimer; nowMs?: () => number }` (defaults
  `defaultTickTimer()` / `performance.now`, injectable for tests). The idle
  timer fires every **100 ms**; each wakeup schedules pulses covering
  `(lastScheduledMs, nowMs + 200]` at `sixteenthDuration()/6 × 1000` ms spacing,
  plus a **2 s** `tempo` heartbeat. It starts on `enable()`-while-stopped and on
  `onStop`, and stops on `onStart` and `disable()`. The idle grid is
  discontinuous with the played grid at Start; because idle pulses are queued
  as *future-timestamped* scheduled sends, the tail still in the OS queue at
  Start is a reordering hazard — see the v3 fix (REQ-16..18). Idle `0xF8` also
  reaches MIDI hardware — standard behaviour.
- **REQ-12** — **Explicit tempo message.** `SyncMessage` grows `{type:'tempo',
  bpm}`. The master emits it on `enable()`, on every `onStart`, on even ticks
  when `|bpm − lastSent| ≥ 0.1`, every 2 s while stopped (idle heartbeat), and
  in `announceTo`. `MidiSyncTransport.send` **early-returns for `'tempo'`** (no
  MIDI byte). The slave, on `'tempo'`, calls `clock.setBpm(bpm)` (skips if
  `|Δ| < 0.05`) and records `lastTempoMsgAtMs`; while a tempo message is fresh
  (`TEMPO_MSG_FRESH_MS = 2500`) the pulse estimator keeps running but its
  BPM-write path is suppressed — so an explicit-tempo (WiFi) master wins and a
  pulse-only (MIDI) master automatically falls back when tempo messages stop.
- **REQ-13** — **Tape-stop gate.** While slaved, Tape Stop skips its clock-BPM ramp
  (the pitch-bend ramp still sounds). `Performance` gains a public settable
  predicate `clockRampAllowed: () => boolean` (default `() => true`); both the
  per-frame `clock.setBpm(...)` and the final restore `clock.setBpm(origBpm)`
  are wrapped in `if (this.clockRampAllowed())` (an ungated restore would stomp
  the followed tempo with the knob value). Engine wires
  `perf.clockRampAllowed = () => this.sync.activeMode !== 'slave'` right after
  sync construction — `activeMode`, so a selected-but-unlinked slave still ramps
  (see performance.md).
- **REQ-14** — **BPM-knob slaved indicator.** `Knob.setDisabled(on)` toggles a
  `disabled` style class + `aria-disabled` and early-returns in `onPointerDown`
  (blocks drag **and** double-tap reset). `app.ts` captures the BPM knob and
  subscribes `engine.sync.onStatus` → `setDisabled(activeMode === 'slave')`
  (v4 — the *running* role, not the selection; REQ-19) with a tooltip
  "Tempo follows the sync master while slaved".
- **REQ-15** — **Multi-transport + links status.** MIDI and WiFi coexist:
  `SyncController.addTransport(id, t)` replaces `attachTransport` (a `Map` keyed
  by `TransportId = 'midi' | 'wifi'`; same id replaces + unsubscribes). Sends
  broadcast to every transport; incoming from any is gated as before. When a
  transport's `outs` goes 0 → >0 while master, the controller calls
  `master.announceTo` targeting **only that transport** (REQ-10). `SyncStatus`
  replaces `ports` with `links: Array<{id, ins, outs}>`. The status line reads
  `MIDI unavailable` / `No MIDI ports` / `N in · M out`, plus ` · WiFi: linked`
  / ` · WiFi: not linked`; slave suffixes (following/stalled) unchanged. See
  `webrtc-sync.md` for the WiFi transport itself.

## v3 fix — scheduled-send reordering at Start

A field bug (a MIDI slave settled ~a beat **ahead** of the master; the WiFi
path was fine) traced to **scheduled-send reordering**: `MIDIOutput.send(data,
atMs)` queues future-timestamped bytes inside the browser/OS, and an
untimestamped byte sent later *overtakes* them. At Start the master's 0xFA
(sent immediately) overtook up to `idleHorizonMs` of already-queued idle
pulses, so the slave received Start first, then the stale idle tail
**interleaved** with the real run pulses. Two failures compounded:

1. the interleaved double stream halves the apparent inter-pulse interval, so
   the estimator wrote ~2× tempo — and on a MIDI-only wire there is no `tempo`
   message (REQ-12) to suppress it — making the slave sprint ahead;
2. the stale pulses inflated the slave's run pulse counter, so the
   `(startStep + pulse/6)` phase mapping was skewed K pulses early and the
   phase corrector then *held* the slave ahead instead of pulling it back.

The WebRTC transport is immune: it transmits immediately, in send-call order,
with the timestamp in-band. v2's REQ-11 note ("discontinuous grid at Start —
accepted") wrongly assumed wire order matches send-call order. The same hazard
exists at Stop and at a mid-play `announceTo` (queued *run* pulses overtaken by
0xFC / 0xFB). Deliberately rejected: timestamping 0xFA past the queued tail —
that delays the slave's start by up to `idleHorizonMs`, a worse initial phase
error than the one being fixed.

- **REQ-16** — **Post-start settle window.** After a slave (re)start
  (`start`/`continue`), pulses are **ignored wholesale** for
  `startSettleBaseMs (300) + 12 pulse intervals` past the message's arrival —
  covering the possible in-flight scheduled span (`idleHorizonMs` after a
  Start; look-ahead + one 12-pulse batch after a continue-join) plus delivery
  jitter. Only stall bookkeeping still runs (a settling pulse proves the wire
  is alive). Stale reordered pulses therefore never reach the estimator or the
  pulse counter while playing. The estimator is deliberately **not**
  interval-gated: real Web MIDI delivery is bursty (pulses bunch on the event
  loop), so a "too close to the last pulse" heuristic mistakes burst-followers
  for duplicates and biases the tempo low (field-tested: a 111 BPM master read
  as ~76, flapping) — the rolling window-*span* math is inherently
  burst-immune, so contamination is excluded by *time* instead. After the
  settle, the estimator's own `gapResetMs` clears its window (the EMA — and
  with it the idle warm-up lock — survives), and the first pulse **anchors**
  the pulse counter from arrival time (REQ-17), since an unknown number of run
  pulses fell inside the settle. Cost: after a Start from a *cold, pulse-only*
  master (no idle clock, no `tempo` message), tempo lock is delayed by the
  settle (~0.5–0.8 s); with the idle clock (REQ-11) or a `tempo`-carrying
  transport (REQ-12) the tempo is already locked before the Start, so the
  settle costs nothing.
- **REQ-17** — **Phase re-anchor.** `SyncSlave.trackPhase` (extends REQ-5/REQ-10):
  the pulse numbering is provably skewed (stale, lost, or reordered pulses)
  when either signal fires — (a) the smoothed phase error exceeds
  `max(reanchorRatio (0.75) × pulse interval, reanchorMinS (0.015))` (a healthy
  corrector never sees errors beyond jitter), or (b) **2 consecutive**
  measurable pulses map to a step with no recorded tick time
  (`phaseMissReanchor`): the look-ahead guarantees a tick precedes its own
  pulse, so persistent misses mean the mapped step lies beyond the look-ahead —
  a skew too large to even measure. The slave then **re-anchors**: it
  recomputes the pulse counter from the pulse's arrival time against the
  nearest recorded local grid step (`round((t − rec.when) / pulseS)` pulses
  from `(rec.step − startStep) × 6`), clears `phaseErr` and the nudge budget,
  and resumes normal counting. The **first pulse after a settle window always
  anchors** (the settle hid an unknown number of run pulses, so counting from
  the Start is meaningless). Count-based mapping stays primary (exact,
  BPM-independent); the re-anchor is the bounded self-heal. Residual accuracy
  after a re-anchor is ± half a pulse interval — at Start the true error is
  milliseconds, so the anchor lands on the true grid.
- **REQ-18** — **Master flush (best-effort).** `SyncTransport` gains optional
  `flush?(): void` — cancel scheduled-but-unsent messages. `MidiSyncTransport`
  implements it as `output.clear()` on every output inside `try/catch`
  (Chromium may not implement `clear()`; a disconnected port may throw — both
  non-fatal). `SyncMaster` calls an injected `opts.flush` **before** sending
  `start` (kills the stale idle tail) and **before** sending `stop` (kills the
  queued run tail), never around `announceTo` (a global clear would cancel
  in-flight run pulses that other, already-locked slaves still need).
  `SyncController` fans the flush out to every transport. The WebRTC transport
  omits `flush` (nothing is queued — it sends immediately).

## v4 fix — a disconnected link must release the transport

Field report: set **Slave**, jam over MIDI or WiFi, then disconnect — and the
instrument stays hostage. `mode` is persisted (REQ-1) and was the *only* signal
anything consumed, so after the cable is pulled or the WebRTC channel tears down
the app still believes it is slaved: the BPM knob stays dimmed and undraggable
(REQ-14), the tempo is frozen at whatever the vanished master last dictated
(REQ-4's gate), Tape Stop still skips its ramp (REQ-13) and render-to-sampler
still refuses — and it all survives a reload. The only escape was clicking
**Off**, which throws away the setting the user wanted remembered.

The wire state was already observable and already emitted (`ports()` +
`onPortsChange` → `emitStatus`); nothing gated on it. v4 splits the one
overloaded concept in two, so the role is a *preference* that only takes effect
while there is a live link.

- **REQ-19** — **Selected mode vs. active role.** `SyncController.mode` stays the
  persisted **selection** (REQ-1 unchanged: `websynth.midisync`, restored at
  boot, painted as the selected segment). New derived
  `SyncController.activeMode: SyncMode` is the role **actually running** — never
  persisted:

  ```
  mode 'off'    -> 'off'
  mode 'master' -> some link has outs > 0                     ? 'master' : 'off'
  mode 'slave'  -> some link has ins > 0
                   AND (a message arrived < linkIdleMs ago
                        OR clock.playing)                     ? 'slave'  : 'off'
  ```

  The `SyncMaster`/`SyncSlave` lifecycle keys off `activeMode`, and so does
  every "are we slaved?" consumer: the gated `transport.bpm → clock.setBpm`
  subscription (REQ-4), the BPM knob (REQ-14), the tape-stop clock ramp
  (REQ-13), the seq panel's render-to-sampler refusal
  (`render-to-sampler.md`) and the empty-play hint (`empty-play-hint.md`).
  `SyncStatus` gains `activeMode`. **Selection painting is unchanged** — an
  armed-but-inactive mode is still the selected segment (so the setting visibly
  persists), just rendered greyed-out.
- **REQ-20** — **Link liveness.** Ports alone are too weak a signal: a virtual MIDI
  cable (loopMIDI) keeps its port after the peer app quits, so `ins > 0` would
  latch forever. A slave is therefore active only with an input port **and** a
  sync message within `linkIdleMs` (3000 ms — comfortably past the master's
  100 ms idle pulses and 2 s tempo heartbeat, REQ-11/12), polled by a
  `TickTimer` watchdog every `watchdogWakeMs` (500 ms) while `mode === 'slave'`
  and re-evaluated on `clock.onStart`/`onStop`, `addTransport` and every
  `onPortsChange`. **`clock.playing` defers the silence-based release**, so
  REQ-6's stall tolerance is untouched — a USB hiccup mid-performance never
  yanks the tempo; a provable wire loss (`ins === 0`) releases immediately in
  either state. Incoming messages stay gated on the **selection**
  (`mode === 'slave'`, REQ-7), never on `activeMode`: receiving one is what
  re-arms the role, so gating on the derived value would deadlock. Reactivation
  therefore stamps the timestamp and rebuilds the role *before* the triggering
  message is handled. A master needs an output port; gating it also stops its
  100 ms idle-clock timer from broadcasting into the void.
- **REQ-21** — **Tempo handoff.** An **automatic** release (link lost / clock
  silence) while `clock.playing` adopts the followed tempo into the knob — a
  one-shot injected `setLocalBpm(bpm)` (`bus.set('transport.bpm', …)`) issued
  *before* `SyncSlave.disable()`, so `disable()`'s existing
  `clock.setBpm(localBpm())` restore lands on the same value and the tempo never
  jumps mid-performance, while the knob becomes truthful (and a later song save
  correct). This narrows REQ-4's "the followed BPM is never written to
  `transport.bpm`" to **never while following**. An **explicit** `setMode`
  change is a deliberate exit and keeps the REQ-4 snap-back to the knob's value
  unchanged.
- **REQ-22** — **Armed UI.** The Song panel's Sync section marks a selected-but-
  inactive mode with an `armed` class alongside `active` (desaturated: selected,
  not lit) and spells out the reason in the status line — `Slave armed — no
  link` (no input port), `Slave armed — no clock` (port present, nothing
  arriving), `Master armed — nothing connected` (no output port). The armed BPM
  knob is enabled and carries an explanatory tooltip instead of the slaved one.

## v5 — a local playhead seek

[transport-position](transport-position.md) lets the user move the playhead. That
is a transport event, so sync has to have an opinion about it in both roles.

- **REQ-23** — **A master announces its seek.** After a local
  `Clock.seek` while `activeMode === 'master'`, `SyncController` fans
  `SyncMaster.announceTo` out over every transport, which sends `songposition` +
  `continue` (REQ-10's existing join primitive — no new message types). Without it
  a slave keeps counting pulses from *its* start and stays exactly the jump
  distance behind for the rest of the session. It deliberately does **not** send
  `start`: REQ-3 makes a slave restart at **bar 0** on `start`, which is the one
  thing a mid-song jump must not do.
- **REQ-24** — **A slave refuses to seek locally.** While `activeMode === 'slave'` the
  remote transport owns the playhead: `Engine.seekTo` returns `false` and
  `canSeek()` is `false`, so every UI surface disables itself rather than fighting
  REQ-5's phase correction — a local `_step` jump invalidates the slave's
  `tickTimes` mapping and drives it into a `reanchor()` for a beat or two. This
  mirrors REQ-13's `clockRampAllowed` gate on Tape Stop: local transport *controls*
  stay live (REQ-3), local transport *position* does not.

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
  flush?(): void                  # v3: best-effort cancel of scheduled-but-unsent messages
SyncStatus:
  mode: SyncMode                  # the persisted *selection*
  activeMode: SyncMode            # v4: the role actually running ('off' while armed but unconnected)
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
SyncMaster(clock, send, toPerfMs, opts?: { timer?, nowMs?, flush? }):   # v3: flush called before start/stop sends (REQ-18)
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
SyncController(clock, { toPerfMs, toAudioTime, localBpm, persist?,
                        setLocalBpm?, nowMs?, watchdogTimer? }):   # v4: last three
  mode: SyncMode                  # the persisted selection
  activeMode: SyncMode            # v4: the running role (REQ-19); 'off' while armed
  setMode(m): void                # persist, re-derive the role (explicit: no tempo adopt), emit
  addTransport(id, t): void       # v2: replaces attachTransport; Map keyed by TransportId (same id replaces)
  announcePosition(): void        # v5 (REQ-23): while master, fan master.announceTo out
                                  # over every transport (songposition + continue).
                                  # No-op in any other role. Called by Engine.seekTo.
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
# v5 note: Clock.seek/onSeek (transport.md REQ-6) is a *local* user gesture, not a
# sync primitive. A slave refuses it (REQ-24); a master announces it (REQ-23).
# It is NOT how incoming songposition is applied — that still goes through
# restart -> clock.start(pendingBeat), which must reset the follow state (REQ-10).
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
startSettleBaseMs: 300            # v3: + 12 pulse intervals — post-(re)start pulse-ignore span (REQ-16)
reanchorRatio: 0.75               # v3: |phaseErr| beyond this × pulse interval -> re-anchor (REQ-17)
reanchorMinS: 0.015               # v3: re-anchor floor so jitter spikes can't trigger it
phaseMissReanchor: 2              # v3: consecutive unmeasurable pulses -> re-anchor (REQ-17)
```

Master idle-clock + tempo constants (`sync-master.ts`, v2):

```yaml
idleWakeMs: 100                   # idle timer wakeup cadence while stopped
idleHorizonMs: 200                # schedule pulses covering (lastScheduled, now + 200]
tempoHeartbeatMs: 2000            # idle 'tempo' emission spacing
tempoSendMinDelta: 0.1            # emit 'tempo' on even ticks when |bpm - lastSent| >= this
```

Link-liveness constants (`sync-controller.ts`, v4 — REQ-20):

```yaml
linkIdleMs: 3000                  # no sync message for this long -> the slave link is dead
watchdogWakeMs: 500               # TickTimer poll cadence while mode is 'slave'
```

Time domains: MIDI timestamps (`MIDIOutput.send`, `MIDIMessageEvent.timeStamp`)
are `performance.now()`-domain; `Clock` schedules in AudioContext time. The
converters are injected into the core:
`toPerfMs = (t) => performance.now() + (t - ctx.currentTime) * 1000` and its
inverse — the core never touches `performance`/`ctx` directly (unit-testable).

### Layer touchpoints & ordering

- `Engine.init()` constructs `SyncController` immediately **before**
  `subscribeParams()` so the gated `transport.bpm` subscription
  (`if (this.sync.activeMode !== 'slave')` — v4) can read it safely. It passes
  `setLocalBpm: (b) => this.bus.set('transport.bpm', b)` (v4, REQ-21).
  Immediately after, it constructs `this.rtcSync = new WebRtcSyncTransport()`
  and calls `this.sync.addTransport('wifi', this.rtcSync)` (v2; see
  webrtc-sync.md), and wires the tape-stop gate
  `this.perf.clockRampAllowed = () => this.sync.activeMode !== 'slave'`.
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
  When two beats of pulses have arrived after the post-start settle window (REQ-16; pulses while stopped need no settle)
  Then the local clock BPM is within 0.5 of 140
# pinned by: tests/audio/transport/sync/sync-slave.test.ts

Scenario: Jittered pulses do not make the tempo flap (edge)
  Given pulses at 120 BPM with up to ±3 ms of jitter
  Then the smoothed estimate stays within 120 ± 1; a single first-window write may reach ±1.5 (2·jitter over a one-beat span)
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

v3 regression scenarios (scheduled-send reordering — the "MIDI slave runs a
beat ahead" bug):

```gherkin
Scenario: Stale in-flight pulses after Start do not skew tempo or phase (regression)
  Given a slave warmed by idle pulses at 120 BPM
  When 'start' arrives followed by ~200 ms of stale idle-grid pulses interleaved with the real run pulses
  Then the settle window drops the whole contaminated span: no post-start BPM write strays from 120 (pre-fix: ~2x writes)
  And the summed phase nudges stay within ±30 ms (pre-fix: dragged ahead ~10 ms every beat, indefinitely)
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
# pinned by: tests/audio/midi-sync-transport.test.ts
```

v4 regression scenarios (a disconnected link must release the transport):

```gherkin
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

Scenario: Losing the wire releases the role (the reported bug)
  Given a slave following a master over a transport
  When the transport's input ports drop to 0 (cable pulled / DataChannel closed)
  Then activeMode returns to 'off' while mode stays 'slave'
  And the clock BPM is back under the knob's control
# pinned by: tests/audio/transport/sync/sync-controller.test.ts, e2e/sync.spec.ts

Scenario: Clock silence releases only once stopped (REQ-6 stall tolerance held)
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
  But an explicit setMode('off') still snaps back to the knob's 120 (REQ-4)
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

Scenario: A master announces a local playhead seek (v5, REQ-23)
  Given sync mode is master and the transport is playing
  When the user moves the playhead
  Then songposition + continue are broadcast to every transport
  And `start` is NOT sent (it would realign slaves to bar 0)
# pinned by: tests/audio/transport/sync/sync-controller.test.ts

Scenario: A slave refuses a local playhead seek (v5, REQ-24)
  Given activeMode is 'slave'
  When Engine.seekTo is called
  Then it returns false, clock.step is unchanged, and canSeek() is false
  But the local Play button and arp auto-start still work (REQ-3 unchanged)
# pinned by: tests/audio/engine-seek.test.ts
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
  headless Chromium has no MIDI ports — which makes it the end-to-end proof of
  v4's armed state: selecting Slave there must leave the BPM knob live) —
  `npm run e2e`
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
  disabled dim; the status line's followed-BPM disambiguates. (v4 narrows this:
  the knob *adopts* the followed tempo when the link drops mid-play — REQ-21.)
- **Per-port routing**: sends still broadcast to every MIDI output and liveness
  is a whole-transport question (REQ-20), so a slave cannot yet say *which*
  input it is following. A port picker would sharpen both.

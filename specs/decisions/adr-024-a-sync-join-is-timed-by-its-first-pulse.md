# ADR-024 — A sync join is timed by its first pulse, and a following slave jumps in place

```yaml
id: adr-024-a-sync-join-is-timed-by-its-first-pulse
status: accepted
date: 2026-09-23
deciders: core
related:
  - ../features/midi-clock-sync   # REQ-a-join-is-timed-by-its-first-pulse, REQ-a-following-slave-jumps-in-place
  - ../features/webrtc-sync       # REQ-a-join-carries-its-time
  - ../features/transport         # REQ-a-start-can-name-its-first-step-time, REQ-a-jump-can-be-scheduled
  - ../features/transport-loop    # the loop wrap that exposed it
```

## Context / Forces

A slave took its timing from **when a `start` / `continue` arrived**: it put its
first step 50 ms after arrival and restarted its clock on every join. That was
right only for this app's own master, which happened to send Start 50 ms before
its first step. Two measured failures followed from it, both reproduced in a
loopback of two real `Clock`s, a real `SyncMaster` and a real `SyncSlave`:

- a master's **seek or loop wrap** announced the jump at once, a whole look-ahead
  (100–225 ms at 120 BPM) before the jump sounded, so the slave restarted early —
  and the phase re-anchor (REQ-sync-phase-re-anchor) took the offset for a
  miscounted pulse and kept it: after a few wraps the slave sat **a 16th ahead
  for good**;
- a **hardware master** sends Start and then clock straight away, so the slave
  began 50 ms late and locked in **two pulses** of it.

The forces were three. MIDI hardware counts from the first clock pulse after
Start/Continue, so a join sent early makes a hardware slave count pre-jump pulses
as the new position. Over Web MIDI a join can be *scheduled*, but a DataChannel
sends at once and its timing channel can overtake its control channel. And a slave
already following has a grid that is phase-locked to the master — restarting it
throws the lock away and pays a settle window on every wrap.

## Decision

**The new position sounds on the first pulse at or after the join, and a slave
already following moves there on its unchanged grid instead of restarting.**

- The master schedules every join `JOIN_LEAD_MS` (1 ms) before the first pulse at
  the new position, `toPerfMs(clock.nextStepAt)` — after every pre-jump pulse on a
  Web MIDI wire, which is also exactly what a hardware slave counts from.
- The WiFi wire carries that schedule on the message (`{t:'continue', at}`,
  webrtc-sync REQ-a-join-carries-its-time), converted into the receiver's domain,
  because a DataChannel cannot honour a send time. It is optional and additive.
- The slave uses the message's `at` when there is one, otherwise waits for the
  first pulse whose time is at or after the join. Stopped, it starts there
  (`Clock.start(fromStep, firstStepAt)`); already following, it jumps there
  (`Clock.seekAt(step, at)`) and renumbers its pulses at the jump's time.
- The clock gained both primitives as general transport features (transport.md
  REQ-a-start-can-name-its-first-step-time, REQ-a-jump-can-be-scheduled), not as
  sync special cases.

## Alternatives considered

- **Keep the arrival-based start and only timestamp the announce 50 ms early** —
  rejected: it fixes this app's own slave and breaks every hardware slave, which
  would count the 2–3 pre-jump pulses queued after the early Continue as the new
  position. MIDI's rule is the first pulse after the message; the lead has to be
  essentially zero.
- **Keep restarting on every join, just at the right time** — rejected: over MIDI
  the jump's first pulse arrives only as the jump is due, when the slave's
  look-ahead has already scheduled up to 100 ms of old steps, so a restart at that
  moment doubles up to a step of material on every wrap; and a restart discards the
  phase lock and re-runs the settle window each time. A jump on the locked grid
  keeps the lock and costs nothing.
- **Make the re-anchor smarter instead** — rejected: the re-anchor cannot tell a
  late start from a miscounted pulse — both look like a large phase error — and the
  right fix is not to create the late start. It stays as the bounded self-heal for
  genuinely lost or reordered pulses.
- **Borrow the clock's step router for the scheduled jump** — rejected: the loop
  driver owns that single slot even on a slave (it installs its router whenever a
  loop is engaged and merely refuses the jump), so a second owner would fight it.
  `seekAt` is its own held jump, applied after the router in the drain.
- **A separate "start at" message type on the WiFi wire** — rejected: an optional
  field on the existing `start`/`continue` is invisible to an older peer, keeps
  one vocabulary with MIDI, and needs no version handshake.

## Consequences

- **Good:** a slave stays in step through any number of loop wraps and seeks, over
  MIDI and WiFi, within the link latency; it starts on a hardware master's first
  pulse instead of two pulses late; and a following slave never restarts, so there
  is no settle window and no lost lock after a jump. Over WiFi a join also cancels
  the network latency.
- **Trade-off:** over MIDI a following slave still hears up to one look-ahead of
  old material at a jump, because MIDI gives no advance notice — the grid stays
  right and it continues in step, but those steps have already gone out.
- **Trade-off:** a slave never starts without clock. A join with no pulse behind
  it waits, and only a `stop` cancels it; every MIDI master sends clock with Start,
  and this app's master always does.
- **Trade-off:** mixed versions degrade. An older master over MIDI still sends an
  unscheduled Start that can overtake its idle tail, leaving a new slave a pulse or
  two off; an older WiFi peer sends no `at`, so the slave falls back to the first
  pulse, which is still correct but open to the cross-channel race.
- **Rule:** any new transport surface that can move the playhead must announce it
  through `SyncMaster.announceTo`, and any new slave-side join must go through the
  slave's join rather than `clock.start` — the loopback test
  (`tests/audio/transport/sync/sync-loopback.test.ts`) is what holds this.

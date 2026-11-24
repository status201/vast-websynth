# Motion lane mutes (one mute per lane; a lane can mute another)

```yaml
id: motion-lane-mute
status: implemented
version: 1
owner: core
related:
  - motion-sequencer      # the machine whose lanes these mute
  - motion-panel          # where the switches sit
  - presets               # why a lane mute is not part of a sound
  - runtime-performance   # the frame loop's cost contract
  - untrusted-input       # a refused target warns like an unknown one
  - xy-pad                # its assign pickers honour the fence
source:
  - src/state/motion-lanes.ts               # lane identity: mute ids + the target fence
  - src/audio/transport/motion-machine.ts   # setLaneMuted, ownership, the sweep
  - src/audio/engine-params.ts              # the bus -> machine binding
  - src/state/xy-effective.ts               # XY lane mute -> base axes
  - src/state/params.ts                     # the mute params
  - src/state/song-validate.ts              # a refused target warns on import
  - src/ui/components/xy-pad.ts             # the pad's pickers honour the fence
```

## Background / Why

`motion.mute` silences the whole [motion sequencer](motion-sequencer.md). With five
lanes (the XY lane and A–D) the useful grain is finer: drop one lane out of a song
while the others keep moving, as every other machine's track mute already allows.
Because a lane mute is an ordinary `ParamBus` param, a motion lane can drive another
lane's mute, so one lane can switch another on and off as the bar plays.

## Requirements

The machine has five **lanes**: lane 0 is the XY lane and lane `1 + t` is track `t`.
`MOTION_LANE_COUNT` (= `1 + MOTION_TRACK_COUNT`) and the lane ↔ id mapping live once,
in `src/state/motion-lanes.ts`. The params, the engine binding, the panel and the XY
resolver all derive from it (ADR-022's rule, one level in).

- **REQ-each-motion-lane-has-its-own-mute** — `motion.xy.mute` (the XY lane) and
  `motion.t<i>.mute` (each track) default to 0, so no existing song changes (ADR-006).
  They are independent of `motion.mute`, which still silences the whole machine. A
  muted lane:
  - **writes nothing**, and is skipped by the frame loop — a muted XY lane skips
    its axes and carry too. That costs one boolean read per lane per frame;
  - **returns its sound params to their baselines**, as Stop and `motion.mute` do, at
    the end of the **first whole frame it sits out** (≤ one frame, 1/fps). Every
    baselined param has an **owner**: the lane that last *wrote* it, parks
    included, so each write hands it over. After the lanes have written, a sweep
    releases every param still owned by a lane that was already muted when the
    frame began. Going by writes rather than assignments is the point: a param an
    unmuted lane still writes has changed owner and never blips to its baseline; an
    assigned lane with no anchors protects nothing; two muted lanes sharing a param
    both let it go; and a handover, a rest or a seek needs no special case. A frame
    with no cell to evaluate (just after a start or a seek) sweeps nothing. The
    lane mutes it set are not sounds and are held
    (REQ-a-lane-can-mute-another-lane);
  - **neither parks nor counts as driving** at a handover
    ([motion-sequencer](motion-sequencer.md) REQ-a-bank-parks-at-its-last-anchor):
    the outgoing bank does not park a muted lane's param, and a muted incoming lane
    does not shield one;
  - **resumes on the next frame** when unmuted, re-baselining like any first write.

  While the XY lane is muted the XY Pad shows its base axes
  ([motion-sequencer](motion-sequencer.md) REQ-motion-drives-the-xy-assignment). Lane
  mutes are song state, not sound: the `motion.` prefix already keeps them out of
  presets ([presets](presets.md)
  REQ-a-preset-is-only-a-sound).
- **REQ-a-lane-can-mute-another-lane** — A lane mute is an ordinary discrete param,
  so another lane can target it. A step-mode lane on `motion.t1.mute` switches lane
  B on and off per anchor. Its write reaches `setLaneMuted` synchronously through the
  bus, inside the frame, and `setLaneMuted` only marks: nothing is released
  mid-frame. Lanes run in lane order (XY, A–D), so the outcome is deterministic: a
  lane muted mid-frame keeps what it already wrote until the next sweep, and one
  that has not run yet skips the frame.

  When a lane mutes, the **lane mutes it set are held**, not released
  (`isMotionLaneMuteId`). Releasing a switch would mute or unmute a lane from the
  sweep, whose own release could flip another back, and two lanes driving each
  other's mutes would flap at frame rate. Held, a mute only ever changes by a write
  of an unmuted lane, so the sweep releases sounds only, in one pass. Muting a lane
  that switches another therefore leaves that one where it was. A mute param is
  baselined like any target, so **Stop** returns every switch to what the user set.
- **REQ-a-lane-cannot-target-the-machine-or-itself** —
  `motionTargetAllowed(lane, id)` is false for `motion.on`, `motion.mute` and the
  lane's **own** mute. A lane writing the machine switches deactivates the machine,
  whose restore puts the switch back and reactivates it: an oscillation at frame
  rate. A lane writing its own mute could never write again to undo it. The pickers that choose a lane's target leave these ids out: the track
  picker, the XY axis pickers, and the XY Pad's own assign pickers (its base
  assignment is what the XY lane drives). The machine refuses the write too, so a
  file naming one drives nothing on that lane. The import says so: a refused target
  is reported like an unknown one ([untrusted-input](untrusted-input.md)
  REQ-an-unresolvable-target-warns), and the lane's picker shows it dimmed
  ([motion-panel](motion-panel.md) REQ-a-motion-lane-header-carries-its-mute). The machine's check is a string-identity compare
  on the write path.

## Technical design

### Contract / public interface

- `src/state/motion-lanes.ts` (pure): `MOTION_LANE_COUNT`, `MOTION_XY_LANE` (0),
  `motionTrackLane(t)` (`1 + t`), `motionLaneMuteId(lane)` → `motion.xy.mute` |
  `motion.t<t>.mute`, `isMotionLaneMuteId(id)` and `motionTargetAllowed(lane, id)`.
- `MotionMachine.setLaneMuted(lane, m)`, bound by the Engine to each
  `motionLaneMuteId(l)` after the slide params. It marks the lane and stamps
  `mutedAt[lane]` with the frame count; `sweepMuted()` runs at the end of an
  evaluated frame while one is pending. The owner map lives beside the baseline
  map; `write(id, norm, lane)` and `release(id)` are the machine's only writers to
  either.
- `unresolvedTargets(file)` also reports a known id that `motionTargetAllowed`
  refuses for the lane it sits in.
- `createEffectiveXy` also re-resolves on `motion.xy.mute`.

### Data shapes

```yaml
Params:
  motion.xy.mute:   { discrete, labels: [on, mute], default: 0 }   # lane 0, the XY lane
  motion.t<i>.mute: { discrete, labels: [on, mute], default: 0 }   # lane 1+i, i in 0..MOTION_TRACK_COUNT-1
MotionMachine (private):
  laneMuted: boolean[MOTION_LANE_COUNT]
  mutedAt: number[MOTION_LANE_COUNT]   # frameSeq when the lane last muted
  frameSeq: number                     # evaluated frames; a frame with no cell does not count
  owner: Map<paramId, lane>            # the last writer; only beside a baseline
```

### Persistence

The params travel with songs, save slots, share links and project zips like any
param. An older build keeps an unknown param key and ignores it, so no song version
bump. Presets skip them (the `motion.` prefix).

## Scenarios (BDD)

```gherkin
Scenario: Muting one lane returns its param while the others keep moving (REQ-each-motion-lane-has-its-own-mute)
  Given track A drives fx.delay.mix and track B drives filter.resonance, both sliding
  When lane A is muted mid-play
  Then after the next frame fx.delay.mix is back at its pre-play value and stays there
  And filter.resonance keeps following track B's curve
  And unmuting lane A puts fx.delay.mix back on its curve on the next frame
# pinned by: tests/audio/transport/motion-machine.test.ts, e2e/motion.spec.ts

Scenario: Muting the XY lane restores both axes and the pad's base axes (REQ-each-motion-lane-has-its-own-mute)
  Given the play bank overrides x to fx.delay.time and the XY lane is driving it
  When motion.xy.mute is set
  Then both axis params return to their baselines while the tracks keep writing
  And the XY Pad's effective axes fall back to the base assignment
# pinned by: tests/audio/transport/motion-machine.test.ts, tests/state/xy-effective.test.ts

Scenario: A param two lanes share does not blip when one of them mutes (REQ-each-motion-lane-has-its-own-mute)
  Given the XY lane's y axis and track A both drive filter.resonance, A writing last
  When lane A is muted mid-play — by the user, by another lane after A has written
    in that frame, or just after a seek
  Then filter.resonance never takes its baseline value: the XY lane writes it first
    and takes it over
# pinned by: tests/audio/transport/motion-machine.test.ts

Scenario: A lane that is assigned but writes nothing protects nothing (REQ-each-motion-lane-has-its-own-mute, regression)
  Given the XY lane has no anchors but its axes name filter.resonance
  And track B drives filter.resonance
  When lane B is muted
  Then filter.resonance goes back to its baseline after the next frame
# pinned by: tests/audio/transport/motion-machine.test.ts

Scenario: A param shared by two lanes goes home when both mute (REQ-each-motion-lane-has-its-own-mute, regression)
  Given tracks A and B both drive fx.delay.mix
  When both are muted in the same frame
  Then fx.delay.mix is back at its baseline after the frame they both sit out
# pinned by: tests/audio/transport/motion-machine.test.ts

Scenario: At a handover the incoming bank decides (REQ-each-motion-lane-has-its-own-mute, regression)
  Given bank A's track B drives fx.delay.mix and lane B is muted just before the bar line
  When the chain moves to bank B
  Then if bank B's track A writes fx.delay.mix, it passes straight to that value
  And if bank B leaves it alone, it goes back to its baseline
# pinned by: tests/audio/transport/motion-machine.test.ts

Scenario: A muted lane does not park at a handover (REQ-each-motion-lane-has-its-own-mute)
  Given a chain A → B where bank A's track A drives a param bank B leaves alone
  And lane A is muted
  When the chain hands bank A over to bank B
  Then nothing writes that param — it stays at its baseline
# pinned by: tests/audio/transport/motion-machine.test.ts

Scenario: One lane switches another on and off (REQ-a-lane-can-mute-another-lane)
  Given track A in STEP mode drives motion.t1.mute, high on steps 0–7 and low on 8–15
  And track B slides filter.resonance
  When the bar plays
  Then lane B is muted for the first half — filter.resonance at its baseline —
    and follows its curve in the second half
  And stopping returns motion.t1.mute to the value the user set
# pinned by: tests/audio/transport/motion-machine.test.ts

Scenario: A muted lane leaves the mutes it set (REQ-a-lane-can-mute-another-lane)
  Given lane B mutes lane A, and lane C then mutes lane B
  Then A's sound params go home, but A stays muted — the switch B set is held
  And Stop returns every lane mute to what the user set
# pinned by: tests/audio/transport/motion-machine.test.ts

Scenario: Two lanes driving each other's mutes settle instead of flapping (REQ-a-lane-can-mute-another-lane, regression)
  Given the user muted lane A, lane A mutes lane B and lane B unmutes lane A
  When frames run at the same position
  Then B unmutes A once, A mutes B once, and neither switch moves again
# pinned by: tests/audio/transport/motion-machine.test.ts

Scenario: Two lanes muting each other settle in lane order (REQ-a-lane-can-mute-another-lane)
  Given track A drives motion.t1.mute high and track B drives motion.t0.mute high
  When a frame runs
  Then lane A writes first and mutes lane B, which writes nothing
  And the frame terminates with lane A live and lane B muted
# pinned by: tests/audio/transport/motion-machine.test.ts

Scenario: A lane cannot drive the machine switch or its own mute (REQ-a-lane-cannot-target-the-machine-or-itself)
  Given track A is assigned to motion.t0.mute (its own mute), or to motion.mute
  When the transport plays its anchors
  Then nothing is written and the machine keeps running
  And the lane's param picker offers neither id, while motion.t1.mute is offered
  And the XY Pad's assign pickers offer neither motion.on, motion.mute nor motion.xy.mute
# pinned by: tests/audio/transport/motion-machine.test.ts, tests/state/motion-lanes.test.ts, tests/ui/motion-panel.test.ts, tests/ui/xy-pad.test.ts

Scenario: A song naming a refused target says so on import (REQ-a-lane-cannot-target-the-machine-or-itself)
  Given a song whose lane A targets motion.t0.mute and whose xy.x is motion.xy.mute
  When it is validated
  Then it is accepted, with a warning naming each path
  And lane B targeting motion.t0.mute raises none
# pinned by: tests/state/song-validate.test.ts

Scenario: Lane mutes are not part of a sound (REQ-each-motion-lane-has-its-own-mute)
  Given lane B is muted
  When a preset is saved
  Then the preset carries no motion.*.mute param, and loading one leaves lane mutes alone
# pinned by: tests/state/preset-session.test.ts
```

## Tests & verification

- Unit: `tests/audio/transport/motion-machine.test.ts` ("per-lane mutes"),
  `tests/state/{motion-lanes,xy-effective,preset-session,song-validate}.test.ts`,
  `tests/ui/{motion-panel,xy-pad}.test.ts` — `npm test`. E2E: `e2e/motion.spec.ts`.
- Cost: `npm run bench:perf` "motion demo playing", before/after.
- **By ear** (ADR-010): mute and unmute each lane of a motion demo mid-play against
  an unmuted take; then a STEP lane on `motion.t1.mute` switching lane B per half-bar.

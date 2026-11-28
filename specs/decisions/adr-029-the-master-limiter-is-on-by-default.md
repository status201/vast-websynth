# ADR-029 — The master limiter is on by default, at a 0 dBFS ceiling after the volume

```yaml
id: adr-029-the-master-limiter-is-on-by-default
status: accepted
date: 2026-11-28
deciders: core
related:
  - ../features/master-limiter
  - adr-006-no-op-param-defaults
  - adr-010-musical-stable-cheap-dsp
  - adr-012-true-bypass-disconnects
```

## Context / Forces

[ADR-006](adr-006-no-op-param-defaults.md) says a new param defaults to a no-op.
Otherwise every saved song that lacks the key changes sound when it loads. The
[master limiter](../features/master-limiter.md) is only worth having if it is
there for someone who never knew to switch it on: an over hard-clips at the
speakers and in every export. A limiter left off by default protects nobody who
needs it.

What decides it is that "no-op" is a property of the **output**, not of the switch.
An over beyond 0 dBFS never sounded as stored. It reached the listener as a hard
clip in the browser's output and as the ±1 clamp in `pcm16`. So the only audio a
default-ON limiter can change is audio that was already being changed, by a worse
process.

## Decision

`fx.master.limit.on` defaults to **1**, with `ceiling` at **0 dBFS** and `drive` at
**0 dB**. The limiter sits **after** the master volume, directly before the
destination and the recorder (master-limiter.md REQ-the-limiter-is-the-last-stage).
At those defaults it is an identity, bit for bit and delayed by 1.5 ms, on any
signal that stays within ±1 (REQ-in-range-audio-passes-unchanged). Where a song
does exceed ±1, a lookahead gain dip replaces the hard clip.

This is consistent with ADR-006 rather than an exception to it. ADR-006 protects
the sound of a saved song, and a song's in-range sound is untouched. ADR-006
itself is unchanged.

## Alternatives considered

- **Off by default (strict reading of ADR-006)** — rejected. The people a safety
  limiter is for are exactly the ones who don't know it exists. It would also
  leave the default export path (`pcm16`'s clamp) clipping for every song that
  overs.
- **Before the master volume** (right after MASTER COMP, where a mixing desk's
  bus limiter sits) — rejected. Demos set `master.volume` anywhere from 0.5 to 1,
  so a 0 dBFS ceiling there would limit overs the volume was about to bring back
  into range. The default would then stop being a no-op, which is the property
  this decision rests on.
- **A ceiling below 0 dBFS by default** (−0.3 or −1 dB, for inter-sample headroom)
  — rejected for the same reason. It would touch in-range audio between the
  ceiling and 0 dBFS. A lower ceiling is one knob turn for anyone who wants one.
- **A stateless soft clipper** (no latency, cheapest) — rejected as the default
  safety. A clipper is distortion by construction, so it would colour every over
  instead of dipping it out of the way. It also has to start bending below 0 dBFS
  to be soft, which again touches in-range audio.
- **The native `DynamicsCompressorNode` as a limiter** — rejected. It applies its
  own make-up gain, which can't be switched off, so it would not be an identity
  in range. It is also not a brickwall at any setting, and Blink and Gecko render
  it differently.

## Consequences

- **Good:** no default path hard-clips any more, live or exported. A loud song is
  heard as a gain dip with a meter showing it. In-range songs are bit-exact.
  DRIVE makes the same stage a loudness control on request.
- **Trade-off:** every patch pays the limiter's audio-thread cost, because it is
  never bypassed by default. That cost is measured with `bench:perf`.
- **Trade-off:** 1.5 ms is added to the output latency, always. It is below any
  audible threshold for playing, and well inside the clock's look-ahead. Clock
  and sync outputs are not compensated for it.
- **Trade-off:** a song that clipped before **will sound different**. That is
  the point, but it is a change all the same. No shipped demo is one of them (see
  below), so the change reaches only user songs, live playing and DRIVE.

## Peak survey (before the limiter)

Every demo was rendered through `bench:audio` with `fx.master.limit.on=0` (the old
graph: bypassed means the undelayed dry path) at its own `master.volume`. Each
export was then scanned for full-scale samples. **44 of 46 demos were measured
and none reached full scale.** The hottest were Bunk at −2.1 dBFS, Luftballons at
−4.5 and Titulaer at −5.8. Every other demo peaked below −7 dBFS, including the
four Illusion demos that run MASTER COMP at +12 dB makeup (−13 to −25 dBFS).
Rickroll (238 s) and Sweet Dreams (190 s) are longer than the bench's 180 s cap
and weren't measured.

So on the day it landed, the default limiter changed no measured demo: each one
comes out bit-exact, 1.5 ms later. The case for ON rests on what isn't shipped:
a user's hot patch, stacked voices played live, a DRIVE turned up.

# ADR-023 — The synth channel goes stereo on demand, and its level never depends on that

```yaml
id: adr-023-the-synth-channel-goes-stereo-on-demand
status: accepted
date: 2026-09-22
deciders: core
related:
  - ../features/sequencer
  - ../features/lfo
  - ../features/runtime-performance
  - adr-006-no-op-param-defaults
  - adr-010-musical-stable-cheap-dsp
  - adr-012-true-bypass-disconnects
  - adr-018-audio-graph-memory-is-committed-not-reclaimed
```

> ADR `status` is its own decision lifecycle and is **not** the feature-spec
> `draft | active | implemented`. A decision is `proposed`, then `accepted`; a
> later ADR can mark it `superseded by adr-XXX` or `deprecated`. Records are
> append-only — supersede, don't rewrite.

## Context / Forces

The drum machine and the sampler have had per-track pan since their per-track
channels existed, because each of their tracks owns its voice: a
`StereoPannerNode` hangs off it and costs nothing else. The four **sequencer**
tracks do not own anything. They call the track-agnostic
`SynthOutput.playNote` into one shared eight-voice pool that sums at a single
`voiceBus`; track identity is discarded at the call.

That leaves exactly one seam — between a voice's output and `voiceBus` — and
putting a panner there collides with a deliberate, documented optimisation. The
synth voice path is **1-channel end to end**, and the insert chain stays
1-channel through `eq → dist → wah → phaser → delay` because `synthPan` was
placed *last* precisely so nothing upstream pays for a second channel
([lfo.md](../features/lfo.md) REQ-pan-sweeps-a-stereo-panner, ADR-010 *cheap*). A
`StereoPannerNode` always emits two channels, so a per-voice panner doubles the
work of ten biquads, a 4x-oversampled waveshaper, a wah, a phaser and a delay.

Tracing that turned up a second, older problem. `StereoPannerNode` passes a
**stereo** input through untouched at centre but applies the **equal-power** law
to a **mono** one. With the reverb bypassed — ADR-012 disconnects its wet edge,
and the reverb is the only thing in the chain that makes a second channel —
`synthPan` received mono and took 3 dB off the whole synth channel. Measured
through the real graph (`npm run bench:audio`, held A2, `osc2.level=0` to remove
beat-phase noise): **-40.03 dB with the reverb off against -37.02 dB with it on
and its mix at 0 — 3.01 dB, ratio 0.7075 = 1/sqrt(2)**. One node's channel count
was deciding the level of the channel, and switching a reverb on raised the *dry*
synth by 3 dB as a side effect.

Both problems are the same problem: the synth channel's behaviour depended on
*how many channels happened to be flowing*, which is an implementation detail no
musical control should be able to see.

## Decision

**The synth channel is 1-channel until a player asks for width, and its level and
its pan law never depend on which of those is true.** Two halves, and the second
is what makes the first safe:

1. **Width is spliced in on a gesture.** Every voice carries two output edges — a
   dry one and one through a `StereoPannerNode`, fed **mono** so it uses the
   equal-power law and carrying a fixed `sqrt(2)` so its centre equals the dry
   edge (sequencer.md REQ-panning-a-track-does-not-change-its-level). `Engine` holds the four
   `seq.t<i>.pan` values and connects the panned edges only while one of them is
   non-zero, using ADR-012's idiom: reconnect before ramping on the way in; ramp,
   then disconnect after the crossfade settles on the way out. Disconnecting is
   the point — a channel count follows *connections*, not gains. A song that
   never pans keeps the old graph, the mono inserts and the old CPU exactly
   ([sequencer.md](../features/sequencer.md) REQ-the-spread-stage-engages-off-centre).

2. **`synthPan`'s input is pinned to two channels, always.** `forceStereo`
   (`src/audio/stereo.ts`) sets `channelCount 2` / `channelCountMode 'explicit'`
   / `channelInterpretation 'speakers'`, so a mono input up-mixes to `L = R = x`
   and passes at unity ([lfo.md](../features/lfo.md) REQ-the-auto-pan-reads-a-stereo-input).

Without (2), (1) is not implementable as a no-op: engaging the stage would change
`synthPan`'s input from one channel to two and move the level 3 dB on any patch
with the reverb off — a pan knob that is also a volume knob. With (2) the splice
is transparent by construction, and that is the whole argument for doing them
together.

The helper is one place, not three: the sampler's per-slot pan already wrote
those three properties by hand with the explanation attached, and this is the
third caller.

Note that (2) applies to `synthPan` and **not** to the voice panners, which is
not an inconsistency but the same rule read twice. A `StereoPannerNode` has two
laws, and which one it uses is chosen by its input's channel count: *equal power*
for mono, *fold* for stereo. A voice **places a mono source**, so it wants equal
power and must stay mono; `synthPan` **moves an already-stereo bus**, so it wants
the fold and must not have its law flip when an effect upstream is switched on.
Both were measured, not reasoned: giving the voice panner a stereo input put
+1.34 dB of mix power into one hard-panned track, and leaving `synthPan` a mono
one took 3.01 dB off the whole channel.

## Alternatives considered

- **Always-on per-voice panners** — rejected. Simpler (no splice, no engage
  state), and with (2) it is sonically transparent, but every session then pays a
  2-channel insert chain whether or not anyone pans, including the weak
  performance tier. The cost is real and permanent, and it is levied on the
  overwhelming majority of songs that will never use the feature — which is
  exactly the shape ADR-006's no-op rule exists to refuse.

- **Four per-track sub-buses, each with its own FX chain** — rejected outright.
  It is the "obvious" mixer architecture and it is unaffordable here: four
  `ConvolverNode`s at ~10–13 MB each, committed for the session
  ([ADR-018](adr-018-audio-graph-memory-is-committed-not-reclaimed.md)), plus
  four of everything else. It would also make the FX per track, which is a
  different (and much larger) feature than placing four tracks in the field.

- **Partition the voice pool, four voices to four tracks** — rejected: it trades
  polyphony for stereo. Track 1 could no longer hold a chord, and live keyboard
  play would be competing for a quarter of the voices.

- **Rewire a voice to a per-track panner at note-on** — rejected: that is a graph
  edit per note, which [ADR-017](adr-017-modulation-in-graph.md) forbids in as
  many words ("never per frame, per tick or per note").

- **Leave the 3 dB alone and document it** — rejected, and this is the one worth
  recording. It keeps every existing song bit-exact, which is genuinely valuable.
  But it makes the new pan knob change loudness on any reverb-off patch, and it
  leaves an instrument where switching on a reverb also turns the dry signal up.
  The alternative was weighed against a small, auditable blast radius: 21 of the
  24 shipped demos run the synth reverb on and do not move at all; `1983`, `Bunk`
  and `Run_Away` gain the 3 dB they should always have had, and `Bunk` — the one
  demo that is both reverb-off and auto-panning — also changes sweep law. Three
  demos to re-listen to is a smaller price than a permanently dishonest control.

- **Fix the 3 dB by down-mixing to mono before the panner instead** — rejected:
  it would make the level consistent by destroying the reverb's stereo image,
  which is a sound change in the wrong direction (ADR-010, *musical* first).

## Consequences

- **Good:** per-track pan costs a centred song **nothing** — not a node in
  circuit, not a channel, not a cycle. The no-op default is a no-op in the
  strongest available sense: the same graph.
- **Good:** the auto-pan now behaves the same way everywhere. Its law and its
  level stop depending on an unrelated effect's bypass state, which also removes
  a trap for anyone adding a stereo effect to the chain later.
- **Trade-off:** a song that *does* pan pays a 2-channel insert chain — roughly
  double that stage — for as long as any track is off centre. That is the honest
  price of width, it is opted into, and it is the reason the stage disengages.
- **Trade-off:** three shipped demos change level by 3 dB and one changes its
  auto-pan character. Recorded here so the next person reading a demo diff knows
  why, rather than re-deriving it.
- **Trade-off:** two sequencer tracks sounding the **same pitch** still share one
  voice and therefore one pan ([sequencer.md](../features/sequencer.md)
  REQ-two-tracks-on-one-pitch-share-a-pan). Fixing that means keying the
  held-note map per track, which costs a voice per duplicated pitch out of eight
  and rewrites the stealing invariant; it is documented rather than paid for.
- **Generalises:** any future "give the synth channel a stereo stage" — a width
  control, a chorus, a haas spread — inherits both halves. Splice it on demand,
  and never let a channel count decide a level.

# ADR-005 — Filter cutoff as a MIDI note number, not Hz

```yaml
id: adr-005-cutoff-as-midi-note
status: accepted
date: 2026-05-15
deciders: core
related:
  - ../features/ladder-filter
  - ../features/lfo
  - ../features/envelopes
```

> ADR `status` is its own decision lifecycle (`proposed | accepted | superseded
> by adr-XXX | deprecated`), distinct from a feature spec's lifecycle.

## Context / Forces

The ladder filter's cutoff is modulated from several sources at once — the filter
envelope, the LFO, key-tracking, the mod wheel. Musically, all of those act in
**semitones** (an octave of sweep, a fixed key-track ratio), which is *linear in
note space* but *exponential in Hz*. Web Audio can sum multiple modulation
signals natively only by connecting them into a single `AudioParam`, and that
summation is additive. So the question is which unit the filter's cutoff
`AudioParam` should carry.

## Decision

The ladder filter **AudioWorklet** (`public/worklets/ladder-filter.js`) takes
**`cutoffNote`** — a MIDI note number — not a frequency in Hz. Every modulator
contributes a semitone offset that sums additively into that one `AudioParam` via
Web Audio's native input summation; the note→Hz conversion happens once, inside
the worklet. All modulation code therefore stays in semitone space (a rule
restated across `features/ladder-filter`, `features/lfo`, `features/envelopes`).

## Alternatives considered

- **Cutoff in Hz** — rejected: modulation in Hz is multiplicative and
  non-musical (the same "+200 Hz" is an octave down low and nothing up high), and
  it can't exploit `AudioParam` summation — we'd have to combine modulators by
  hand in JS, losing the audio-thread summation and sample-accurate timing.

## Consequences

- **Good:** envelope + LFO + key-track + mod-wheel sum for free in the audio
  thread, sample-accurately, in the unit musicians actually think in; one
  conversion lives in the worklet.
- **Trade-off:** the whole modulation pipeline is constrained to stay additive in
  semitone space — a contributor adding a new cutoff modulator must emit a semitone
  offset, not a Hz value, or the summation breaks silently.

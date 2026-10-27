# ADR-026 — Oscillator sync is a per-voice worklet that renders osc1 + osc2, and only while engaged

```yaml
id: adr-026-oscillator-sync-is-a-per-voice-worklet-pair
status: accepted
date: 2026-10-27
deciders: core
related:
  - ../features/oscillator-sync
  - ../features/oscillators
  - adr-010-musical-stable-cheap-dsp
  - adr-012-true-bypass-disconnects
  - adr-017-modulation-in-graph
```

## Context / Forces

Oscillator sync resets (or reverses) one oscillator whenever another completes a
cycle. The voice's oscillators are native `OscillatorNode`s: they are
band-limited by the browser and cost nothing on the audio thread we own, but
they cannot reset their phase. [oscillators](../features/oscillators.md) already
declined a worklet oscillator for PWM, on the grounds that polyBLEP aliases above
~2 kHz and would mean 16 always-on processors. It asked for any such proposal to
be made against [ADR-010](adr-010-musical-stable-cheap-dsp.md). Sync is that
proposal.

The forces:
- The *sound* of sync is the **sweep**: slave pitch moved by an envelope or LFO,
  per voice.
- A naive digital reset aliases badly.
- Cost multiplies by the voice count.

The kinds of sync considered:
- **Hard:** a reset at the master's wrap.
- **Reversing soft:** the slave's direction flips.
- **Threshold / weak:** hard sync gated off near or below the master.
- **Phase advance, reset inhibit, overlap (FOF)** and **PLL-style locking.**

Hard and reversing cover the musical ground. The rest are gates on hard sync,
niche, or need a feedback model.

## Decision

**Sync runs in a per-voice AudioWorklet that renders both osc1 and osc2 while
engaged, corrects every discontinuity with a windowed-sinc band-limited
residual, and does not exist or run while sync is off.**

- **Renders both oscillators.** The worklet cannot read a native node's phase,
  and two independently computed pitch tracks drift over a session-long voice.
  Owning both phases makes the lock structural.
- **Windowed-sinc residual.** The kernel is Blackman-Harris, half-length 16, cut
  off at 0.42·fs. It uses step, ramp and curvature residuals at the event's
  sub-sample time, and a 16-sample latency shared by both outputs.
- **Absent while off.** The module loads and the nodes are created on first use.
  An engaged pair is crossfaded in, and the silent side is disconnected (ADR-012).
  It idles with the voice, like the ladder filter.
- **Modulation stays in the graph (ADR-017).** Pitch sources and a new `sync`
  destination reach the pair through per-voice `ConstantSourceNode` junctions,
  so the filter envelope can sweep sync sample-accurately.

## Alternatives considered

- **A `PeriodicWave` bank indexed by ratio (the PWM trick)** — rejected. A synced
  wave at a fixed ratio is periodic at the master's pitch, so it *could* be
  precomputed and stay alias-free. But a ratio change is a main-thread swap on a
  timer. It zippers on a fast sweep, freezes in a background tab, and cannot
  follow a per-voice envelope in the graph. At ~670 KB of native memory per
  entry ([oscillators](../features/oscillators.md)
  REQ-a-wave-bank-entry-is-built-on-first-use), one swept bank is ~86 MB per
  slave waveform.
- **Keep osc1 native and run a phantom master in the worklet** — rejected. It is
  cheaper, but the audible osc1 and the slave's reset clock would be two phases
  that slowly drift, so osc1+osc2 near ratio 1 would comb-cancel differently
  note to note.
- **2-point polyBLEP** — rejected as the shipped kernel. It is measured at −16…−39
  dB total aliasing on a saw slave, where the windowed sinc reaches −40…−89.
  Overlapping events within 2 samples also defeat it. It is kept only as a
  measurement baseline.
- **A shorter (half-length 8) sinc** — rejected. It measures the same below
  10 kHz, but 15–25 dB worse above. It is cheaper by ≤ ~1.5% of a core in the
  busiest case, and ADR-010 ranks *musical* first.
- **minBLEP** (minimum-phase, zero latency) — rejected. It needs a
  cepstrum-built table, and latency is irrelevant when both outputs share it.
- **Oversampling** — rejected, as ADR-010 already rejects it: every per-sample
  cost multiplies, a decimator is needed, and it is the only cure for a sine
  slave near Nyquist, which is a corner worth accepting rather than paying for.
- **BLIT with a leaky integrator** — rejected on *stable*: DC drift and
  integrator state that a sweep can run away with.
- **Swapping each `Osc` to a worklet node permanently** — rejected. Every patch
  would pay audio-thread cost for a feature most do not use, and the default
  sound would change.

## Consequences

- **Good:**
  - Hard and soft sync with in-graph, per-voice, sample-accurate sweeps.
  - Saw, triangle and square slaves are at the measurement floor in band.
  - Zero cost and an unchanged graph for every patch that does not use it.
  - A-rate pulse width comes free for an engaged pair.
- **Trade-off:**
  - About 3.5–12% of one core for 8 sounding voices with sync on (Node
    measurement), roughly 2–3× the ladder filter.
  - A 0.33 ms offset between the pair and the native sub-oscillator, inaudible
    because the sub was never phase-locked.
  - A sine slave above ~3 kHz aliases more than the other waves.
  - While engaged, osc1 is the worklet's oscillator, not the browser's. The two
    differ only in their aliasing residue.
  - The first engagement waits for one module load, and voices play native until
    it lands.

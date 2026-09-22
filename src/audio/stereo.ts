/**
 * The 2-channel up-mix a `StereoPannerNode` needs in front of it.
 *
 * A `StereoPannerNode` passes a **stereo** input through untouched at centre,
 * but applies the **equal-power** law to a **mono** one — so a mono signal
 * arrives 3.01 dB quieter (ratio 0.7075 = 1/sqrt(2)) through a panner that is
 * doing nothing. Pinning the node ahead of it to two explicit channels makes the
 * graph up-mix to `L = R = x` first, and centre becomes a real no-op.
 *
 * That trap has now been paid for twice: the sampler's per-slot channel
 * (sampler.md REQ-each-slot-has-a-channel) hit it when a mono clip went quiet,
 * and `synthPan` had been silently taking 3 dB off the whole synth channel
 * whenever the reverb — the only thing upstream that makes a second channel —
 * was bypassed (lfo.md REQ-the-auto-pan-reads-a-stereo-input, ADR-023). One
 * helper, so the third caller does not re-derive it.
 *
 * `speakers` is the default interpretation and is set anyway: the whole point is
 * that the up-mix is a speaker up-mix (L = R), not a discrete channel map.
 */
export function forceStereo<T extends AudioNode>(node: T): T {
  node.channelCount = 2;
  node.channelCountMode = 'explicit';
  node.channelInterpretation = 'speakers';
  return node;
}

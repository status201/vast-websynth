import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { forceStereo } from '../../src/audio/stereo';

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8');

/**
 * **A channel count must never decide a level** (lfo.md
 * REQ-the-auto-pan-reads-a-stereo-input, ADR-023).
 *
 * `StereoPannerNode` passes a STEREO input through untouched at centre but
 * applies the equal-power law to a MONO one. `synthPan` saw one channel or two
 * depending on whether the **reverb** — the only thing in the synth chain that
 * makes a second — was bypassed, so switching a reverb on raised the dry synth
 * by 3.01 dB (measured through the real graph: -40.03 dB against -37.02 dB,
 * ratio 0.7075) and changed the sweep's law with it.
 *
 * The level half of that cannot be observed behaviourally here: the mock graph
 * has no channels and no mixing, so a unit test cannot hear 3 dB. It is pinned
 * the way `no-unanchored-cancel.test.ts` pins its Gecko defect — the helper's
 * behaviour directly, and a source rule that the one node which used to be
 * exposed still goes through it. The audible half is ADR-010's job
 * (specs/recipes/verify-audio-by-ear.md).
 */
describe('forceStereo', () => {
  it('pins a node to an explicit 2-channel speaker up-mix', () => {
    const node = { channelCount: 1, channelCountMode: 'max', channelInterpretation: 'discrete' };
    forceStereo(node as unknown as AudioNode);
    expect(node.channelCount).toBe(2);
    expect(node.channelCountMode).toBe('explicit');
    // A speaker up-mix is the point: mono must arrive as L = R, not on one side.
    expect(node.channelInterpretation).toBe('speakers');
  });

  it('returns the node, so it can wrap a create call inline', () => {
    const node = {} as unknown as AudioNode;
    expect(forceStereo(node)).toBe(node);
  });
});

describe('the synth channel forces stereo where it matters', () => {
  it('synthPan goes through forceStereo', () => {
    // If this line is ever dropped, the synth quietly loses 3 dB again on every
    // patch whose reverb is off, and every test still passes.
    expect(src('audio/engine.ts')).toContain('forceStereo(this.synthPan)');
  });

  it('the sampler slot pan still does too, via the same helper', () => {
    const s = src('audio/transport/sampler-machine.ts');
    expect(s).toContain('forceStereo(g)');
    // The hand-written copy is gone — one rule, one place (ADR-023).
    expect(s).not.toContain("channelCountMode = 'explicit'");
  });

  it('a voice does NOT force its own pan edge stereo', () => {
    // The opposite rule from synthPan's, and for the opposite reason: a voice is
    // placing a MONO source, which wants the equal-power law. See
    // voice-spread.test.ts for the measurement that settles it.
    expect(src('audio/voice.ts')).not.toContain('forceStereo');
  });
});

/**
 * The pan survives four hand-offs to reach a voice — sequencer → `SynthOutput`
 * → `Engine.playNote` → `Polyphony` → `Voice` — and dropping it at any one of
 * them is **silent**: the param still registers, `param-wiring` still sees the
 * id referenced, every unit test still passes and the knob still moves.
 *
 * That is not hypothetical. The adapter really was written
 * `(n, v, w) => this.playNote(n, v, w)` and swallowed the opts; nothing but a
 * rendered take caught it. `voice-spread.test.ts` pins the far end of the seam
 * behaviourally; this is the closure itself.
 */
describe('the SynthOutput adapter', () => {
  it('passes its fourth argument on', () => {
    expect(src('audio/engine.ts')).toContain('playNote: (n, v, w, o) => this.playNote(n, v, w, o)');
  });
});

import { describe, it, expect } from 'vitest';
import { anythingToPlay } from '../../../src/audio/transport/anything-to-play';
import { PatternStore, REST } from '../../../src/state/patterns';
import type { ChainLane } from '../../../src/audio/transport/arrangement';

/** empty-play-hint.md REQ-2 — the pure "would starting the transport sound?" rule. */

const lane = (enabled = false, steps: number[] = [0]): ChainLane => ({ enabled, steps });

function makeGet(on: Partial<Record<string, number>>): (id: string) => number {
  return (id) => on[id] ?? 0;
}

const NO_BUFFERS = Array<AudioBuffer | null>(8).fill(null);
const fakeBuffer = {} as AudioBuffer;

function lanes(over: Partial<{ seq: ChainLane; drum: ChainLane; sampler: ChainLane }> = {}) {
  return { seq: lane(), drum: lane(), sampler: lane(), ...over };
}

describe('anythingToPlay', () => {
  it('is false on a fresh store with every machine off (the seeded drum groove is silent)', () => {
    const patterns = new PatternStore();
    expect(anythingToPlay(makeGet({}), patterns, lanes(), NO_BUFFERS)).toBe(false);
  });

  it('an enabled arp always counts (it sounds on a held key)', () => {
    const patterns = new PatternStore();
    expect(anythingToPlay(makeGet({ 'arp.on': 1 }), patterns, lanes(), NO_BUFFERS)).toBe(true);
  });

  it('drums: the seeded groove counts once drum.on rises', () => {
    const patterns = new PatternStore();
    expect(anythingToPlay(makeGet({ 'drum.on': 1 }), patterns, lanes(), NO_BUFFERS)).toBe(true);
  });

  it('seq: on but empty is false; a lit step flips it', () => {
    const patterns = new PatternStore();
    const get = makeGet({ 'seq.on': 1 });
    expect(anythingToPlay(get, patterns, lanes(), NO_BUFFERS)).toBe(false);
    patterns.setSeqStep(3, { on: true });
    expect(anythingToPlay(get, patterns, lanes(), NO_BUFFERS)).toBe(true);
  });

  it('chain enabled: only banks actually in the chain count (RESTs skipped)', () => {
    const patterns = new PatternStore();
    const get = makeGet({ 'seq.on': 1 });
    patterns.setSeqStep(0, { on: true }); // content in bank 0 (the edit bank)

    // Chain plays only bank 1 (empty) → silent, even though bank 0 has a step.
    expect(anythingToPlay(get, patterns, lanes({ seq: lane(true, [1]) }), NO_BUFFERS)).toBe(false);
    // A chain of pure rests is silent too.
    expect(anythingToPlay(get, patterns, lanes({ seq: lane(true, [REST]) }), NO_BUFFERS)).toBe(false);
    // Adding bank 0 to the chain makes it audible.
    expect(anythingToPlay(get, patterns, lanes({ seq: lane(true, [REST, 0]) }), NO_BUFFERS)).toBe(true);
  });

  it('sampler: a lit cell needs a loaded buffer on that slot', () => {
    const patterns = new PatternStore();
    const get = makeGet({ 'sampler.on': 1 });
    patterns.setSamplerCell(2, 0, { on: true });
    expect(anythingToPlay(get, patterns, lanes(), NO_BUFFERS)).toBe(false);

    const buffers = [...NO_BUFFERS];
    buffers[1] = fakeBuffer; // wrong slot — still silent
    expect(anythingToPlay(get, patterns, lanes(), buffers)).toBe(false);
    buffers[2] = fakeBuffer;
    expect(anythingToPlay(get, patterns, lanes(), buffers)).toBe(true);
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Song, DEMO_SONGS } from '../../src/state/song';
import type { SongFile } from '../../src/state/song';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { PatternStore } from '../../src/state/patterns';

/** Deep clone via JSON so a test never mutates the shared DEMO_SONGS object. */
function demo(): SongFile {
  return JSON.parse(JSON.stringify(DEMO_SONGS['Knight Rider'])) as SongFile;
}

/** Minimal Arrangement stand-in: only the surface Song.capture/apply touch. */
function fakeArr() {
  return {
    seq: { enabled: false, steps: [0] as number[] },
    drum: { enabled: false, steps: [0] as number[] },
    sampler: { enabled: false, steps: [0] as number[] },
    setSeqChain(steps: number[], enabled: boolean) {
      this.seq = { enabled, steps: [...steps] };
    },
    setDrumChain(steps: number[], enabled: boolean) {
      this.drum = { enabled, steps: [...steps] };
    },
    setSamplerChain(steps: number[], enabled: boolean) {
      this.sampler = { enabled, steps: [...steps] };
    },
  };
}

// jsdom's localStorage isn't reliably wired here; a tiny in-memory Storage
// keeps the slot tests deterministic and version-independent.
const store = new Map<string, string>();
const localStorageMock: Storage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};

describe('Song', () => {
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', localStorageMock);
  });

  it('round-trips through toJSON/fromJSON', () => {
    const file = demo();
    const parsed = Song.fromJSON(Song.toJSON(file));
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('Knight Rider');
    expect(parsed).toEqual(file);
  });

  it('fromJSON rejects malformed JSON', () => {
    expect(Song.fromJSON('{ not json')).toBeNull();
  });

  it('fromJSON rejects valid JSON missing the song shape', () => {
    expect(Song.fromJSON(JSON.stringify({ format: 'websynth-song' }))).toBeNull();
    expect(Song.fromJSON(JSON.stringify({ hello: 'world' }))).toBeNull();
  });

  it('list() includes the demo songs', () => {
    expect(Song.list()).toEqual(
      expect.arrayContaining(['Knight Rider', 'Zombie Nation', 'I Feel Love']),
    );
  });

  it('saveSlot → loadSlot → deleteSlot via localStorage', () => {
    const file = demo();
    file.name = 'My Slot';
    Song.saveSlot('My Slot', file);
    expect(Song.list()).toContain('My Slot');

    const loaded = Song.loadSlot('My Slot');
    expect(loaded?.name).toBe('My Slot');

    Song.deleteSlot('My Slot');
    expect(Song.list()).not.toContain('My Slot');
    expect(Song.loadSlot('My Slot')).toBeNull();
  });

  it('loadSlot falls back to a demo song when no slot is stored', () => {
    expect(Song.loadSlot('Zombie Nation')?.name).toBe('Zombie Nation');
  });

  it('apply() restores params + banks + both chain lanes into live state', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    const patterns = new PatternStore();
    const arr = fakeArr();
    const file = demo(); // Knight Rider: bpm 125, mono voicing

    Song.apply(file, bus, patterns, arr as never);

    expect(bus.get('transport.bpm')).toBe(125);
    expect(bus.get('voicing.mode')).toBe(0);
    expect(arr.seq.enabled).toBe(true);
    expect(arr.seq.steps).toEqual([0, 0, 1, 0]);
    expect(arr.drum.steps).toEqual([0, 0, 0, 1]);
    // first sequencer bank note matches the Knight Rider riff
    expect(patterns.seqBanks[0]![0]!.note).toBe(36);
  });

  it('apply() resets params omitted from the snapshot back to their defaults', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    const patterns = new PatternStore();
    const arr = fakeArr();

    bus.set('fx.drum.delay.on', 1);                   // simulate a prior full snapshot
    Song.apply(demo(), bus, patterns, arr as never);  // Knight Rider omits the key

    expect(bus.get('fx.drum.delay.on')).toBe(0);      // back to registered default
  });

  it('capture() snapshots params, banks and both chain lanes', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    bus.set('transport.bpm', 142);
    const patterns = new PatternStore();
    const arr = fakeArr();
    arr.setSeqChain([1, 2], true);

    const file = Song.capture(bus, patterns, arr as never, 'Take 1');
    expect(file.format).toBe('websynth-song');
    expect(file.name).toBe('Take 1');
    expect(file.params['transport.bpm']).toBe(142);
    expect(file.seqChain).toEqual({ enabled: true, steps: [1, 2] });
    expect(file.seqBanks.length).toBe(4);
  });

  describe('sampler (v2)', () => {
    it('capture() writes version 2 with sampler banks/chain/names', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      const patterns = new PatternStore();
      patterns.setSamplerCell(0, 3, { on: true });
      patterns.setSampleName(1, 'kick.wav');
      const arr = fakeArr();
      arr.setSamplerChain([2, 3], true);

      const file = Song.capture(bus, patterns, arr as never, 'S');
      expect(file.version).toBe(2);
      expect(file.samplerChain).toEqual({ enabled: true, steps: [2, 3] });
      expect(file.samplerBanks!.length).toBe(4);
      expect(file.samplerBanks![0]![0]![3]!.on).toBe(true);
      expect(file.sampleNames![1]).toBe('kick.wav');
    });

    it('v2 round-trips through toJSON/fromJSON', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      const patterns = new PatternStore();
      patterns.setSampleName(0, 'snare.mp3');
      const arr = fakeArr();
      arr.setSamplerChain([1], true);
      const file = Song.capture(bus, patterns, arr as never, 'RT');
      expect(Song.fromJSON(Song.toJSON(file))).toEqual(file);
    });

    it('v1 song (no sampler fields) still applies — empty banks, chain off', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      const patterns = new PatternStore();
      patterns.setSamplerCell(0, 5, { on: true }); // pre-existing edit state
      patterns.setSampleName(0, 'leftover.wav');
      const arr = fakeArr();
      const v1 = demo(); // Knight Rider is version 1, no sampler fields
      expect(v1.version).toBe(1);

      Song.apply(v1, bus, patterns, arr as never);

      expect(arr.sampler).toEqual({ enabled: false, steps: [0] });
      // restore() with absent sampler fields leaves banks/names untouched,
      // so applying a v1 song never corrupts sampler state.
      expect(patterns.samplerBanks[0]![0]![5]!.on).toBe(true);
      expect(patterns.sampleNames[0]).toBe('leftover.wav');
    });
  });

  describe('"I Feel Love" demo', () => {
    it('exists and round-trips through toJSON/fromJSON', () => {
      const ifl = DEMO_SONGS['I Feel Love'];
      expect(ifl).toBeDefined();
      const parsed = Song.fromJSON(Song.toJSON(ifl!));
      expect(parsed).toEqual(ifl);
    });

    it('applies the ladder-filter bass params + octave-pulse riff', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      const patterns = new PatternStore();
      const arr = fakeArr();

      Song.apply(DEMO_SONGS['I Feel Love']!, bus, patterns, arr as never);

      expect(bus.get('transport.bpm')).toBe(125);
      expect(bus.get('voicing.mode')).toBe(0); // mono
      expect(bus.get('filter.resonance')).toBe(1.5);
      expect(bus.get('lfo.dest')).toBe(1); // LFO → cutoff
      // step 2 jumps the octave (45 → 57) in the bassline
      expect(patterns.seqBanks[0]![2]!.note).toBe(57);
      expect(arr.seq.enabled).toBe(true);
    });
  });

  describe('"Apex Twin" drop-in demo', () => {
    it('is auto-registered ahead of the built-ins and round-trips', () => {
      const apex = DEMO_SONGS['Apex Twin'];
      expect(apex).toBeDefined();
      // Drop-in demos are spread *before* the hand-authored built-ins, so any
      // drop-in precedes any built-in regardless of how many demos exist.
      // (Asserting a fixed [0] key breaks the moment another drop-in is added.)
      const keys = Object.keys(DEMO_SONGS);
      expect(keys.indexOf('Apex Twin')).toBeLessThan(keys.indexOf('Knight Rider'));
      expect(Song.fromJSON(Song.toJSON(apex!))).toEqual(apex);
    });

    it('applies its params + 8-step chains', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      const patterns = new PatternStore();
      const arr = fakeArr();

      Song.apply(DEMO_SONGS['Apex Twin']!, bus, patterns, arr as never);

      expect(bus.get('transport.bpm')).toBe(128);
      expect(patterns.seqBanks[0]![0]!.note).toBe(45);
      expect(arr.seq.steps).toEqual([0, 0, 1, 0, 0, 2, 0, 3]);
      expect(arr.drum.steps).toEqual([0, 0, 1, 1, 2, 0, 1, 3]);
    });
  });
});

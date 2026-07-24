import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Song, DEMO_SONGS } from '../../src/state/song';
import type { SongFile } from '../../src/state/song';
import { compactSongForExport } from '../../src/state/serialize';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { PatternStore } from '../../src/state/patterns';
import { XyPadStore, XY_DEFAULT_ASSIGN } from '../../src/state/xy-pad';

/** Deep clone via JSON so a test never mutates the shared DEMO_SONGS object. */
function demo(): SongFile {
  return JSON.parse(JSON.stringify(DEMO_SONGS['Zombie Nation'])) as SongFile;
}

/** Minimal Arrangement stand-in: only the surface Song.capture/apply touch. */
function fakeArr() {
  return {
    seq: { enabled: false, steps: [0] as number[] },
    drum: { enabled: false, steps: [0] as number[] },
    sampler: { enabled: false, steps: [0] as number[] },
    motion: { enabled: false, steps: [0] as number[] },
    setSeqChain(steps: number[], enabled: boolean) {
      this.seq = { enabled, steps: [...steps] };
    },
    setDrumChain(steps: number[], enabled: boolean) {
      this.drum = { enabled, steps: [...steps] };
    },
    setSamplerChain(steps: number[], enabled: boolean) {
      this.sampler = { enabled, steps: [...steps] };
    },
    setMotionChain(steps: number[], enabled: boolean) {
      this.motion = { enabled, steps: [...steps] };
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
    expect(parsed!.name).toBe('Zombie Nation');
    // toJSON emits the canonical compact form (rounded + default-sparse cells),
    // so fromJSON returns that, not the full-cell input. apply() re-expands it.
    expect(parsed).toEqual(compactSongForExport(file));
  });

  it('fromJSON rejects malformed JSON', () => {
    expect(Song.fromJSON('{ not json')).toBeNull();
  });

  it('fromJSON rejects valid JSON missing the song shape', () => {
    expect(Song.fromJSON(JSON.stringify({ format: 'websynth-song' }))).toBeNull();
    expect(Song.fromJSON(JSON.stringify({ hello: 'world' }))).toBeNull();
  });

  describe('authoring-dialect routing (parse)', () => {
    it('parse() expands an author-format file to a canonical v3 SongFile', () => {
      const author = JSON.stringify({
        format: 'websynth-song-author',
        version: 1,
        name: 'Author Song',
        params: { 'transport.bpm': 124 },
        seq: [['A2', null, 'C3']],
        drums: [{ kick: [0, 4, 8, 12] }],
        seqChain: 'AABA',
      });
      const res = Song.parse(author);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.file.format).toBe('websynth-song');
      expect(res.file.version).toBe(3);
      expect(res.file.name).toBe('Author Song');
      expect(res.file.seqBanks[0]![0]!.note).toBe(45);
      expect(res.file.drumBanks[0]![0]![4]!.on).toBe(true);
      expect(res.file.seqChain).toEqual({ enabled: true, steps: [0, 0, 1, 0] });
      // The expanded file applies like any canonical file.
      const bus = new ParamBus();
      registerDefaults(bus);
      Song.apply(res.file, bus, new PatternStore(), fakeArr() as never);
      expect(bus.get('transport.bpm')).toBe(124);
    });

    it('parse() reports author-dialect errors in authoring terms', () => {
      const res = Song.parse(JSON.stringify({
        format: 'websynth-song-author', version: 1, name: 'X', seq: [['H4']],
      }));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.errors[0]).toMatch(/seq\[0\]\[0\]/);
    });

    it('parse() of a canonical file is unchanged by the routing branch', () => {
      const res = Song.parse(Song.toJSON(demo()));
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.file).toEqual(compactSongForExport(demo()));
    });
  });

  it('list() includes the demo songs', () => {
    expect(Song.list()).toEqual(
      expect.arrayContaining(['Zombie Nation', 'I Feel Love']),
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
    const file = demo(); // Zombie Nation: bpm 130, mono voicing

    Song.apply(file, bus, patterns, arr as never);

    expect(bus.get('transport.bpm')).toBe(130);
    expect(bus.get('voicing.mode')).toBe(0);
    expect(arr.seq.enabled).toBe(true);
    expect(arr.seq.steps).toEqual([0, 1, 2, 3]);
    expect(arr.drum.steps).toEqual([0, 0, 0, 1]);
    // first sounded note of the Zombie Nation hook (step 0 is a rest)
    expect(patterns.seqBanks[0]![0]![2]!.note).toBe(69);
  });

  it('apply() resets params omitted from the snapshot back to their defaults', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    const patterns = new PatternStore();
    const arr = fakeArr();

    bus.set('fx.drum.delay.on', 1);                   // simulate a prior full snapshot
    Song.apply(demo(), bus, patterns, arr as never);  // Zombie Nation omits the key

    expect(bus.get('fx.drum.delay.on')).toBe(0);      // back to registered default
  });

  it('apply() fires per-param subscribers (audio/UI repaint) but suppresses onChange (not an edit)', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    const patterns = new PatternStore();
    const arr = fakeArr();

    // A per-param subscriber stands in for BOTH an Engine audio applier and a
    // UI control: on load they repaint through this one `subscribe` channel.
    const bpmSeen: number[] = [];
    bus.subscribe('transport.bpm', (v) => bpmSeen.push(v)); // fires now with default 120
    // onChange is the global "an edit happened" signal (→ session.markDirty()).
    const edits: string[] = [];
    bus.onChange((id) => edits.push(id));

    Song.apply(demo(), bus, patterns, arr as never); // Zombie Nation: bpm 130

    // The per-param channel delivered the restored value, so audio + UI update…
    expect(bpmSeen).toContain(130);
    // …but loading a song is NOT an edit, so the global onChange never fired.
    expect(edits).toEqual([]);
  });

  it('a chain REST slot round-trips through capture / toJSON / fromJSON / apply', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    const patterns = new PatternStore();
    const arr = fakeArr();
    arr.setDrumChain([0, -1, 1], true); // REST in the middle

    const file = Song.capture(bus, patterns, arr as never, 'Rest song');
    expect(file.drumChain).toEqual({ enabled: true, steps: [0, -1, 1] });

    // Survives serialization, and apply() (via set*Chain / clampChainStep) preserves it.
    const parsed = Song.fromJSON(Song.toJSON(file));
    expect(parsed!.drumChain.steps).toEqual([0, -1, 1]);
    const arr2 = fakeArr();
    Song.apply(parsed!, bus, new PatternStore(), arr2 as never);
    expect(arr2.drum.steps).toEqual([0, -1, 1]);
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

  it('capture() emits full drum cells (per-step settings included)', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    const patterns = new PatternStore();
    patterns.setDrumCell(2, 5, { on: true, gate: 0.5, ratchet: 3 });

    const file = Song.capture(bus, patterns, fakeArr() as never, 'Full');
    expect(file.drumBanks[0]![2]![5]!).toEqual(
      { on: true, velocity: 0.85, gate: 0.5, prob: 1, ratchet: 3, tie: false });
  });

  it('applying a legacy file (on/velocity drum cells) resets per-step settings to defaults', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    const patterns = new PatternStore();
    patterns.setDrumCell(0, 0, { gate: 0.25, ratchet: 4, tie: true }); // live edits to reset
    const arr = fakeArr();
    const v1 = demo();
    expect(v1.version).toBe(1);
    // Strip the cells down to the legacy { on, velocity } shape.
    v1.drumBanks = v1.drumBanks.map((bank) =>
      bank.map((row) => row.map((c) => ({ on: c.on, velocity: c.velocity }))),
    ) as typeof v1.drumBanks;

    Song.apply(v1, bus, patterns, arr as never);

    const cell = patterns.drumBanks[0]![0]![0]!;
    expect(cell.gate).toBe(1);
    expect(cell.ratchet).toBe(1);
    expect(cell.tie).toBe(false);
  });

  describe('sampler (v2)', () => {
    it('capture() writes the current version with sampler banks/chain/names', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      const patterns = new PatternStore();
      patterns.setSamplerCell(0, 3, { on: true });
      patterns.setSampleName(1, 'kick.wav');
      const arr = fakeArr();
      arr.setSamplerChain([2, 3], true);

      const file = Song.capture(bus, patterns, arr as never, 'S');
      expect(file.version).toBe(6);
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
      expect(Song.fromJSON(Song.toJSON(file))).toEqual(compactSongForExport(file));
    });

    it('v1 song (no sampler fields) still applies — empty banks, chain off', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      const patterns = new PatternStore();
      patterns.setSamplerCell(0, 5, { on: true }); // pre-existing edit state
      patterns.setSampleName(0, 'leftover.wav');
      const arr = fakeArr();
      const v1 = demo(); // Zombie Nation is version 1, no sampler fields
      expect(v1.version).toBe(1);

      Song.apply(v1, bus, patterns, arr as never);

      expect(arr.sampler).toEqual({ enabled: false, steps: [0] });
      // restore() with absent sampler fields leaves banks/names untouched,
      // so applying a v1 song never corrupts sampler state.
      expect(patterns.samplerBanks[0]![0]![5]!.on).toBe(true);
      expect(patterns.sampleNames[0]).toBe('leftover.wav');
    });
  });

  describe('load is authoritative — motion (regression)', () => {
    it('loading a no-motion song clears motion but keeps sampler (REQ-3)', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      const patterns = new PatternStore();
      const arr = fakeArr();

      // A previously-loaded song's live state: motion (an XY anchor, an assigned +
      // anchored extra track, and a per-bank axis override) AND sampler (cell + name).
      patterns.setMotionStep(0, { on: true, x: 0.5, y: 0.8 });
      patterns.setMotionTrackParam(0, 'fx.delay.mix');
      patterns.setMotionTrackStep(0, 3, { on: true, v: 0.7 });
      patterns.setMotionAssign({ x: 'lfo.rate', y: 'master.volume' });
      patterns.setSamplerCell(0, 5, { on: true });
      patterns.setSampleName(0, 'kept.wav');

      // Load Zombie Nation (v1 — no motion AND no sampler fields) into the SAME store.
      const v1 = demo();
      expect(v1.version).toBe(1);
      Song.apply(v1, bus, patterns, arr as never);

      // Motion is authoritative: every section is blanked, nothing is still automated.
      expect(patterns.motion.every((s) => !s.on)).toBe(true);
      expect(patterns.motionTrack(0)!.param).toBeUndefined();
      expect(patterns.motionTrack(0)!.steps.every((s) => !s.on)).toBe(true);
      expect(patterns.motionAssign(0)).toBeNull();

      // Sampler is the deliberate exception — its banks/names inherit (buffers live
      // in SamplerMachine; a full sampler clear is New Song's job).
      expect(patterns.samplerBanks[0]![0]![5]!.on).toBe(true);
      expect(patterns.sampleNames[0]).toBe('kept.wav');
    });
  });

  // song-mode.md REQ-3b / sampler.md REQ-7 — a slot's audio belongs to the name
  // beside it, so a load that renames a slot must take the audio with it.
  describe('load is authoritative — stale sampler audio (regression)', () => {
    /** Stand-in for SamplerMachine: records what apply evicted. */
    const fakeSampler = () => {
      const cleared: number[] = [];
      return { cleared, setBuffer: (slot: number, buf: AudioBuffer | null) => { if (!buf) cleared.push(slot); } };
    };

    const rig = () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      const patterns = new PatternStore();
      patterns.setSampleName(0, 'beep.wav');
      patterns.setSampleName(1, 'kick.wav');
      return { bus, patterns, arr: fakeArr() };
    };

    it('evicts the buffer of every slot the incoming song renames', () => {
      const { bus, patterns, arr } = rig();
      const sampler = fakeSampler();

      const file = Song.capture(bus, new PatternStore(), fakeArr() as never, 'Other');
      file.sampleNames = ['snare.wav', 'kick.wav', null, null, null, null, null, null];

      Song.apply(file, bus, patterns, arr as never, undefined, sampler);

      // Slot 0 renamed → evicted. Slot 1 has the SAME name → its audio is kept,
      // so reloading a song you already have the samples for still just works.
      expect(sampler.cleared).toEqual([0]);
    });

    it('evicts a slot the incoming song leaves unnamed', () => {
      const { bus, patterns, arr } = rig();
      const sampler = fakeSampler();

      const file = Song.capture(bus, new PatternStore(), fakeArr() as never, 'Blank');
      expect(file.sampleNames!.every((n) => n === null)).toBe(true);

      Song.apply(file, bus, patterns, arr as never, undefined, sampler);
      expect(sampler.cleared).toEqual([0, 1]);
    });

    it('evicts nothing when the file omits sampleNames (v1 inherit, REQ-3)', () => {
      const { bus, patterns, arr } = rig();
      const sampler = fakeSampler();

      const v1 = demo(); // Zombie Nation — no sampler section at all
      expect(v1.sampleNames).toBeUndefined();

      Song.apply(v1, bus, patterns, arr as never, undefined, sampler);
      expect(sampler.cleared).toEqual([]);
      expect(patterns.sampleNames[0]).toBe('beep.wav');
    });

    it('is a no-op without a sampler handle (unit callers keep the old shape)', () => {
      const { bus, patterns, arr } = rig();
      const file = Song.capture(bus, new PatternStore(), fakeArr() as never, 'Blank');
      expect(() => Song.apply(file, bus, patterns, arr as never)).not.toThrow();
    });
  });

  describe('XY Pad (v3)', () => {
    it('capture() writes version 3 and the store\'s current axis assignment', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      const patterns = new PatternStore();
      const xy = new XyPadStore();
      xy.set({ x: 'lfo.rate', y: 'master.volume' });

      const file = Song.capture(bus, patterns, fakeArr() as never, 'XY', xy);
      expect(file.version).toBe(6);
      expect(file.xy).toEqual({ x: 'lfo.rate', y: 'master.volume' });
    });

    it('capture() without a store still writes the default assignment (v3)', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      const file = Song.capture(bus, new PatternStore(), fakeArr() as never, 'XY');
      expect(file.version).toBe(6);
      expect(file.xy).toEqual(XY_DEFAULT_ASSIGN);
    });

    it('apply() sets the XY store from the file', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      const patterns = new PatternStore();
      const arr = fakeArr();
      const xy = new XyPadStore();
      const file = Song.capture(bus, patterns, arr as never, 'XY', xy);
      file.xy = { x: 'filter.drive', y: 'fx.delay.mix' };

      const target = new XyPadStore();
      Song.apply(file, bus, patterns, arr as never, target);
      expect(target.get()).toEqual({ x: 'filter.drive', y: 'fx.delay.mix' });
    });

    it('apply() of a v1/v2 file (no xy) resets the store to defaults', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      const patterns = new PatternStore();
      const arr = fakeArr();
      const target = new XyPadStore();
      target.set({ x: 'lfo.rate', y: 'lfo.amount' }); // pre-existing assignment

      const v1 = demo(); // Zombie Nation, version 1
      delete v1.xy; // demos may carry an xy assignment; this test needs an xy-less file
      expect(v1.xy).toBeUndefined();
      Song.apply(v1, bus, patterns, arr as never, target);

      expect(target.get()).toEqual(XY_DEFAULT_ASSIGN);
    });

    it('the xy assignment round-trips through toJSON/fromJSON', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      const xy = new XyPadStore();
      xy.set({ x: 'lfo.rate', y: 'filter.cutoff' });
      const file = Song.capture(bus, new PatternStore(), fakeArr() as never, 'RT', xy);
      const parsed = Song.fromJSON(Song.toJSON(file));
      expect(parsed!.xy).toEqual({ x: 'lfo.rate', y: 'filter.cutoff' });
      expect(parsed).toEqual(compactSongForExport(file));
    });
  });

  describe('"I Feel Love" demo', () => {
    it('exists and round-trips through toJSON/fromJSON', () => {
      const ifl = DEMO_SONGS['I Feel Love'];
      expect(ifl).toBeDefined();
      const parsed = Song.fromJSON(Song.toJSON(ifl!));
      expect(parsed).toEqual(compactSongForExport(ifl!));
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
      expect(patterns.seqBanks[0]![0]![2]!.note).toBe(57);
      expect(arr.seq.enabled).toBe(true);
    });
  });

  describe('"Fat" drop-in demo', () => {
    it('is a v2 file and round-trips through toJSON/fromJSON', () => {
      const fat = DEMO_SONGS['Fat'];
      expect(fat).toBeDefined();
      expect(fat!.version).toBe(2);
      expect(Song.fromJSON(Song.toJSON(fat!))).toEqual(compactSongForExport(fat!));
    });

    it('applies its acid params and per-step settings', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      const patterns = new PatternStore();
      const arr = fakeArr();

      const fat = DEMO_SONGS['Fat']!;
      Song.apply(fat, bus, patterns, arr as never);

      expect(bus.get('transport.bpm')).toBe(127);
      expect(bus.get('voicing.mode')).toBe(0);             // mono 303
      // resonance is fine-tuned on every re-export, so assert it transferred
      // faithfully rather than pinning a float that drifts on each retune.
      expect(bus.get('filter.resonance')).toBe(fat.params['filter.resonance']);
      expect(bus.get('fx.drum.comp.ratio')).toBe(4);       // ALL buttons in
      expect(patterns.seqBanks[0]![0]![2]!.tie).toBe(true);    // acid slide
      expect(patterns.drumBanks[0]![3]![2]!.gate).toBeCloseTo(0.45); // choked open hat
      expect(patterns.drumBanks[0]![2]![1]!.prob).toBeCloseTo(0.35); // ghost hat
      expect(arr.seq.steps).toHaveLength(16);              // long chains
      expect(arr.drum.steps).toHaveLength(16);
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
      expect(keys.indexOf('Apex Twin')).toBeLessThan(keys.indexOf('Zombie Nation'));
      expect(Song.fromJSON(Song.toJSON(apex!))).toEqual(compactSongForExport(apex!));
    });

    it('applies its params + 8-step chains', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      const patterns = new PatternStore();
      const arr = fakeArr();

      Song.apply(DEMO_SONGS['Apex Twin']!, bus, patterns, arr as never);

      expect(bus.get('transport.bpm')).toBe(128);
      expect(patterns.seqBanks[0]![0]![0]!.note).toBe(45);
      expect(arr.seq.steps).toEqual([0, 0, 1, 0, 0, 2, 0, 3]);
      expect(arr.drum.steps).toEqual([0, 0, 1, 1, 2, 0, 1, 3]);
    });
  });
});

describe('Song — four sequencer tracks (sequencer.md REQ-13)', () => {
  const rig = () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    return { bus, patterns: new PatternStore() };
  };

  it('a one-track song omits seqTracks entirely, so it is unchanged from v5', () => {
    const { bus, patterns } = rig();
    patterns.setSeqStep(0, 0, { on: true, note: 60 });
    const file = Song.capture(bus, patterns, fakeArr() as never, 'One');
    expect(file.seqTracks).toBeUndefined();
    expect(file.seqBanks[0]![0]).toMatchObject({ on: true, note: 60 });
  });

  it('tracks 2-4 round-trip, with index 0 null (track 1 lives in seqBanks)', () => {
    const { bus, patterns } = rig();
    patterns.setSeqStep(0, 0, { on: true, note: 60 });
    patterns.setSeqStep(2, 5, { on: true, note: 67 });
    const file = Song.capture(bus, patterns, fakeArr() as never, 'Four');
    expect(file.version).toBe(6);
    expect(file.seqTracks![0]![0]).toBeNull();       // never duplicates track 1
    expect(file.seqTracks![0]![1]).toBeNull();       // empty track stays null
    expect(file.seqTracks![0]![2]![5]).toMatchObject({ on: true, note: 67 });

    const parsed = Song.fromJSON(Song.toJSON(file))!;
    const fresh = new PatternStore();
    Song.apply(parsed, bus, fresh, fakeArr() as never);
    expect(fresh.seqTrack(0)![0]).toMatchObject({ on: true, note: 60 });
    expect(fresh.seqTrack(2)![5]).toMatchObject({ on: true, note: 67 });
  });

  it('a v1-v5 file loads with three empty tracks and sounds identical', () => {
    const { bus, patterns } = rig();
    // Dirty the extra tracks first: the load must be authoritative about them.
    patterns.setSeqStep(3, 2, { on: true, note: 99 });
    const legacy = { ...demo(), version: 5 as const };
    Song.apply(legacy, bus, patterns, fakeArr() as never);
    expect(patterns.seqTrack(1)!.every((s) => !s.on)).toBe(true);
    expect(patterns.seqTrack(3)!.every((s) => !s.on)).toBe(true);
    expect(patterns.seqTrack(0)!.some((s) => s.on)).toBe(true);
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  Song, DEMO_SONGS, JSON_DEMOS, ZIP_DEMOS, demoNames, isDemoName, resolveDemoName,
  compareSongNames,
} from '../../src/state/song';
import { DROP_IN_DEMOS, DROP_IN_NAMES } from './demo-files';
import { fixtureSong, FIXTURE } from '../fixtures/song-fixture';
import type { SongFile } from '../../src/state/song';
import { compactSongForExport } from '../../src/state/serialize';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { PatternStore } from '../../src/state/patterns';
import { XyPadStore, XY_DEFAULT_ASSIGN } from '../../src/state/xy-pad';
import { fakeArrangement } from '../fixtures/fake-arrangement';
import { SONG_VERSION } from '../../src/state/song-version';
import {
  barTicks, DEFAULT_BAR_TICKS, DEFAULT_BEATS, DEFAULT_BEAT_UNIT, DEFAULT_LANE_RATE, LEN_FOLLOW,
} from '../../src/state/meter';

/**
 * The song these tests assert against — the suite's own, never a shipped demo
 * (tests/fixtures/song-fixture.ts explains why). Already a fresh deep copy, so
 * a test may mutate it freely.
 */
const demo = (): SongFile => fixtureSong();

/** Minimal Arrangement stand-in: only the surface Song.capture/apply touch. */
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
    expect(parsed!.name).toBe(FIXTURE.name);
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
      Song.apply(res.file, bus, new PatternStore(), fakeArrangement() as never);
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

  // `list()` carrying every demo name is covered derivably by
  // "Song.list with fetched demos" below, over the whole library rather than two
  // spelled names.

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
    // Any built-in: they are the bundled, synchronous ones loadSlot can return.
    const builtIn = Object.keys(DEMO_SONGS)[0]!;
    expect(Song.loadSlot(builtIn)?.name).toBe(builtIn);
  });

  it('apply() restores params + banks + both chain lanes into live state', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    const patterns = new PatternStore();
    const arr = fakeArrangement();
    const file = demo();

    Song.apply(file, bus, patterns, arr as never);

    expect(bus.get('transport.bpm')).toBe(FIXTURE.bpm);
    expect(bus.get('voicing.mode')).toBe(0);
    expect(arr.seq.enabled).toBe(true);
    expect(arr.seq.steps).toEqual([...FIXTURE.seqChain]);
    expect(arr.drum.steps).toEqual([...FIXTURE.drumChain]);
    // the fixture's first sounded note (step 0 is a rest)
    expect(patterns.seqBanks[0]![0]![FIXTURE.plainStep]!.note).toBe(FIXTURE.plainNote);
  });

  it('apply() resets params omitted from the snapshot back to their defaults', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    const patterns = new PatternStore();
    const arr = fakeArrangement();

    bus.set('fx.drum.delay.on', 1);                   // simulate a prior full snapshot
    Song.apply(demo(), bus, patterns, arr as never);  // the fixture omits the key

    expect(bus.get('fx.drum.delay.on')).toBe(0);      // back to registered default
  });

  it('apply() fires per-param subscribers (audio/UI repaint) but suppresses onChange (not an edit)', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    const patterns = new PatternStore();
    const arr = fakeArrangement();

    // A per-param subscriber stands in for BOTH an Engine audio applier and a
    // UI control: on load they repaint through this one `subscribe` channel.
    const bpmSeen: number[] = [];
    bus.subscribe('transport.bpm', (v) => bpmSeen.push(v)); // fires now with default 120
    // onChange is the global "an edit happened" signal (→ session.markDirty()).
    const edits: string[] = [];
    bus.onChange((id) => edits.push(id));

    Song.apply(demo(), bus, patterns, arr as never);

    // The per-param channel delivered the restored value, so audio + UI update…
    expect(bpmSeen).toContain(FIXTURE.bpm);
    // …but loading a song is NOT an edit, so the global onChange never fired.
    expect(edits).toEqual([]);
  });

  it('a chain REST slot round-trips through capture / toJSON / fromJSON / apply', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    const patterns = new PatternStore();
    const arr = fakeArrangement();
    arr.setDrumChain([0, -1, 1], true); // REST in the middle

    const file = Song.capture(bus, patterns, arr as never, 'Rest song');
    expect(file.drumChain).toEqual({ enabled: true, steps: [0, -1, 1] });

    // Survives serialization, and apply() (via set*Chain / clampChainStep) preserves it.
    const parsed = Song.fromJSON(Song.toJSON(file));
    expect(parsed!.drumChain.steps).toEqual([0, -1, 1]);
    const arr2 = fakeArrangement();
    Song.apply(parsed!, bus, new PatternStore(), arr2 as never);
    expect(arr2.drum.steps).toEqual([0, -1, 1]);
  });

  it('capture() snapshots params, banks and both chain lanes', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    bus.set('transport.bpm', 142);
    const patterns = new PatternStore();
    const arr = fakeArrangement();
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

    const file = Song.capture(bus, patterns, fakeArrangement() as never, 'Full');
    expect(file.drumBanks[0]![2]![5]!).toEqual(
      { on: true, velocity: 0.85, gate: 0.5, prob: 1, ratchet: 3, tie: false });
  });

  it('applying a legacy file (on/velocity drum cells) resets per-step settings to defaults', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    const patterns = new PatternStore();
    patterns.setDrumCell(0, 0, { gate: 0.25, ratchet: 4, tie: true }); // live edits to reset
    const arr = fakeArrangement();
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
      const arr = fakeArrangement();
      arr.setSamplerChain([2, 3], true);

      const file = Song.capture(bus, patterns, arr as never, 'S');
      expect(file.version).toBe(SONG_VERSION);
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
      const arr = fakeArrangement();
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
      const arr = fakeArrangement();
      const v1 = demo(); // the fixture is version 1, no sampler fields
      expect(v1.version).toBe(1);

      Song.apply(v1, bus, patterns, arr as never);

      // transpose rides along on every lane (one ChainLane type) and is always
      // sized to steps — all zeros here, i.e. a no-op, which is the only shape a
      // pre-v7 file can produce.
      expect(arr.sampler).toEqual({ enabled: false, steps: [0], transpose: [0] });
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
      const arr = fakeArrangement();

      // A previously-loaded song's live state: motion (an XY anchor, an assigned +
      // anchored extra track, and a per-bank axis override) AND sampler (cell + name).
      patterns.setMotionStep(0, { on: true, x: 0.5, y: 0.8 });
      patterns.setMotionTrackParam(0, 'fx.delay.mix');
      patterns.setMotionTrackStep(0, 3, { on: true, v: 0.7 });
      patterns.setMotionAssign({ x: 'lfo.rate', y: 'master.volume' });
      patterns.setSamplerCell(0, 5, { on: true });
      patterns.setSampleName(0, 'kept.wav');

      // Load the fixture (v1 — no motion AND no sampler fields) into the SAME store.
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
      return { bus, patterns, arr: fakeArrangement() };
    };

    it('evicts the buffer of every slot the incoming song renames', () => {
      const { bus, patterns, arr } = rig();
      const sampler = fakeSampler();

      const file = Song.capture(bus, new PatternStore(), fakeArrangement() as never, 'Other');
      file.sampleNames = ['snare.wav', 'kick.wav', null, null, null, null, null, null];

      Song.apply(file, bus, patterns, arr as never, undefined, sampler);

      // Slot 0 renamed → evicted. Slot 1 has the SAME name → its audio is kept,
      // so reloading a song you already have the samples for still just works.
      expect(sampler.cleared).toEqual([0]);
    });

    it('evicts a slot the incoming song leaves unnamed', () => {
      const { bus, patterns, arr } = rig();
      const sampler = fakeSampler();

      const file = Song.capture(bus, new PatternStore(), fakeArrangement() as never, 'Blank');
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
      const file = Song.capture(bus, new PatternStore(), fakeArrangement() as never, 'Blank');
      expect(() => Song.apply(file, bus, patterns, arr as never)).not.toThrow();
    });
  });

  describe('XY Pad (v3)', () => {
    it('capture() writes SONG_VERSION and the store\'s current axis assignment', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      const patterns = new PatternStore();
      const xy = new XyPadStore();
      xy.set({ x: 'lfo.rate', y: 'master.volume' });

      const file = Song.capture(bus, patterns, fakeArrangement() as never, 'XY', xy);
      expect(file.version).toBe(SONG_VERSION);
      expect(file.xy).toEqual({ x: 'lfo.rate', y: 'master.volume' });
    });

    it('capture() without a store still writes the default assignment (v3)', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      const file = Song.capture(bus, new PatternStore(), fakeArrangement() as never, 'XY');
      expect(file.version).toBe(SONG_VERSION);
      expect(file.xy).toEqual(XY_DEFAULT_ASSIGN);
    });

    it('apply() sets the XY store from the file', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      const patterns = new PatternStore();
      const arr = fakeArrangement();
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
      const arr = fakeArrangement();
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
      const file = Song.capture(bus, new PatternStore(), fakeArrangement() as never, 'RT', xy);
      const parsed = Song.fromJSON(Song.toJSON(file));
      expect(parsed!.xy).toEqual({ x: 'lfo.rate', y: 'filter.cutoff' });
      expect(parsed).toEqual(compactSongForExport(file));
    });
  });

  /**
   * The shipped demos, asserted **as a set**. Naming one here would make the
   * suite fail for a data edit that broke nothing (see
   * tests/fixtures/song-fixture.ts); everything a specific song used to pin —
   * per-step settings, long chains, v1 migration — is the fixture's job now.
   * These run over the whole library, so a new demo gains coverage for free.
   */
  describe('shipped demos', () => {
    /** Applying a file must restore every param it actually declares. */
    const appliesOwnContents = (file: SongFile): void => {
      const bus = new ParamBus();
      registerDefaults(bus);
      const patterns = new PatternStore();
      const arr = fakeArrangement();

      Song.apply(file, bus, patterns, arr as never);

      for (const [key, value] of Object.entries(file.params)) {
        expect(bus.get(key), `${file.name}: ${key}`).toBe(value);
      }
      expect(arr.seq.steps, `${file.name}: seq chain`).toEqual(file.seqChain.steps);
      expect(arr.drum.steps, `${file.name}: drum chain`).toEqual(file.drumChain.steps);
    };

    describe.each(Object.keys(DEMO_SONGS))('built-in: %s', (name) => {
      it('round-trips through toJSON/fromJSON', () => {
        const file = DEMO_SONGS[name]!;
        expect(Song.fromJSON(Song.toJSON(file))).toEqual(compactSongForExport(file));
      });

      it('applies its own declared params and chains', () => {
        appliesOwnContents(DEMO_SONGS[name]!);
      });
    });

    describe.each(DROP_IN_NAMES)('drop-in: %s', (name) => {
      it('round-trips through toJSON/fromJSON', () => {
        const file = DROP_IN_DEMOS[name]!;
        expect(Song.fromJSON(Song.toJSON(file))).toEqual(compactSongForExport(file));
      });

      it('applies its own declared params and chains', () => {
        appliesOwnContents(DROP_IN_DEMOS[name]!);
      });
    });

    // song-mode.md REQ-12 (v20). Stated over the whole library rather than
    // through spelled names — it holds however many demos exist. This replaced
    // "every drop-in ahead of every built-in": which of the three sources a demo
    // comes from is a loading detail, and it used to pin the project zips to the
    // end of the shelf.
    it('orders the shelf alphabetically, whatever source a demo comes from', () => {
      const names = demoNames();
      expect(names).toEqual([...names].sort(compareSongNames));
    });

    it('lists every demo from every source exactly once', () => {
      const names = demoNames();
      for (const n of [...DROP_IN_NAMES, ...Object.keys(DEMO_SONGS), ...ZIP_DEMOS.map((d) => d.name)]) {
        expect(names.filter((x) => x === n), n).toHaveLength(1);
      }
      expect(names).toHaveLength(
        DROP_IN_NAMES.length + Object.keys(DEMO_SONGS).length + ZIP_DEMOS.length,
      );
    });

    // The regression this change was made for: a zip demo sat last purely for
    // being a zip, which pushed it past DEMO_ROW_LIMIT into the "All Demos"
    // fold. Each zip must sit exactly where its *name* puts it.
    it('places each project zip by its name, not at the end', () => {
      const names = demoNames();
      for (const zip of ZIP_DEMOS) {
        const expected = [...names].sort(compareSongNames).indexOf(zip.name);
        expect(names.indexOf(zip.name), zip.name).toBe(expected);
      }
    });

    // song-mode.md REQ-11: the drop-ins are fetched on click, so their *names*
    // come from the generated index rather than from the files at build time.
    // A drifted index would silently mislabel every button.
    it('labels every drop-in by its song name, via the generated index', () => {
      // DROP_IN_NAMES, not Object.keys — object key order hoists the year-named
      // demos ahead of the rest, whatever order they registered in.
      expect(JSON_DEMOS.map((d) => d.name)).toEqual(DROP_IN_NAMES);
      for (const d of JSON_DEMOS) {
        expect(d.url, `${d.name} has no url`).toBeTruthy();
      }
    });

    // Relied on wherever a caller round-trips a built-in through its name — the
    // demo row's label, `loadSlot`, and e2e's pick-a-demo-by-kind helpers.
    it('keys every built-in by its own name', () => {
      for (const [key, file] of Object.entries(DEMO_SONGS)) {
        expect(file.name, `DEMO_SONGS['${key}']`).toBe(key);
      }
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
    const file = Song.capture(bus, patterns, fakeArrangement() as never, 'One');
    expect(file.seqTracks).toBeUndefined();
    expect(file.seqBanks[0]![0]).toMatchObject({ on: true, note: 60 });
  });

  it('tracks 2-4 round-trip, with index 0 null (track 1 lives in seqBanks)', () => {
    const { bus, patterns } = rig();
    patterns.setSeqStep(0, 0, { on: true, note: 60 });
    patterns.setSeqStep(2, 5, { on: true, note: 67 });
    const file = Song.capture(bus, patterns, fakeArrangement() as never, 'Four');
    expect(file.version).toBe(SONG_VERSION);
    expect(file.seqTracks![0]![0]).toBeNull();       // never duplicates track 1
    expect(file.seqTracks![0]![1]).toBeNull();       // empty track stays null
    expect(file.seqTracks![0]![2]![5]).toMatchObject({ on: true, note: 67 });

    const parsed = Song.fromJSON(Song.toJSON(file))!;
    const fresh = new PatternStore();
    Song.apply(parsed, bus, fresh, fakeArrangement() as never);
    expect(fresh.seqTrack(0)![0]).toMatchObject({ on: true, note: 60 });
    expect(fresh.seqTrack(2)![5]).toMatchObject({ on: true, note: 67 });
  });

  it('a v1-v5 file loads with three empty tracks and sounds identical', () => {
    const { bus, patterns } = rig();
    // Dirty the extra tracks first: the load must be authoritative about them.
    patterns.setSeqStep(3, 2, { on: true, note: 99 });
    const legacy = { ...demo(), version: 5 as const };
    Song.apply(legacy, bus, patterns, fakeArrangement() as never);
    expect(patterns.seqTrack(1)!.every((s) => !s.on)).toBe(true);
    expect(patterns.seqTrack(3)!.every((s) => !s.on)).toBe(true);
    expect(patterns.seqTrack(0)!.some((s) => s.on)).toBe(true);
  });
});

/**
 * song-mode.md REQ-12 — the drop-ins are fetched, not bundled, but they must not
 * disappear from the slot picker: they were selectable there before the change,
 * and `Song.list()` is what fills that dropdown.
 */
describe('Song.list with fetched demos', () => {
  it('lists every drop-in and built-in name, sorted, alongside stored slots', () => {
    const list = Song.list();
    for (const name of Object.keys(DROP_IN_DEMOS)) expect(list).toContain(name);
    for (const name of Object.keys(DEMO_SONGS)) expect(list).toContain(name);
    // The same comparator the demo row uses (song-mode.md REQ-12) — the picker
    // and the shelf must not disagree about where a name sits.
    expect(list).toEqual([...list].sort(compareSongNames));
  });

  it('loadSlot stays sync and returns only built-ins, never a fetched demo', () => {
    expect(Song.loadSlot(Object.keys(DEMO_SONGS)[0]!)).not.toBeNull();
    // A drop-in is listed but not loadable here — the Song panel's Load button
    // falls back to loadDemo for exactly this case.
    const dropIn = DROP_IN_NAMES[0]!;
    expect(Song.loadSlot(dropIn)).toBeNull();
    expect(Song.list()).toContain(dropIn);
  });
});

/**
 * song-mode.md REQ-12 (v18). Demo names are *data* — `src/state/demos/` is a
 * drop-in directory — but callers name one: the tour applies `DEMO_FOR_TOUR` by
 * string constant. `loadDemo` used to return silently for a name no source
 * owned, so renaming that one file turned the tour's headline step into a no-op
 * and the step after it into narration over silence.
 */
describe('demo name resolution', () => {
  const NOT_A_DEMO = 'no demo is called this — zzz';

  it('recognises every name the three sources own, and nothing else', () => {
    for (const name of demoNames()) expect(isDemoName(name), name).toBe(true);
    expect(isDemoName(NOT_A_DEMO)).toBe(false);
  });

  it('resolves a known name to itself', () => {
    for (const name of demoNames()) expect(resolveDemoName(name)).toBe(name);
  });

  it('resolves an unknown name to the first demo, never to undefined', () => {
    expect(resolveDemoName(NOT_A_DEMO)).toBe(demoNames()[0]);
    expect(resolveDemoName(NOT_A_DEMO)).toBeDefined();
  });
});

describe('Song — meter back-compat (meter.md REQ-19)', () => {
  it('loads a pre-meter file as 4/4, with every lane following the bar', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    // Dirty the session first: apply() must be authoritative, not inheriting.
    bus.set('transport.beats', 7);
    bus.set('transport.beatUnit', 1);
    bus.set('drum.len', 12);
    bus.set('seq.rate', 0);

    Song.apply(demo(), bus, new PatternStore(), fakeArrangement() as never);

    expect(bus.get('transport.beats')).toBe(DEFAULT_BEATS);
    expect(bus.get('transport.beatUnit')).toBe(DEFAULT_BEAT_UNIT);
    expect(barTicks(bus.get('transport.beats'), bus.get('transport.beatUnit')))
      .toBe(DEFAULT_BAR_TICKS);
    for (const id of ['seq.len', 'drum.len', 'sampler.len', 'motion.len']) {
      expect(bus.get(id), id).toBe(LEN_FOLLOW);
    }
    for (const id of ['seq.rate', 'drum.rate', 'sampler.rate', 'motion.rate']) {
      expect(bus.get(id), id).toBe(DEFAULT_LANE_RATE);
    }
  });

  it('carries the meter in `params`, so the format version never moves', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    const patterns = new PatternStore();
    const arr = fakeArrangement();
    bus.set('transport.beats', 7);
    bus.set('transport.beatUnit', 1);

    const file = compactSongForExport(Song.capture(bus, patterns, arr as never, 'Seven'));
    // The meter is ten scalars in the open `params` map — no new top-level key,
    // no schema change, and so no version bump (ADR-007, meter.md REQ-19).
    expect(file.params!['transport.beats']).toBe(7);
    expect(file.params!['transport.beatUnit']).toBe(1);
    expect(Object.keys(file)).not.toContain('meter');
    expect(file.version).toBe(SONG_VERSION);
    expect(Song.fromJSON(Song.toJSON(file))!.version).toBe(SONG_VERSION);
  });

  it('round-trips a 7/8 song with a polyrhythmic drum lane', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    const patterns = new PatternStore();
    const arr = fakeArrangement();
    bus.set('transport.beats', 7);
    bus.set('transport.beatUnit', 1);
    bus.set('drum.len', 12);
    bus.set('drum.rate', 0);

    const file = Song.capture(bus, patterns, arr as never, 'Seven Eight');
    const parsed = Song.fromJSON(Song.toJSON(compactSongForExport(file)))!;
    const bus2 = new ParamBus();
    registerDefaults(bus2);
    Song.apply(parsed, bus2, new PatternStore(), fakeArrangement() as never);

    expect(barTicks(bus2.get('transport.beats'), bus2.get('transport.beatUnit'))).toBe(14);
    expect(bus2.get('drum.len')).toBe(12);
    expect(bus2.get('drum.rate')).toBe(0);
  });
});

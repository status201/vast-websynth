import { describe, it, expect, beforeEach } from 'vitest';
import { Presets } from '../../src/state/preset';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { installLocalStorageMock } from '../storage-mock';

const PREFIX = 'websynth.preset.';
const INDEX_KEY = 'websynth.preset.index';
const FACTORY_NAMES = [
  'acid', 'b3', 'basic', 'bass', 'bells', 'brass', 'ember', 'lead', 'pad',
  'pbass', 'piano', 'pluck', 'prism', 'reese', 'rhodes', 'solina', 'upright',
  'vellum', 'wobble',
];

describe('Presets', () => {
  beforeEach(() => {
    installLocalStorageMock();
  });

  describe('factory()', () => {
    it('exposes every built-in bank', () => {
      const f = Presets.factory();
      expect(Object.keys(f).sort()).toEqual(FACTORY_NAMES);
    });

    it('each bank carries the core synth params', () => {
      for (const snap of Object.values(Presets.factory())) {
        expect(snap['filter.cutoff']).toBeTypeOf('number');
        expect(snap['master.volume']).toBeTypeOf('number');
      }
    });

    // A typo'd id would be stored but silently do nothing; an out-of-range
    // value would be clamped, so the patch would not sound as authored.
    it('uses only registered param ids, with in-range values', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      for (const [name, snap] of Object.entries(Presets.factory())) {
        for (const [id, value] of Object.entries(snap)) {
          expect(bus.def(id), `${name}: unknown param '${id}'`).toBeDefined();
          bus.set(id, value);
          expect(bus.get(id), `${name}: '${id}' value ${value} clamped`).toBe(value);
        }
      }
    });

    // Factory presets set the FULL sound (REQ-2b), so a param missing from one
    // of them leaks the previous patch's value on a preset change. The filter
    // model is the loudest possible instance of that bug: load a LADDER patch
    // after a POLY one and it would keep the wrong filter.
    it('sets the filter model, shape and keytrack in every bank', () => {
      for (const [name, snap] of Object.entries(Presets.factory())) {
        for (const id of ['filter.model', 'filter.shape', 'filter.keytrack']) {
          expect(snap[id], `${name}: '${id}' missing`).toBeTypeOf('number');
        }
      }
    });

    it('names at least one bank per filter model', () => {
      const models = new Set(Object.values(Presets.factory()).map((s) => s['filter.model']));
      expect(models).toContain(0); // LADDER
      expect(models).toContain(1); // POLY
    });
  });

  // ADR-006: presets are ParamBus snapshots that simply omit params they never
  // knew about, so a no-op default is the whole back-compat story.
  describe('params added after a preset was saved', () => {
    const legacy = () => {
      const snap = { ...Presets.factory()['basic']! };
      delete snap['filter.model'];
      delete snap['filter.shape'];
      delete snap['filter.keytrack'];
      return snap;
    };

    it('leave an older preset on the ladder, sounding unchanged', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      Presets.apply(bus, legacy());

      // Nothing in the file to restore them from, so they sit at their
      // registered defaults — which must reproduce the pre-existing sound, not
      // a "sensible" new one.
      expect(bus.get('filter.model')).toBe(0);
      expect(bus.get('filter.shape')).toBe(0);
      expect(bus.get('filter.keytrack')).toBe(0);
    });

    // `restore` writes only the ids the snapshot carries — it does not reset
    // the rest — so a preset that omits a param inherits whatever was loaded
    // before it. That is exactly why every FACTORY bank sets the full sound
    // (REQ-2b); this pins the failure mode that rule exists to prevent.
    it('would otherwise leak the previous patch, which is why factory banks set them', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      bus.set('filter.model', 1); // a POLY patch was loaded first

      Presets.apply(bus, legacy());
      expect(bus.get('filter.model')).toBe(1); // leaked — the file said nothing

      Presets.apply(bus, Presets.factory()['basic']!);
      expect(bus.get('filter.model')).toBe(0); // a real factory bank sets it
    });
  });

  describe('list()', () => {
    it('returns the factory names sorted when nothing is stored', () => {
      expect(Presets.list()).toEqual(FACTORY_NAMES);
    });

    it('merges the stored index with factory names, deduped and sorted', () => {
      localStorage.setItem(INDEX_KEY, JSON.stringify(['zed', 'basic', 'alpha']));
      expect(Presets.list()).toEqual(['alpha', 'zed', ...FACTORY_NAMES].sort());
    });

    it('survives a corrupt index key', () => {
      localStorage.setItem(INDEX_KEY, '{not json');
      expect(Presets.list()).toEqual(FACTORY_NAMES);
    });
  });

  describe('ensureFactoryPresets()', () => {
    it('seeds storage entries and the index for every factory bank', () => {
      Presets.ensureFactoryPresets();
      for (const name of Object.keys(Presets.factory())) {
        expect(localStorage.getItem(PREFIX + name)).not.toBeNull();
      }
      const index = JSON.parse(localStorage.getItem(INDEX_KEY)!) as string[];
      expect(index.sort()).toEqual(FACTORY_NAMES);
    });

    it('does not overwrite a customised factory entry', () => {
      localStorage.setItem(PREFIX + 'bass', JSON.stringify({ 'filter.cutoff': 1 }));
      Presets.ensureFactoryPresets();
      expect(JSON.parse(localStorage.getItem(PREFIX + 'bass')!)).toEqual({ 'filter.cutoff': 1 });
    });

    it('is idempotent — a second call adds nothing new', () => {
      Presets.ensureFactoryPresets();
      const after1 = localStorage.getItem(INDEX_KEY);
      Presets.ensureFactoryPresets();
      expect(localStorage.getItem(INDEX_KEY)).toBe(after1);
    });
  });

  describe('save() / load()', () => {
    it('round-trips a saved snapshot and indexes its name', () => {
      Presets.save('mine', { 'filter.cutoff': 70, 'master.volume': 0.5 });
      expect(Presets.load('mine')).toEqual({ 'filter.cutoff': 70, 'master.volume': 0.5 });
      const index = JSON.parse(localStorage.getItem(INDEX_KEY)!) as string[];
      expect(index).toContain('mine');
    });

    it('does not duplicate an existing name in the index', () => {
      Presets.save('mine', { 'filter.cutoff': 70 });
      Presets.save('mine', { 'filter.cutoff': 80 });
      const index = JSON.parse(localStorage.getItem(INDEX_KEY)!) as string[];
      expect(index.filter((n) => n === 'mine')).toHaveLength(1);
    });

    it('falls back to the factory snapshot when a factory name is not stored', () => {
      expect(Presets.load('bass')).toEqual(Presets.factory()['bass']);
    });

    it('returns null for an unknown, unstored name', () => {
      expect(Presets.load('nope')).toBeNull();
    });

    it('returns null when the stored JSON is malformed', () => {
      localStorage.setItem(PREFIX + 'broken', '{bad json');
      expect(Presets.load('broken')).toBeNull();
    });
  });

  describe('capture() / apply()', () => {
    it('capture delegates to bus.snapshot', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      bus.set('filter.cutoff', 77);
      const snap = Presets.capture(bus);
      expect(snap['filter.cutoff']).toBe(77);
    });

    it('apply restores a snapshot onto the bus', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      Presets.apply(bus, { 'filter.cutoff': 60, 'master.volume': 0.3 });
      expect(bus.get('filter.cutoff')).toBe(60);
      expect(bus.get('master.volume')).toBe(0.3);
    });

    it('after apply, reset() returns a param to the preset value', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      Presets.apply(bus, { 'filter.cutoff': 60 });
      bus.set('filter.cutoff', 110); // user drags the knob
      bus.reset('filter.cutoff');    // double-tap
      expect(bus.get('filter.cutoff')).toBe(60);
    });

    it('a param the preset omits resets to the global default, not the preset', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      const def = bus.def('transport.bpm')!.default;
      Presets.apply(bus, { 'filter.cutoff': 60 }); // no transport.bpm
      bus.set('transport.bpm', 200);
      bus.reset('transport.bpm');
      expect(bus.get('transport.bpm')).toBe(def);
    });
  });
});

describe('Presets.modified() / entries() (presets.md REQ-8)', () => {
  beforeEach(() => {
    installLocalStorageMock();
  });

  it('an untouched factory install has nothing modified', () => {
    Presets.ensureFactoryPresets();
    expect(Presets.modified()).toEqual([]);
  });

  it('counts a user-made preset', () => {
    Presets.ensureFactoryPresets();
    Presets.save('MyLead', { 'filter.cutoff': 90 });
    expect(Presets.modified()).toEqual(['MyLead']);
  });

  it('counts an edited factory preset, and stops counting it once restored', () => {
    Presets.ensureFactoryPresets();
    const original = Presets.factory()['bass']!;
    Presets.save('bass', { ...original, 'filter.cutoff': 33 });
    expect(Presets.modified()).toContain('bass');

    Presets.save('bass', original);
    expect(Presets.modified()).not.toContain('bass');
  });

  it('is derived, not tracked — re-saving identical values is not a modification', () => {
    Presets.ensureFactoryPresets();
    Presets.save('pad', Presets.factory()['pad']!);
    expect(Presets.modified()).toEqual([]);
  });

  it('entries() returns snapshots for the named presets and skips unknown names', () => {
    Presets.ensureFactoryPresets();
    Presets.save('MyLead', { 'filter.cutoff': 90 });
    const out = Presets.entries(['MyLead', 'nope']);
    expect(Object.keys(out)).toEqual(['MyLead']);
    expect(out['MyLead']).toEqual({ 'filter.cutoff': 90 });
  });

  it('a bank export of the modified set carries exactly what the user made', () => {
    Presets.ensureFactoryPresets();
    Presets.save('MyLead', { 'filter.cutoff': 90 });
    Presets.save('bass', { ...Presets.factory()['bass']!, 'filter.drive': 2.9 });
    expect(Object.keys(Presets.entries(Presets.modified())).sort()).toEqual(['MyLead', 'bass']);
  });
});

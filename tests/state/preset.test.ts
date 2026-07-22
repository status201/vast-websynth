import { describe, it, expect, beforeEach } from 'vitest';
import { Presets } from '../../src/state/preset';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { installLocalStorageMock } from '../storage-mock';

const PREFIX = 'websynth.preset.';
const INDEX_KEY = 'websynth.preset.index';
const FACTORY_NAMES = [
  'acid', 'b3', 'basic', 'bass', 'bells', 'brass', 'lead', 'pad', 'pbass',
  'piano', 'pluck', 'reese', 'rhodes', 'solina', 'upright', 'wobble',
];

describe('Presets', () => {
  beforeEach(() => {
    installLocalStorageMock();
  });

  describe('factory()', () => {
    it('exposes the sixteen built-in banks', () => {
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

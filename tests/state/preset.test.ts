import { describe, it, expect, beforeEach } from 'vitest';
import { Presets } from '../../src/state/preset';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { installLocalStorageMock } from '../storage-mock';
import { MOD_ROWS, MOD_SRC, MOD_DST } from '../../src/state/mod-routing';

const PREFIX = 'websynth.preset.';
const INDEX_KEY = 'websynth.preset.index';
const FACTORY_NAMES = [
  'acid', 'b3', 'basic', 'bass', 'bells', 'brass', 'chime', 'clang', 'ember',
  'growl', 'lead', 'pad', 'pbass', 'piano', 'pluck', 'prism', 'reese', 'rhodes',
  'solina', 'tear', 'tines', 'upright', 'vellum', 'wobble',
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

    // Factory presets set the FULL sound (REQ-a-factory-preset-sets-the-full-sound), so a bank file says
    // everything it means. Before presets.md v15's loader reset, a param missing
    // from one leaked the previous patch's value: load a LADDER patch after a POLY
    // one and it kept the wrong filter.
    it('sets the filter model, shape and keytrack in every bank', () => {
      for (const [name, snap] of Object.entries(Presets.factory())) {
        for (const id of ['filter.model', 'filter.shape', 'filter.keytrack']) {
          expect(snap[id], `${name}: '${id}' missing`).toBeTypeOf('number');
        }
      }
    });

    // Same rule, the instance that actually slipped twice: `lfo.sync` shipped
    // in lfo v6 and never reached the banks, and `lfo2.*` would have repeated
    // it, when Presets.apply did not yet reset what a preset omits (presets.md
    // REQ-a-factory-preset-sets-the-full-sound, REQ-loading-a-preset-starts-from-the-default-sound).
    it('sets every param of both LFOs in every bank', () => {
      const ids = ['lfo', 'lfo2'].flatMap((p) =>
        ['rate', 'amount', 'wave', 'dest', 'sync'].map((k) => `${p}.${k}`));
      for (const [name, snap] of Object.entries(Presets.factory())) {
        for (const id of ids) {
          expect(snap[id], `${name}: '${id}' missing`).toBeTypeOf('number');
        }
      }
    });

    // The rule the two tests above are instances of, stated once. Every synth
    // FX `.on` is pinned unconditionally — the comment below has claimed this
    // was the convention since the tempo-lock work, but nothing enforced it, so
    // `fx.duck.on` was absent from all nineteen banks the day it shipped
    // (sidechain-ducking.md REQ-a-bypassed-ducker-costs-nothing, presets.md REQ-a-factory-preset-sets-the-full-sound).
    it('sets every synth-FX on flag in every bank', () => {
      for (const [name, snap] of Object.entries(Presets.factory())) {
        for (const fx of ['eq', 'dist', 'wah', 'phaser', 'delay', 'reverb', 'duck']) {
          expect(snap[`fx.${fx}.on`], `${name}: 'fx.${fx}.on' missing`).toBeTypeOf('number');
        }
      }
    });

    // The same rule for the FX tempo locks (tempo-lock.md REQ-sync-defaults-to-free). Scoped to the
    // banks that ENGAGE the effect, which is the existing convention here: a
    // bypassed effect's sub-params are inert, so only `fx.<name>.on` is pinned
    // unconditionally. An engaged one with no `.sync` would inherit whatever
    // division the previously loaded patch was locked to.
    it('sets the tempo lock of every effect it engages, in every bank', () => {
      for (const [name, snap] of Object.entries(Presets.factory())) {
        for (const fx of ['wah', 'phaser', 'delay']) {
          if (snap[`fx.${fx}.on`] !== 1) continue;
          expect(snap[`fx.${fx}.sync`], `${name}: 'fx.${fx}.sync' missing`).toBeTypeOf('number');
        }
      }
    });

    // v14 (presets.md REQ-a-factory-preset-sets-the-full-sound): the same rule for the oscillators'
    // cross-modulation, sync and pulse widths, and the mod matrix — a showcase that
    // routes the filter envelope to `fm` would otherwise leave the route playing
    // under the next preset. Every row's source is pinned unconditionally; a row
    // that is ON pins what it routes, and a bank that engages sync pins its pitch.
    it('sets the oscillators\' cross-mod, sync, widths and every mod row in every bank', () => {
      const ids = [
        'osc1.fm', 'osc1.ring', 'osc2.sync', 'osc1.pulseWidth', 'osc2.pulseWidth',
        ...Array.from({ length: MOD_ROWS }, (_, n) => `mod.${n}.src`),
      ];
      for (const [name, snap] of Object.entries(Presets.factory())) {
        for (const id of ids) expect(snap[id], `${name}: '${id}' missing`).toBeTypeOf('number');
        if (snap['osc2.sync'] !== 0) {
          expect(snap['osc2.syncPitch'], `${name}: 'osc2.syncPitch' missing`).toBeTypeOf('number');
        }
        for (let n = 0; n < MOD_ROWS; n++) {
          if (snap[`mod.${n}.src`] === MOD_SRC.off) continue;
          for (const k of ['dst', 'amt']) {
            expect(snap[`mod.${n}.${k}`], `${name}: 'mod.${n}.${k}' missing`).toBeTypeOf('number');
          }
        }
      }
    });

    // The showcases (REQ-factory-presets-span-the-instrument-families, v14): each one
    // actually engages what it is there to show, so a later edit cannot quietly
    // turn one into a plain patch.
    it('the cross-mod and sync showcases engage what they show', () => {
      const f = Presets.factory();
      const routesTo = (name: string, dst: number) => Array.from({ length: MOD_ROWS }, (_, n) => n)
        .some((n) => f[name]![`mod.${n}.src`] !== MOD_SRC.off && f[name]![`mod.${n}.dst`] === dst);
      for (const name of ['tines', 'chime', 'growl']) {
        expect(f[name]!['osc1.fm'], name).toBeGreaterThan(0);
        expect(routesTo(name, MOD_DST.fm), `${name} routes to fm`).toBe(true);
      }
      expect(f['clang']!['osc1.ring']).toBeGreaterThan(0);
      expect(f['tear']!['osc2.sync']).toBe(1);
      expect(routesTo('tear', MOD_DST.sync), 'tear routes to sync').toBe(true);
    });

    it('loading a plain bank after a showcase leaves no FM or route behind', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      Presets.apply(bus, Presets.factory()['tines']!);
      expect(bus.get('osc1.fm')).toBeGreaterThan(0);
      Presets.apply(bus, Presets.factory()['basic']!);
      expect(bus.get('osc1.fm')).toBe(0);
      for (let n = 0; n < MOD_ROWS; n++) expect(bus.get(`mod.${n}.src`)).toBe(MOD_SRC.off);
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

    // presets.md REQ-loading-a-preset-starts-from-the-default-sound (v15). `restore` writes only the ids a
    // snapshot carries, so before v15 a preset that omitted a param inherited the
    // previous patch's value — a POLY filter, or `tines`' FM and its route. The
    // load now starts every omitted sound param from its no-op default, which is
    // how the preset sounded when it was saved.
    it('an older preset no longer inherits the previous patch', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      bus.set('filter.model', 1); // a POLY patch was loaded first
      Presets.apply(bus, legacy());
      expect(bus.get('filter.model')).toBe(0);

      Presets.apply(bus, Presets.factory()['tines']!);
      expect(bus.get('osc1.fm')).toBeGreaterThan(0);
      const older = { ...legacy() };
      for (const id of Object.keys(older)) {
        if (id.startsWith('osc1.fm') || id.startsWith('osc1.ring') || id.startsWith('mod.')) delete older[id];
      }
      Presets.apply(bus, older);
      expect(bus.get('osc1.fm')).toBe(0);
      for (let n = 0; n < MOD_ROWS; n++) expect(bus.get(`mod.${n}.src`)).toBe(MOD_SRC.off);
    });

    it('leaves the key and the master compressor where they are', () => {
      const bus = new ParamBus();
      registerDefaults(bus);
      bus.set('scale.root', 2);
      bus.set('scale.type', 2);
      bus.set('chord.voicing', 1);
      bus.set('fx.master.comp.makeup', 6);
      Presets.apply(bus, Presets.factory()['lead']!);
      expect(bus.get('scale.root')).toBe(2);
      expect(bus.get('scale.type')).toBe(2);
      expect(bus.get('chord.voicing')).toBe(1);
      expect(bus.get('fx.master.comp.makeup')).toBe(6);
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

    // presets.md REQ-an-older-factory-seed-is-refreshed: a stored slot that is the current bank
    // minus its newer keys is an older release's seed, so it is brought up to date;
    // one that differs on any value is somebody's sound and is kept.
    it('refreshes an older seed, and keeps an edit', () => {
      const basic = Presets.factory()['basic']!;
      const older = { ...basic };
      delete older['osc1.fm'];
      delete older['mod.0.src'];
      localStorage.setItem(PREFIX + 'basic', JSON.stringify(older));
      const edited = { ...Presets.factory()['lead']!, 'filter.cutoff': 42 };
      delete edited['osc1.fm'];
      localStorage.setItem(PREFIX + 'lead', JSON.stringify(edited));

      Presets.ensureFactoryPresets();
      expect(Presets.load('basic')).toEqual(basic);
      expect(Presets.modified()).not.toContain('basic');
      expect(Presets.load('lead')!['filter.cutoff']).toBe(42);
      expect(Presets.modified()).toContain('lead');
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

describe('Presets.modified() / entries() (presets.md REQ-modified-is-computed-not-tracked)', () => {
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

// presets.md REQ-a-stored-preset-can-be-deleted.
describe('Presets.remove', () => {
  beforeEach(() => {
    installLocalStorageMock();
    Presets.ensureFactoryPresets();
  });

  it('deletes a user preset outright', () => {
    Presets.save('Mine', { 'filter.cutoff': 50 });
    expect(Presets.list()).toContain('Mine');
    Presets.remove('Mine');
    expect(Presets.list()).not.toContain('Mine');
    expect(Presets.load('Mine')).toBeNull();
  });

  it('reverts an edited factory preset to its factory sound', () => {
    const name = Object.keys(Presets.factory())[0]!;
    const factory = Presets.factory()[name]!;
    Presets.save(name, { ...factory, 'filter.cutoff': 12.5 });
    expect(Presets.modified()).toContain(name);
    Presets.remove(name);
    expect(Presets.list()).toContain(name);
    expect(Presets.load(name)).toEqual(factory);
    expect(Presets.modified()).not.toContain(name);
    expect(Presets.isFactory(name)).toBe(true);
    expect(Presets.isFactory('Mine')).toBe(false);
  });
});

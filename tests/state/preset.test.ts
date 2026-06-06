import { describe, it, expect, beforeEach } from 'vitest';
import { Presets } from '../../src/state/preset';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { installLocalStorageMock } from '../storage-mock';

const PREFIX = 'websynth.preset.';
const INDEX_KEY = 'websynth.preset.index';

describe('Presets', () => {
  beforeEach(() => {
    installLocalStorageMock();
  });

  describe('factory()', () => {
    it('exposes the six built-in banks', () => {
      const f = Presets.factory();
      expect(Object.keys(f).sort()).toEqual(['basic', 'bass', 'lead', 'pad', 'pluck', 'wobble']);
    });

    it('each bank carries the core synth params', () => {
      for (const snap of Object.values(Presets.factory())) {
        expect(snap['filter.cutoff']).toBeTypeOf('number');
        expect(snap['master.volume']).toBeTypeOf('number');
      }
    });
  });

  describe('list()', () => {
    it('returns the factory names sorted when nothing is stored', () => {
      expect(Presets.list()).toEqual(['basic', 'bass', 'lead', 'pad', 'pluck', 'wobble']);
    });

    it('merges the stored index with factory names, deduped and sorted', () => {
      localStorage.setItem(INDEX_KEY, JSON.stringify(['zed', 'basic', 'alpha']));
      expect(Presets.list()).toEqual(['alpha', 'basic', 'bass', 'lead', 'pad', 'pluck', 'wobble', 'zed']);
    });

    it('survives a corrupt index key', () => {
      localStorage.setItem(INDEX_KEY, '{not json');
      expect(Presets.list()).toEqual(['basic', 'bass', 'lead', 'pad', 'pluck', 'wobble']);
    });
  });

  describe('ensureFactoryPresets()', () => {
    it('seeds storage entries and the index for every factory bank', () => {
      Presets.ensureFactoryPresets();
      for (const name of Object.keys(Presets.factory())) {
        expect(localStorage.getItem(PREFIX + name)).not.toBeNull();
      }
      const index = JSON.parse(localStorage.getItem(INDEX_KEY)!) as string[];
      expect(index.sort()).toEqual(['basic', 'bass', 'lead', 'pad', 'pluck', 'wobble']);
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
  });
});

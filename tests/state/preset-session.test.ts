import { describe, it, expect } from 'vitest';
import { PresetSession, isPatchParam, patchSnapshot } from '../../src/state/preset-session';

describe('PresetSession', () => {
  it('formats display with a dirty marker once edited', () => {
    const s = new PresetSession();
    s.setActive('basic');
    expect(s.display).toBe('basic');
    s.markDirty();
    expect(s.dirty).toBe(true);
    expect(s.display).toBe('basic *');
  });

  it('setActive clears the dirty flag', () => {
    const s = new PresetSession();
    s.setActive('basic');
    s.markDirty();
    s.setActive('pad');
    expect(s.dirty).toBe(false);
    expect(s.display).toBe('pad');
  });

  it('markDirty is idempotent and emits only on the first call', () => {
    const s = new PresetSession();
    s.setActive('basic');
    let emits = 0;
    s.subscribe(() => emits++); // immediate: 1
    s.markDirty();
    s.markDirty();
    s.markDirty();
    expect(emits).toBe(2); // immediate + one dirty transition
  });

  it('subscribe fires immediately and on every active/dirty change; unsubscribe stops it', () => {
    const s = new PresetSession();
    s.setActive('basic');
    const seen: string[] = [];
    const off = s.subscribe(() => seen.push(s.display));
    s.markDirty();
    s.setActive('pad');
    off();
    s.markDirty();
    expect(seen).toEqual(['basic', 'basic *', 'pad']);
  });

  it('display falls back to empty before any preset is set', () => {
    const s = new PresetSession();
    expect(s.display).toBe('');
    s.markDirty(); // no label yet → no spurious " *"
    expect(s.display).toBe('');
  });
});

// presets.md REQ-13 — a loaded song's sound stays selectable while presets are
// auditioned against it.
describe('PresetSession.songSound', () => {
  it('starts unpinned', () => {
    expect(new PresetSession().songSound).toBeNull();
  });

  it('setActiveSong pins the patch and labels the selector, clean', () => {
    const s = new PresetSession();
    s.setActive('basic');
    s.markDirty();
    s.setActiveSong('A Test Song', { 'filter.cutoff': 61 });
    expect(s.songSound).toEqual({ name: 'A Test Song', patch: { 'filter.cutoff': 61 } });
    expect(s.display).toBe('A Test Song');
    expect(s.dirty).toBe(false);
  });

  it('selecting a preset does not unpin the song being compared against', () => {
    const s = new PresetSession();
    s.setActiveSong('A Test Song', { 'filter.cutoff': 61 });
    s.setActive('lead');
    expect(s.display).toBe('lead');
    expect(s.songSound?.name).toBe('A Test Song'); // still reachable — the point of REQ-13
  });

  it('a second song replaces the pin rather than accumulating history', () => {
    const s = new PresetSession();
    s.setActiveSong('A Test Song', { 'filter.cutoff': 61 });
    s.setActiveSong('Another Test Song', { 'filter.cutoff': 80 });
    expect(s.songSound).toEqual({ name: 'Another Test Song', patch: { 'filter.cutoff': 80 } });
  });

  it('emits so the selector can rebuild its options', () => {
    const s = new PresetSession();
    const seen: (string | null)[] = [];
    s.subscribe(() => seen.push(s.songSound?.name ?? null));
    s.setActiveSong('A Test Song', {});
    expect(seen).toEqual([null, 'A Test Song']);
  });
});

describe('patchSnapshot', () => {
  it('keeps the patch and drops the song-level machines', () => {
    const snap = {
      'filter.cutoff': 61, 'osc1.wave': 2, 'fx.reverb.mix': 0.3, 'master.volume': 0.8,
      'transport.bpm': 138, 'drum.t0.pan': -0.3, 'seq.on': 1, 'fx.drum.delay.on': 1,
      'master.modWheel': 0.5,
    };
    expect(patchSnapshot(snap)).toEqual({
      'filter.cutoff': 61, 'osc1.wave': 2, 'fx.reverb.mix': 0.3, 'master.volume': 0.8,
    });
  });

  it('agrees with isPatchParam id for id, so the marker and the pin cannot diverge', () => {
    const snap = { 'filter.cutoff': 61, 'transport.bpm': 138, 'lfo.rate': 4, 'arp.on': 1 };
    for (const id of Object.keys(snap)) {
      expect(id in patchSnapshot(snap), id).toBe(isPatchParam(id));
    }
  });

  it('does not mutate or alias its input', () => {
    const snap = { 'filter.cutoff': 61, 'transport.bpm': 138 };
    const out = patchSnapshot(snap);
    out['filter.cutoff'] = 99;
    expect(snap['filter.cutoff']).toBe(61);
    expect(snap['transport.bpm']).toBe(138);
  });
});

describe('isPatchParam', () => {
  it('treats synth voice + synth FX + master volume as patch edits', () => {
    for (const id of [
      'osc1.wave', 'sub.level', 'unison.voices', 'analog.drift', 'mixer.glide',
      'voicing.mode', 'filter.cutoff', 'env.amp.attack', 'lfo.rate',
      'fx.dist.on', 'fx.reverb.mix', 'master.volume',
    ]) {
      expect(isPatchParam(id), id).toBe(true);
    }
  });

  it('excludes song-level machines and transient performance params', () => {
    for (const id of [
      'transport.bpm', 'arp.on', 'seq.on', 'drum.t0.vol', 'sampler.master',
      'fx.drum.delay.on', 'fx.sampler.reverb.mix',
      'master.pitchBend', 'master.modWheel', 'fx.djfilter', 'keyboard.transpose',
    ]) {
      expect(isPatchParam(id), id).toBe(false);
    }
  });

  it('excludes the motion sequencer, so a preset cannot switch it off (meter.md REQ-13)', () => {
    // `motion.` was missing from the prefix list: loading a sound reapplied
    // `motion.on` = 0 from the patch defaults and silently killed a song's
    // automation. It is a song-level machine like seq/drum/sampler.
    for (const id of ['motion.on', 'motion.mute', 'motion.slide', 'motion.t0.slide',
      'motion.len', 'motion.rate']) {
      expect(isPatchParam(id), id).toBe(false);
    }
  });

  it('excludes every meter param, so a preset cannot change the meter (meter.md REQ-5)', () => {
    for (const id of ['transport.beats', 'transport.beatUnit',
      'seq.len', 'seq.rate', 'drum.len', 'drum.rate', 'sampler.len', 'sampler.rate']) {
      expect(isPatchParam(id), id).toBe(false);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { PresetSession, isPatchParam } from '../../src/state/preset-session';

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
});

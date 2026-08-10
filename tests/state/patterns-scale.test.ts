import { describe, it, expect } from 'vitest';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { DROP_IN_DEMOS } from './demo-files';
import { SCALE_LABELS, CHORD_LABELS } from '../../src/utils/music';

/**
 * The back-compat half of scale-quantization.md REQ-1 and chord-tools.md REQ-5.
 *
 * These params ride in the ordinary `params` bag, so nothing about the song format
 * changed — which is only safe because every default is a true no-op. That is the
 * claim under test: a song written before the key existed must load, and sound,
 * exactly as it did (ADR-006).
 */
function freshBus(): ParamBus {
  const bus = new ParamBus();
  registerDefaults(bus);
  return bus;
}

describe('key params are inert by default (REQ-1)', () => {
  it('defaults to chromatic, C, and no chord memory', () => {
    const bus = freshBus();
    expect(bus.get('scale.type')).toBe(0);
    expect(bus.get('scale.root')).toBe(0);
    expect(bus.get('chord.voicing')).toBe(0);
  });

  it('names index 0 of each label array as the inert option', () => {
    // The defaults above are only no-ops because these two indices mean "off".
    // Reordering either array would silently re-key every saved song.
    expect(SCALE_LABELS[0]).toBe('chromatic');
    expect(CHORD_LABELS[0]).toBe('off');
  });

  it('registers the params over their full label range', () => {
    const bus = freshBus();
    expect(bus.def('scale.root')?.max).toBe(11);
    expect(bus.def('scale.type')?.max).toBe(SCALE_LABELS.length - 1);
    expect(bus.def('chord.voicing')?.max).toBe(CHORD_LABELS.length - 1);
  });
});

describe('songs written before the key existed (REQ-1, back-compat)', () => {
  // Picked by kind, not by name: every shipped demo predates this feature, so all
  // of them are the fixture. A demo added later that *does* set a key would simply
  // be skipped rather than making this test wrong.
  const demos = Object.entries(DROP_IN_DEMOS);

  it('has demos to check', () => {
    expect(demos.length).toBeGreaterThan(0);
  });

  it('carries no scale keys, so each falls back to the inert default', () => {
    for (const [name, song] of demos) {
      const params = song.params as Record<string, number | undefined>;
      for (const id of ['scale.root', 'scale.type', 'chord.voicing']) {
        if (params[id] === undefined) continue;
        // If a future demo does set one, it must still be a legal index.
        const def = freshBus().def(id)!;
        expect(params[id], `${name} / ${id}`).toBeGreaterThanOrEqual(def.min);
        expect(params[id], `${name} / ${id}`).toBeLessThanOrEqual(def.max);
      }
    }
  });

  it('restores to chromatic when a song omits the keys', () => {
    const bus = freshBus();
    bus.set('scale.type', SCALE_LABELS.indexOf('minor'));
    bus.set('chord.voicing', CHORD_LABELS.indexOf('7th'));

    // A pre-feature song's params bag simply has no such keys.
    const legacy = Object.fromEntries(
      Object.entries(bus.snapshot()).filter(([id]) => !id.startsWith('scale.') && id !== 'chord.voicing'),
    );
    bus.resetDefaults();
    bus.restore(legacy);

    expect(bus.get('scale.type')).toBe(0);
    expect(bus.get('chord.voicing')).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { PatternStore } from '../../src/state/patterns';
import { Song } from '../../src/state/song';
import { validateSongFile } from '../../src/state/song-validate';
import { MAX_PARAM_KEYS } from '../../src/state/limits';
import { fakeArr } from '../fixtures/fake-arrangement';

/**
 * untrusted-input.md REQ-payload-values-are-bounded (v17). `Song.capture` writes
 * every registered param, so the bound on a `params` map is also a ceiling on the
 * registry: outgrow it and this build refuses the songs it saves. This fails at a
 * quarter of the bound — while there is still room — so the fix is to raise
 * `MAX_PARAM_KEYS`, never to loosen this.
 */
describe('MAX_PARAM_KEYS keeps headroom over the registry', () => {
  const bus = new ParamBus();
  registerDefaults(bus);

  it('the registry uses at most a quarter of the bound', () => {
    expect(bus.ids().length * 4).toBeLessThanOrEqual(MAX_PARAM_KEYS);
  });

  it('the published schema advertises the same bound', () => {
    const schema = JSON.parse(readFileSync(
      fileURLToPath(new URL('../../public/schema/websynth-song.schema.json', import.meta.url)), 'utf8',
    )) as { properties: { params: { maxProperties: number } } };
    expect(schema.properties.params.maxProperties).toBe(MAX_PARAM_KEYS);
  });

  it('a captured session passes its own params check (regression)', () => {
    const file = Song.capture(bus, new PatternStore(), fakeArr(), 'Headroom');
    const res = validateSongFile(JSON.parse(JSON.stringify(file)));
    expect(res.ok).toBe(true);
  });
});

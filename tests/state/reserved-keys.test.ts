import { describe, it, expect } from 'vitest';
import { validatePresetPayload } from '../../src/state/preset-validate';
import { validateSongFile } from '../../src/state/song-validate';
import { MAX_PARAM_KEYS } from '../../src/state/limits';
import { Song } from '../../src/state/song';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { PatternStore } from '../../src/state/patterns';
import { fakeArr } from '../fixtures/fake-arrangement';

/**
 * untrusted-input.md REQ-reserved-keys-are-refused (v6) — "refused everywhere",
 * made true as written.
 *
 * The guard was at three validators and the narrowness was recorded in the spec
 * as a known gap. Two of the unguarded paths were live rather than theoretical:
 *
 *   - motion cells reach the same `Object.assign(cell, DEFAULTS, parsed)` in
 *     `PatternStore.restore` that the seq/trigger cells do — the motivating
 *     path, with no guard on it;
 *   - the bank loop writes `presets[n] = …` with `n` straight out of
 *     `JSON.parse`, and for `__proto__` that is a `[[Set]]` re-pointing the
 *     map's prototype.
 *
 * `MAX_PARAM_KEYS` was likewise enforced on a song's `params` but on no preset
 * path, though a preset reaches `ParamBus.restore` the same way — and the bus
 * KEEPS unregistered ids, so junk rides into every later save.
 *
 * Every hostile payload here is built with `JSON.parse`, never a literal:
 * `obj['__proto__'] = x` invokes the *setter* and creates no own key, so a
 * literal would not reproduce the hazard at all. That is also precisely why the
 * hazard exists only on the parse path.
 */

function songWith(over: Record<string, unknown>): Record<string, unknown> {
  const bus = new ParamBus();
  registerDefaults(bus);
  const file = Song.capture(bus, new PatternStore(), fakeArr(), 'T');
  return { ...(JSON.parse(JSON.stringify(file)) as Record<string, unknown>), ...over };
}

const errorsOf = (r: unknown): string => ((r as { errors?: string[] }).errors ?? []).join('\n');

/** 16 motion-track step cells, the first of which carries a reserved key. */
const trackWithBadCell = (): unknown => {
  const good = Array.from({ length: 15 }, () => ({ on: false, v: 0.5 }));
  const steps = `[{"on":false,"v":0.5,"__proto__":{"on":true}},${JSON.stringify(good).slice(1)}`;
  return JSON.parse(`{"param":"filter.cutoff","steps":${steps}}`);
};

describe('reserved keys are refused on every payload path', () => {
  it('refuses a __proto__ key on a motion XY cell', () => {
    const banks: unknown[][] = Array.from({ length: 4 }, () =>
      Array.from({ length: 16 }, () => ({ on: false, x: 0.5, y: 0.5 })));
    banks[0]![0] = JSON.parse('{"on":false,"x":0.5,"y":0.5,"__proto__":{"on":true}}');

    const res = validateSongFile(songWith({ motionBanks: banks }));
    expect(res.ok).toBe(false);
    expect(errorsOf(res)).toContain('__proto__');
  });

  it('refuses a __proto__ key on an extra motion track', () => {
    const steps = JSON.stringify(Array.from({ length: 16 }, () => ({ on: false, v: 0.5 })));
    const bad = JSON.parse(`{"param":"filter.cutoff","steps":${steps},"__proto__":{"param":"x"}}`);

    const res = validateSongFile(songWith({ motionTracks: [[null, bad]] }));
    expect(res.ok).toBe(false);
    expect(errorsOf(res)).toContain('__proto__');
  });

  it('refuses a __proto__ key on an extra motion track’s step cell', () => {
    const res = validateSongFile(songWith({ motionTracks: [[null, trackWithBadCell()]] }));
    expect(res.ok).toBe(false);
    expect(errorsOf(res)).toContain('__proto__');
  });

  it('refuses a __proto__ key in a preset params map', () => {
    const raw = JSON.parse('{"format":"websynth-preset","version":1,"name":"L",'
      + '"params":{"filter.cutoff":80,"__proto__":{"x":1}}}') as unknown;
    const res = validatePresetPayload(raw);
    expect(res.ok).toBe(false);
    // The REFUSAL, not the incidental "that is not a number" complaint the
    // same key would also draw — otherwise this passes with no guard at all.
    expect(errorsOf(res)).toContain('must not carry');
  });

  it('refuses a __proto__ entry in a bank’s presets map, which is a [[Set]]', () => {
    const raw = JSON.parse('{"format":"websynth-preset-bank","version":1,"name":"set",'
      + '"presets":{"__proto__":{"filter.cutoff":60},"one":{"filter.cutoff":70}}}') as unknown;
    const res = validatePresetPayload(raw);
    expect(res.ok).toBe(false);
    expect(errorsOf(res)).toContain('__proto__');
  });

  it('still accepts an ordinary preset and bank', () => {
    expect(validatePresetPayload({
      format: 'websynth-preset', version: 1, name: 'L', params: { 'filter.cutoff': 80 },
    }).ok).toBe(true);
    expect(validatePresetPayload({
      format: 'websynth-preset-bank', version: 1, name: 'set',
      presets: { one: { 'filter.cutoff': 60 } },
    }).ok).toBe(true);
  });
});

describe('a preset’s params map is bounded like a song’s', () => {
  it('refuses more than MAX_PARAM_KEYS entries, and says so', () => {
    const params: Record<string, number> = {};
    for (let i = 0; i <= MAX_PARAM_KEYS; i++) params[`junk.p${i}`] = 0;

    const res = validatePresetPayload({
      format: 'websynth-preset', version: 1, name: 'L', params,
    });
    expect(res.ok).toBe(false);
    // The specific refusal must survive, not be replaced by the generic
    // "no valid params map" one — that would point at the wrong problem.
    expect(errorsOf(res)).toContain(String(MAX_PARAM_KEYS));
  });

  it('accepts a map at the limit', () => {
    const params: Record<string, number> = {};
    for (let i = 0; i < MAX_PARAM_KEYS; i++) params[`junk.p${i}`] = 0;
    expect(validatePresetPayload({
      format: 'websynth-preset', version: 1, name: 'L', params,
    }).ok).toBe(true);
  });
});

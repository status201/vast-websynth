import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../src/audio/engine';
import { Polyphony } from '../../src/audio/polyphony';
import { LFO } from '../../src/audio/lfo';
import {
  makeMockAudioContext,
  installMockAudioWorkletNode,
  MockAudioWorkletNode,
  makeParam,
} from './mock-audio-context';

/**
 * specs/features/oscillator-sync.md — the engine side: the pairs are built on
 * first use and only then (REQ-the-pair-is-built-on-first-use), and every pitch
 * source reaches the pair (REQ-every-pitch-source-reaches-the-pair).
 *
 * A real `Engine` needs a context, three worklet modules and an async `init()`,
 * so — as `engine-resume.test.ts` does — the lazy builder is driven on a
 * structural stub built on `Engine.prototype`, which runs the production method.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8');

beforeEach(() => { installMockAudioWorkletNode(); });
afterEach(() => vi.unstubAllGlobals());

function engineLike(voiceCount = 3, addModule = vi.fn(async () => {})) {
  const ctx = makeMockAudioContext();
  ctx.audioWorklet.addModule = addModule;
  const voices = Array.from({ length: voiceCount }, () => ({ attachSync: vi.fn() }));
  const engine = Object.assign(Object.create(Engine.prototype) as object, {
    ctx, voices, syncReady: null,
  }) as unknown as { ensureSync(): Promise<void> };
  return { engine, voices, addModule };
}

describe('the pairs are built on first use (REQ-the-pair-is-built-on-first-use)', () => {
  it('loads the module once and gives every voice one pair, however often it is asked', async () => {
    const { engine, voices, addModule } = engineLike();
    await Promise.all([engine.ensureSync(), engine.ensureSync()]);
    await engine.ensureSync();
    expect(addModule).toHaveBeenCalledTimes(1);
    expect(addModule).toHaveBeenCalledWith('/worklets/sync-osc.js');
    for (const v of voices) expect(v.attachSync).toHaveBeenCalledTimes(1);
    expect(MockAudioWorkletNode.instances.filter((n) => n.workletName === 'sync-osc')).toHaveLength(3);
  });

  it('a failed load leaves sync inert and throws into nobody', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { engine, voices } = engineLike(2, vi.fn(async () => { throw new Error('offline'); }));
    await expect(engine.ensureSync()).resolves.toBeUndefined();
    for (const v of voices) expect(v.attachSync).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('only a mode other than off asks for the pairs', () => {
    // The subscriber is the one seam a stub cannot reach without booting every
    // other subscription, so its shape is pinned on the source.
    const s = src('audio/engine.ts');
    expect(s).toMatch(/bus\.subscribe\('osc2\.sync', \(x\) => \{\s+if \(Math\.round\(x\) !== 0\) void this\.ensureSync\(\);/);
    expect(s).not.toMatch(/init\(\)[\s\S]{0,400}SyncOscNode\.loadModule/);
  });
});

describe('every pitch source reaches the pair (REQ-every-pitch-source-reaches-the-pair)', () => {
  const voiceStub = () => {
    const targets = [makeParam(0), makeParam(0), makeParam(0), makeParam(0)];
    return { targets, pitchTargets: () => targets, syncTarget: makeParam(12) };
  };

  it('analogue drift connects to all four pitch targets', () => {
    const ctx = makeMockAudioContext();
    const poly = new Polyphony(ctx as any, []);
    const v = voiceStub();
    poly.connectDrift(v as any);
    const drift = ctx.createConstantSource.mock.results[0]!.value;
    for (const t of v.targets) expect(drift.connect).toHaveBeenCalledWith(t);
  });

  it('pitch bend and both LFOs go through pitchTargets, and the LFOs reach the sync junction', () => {
    const s = src('audio/engine.ts');
    expect(s).toContain('for (const t of v.pitchTargets()) this.pitchBend.connect(t);');
    expect(s).toContain('for (const t of v.pitchTargets()) lfo.toPitch.connect(t);');
    expect(s).toContain('lfo.toSync.connect(v.syncTarget);');
    // No call site may hand-list the three detunes again — that list is how a
    // fourth target gets forgotten.
    expect(s).not.toContain('.connect(v.osc1.detuneParam)');
  });
});

describe('the LFO sync destination (REQ-sync-is-a-modulation-destination)', () => {
  it('drives toSync at ±24 st at full amount and nothing else', () => {
    const ctx = makeMockAudioContext();
    const lfo = new LFO(ctx as any);
    lfo.setAmount(1);
    lfo.setDest(7); // 'sync' in LFO_DEST_LABELS
    const last = (p: { setTargetAtTime: ReturnType<typeof vi.fn> }) => p.setTargetAtTime.mock.calls.at(-1)?.[0];
    expect(last(lfo.toSync.gain as any)).toBe(24);
    expect(last(lfo.toPitch.gain as any)).toBe(0);
    expect(last(lfo.toCutoff.gain as any)).toBe(0);
  });
});

describe('FM is in use while the knob or a route says so (cross-modulation.md REQ-cross-mod-disconnects-when-unused)', () => {
  it('engages every voice when the index is up or a live row targets fm, and only then', async () => {
    const { MOD_DST } = await import('../../src/state/mod-routing');
    const voices = [{ setFmInUse: vi.fn() }, { setFmInUse: vi.fn() }];
    let routed = false;
    const usesDest = vi.fn(() => routed);
    const engine = Object.assign(Object.create(Engine.prototype) as object, {
      voices, fmIndex: 0, modMatrix: { usesDest },
    }) as unknown as { refreshFm(): void; fmIndex: number };

    engine.refreshFm();
    for (const v of voices) expect(v.setFmInUse).toHaveBeenLastCalledWith(false);
    expect(usesDest).toHaveBeenCalledWith(MOD_DST.fm);

    routed = true;
    engine.refreshFm();
    for (const v of voices) expect(v.setFmInUse).toHaveBeenLastCalledWith(true);

    routed = false;
    engine.fmIndex = 2;
    engine.refreshFm();
    for (const v of voices) expect(v.setFmInUse).toHaveBeenLastCalledWith(true);
  });

  it('a matrix re-patch re-evaluates it', () => {
    // Both the src and the dst subscription call refreshFm — a route alone can engage FM.
    const body = src('audio/engine.ts');
    expect(body).toMatch(/mod\.\$\{n\}\.src`, \(v\) => \{ this\.modMatrix\.setSource\(row, v\); this\.refreshFm\(\); \}/);
    expect(body).toMatch(/mod\.\$\{n\}\.dst`, \(v\) => \{ this\.modMatrix\.setDest\(row, v\); this\.refreshFm\(\); \}/);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OscPairPolicy } from '../../src/audio/osc-pair-policy';
import { Polyphony } from '../../src/audio/polyphony';
import { LFO } from '../../src/audio/lfo';
import { PAIR_RELEASE_HOLD_MS } from '../../src/audio/cross-mod';
import {
  makeMockAudioContext,
  installMockAudioWorkletNode,
  MockAudioWorkletNode,
  makeParam,
} from './mock-audio-context';

/**
 * specs/features/oscillator-sync.md — the engine side: the pairs are built on
 * first use and only then (REQ-the-pair-is-built-on-first-use), and every pitch
 * source reaches the pair (REQ-every-pitch-source-reaches-the-pair). The pair
 * policy (`OscPairPolicy`) is driven directly over stub voices; the wiring only a
 * booted Engine reaches is pinned on its source.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8');

beforeEach(() => { installMockAudioWorkletNode(); });
afterEach(() => vi.unstubAllGlobals());

const voice = () => ({ attachSync: vi.fn(), setFm: vi.fn(), setFmInUse: vi.fn(), setPairFree: vi.fn() });

function policyWith(opts: {
  voiceCount?: number;
  addModule?: (...a: unknown[]) => Promise<void>;
  fmRouted?: () => boolean;
  pwmOwned?: () => boolean;
} = {}) {
  const ctx = makeMockAudioContext();
  const addModule = vi.fn(opts.addModule ?? (async () => {}));
  ctx.audioWorklet.addModule = addModule;
  const voices = Array.from({ length: opts.voiceCount ?? 3 }, voice);
  const policy = new OscPairPolicy({
    ctx: ctx as any,
    voices: voices as any,
    fmRouted: opts.fmRouted ?? (() => false),
    pwmOwned: opts.pwmOwned ?? (() => false),
  });
  return { policy, voices, addModule };
}

describe('the pairs are built on first use (REQ-the-pair-is-built-on-first-use)', () => {
  it('loads the module once and gives every voice one pair, however often it is asked', async () => {
    const { policy, voices, addModule } = policyWith();
    await Promise.all([policy.ensureSync(), policy.ensureSync()]);
    await policy.ensureSync();
    expect(addModule).toHaveBeenCalledTimes(1);
    expect(addModule).toHaveBeenCalledWith('/worklets/sync-osc.js');
    for (const v of voices) expect(v.attachSync).toHaveBeenCalledTimes(1);
    expect(MockAudioWorkletNode.instances.filter((n) => n.workletName === 'sync-osc')).toHaveLength(3);
  });

  it('a failed load leaves sync inert and throws into nobody', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { policy, voices } = policyWith({ voiceCount: 2, addModule: async () => { throw new Error('offline'); } });
    await expect(policy.ensureSync()).resolves.toBeUndefined();
    for (const v of voices) expect(v.attachSync).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // Regression: the failed promise was memoized as resolved, so a transient fetch
  // failure (offline before the precache filled) left sync dead until reload,
  // while the flanger and reverse delay retried.
  it('a failed load is forgotten, so the next ask loads it and builds the pairs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = true;
    const { policy, voices, addModule } = policyWith({
      voiceCount: 2,
      addModule: async () => { if (fail) throw new Error('offline'); },
    });
    await expect(policy.ensureSync()).resolves.toBeUndefined();
    for (const v of voices) expect(v.attachSync).not.toHaveBeenCalled();
    fail = false;
    await policy.ensureSync();
    await policy.ensureSync();
    expect(addModule).toHaveBeenCalledTimes(2);
    for (const v of voices) expect(v.attachSync).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('a failure building the pairs is not retried, so no voice is attached twice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { policy, voices, addModule } = policyWith({ voiceCount: 2 });
    voices[1]!.attachSync.mockImplementation(() => { throw new Error('boom'); });
    await expect(policy.ensureSync()).resolves.toBeUndefined();
    await policy.ensureSync();
    expect(addModule).toHaveBeenCalledTimes(1);
    expect(voices[0]!.attachSync).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('only a mode other than off asks for the pairs', () => {
    // The subscriber is the one seam a stub cannot reach without booting every
    // other subscription, so its shape is pinned on the source.
    expect(src('audio/engine-params.ts')).toMatch(
      /bus\.subscribe\('osc2\.sync', \(x\) => \{\s+if \(Math\.round\(x\) !== 0\) void pairs\.ensureSync\(\);/,
    );
    // Nothing at boot loads the module: only the policy does, on demand.
    expect(src('audio/engine.ts')).not.toMatch(/SyncOscNode\.loadModule/);
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
  it('engages every voice when the index is up or a live row targets fm, and only then', () => {
    let routed = false;
    const fmRouted = vi.fn(() => routed);
    const { policy, voices } = policyWith({ voiceCount: 2, fmRouted });

    policy.refreshFm();
    for (const v of voices) expect(v.setFmInUse).toHaveBeenLastCalledWith(false);
    expect(fmRouted).toHaveBeenCalled();

    routed = true;
    policy.refreshFm();
    for (const v of voices) expect(v.setFmInUse).toHaveBeenLastCalledWith(true);

    routed = false;
    policy.setFmIndex(2);
    for (const v of voices) expect(v.setFm).toHaveBeenLastCalledWith(2);
    for (const v of voices) expect(v.setFmInUse).toHaveBeenLastCalledWith(true);
  });

  it('a matrix re-patch re-evaluates it', () => {
    // Both the src and the dst subscription re-ask FM — a route alone can engage it.
    const body = src('audio/engine.ts');
    expect(body).toMatch(/mod\.\$\{n\}\.src`, \(v\) => \{ this\.modMatrix\.setSource\(row, v\); this\.pairs\.refreshFm\(\); \}/);
    expect(body).toMatch(/mod\.\$\{n\}\.dst`, \(v\) => \{ this\.modMatrix\.setDest\(row, v\); this\.pairs\.refreshFm\(\); \}/);
    expect(body).toContain('fmRouted: () => this.modMatrix.usesDest(MOD_DST.fm)');
  });
});

describe('an FM carrier with a pulse width frees the pairs (cross-modulation.md REQ-an-fm-carrier-with-a-pulse-width-runs-in-the-pair)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());
  const SQUARE = 3;
  const SAW = 2;
  function predicate() {
    const pwm = { pwmOwner: null as number | null };
    const { policy, voices } = policyWith({ voiceCount: 2, pwmOwned: () => pwm.pwmOwner !== null });
    const ensureSync = vi.spyOn(policy, 'ensureSync').mockResolvedValue(undefined);
    const freed = () => voices.map((v) => v.setPairFree.mock.calls.at(-1)?.[0]);
    return { policy, voices, pwm, ensureSync, freed };
  }

  it('frees every voice only while FM is in use on a square whose width can move', () => {
    const { policy, pwm, ensureSync, freed } = predicate();
    policy.setFmIndex(0.4);
    policy.setOsc2Wave(SQUARE);
    // A square at 0.5 with no PWM swaps nothing: it keeps the native, through-zero path.
    expect(freed()).toEqual([undefined, undefined]);
    expect(ensureSync).not.toHaveBeenCalled();

    pwm.pwmOwner = 0; // an LFO takes the pulse destination
    policy.refreshPairFree();
    expect(freed()).toEqual([true, true]);
    expect(ensureSync).toHaveBeenCalledTimes(1);

    policy.setFmIndex(0);
    expect(freed()).toEqual([true, true]); // held: a release waits
    vi.advanceTimersByTime(PAIR_RELEASE_HOLD_MS);
    expect(freed()).toEqual([false, false]);
  });

  it('a predicate back to true inside the hold cancels the release (a WIDTH drag through 0.5)', () => {
    const { policy, voices } = predicate();
    policy.setFmIndex(2);
    policy.setOsc2Wave(SQUARE);
    policy.setOsc2Width(0.6);
    policy.setOsc2Width(0.5);
    vi.advanceTimersByTime(PAIR_RELEASE_HOLD_MS / 2);
    policy.setOsc2Width(0.52);
    vi.advanceTimersByTime(PAIR_RELEASE_HOLD_MS * 2);
    for (const v of voices) expect(v.setPairFree.mock.calls).toEqual([[true]]);
  });

  it('a re-ask while freed asks for the pairs again, so a failed load is retried', () => {
    const { policy, pwm, ensureSync } = predicate();
    policy.setFmIndex(0.4);
    pwm.pwmOwner = 0;
    policy.setOsc2Wave(SQUARE);
    expect(ensureSync).toHaveBeenCalledTimes(1);
    policy.refreshPairFree(); // e.g. the next WIDTH move after a failed load
    expect(ensureSync).toHaveBeenCalledTimes(2);
  });

  it('the WIDTH knob alone frees them under FM, and leaving square releases them', () => {
    const { policy, voices, freed } = predicate();
    policy.setFmIndex(2);
    policy.setOsc2Wave(SQUARE);
    policy.setOsc2Width(0.6);
    expect(freed()).toEqual([true, true]);

    // A WIDTH drag re-asks on every move; only a change of answer reaches the voices.
    policy.setOsc2Width(0.7);
    for (const v of voices) expect(v.setPairFree).toHaveBeenCalledTimes(1);

    policy.setOsc2Wave(SAW);
    vi.advanceTimersByTime(PAIR_RELEASE_HOLD_MS);
    expect(freed()).toEqual([false, false]);
  });

  it('every input of the predicate re-asks it, before the value reaches the voices', () => {
    const engine = src('audio/engine.ts');
    expect(engine).toMatch(/new PwmDriver\(this\.voices, \(\) => this\.ctx\.currentTime, \(\) => this\.pairs\.refreshPairFree\(\)\)/);
    expect(engine).toContain('pwmOwned: () => this.pwm.pwmOwner !== null');
    expect(engine).toMatch(/bus\.subscribe\('osc2\.pulseWidth', \(x\) => \{[^}]*this\.pairs\.setOsc2Width\(x\);\s+this\.pwm\.setBase\(1, x\);/);
    expect(src('audio/engine-params.ts')).toMatch(
      /bus\.subscribe\('osc2\.wave', \(x\) => \{[^}]*pairs\.setOsc2Wave\(x\);\s+for \(const v of voices\) v\.osc2\.setWave\(x\);/,
    );
  });
});

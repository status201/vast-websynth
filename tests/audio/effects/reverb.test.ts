// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Reverb } from '../../../src/audio/effects/reverb';
import { makeMockAudioContext, type MockAudioContext } from '../mock-audio-context';

/**
 * The impulse-response bank (runtime-performance.md REQ-boot-cost-matches-the-request/REQ-immutable-artefacts-are-shared). An IR is a
 * pure function of (sampleRate, duration) and a ConvolverNode only reads its
 * buffer, so the bank is generated lazily and shared across every Reverb —
 * three chains used to render five IRs each (2.65 M samples, ~10.6 MB) up front
 * on the boot path.
 *
 * `createBuffer` calls are the proxy for generation work: each one is a whole
 * IR's worth of `Math.random`/`pow`/`sin`.
 */

/** A Reverb that has been switched on — the bank's behaviour once it is in use.
 *  `off` keeps it as it boots: bypassed, holding no IR
 *  (effects.md REQ-a-reverb-prepares-its-ir-on-first-use). */
const mk = (ctx: MockAudioContext, maxIrS?: number, off = false): Reverb => {
  const r = new Reverb(ctx as unknown as AudioContext, maxIrS === undefined ? undefined : { maxIrS });
  if (!off) r.setBypass(false);
  return r;
};
const heldIr = (r: Reverb): AudioBuffer | null =>
  (r as unknown as { convolver: ConvolverNode }).convolver.buffer;

// The cache is process-wide and keyed by sample rate, so each test takes its own
// rate rather than needing a test-only reset hatch on the production module.
// (That the rate partitions the cache at all is itself part of the contract: an
// IR is only valid for the rate it was rendered at.)
let nextRate = 44100;
const freshCtx = (): MockAudioContext => makeMockAudioContext(nextRate++);

/** How many IRs were generated on this context. */
const generated = (ctx: MockAudioContext): number => ctx.createBuffer.mock.calls.length;

/**
 * `setSize` ducks the effect's output, swaps the IR on a 40 ms timer and ramps
 * back (effects.md REQ-a-reverb-size-change-ducks), so the buffer only lands after that window. Every
 * assertion on `convolver.buffer` goes through this. Note the IR *generation* is
 * still synchronous inside `setSize`, so the `generated()` counts below need no
 * timer at all — which is the point: the duck defers the swap, not the work.
 */
const setSize = (r: Reverb, v: number): void => {
  r.setSize(v);
  vi.advanceTimersByTime(50);
};

/**
 * Fake timers for the whole file, and pending ones dropped after each test. An
 * effect boots bypassed, so its constructor arms a real 300 ms disconnect timer
 * (effects.md REQ-a-bypassed-effect-drains-before-disconnect) whose callback
 * calls `window.setTimeout`. Left on the real clock it can fire after this
 * file's jsdom environment is torn down — `window is not defined`, an
 * unhandled error that fails the run even though every test passed.
 */
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('Reverb IR bank', () => {
  it('generates only the default size when first switched on', () => {
    const ctx = freshCtx();
    mk(ctx);
    expect(generated(ctx)).toBe(1);
  });

  // effects.md REQ-a-reverb-prepares-its-ir-on-first-use. Assigning
  // convolver.buffer prepares the kernel synchronously (12-17 ms in Blink, 23-34
  // ms in Gecko), and the three chains each did it at boot for reverbs that may
  // never be switched on.
  it('builds and holds no IR while it has never been switched on', () => {
    const ctx = freshCtx();
    const all = [mk(ctx, undefined, true), mk(ctx, undefined, true), mk(ctx, undefined, true)];
    for (const r of all) r.setSize(0.1); // a song load writing the size, reverbs off
    vi.advanceTimersByTime(200);
    expect(generated(ctx)).toBe(0);
    for (const r of all) expect(heldIr(r)).toBeNull();
  });

  it('a size written before the first switch-on is the one it builds', () => {
    const ctx = freshCtx();
    const r = mk(ctx, undefined, true);
    r.setSize(0); // the shortest tail, chosen while off
    const out = (r as unknown as { wrap: { processedOut: GainNode } }).wrap.processedOut;
    // Nothing has rung, so there is nothing to duck either.
    expect(out.gain.setTargetAtTime as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    r.setBypass(false);
    expect(generated(ctx)).toBe(1);
    expect(heldIr(r)!.length).toBe(Math.floor(ctx.sampleRate * 0.4));
  });

  it('shares one bank across every Reverb on the same context', () => {
    const ctx = freshCtx();
    const [synth, drum, sampler] = [mk(ctx), mk(ctx), mk(ctx)];
    // Three instances, one IR — the two later ones hit the cache.
    expect(generated(ctx)).toBe(1);

    // …and it is literally the same buffer object in each convolver.
    const buf = (b: Reverb): unknown =>
      (b as unknown as { convolver: ConvolverNode }).convolver.buffer;
    expect(buf(drum)).toBe(buf(synth));
    expect(buf(sampler)).toBe(buf(synth));
  });

  it('generates a size on first use and reuses it thereafter', () => {
    const ctx = freshCtx();
    const a = mk(ctx);
    const b = mk(ctx);
    const before = generated(ctx);

    a.setSize(0); // shortest tail — not built yet
    expect(generated(ctx)).toBe(before + 1);

    a.setSize(1); // another new one
    expect(generated(ctx)).toBe(before + 2);

    a.setSize(0); // back to a built one — no work
    b.setSize(0); // a *different* reverb, same size — no work
    b.setSize(1);
    expect(generated(ctx)).toBe(before + 2);
  });

  it('a full sweep builds each size exactly once, however often it is dragged', () => {
    const ctx = freshCtx();
    const r = mk(ctx);
    // 5 bank entries, one already built by the constructor.
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i <= 40; i++) r.setSize(i / 40);
    }
    expect(generated(ctx)).toBe(5);
  });

  it('maps size 0..1 across the bank and clamps outside it', () => {
    const ctx = freshCtx();
    const r = mk(ctx);
    const buf = (): AudioBuffer =>
      (r as unknown as { convolver: ConvolverNode }).convolver.buffer!;

    setSize(r, 0);
    const shortest = buf();
    setSize(r, 1);
    const longest = buf();
    expect(longest.length).toBeGreaterThan(shortest.length);

    setSize(r, -5);
    expect(buf()).toBe(shortest);
    setSize(r, 5);
    expect(buf()).toBe(longest);
  });

  // performance-mode.md REQ-weak-tier-reduces-fx-cost: the cap shortens the tails, it does not shrink
  // the bank — so `size` keeps its meaning and presets sound the same shape.
  it('a perf-tier IR cap shortens tails without collapsing the bank', () => {
    const ctx = freshCtx();
    const capped = mk(ctx, 1.5);
    const buf = (): AudioBuffer =>
      (capped as unknown as { convolver: ConvolverNode }).convolver.buffer!;

    setSize(capped, 0);
    const shortest = buf().length;
    setSize(capped, 1);
    const longest = buf().length;
    expect(shortest).toBeLessThan(longest);
    expect(longest).toBe(Math.floor(ctx.sampleRate * 1.5)); // clamped, not 4 s

    // Every size at/over the cap collapses onto the same cached buffer.
    setSize(capped, 0.75);
    const atCap = buf();
    setSize(capped, 1);
    expect(buf()).toBe(atCap);
  });

  /**
   * The shape a song load makes (song-mode.md REQ-applying-a-song-is-click-free): `resetDefaults()` writes
   * the default size, then `restore()` writes the song's — both in one turn,
   * inside the swap's mute window. Reported from the field: a demo asking for
   * 11% played at the 60% default, intermittently, and nudging the knob one
   * percent made the reverb *smaller*.
   *
   * The cause was the guard reading `convolver.buffer`, which lags the whole
   * window: the second write saw the value the first had not applied yet,
   * concluded it was already there, and returned without superseding the
   * pending swap — so the default landed. It only bit when the previous song
   * left the *song's* IR in place, which is what made it intermittent.
   */
  it('two writes in one turn land on the second, not the first (regression)', () => {
    const ctx = freshCtx();
    const r = mk(ctx);
    const buf = (): AudioBuffer =>
      (r as unknown as { convolver: ConvolverNode }).convolver.buffer!;

    // Put the convolver on the SMALL IR — the state that used to break it.
    setSize(r, 0);
    const small = buf();

    // Now the load: default (0.6 -> the middle IR), then the song's 0.105 ->
    // the small one again. The net effect must be "unchanged", not "default".
    r.setSize(0.6);
    r.setSize(0.105);
    vi.advanceTimersByTime(200);
    expect(buf()).toBe(small);

    // And the same pair the other way round still moves it.
    r.setSize(0.105);
    r.setSize(1);
    vi.advanceTimersByTime(200);
    expect(buf().length).toBeGreaterThan(small.length);
  });

  it('caps do not leak between tiers (cache key includes the duration)', () => {
    const ctx = freshCtx();
    const capped = mk(ctx, 1.5);
    const full = mk(ctx);
    const buf = (r: Reverb): AudioBuffer =>
      (r as unknown as { convolver: ConvolverNode }).convolver.buffer!;

    setSize(capped, 1);
    setSize(full, 1);
    expect(buf(full).length).toBeGreaterThan(buf(capped).length);
  });

  it('generates stereo IRs that decay', () => {
    const ctx = freshCtx();
    const r = mk(ctx);
    r.setSize(1);
    const ir = (r as unknown as { convolver: ConvolverNode }).convolver.buffer!;
    expect(ir.numberOfChannels).toBe(2);

    const data = ir.getChannelData(0);
    const rms = (from: number, to: number): number => {
      let s = 0;
      for (let i = from; i < to; i++) s += data[i]! * data[i]!;
      return Math.sqrt(s / (to - from));
    };
    const n = data.length;
    const tenth = Math.floor(n / 10);
    expect(rms(0, tenth)).toBeGreaterThan(rms(n - tenth, n) * 5);
  });
});

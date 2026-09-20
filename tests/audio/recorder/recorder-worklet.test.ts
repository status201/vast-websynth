import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

/**
 * Drives the real `public/worklets/recorder.js` under Node by stubbing the
 * AudioWorklet globals, the way `ladder-filter-worklet.test.ts` does.
 *
 * The contract under test is the batching one (audio-export.md
 * REQ-chunks-are-batched-then-flushed / REQ-each-chunk-is-frame-tagged) plus
 * runtime-performance.md REQ-no-allocation-in-a-hot-loop: a FULL batch is
 * transferred as it stands rather than copied. `filled` rises by exactly one
 * quantum per call, so the periodic flush always lands on the accumulator's own
 * length — only the final short flush on stop has anything to trim.
 */

const SR = 48000;
const BLOCK = 128;
const BATCH_QUANTA = 16; // keep in sync with the worklet + RECORD_BATCH_QUANTA

interface Posted { l?: Float32Array; r?: Float32Array; f?: number; done?: boolean }

interface ProcessorLike {
  port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown, t?: unknown[]) => void };
  recording: boolean;
  process(inputs: Float32Array[][]): boolean;
  flush(done: boolean): void;
}

let Processor: new () => ProcessorLike;

beforeAll(async () => {
  vi.stubGlobal('sampleRate', SR);
  vi.stubGlobal('currentFrame', 0);
  vi.stubGlobal('AudioWorkletProcessor', class {
    port = { onmessage: null, postMessage: () => {} };
  });
  vi.stubGlobal('registerProcessor', (_name: string, cls: unknown) => {
    Processor = cls as typeof Processor;
  });
  await import('../../../public/worklets/recorder.js' as string);
});

function rig() {
  const proc = new Processor();
  const posts: Posted[] = [];
  const transfers: unknown[][] = [];
  proc.port.postMessage = (m, t) => { posts.push(m as Posted); transfers.push((t as unknown[]) ?? []); };
  proc.recording = true;
  const L = new Float32Array(BLOCK);
  const R = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) { L[i] = i / BLOCK; R[i] = -i / BLOCK; }
  return { proc, posts, transfers, pump: (n: number) => { for (let i = 0; i < n; i++) proc.process([[L, R]]); } };
}

describe('recorder worklet batching', () => {
  beforeEach(() => { vi.stubGlobal('currentFrame', 0); });

  it('posts nothing until a whole batch is filled', () => {
    const { posts, pump } = rig();
    pump(BATCH_QUANTA - 1);
    expect(posts).toHaveLength(0);
  });

  it('posts one message per full batch, of exactly the batch length', () => {
    const { posts, pump } = rig();
    pump(BATCH_QUANTA * 3);
    expect(posts).toHaveLength(3);
    for (const p of posts) {
      expect(p.l).toHaveLength(BATCH_QUANTA * BLOCK);
      expect(p.r).toHaveLength(BATCH_QUANTA * BLOCK);
    }
  });

  it('transfers the accumulator itself on a full batch, rather than a copy', () => {
    const { proc, posts, transfers, pump } = rig();
    // Grab the accumulator while it still exists: the flush nulls it, and in a
    // real host the transfer detaches its buffer.
    pump(BATCH_QUANTA - 1);
    const accL = (proc as unknown as { batchL: Float32Array }).batchL;
    const accR = (proc as unknown as { batchR: Float32Array }).batchR;
    expect(accL).toBeInstanceOf(Float32Array);

    pump(1); // completes the batch -> flush

    // Identity, not equality: a `.slice()` would post a different object with
    // the same contents, which is the allocation this avoids
    // (REQ-no-allocation-in-a-hot-loop).
    expect(posts[0]!.l).toBe(accL);
    expect(posts[0]!.r).toBe(accR);
    expect(transfers[0]).toContain(accL.buffer);
  });

  it('carries the captured audio through unchanged', () => {
    const { posts, pump } = rig();
    pump(BATCH_QUANTA);
    const l = posts[0]!.l!;
    expect(l[0]).toBeCloseTo(0, 6);
    expect(l[1]).toBeCloseTo(1 / BLOCK, 6);
    expect(posts[0]!.r![1]).toBeCloseTo(-1 / BLOCK, 6);
  });

  it('still trims the short final flush on stop', () => {
    const { proc, posts, pump } = rig();
    pump(3); // a partial batch
    proc.flush(true);

    expect(posts).toHaveLength(1);
    expect(posts[0]!.l).toHaveLength(3 * BLOCK);
    expect(posts[0]!.done).toBe(true);
  });

  it('resolves a stop even with nothing buffered', () => {
    const { proc, posts } = rig();
    proc.flush(true);
    expect(posts).toEqual([{ done: true }]);
  });

  it('tags each batch with its first absolute frame', () => {
    const { proc, posts } = rig();
    const L = new Float32Array(BLOCK);
    vi.stubGlobal('currentFrame', 9000);
    for (let i = 0; i < BATCH_QUANTA; i++) proc.process([[L, L]]);
    expect(posts[0]!.f).toBe(9000);
  });

  it('does nothing at all while not recording', () => {
    const { proc, posts, pump } = rig();
    proc.recording = false;
    pump(BATCH_QUANTA * 2);
    expect(posts).toHaveLength(0);
  });
});

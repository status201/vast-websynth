import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RecorderNode, RECORD_BATCH_QUANTA } from '../../../src/audio/recorder/node';

/**
 * `RecorderNode`'s teardown (sample-recorder.md REQ-6) and its batched capture
 * (audio-export.md REQ-6b).
 *
 * The worklet accumulates `RECORD_BATCH_QUANTA` quanta per message, which is
 * only safe because `stop`/`pause` make it flush the partial batch and the node
 * *waits* for that flush. Reading the chunk list synchronously — what it used to
 * do — would drop up to a batch (~40 ms at 48 kHz) off the end of every take.
 *
 * `mic-capture.test.ts` mocks this module wholesale, so the real behaviour is
 * only reachable from here.
 */

/**
 * A stand-in for the worklet node. `postMessage({cmd:'stop'|'pause'})` triggers
 * the flush the real processor performs in its own `onmessage`: the partial
 * batch (if any) followed by the `done` ack the node blocks on.
 */
function stubWorkletNode() {
  const node = {
    port: {
      onmessage: null as ((e: MessageEvent) => void) | null,
      postMessage: vi.fn((msg?: { cmd?: string }) => {
        if (msg?.cmd === 'stop' || msg?.cmd === 'pause') node.flush();
      }),
    },
    disconnect: vi.fn(),
    /** Frames the worklet is holding in its partial batch, if any. */
    pending: null as { l: Float32Array; r: Float32Array; f: number } | null,
    /** What the processor does on stop/pause: post the remainder, marked done. */
    flush(): void {
      const p = node.pending;
      node.pending = null;
      const data = p ? { ...p, done: true } : { done: true };
      node.port.onmessage?.({ data } as MessageEvent);
    },
  };
  return node;
}

let node: ReturnType<typeof stubWorkletNode>;

beforeEach(() => {
  node = stubWorkletNode();
  // A plain function, not an arrow — `create` calls it with `new`, and the
  // object it returns becomes the instance.
  vi.stubGlobal('AudioWorkletNode', vi.fn(function fakeWorkletNode() { return node; }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const make = (): Promise<RecorderNode> =>
  RecorderNode.create({ sampleRate: 48000 } as unknown as AudioContext);

/** A ramp, so a mis-ordered or dropped batch is visible in the samples. */
function ramp(from: number, n: number): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = from + i;
  return a;
}

/** Deliver one batch the way the worklet would. */
function deliver(frames: Float32Array, at: number): void {
  node.port.onmessage?.({ data: { l: frames, r: frames, f: at } } as MessageEvent);
}

describe('RecorderNode batched capture (audio-export REQ-6b)', () => {
  it('concatenates batches in order, with no gap at a boundary', async () => {
    const rec = await make();
    rec.start();
    const quantum = 128;
    const batch = RECORD_BATCH_QUANTA * quantum;
    deliver(ramp(0, batch), 0);
    deliver(ramp(batch, batch), batch);

    const take = await rec.stop();

    // Frame-identical to a per-quantum capture: same samples, same order.
    expect(take.left.length).toBe(2 * batch);
    for (let i = 0; i < take.left.length; i++) expect(take.left[i]).toBe(i);
  });

  it('keeps the frames still buffered when the stop arrives mid-batch', async () => {
    const rec = await make();
    rec.start();
    deliver(ramp(0, 1024), 0);
    // The worklet is part-way through its next batch when the user hits stop.
    node.pending = { l: ramp(1024, 300), r: ramp(1024, 300), f: 1024 };

    const take = await rec.stop();

    expect(take.left.length).toBe(1324);
    expect(take.left[1023]).toBe(1023);
    expect(take.left[1024]).toBe(1024);   // the flushed tail, not a gap
    expect(take.left[1323]).toBe(1323);
  });

  it('tags firstFrame from the first batch, not the first quantum', async () => {
    const rec = await make();
    rec.start();
    deliver(ramp(0, 2048), 4096);
    expect(rec.firstFrame).toBe(4096);
    expect(rec.capturedFrames).toBe(2048);
    await rec.stop();
  });

  it('pause flushes too, so the paused stretch cannot straddle a batch', async () => {
    const rec = await make();
    rec.start();
    deliver(ramp(0, 512), 0);
    node.pending = { l: ramp(512, 64), r: ramp(512, 64), f: 512 };

    await rec.pause();
    expect(rec.capturedFrames).toBe(576);   // the partial batch landed

    rec.resume();
    deliver(ramp(576, 512), 99999);         // a later moment in the timeline
    const take = await rec.stop();

    // One continuous buffer — the paused time is simply absent (REQ-4).
    expect(take.left.length).toBe(1088);
    for (let i = 0; i < take.left.length; i++) expect(take.left[i]).toBe(i);
  });

  it('resolves with an empty take when nothing was ever captured (edge)', async () => {
    const rec = await make();
    const take = await rec.stop();
    expect(take.left.length).toBe(0);
    expect(take.sampleRate).toBe(48000);
  });
});

describe('RecorderNode.dispose (sample-recorder REQ-6)', () => {
  it('clears the port handler and disconnects the node', async () => {
    const rec = await make();
    expect(node.port.onmessage).toBeTypeOf('function');

    rec.dispose();

    expect(node.port.onmessage).toBeNull();
    expect(node.disconnect).toHaveBeenCalledTimes(1);
  });

  it('drops the captured chunks it was holding', async () => {
    const rec = await make();
    rec.start();
    deliver(ramp(0, 256), 0);
    expect(rec.capturedFrames).toBe(256);

    rec.dispose();
    // The take is gone with the node — a disposed recorder hands back nothing
    // rather than a stale buffer.
    expect((await rec.stop()).left.length).toBe(0);
  });

  it('is idempotent — a second dispose tears nothing down twice', async () => {
    const rec = await make();
    rec.dispose();
    rec.dispose();
    expect(node.disconnect).toHaveBeenCalledTimes(1);
  });

  it('accepts no further start/stop, so nothing posts to a dead port', async () => {
    const rec = await make();
    rec.dispose();
    node.port.postMessage.mockClear();

    rec.start();
    const take = await rec.stop();

    expect(node.port.postMessage).not.toHaveBeenCalled();
    expect(take.left.length).toBe(0);
    expect(take.sampleRate).toBe(48000);
  });

  it('releases a stop that is still waiting on a flush (edge)', async () => {
    const rec = await make();
    rec.start();
    // A port that never answers — the modal closing mid-flush must not hang.
    node.port.postMessage.mockImplementation(() => {});
    const pending = rec.stop();
    rec.dispose();
    await expect(pending).resolves.toBeDefined();
  });
});

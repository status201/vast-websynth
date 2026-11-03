// Passive capture node. Receives the master output, and while armed copies
// the stereo frames to the main thread via postMessage. Has zero outputs, so
// it is a pure sink — it never doubles audio into the destination. Only
// buffers/posts while `recording` is true.
//
// Frames are BATCHED (audio-export.md REQ-chunks-are-batched-then-flushed): one message per
// RECORD_BATCH_QUANTA quanta rather than one per quantum, which at 48 kHz is
// ~23 messages/s instead of ~375. The main thread had to drain every one of
// those transfers, and a stall (a big repaint, a demo load) queued them with
// their backing ArrayBuffers held alive.
//
// Batching is only correct because `stop`/`pause` FLUSH the partial batch and
// the main thread waits for it — without that, up to a batch of frames would
// vanish off the end of every take. The capture stays frame-identical to the
// unbatched one.

/** Quanta per message. Keep in sync with RECORD_BATCH_QUANTA in recorder/node.ts. */
const BATCH_QUANTA = 16;

/** Frames in a quantum whose input has no channels to measure it by. 128 until the
 *  host says otherwise (`renderQuantumSize`, where the AudioWorkletGlobalScope has it). */
const RENDER_QUANTUM = typeof renderQuantumSize === 'number' ? renderQuantumSize : 128;

class RecorderProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [];
  }

  constructor() {
    super();
    this.recording = false;
    // The partial batch: two channel buffers, how many frames are in them, and
    // the absolute frame index of the first one (REQ-each-chunk-is-frame-tagged's `f`).
    this.batchL = null;
    this.batchR = null;
    this.filled = 0;
    this.batchFirstFrame = 0;
    this.port.onmessage = (e) => {
      const cmd = e.data && e.data.cmd;
      if (cmd === 'start') {
        this.recording = true;
      } else if (cmd === 'stop' || cmd === 'pause') {
        this.recording = false;
        // Hand back whatever is buffered, and say so — the main thread blocks on
        // this reply before it concatenates the take.
        this.flush(true);
      }
    };
  }

  /**
   * Post the partial batch. `done` marks it as the reply the main thread is
   * waiting on, and is sent even when there is nothing buffered so a stop always
   * resolves.
   */
  flush(done) {
    if (this.filled === 0) {
      if (done) this.port.postMessage({ done: true });
      return;
    }
    // A FULL batch is the common case, and it needs no copy at all: `filled`
    // rises by exactly one quantum per call, so the periodic flush lands on the
    // accumulator's own length and the buffer can be transferred as it stands.
    // Only the final flush on stop is short, and only that one pays to trim.
    //
    // What this saves is the COPY — ~0.014% of a core (measured, 11/11 paired
    // reps). It does NOT stop the allocation: transferring detaches `batchL`,
    // so the next `process()` allocates a fresh pair of 8 KB arrays, exactly as
    // often as the `slice()` it replaced did (~23 flushes/s). That is still an
    // allocation inside `process()`, which
    // runtime-performance.md REQ-no-allocation-in-a-hot-loop forbids; ending it
    // would take a buffer pool the main thread hands back (audio-export.md
    // REQ-chunks-are-batched-then-flushed).
    const full = this.filled === this.batchL.length;
    const l = full ? this.batchL : this.batchL.subarray(0, this.filled).slice();
    const r = full ? this.batchR : this.batchR.subarray(0, this.filled).slice();
    const msg = { l, r, f: this.batchFirstFrame };
    if (done) msg.done = true;
    this.port.postMessage(msg, [l.buffer, r.buffer]);
    this.batchL = null;
    this.batchR = null;
    this.filled = 0;
  }

  process(inputs) {
    if (!this.recording) return true;
    // An input with NO channels is silence, not nothing (audio-export.md
    // REQ-a-silent-quantum-is-captured-as-silence): the spec gives an input zero
    // channels when nothing upstream is actively processing, and Gecko does so
    // for every gain-0 stretch. Skipping it cut the silence out of the take.
    const input = inputs[0];
    const srcL = input && input[0] && input[0].length > 0 ? input[0] : null;
    const srcR = srcL && input[1] && input[1].length === srcL.length ? input[1] : srcL;

    const n = srcL ? srcL.length : RENDER_QUANTUM;
    if (this.batchL === null || this.batchL.length < BATCH_QUANTA * n) {
      this.batchL = new Float32Array(BATCH_QUANTA * n);
      this.batchR = new Float32Array(BATCH_QUANTA * n);
      this.filled = 0;
    }
    // f = absolute sample index of this batch's first frame (REQ-each-chunk-is-frame-tagged): lets the
    // main thread map a scheduled AudioContext time to an exact offset in the
    // captured stream.
    if (this.filled === 0) this.batchFirstFrame = currentFrame;

    // The render buffer is reused by the engine, so copy before transferring.
    if (srcL) {
      this.batchL.set(srcL, this.filled);
      this.batchR.set(srcR, this.filled);
    } else {
      this.batchL.fill(0, this.filled, this.filled + n);
      this.batchR.fill(0, this.filled, this.filled + n);
    }
    this.filled += n;

    if (this.filled >= BATCH_QUANTA * n) this.flush(false);
    return true;
  }
}

registerProcessor('recorder', RecorderProcessor);

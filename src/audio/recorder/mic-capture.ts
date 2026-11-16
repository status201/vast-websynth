/**
 * Microphone capture for the "Record a sound" feature. Reuses the existing
 * `recorder` AudioWorklet (`RecorderNode`) so the captured PCM lands as the
 * same `CapturedAudio` the encode pipeline already consumes — no lossy
 * intermediate, no extra codec variance.
 */
import { RecorderNode, type CapturedAudio } from './node';

export type MicError = 'insecure-context' | 'unsupported' | 'denied' | 'no-device' | 'unknown';

export class MicCaptureError extends Error {
  constructor(readonly code: MicError, message: string) {
    super(message);
    this.name = 'MicCaptureError';
  }
}

/** The mic's level right now, linear 0..1+ (sample-recorder.md REQ-the-mic-opens-with-the-studio). */
export interface MicLevel {
  peak: number;
  rms: number;
}

export interface MicSession {
  start(): void;
  /** The context time `start()` armed the take at — what a count-in crops to
   *  (sample-recorder.md REQ-count-in-lands-the-take-on-a-downbeat). 0 before. */
  readonly startedAt: number;
  /** The input's level over the last ~43 ms, read from an analyser on the mic. */
  level(): MicLevel;
  /** Async because the recorder waits for the worklet's flush (audio-export REQ-chunks-are-batched-then-flushed). */
  stop(): Promise<CapturedAudio>;
  /** Stop tracks (clears the OS mic indicator) and tear down the graph. */
  dispose(): void;
}

export async function openMicSession(ctx: AudioContext): Promise<MicSession> {
  if (!window.isSecureContext) {
    throw new MicCaptureError(
      'insecure-context',
      'Microphone access needs a secure context (HTTPS or localhost).',
    );
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new MicCaptureError('unsupported', 'This browser cannot capture microphone audio.');
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
  } catch (err) {
    const name = (err as { name?: string }).name ?? '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new MicCaptureError('denied', 'Microphone permission was blocked.');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') {
      throw new MicCaptureError('no-device', 'No usable microphone was found.');
    }
    throw new MicCaptureError('unknown', 'Could not start the microphone.');
  }

  // A fresh RecorderNode — never the engine's master-tapped one. The worklet
  // module is already registered by Engine.init(), so create() is enough.
  const recorder = await RecorderNode.create(ctx);
  const src = ctx.createMediaStreamSource(stream);

  // The recorder is a 0-output sink; it only processes while its upstream is
  // pulled toward `destination`. Route the mic through a muted gain to the
  // destination so the graph stays live with zero audible monitoring.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  src.connect(recorder.input);
  src.connect(sink);
  sink.connect(ctx.destination);

  // The meter's tap. An analyser is a pass-through sink that needs no output
  // pulled, and reading it costs one copy of its window per animation frame.
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  src.connect(analyser);
  const frame = new Float32Array(analyser.fftSize);

  let armed = false;
  let disposed = false;
  let startedAt = 0;

  return {
    get startedAt(): number { return startedAt; },
    start(): void {
      if (disposed || armed) return;
      armed = true;
      startedAt = ctx.currentTime;
      recorder.start();
    },
    level(): MicLevel {
      if (disposed) return { peak: 0, rms: 0 };
      analyser.getFloatTimeDomainData(frame);
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < frame.length; i++) {
        const v = frame[i]!;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        sum += v * v;
      }
      return { peak, rms: Math.sqrt(sum / frame.length) };
    },
    stop(): Promise<CapturedAudio> {
      armed = false;
      return recorder.stop();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (armed) {
        // Fire-and-forget: dispose discards the take, so there is nothing to
        // wait for — and `dispose()` below releases any pending flush anyway.
        void recorder.stop().catch(() => { /* already torn down */ });
        armed = false;
      }
      try { src.disconnect(); } catch { /* already disconnected */ }
      try { sink.disconnect(); } catch { /* already disconnected */ }
      try { analyser.disconnect(); } catch { /* already disconnected */ }
      // The session owns this recorder (REQ-record-through-a-fresh-recorder-node makes a fresh one per session), so
      // it must release it too — otherwise every modal open strands a worklet
      // node, its render-thread processor and the chunks its port handler holds
      // (REQ-the-recorder-node-is-released-with-the-session). The engine's master-tapped recorders are never disposed.
      recorder.dispose();
      for (const t of stream.getTracks()) t.stop();
    },
  };
}

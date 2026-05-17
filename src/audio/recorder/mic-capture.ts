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

export interface MicSession {
  start(): void;
  stop(): CapturedAudio;
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

  let armed = false;
  let disposed = false;

  return {
    start(): void {
      if (disposed || armed) return;
      armed = true;
      recorder.start();
    },
    stop(): CapturedAudio {
      armed = false;
      return recorder.stop();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (armed) {
        try { recorder.stop(); } catch { /* already torn down */ }
        armed = false;
      }
      try { src.disconnect(); } catch { /* already disconnected */ }
      try { sink.disconnect(); } catch { /* already disconnected */ }
      for (const t of stream.getTracks()) t.stop();
    },
  };
}

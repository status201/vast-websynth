// Ambient declarations for installed-PWA browser APIs that are not (yet) in
// TypeScript's lib.dom. See specs/features/pwa-install.md.

/** File Handling API — Chromium desktop/ChromeOS only today. */
interface LaunchParams {
  readonly files: ReadonlyArray<FileSystemFileHandle>;
}

interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void;
}

interface Window {
  launchQueue?: LaunchQueue;
}

/** Audio Session API — Safari 17+. */
interface AudioSession {
  type: string;
}

interface Navigator {
  audioSession?: AudioSession;
}

/**
 * AudioRenderCapacity — Chrome 115+. The audio thread's own report card;
 * `underrunRatio` is the fraction of render quanta that missed their deadline,
 * which is the crackle itself rather than a proxy for it. See
 * `specs/features/audio-lifecycle.md` REQ-10.
 */
interface AudioRenderCapacityEvent extends Event {
  readonly timestamp: number;
  readonly averageLoad: number;
  readonly peakLoad: number;
  readonly underrunRatio: number;
}

interface AudioRenderCapacity extends EventTarget {
  start(options?: { updateInterval?: number }): void;
  stop(): void;
  addEventListener(type: 'update', fn: (e: AudioRenderCapacityEvent) => void): void;
  removeEventListener(type: 'update', fn: (e: AudioRenderCapacityEvent) => void): void;
}

interface AudioContext {
  readonly renderCapacity?: AudioRenderCapacity;
}

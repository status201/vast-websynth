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

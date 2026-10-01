// The last uncaught errors, for the Debug panel (debug-panel.md
// REQ-the-panel-keeps-the-last-errors).
//
// An eager leaf with no imports, like `debug-sources.ts`: `main.ts` installs it
// before boot so an error during boot is caught too, and the panel that reads it
// is behind a lazy import (runtime-performance.md REQ-boot-cost-matches-the-request).
//
// It only observes. Nothing here calls `preventDefault()`, so the console still
// shows every error, and nothing here may throw: a logger that throws from an
// error handler would feed itself.

export interface ErrorLogEntry {
  at: number;
  kind: 'error' | 'rejection';
  message: string;
}

/** How many entries are kept — the oldest drops off. */
export const ERROR_LOG_CAPACITY = 10;
/** Longest kept message; a runaway error must not grow memory or the report. */
export const ERROR_MESSAGE_MAX = 300;

const entries: ErrorLogEntry[] = [];
let total = 0;
let installed: Window | null = null;

function messageOf(reason: unknown): string {
  if (reason instanceof Error) return reason.message || reason.name;
  try {
    return String(reason);
  } catch {
    return 'unprintable value';
  }
}

/** The listeners' body; exported so tests can record without dispatching events. */
export function recordError(kind: ErrorLogEntry['kind'], reason: unknown): void {
  try {
    let message = messageOf(reason).trim() || '(no message)';
    if (message.length > ERROR_MESSAGE_MAX) message = message.slice(0, ERROR_MESSAGE_MAX - 1) + '…';
    entries.push({ at: Date.now(), kind, message });
    if (entries.length > ERROR_LOG_CAPACITY) entries.shift();
    total++;
  } catch {
    // never let the logger throw from inside an error handler
  }
}

/** Start listening on `target`. Idempotent: a second call is a no-op. */
export function installErrorLog(target: Window = window): void {
  if (installed) return;
  installed = target;
  target.addEventListener('error', (e: ErrorEvent) => {
    recordError('error', e.error ?? e.message);
  });
  target.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    recordError('rejection', e.reason);
  });
}

/** The kept entries, oldest first, and how many were recorded in total. */
export function errorLog(): { entries: readonly ErrorLogEntry[]; total: number } {
  return { entries, total };
}

/** Test seam: forget every entry (the listeners stay). */
export function clearErrorLog(): void {
  entries.length = 0;
  total = 0;
}

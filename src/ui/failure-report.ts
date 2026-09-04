// The copyable diagnostic block behind a failed import's Copy button, and the
// truncated message the surface shows beside it. Pure formatting — it reads no
// DOM and writes no clipboard: see `specs/features/failure-report.md`.
import { MAX_ERRORS } from '../state/validate-utils';

declare const __APP_VERSION__: string;

/**
 * A failure worth putting on the clipboard.
 *
 * `errors` is the **complete** set, never the shortened list a dialog renders:
 * the reason this exists is that the two differ. The song validator collects up
 * to `MAX_ERRORS` (50) messages and the Import failed dialog shows eight of
 * them, so dismissing it used to destroy the rest (song-mode.md REQ-18).
 */
export interface FailureReport {
  /** The dialog's own title — becomes the report's first line. */
  title: string;
  /** Offending file or link name. Omitted → no `file:` line. */
  file?: string;
  /** Every message, uncapped by whatever the view shows. */
  errors: string[];
  /** The producer stopped at its own cap, so this list is itself incomplete. */
  capped?: boolean;
}

/** How many messages an alert bullets before it defers to the Copy button. */
const SHOWN_IN_ALERT = 8;

/**
 * True when a validator filled its error budget, so its own list is partial —
 * what `FailureReport.capped` wants (REQ-3). Every caller derives it the same
 * way, so it is derived in one place.
 */
export function isCapped(errors: string[]): boolean {
  return errors.length >= MAX_ERRORS;
}

/**
 * The bulleted message an alert shows: the first few, then a line that **names
 * the Copy button**. One implementation because that last sentence is a promise
 * the spec makes (song-mode.md REQ-18) — two copies of it drift, and the copy
 * this surface shows would stop matching the button it points at.
 */
export function failureMessage(lead: string, errors: string[]): string {
  const shown = errors.slice(0, SHOWN_IN_ALERT);
  const more = errors.length - shown.length;
  return `${lead}:\n• ` + shown.join('\n• ')
    + (more > 0 ? `\n…and ${more} more — use Copy errors for the full list` : '');
}

/**
 * Build the pasteable report. Pure apart from the timestamp — it reads no DOM,
 * writes no clipboard, and truncates nothing (failure-report.md REQ-1/REQ-4).
 * The caller hands the result to `alertDialog`'s `copyable` (dialog.md REQ-9).
 */
export function buildFailureReport(r: FailureReport): string {
  const n = r.errors.length;
  const lines = [`VAST G1-J8 ${__APP_VERSION__} — ${r.title}`, new Date().toISOString()];
  if (r.file) lines.push(`file: ${r.file}`);
  // Say so when the validator stopped walking, rather than presenting a capped
  // list as a complete one (REQ-3).
  lines.push(`${n} ${n === 1 ? 'error' : 'errors'}${r.capped ? ' (validator cap reached)' : ''}:`);
  if (n > 0) lines.push('', ...r.errors.map((e) => `• ${e}`));
  return lines.join('\n') + '\n';
}

/** Sugar for the common single-message failure (an exception, a decode error). */
export function buildFailureReportFor(title: string, message: string, file?: string): string {
  return buildFailureReport({ title, file, errors: [message] });
}

/**
 * The one report for a save the user asked for and the browser refused
 * (specs/features/storage-failures.md REQ-a-failed-save-says-so). Song Save,
 * preset Save, preset Import and a song import's slot write all come here, so
 * "not stored, and why" reads the same wherever it happens.
 */
import { alertDialog } from './components/dialog';
import { buildFailureReportFor, thrownMessage } from './failure-report';

/** A full quota, as Blink/WebKit and Gecko each name it. */
function isQuotaError(e: unknown): boolean {
  const name = typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

/** Why a write was refused, in words a player can act on. */
export function storageFailureReason(e: unknown): string {
  return isQuotaError(e)
    ? 'storage is full'
    : 'the browser would not store it';
}

/**
 * Say what was not stored. `message` names the thing and what happened to it;
 * the reason is appended, and the raw error is offered behind Copy.
 */
export function alertStorageFailure(opts: { title: string; message: string; error: unknown }): Promise<void> {
  const reason = storageFailureReason(opts.error);
  return alertDialog({
    title: opts.title,
    message: `${opts.message} — ${reason}.${isQuotaError(opts.error)
      ? '\n\nDeleting saved songs or presets you no longer need frees room.'
      : ''}`,
    copyable: buildFailureReportFor(opts.title, thrownMessage(opts.error)),
    copyLabel: 'Copy error',
  });
}

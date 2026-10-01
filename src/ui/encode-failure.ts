import type { ExportFormat } from '../audio/recorder/recorder-controller';
import { NOT_DOWNLOADED_YET, PLAY_OFFLINE_HINT } from './offline-wording';

/**
 * What to tell the user when a take or an export could not be written
 * (audio-export.md REQ-a-failed-encode-keeps-the-take). The one realistic cause is the MP3 encoder's
 * lazy chunk failing to load, so the sentence is the lazy-load one — offline
 * says the part is not downloaded yet, online that the download failed — in the
 * operation's own words (lazy-load-failure.md). One helper, so the Record
 * window and the export modal cannot word it differently.
 */
export function encodeFailureText(format: ExportFormat): string {
  if (format !== 'mp3') return "Couldn't write the file.";
  return navigator.onLine
    ? "Couldn't write the MP3 — the encoder failed to download. Try again, or save as WAV."
    : `Couldn't write the MP3 — ${NOT_DOWNLOADED_YET}. Save as WAV instead. ${PLAY_OFFLINE_HINT}`;
}

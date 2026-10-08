/**
 * The pre-read cap for a file arriving at an import door
 * (untrusted-input.md REQ-a-file-is-sized-before-it-is-read).
 *
 * A `File` already knows its size, so the check costs nothing while reading the
 * bytes costs all of them. Every file door — the Song panel's Import button, the
 * installed PWA's launchQueue and a file dropped on the window — asks this
 * before `arrayBuffer()`/`text()`. Pure and DOM-free: it takes the three fields
 * it needs, not a `File`, so it is testable under node.
 */
import { MAX_SONG_JSON_BYTES, MAX_ZIP_TOTAL_BYTES } from './limits';

export interface SizedFile {
  name: string;
  type: string;
  size: number;
}

/**
 * The byte cap a file is held to, decided from its name and MIME type alone. A
 * name that says neither kind gets the larger cap: its bytes decide what it is
 * (`sniffImportKind`), and refusing a real project on a guess is the worse failure.
 */
export function importCapFor(file: Pick<SizedFile, 'name' | 'type'>): number {
  const n = file.name.toLowerCase();
  if (n.endsWith('.zip') || file.type === 'application/zip') return MAX_ZIP_TOTAL_BYTES;
  if (n.endsWith('.json') || n.endsWith('.txt') || file.type === 'application/json') return MAX_SONG_JSON_BYTES;
  return Math.max(MAX_ZIP_TOTAL_BYTES, MAX_SONG_JSON_BYTES);
}

/** Why a file is refused before it is read, or `null` when it is within its cap. */
export function oversizedFileMessage(file: SizedFile): string | null {
  const cap = importCapFor(file);
  if (file.size <= cap) return null;
  return `"${file.name}" is larger than the ${Math.round(cap / (1024 * 1024))} MB limit.`;
}

/**
 * What a file arriving at an import door is, and the cap it is read under —
 * both decided before a byte is read
 * (untrusted-input.md REQ-a-file-is-sized-before-it-is-read).
 *
 * A `File` already knows its name, type and size, so these cost nothing while
 * reading the bytes costs all of them. Every file door — the Song panel's Import
 * button, the installed PWA's launchQueue and a file dropped on the window — asks
 * `oversizedFileMessage` before `arrayBuffer()`/`text()`, and the drop routes by
 * `fileKindOf`. One rule, so the kind a file is routed as and the cap it is held
 * to cannot disagree. Pure and DOM-free: it takes the fields it needs, not a
 * `File`, so it is testable under node.
 */
import { MAX_SONG_JSON_BYTES, MAX_ZIP_TOTAL_BYTES } from './limits';

export interface SizedFile {
  name: string;
  type: string;
  size: number;
}

/** What a file is, from its name and MIME type alone. */
export type FileKind = 'zip' | 'json' | 'audio' | 'other';

/** MIME types a browser reports for a zip (Chromium on Windows says the latter). */
const ZIP_TYPES = new Set(['application/zip', 'application/x-zip-compressed']);

export function fileKindOf(file: Pick<SizedFile, 'name' | 'type'>): FileKind {
  const n = file.name.toLowerCase();
  if (n.endsWith('.zip') || ZIP_TYPES.has(file.type)) return 'zip';
  if (n.endsWith('.json') || n.endsWith('.txt') || file.type === 'application/json') return 'json';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'other';
}

/**
 * The byte cap a file is held to. A file whose name and type say neither zip nor
 * JSON gets the larger cap: its bytes decide what it is (`sniffImportKind`), and
 * refusing a real project on a guess is the worse failure.
 */
export function importCapFor(file: Pick<SizedFile, 'name' | 'type'>): number {
  const kind = fileKindOf(file);
  if (kind === 'zip') return MAX_ZIP_TOTAL_BYTES;
  if (kind === 'json') return MAX_SONG_JSON_BYTES;
  return Math.max(MAX_ZIP_TOTAL_BYTES, MAX_SONG_JSON_BYTES);
}

/** Why a file is refused before it is read, or `null` when it is within its cap. */
export function oversizedFileMessage(file: SizedFile): string | null {
  const cap = importCapFor(file);
  if (file.size <= cap) return null;
  return `"${file.name}" is larger than the ${Math.round(cap / (1024 * 1024))} MB limit.`;
}

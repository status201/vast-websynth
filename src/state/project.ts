/**
 * Project bundle — a song plus its sampler audio clips in one
 * `<name>.websynth.zip` (project-export.md). Pure build/parse: no
 * AudioContext, no DOM beyond `Blob`, so it is unit-testable under jsdom.
 * The zip is a *container* around the existing canonical compact song JSON
 * (ADR-011) — `SongFile` itself is untouched. Clips are keyed by the slot
 * index in the entry name (`samples/<slot>-<name>.<ext>`), so there is no
 * manifest and no name-collision problem; `sampleNames` in `song.json`
 * remains the display-name source of truth.
 */
import { Song, type SongFile } from './song';
import { SAMPLER_SLOT_COUNT } from './patterns';
import { zipWrite, zipRead, ZipError, type ZipEntry } from '../utils/zip';
import { encodeWav, encodeMp3 } from '../audio/recorder/encode';
import type { CapturedAudio } from '../audio/recorder/node';

export type ClipExt = 'wav' | 'mp3';

/** A slot's encoded audio, ready to be zipped (data = the encoded file bytes). */
export interface ProjectClipOut {
  slot: number;
  data: Uint8Array;
  ext: ClipExt;
}

/** A clip pulled out of an imported zip. `data` is a view into the zip buffer —
 * copy (`.slice()`) before handing it to `decodeAudioData`, which detaches. */
export interface ProjectClipIn {
  slot: number;
  entryName: string;
  data: Uint8Array;
}

export type ProjectParse =
  | { ok: true; file: SongFile; clips: ProjectClipIn[] }
  | { ok: false; errors: string[] };

const SONG_ENTRY = 'song.json';
/** Tolerates folder nesting from an Explorer re-zip: match by path suffix. */
const SONG_RE = /(?:^|\/)song\.json$/i;
const CLIP_RE = /(?:^|\/)samples\/(\d+)-[^/]*\.(wav|mp3)$/i;

/**
 * Encode one slot's audio. The extension derives from the blob's MIME type,
 * never the requested format — `encodeMp3` silently falls back to WAV at
 * sample rates lamejs cannot handle (project-export.md REQ-4). Async because
 * the MP3 path lazily imports lamejs (audio-export.md REQ-7).
 */
export async function encodeClip(a: CapturedAudio, fmt: ClipExt): Promise<{ blob: Blob; ext: ClipExt }> {
  const blob = fmt === 'mp3'
    ? await encodeMp3(a.left, a.right, a.sampleRate)
    : encodeWav(a.left, a.right, a.sampleRate);
  return { blob, ext: blob.type === 'audio/mpeg' ? 'mp3' : 'wav' };
}

/** Entry-name-safe clip name: extension stripped, unsafe runs collapsed to _. */
function sanitizeClipName(name: string | null | undefined): string {
  const base = (name ?? '').replace(/\.[^.]*$/, '');
  return base.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 40) || 'clip';
}

export async function buildProjectZip(file: SongFile, clips: ProjectClipOut[]): Promise<Uint8Array> {
  const entries: ZipEntry[] = [
    { name: SONG_ENTRY, data: new TextEncoder().encode(Song.toJSON(file)) },
  ];
  for (const c of clips) {
    const name = sanitizeClipName(file.sampleNames?.[c.slot]);
    entries.push({ name: `samples/${c.slot}-${name}.${c.ext}`, data: c.data });
  }
  return zipWrite(entries);
}

export async function parseProjectZip(bytes: Uint8Array): Promise<ProjectParse> {
  let entries: ZipEntry[];
  try {
    entries = await zipRead(bytes);
  } catch (e) {
    return { ok: false, errors: [e instanceof ZipError ? e.message : 'Could not read the zip file.'] };
  }

  // Some Windows zippers (PowerShell's Compress-Archive) write backslash
  // separators — normalize before matching so a hand re-zip still imports.
  const nameOf = (e: ZipEntry): string => e.name.replace(/\\/g, '/');

  const songEntry = entries.find((e) => SONG_RE.test(nameOf(e)));
  if (!songEntry) {
    return { ok: false, errors: ['The zip does not contain a song.json.'] };
  }
  const res = Song.parse(new TextDecoder().decode(songEntry.data));
  if (!res.ok) return res;

  const clips: ProjectClipIn[] = [];
  for (const e of entries) {
    const m = CLIP_RE.exec(nameOf(e));
    if (!m) continue;
    const slot = Number(m[1]);
    if (slot >= SAMPLER_SLOT_COUNT) continue; // out-of-range slot: skip, never abort
    clips.push({ slot, entryName: nameOf(e), data: e.data });
  }
  return { ok: true, file: res.file, clips };
}

/** Download filename — Song.download's sanitize idiom + the project extension. */
export function projectFilename(songName: string): string {
  return `${songName.replace(/[^a-z0-9_-]+/gi, '_') || 'song'}.websynth.zip`;
}

/** Zip vs JSON import: PK magic bytes first, filename extension as fallback. */
export function sniffImportKind(head: Uint8Array, filename: string): 'zip' | 'json' {
  if (head.length >= 2 && head[0] === 0x50 && head[1] === 0x4b) return 'zip';
  return filename.toLowerCase().endsWith('.zip') ? 'zip' : 'json';
}

/**
 * The one import parse path (pwa-install.md REQ-7): sniff raw import bytes
 * and route to the project-zip or plain-JSON song parser. Pure — shared by
 * the Song panel's file input and the installed-PWA launchQueue consumer,
 * so an OS-opened song file behaves exactly like an Import-button import.
 * The JSON branch carries no clips.
 */
export async function parseSongOrProject(bytes: Uint8Array, filename: string): Promise<ProjectParse> {
  if (sniffImportKind(bytes.subarray(0, 4), filename) === 'zip') {
    return parseProjectZip(bytes);
  }
  const res = Song.parse(new TextDecoder().decode(bytes));
  return res.ok ? { ok: true, file: res.file, clips: [] } : res;
}

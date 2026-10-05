/**
 * Standard MIDI File reader + an arranger's analysis (midi-file-reader.md).
 *
 * Pure — no DOM, no Node — so the MCP song core re-exports it (mcp-server.md
 * REQ-song-core-entry-exports-only-pure-code). A .mid is untrusted input
 * (untrusted-input.md REQ-the-untrusted-surfaces-are-enumerated): every length
 * is checked against the bytes that remain before it is read, and nothing here
 * throws out of `parseMidiFile` (REQ-a-midi-parse-never-throws).
 */
import {
  MAX_MIDI_FILE_BYTES, MAX_MIDI_TRACKS, MAX_MIDI_BARS, MAX_MIDI_SUMMARY_BARS, MAX_MIDI_NAME_CHARS,
} from './limits';
import { GM_PROGRAMS, gmDrum } from './gm-names';

export interface MidiNote {
  tick: number;
  dur: number;
  note: number;
  velocity: number;
  /** 0-15, as on the wire. */
  channel: number;
  /** Index of the `MTrk` chunk it came from. */
  track: number;
}

export interface MidiFile {
  format: 0 | 1;
  ppq: number;
  trackNames: string[];
  tempos: { tick: number; bpm: number }[];
  meters: { tick: number; num: number; den: number }[];
  programs: { tick: number; channel: number; program: number }[];
  notes: MidiNote[];
}

export type MidiParse =
  | { ok: true; file: MidiFile; warnings: string[] }
  | { ok: false; errors: string[] };

/** A refusal raised inside the parser; `parseMidiFile` turns it into `{ok:false}`. */
class MidiError extends Error {}

const u16 = (b: Uint8Array, i: number): number => (b[i]! << 8) | b[i + 1]!;
const u32 = (b: Uint8Array, i: number): number =>
  ((b[i]! << 24) >>> 0) + ((b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!);
const tag = (b: Uint8Array, i: number): string =>
  String.fromCharCode(b[i]!, b[i + 1]!, b[i + 2]!, b[i + 3]!);

/** A variable-length quantity: at most 4 bytes, and never past `end`. */
function vlq(b: Uint8Array, i: number, end: number, where: string): [number, number] {
  let v = 0;
  for (let k = 0; k < 4; k++) {
    if (i >= end) throw new MidiError(`${where}: a length runs past the end of the track`);
    const c = b[i++]!;
    v = (v << 7) | (c & 0x7f);
    if (c < 0x80) return [v >>> 0, i];
  }
  throw new MidiError(`${where}: a variable-length number is longer than 4 bytes`);
}

/** Control characters out, length capped: a track name lands in an agent's context. */
const cleanName = (bytes: Uint8Array): string => {
  let s = '';
  for (const c of bytes) s += String.fromCharCode(c);
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, MAX_MIDI_NAME_CHARS);
};

interface Counters { overlaps: number; orphans: number; dangling: number; ignored: number }

function parseTrack(b: Uint8Array, start: number, end: number, t: number, file: MidiFile, n: Counters): void {
  const where = (i: number) => `track ${t + 1}, byte ${i}`;
  const open = new Map<number, { tick: number; vel: number }>();
  const close = (key: number, tick: number) => {
    const o = open.get(key);
    if (!o) return false;
    file.notes.push({ tick: o.tick, dur: tick - o.tick, note: key & 0x7f, velocity: o.vel, channel: key >> 7, track: t });
    open.delete(key);
    return true;
  };
  let i = start;
  let tick = 0;
  let run = -1;
  let named = false;
  while (i < end) {
    const [dt, at] = vlq(b, i, end, where(i));
    i = at;
    tick += dt;
    if (i >= end) throw new MidiError(`${where(i)}: an event runs past the end of the track`);
    const s = b[i]!;
    // REQ-smf-format-0-and-1-are-read: meta and sysex are skipped by length and cancel running status.
    if (s === 0xff) {
      if (i + 1 >= end) throw new MidiError(`${where(i)}: a meta event runs past the end of the track`);
      const type = b[i + 1]!;
      const [len, j] = vlq(b, i + 2, end, where(i));
      if (j + len > end) throw new MidiError(`${where(i)}: a meta event runs past the end of the track`);
      const d = b.subarray(j, j + len);
      if (type === 0x51 && len >= 3) {
        const us = (d[0]! << 16) | (d[1]! << 8) | d[2]!;
        if (us > 0) file.tempos.push({ tick, bpm: Math.round((60_000_000 / us) * 100) / 100 });
        else n.ignored++;
      } else if (type === 0x58 && len >= 2) {
        if (d[0]! > 0 && d[1]! <= 6) file.meters.push({ tick, num: d[0]!, den: 2 ** d[1]! });
        else n.ignored++;
      } else if (type === 0x03 && !named) {
        file.trackNames[t] = cleanName(d);
        named = true;
      }
      i = j + len;
      run = -1;
      if (type === 0x2f) break;
      continue;
    }
    if (s === 0xf0 || s === 0xf7) {
      const [len, j] = vlq(b, i + 1, end, where(i));
      if (j + len > end) throw new MidiError(`${where(i)}: a sysex message runs past the end of the track`);
      i = j + len;
      run = -1;
      continue;
    }
    if (s > 0xf0) throw new MidiError(`${where(i)}: unsupported status byte in a file`);
    if (s & 0x80) {
      run = s;
      i++;
    } else if (run < 0) {
      throw new MidiError(`${where(i)}: a data byte has no status before it`);
    }
    const st = run & 0xf0;
    const ch = run & 0x0f;
    const size = st === 0xc0 || st === 0xd0 ? 1 : 2;
    if (i + size > end) throw new MidiError(`${where(i)}: an event runs past the end of the track`);
    const d1 = b[i]!;
    const d2 = size === 2 ? b[i + 1]! : 0;
    if (d1 > 0x7f || d2 > 0x7f) throw new MidiError(`${where(i)}: a data byte is out of range`);
    i += size;
    const key = (ch << 7) | d1;
    // REQ-notes-pair-per-channel-and-pitch
    if (st === 0x90 && d2 > 0) {
      if (close(key, tick)) n.overlaps++;
      open.set(key, { tick, vel: d2 });
    } else if (st === 0x80 || st === 0x90) {
      if (!close(key, tick)) n.orphans++;
    } else if (st === 0xc0) {
      file.programs.push({ tick, channel: ch, program: d1 });
    }
  }
  for (const key of [...open.keys()]) {
    close(key, tick);
    n.dangling++;
  }
}

function parse(b: Uint8Array): MidiParse {
  // REQ-a-midi-file-is-bounded: the byte cap comes before any parsing.
  if (b.length > MAX_MIDI_FILE_BYTES) {
    throw new MidiError(`the file is ${b.length} bytes; the limit is ${MAX_MIDI_FILE_BYTES}`);
  }
  if (b.length < 14 || tag(b, 0) !== 'MThd') {
    throw new MidiError('not a Standard MIDI File: it must start with "MThd"');
  }
  const hdrLen = u32(b, 4);
  if (hdrLen < 6 || 8 + hdrLen > b.length) throw new MidiError('the MThd header chunk is malformed');
  const format = u16(b, 8);
  const division = u16(b, 12);
  if (format === 2) throw new MidiError('format 2 (independent sequences) is not supported');
  if (format > 2) throw new MidiError(`unknown MIDI file format ${format}`);
  if (division & 0x8000) throw new MidiError('SMPTE time division is not supported, only ticks per quarter note');
  if (division === 0) throw new MidiError('the file declares 0 ticks per quarter note');

  const file: MidiFile = {
    format: format as 0 | 1, ppq: division, trackNames: [], tempos: [], meters: [], programs: [], notes: [],
  };
  const n: Counters = { overlaps: 0, orphans: 0, dangling: 0, ignored: 0 };
  let pos = 8 + hdrLen;
  let tracks = 0;
  while (pos + 8 <= b.length) {
    const id = tag(b, pos);
    const len = u32(b, pos + 4);
    if (pos + 8 + len > b.length) throw new MidiError(`the chunk at byte ${pos} runs past the end of the file`);
    if (id === 'MTrk') {
      if (tracks >= MAX_MIDI_TRACKS) throw new MidiError(`more than ${MAX_MIDI_TRACKS} tracks`);
      file.trackNames[tracks] = '';
      parseTrack(b, pos + 8, pos + 8 + len, tracks, file, n);
      tracks++;
    }
    pos += 8 + len;
  }
  if (tracks === 0) throw new MidiError('the file has no MTrk track chunks');

  const byTick = (a: { tick: number }, c: { tick: number }) => a.tick - c.tick;
  file.tempos.sort(byTick);
  file.meters.sort(byTick);
  file.programs.sort(byTick);
  file.notes.sort((a, c) => a.tick - c.tick || a.note - c.note);

  const warnings: string[] = [];
  if (n.overlaps) warnings.push(`${n.overlaps} note(s) restarted while still sounding; each was closed at the new onset`);
  if (n.orphans) warnings.push(`${n.orphans} note-off(s) had no note to close and were ignored`);
  if (n.dangling) warnings.push(`${n.dangling} note(s) were still sounding at the end of their track and were closed there`);
  if (n.ignored) warnings.push(`${n.ignored} tempo/time-signature event(s) were out of range and ignored`);
  return { ok: true, file, warnings };
}

/** Parse a Standard MIDI File. Never throws (REQ-a-midi-parse-never-throws). */
export function parseMidiFile(bytes: Uint8Array): MidiParse {
  try {
    return parse(bytes);
  } catch (e) {
    return { ok: false, errors: [e instanceof MidiError ? e.message : 'not a readable MIDI file'] };
  }
}

/* ------------------------------------------------------------------ analysis */

export interface MidiAnalyzeOptions {
  /** 1-based, inclusive. Default: the first bar with a note. */
  fromBar?: number;
  toBar?: number;
  /** MIDI channels 1-16 to list; default all. */
  channels?: number[];
}

export interface MidiChannelSummary {
  channel: number;
  instrument: string;
  notes: number;
  range: string;
  maxPolyphony: number;
  grid: string;
  drums?: { note: number; name: string; count: number; websynth: string | null }[];
}

export interface MidiAnalysis {
  ok: true;
  format: 0 | 1;
  ppq: number;
  bars: number;
  firstSoundingBar: number;
  tempo: { bpm: number; changes: { bar: number; bpm: number }[] };
  meter: { first: string; changes: { bar: number; meter: string }[] };
  grid: { divisions: number | 'free'; label: string; offGrid16: number };
  suggestion: string;
  tracks: { index: number; name: string; notes: number }[];
  channels: MidiChannelSummary[];
  distinctBars: { all: number; byChannel: Record<string, number> };
  repeats: { bars: number[] }[];
  window: { fromBar: number; toBar: number; truncated: boolean; nextBar?: number };
  listing: { bar: number; meter?: string; channels: Record<string, string> }[];
}

export type MidiAnalysisResult = MidiAnalysis | { ok: false; errors: string[] };

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n: number): string => `${NOTE_NAMES[n % 12]!}${Math.floor(n / 12) - 1}`;
const DRUM_CHANNEL = 9;

/** REQ-the-grid-is-the-coarsest-that-holds-every-onset: divisions per quarter, coarsest first. */
const DIVISIONS = [1, 2, 3, 4, 6, 8, 12, 16, 24] as const;
const GRID_LABEL: Record<number, string> = {
  1: '1/4', 2: '1/8', 3: '1/8T', 4: '1/16', 6: '1/16T', 8: '1/32', 12: '1/32T', 16: '1/64', 24: '1/64T',
};
/** The `seq.rate` index for a grid the sequencer can step at (params.ts value map). */
const SEQ_RATE: Record<number, number> = { 1: 8, 2: 5, 3: 3, 4: 2, 6: 1, 8: 0 };

function gridOf(ticks: number[], ppq: number): { divisions: number | 'free'; label: string; offGrid16: number } {
  const on = (t: number, d: number) => ((t % ppq) * d) % ppq === 0;
  const offGrid16 = ticks.filter((t) => !on(t, 4)).length;
  for (const d of DIVISIONS) {
    if (ticks.every((t) => on(t, d))) return { divisions: d, label: GRID_LABEL[d]!, offGrid16 };
  }
  return { divisions: 'free', label: 'free (not on any grid down to 1/64T)', offGrid16 };
}

/** Two decimals, no trailing zeros. */
const fmt = (x: number): string => String(Math.round(x * 100) / 100);

function suggest(grid: { divisions: number | 'free'; label: string }, num: number, den: number): string {
  if (grid.divisions === 'free') {
    return 'onsets are off every musical grid (a live performance?): quantize to 1/16 when writing steps.';
  }
  const rate = SEQ_RATE[grid.divisions];
  if (rate === undefined) {
    return `the file needs ${grid.label}, finer than the sequencer's 1/32 step: quantize to 1/32 or 1/16 when writing steps.`;
  }
  const cells = ((4 * num) / den) * grid.divisions;
  if (!Number.isInteger(cells)) {
    return `at ${grid.label} a ${num}/${den} bar is ${fmt(cells)} cells, not a whole number: use a finer seq.rate.`;
  }
  if (cells > 16) {
    return `at ${grid.label} (seq.rate ${rate}) a ${num}/${den} bar is ${cells} cells, more than a bank's 16: split each bar over two banks, or quantize coarser.`;
  }
  const perBank = Math.floor(16 / cells);
  return `every onset fits ${grid.label}: seq.rate ${rate} makes a ${num}/${den} bar ${cells} cells, so seq.len ${perBank * cells} holds ${perBank} bar${perBank > 1 ? 's' : ''} per bank` +
    // The lane's cells run from song bar 1, so a k-bar bank must start on bar 1, 1+k, 1+2k…
    (perBank > 1
      ? ` (list the bank ${perBank} times in seqChain, once per bar, and start it on bar 1, ${1 + perBank}, ${1 + 2 * perBank}…).`
      : '.');
}

/** Analyse a parsed file for an arranger (midi-file-reader.md). */
export function analyzeMidi(file: MidiFile, opts: MidiAnalyzeOptions = {}): MidiAnalysisResult {
  const { ppq, notes } = file;
  const six = ppq / 4;
  const endTick = notes.reduce((m, x) => Math.max(m, x.tick + x.dur, x.tick + 1), 0);

  // REQ-bars-follow-the-file-meter + REQ-a-midi-file-is-bounded: the map is capped while it is built.
  const starts: number[] = [];
  const barMeter: string[] = [];
  let cur = { num: 4, den: 4 };
  let mi = 0;
  for (let t = 0; t < endTick || starts.length === 0;) {
    while (mi < file.meters.length && file.meters[mi]!.tick <= t) cur = file.meters[mi++]!;
    if (starts.length >= MAX_MIDI_BARS) {
      return { ok: false, errors: [`the file is longer than ${MAX_MIDI_BARS} bars`] };
    }
    starts.push(t);
    barMeter.push(`${cur.num}/${cur.den}`);
    t += (ppq * 4 * cur.num) / cur.den;
  }
  const barOf = (tick: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= tick) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const bars = notes.length ? starts.length : 0;

  // Parts (REQ-the-analysis-names-the-parts).
  const used = [...new Set(notes.map((x) => x.channel))].sort((a, c) => a - c);
  const channels: MidiChannelSummary[] = used.map((ch) => {
    const mine = notes.filter((x) => x.channel === ch);
    const first = mine[0]!.tick;
    const progs = file.programs.filter((p) => p.channel === ch);
    const prog = [...progs].reverse().find((p) => p.tick <= first) ?? progs[0];
    const pitches = mine.map((x) => x.note);
    const edges = mine.flatMap((x) => [[x.tick, 1], [x.tick + x.dur, -1]] as const)
      .sort((a, c) => a[0] - c[0] || a[1] - c[1]);
    let poly = 0;
    let maxPolyphony = 0;
    for (const [, d] of edges) maxPolyphony = Math.max(maxPolyphony, (poly += d));
    const summary: MidiChannelSummary = {
      channel: ch + 1,
      instrument: ch === DRUM_CHANNEL ? 'drums' : GM_PROGRAMS[prog?.program ?? 0]!,
      notes: mine.length,
      // A loop, not Math.min(...pitches): a file at the byte cap holds ~170k notes,
      // more arguments than a spread call can take.
      range: `${noteName(pitches.reduce((a, c) => Math.min(a, c)))}-${noteName(pitches.reduce((a, c) => Math.max(a, c)))}`,
      maxPolyphony,
      grid: gridOf(mine.map((x) => x.tick), ppq).label,
    };
    if (ch === DRUM_CHANNEL) {
      const count = new Map<number, number>();
      for (const p of pitches) count.set(p, (count.get(p) ?? 0) + 1);
      summary.drums = [...count].sort((a, c) => a[0] - c[0]).map(([note, c]) => {
        const g = gmDrum(note);
        return { note, name: g?.name ?? noteName(note), count: c, websynth: g?.websynth ?? null };
      });
    }
    return summary;
  });

  const grid = gridOf(notes.map((x) => x.tick), ppq);
  const meterAt = (m?: { num: number; den: number }) => (m ? `${m.num}/${m.den}` : '4/4');
  const firstMeter = file.meters[0] && file.meters[0].tick === 0 ? file.meters[0] : { num: 4, den: 4 };
  const firstTempo = file.tempos[0] && file.tempos[0].tick === 0 ? file.tempos[0].bpm : 120;

  // Per-bar tokens (REQ-the-listing-is-a-window-of-bars) and repeat keys (REQ-repeats-are-grouped).
  const want = opts.channels?.length ? new Set(opts.channels.map((c) => c - 1)) : null;
  const shown = used.filter((ch) => !want || want.has(ch));
  const tokens: Map<number, string[]>[] = Array.from({ length: bars }, () => new Map());
  const keys: Map<number, string[]>[] = Array.from({ length: bars }, () => new Map());
  const ordered = [...notes].sort((a, c) => a.tick - c.tick || c.note - a.note);
  for (const x of ordered) {
    if (want && !want.has(x.channel)) continue;
    const bar = barOf(x.tick);
    const pos = fmt((x.tick - starts[bar - 1]!) / six);
    const name = x.channel === DRUM_CHANNEL
      ? (gmDrum(x.note)?.name.replace(/[^A-Za-z0-9]/g, '') ?? noteName(x.note))
      : noteName(x.note);
    const len = x.dur / six;
    const t = tokens[bar - 1]!;
    const k = keys[bar - 1]!;
    if (!t.has(x.channel)) { t.set(x.channel, []); k.set(x.channel, []); }
    t.get(x.channel)!.push(`${pos}:${name}/${fmt(len)}`);
    // Onset and pitch only: a release is articulation, not a different bank (REQ-repeats-are-grouped).
    k.get(x.channel)!.push(`${pos}:${name}`);
  }

  const groups = new Map<string, number[]>();
  const byChannel: Record<string, Set<string>> = {};
  for (let i = 0; i < bars; i++) {
    const k = keys[i]!;
    if (!k.size) continue;
    const whole = shown.map((ch) => `${ch}=${(k.get(ch) ?? []).join(' ')}`).join('|');
    groups.set(whole, [...(groups.get(whole) ?? []), i + 1]);
    for (const [ch, list] of k) (byChannel[String(ch + 1)] ??= new Set()).add(list.join(' '));
  }
  const repeats = [...groups.values()].filter((g) => g.length > 1).map((g) => ({ bars: g }));

  // The window.
  const firstSoundingBar = notes.length ? barOf(notes[0]!.tick) : 0;
  const fromBar = Math.max(1, Math.floor(opts.fromBar ?? (firstSoundingBar || 1)));
  let toBar = Math.min(bars, Math.floor(opts.toBar ?? bars));
  let truncated = false;
  if (toBar - fromBar + 1 > MAX_MIDI_SUMMARY_BARS) {
    toBar = fromBar + MAX_MIDI_SUMMARY_BARS - 1;
    truncated = true;
  }
  const listing: MidiAnalysis['listing'] = [];
  for (let bar = fromBar; bar <= toBar; bar++) {
    const entry: MidiAnalysis['listing'][number] = { bar, channels: {} };
    const m = barMeter[bar - 1]!;
    if (bar === 1 ? m !== '4/4' : m !== barMeter[bar - 2]) entry.meter = m;
    for (const [ch, list] of tokens[bar - 1]!) entry.channels[String(ch + 1)] = list.join(' ');
    listing.push(entry);
  }

  return {
    ok: true,
    format: file.format,
    ppq,
    bars,
    firstSoundingBar,
    tempo: {
      bpm: firstTempo,
      changes: file.tempos.filter((x, i) => x.tick > 0 && x.bpm !== (file.tempos[i - 1]?.bpm ?? 120))
        .map((x) => ({ bar: barOf(x.tick), bpm: x.bpm })),
    },
    meter: {
      first: `${firstMeter.num}/${firstMeter.den}`,
      // A re-stated signature is not a change (exports repeat 4/4 on every track).
      changes: file.meters
        .filter((x, i) => x.tick > 0 && `${x.num}/${x.den}` !== meterAt(file.meters[i - 1]))
        .map((x) => ({ bar: barOf(x.tick), meter: `${x.num}/${x.den}` })),
    },
    grid,
    suggestion: notes.length ? suggest(grid, firstMeter.num, firstMeter.den) : 'the file has no notes.',
    tracks: file.trackNames.map((name, i) => ({ index: i + 1, name, notes: notes.filter((x) => x.track === i).length })),
    channels,
    distinctBars: {
      all: groups.size,
      byChannel: Object.fromEntries(Object.entries(byChannel).map(([ch, s]) => [ch, s.size])),
    },
    repeats,
    window: truncated ? { fromBar, toBar, truncated, nextBar: toBar + 1 } : { fromBar, toBar, truncated },
    listing,
  };
}

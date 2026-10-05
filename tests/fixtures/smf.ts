// A tiny Standard MIDI File writer for tests (midi-file-reader.md): every file a
// test reads is built here, byte by byte, so no binary fixture is checked in and
// each test shows exactly what it feeds the parser.

export const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
export const u32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

/** A MIDI variable-length quantity. */
export function vlq(n: number): number[] {
  const out = [n & 0x7f];
  for (n >>>= 7; n; n >>>= 7) out.unshift((n & 0x7f) | 0x80);
  return out;
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

export const chunk = (id: string, body: number[]): number[] => [...ascii(id), ...u32(body.length), ...body];
export const header = (format: number, tracks: number, division: number): number[] =>
  chunk('MThd', [...u16(format), ...u16(tracks), ...u16(division)]);

/** One event: its delta time, then its raw bytes (status may be omitted for running status). */
export type Ev = [delta: number, ...bytes: number[]];

/** An `MTrk` chunk; appends end-of-track unless told not to. */
export const track = (events: Ev[], endOfTrack = true): number[] =>
  chunk('MTrk', [...events.flatMap(([d, ...b]) => [...vlq(d), ...b]), ...(endOfTrack ? [0, 0xff, 0x2f, 0] : [])]);

export const smf = (...parts: number[][]): Uint8Array => new Uint8Array(parts.flat());

export const on = (ch: number, note: number, vel = 100): number[] => [0x90 | ch, note, vel];
export const off = (ch: number, note: number): number[] => [0x80 | ch, note, 0];
export const program = (ch: number, p: number): number[] => [0xc0 | ch, p];
export function tempo(bpm: number): number[] {
  const us = Math.round(60_000_000 / bpm);
  return [0xff, 0x51, 3, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff];
}
/** Time signature: numerator and the denominator's power of two (2 = quarter). */
export const meter = (num: number, denPow: number): number[] => [0xff, 0x58, 4, num, denPow, 24, 8];
export const trackName = (s: string): number[] => [0xff, 0x03, ...vlq(s.length), ...ascii(s)];

/**
 * A format-0 file of `[tick, dur, note, channel?]` notes, absolute ticks, at
 * `ppq` (default 96: a sixteenth is 24 ticks, a 4/4 bar 384), plus any meta
 * events at their own absolute ticks.
 */
export function notesFile(
  notes: [number, number, number, number?][], ppq = 96, metas: [number, number[]][] = [],
): Uint8Array {
  const events: [number, number[]][] = [...metas];
  for (const [t, d, n, ch = 0] of notes) {
    events.push([t, on(ch, n)]);
    events.push([t + d, off(ch, n)]);
  }
  // Offs before ons at the same tick, so a repeated pitch closes before it reopens.
  events.sort((a, b) => a[0] - b[0] || (a[1][0]! & 0xf0) - (b[1][0]! & 0xf0));
  let last = 0;
  const evs: Ev[] = [];
  for (const [t, bytes] of events) {
    evs.push([t - last, ...bytes]);
    last = t;
  }
  return smf(header(0, 1, ppq), track(evs));
}

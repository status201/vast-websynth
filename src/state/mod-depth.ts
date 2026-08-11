import { LFO_DEST_LABELS } from './params';
import { MOD_ROWS, MOD_DST, MOD_SRC, MOD_DEST_SCALE } from './mod-routing';

/**
 * How far modulation can move a given faceplate param — mod-matrix.md REQ-8.
 *
 * This is what lets a knob draw the **range** modulation can take it over, computed
 * from the route params alone. No audio-thread readback, nothing per frame: the answer
 * changes only when a route changes. Showing where modulation *currently* is would
 * need a port message per frame and a per-voice answer (`filter env` has eight), which
 * is why the arc shows reach rather than position.
 *
 * Lives in `state/` beside the routing rule so the UI never reaches into `audio/`.
 */

/**
 * The faceplate param each destination shows on — only where one exists.
 *
 * `pitch`, `amp` and `pan` are absent on purpose: no single knob owns them (pitch is
 * three oscillator detunes, amp is the tremolo VCA, pan is the bus panner), so there
 * is nothing to draw an arc on.
 */
const DEST_PARAM: Record<number, string> = {
  [MOD_DST.cutoff]: 'filter.cutoff',
  [MOD_DST.resonance]: 'filter.resonance',
  [MOD_DST.shape]: 'filter.shape',
  [MOD_DST.drive]: 'filter.drive',
};

/**
 * The same for an LFO row, which carries **its own** depth scalars — the LFO reaches
 * ±24 semitones of cutoff where a matrix route reaches ±48 (lfo.md REQ-13). Keyed by
 * destination *name* because `LFO_DEST_LABELS` and `MOD_DEST_LABELS` are two
 * independently append-only arrays whose indices do not line up.
 */
const LFO_DEST: Record<string, { param: string; scale: number }> = {
  cutoff: { param: 'filter.cutoff', scale: 24 },
  shape: { param: 'filter.shape', scale: 0.5 },
};

/** Params that can be a modulation destination — the gate a Knob checks before it
 *  bothers subscribing to any of this. */
export function isModDestParam(id: string): boolean {
  if (Object.values(DEST_PARAM).includes(id)) return true;
  return Object.values(LFO_DEST).some((d) => d.param === id);
}

/**
 * Every param a change to which could move `paramId`'s arc — what a Knob subscribes
 * to. Empty for a param nothing can modulate, so the overwhelming majority of knobs
 * subscribe to nothing at all.
 */
export function modDepthDeps(paramId: string): string[] {
  if (!isModDestParam(paramId)) return [];
  const out: string[] = [];
  for (let n = 0; n < MOD_ROWS; n++) out.push(`mod.${n}.src`, `mod.${n}.dst`, `mod.${n}.amt`);
  for (const p of ['lfo', 'lfo2']) out.push(`${p}.dest`, `${p}.amount`);
  out.push('master.modWheel');
  return out;
}

/**
 * Total reach, in `paramId`'s own units, of every route currently pointed at it.
 *
 * Depths **add** — two routes on one destination sum in the audio graph, so the range
 * they can reach between them is the sum of their magnitudes. Sign is dropped: a
 * bipolar route swings both ways, and so does the arc.
 *
 * `read` rather than a `ParamBus` so this stays pure and testable.
 */
/**
 * Where modulation currently *has* this param, in its own units — but only from
 * sources the main thread already knows the value of, and `null` when there are none.
 *
 * Today that means exactly one source: the **mod wheel**. The distinction is not
 * arbitrary. The LFOs, the envelopes and random live on the audio thread, so reading
 * their instantaneous value would cost a port message per frame; the envelopes and
 * velocity are additionally **per-voice**, so "where is it now?" has eight different
 * answers. The mod wheel is a `ParamBus` param — its value is already here, exactly,
 * for free — and it is the one source a player is physically holding, so it is also
 * the one where a static band reads as a broken feature.
 *
 * Signed, unlike `modDepthFor`: a negative amount moves the marker the other way.
 * The wheel's own contribution to LFO 1's *depth* (lfo.md REQ-11) is deliberately not
 * counted here — that widens the band, which `modDepthFor` already shows, and adding
 * it again would double-count one gesture.
 */
export function modOffsetFor(paramId: string, read: (id: string) => number): number | null {
  let offset = 0;
  let found = false;

  for (let n = 0; n < MOD_ROWS; n++) {
    if (Math.round(read(`mod.${n}.src`)) !== MOD_SRC.modWheel) continue;
    const dst = Math.round(read(`mod.${n}.dst`));
    if (DEST_PARAM[dst] !== paramId) continue;
    found = true;
    offset += read('master.modWheel') * read(`mod.${n}.amt`) * (MOD_DEST_SCALE[dst] ?? 0);
  }

  return found ? offset : null;
}

/**
 * Which way the routes on this param push: `-1` when **every** contributing route is
 * negative, `1` when every one is positive, `0` when they are mixed or there are none.
 *
 * This is what lets a faceplate knob show an inverted route without the matrix window
 * open (mod-matrix.md REQ-13) — the case that motivated the colour in the first place.
 *
 * Deliberately unanimous rather than a sum of signs: with one route up and one down,
 * "the modulation is negative" is not a true statement about the knob, and a colour
 * that claimed it would be worse than no colour. Mixed stays neutral.
 */
export function modSignFor(paramId: string, read: (id: string) => number): -1 | 0 | 1 {
  let pos = false;
  let neg = false;

  for (let n = 0; n < MOD_ROWS; n++) {
    if (Math.round(read(`mod.${n}.src`)) === MOD_SRC.off) continue;
    if (DEST_PARAM[Math.round(read(`mod.${n}.dst`))] !== paramId) continue;
    const amt = read(`mod.${n}.amt`);
    if (amt > 0) pos = true;
    else if (amt < 0) neg = true;
  }

  // An LFO row's depth is `lfo.amount`, which is 0..1 — it can never be negative, so
  // an active one only ever counts as positive.
  for (const prefix of ['lfo', 'lfo2']) {
    const name = LFO_DEST_LABELS[Math.round(read(`${prefix}.dest`))];
    const d = name === undefined ? undefined : LFO_DEST[name];
    if (d && d.param === paramId && read(`${prefix}.amount`) > 0) pos = true;
  }

  if (neg && !pos) return -1;
  if (pos && !neg) return 1;
  return 0;
}

export function modDepthFor(paramId: string, read: (id: string) => number): number {
  let depth = 0;

  for (let n = 0; n < MOD_ROWS; n++) {
    if (Math.round(read(`mod.${n}.src`)) === MOD_SRC.off) continue;
    const dst = Math.round(read(`mod.${n}.dst`));
    if (DEST_PARAM[dst] !== paramId) continue;
    depth += Math.abs(read(`mod.${n}.amt`)) * (MOD_DEST_SCALE[dst] ?? 0);
  }

  for (const prefix of ['lfo', 'lfo2']) {
    const name = LFO_DEST_LABELS[Math.round(read(`${prefix}.dest`))];
    const d = name === undefined ? undefined : LFO_DEST[name];
    if (!d || d.param !== paramId) continue;
    // The mod wheel adds into LFO 1's depth (lfo.md REQ-11), so it widens the reach
    // exactly as the AMT knob does — the arc has to agree with what is heard.
    const wheel = prefix === 'lfo' ? read('master.modWheel') : 0;
    depth += Math.min(1, read(`${prefix}.amount`) + wheel) * d.scale;
  }

  return depth;
}

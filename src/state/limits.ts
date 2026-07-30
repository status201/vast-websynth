/**
 * Bounds for everything that arrives from outside the app
 * (specs/features/untrusted-input.md, ADR-015).
 *
 * A song is a *shareable document* — it travels as a `#song=` URL, a file, a
 * pasted AI reply or a `.websynth.zip`, and the link forms apply at boot with no
 * user interaction. So every payload is authored by someone else, and ADR-003
 * (zero runtime dependencies) means no library sets a sane default limit on our
 * behalf: every bound is ours to write down, and this is where they are written.
 *
 * Sized against the demo corpus **plus generous headroom**, deliberately: a limit
 * is a compatibility surface, and refusing a real song is a worse failure than
 * accepting a slightly silly one. Raising a limit later is additive and safe;
 * lowering one is a breaking change (ADR-007's treatment applies).
 */

/** Decoded `#song=` payload / fetched `songUrl` body. The largest demo is ~2 orders below. */
export const MAX_SONG_JSON_BYTES = 8 * 1024 * 1024;

/** One decompressed zip entry — a sampler clip is a multi-MB WAV. */
export const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;

/** Summed across all entries of one zip: 8 slots of clip audio plus headroom. */
export const MAX_ZIP_TOTAL_BYTES = 256 * 1024 * 1024;

/** Central-directory entry count: 8 clips + song.json + folder entries, generously. */
export const MAX_ZIP_ENTRIES = 64;

/** A WebRTC signalling blob (`WS2.…`) or a scanned QR. A deflated SDP is ~700 bytes. */
export const MAX_SIGNAL_BYTES = 256 * 1024;

/** Arrangement chain length. 1024 bars is ~34 minutes at 120 BPM. */
export const MAX_CHAIN_STEPS = 1024;

/** `{enabled, steps: {enabled, steps: …}}` nesting in the authoring dialect. */
export const MAX_CHAIN_DEPTH = 8;

/** Keys in a `params` map. The bus registers ~150; unknown ids are kept (ADR-007). */
export const MAX_PARAM_KEYS = 512;

/** MIDI note range. `midiToHz(1e6)` is Infinity, and a non-finite AudioParam write throws. */
export const MIDI_NOTE_MIN = 0;
export const MIDI_NOTE_MAX = 127;

/**
 * Keys a payload may never carry. `PatternStore.restore` does
 * `Object.assign(cell, DEFAULTS, parsedCell)`, and `Object.assign` uses [[Set]] —
 * so a `__proto__` key from `JSON.parse` re-points the destination cell's
 * prototype. Today every field read by the audio layer is an own property from
 * the defaults, so the swap is shadowed and inert; that is a coincidence of the
 * defaults covering every field, not a guarantee. Refusing the key here is what
 * makes it a guarantee.
 */
export const RESERVED_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/** Whether an object parsed from a payload carries any {@link RESERVED_KEYS}. */
export function reservedKeyIn(o: object): string | null {
  for (const k of RESERVED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(o, k)) return k;
  }
  return null;
}

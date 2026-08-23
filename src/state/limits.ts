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

/**
 * Per-slot arrangement transpose, in semitones (arrangement.md REQ-8).
 * ±2 octaves — the same span as `drum.t*.tune`, and enough for any progression.
 * Kept modest deliberately: the offset is added to a stored note before the
 * `MIDI_NOTE_MIN/MAX` clamp, so a huge range would just clamp into silence at
 * the edges while making the UI's readout wider for no musical gain.
 */
export const MAX_CHAIN_TRANSPOSE = 24;

/**
 * Transport position, in 16th-note ticks (transport.md REQ-10).
 *
 * `Clock._step` used to be masked with `& 0xffff`, which doubled as its bound.
 * That wrap was only phase-safe for bar lengths dividing 65536 — i.e. powers of
 * two — so meter.md REQ-4 had to remove it, and the bound moved here. `2**31` is
 * ~8.5 years of 16ths at 120 BPM: a guard rail against a hostile `seek`, not a
 * limit any song can reach.
 */
export const MAX_STEP = 2 ** 31;

/** Keys in a `params` map. The bus registers ~150; unknown ids are kept (ADR-007). */
export const MAX_PARAM_KEYS = 512;

/**
 * The public MCP endpoint (untrusted-input.md REQ-14, ADR-020). Everything above
 * is sized *generously* — refusing a real song is the worse failure. These four
 * are sized the other way, and the difference is deliberate: every other surface
 * is reached by a user who chose to open something, while
 * `https://vast.status201.com/mcp` is authless and reachable by anyone forever.
 * There a limit is not a compatibility surface, it is the only defence, so it
 * costs nothing to be tight and it costs real money to be loose.
 */

/**
 * One `POST /mcp` body. An eighth of {@link MAX_SONG_JSON_BYTES}: a public
 * endpoint pays CPU for everything it parses, and no authored song is near
 * either number. Enforced against a *running* count while the socket is read,
 * per REQ-2 — a cap applied after buffering has already spent the memory.
 */
export const MAX_MCP_REQUEST_BYTES = 1024 * 1024;

/** Per-IP fixed-window request budget. */
export const MAX_MCP_REQUESTS_PER_MINUTE = 60;

/**
 * IPs the rate limiter may track at once, after which it evicts.
 *
 * The limiter is itself a payload-reachable data structure: it allocates one
 * entry per caller-chosen key, so without this it is a memory-exhaustion vector
 * wearing a defence's clothes. ADR-015's rule applies to the guard as much as to
 * the thing guarded.
 */
export const MAX_MCP_RATE_KEYS = 10_000;

/** Wall clock for one MCP request, socket to response. */
export const MAX_MCP_REQUEST_MS = 15_000;

/** MIDI note range. `midiToHz(1e6)` is Infinity, and a non-finite AudioParam write throws. */
export const MIDI_NOTE_MIN = 0;
export const MIDI_NOTE_MAX = 127;

/**
 * Per-step micro-timing resolution: notches per **cell** (step-settings.md REQ-6).
 * 24 makes a 1/384 note at the default lane rate — the same grid Elektron's Micro
 * Timing uses — and, unlike 16, puts the triplet positions exactly on a notch
 * (`8/24` is a third of a cell).
 */
export const MICRO_UNITS = 24;

/**
 * The bound on `micro`, in notches: half a cell either way (step-settings.md
 * REQ-7). Chosen because it is exactly the point at which a fully-late step and
 * the fully-early step after it *meet* rather than **cross** — which is what keeps
 * the ducker's `when < onset` guard and the sequencer's mono release ordering
 * correct with no extra machinery. It is the same bound, for the same reason, that
 * swing uses to stop an off-beat crossing the next on-beat (transport.md REQ-11).
 */
export const MICRO_MAX = 12;

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

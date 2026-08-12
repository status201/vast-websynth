import type { ParamId } from './params';
import type { Snapshot } from './preset';

/** The sound a loaded song brought with it, kept selectable (presets.md REQ-13). */
export interface SongSound {
  /** The song's name — the label of the pinned dropdown entry. */
  name: string;
  /** Its patch params only, as `patchSnapshot` defines them. */
  patch: Snapshot;
}

/**
 * Tracks the *active sound* shown in the header preset selector: a label
 * (preset or song name) plus a dirty flag set once the user edits the synth
 * patch away from it. Pure + DOM-free so the UI can subscribe and the logic
 * stays unit-testable. UI and audio are unaffected — this only drives the
 * selector's displayed text.
 *
 * Since presets.md REQ-13 it also holds the loaded song's **sound**, so the
 * selector can offer it as an option instead of only naming it: auditioning a
 * preset against a demo used to destroy the demo's patch with no way back.
 */
export class PresetSession {
  private _label = '';
  private _dirty = false;
  private _songSound: SongSound | null = null;
  private readonly listeners = new Set<() => void>();

  get label(): string {
    return this._label;
  }

  get dirty(): boolean {
    return this._dirty;
  }

  /** Text for the selector: the label, with a `*` marker once edited. */
  get display(): string {
    return this._dirty && this._label ? `${this._label} *` : this._label;
  }

  /**
   * A preset/song became active (selected, saved, loaded, or boot). Clean.
   *
   * Deliberately leaves `songSound` alone: picking a preset is exactly the act
   * REQ-13 exists to make survivable, so it must not unpin the sound being
   * compared against. Only {@link setActiveSong} replaces it.
   */
  setActive(name: string): void {
    this._label = name;
    this._dirty = false;
    this.emit();
  }

  /**
   * A song/demo became active: label it *and* pin its patch so the selector can
   * offer it as an option (presets.md REQ-13). One slot — the next song load
   * replaces it, and nothing is persisted (the autosaved song re-pins on
   * restore).
   */
  setActiveSong(name: string, patch: Snapshot): void {
    this._songSound = { name, patch };
    this.setActive(name);
  }

  /** The pinned song sound, or `null` when no song has been loaded. */
  get songSound(): SongSound | null {
    return this._songSound;
  }

  /** The user edited the patch. Idempotent — only the first call emits. */
  markDirty(): void {
    if (this._dirty) return;
    this._dirty = true;
    this.emit();
  }

  /** Subscribe to display changes; fires immediately. Returns unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    listener();
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }
}

/**
 * Whether a param edit counts as a *synth-patch* change (and so marks the
 * selector dirty). Patch = the synth voice + synth FX + master volume; the
 * song-level machines and transient performance params are excluded so that
 * starting the sequencer, nudging the BPM, or a tape-stop pitch sweep don't
 * masquerade as a sound edit. New osc/filter/FX params count automatically.
 */
const NON_PATCH_PREFIXES = [
  'transport.', 'arp.', 'seq.', 'drum.', 'sampler.', 'fx.drum.', 'fx.sampler.',
];
const NON_PATCH_IDS = new Set<ParamId>([
  'master.pitchBend', 'master.modWheel', 'fx.djfilter', 'keyboard.transpose',
]);

export function isPatchParam(id: ParamId): boolean {
  if (NON_PATCH_IDS.has(id)) return false;
  return !NON_PATCH_PREFIXES.some((p) => id.startsWith(p));
}

/**
 * The patch half of a snapshot — what the selector calls "the sound"
 * (presets.md REQ-13).
 *
 * Same predicate the dirty marker uses, so the `*` and the pinned entry can
 * never disagree about what a sound *is*. Restoring only these ids is the point:
 * returning to a demo's sound must not undo a BPM tweak or a drum edit made
 * since it loaded — the song's arrangement is what loading the song is for.
 */
export function patchSnapshot(snap: Snapshot): Snapshot {
  const out: Snapshot = {};
  for (const [id, v] of Object.entries(snap)) {
    if (isPatchParam(id)) out[id] = v;
  }
  return out;
}

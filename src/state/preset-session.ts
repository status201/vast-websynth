import type { ParamId } from './params';

/**
 * Tracks the *active sound* shown in the header preset selector: a label
 * (preset or song name) plus a dirty flag set once the user edits the synth
 * patch away from it. Pure + DOM-free so the UI can subscribe and the logic
 * stays unit-testable. UI and audio are unaffected — this only drives the
 * selector's displayed text.
 */
export class PresetSession {
  private _label = '';
  private _dirty = false;
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

  /** A preset/song became active (selected, saved, loaded, or boot). Clean. */
  setActive(name: string): void {
    this._label = name;
    this._dirty = false;
    this.emit();
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

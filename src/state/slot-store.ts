/**
 * localStorage-backed named slots with a name index — the storage shape both
 * presets (`websynth.preset.*`) and saved songs (`websynth.song.*`) use. Each
 * store owns one prefix; its index lives at `<prefix>index` (both callers'
 * index keys are literally that, so one param suffices).
 *
 * Values are opaque JSON strings: serialization stays with the caller (presets
 * round params, songs go through the canonical compact form), so this class
 * never needs to know either schema. Reads are defensive — a corrupt or absent
 * index reads as empty rather than throwing, matching the previous behaviour.
 */
export class SlotStore {
  private readonly indexKey: string;

  constructor(private readonly prefix: string) {
    this.indexKey = prefix + 'index';
  }

  /** The slot names, in insertion order. Empty when absent or corrupt. */
  readIndex(): string[] {
    try {
      const raw = localStorage.getItem(this.indexKey);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch { return []; }
  }

  writeIndex(ix: string[]): void {
    localStorage.setItem(this.indexKey, JSON.stringify(ix));
  }

  /** Append `name` unless it is already indexed. */
  addToIndex(name: string): void {
    const ix = this.readIndex();
    if (!ix.includes(name)) { ix.push(name); this.writeIndex(ix); }
  }

  removeFromIndex(name: string): void {
    this.writeIndex(this.readIndex().filter((n) => n !== name));
  }

  /** The stored JSON for `name`, or null when the slot is empty. */
  readRaw(name: string): string | null {
    return localStorage.getItem(this.prefix + name);
  }

  /** Write the slot value only — the index is the caller's concern. */
  writeRaw(name: string, json: string): void {
    localStorage.setItem(this.prefix + name, json);
  }

  /** Drop the slot and its index entry. */
  remove(name: string): void {
    localStorage.removeItem(this.prefix + name);
    this.removeFromIndex(name);
  }
}

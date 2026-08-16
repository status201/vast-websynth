import styles from '../styles/keyboard.module.css';
import { type KeyState, keyRole } from '../key-roles';
import type { ParamBus } from '../../state/params';

const WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11];          // C D E F G A B
const BLACK_OFFSETS: Array<{ semi: number; whiteIdx: number }> = [
  { semi: 1, whiteIdx: 0 }, // C#
  { semi: 3, whiteIdx: 1 }, // D#
  { semi: 6, whiteIdx: 3 }, // F#
  { semi: 8, whiteIdx: 4 }, // G#
  { semi: 10, whiteIdx: 5 }, // A#
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export interface KeyboardOptions {
  bus: ParamBus;
  startOctave?: number;  // octave of first white key; default 3 → C3
  octaves?: number;      // default 3
}

/** A key currently carrying one of the lit classes, remembered as the ELEMENT it
 *  was resolved to (input-control.md REQ-10) — `count` because two of the four
 *  sequencer tracks can sound the same note with different gates. */
interface LitKey {
  el: HTMLElement;
  count: number;
}

export class Keyboard {
  readonly el: HTMLElement;
  private readonly keys: Map<number, HTMLElement> = new Map(); // midi → element
  /** pointerId → the element's own note and the (transposed) note it sounded.
   *  Both, because OCT may move between press and release (REQ-11). */
  private readonly activeByPointer: Map<number, { key: number; sounding: number }> = new Map();
  private readonly litActive: Map<number, LitKey> = new Map();
  private readonly litSeq: Map<number, LitKey> = new Map();
  private readonly bus: ParamBus;
  private _transpose = 0;
  private readonly labelKeys: HTMLElement[] = [];

  constructor(private readonly opts: KeyboardOptions) {
    this.bus = opts.bus;
    const startOct = opts.startOctave ?? 3;
    const octaves = opts.octaves ?? 3;

    this.el = document.createElement('div');
    this.el.className = styles.root!;

    const totalWhites = octaves * 7;

    // White keys
    for (let i = 0; i < totalWhites; i++) {
      const oct = startOct + Math.floor(i / 7);
      const wIdxInOct = i % 7;
      const midi = (oct + 1) * 12 + (WHITE_OFFSETS[wIdxInOct] ?? 0);
      const key = document.createElement('div');
      key.className = `${styles.key!} ${styles.white!}`;
      key.dataset.note = String(midi);
      if (wIdxInOct === 0) {
        key.textContent = `C${oct}`;
        this.labelKeys.push(key);
      }
      this.keys.set(midi, key);
      this.el.appendChild(key);
    }

    // Black keys (absolutely positioned via JS so they align across responsive widths)
    const blackOverlay = document.createElement('div');
    blackOverlay.style.position = 'absolute';
    blackOverlay.style.inset = '6px'; // align with .keyboard padding so x% matches white keys
    blackOverlay.style.pointerEvents = 'none';
    this.el.appendChild(blackOverlay);

    for (let o = 0; o < octaves; o++) {
      for (const { semi, whiteIdx } of BLACK_OFFSETS) {
        const oct = startOct + o;
        const midi = (oct + 1) * 12 + semi;
        const key = document.createElement('div');
        key.className = `${styles.key!} ${styles.black!}`;
        key.dataset.note = String(midi);
        key.style.pointerEvents = 'auto';
        // Position: place over the right edge of white key at column (o*7 + whiteIdx)
        const col = o * 7 + whiteIdx;
        const widthPct = 100 / totalWhites;
        key.style.left = `calc(${(col + 1) * widthPct}% - ${(widthPct * 0.6) / 2}%)`;
        key.style.width = `${widthPct * 0.6}%`;
        this.keys.set(midi, key);
        blackOverlay.appendChild(key);
      }
    }

    this.el.addEventListener('pointerdown', this.onPointerDown);
    this.el.addEventListener('pointermove', this.onPointerMove);
    this.el.addEventListener('pointerup', this.onPointerUp);
    this.el.addEventListener('pointercancel', this.onPointerUp);
    this.el.addEventListener('pointerleave', this.onPointerUp);
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());

    // Moving OCT re-points the note→element mapping under everything currently
    // lit or held. Nothing needs clearing: lit keys remember their element and
    // pointer holds remember the note they sounded (REQ-10/REQ-11), so every
    // pending release still lands on what it took. Only the labels move.
    opts.bus.subscribe('keyboard.transpose', (v) => {
      this._transpose = Math.round(v);
      this.updateLabels();
    });
  }

  private tr(note: number): number {
    return note + this._transpose * 12;
  }

  /**
   * The key that *sounds* `note` — the one resolver behind both highlight APIs
   * (input-control.md REQ-10). An element sounds `note + transpose * 12`, so the
   * inverse is the lookup. Callers must resolve **once**, when lighting up, and
   * remember the element: OCT is free to move before the light-off is due.
   */
  private keyFor(note: number): HTMLElement | undefined {
    return this.keys.get(note - this._transpose * 12);
  }

  /** Add/remove a lit class, bookkeeping the resolved element in `lit`. */
  private setLit(lit: Map<number, LitKey>, cls: string, note: number, on: boolean): void {
    const held = lit.get(note);
    if (on) {
      if (held) { held.count++; return; }
      const el = this.keyFor(note);
      if (!el) return;               // outside the drawn range — nothing to light
      el.classList.add(cls);
      lit.set(note, { el, count: 1 });
      return;
    }
    if (!held) return;
    if (--held.count > 0) return;    // another voice still holds this note
    held.el.classList.remove(cls);
    lit.delete(note);
  }

  private updateLabels(): void {
    for (const key of this.labelKeys) {
      const midi = Number(key.dataset.note);
      const oct = Math.floor(midi / 12) - 1 + this._transpose;
      key.textContent = `C${oct}`;
    }
  }

  private noteAt(x: number, y: number): number | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el) return null;
    if (!el.classList.contains(styles.key!)) return null;
    const raw = el.dataset.note;
    return raw ? Number(raw) : null;
  }

  /** Press the key element `note`, remembering the note it actually sounded so the
   *  release names that one even if OCT moved meanwhile (REQ-11). */
  private pressKey(pointerId: number, note: number): void {
    const sounding = this.tr(note);
    this.activeByPointer.set(pointerId, { key: note, sounding });
    // Through the same lit bookkeeping the computer keyboard uses, so a key held
    // by both a finger and a computer key stays lit until the last one lets go.
    this.setLit(this.litActive, 'active', sounding, true);
    this.bus.noteOn(sounding);
  }

  private releasePointer(pointerId: number): void {
    const held = this.activeByPointer.get(pointerId);
    if (!held) return;
    this.activeByPointer.delete(pointerId);
    this.setLit(this.litActive, 'active', held.sounding, false);
    this.bus.noteOff(held.sounding);
  }

  private onPointerDown = (e: PointerEvent): void => {
    e.preventDefault();
    const note = this.noteAt(e.clientX, e.clientY);
    if (note === null) return;
    this.pressKey(e.pointerId, note);
  };

  private onPointerMove = (e: PointerEvent): void => {
    const held = this.activeByPointer.get(e.pointerId);
    if (!held) return;
    const note = this.noteAt(e.clientX, e.clientY);
    if (note === null || note === held.key) return;
    this.releasePointer(e.pointerId);
    this.pressKey(e.pointerId, note);
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.releasePointer(e.pointerId);
  };

  /**
   * Visual-only key highlight — the target of `UiBridge.pressKey/releaseKey`, so
   * the on-screen keyboard repaints in lock-step with computer-keyboard / MIDI
   * input. It must NOT touch the bus: the note-on/off itself is owned by the
   * input source (`installShortcuts` for the computer keyboard), so highlighting
   * here would double-fire the note funnel. See input-control.md REQ-2.
   */
  highlight(note: number, on: boolean): void {
    this.setLit(this.litActive, 'active', note, on);
  }

  /**
   * Sequencer-playback highlight — a distinct class from the user-pressed
   * `.active` so the two never clobber each other's state. No-ops for notes
   * outside the visible range.
   */
  seqHighlight(note: number, on: boolean): void {
    this.setLit(this.litSeq, 'seq', note, on);
  }

  clearSeqHighlights(): void {
    for (const { el } of this.litSeq.values()) el.classList.remove('seq');
    this.litSeq.clear();
  }

  /**
   * Mark every key with the musical role its pitch class plays in the current key —
   * the third highlight layer, and the only *static* one (input-control.md REQ-14,
   * scale-quantization.md REQ-10). `null` clears, which is what chromatic gets.
   *
   * Deliberately **not** routed through `setLit`: the two lit states are transient and
   * refcounted and must remember the element they lit (REQ-10/REQ-11), while a role is
   * a standing property that is rewritten wholesale. Separate channels — an attribute
   * here, classes there — so a sweep of the board can never strand a held note's light.
   *
   * Keyed by the element's own pitch class, and `_transpose` moves in whole octaves, so
   * that IS its sounding pitch class: an OCT change needs no repaint at all.
   */
  setKeyRoles(state: KeyState | null): void {
    for (const [midi, el] of this.keys) {
      const role = state ? keyRole(midi % 12, state) : 'out';
      // `out` is written as *no* attribute, where the KEY tab's map draws it as a
      // fourth state. On a keyboard you can press, an out-of-scale key is not out of
      // play — it still sounds, quantized onto the nearest tone — so marking it would
      // claim otherwise (REQ-10).
      const next = role === 'out' ? '' : role;
      // Guard each write on what is already rendered (runtime-performance.md REQ-7).
      if ((el.dataset.role ?? '') === next) continue;
      if (next) el.dataset.role = next;
      else delete el.dataset.role;
    }
  }
}

export function noteName(midi: number): string {
  const n = NOTE_NAMES[((midi % 12) + 12) % 12]!;
  const oct = Math.floor(midi / 12) - 1;
  return `${n}${oct}`;
}

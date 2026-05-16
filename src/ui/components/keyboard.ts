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

export class Keyboard {
  readonly el: HTMLElement;
  private readonly keys: Map<number, HTMLElement> = new Map(); // midi → element
  private readonly activeByPointer: Map<number, number> = new Map();
  private readonly bus: ParamBus;

  constructor(private readonly opts: KeyboardOptions) {
    this.bus = opts.bus;
    const startOct = opts.startOctave ?? 3;
    const octaves = opts.octaves ?? 3;

    this.el = document.createElement('div');
    this.el.className = 'keyboard';

    const totalWhites = octaves * 7;

    // White keys
    for (let i = 0; i < totalWhites; i++) {
      const oct = startOct + Math.floor(i / 7);
      const wIdxInOct = i % 7;
      const midi = (oct + 1) * 12 + (WHITE_OFFSETS[wIdxInOct] ?? 0);
      const key = document.createElement('div');
      key.className = 'key white';
      key.dataset.note = String(midi);
      key.textContent = wIdxInOct === 0 ? `C${oct}` : '';
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
        key.className = 'key black';
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
  }

  /** Programmatically press a key (for QWERTY / MIDI). */
  press(note: number): void {
    const k = this.keys.get(note);
    if (k) k.classList.add('active');
    this.bus.noteOn(note);
  }

  release(note: number): void {
    const k = this.keys.get(note);
    if (k) k.classList.remove('active');
    this.bus.noteOff(note);
  }

  private noteAt(x: number, y: number): number | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el) return null;
    if (!el.classList.contains('key')) return null;
    const raw = el.dataset.note;
    return raw ? Number(raw) : null;
  }

  private setKeyActive(note: number, active: boolean): void {
    const el = this.keys.get(note);
    if (!el) return;
    if (active) el.classList.add('active');
    else el.classList.remove('active');
  }

  private onPointerDown = (e: PointerEvent): void => {
    e.preventDefault();
    const note = this.noteAt(e.clientX, e.clientY);
    if (note === null) return;
    this.activeByPointer.set(e.pointerId, note);
    this.setKeyActive(note, true);
    this.bus.noteOn(note);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.activeByPointer.has(e.pointerId)) return;
    const note = this.noteAt(e.clientX, e.clientY);
    const current = this.activeByPointer.get(e.pointerId)!;
    if (note === null || note === current) return;
    this.setKeyActive(current, false);
    this.bus.noteOff(current);
    this.activeByPointer.set(e.pointerId, note);
    this.setKeyActive(note, true);
    this.bus.noteOn(note);
  };

  private onPointerUp = (e: PointerEvent): void => {
    const note = this.activeByPointer.get(e.pointerId);
    if (note === undefined) return;
    this.setKeyActive(note, false);
    this.bus.noteOff(note);
    this.activeByPointer.delete(e.pointerId);
  };

  /** Optional: highlight a held note (e.g. from MIDI input). */
  highlight(note: number, on: boolean): void {
    this.setKeyActive(note, on);
  }

  /**
   * Sequencer-playback highlight — a distinct class from the user-pressed
   * `.active` so the two never clobber each other's state. No-ops for notes
   * outside the visible range.
   */
  seqHighlight(note: number, on: boolean): void {
    const el = this.keys.get(note);
    if (el) el.classList.toggle('seq', on);
  }

  clearSeqHighlights(): void {
    for (const el of this.keys.values()) el.classList.remove('seq');
  }
}

export function noteName(midi: number): string {
  const n = NOTE_NAMES[((midi % 12) + 12) % 12]!;
  const oct = Math.floor(midi / 12) - 1;
  return `${n}${oct}`;
}

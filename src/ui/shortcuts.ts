import type { Engine } from '../audio/engine';
import type { ParamBus } from '../state/params';

// Lower row, C..C (one octave + tonic)
const LOWER: Record<string, number> = {
  z: 0,  s: 1,  x: 2,  d: 3,  c: 4,  v: 5,
  g: 6,  b: 7,  h: 8,  n: 9,  j: 10, m: 11,
  ',': 12,
};
// Upper row, C..C (one octave higher than LOWER)
const UPPER: Record<string, number> = {
  q: 12, '2': 13, w: 14, '3': 15, e: 16, r: 17,
  '5': 18, t: 19, '6': 20, y: 21, '7': 22, u: 23,
  i: 24,
};

export function installShortcuts(engine: Engine, bus: ParamBus): void {
  let baseOctave = 4; // bottom row starts at C4
  const held = new Set<string>();
  let fillHeld = false;

  function keyToMidi(k: string): number | null {
    const lk = k.length === 1 ? k.toLowerCase() : k;
    if (lk in LOWER) return (baseOctave + 1) * 12 + LOWER[lk]!;
    if (lk in UPPER) return (baseOctave + 1) * 12 + UPPER[lk]!;
    return null;
  }

  function press(note: number) {
    const kb = (window as any).__synthKeyboard;
    if (kb && typeof kb.press === 'function') kb.press(note);
    else bus.noteOn(note);
  }
  function release(note: number) {
    const kb = (window as any).__synthKeyboard;
    if (kb && typeof kb.release === 'function') kb.release(note);
    else bus.noteOff(note);
  }

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;

    // Pitch bend (springs back on release)
    if (k === '.') { bus.set('master.pitchBend', 1); return; }
    if (k === '/') { bus.set('master.pitchBend', -1); return; }

    // Octave shift
    if (k === 'ArrowLeft') {
      baseOctave = Math.max(0, baseOctave - 1);
      return;
    }
    if (k === 'ArrowRight') {
      baseOctave = Math.min(7, baseOctave + 1);
      return;
    }

    // Panic
    if (k === 'Escape') { engine.panic(); return; }

    // Transport play/stop
    if (k === ' ' || k === 'Spacebar') {
      e.preventDefault();
      const toggle = (window as any).__transportToggle;
      if (typeof toggle === 'function') toggle();
      else engine.clock.toggle();
      return;
    }

    // Hold for a drum fill
    if (k === 'f' || k === 'F') {
      e.preventDefault();
      if (!fillHeld) { fillHeld = true; engine.perf.setFill(true); }
      return;
    }

    const note = keyToMidi(k);
    if (note === null) return;
    const id = `${k}:${note}`;
    if (held.has(id)) return;
    held.add(id);
    press(note);
    e.preventDefault();
  });

  window.addEventListener('keyup', (e: KeyboardEvent) => {
    const k = e.key;
    if (k === '.' || k === '/') { bus.set('master.pitchBend', 0); return; }
    if (k === 'f' || k === 'F') {
      if (fillHeld) { fillHeld = false; engine.perf.setFill(false); }
      return;
    }
    const note = keyToMidi(k);
    if (note === null) return;
    const id = `${k}:${note}`;
    if (!held.has(id)) return;
    held.delete(id);
    release(note);
  });

  window.addEventListener('blur', () => {
    // Release everything when window loses focus
    if (fillHeld) { fillHeld = false; engine.perf.setFill(false); }
    for (const id of held) {
      const [, noteStr] = id.split(':');
      if (noteStr) release(Number(noteStr));
    }
    held.clear();
  });
}

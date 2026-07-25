import type { StudioApi } from './studio-api';
import type { ParamBus } from '../state/params';
import type { UiBridge } from './ui-bridge';
import { SEQ_LENGTH } from '../state/patterns';

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

/** True when the event originates inside an editable field, where keystrokes
 *  must reach the field rather than play the synth. */
function isEditableTarget(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  return !!t?.closest('input, textarea, [contenteditable="true"]');
}

export function installShortcuts(engine: StudioApi, bus: ParamBus, bridge: UiBridge): void {
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
    bridge.pressKey(note);
    bus.noteOn(note);
  }
  function release(note: number) {
    bridge.releaseKey(note);
    bus.noteOff(note);
  }

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (isEditableTarget(e)) return; // let text fields receive their keystrokes
    if (e.repeat) return;

    // Ctrl/Cmd+Z — undo on the active machine tab (pattern-undo.md REQ-10).
    // Must run before the generic modifier bail-out; Shift/Alt variants
    // (redo conventions) fall through untouched.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
      if (bridge.undoActiveMachine()) e.preventDefault();
      return;
    }

    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;

    // --- Transport position (transport-position.md REQ-11) ---
    // Home = back to the top; Shift+arrows = ±1 bar. Both must be tested BEFORE
    // the bare-arrow octave shift below, which otherwise fires on Shift+Arrow
    // too. A refused seek (slaved, or a capture in flight) falls through without
    // preventDefault, the same boolean idiom Ctrl+Z and Delete use above.
    if (k === 'Home') {
      if (engine.seekTo(0)) e.preventDefault();
      return;
    }
    if (e.shiftKey && (k === 'ArrowLeft' || k === 'ArrowRight')) {
      // Playing: relative to the live step. Stopped: relative to the cue — where
      // Play will begin — which is what the ruler shows, so the two agree.
      const from = engine.clock.playing ? engine.clock.step : engine.clock.cue;
      const bar = Math.floor(from / SEQ_LENGTH) + (k === 'ArrowRight' ? 1 : -1);
      if (engine.seekTo(Math.max(0, bar) * SEQ_LENGTH)) e.preventDefault();
      return;
    }

    // Delete/Backspace — clear the selected step on the active machine tab
    // (step-grid-editing.md REQ-5). Scoped exactly like Ctrl+Z above, so it can
    // never reach a grid that is off screen.
    if (k === 'Delete' || k === 'Backspace') {
      if (bridge.clearSelectedStep()) e.preventDefault();
      return;
    }

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
      bridge.toggleTransport();
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
    if (isEditableTarget(e)) return; // let text fields receive their keystrokes
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

  window.addEventListener('contextmenu', (e: MouseEvent) => {
    // Android/iOS long-press on a button (Stutter etc.) otherwise opens the
    // native menu, which steals focus and cancels the press-and-hold. Keep
    // the menu only inside editable fields so touch copy/paste still works.
    if (isEditableTarget(e)) return;
    e.preventDefault();
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

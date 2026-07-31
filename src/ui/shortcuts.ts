import type { StudioApi } from './studio-api';
import type { ParamBus } from '../state/params';
import type { UiBridge } from './ui-bridge';
import { SEQ_LENGTH } from '../state/patterns';
import { LAYOUTS, resolveLayout, onLayoutChange } from '../state/keyboard-layout';

/**
 * The piano shape: which **physical** key is which semitone, two rows of C..C.
 * Layout-independent by construction — this describes the instrument, not the
 * keyboard, so it is also what the About modal's diagram is drawn from
 * (input-control.md REQ-3, onboarding.md REQ-17c). A picture of the keyboard
 * that disagrees with the keyboard is worse than no picture, so both the
 * bindings below and that diagram come from here.
 */
export const NOTE_ROWS: { lower: Record<string, number>; upper: Record<string, number> } = {
  lower: {
    KeyZ: 0,  KeyS: 1,  KeyX: 2,  KeyD: 3,  KeyC: 4,  KeyV: 5,
    KeyG: 6,  KeyB: 7,  KeyH: 8,  KeyN: 9,  KeyJ: 10, KeyM: 11,
    Comma: 12,
  },
  upper: {
    KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17,
    Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23,
    KeyI: 24,
  },
};

/**
 * `character -> semitone`, composed from `NOTE_ROWS` and the active layout
 * (keyboard-layout.md REQ-1). Matching stays on `e.key`, so these are rebuilt
 * **in place** on a layout change — `installShortcuts` closes over them.
 */
const LOWER: Record<string, number> = {};
const UPPER: Record<string, number> = {};

function rebuildNoteMaps(): void {
  const chars = LAYOUTS[resolveLayout()].keys;
  for (const [row, target] of [[NOTE_ROWS.lower, LOWER], [NOTE_ROWS.upper, UPPER]] as const) {
    for (const k of Object.keys(target)) delete target[k];
    for (const [code, semitone] of Object.entries(row)) {
      const ch = chars[code];
      if (ch) target[ch] = semitone;
    }
  }
}
rebuildNoteMaps();

/** True when the event originates inside an editable field, where keystrokes
 *  must reach the field rather than play the synth. */
function isEditableTarget(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  return !!t?.closest('input, textarea, [contenteditable="true"]');
}

export function installShortcuts(engine: StudioApi, bus: ParamBus, bridge: UiBridge): void {
  let baseOctave = 4; // bottom row starts at C4
  // key → the note it PRESSED, never the note the current baseOctave now names
  // (input-control.md REQ-11): an octave shift mid-hold used to make keyup miss
  // this map entirely, so the note was never released and its key stayed lit
  // until the window lost focus.
  const held = new Map<string, number>();
  let fillHeld = false;

  /** Case-folded key identity. Shift can be pressed or released mid-hold, which
   *  flips `e.key` between 'z' and 'Z' — keying `held` on the raw value would
   *  strand the note exactly like the octave shift did. */
  const keyId = (k: string): string => (k.length === 1 ? k.toLowerCase() : k);

  function keyToMidi(k: string): number | null {
    const lk = keyId(k);
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

  // A layout switch re-keys `held` out from under itself: an entry stored under
  // the old character can never match a future keyup, so it would hang exactly
  // like the octave shift in REQ-11. Release everything first, then remap —
  // same rule the `blur` handler follows (input-control.md REQ-13).
  onLayoutChange(() => {
    for (const note of held.values()) release(note);
    held.clear();
    rebuildNoteMaps();
  });

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

    // Shift+R — the RECORD window, from any tab (record-window.md REQ-9).
    // Above the note handling for the same reason the Shift+Arrow branch is:
    // `keyId` case-folds, so a bare `r` is a note key and Shift+R would
    // otherwise play it. Shift makes it un-typable by accident while playing.
    if (e.shiftKey && (k === 'R' || k === 'r')) {
      e.preventDefault();
      bridge.toggleRecordWindow();
      return;
    }

    // Delete/Backspace — clear the selected step on the active machine tab
    // (step-grid-editing.md REQ-5). Scoped exactly like Ctrl+Z above, so it can
    // never reach a grid that is off screen.
    if (k === 'Delete' || k === 'Backspace') {
      if (bridge.clearSelectedStep()) e.preventDefault();
      return;
    }

    // `?` — show/hide the info badges (input-control.md REQ-9). Ordered ABOVE
    // the pitch-bend branch below: `e.key` for Shift+/ is '?', so '/' never
    // matches today, but a layout quirk must not turn a help request into a bend.
    if (k === '?') {
      e.preventDefault();
      bridge.toggleInfoBadges();
      return;
    }

    // Pitch bend, springs back on release (input-control.md REQ-12). `'` sits
    // directly above `/` on the board, so the keys state which way is up — `.`
    // and `/` were side by side, which made the mapping pure memorisation. `.`
    // is deliberately left unbound rather than kept as an alias.
    //
    // Matched on `e.code`, the only branch here that is: the pair is chosen for
    // *where the keys sit*, so position is what to match. `e.key` broke three
    // ways — a dead-key layout reports `Dead` for `'`, QWERTZ/AZERTY put neither
    // character where the diagram draws it, and Shift mid-hold flipped the
    // keyup's `e.key` to `?`/`"` so the release below missed and the bend stuck.
    // `?` is handled above and returns, so Shift+Slash still reaches the badges.
    if (e.code === 'Quote') { bus.set('master.pitchBend', 1); return; }
    if (e.code === 'Slash') { bus.set('master.pitchBend', -1); return; }

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
    const id = keyId(k);
    if (held.has(id)) return;
    held.set(id, note);
    press(note);
    e.preventDefault();
  });

  window.addEventListener('keyup', (e: KeyboardEvent) => {
    if (isEditableTarget(e)) return; // let text fields receive their keystrokes
    const k = e.key;
    // Same `e.code` the press used, so a Shift pressed or released mid-hold
    // cannot strand the bend (REQ-12; the note-key twin of this is REQ-11).
    if (e.code === 'Quote' || e.code === 'Slash') { bus.set('master.pitchBend', 0); return; }
    if (k === 'f' || k === 'F') {
      if (fillHeld) { fillHeld = false; engine.perf.setFill(false); }
      return;
    }
    // Deliberately NOT keyToMidi(k) — baseOctave may have shifted since keydown.
    const id = keyId(k);
    const note = held.get(id);
    if (note === undefined) return;
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
    for (const note of held.values()) release(note);
    held.clear();
  });
}

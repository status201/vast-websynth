import type { ParamBus, ParamId } from '../state/params';
import { chordDegrees, diatonicChord, scaleTones } from '../utils/music';

/**
 * The current key, as pitch classes — the one vocabulary two surfaces share.
 *
 * The KEY tab's map (`ui/panels/key-panel.ts`) and the playable keyboard
 * (`ui/components/keyboard.ts`) both colour keys by musical role. They are different
 * pictures with different rules about *when* to show one — the map always paints, the
 * keyboard only while a scale is active — but they must never disagree about which
 * note is the root, and they must wear the same colours doing it. So the derivation
 * and the precedence live here, once, and neither surface owns them.
 *
 * Pure: reads the bus, touches no DOM. The palette's other half is the `--key-role-*`
 * tokens in `styles/theme.css`.
 *
 * Spec: `specs/features/scale-quantization.md` REQ-9 / REQ-10.
 */

/** Falling precedence: a pitch class wears the first of these that fits. */
export type KeyRole = 'root' | 'chord' | 'scale' | 'out';

export interface KeyState {
  /** The root's pitch class, 0..11. */
  root: number;
  /** Pitch classes the scale admits — every one of them while chromatic. */
  tones: ReadonlySet<number>;
  /** The tonic chord of the current voicing (chord-tools.md REQ-1); empty when off. */
  chord: ReadonlySet<number>;
  /** False while `chromatic`, where "in scale" says nothing about any note. */
  active: boolean;
}

/** The three params a key is made of. `voicing.mode` is NOT one: it gates the live
 *  chord path, not the picture, and only the KEY tab's hint has anything to say
 *  about it. */
export const KEY_PARAMS: readonly ParamId[] = ['scale.root', 'scale.type', 'chord.voicing'];

/** Every pitch class — what `chromatic` admits, and so the map's default state. */
const ALL_PITCH_CLASSES: ReadonlySet<number> = new Set(Array.from({ length: 12 }, (_, i) => i));

/** Read the current key off the bus. Cheap enough to call per change; nothing caches. */
export function readKeyState(bus: ParamBus): KeyState {
  const root = Math.round(bus.get('scale.root'));
  const scale = Math.round(bus.get('scale.type'));
  const voicing = Math.round(bus.get('chord.voicing'));
  const active = scale > 0;

  // Chromatically every note is admitted, and saying so is what makes choosing a
  // scale visibly *remove* notes on the map (scale-quantization.md REQ-9).
  const tones = active ? new Set(scaleTones(root, scale)) : ALL_PITCH_CLASSES;

  // Chord memory has no chord until a key is held, so the tonic stands in — that is
  // what lets the voicing control show its effect before anything is played.
  const chord = new Set<number>();
  if (active && voicing > 0) {
    for (const n of diatonicChord(60, root, scale, chordDegrees(voicing))) chord.add(n % 12);
  }

  return { root, tones, chord, active };
}

/** The role a pitch class plays, in falling precedence — so the root still reads as
 *  the root even though it is also a chord tone and a scale tone. */
export function keyRole(pc: number, s: KeyState): KeyRole {
  if (pc === s.root) return 'root';
  if (s.chord.has(pc)) return 'chord';
  if (s.tones.has(pc)) return 'scale';
  return 'out';
}

/** Subscribe a repaint to every param a key is made of, and paint once now — so a
 *  caller needs no separate initial pass, and preset/song `restore()` is covered by
 *  the same code path. The gate is there because `ParamBus.subscribe` fires on
 *  subscribe: without it, wiring up would paint once per param instead of once. */
export function onKeyChange(bus: ParamBus, fn: () => void): void {
  let wired = false;
  for (const id of KEY_PARAMS) bus.subscribe(id, () => { if (wired) fn(); });
  wired = true;
  fn();
}

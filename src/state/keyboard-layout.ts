/**
 * Which characters the physical keys produce (specs/features/keyboard-layout.md).
 *
 * The note rows are matched on `e.key`, which is only correct on QWERTY: on
 * AZERTY the bottom-left key prints **W** and used to hit the upper octave's
 * `w: 14`, sounding a D instead of the bottom C. So a layout is one
 * `code -> character` table, and everything downstream — the live note maps and
 * the About modal's keyboard diagram — is derived from it, so the bindings and
 * the picture of the bindings cannot disagree.
 *
 * That shape is also exactly what `navigator.keyboard.getLayoutMap()` returns,
 * which is why detection is a table lookup rather than a parallel code path.
 *
 * Device-scoped setup state, deliberately **not** a `ParamBus` param: which
 * keyboard is plugged in must never travel inside a preset or a song
 * (`sync-mode.ts` / `perf-mode.ts` precedent).
 */

const STORE_KEY = 'websynth.keyboard.layout';

export type LayoutId = 'qwerty' | 'azerty' | 'qwertz' | 'dvorak';
export type LayoutPref = 'auto' | LayoutId;

const IDS: readonly LayoutId[] = ['qwerty', 'azerty', 'qwertz', 'dvorak'];
const PREFS: readonly LayoutPref[] = ['auto', ...IDS];

/**
 * `code -> the character that key produces`. Only the codes the app binds need
 * tabulating (`NOTE_ROWS` in `ui/shortcuts.ts` is the list) — these tables are
 * not a general keyboard model and must not grow into one.
 */
type KeyTable = Record<string, string>;

const QWERTY: KeyTable = {
  KeyZ: 'z', KeyS: 's', KeyX: 'x', KeyD: 'd', KeyC: 'c', KeyV: 'v', KeyG: 'g',
  KeyB: 'b', KeyH: 'h', KeyN: 'n', KeyJ: 'j', KeyM: 'm', Comma: ',',
  KeyQ: 'q', Digit2: '2', KeyW: 'w', Digit3: '3', KeyE: 'e', KeyR: 'r',
  Digit5: '5', KeyT: 't', Digit6: '6', KeyY: 'y', Digit7: '7', KeyU: 'u',
  KeyI: 'i',
};

// AZERTY: A<->Q and Z<->W swap, M moves up to the home row (so the bottom row's
// last natural is `,`), and the digit row is unshifted punctuation — which is
// why the upper octave's sharps read é " ( - è rather than 2 3 5 6 7.
const AZERTY: KeyTable = {
  ...QWERTY,
  KeyZ: 'w', KeyM: ',', Comma: ';',
  KeyQ: 'a', KeyW: 'z',
  Digit2: 'é', Digit3: '"', Digit5: '(', Digit6: '-', Digit7: 'è',
};

// QWERTZ: only Y and Z trade places; the digit row is unshifted numbers as on
// QWERTY, so the sharps are unchanged.
const QWERTZ: KeyTable = {
  ...QWERTY,
  KeyZ: 'y',
  KeyY: 'z',
};

const DVORAK: KeyTable = {
  KeyZ: ';', KeyS: 'o', KeyX: 'q', KeyD: 'e', KeyC: 'j', KeyV: 'k', KeyG: 'i',
  KeyB: 'x', KeyH: 'd', KeyN: 'b', KeyJ: 'h', KeyM: 'm', Comma: 'w',
  KeyQ: "'", Digit2: '2', KeyW: ',', Digit3: '3', KeyE: '.', KeyR: 'p',
  Digit5: '5', KeyT: 'y', Digit6: '6', KeyY: 'f', Digit7: '7', KeyU: 'g',
  KeyI: 'c',
};

export const LAYOUTS: Record<LayoutId, { label: string; keys: KeyTable }> = {
  qwerty: { label: 'QWERTY (US/UK)', keys: QWERTY },
  azerty: { label: 'AZERTY (FR)', keys: AZERTY },
  qwertz: { label: 'QWERTZ (DE/CH)', keys: QWERTZ },
  dvorak: { label: 'Dvorak', keys: DVORAK },
};

// ---- preference ------------------------------------------------------------

/** Stored preference, defaulting to 'auto'. Bad/absent values read as 'auto'. */
export function readLayoutPref(): LayoutPref {
  try {
    const v = localStorage.getItem(STORE_KEY);
    if (v && (PREFS as readonly string[]).includes(v)) return v as LayoutPref;
    return 'auto';
  } catch {
    return 'auto';
  }
}

export function writeLayoutPref(pref: LayoutPref): void {
  try {
    localStorage.setItem(STORE_KEY, pref);
  } catch {
    /* private mode / quota — non-fatal */
  }
  for (const cb of listeners) cb();
}

// ---- detection -------------------------------------------------------------

/** Cached `detectLayout()` result; `undefined` until `primeDetection()` runs. */
let detected: LayoutId | null | undefined;

interface KeyboardApi {
  getLayoutMap?: () => Promise<Map<string, string>>;
}

/**
 * What the browser says the keys actually print. Chromium-only and async, so
 * it is a **hint** — an absent API, a rejection, or an unrecognised layout all
 * yield `null` and leave 'auto' reading as QWERTY. The picker is the real
 * escape hatch (the framing `perf-mode.ts` uses for its tier detection).
 */
export async function detectLayout(): Promise<LayoutId | null> {
  try {
    if (typeof navigator === 'undefined') return null;
    const kb = (navigator as Navigator & { keyboard?: KeyboardApi }).keyboard;
    if (!kb?.getLayoutMap) return null;
    const map = await kb.getLayoutMap();
    // Two codes separate all four: KeyQ tells AZERTY apart, KeyZ the rest.
    const q = map.get('KeyQ')?.toLowerCase();
    const z = map.get('KeyZ')?.toLowerCase();
    if (q === 'a') return 'azerty';
    if (z === 'y') return 'qwertz';
    if (z === ';') return 'dvorak';
    if (z === 'z') return 'qwerty';
    return null;
  } catch {
    return null;
  }
}

/** Warm the detection cache once at boot, before the first paint. */
export async function primeDetection(): Promise<void> {
  detected = await detectLayout();
  if (readLayoutPref() === 'auto' && detected) {
    for (const cb of listeners) cb();
  }
}

/** The layout in force. Synchronous — callers render synchronously, and until
 *  `primeDetection()` resolves, 'auto' reads as QWERTY. */
export function resolveLayout(): LayoutId {
  const pref = readLayoutPref();
  if (pref !== 'auto') return pref;
  return detected ?? 'qwerty';
}

/** The active layout's character for a physical key — the diagram's cap label. */
export function labelFor(code: string): string {
  return LAYOUTS[resolveLayout()].keys[code] ?? '';
}

// ---- change notification ---------------------------------------------------

const listeners = new Set<() => void>();

/** Subscribe to layout changes; returns an unsubscribe. Does not fire on
 *  subscription — callers derive their initial state themselves. */
export function onLayoutChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Test seam: drop the cached detection so a suite can start from cold. */
export function resetDetectionForTests(): void {
  detected = undefined;
}

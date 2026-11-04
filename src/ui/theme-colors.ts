/**
 * The canvases' colours (specs/features/ui-themes.md REQ-canvas-reads-the-screen-tokens).
 *
 * A canvas cannot read `var(--x)`, so the painters that draw into the display
 * windows — scope, EQ graph, scratch graph, sample waveform — take their colours
 * from here instead of from literals. The `--screen-*` tokens are resolved ONCE,
 * through a probe element (so whatever a theme writes — a hex, a `var()`, a
 * `color-mix()` — comes back as the browser's own `rgb()`), and cached until a
 * theme change invalidates them. Nothing here may run per frame.
 */

/** A colour as 0–255 channels; alpha is applied per use (REQ-an-alpha-derives-from-its-base). */
export type Rgb = readonly [number, number, number];

export interface ScreenPalette {
  /** Grid, ticks, labels, and the secondary curve — the default's amber. */
  ink: Rgb;
  /** The main trace or curve. */
  trace: Rgb;
  /** Clip and cut marks. */
  hot: Rgb;
  /** A grabbed handle. */
  highlight: Rgb;
  /** A cue point. */
  cue: Rgb;
}

const TOKENS: Record<keyof ScreenPalette, string> = {
  ink: '--screen-ink',
  trace: '--screen-trace',
  hot: '--screen-hot',
  highlight: '--screen-highlight',
  cue: '--screen-cue',
};

/**
 * Dark's values — the fallback where a token does not resolve (no DOM, or a
 * test environment without a cascade). Pinned equal to theme.css by
 * tests/ui/theme-colors.test.ts, so the two cannot drift.
 */
export const DARK_SCREEN: ScreenPalette = {
  ink: [244, 205, 94],
  trace: [232, 116, 46],
  hot: [255, 58, 32],
  highlight: [255, 233, 168],
  cue: [127, 214, 255],
};

/** The channels of a computed colour, or null if it is not one. Alpha is dropped. */
export function parseColor(value: string): Rgb | null {
  const legacy = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value);
  if (legacy) return [Number(legacy[1]), Number(legacy[2]), Number(legacy[3])];
  const srgb = /^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)/.exec(value);
  if (srgb) return [1, 2, 3].map((i) => Math.round(Number(srgb[i]) * 255)) as unknown as Rgb;
  return null;
}

/** A canvas colour from a base and an alpha. */
export function rgba(c: Rgb, alpha = 1): string {
  return alpha >= 1 ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
}

let cached: ScreenPalette | null = null;

function resolve(): ScreenPalette {
  if (typeof document === 'undefined' || !document.body) return DARK_SCREEN;
  const probe = document.createElement('span');
  probe.hidden = true;
  document.body.append(probe);
  try {
    const out = { ...DARK_SCREEN };
    const root = getComputedStyle(document.documentElement);
    for (const key of Object.keys(TOKENS) as (keyof ScreenPalette)[]) {
      // An undeclared token would leave the probe its inherited colour, which
      // parses fine and is wrong; so a token must exist before it is resolved.
      if (!root.getPropertyValue(TOKENS[key]).trim()) continue;
      probe.style.color = `var(${TOKENS[key]})`;
      out[key] = parseColor(getComputedStyle(probe).color) ?? DARK_SCREEN[key];
    }
    return out;
  } finally {
    probe.remove();
  }
}

/** The current theme's screen colours — resolved on first read, then cached. */
export function screenPalette(): ScreenPalette {
  return (cached ??= resolve());
}

const listeners = new Set<() => void>();

/**
 * Forget the cached palette, so the next read resolves the tokens again, and
 * tell every subscribed canvas to repaint. For a theme change
 * (REQ-a-theme-change-repaints-the-canvases).
 */
export function invalidateScreenPalette(): void {
  cached = null;
  for (const fn of [...listeners]) fn();
}

/**
 * Run `fn` after each theme change — a canvas that paints only on demand
 * schedules its repaint here. Returns the unsubscribe, for its `destroy()`.
 */
export function onPaletteChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * A value built from the palette (a painter's set of `rgba()` strings), rebuilt
 * only when the palette object changes — so a painter can call the getter every
 * frame and allocate nothing.
 */
export function paletteDerived<T>(build: (p: ScreenPalette) => T): () => T {
  let from: ScreenPalette | null = null;
  let value: T;
  return () => {
    const p = screenPalette();
    if (p !== from) {
      from = p;
      value = build(p);
    }
    return value;
  };
}

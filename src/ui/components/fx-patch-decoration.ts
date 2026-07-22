import styles from '../styles/fx-patch-decoration.module.css';

/**
 * Decorative rack scenery filling the empty `.fxRow` cell that five effect
 * panels leave in the ≤992px 2-column layout (specs/features/fx-patch-decoration.md):
 * an empty bay — faintly lit in the middle, falling away to black at the rim —
 * with a loom of patch cables dropping through it from the rack above, and one
 * unused lead dangling its 1/4" plug in mid-air.
 *
 * Two stacked full-bleed SVG layers, because the cell's aspect ratio swings from
 * ~1.7:1 (phone) to ~4.7:1 (992px) — no single viewBox both reaches the edges
 * and keeps the connector round (REQ-4):
 *   - cables: `preserveAspectRatio="none"` + `vector-effect="non-scaling-stroke"`,
 *     so the stretch bends the curves (natural for slack cable) but never the
 *     stroke width, and the runs always meet the cell edges;
 *   - lead: `xMidYMin meet` — aspect preserved so the plug stays undistorted,
 *     but anchored **top** so its cable always enters through the cell's edge
 *     instead of starting in mid-air inside a letterbox.
 *
 * Modeled on `wave-icons.ts` / `header-icons.ts`: the markup carries no colour.
 * Each cable is wrapped in a hue class that sets `--wire`/`--wire-lit` (the
 * inline-custom-prop pattern `StepButton` uses), so the whole patch-bay palette
 * lives in the stylesheet. Static by design (REQ-7): lighting is a dark sheath
 * path doubled by a thin low-opacity sheen, never a filter or drop-shadow.
 */
export function fxPatchDecoration(): HTMLElement {
  const el = document.createElement('div');
  el.className = styles.root!;
  el.dataset.testid = 'fx-patch-decoration';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = cablesLayer() + leadLayer();
  return el;
}

/** A sheath path doubled by its sheen — the whole lighting model (REQ-7). */
const cable = (d: string, cls: string, sheen: string, attrs = ''): string =>
  `<path class="${cls}" d="${d}"${attrs}/><path class="${sheen}" d="${d}"${attrs}/>`;

/** Keeps the cables layer's strokes even width under its non-uniform stretch. */
const FIXED_STROKE = ' vector-effect="non-scaling-stroke"';

/**
 * The loom behind the bay: cables dropping from the rack above and out through
 * the bottom, plus a few draping in from the panel to the left. Nothing runs to
 * or ends at the **right** edge — this is the last bay in the row, so there is
 * nothing over there to connect to and a cable stopping at that edge reads as a
 * cut-off drawing (REQ-9). Mixed hues and gauges; a patch bay is never tidy.
 */
const BG_CABLES: ReadonlyArray<{
  hue: keyof typeof styles;
  d: string;
  thin?: boolean;
  far?: boolean;
}> = [
  // — the far curtain: cables deeper in the rack, so thinner, dimmer and with
  //   less sway than the near loom (distance flattens the slack). Listed first
  //   so they paint behind everything else. —
  { hue: 'hueBrown', d: 'M6 -10 C 4 24, 9 48, 6 74 S 3 96, 5 112', far: true },
  { hue: 'hueViolet', d: 'M13 -10 C 16 26, 11 50, 14 76 S 17 98, 15 112', far: true },
  { hue: 'hueBlue', d: 'M20 -10 C 23 26, 17 50, 21 76 S 25 98, 22 112', far: true },
  { hue: 'hueRed', d: 'M33 -10 C 30 28, 36 52, 32 78 S 29 98, 31 112', far: true },
  { hue: 'hueGreen', d: 'M43 -10 C 47 24, 40 48, 44 74 S 48 96, 45 112', far: true },
  { hue: 'hueViolet', d: 'M57 -10 C 54 26, 60 50, 56 76 S 52 98, 55 112', far: true },
  { hue: 'hueAmber', d: 'M69 -10 C 72 24, 66 50, 70 76 S 74 98, 71 112', far: true },
  { hue: 'hueBrown', d: 'M81 -10 C 78 26, 85 48, 80 74 S 76 96, 79 112', far: true },
  { hue: 'hueBlue', d: 'M89 -10 C 93 24, 86 50, 90 76 S 94 98, 91 112', far: true },
  { hue: 'hueGreen', d: 'M98 -10 C 94 26, 100 50, 96 76 S 93 98, 96 112', far: true },
  // — the near loom: drops from above, out through the bottom (mixed slack:
  //   some hang taut, some sway wide, so it never reads as a repeating
  //   pattern). The ~55-85% band is left clear: that is the lane the hero lead
  //   hangs in, and a near strand crossing the plug reads as if it were patched
  //   into it. —
  { hue: 'hueBrown', d: 'M10 -10 C 7 26, 15 46, 11 70 S 6 94, 9 112' },
  { hue: 'hueRed', d: 'M20 -10 C 30 22, 12 46, 24 72 S 35 96, 28 112', thin: true },
  { hue: 'hueBlue', d: 'M31 -12 C 30 20, 35 46, 32 74 S 28 96, 30 112' },
  { hue: 'hueAmber', d: 'M42 -10 C 50 18, 36 38, 43 58 S 51 88, 45 112', thin: true },
  { hue: 'hueGreen', d: 'M52 -10 C 54 24, 50 52, 53 78 S 56 98, 54 112', thin: true },
  { hue: 'hueViolet', d: 'M88 -10 C 81 24, 93 48, 85 74 S 79 98, 83 112', thin: true },
  { hue: 'hueBrown', d: 'M96 -10 C 99 28, 93 50, 97 76 S 100 98, 98 112' },
  // — drape in from the panel on the left, then fall away out of the bottom —
  { hue: 'hueBrown', d: 'M-10 18 C 12 26, 22 52, 18 78 S 24 100, 20 112', thin: true },
  { hue: 'hueAmber', d: 'M-10 48 C 10 56, 26 72, 33 92 S 39 108, 40 116' },
  { hue: 'hueBlue', d: 'M-10 80 C 12 88, 22 99, 29 108 S 38 118, 40 122', thin: true },
];

function cablesLayer(): string {
  const runs = BG_CABLES.map(({ hue, d, thin, far }) => {
    const sheath = thin ? `${styles.bgCable!} ${styles.thin!}` : styles.bgCable!;
    const group = far ? `${styles[hue]!} ${styles.far!}` : styles[hue]!;
    return `<g class="${group}">${cable(d, sheath, styles.bgSheen!, FIXED_STROKE)}</g>`;
  }).join('');
  return (
    `<svg class="${styles.layer!} ${styles.cables!}" viewBox="0 0 100 100" ` +
    `preserveAspectRatio="none" aria-hidden="true">${runs}</svg>`
  );
}

/**
 * The hero lead: drops in through the **top** edge, takes a lazy S under its own
 * weight and dangles a TS plug near-vertically at the end — an unused lead left
 * hanging from the rack above, with nothing to plug into (REQ-5).
 *
 * Anchored `xMidYMin` so the cable always meets the top edge: a centred `meet`
 * letterboxes on a short cell and the cable would start in mid-air. The content
 * sits in the **right** half of the viewBox and stops well above its foot, so
 * after centring the plug hangs off-centre and clear of the bay's bottom rim.
 */
function leadLayer(): string {
  const c = styles.cable!;
  const s = styles.sheen!;
  return (
    `<svg class="${styles.layer!} ${styles.lead!}" viewBox="0 0 210 120" ` +
    `preserveAspectRatio="xMidYMin meet" aria-hidden="true">` +
    // Down from above, swaying twice, into the plug's strain relief at ~68°.
    cable('M126 -12 C 131 3, 120 12, 126 22 C 132 31, 147 33, 149 38', c, s) +
    // Plug, drawn horizontally and swung to hang at 76° off the boot.
    `<g transform="rotate(76 150 42)">` +
      // Strain relief (tapered boot).
      `<path class="${styles.boot!}" d="M146 38.6 L154 37.2 L154 46.8 L146 45.4 Z"/>` +
      // Barrel + knurl bands.
      `<rect class="${styles.barrel!}" x="154" y="35.4" width="28" height="13.2" rx="2.4"/>` +
      `<path class="${styles.knurl!}" d="M160 36.6 V47.4 M164 36.6 V47.4 M168 36.6 V47.4"/>` +
      // Collar, then the sleeve + ring groove + tip of the 1/4" TS shaft.
      `<rect class="${styles.collar!}" x="182" y="36.8" width="3.6" height="10.4" rx="1"/>` +
      `<path class="${styles.shaft!}" d="M185.6 39.4 H205 M185.6 44.6 H205"/>` +
      `<path class="${styles.groove!}" d="M202 39 V45"/>` +
      `<path class="${styles.tip!}" d="M205 39.4 C209.6 39.9, 209.6 44.1, 205 44.6 Z"/>` +
      // Specular line along the top of the barrel.
      `<path class="${styles.glint!}" d="M156.5 37.6 H179.5"/>` +
    `</g>` +
    `</svg>`
  );
}

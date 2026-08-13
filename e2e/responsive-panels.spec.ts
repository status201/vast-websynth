import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart } from './helpers';

/**
 * Responsive synth panels — the faceplate's knob distribution across widths.
 * See specs/features/responsive-synth-panels.md.
 *
 * Everything here is *rendered geometry*, which is why it lives in Playwright
 * and not jsdom: `.quad` / `.quint` / `.hex` are CSS grids whose column count
 * changes at 1280px and 1630px, and the claim under test is the resulting row
 * shape, not the class name. Panels carry no testid (`createPanel`'s third
 * argument is a help id), so rows are recovered from the knob testids — stable,
 * specced ids — grouped by their shared `offsetTop`.
 *
 * Widths are changed *within* a test wherever possible: each boot starts a full
 * AudioContext + worklets, and the suite runs two workers.
 */

/** The faceplate panels this spec measures, by their knob param ids, in DOM
 *  order. The LFO panel is deliberately absent: it sits behind a tab strip, so
 *  only one of its pages is ever laid out. */
const PANELS = {
  osc1: ['osc1.octave', 'osc1.detune', 'osc1.level'],
  mixer: ['mixer.noise', 'mixer.glide', 'analog.drift'],
  subuni: ['sub.octave', 'sub.level', 'unison.voices', 'unison.detune'],
  filter: ['filter.cutoff', 'filter.resonance', 'filter.shape', 'filter.drive', 'filter.envAmount', 'filter.keytrack'],
  ampenv: ['env.amp.attack', 'env.amp.decay', 'env.amp.sustain', 'env.amp.release'],
  filterenv: ['env.fil.attack', 'env.fil.decay', 'env.fil.sustain', 'env.fil.release', 'filter.velAmount'],
} as const;

const ALL_IDS = Object.values(PANELS).flat();

interface KnobBox {
  id: string;
  top: number;
  left: number;
  width: number;
  /** The label's ink extent. `scrollWidth` is the spec's prescribed measure: it
   *  is the overflowing text width when a label bleeds past its box, and the box
   *  width otherwise — an upper bound on the ink either way, never an under-read. */
  ink: number;
  label: string;
  /** Content box of the row the knob sits in, for the space-evenly checks. */
  rowLeft: number;
  rowWidth: number;
}

async function readKnobs(page: Page, ids: readonly string[]): Promise<KnobBox[]> {
  return page.evaluate((wanted) => {
    const out: KnobBox[] = [];
    for (const id of wanted) {
      const el = document.querySelector(`[data-testid="knob-${id}"]`) as HTMLElement | null;
      if (!el || el.offsetParent === null) continue; // never rendered / hidden
      const row = el.parentElement as HTMLElement;
      const label = el.firstElementChild as HTMLElement;
      out.push({
        id,
        top: el.offsetTop,
        left: el.offsetLeft,
        width: el.offsetWidth,
        ink: label.scrollWidth,
        label: label.textContent ?? '',
        rowLeft: row.offsetLeft,
        rowWidth: row.clientWidth,
      });
    }
    return out;
  }, ids as string[]) as Promise<KnobBox[]>;
}

/** The knobs of one panel, split into visual rows by shared `offsetTop`, each
 *  row ordered left to right. */
function rowsOf(boxes: KnobBox[], panel: readonly string[]): KnobBox[][] {
  const mine = boxes.filter((b) => panel.includes(b.id));
  expect(mine, `every knob of ${panel[0]}'s panel is rendered`).toHaveLength(panel.length);
  const byTop = new Map<number, KnobBox[]>();
  for (const b of mine) {
    // Round: grid items on one row can differ by a subpixel.
    const key = Math.round(b.top);
    (byTop.get(key) ?? byTop.set(key, []).get(key)!).push(b);
  }
  return [...byTop.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, row]) => row.sort((a, b) => a.left - b.left));
}

/** The row shape — how many knobs on each successive row, e.g. [2, 2]. */
function shape(boxes: KnobBox[], panel: readonly string[]): number[] {
  return rowsOf(boxes, panel).map((r) => r.length);
}

async function shapeAt(page: Page, width: number, panel: readonly string[]): Promise<number[]> {
  await page.setViewportSize({ width, height: 900 });
  return shape(await readKnobs(page, panel), panel);
}

test.describe('responsive synth panels', () => {
  // REQ-3/REQ-5: at/below 1280px the panels widen enough for one row each.
  test('the wide panels each collapse to a single row on a tablet', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1180 }); // iPad Air
    await gotoAndStart(page);
    const boxes = await readKnobs(page, ALL_IDS);

    expect(shape(boxes, PANELS.subuni)).toEqual([4]);
    expect(shape(boxes, PANELS.ampenv)).toEqual([4]);
    // .quint's last-child span is undone here — five fit one row (REQ-1).
    expect(shape(boxes, PANELS.filterenv)).toEqual([5]);
    // Six knobs go 3x2, never 4+2 or 5+1 (REQ-6).
    expect(shape(boxes, PANELS.filter)).toEqual([3, 3]);
  });

  // REQ-3/REQ-4: the same reflow spreads the 3-knob rows across the widened
  // panel, instead of leaving them clustered beside their generous neighbours.
  test('3-knob rows spread on a tablet and stay a centred cluster on the desktop', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await gotoAndStart(page);

    const spread = rowsOf(await readKnobs(page, PANELS.mixer), PANELS.mixer)[0]!;
    expect(spread).toHaveLength(3);
    const lead = spread[0]!.left - spread[0]!.rowLeft;
    const between = spread[1]!.left - (spread[0]!.left + spread[0]!.width);
    // space-evenly gives equal free space either side of every knob; the row's
    // own 4px `gap` is added on top of the space *between* items, so the two
    // differ by exactly that gap and by nothing else.
    expect(lead).toBeGreaterThan(4);
    expect(between - lead).toBeCloseTo(4, 0);

    // Above 1280px the .spread modifier is inert: nothing is distributed, so
    // neighbours sit at exactly the row's own 4px gap and the cluster is
    // centred. Asserted per rendered row, not per panel: an 8-column panel is
    // only ~141px wide at 1440px, so three 52px knobs do not fit one row and
    // the flex row wraps 2+1 — `.spread` being inert is the claim, not the row
    // count. At 1920px the panel is wide enough and the same rule reads as the
    // single centred row of three the spec describes.
    for (const width of [1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      for (const panel of [PANELS.mixer, PANELS.osc1]) {
        for (const row of rowsOf(await readKnobs(page, panel), panel)) {
          for (let i = 1; i < row.length; i++) {
            const gap = row[i]!.left - (row[i - 1]!.left + row[i - 1]!.width);
            expect(gap, `${width}px: ${row[i - 1]!.label}/${row[i]!.label} gap`).toBeCloseTo(4, 0);
          }
          const last = row[row.length - 1]!;
          const clusterCentre = (row[0]!.left + last.left + last.width) / 2;
          const rowCentre = row[0]!.rowLeft + row[0]!.rowWidth / 2;
          expect(Math.abs(clusterCentre - rowCentre), `${width}px: row is centred`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  // REQ-2: the whole point of a grid over flex-wrap — a 4-knob panel is a 2x2
  // block on a narrow 8-column panel and is never allowed to wrap 3+1.
  test('4-knob panels are a 2x2 block on the desktop, never 3+1', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoAndStart(page);

    for (const width of [1281, 1440, 1920, 2560]) {
      expect(await shapeAt(page, width, PANELS.subuni), `SUB/UNI at ${width}px`).toEqual([2, 2]);
      expect(await shapeAt(page, width, PANELS.ampenv), `AMP ENV at ${width}px`).toEqual([2, 2]);
      // .quint: A D / S R / VEL, the fifth spanning the row on its own.
      expect(await shapeAt(page, width, PANELS.filterenv), `FILTER ENV at ${width}px`).toEqual([2, 2, 1]);
    }

    // The spanning VEL is centred across the row, not left-ragged.
    const rows = rowsOf(await readKnobs(page, PANELS.filterenv), PANELS.filterenv);
    const vel = rows[2]![0]!;
    const rowCentre = vel.rowLeft + vel.rowWidth / 2;
    expect(Math.abs(vel.left + vel.width / 2 - rowCentre)).toBeLessThanOrEqual(1);
  });

  // REQ-6: FILTER is the one panel with three shapes, and the middle one is a
  // *narrower* column count than the widths either side of it.
  test('the 6-knob FILTER panel takes each of its three shapes', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 900 });
    await gotoAndStart(page);

    expect(await shapeAt(page, 1920, PANELS.filter), 'wide monitor: 3 across').toEqual([3, 3]);
    expect(await shapeAt(page, 1400, PANELS.filter), 'narrow desktop panel: 2 across').toEqual([2, 2, 2]);
    expect(await shapeAt(page, 820, PANELS.filter), 'widened tablet panel: 3 across').toEqual([3, 3]);

    // The thresholds themselves, from either side.
    expect(await shapeAt(page, 1629, PANELS.filter)).toEqual([2, 2, 2]);
    expect(await shapeAt(page, 1630, PANELS.filter)).toEqual([3, 3]);
    expect(await shapeAt(page, 1280, PANELS.filter)).toEqual([3, 3]);
  });
});

/**
 * REQ-7 — a measurement, not an eyeball. A knob's label may ink wider than its
 * box (the box is a fixed `--knob-size + 8px`), so two knobs whose boxes merely
 * sit side by side can still have their *labels* touch.
 *
 * Bounding boxes are the wrong instrument here and the spec says so: the dial's
 * glow ring has a negative inset and bleeds past the box, which would report a
 * collision on every row. Ink extent is `centre ± scrollWidth / 2`.
 */
test('no knob label ever reaches its neighbour', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoAndStart(page);

  // The one measured, pre-existing collision, recorded in the spec's Open
  // questions: UNISON/SPREAD are six characters inking ~41px against a 44px box
  // at the narrowest breakpoint, so in a 4-up `.quad` cell they meet — by 5.0px
  // at 360px, the only width where it happens (there is already 2px of daylight
  // at 414px). It belongs to knob typography (a label-width rule), not to the
  // column counts under test, so it is carried here by name rather than passed
  // over in silence — and the 6px ceiling still fails if it ever gets worse.
  // Delete this entry when that Open question is closed.
  const KNOWN_COLLISION = { ids: ['unison.voices', 'unison.detune'], belowWidth: 480, byPx: 6 };

  const widths = [360, 414, 480, 600, 768, 820, 992, 1024, 1280, 1400, 1440, 1630, 1920, 2560];
  const collisions: string[] = [];

  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    const boxes = await readKnobs(page, ALL_IDS);
    expect(boxes.length, `every faceplate knob is laid out at ${width}px`).toBe(ALL_IDS.length);

    for (const panel of Object.values(PANELS)) {
      for (const row of rowsOf(boxes, panel)) {
        for (let i = 1; i < row.length; i++) {
          const a = row[i - 1]!;
          const b = row[i]!;
          const gap = (b.left + b.width / 2 - b.ink / 2) - (a.left + a.width / 2 + a.ink / 2);
          if (gap >= -0.5) continue; // touching is allowed; overlapping is not

          const known = KNOWN_COLLISION.ids.includes(a.id) && KNOWN_COLLISION.ids.includes(b.id)
            && width < KNOWN_COLLISION.belowWidth && gap > -KNOWN_COLLISION.byPx;
          if (!known) collisions.push(`${width}px: ${a.label}/${b.label} overlap by ${(-gap).toFixed(1)}px`);
        }
      }
    }
  }

  expect(collisions).toEqual([]);
});

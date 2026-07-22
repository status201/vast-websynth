import { describe, it, expect } from 'vitest';
import { fxPatchDecoration } from '../../src/ui/components/fx-patch-decoration';
import styles from '../../src/ui/styles/fx-patch-decoration.module.css';

const farClass = styles.far!;

/**
 * The unpatched-cable scenery filling the empty FX grid cell
 * (specs/features/fx-patch-decoration.md). It has no behaviour — the contract is
 * that it is inert (REQ-3) and built from the two layers REQ-4 describes.
 * Breakpoint visibility (REQ-1) is CSS, so it is pinned by e2e/fx-patch.spec.ts.
 */
describe('fxPatchDecoration', () => {
  it('is inert: aria-hidden, no pointer events, nothing focusable', () => {
    const el = fxPatchDecoration();
    expect(el.dataset.testid).toBe('fx-patch-decoration');
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelectorAll('button, a, input, select, textarea, [tabindex]')).toHaveLength(0);
    expect(el.textContent).toBe('');
  });

  it('stacks the stretched cables layer and the undistorted lead layer', () => {
    const svgs = fxPatchDecoration().querySelectorAll('svg');
    expect(svgs).toHaveLength(2);

    // Cables stretch to the cell edges; their strokes must not stretch with them.
    const cables = svgs[0]!;
    expect(cables.getAttribute('preserveAspectRatio')).toBe('none');
    const runs = cables.querySelectorAll('path');
    expect(runs.length).toBeGreaterThan(0);
    for (const p of runs) expect(p.getAttribute('vector-effect')).toBe('non-scaling-stroke');

    // The plug layer keeps its aspect ratio so the connector stays round, and
    // anchors top so its cable enters through the cell edge — a centred `meet`
    // would letterbox on a short cell and start the cable in mid-air (REQ-4).
    expect(svgs[1]!.getAttribute('preserveAspectRatio')).toBe('xMidYMin meet');
  });

  it('drops the loom top-to-bottom and never sends a cable right (REQ-9)', () => {
    const cables = fxPatchDecoration().querySelectorAll('svg')[0]!;
    // Sheath + sheen per run, each in its own hue group.
    const groups = [...cables.querySelectorAll('g')];
    expect(groups.length).toBeGreaterThanOrEqual(8);

    // Every command in these paths takes coordinate pairs, so x is even-indexed.
    const points = (g: Element) => {
      const n = [...g.querySelector('path')!.getAttribute('d')!.matchAll(/-?\d+(?:\.\d+)?/g)]
        .map((m) => Number(m[0]));
      return { xs: n.filter((_, i) => i % 2 === 0), ys: n.filter((_, i) => i % 2 === 1) };
    };

    let fromTop = 0;
    for (const g of groups) {
      const { xs, ys } = points(g);
      // Nothing may reach the right edge: this is the last bay in the row, so a
      // cable stopping there reads as a cut-off drawing.
      expect(Math.max(...xs)).toBeLessThanOrEqual(100);
      // Every run has to leave the box, or it floats with visible loose ends.
      expect(Math.min(...xs) < 0 || Math.min(...ys) < 0 || Math.max(...ys) > 100).toBe(true);
      if (Math.min(...ys) < 0) fromTop += 1;
    }
    // The loom hangs from the rack above, so most runs enter through the top.
    expect(fromTop).toBeGreaterThanOrEqual(Math.ceil(groups.length / 2));
  });

  it('colour-codes the bundle across several hues (REQ-9)', () => {
    const cables = fxPatchDecoration().querySelectorAll('svg')[0]!;
    const hues = new Set([...cables.querySelectorAll('g')].map((g) => g.getAttribute('class')));
    expect(hues.size).toBeGreaterThanOrEqual(4);
    expect([...hues].join(' ')).not.toContain('undefined');
  });

  it('draws the far rank first so it paints behind the near loom (REQ-9)', () => {
    const cables = fxPatchDecoration().querySelectorAll('svg')[0]!;
    const isFar = [...cables.querySelectorAll('g')].map((g) => g.classList.contains(farClass));
    expect(isFar.filter(Boolean)).toHaveLength(10);
    // SVG has no z-index: depth is document order, so every far run must come
    // before the first near one.
    expect(isFar.lastIndexOf(true)).toBeLessThan(isFar.indexOf(false));
  });
});

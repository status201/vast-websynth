import { describe, it, expect } from 'vitest';
import { placeCallout } from '../../src/ui/onboarding/tour';

const VW = 1000;
const VH = 800;

function rect(left: number, top: number, w: number, h: number) {
  return { left, top, right: left + w, bottom: top + h, width: w, height: h };
}

describe('placeCallout', () => {
  it('centers the callout when there is no target', () => {
    const p = placeCallout(null, 300, 200, VW, VH);
    expect(p.left).toBe((VW - 300) / 2);
    expect(p.top).toBe((VH - 200) / 2);
  });

  it('places below the target by default (auto) when it fits', () => {
    const r = rect(100, 100, 80, 40); // bottom = 140
    const p = placeCallout(r, 300, 200, VW, VH);
    expect(p.top).toBe(140 + 14); // bottom + gap
    expect(p.left).toBe(100); // aligned to target left
  });

  it('flips above the target when below would overflow the viewport', () => {
    const r = rect(100, 700, 80, 40); // bottom = 740; 740+14+200 > 800
    const p = placeCallout(r, 300, 200, VW, VH);
    expect(p.top).toBe(700 - 14 - 200); // above = top - gap - height
  });

  it('clamps a wide callout into the viewport horizontally', () => {
    const r = rect(950, 100, 40, 40); // near right edge
    const p = placeCallout(r, 300, 200, VW, VH);
    expect(p.left).toBe(VW - 300 - 8); // clamped to right margin
    expect(p.left).toBeGreaterThanOrEqual(8);
  });

  it("honours explicit 'right' placement", () => {
    const r = rect(100, 100, 80, 40); // right = 180
    const p = placeCallout(r, 200, 120, VW, VH, 'right');
    expect(p.left).toBe(180 + 14); // right + gap
    expect(p.top).toBe(100); // aligned to target top
  });

  it("honours explicit 'top' placement", () => {
    const r = rect(100, 400, 80, 40);
    const p = placeCallout(r, 200, 120, VW, VH, 'top');
    expect(p.top).toBe(400 - 14 - 120);
  });

  it('never positions outside the [8, viewport-8] bounds', () => {
    const r = rect(-50, -50, 20, 20);
    const p = placeCallout(r, 300, 200, VW, VH, 'left');
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.left).toBeLessThanOrEqual(VW - 300 - 8);
    expect(p.top).toBeLessThanOrEqual(VH - 200 - 8);
  });
});

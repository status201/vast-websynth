import { describe, it, expect, afterEach } from 'vitest';
import shipped from '../../docs/signal-flow-zones.json';
import { SignalFlowMap } from '../../src/ui/signal-flow/signal-flow-map';
import { childrenOf, hotspotsFor, zoneById, type ZoneManifest } from '../../src/ui/signal-flow/zones';

/**
 * signal-flow-map.md — the map component against the shipped manifest and a
 * stand-in poster (the map never reads the poster's content, only its root).
 * jsdom has no layout, so the view runs at the fallback stage size; the view
 * maths is tests/signal-flow/camera.test.ts's.
 */
const manifest = shipped as ZoneManifest;
const POSTER = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${manifest.width} ${manifest.height}" width="${manifest.width}" height="${manifest.height}" role="img" aria-labelledby="sf-title">
<title id="sf-title">The poster</title>
<rect width="${manifest.width}" height="${manifest.height}" fill="#123456"/></svg>`;

let map: SignalFlowMap | null = null;
function mount(): SignalFlowMap {
  map = new SignalFlowMap({ svgText: POSTER, manifest });
  document.body.appendChild(map.root);
  return map;
}
afterEach(() => {
  map?.dispose();
  map?.root.remove();
  map = null;
});

const q = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const zonesShown = (): string[] =>
  [...document.querySelectorAll<SVGGElement>('[data-testid="signal-flow-zone"]')].map((g) => g.dataset.zone!);
const areasListed = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[data-testid="signal-flow-area"]')].map((b) => b.dataset.zone!);
const crumbs = (): string => [...q('signal-flow-title').parentElement!.querySelector('nav')!.children]
  .map((c) => c.textContent).join(' ');

describe('SignalFlowMap', () => {
  it('opens on the overview (REQ-the-map-opens-on-the-overview)', () => {
    mount();
    const top = childrenOf(manifest, null).map((z) => z.id);
    expect(map!.focused).toBeNull();
    expect(zonesShown()).toEqual(top);
    expect(areasListed()).toEqual(top);
    expect(q('signal-flow-title').textContent).toBe('Overview');
    expect(document.body.textContent).toContain(manifest.intro);
    expect(q('signal-flow-map').querySelector('svg')?.getAttribute('viewBox')).toMatch(/^[-\d.]+ [-\d.]+ [\d.]+ [\d.]+$/);
  });

  it('inlines the poster sized by CSS, with its paper behind it', () => {
    mount();
    const svg = q('signal-flow-map').querySelector('svg')!;
    expect(svg.hasAttribute('width')).toBe(false);
    expect(svg.hasAttribute('height')).toBe(false);
    expect(q('signal-flow-map').style.getPropertyValue('--poster-bg')).toBe('#123456');
  });

  it('keeps the poster title as its name, not as a tooltip over the whole map', () => {
    mount();
    const svg = q('signal-flow-map').querySelector('svg')!;
    expect(svg.querySelector(':scope > title')).toBeNull();
    expect(svg.getAttribute('aria-label')).toBe('The poster');
    expect(svg.hasAttribute('aria-labelledby')).toBe(false);
  });

  it('picks an area and shows its parts (REQ-picking-an-area-zooms-to-it)', () => {
    mount();
    const before = q('signal-flow-map').querySelector('svg')!.getAttribute('viewBox');
    document.querySelector<HTMLElement>('[data-testid="signal-flow-area"][data-zone="machines"]')!.click();
    expect(map!.focused).toBe('machines');
    expect(zonesShown()).toEqual(childrenOf(manifest, 'machines').map((z) => z.id));
    expect(q('signal-flow-map').querySelector('svg')!.getAttribute('viewBox')).not.toBe(before);

    map!.focus('voice');
    expect(q('signal-flow-title').textContent).toBe('Synth voice');
    expect(crumbs()).toBe('Overview › Machines & sound sources › Synth');
    // A leaf offers its neighbours.
    expect(zonesShown()).toEqual(hotspotsFor(manifest, 'voice').map((z) => z.id));
    expect(zonesShown()).not.toContain('voice');
  });

  it('follows the signal with Next and Prev (REQ-next-follows-the-signal)', () => {
    mount();
    const prev = q('signal-flow-prev') as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    q('signal-flow-next').click();
    q('signal-flow-next').click();
    expect(map!.focused).toBe(manifest.tour[1]);
    expect(document.body.textContent).toContain(`2 / ${manifest.tour.length}`);
    prev.click();
    expect(map!.focused).toBe(manifest.tour[0]);
    prev.click();
    expect(map!.focused).toBeNull();
  });

  it('steps out one level at a time, then declines (REQ-escape-steps-out-before-it-closes)', () => {
    mount();
    map!.focus('voice');
    expect(map!.stepOut()).toBe(true);
    expect(map!.focused).toBe('synth');
    expect(map!.stepOut()).toBe(true);
    expect(map!.focused).toBe('machines');
    expect(map!.stepOut()).toBe(true);
    expect(map!.focused).toBeNull();
    expect(map!.stepOut()).toBe(false);
  });

  it('goes to a help topic’s place and rings its block (REQ-a-help-topic-shows-its-place)', () => {
    mount();
    expect(map!.show(['filter'])).toBe(true);
    expect(map!.focused).toBe('voice');
    const rings = [...document.querySelectorAll<SVGElement>('[data-testid="signal-flow-ring"]')].map((r) => r.dataset.spot);
    expect(rings).toEqual(['filter']);
    expect(q('signal-flow-ringed').textContent).toBe('Ringed: FILTER');
    // Several blocks: the innermost area that holds them all.
    map!.show(['syn-eq', 'drm-eq', 'smp-eq']);
    expect(map!.focused).toBe('fx');
    expect(document.querySelectorAll('[data-testid="signal-flow-ring"]')).toHaveLength(3);
    // Moving on clears the rings.
    map!.focus(null);
    expect(document.querySelectorAll('[data-testid="signal-flow-ring"]')).toHaveLength(0);
    expect(q('signal-flow-ringed').hidden).toBe(true);
    // Nothing known: the map stays put.
    expect(map!.show(['no-such-block'])).toBe(false);
    expect(map!.focused).toBeNull();
  });

  /** A pointer event on the stage (jsdom may lack PointerEvent; the map reads only these fields). */
  const pointer = (type: string, id: number, x: number, y: number): void => {
    const e = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });
    Object.defineProperty(e, 'pointerId', { value: id });
    q('signal-flow-map').dispatchEvent(e);
  };
  const viewBox = (): number[] => q('signal-flow-map').querySelector('svg')!.getAttribute('viewBox')!.split(' ').map(Number);

  it('pans on a drag, and a drag is not a tap (REQ-the-map-can-be-explored-freely)', () => {
    mount();
    map!.focus('voice'); // jsdom: no layout, so no tween — the view is there at once
    const [x0, y0] = viewBox();
    pointer('pointerdown', 1, 400, 300);
    pointer('pointermove', 1, 350, 280);
    pointer('pointermove', 1, 300, 260);
    pointer('pointerup', 1, 300, 260);
    const [x1, y1] = viewBox();
    expect(x1).toBeGreaterThan(x0!); // dragged left → the view moves right
    expect(y1).toBeGreaterThan(y0!);
    expect(map!.focused).toBe('voice'); // not picked as a tap on a neighbour
  });

  it('does not take a still two-finger tap for a tap', () => {
    mount();
    map!.focus('voice');
    // A point inside the Modulation neighbour, in client px: jsdom lays nothing
    // out, so the map maps the client against its fallback 1200 × 700 stage.
    const mod = zoneById(manifest, 'mod')!;
    const [vx, vy, vw, vh] = viewBox();
    const cx = ((mod.x + mod.w / 2 - vx!) * 1200) / vw!;
    const cy = ((mod.y + 40 - vy!) * 700) / vh!;
    expect(cy).toBeLessThan(700); // on screen

    const before = viewBox();
    pointer('pointerdown', 1, cx, cy);
    pointer('pointerdown', 2, cx + 20, cy);
    pointer('pointerup', 1, cx, cy);
    pointer('pointerup', 2, cx + 20, cy);
    expect(map!.focused).toBe('voice');
    expect(viewBox()).toEqual(before);

    // The control: one still finger there does pick the neighbour.
    pointer('pointerdown', 3, cx, cy);
    pointer('pointerup', 3, cx, cy);
    expect(map!.focused).toBe('mod');
  });

  it('zooms on a two-finger pinch', () => {
    mount();
    map!.focus('voice');
    const w0 = viewBox()[2]!;
    pointer('pointerdown', 1, 300, 300);
    pointer('pointerdown', 2, 400, 300);
    pointer('pointermove', 2, 500, 300);
    pointer('pointerup', 2, 500, 300);
    pointer('pointerup', 1, 300, 300);
    expect(viewBox()[2]).toBeCloseTo(w0 / 2, 3);
  });

  it('consumes the keys it handles and no others (input-control.md)', () => {
    mount();
    map!.focus('voice');
    const stage = q('signal-flow-map');
    const press = (key: string): boolean => {
      const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      stage.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(press('ArrowLeft')).toBe(true);
    expect(press('+')).toBe(true);
    expect(press('a')).toBe(false);
    // Ctrl/Cmd + = is the browser's page zoom, Alt + ← its Back.
    const mod = (key: string, init: KeyboardEventInit): boolean => {
      const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      stage.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(mod('=', { ctrlKey: true })).toBe(false);
    expect(mod('-', { metaKey: true })).toBe(false);
    expect(mod('ArrowLeft', { altKey: true })).toBe(false);
    expect(press('Home')).toBe(true);
    expect(map!.focused).toBeNull();
  });
});

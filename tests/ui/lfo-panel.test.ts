import { describe, it, expect } from 'vitest';
import { buildLfoPanel } from '../../src/ui/panels/lfo-panel';
import { LFO_DEST_LABELS, ParamBus, registerDefaults } from '../../src/state/params';
import { SYNC_LABELS } from '../../src/utils/tempo';

/**
 * The two-page LFO panel: mutually exclusive destinations (lfo.md REQ-12) and
 * the off-screen-active lamp (REQ-15).
 *
 * Both pages are built and subscribed at boot, so every assertion here can read
 * the hidden page directly — which is the point of REQ-5.
 */

const CUTOFF = LFO_DEST_LABELS.indexOf('cutoff');
const PAN = LFO_DEST_LABELS.indexOf('pan');
const PULSE = LFO_DEST_LABELS.indexOf('pulse');

function build() {
  const bus = new ParamBus();
  registerDefaults(bus);
  const el = buildLfoPanel(bus);
  return { bus, el };
}

/** An option button inside a page's destination dropdown, by its label. */
function destOption(el: HTMLElement, page: '1' | '2', label: string): HTMLButtonElement {
  const shell = el.querySelector<HTMLElement>(`[data-testid="ppage-lfo-${page}"]`)!;
  // The destination dropdown is the first of the two on the page (dest, sync).
  const dd = shell.querySelectorAll<HTMLElement>('.dropdown')[0]!;
  const opts = [...dd.querySelectorAll<HTMLButtonElement>('button')];
  return opts.find((o) => o.textContent === label)!;
}

const hint = (el: HTMLElement, id: string) =>
  el.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const tab = (el: HTMLElement, page: '1' | '2') =>
  el.querySelector<HTMLButtonElement>(`[data-testid="ptab-lfo-${page}"]`)!;

describe('LFO panel', () => {
  it('builds both pages, each bound to its own params (REQ-10)', () => {
    const { el } = build();
    for (const id of ['knob-lfo.rate', 'knob-lfo.amount', 'seg-lfo.wave',
      'knob-lfo2.rate', 'knob-lfo2.amount', 'seg-lfo2.wave']) {
      expect(el.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    }
  });

  it('shows page 1 first and keeps page 2 mounted (REQ-15, REQ-5)', () => {
    const { el } = build();
    expect(el.querySelector('[data-testid="ppage-lfo-1"]')!.classList.contains('visible')).toBe(true);
    expect(el.querySelector('[data-testid="ppage-lfo-2"]')!.classList.contains('visible')).toBe(false);
    expect(el.querySelector('[data-testid="knob-lfo2.rate"]')).not.toBeNull();
  });

  it('greys the destination the other LFO holds, and frees it again (REQ-12)', () => {
    const { bus, el } = build();
    expect(destOption(el, '2', 'cutoff').disabled).toBe(false);

    bus.set('lfo.dest', CUTOFF);
    expect(destOption(el, '2', 'cutoff').disabled).toBe(true);
    expect(destOption(el, '2', 'pan').disabled).toBe(false);
    expect(destOption(el, '2', 'off').disabled).toBe(false);

    bus.set('lfo.dest', 0);
    expect(destOption(el, '2', 'cutoff').disabled).toBe(false);
  });

  it('blocks in both directions', () => {
    const { bus, el } = build();
    bus.set('lfo2.dest', PAN);
    expect(destOption(el, '1', 'pan').disabled).toBe(true);
    expect(destOption(el, '2', 'pan').disabled).toBe(false); // its own value
  });

  it('never greys an LFO own destination, even when duplicated (REQ-12, edge)', () => {
    const { bus, el } = build();
    // What a hand-authored file can produce; the panel must still read true.
    bus.set('lfo.dest', CUTOFF);
    bus.set('lfo2.dest', CUTOFF);
    expect(destOption(el, '1', 'cutoff').disabled).toBe(false);
    expect(destOption(el, '2', 'cutoff').disabled).toBe(false);
  });

  it('names the holder in a hint, and hides it when nothing is taken', () => {
    const { bus, el } = build();
    expect(hint(el, 'dest-taken-lfo2').style.display).toBe('none');

    bus.set('lfo.dest', CUTOFF);
    expect(hint(el, 'dest-taken-lfo2').textContent).toBe('cutoff is used by LFO 1.');
    expect(hint(el, 'dest-taken-lfo2').style.display).not.toBe('none');
    expect(hint(el, 'dest-taken-lfo').style.display).toBe('none');

    bus.set('lfo.dest', 0);
    expect(hint(el, 'dest-taken-lfo2').style.display).toBe('none');
  });

  it('scopes the pulse-rate hint to the page that selected pulse', () => {
    const { bus, el } = build();
    expect(hint(el, 'pulse-hint-lfo').style.display).toBe('none');

    bus.set('lfo2.dest', PULSE);
    expect(hint(el, 'pulse-hint-lfo2').style.display).not.toBe('none');
    expect(hint(el, 'pulse-hint-lfo').style.display).toBe('none');
  });

  it('dims the rate knob of the LFO that is synced, not the other (REQ-9)', () => {
    const { bus, el } = build();
    bus.set('lfo2.sync', SYNC_LABELS.indexOf('1/4'));
    expect(el.querySelector('[data-testid="knob-lfo2.rate"]')!.getAttribute('aria-disabled')).toBe('true');
    expect(el.querySelector('[data-testid="knob-lfo.rate"]')!.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('lights the tab of a modulating page and darkens it again (REQ-15)', () => {
    const { bus, el } = build();
    expect(tab(el, '2').classList.contains('lit')).toBe(false);

    bus.set('lfo2.dest', PAN);
    expect(tab(el, '2').classList.contains('lit')).toBe(false); // armed but at 0 depth
    bus.set('lfo2.amount', 0.6);
    expect(tab(el, '2').classList.contains('lit')).toBe(true);

    bus.set('lfo2.amount', 0);
    expect(tab(el, '2').classList.contains('lit')).toBe(false);
  });

  it('lights LFO 1 from the mod wheel, and never LFO 2 (REQ-11)', () => {
    const { bus, el } = build();
    bus.set('lfo.dest', CUTOFF);
    bus.set('lfo2.dest', PAN);

    bus.set('master.modWheel', 0.4);
    expect(tab(el, '1').classList.contains('lit')).toBe(true);
    expect(tab(el, '2').classList.contains('lit')).toBe(false);
  });

  it('keeps the help anchor on the tab row, not on a tab (REQ-7)', () => {
    const { el } = build();
    const helped = el.querySelectorAll('[data-help="lfo"]');
    expect(helped).toHaveLength(1);
    expect(helped[0]!.tagName).toBe('DIV');
    expect(tab(el, '1').hasAttribute('data-help')).toBe(false);
  });

  it('names both LFOs on the tabs, since they are the panel heading', () => {
    const { el } = build();
    expect(tab(el, '1').textContent).toBe('LFO 1');
    expect(tab(el, '2').textContent).toBe('LFO 2');
  });
});

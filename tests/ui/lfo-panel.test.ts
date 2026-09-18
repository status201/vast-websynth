import { describe, it, expect } from 'vitest';
import { buildLfoPanel } from '../../src/ui/panels/lfo-panel';
import { LFO_DEST_LABELS, ParamBus, registerDefaults } from '../../src/state/params';
import { SYNC_LABELS } from '../../src/utils/tempo';

/**
 * The two-page LFO panel: mutually exclusive destinations (lfo.md REQ-destinations-are-no-longer-exclusive) and
 * the off-screen-active lamp (REQ-the-two-lfos-share-one-panel).
 *
 * Both pages are built and subscribed at boot, so every assertion here can read
 * the hidden page directly — which is the point of REQ-amplitude-destinations-are-smoothed.
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
  const prefix = page === '1' ? 'lfo' : 'lfo2';
  // By testid, not by position: the RATE knob's tempo lock is a dropdown too, and
  // it sits ahead of this one (tempo-lock.md REQ-locked-the-division-replaces-the-dial).
  const dd = el.querySelector<HTMLElement>(`[data-testid="dropdown-${prefix}.dest"]`)!;
  const opts = [...dd.querySelectorAll<HTMLButtonElement>('button')];
  return opts.find((o) => o.textContent === label)!;
}

const hint = (el: HTMLElement, id: string) =>
  el.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const tab = (el: HTMLElement, page: '1' | '2') =>
  el.querySelector<HTMLButtonElement>(`[data-testid="ptab-lfo-${page}"]`)!;

describe('LFO panel', () => {
  it('builds both pages, each bound to its own params (REQ-there-are-two-lfos)', () => {
    const { el } = build();
    for (const id of ['knob-lfo.rate', 'knob-lfo.amount', 'seg-lfo.wave',
      'knob-lfo2.rate', 'knob-lfo2.amount', 'seg-lfo2.wave']) {
      expect(el.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    }
  });

  it('shows page 1 first and keeps page 2 mounted (REQ-the-two-lfos-share-one-panel, REQ-amplitude-destinations-are-smoothed)', () => {
    const { el } = build();
    expect(el.querySelector('[data-testid="ppage-lfo-1"]')!.classList.contains('visible')).toBe(true);
    expect(el.querySelector('[data-testid="ppage-lfo-2"]')!.classList.contains('visible')).toBe(false);
    expect(el.querySelector('[data-testid="knob-lfo2.rate"]')).not.toBeNull();
  });

  // REQ-destinations-are-no-longer-exclusive's mutual exclusion is superseded by the mod matrix (lfo.md v8). What was
  // three tests enforcing the block is now one test enforcing its ABSENCE — the pair
  // may share a destination, and REQ-duplicated-destinations-sum-and-stay-bounded has always said what that sounds like.
  it('lets both LFOs hold one destination (v8, REQ-destinations-are-no-longer-exclusive superseded)', () => {
    const { bus, el } = build();
    expect(destOption(el, '2', 'cutoff').disabled).toBe(false);

    bus.set('lfo.dest', CUTOFF);
    expect(destOption(el, '2', 'cutoff').disabled).toBe(false);
    expect(destOption(el, '1', 'cutoff').disabled).toBe(false);

    bus.set('lfo2.dest', PAN);
    expect(destOption(el, '1', 'pan').disabled).toBe(false);
  });

  it('renders a hand-authored duplicate truthfully (v8, edge)', () => {
    const { bus, el } = build();
    // This state was always reachable from a file; now it is reachable from the UI too.
    bus.set('lfo.dest', CUTOFF);
    bus.set('lfo2.dest', CUTOFF);
    expect(destOption(el, '1', 'cutoff').disabled).toBe(false);
    expect(destOption(el, '2', 'cutoff').disabled).toBe(false);
  });

  it('no longer carries a holder hint (v8, REQ-destinations-are-no-longer-exclusive superseded)', () => {
    const { bus, el } = build();
    bus.set('lfo.dest', CUTOFF);
    expect(el.querySelector('[data-testid="dest-taken-lfo2"]')).toBeNull();
    expect(el.querySelector('[data-testid="dest-taken-lfo"]')).toBeNull();
  });

  it('scopes the pulse-rate hint to the page that selected pulse', () => {
    const { bus, el } = build();
    expect(hint(el, 'pulse-hint-lfo').style.display).toBe('none');

    bus.set('lfo2.dest', PULSE);
    expect(hint(el, 'pulse-hint-lfo2').style.display).not.toBe('none');
    expect(hint(el, 'pulse-hint-lfo').style.display).toBe('none');
  });

  // v9: the synced rate knob is no longer dimmed in place next to a full-width
  // picker two rows below — the picker IS the knob now (tempo-lock.md REQ-locked-the-division-replaces-the-dial), so
  // what marks the synced page is the `synced` state class on its rate knob.
  it('swaps the dial for the division on the LFO that is synced, not the other (REQ-lfo-sync-locks-rate-to-tempo)', () => {
    const { bus, el } = build();
    bus.set('lfo2.sync', SYNC_LABELS.indexOf('1/4'));
    expect(el.querySelector('[data-testid="knob-lfo2.rate"]')!.classList.contains('synced')).toBe(true);
    expect(el.querySelector('[data-testid="knob-lfo.rate"]')!.classList.contains('synced')).toBe(false);
  });

  it('no longer carries a standalone sync picker (v9)', () => {
    const { el } = build();
    expect(el.querySelector('[data-testid="dropdown-lfo.sync"]')).toBeNull();
    // The lock lives on the knob it governs, on both pages.
    expect(el.querySelector('[data-testid="tempolock-lfo.rate"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="tempolock-lfo2.rate"]')).not.toBeNull();
  });

  it('lights the tab of a modulating page and darkens it again (REQ-the-two-lfos-share-one-panel)', () => {
    const { bus, el } = build();
    expect(tab(el, '2').classList.contains('lit')).toBe(false);

    bus.set('lfo2.dest', PAN);
    expect(tab(el, '2').classList.contains('lit')).toBe(false); // armed but at 0 depth
    bus.set('lfo2.amount', 0.6);
    expect(tab(el, '2').classList.contains('lit')).toBe(true);

    bus.set('lfo2.amount', 0);
    expect(tab(el, '2').classList.contains('lit')).toBe(false);
  });

  it('lights LFO 1 from the mod wheel, and never LFO 2 (REQ-the-mod-wheel-feeds-lfo-one-only)', () => {
    const { bus, el } = build();
    bus.set('lfo.dest', CUTOFF);
    bus.set('lfo2.dest', PAN);

    bus.set('master.modWheel', 0.4);
    expect(tab(el, '1').classList.contains('lit')).toBe(true);
    expect(tab(el, '2').classList.contains('lit')).toBe(false);
  });

  it('keeps the help anchor on the tab row, not on a tab (REQ-shape-destination-sweeps-the-pole-mix)', () => {
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

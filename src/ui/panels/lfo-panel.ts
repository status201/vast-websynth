import type { ParamBus } from '../../state/params';
import { LFO_DEST_LABELS, LFO_SYNC_LABELS, WAVE_LABELS } from '../../state/params';
import { blockedDests, LFO_PREFIXES, otherLfo, type LfoPrefix } from '../../state/lfo-routing';
import { PWM_RATE_MAX } from '../../audio/pwm';
import { Knob } from '../components/knob';
import { Segmented } from '../components/segmented';
import { ParamDropdown } from '../components/param-dropdown';
import { WAVE_ICONS } from '../components/wave-icons';
import { createTabbedPanel } from '../components/panel';
import styles from '../styles/layout.module.css';

const PULSE_DEST = LFO_DEST_LABELS.indexOf('pulse');
const OFF_DEST = LFO_DEST_LABELS.indexOf('off');

/** Human name for a prefix, used in the "already taken" hint. */
const LFO_NAMES: Record<LfoPrefix, string> = { lfo: 'LFO 1', lfo2: 'LFO 2' };

interface LfoPage {
  /** Re-read the other LFO's destination and repaint what this page may offer. */
  refreshDest(): void;
}

/**
 * The LFO panel: two identical pages, one per LFO, behind a tab strip in the
 * panel's own title row (lfo.md REQ-15).
 *
 * Extracted from `app.ts`, unlike the other seven faceplate panels, because it
 * is the only one with cross-instance state (REQ-12's exclusivity), two pages,
 * and a body that is a parameterised builder rather than a literal.
 */
export function buildLfoPanel(bus: ParamBus): HTMLElement {
  const pages = {} as Record<LfoPrefix, LfoPage>;

  const { el, tabs } = createTabbedPanel({
    prefix: 'lfo',
    help: 'lfo',
    // The tabs are this panel's heading, so they carry the full name — there is
    // no separate "LFO" title left for them to disambiguate against.
    pages: LFO_PREFIXES.map((prefix, i) => ({
      id: String(i + 1),
      label: LFO_NAMES[prefix],
      build: (body: HTMLElement) => { pages[prefix] = buildLfoPage(bus, prefix, body); },
    })),
  });

  LFO_PREFIXES.forEach((prefix, i) => {
    // Each page watches the OTHER LFO's destination, so claiming one greys it
    // on the facing page (REQ-12). `subscribe` fires immediately, so both lists
    // are correct on first paint.
    bus.subscribe(`${otherLfo(prefix)}.dest`, () => pages[prefix].refreshDest());
    // ...and its own, since "my own value is never blocked" depends on it.
    bus.subscribe(`${prefix}.dest`, () => pages[prefix].refreshDest());

    // A modulating LFO on the hidden page would otherwise be invisible state
    // (ADR-014 law 5). The mod wheel only counts for LFO 1, which is the only
    // one it reaches (REQ-11).
    const lit = (): void => {
      const armed = Math.round(bus.get(`${prefix}.dest`)) !== OFF_DEST;
      const depth = bus.get(`${prefix}.amount`) + (prefix === 'lfo' ? bus.get('master.modWheel') : 0);
      tabs.setLit(String(i + 1), armed && depth > 0);
    };
    bus.subscribe(`${prefix}.dest`, lit);
    bus.subscribe(`${prefix}.amount`, lit);
    if (prefix === 'lfo') bus.subscribe('master.modWheel', lit);
  });

  return el;
}

/** One LFO's controls. Identical for both prefixes — that is the point. */
function buildLfoPage(bus: ParamBus, prefix: LfoPrefix, b: HTMLElement): LfoPage {
  b.appendChild(new Segmented(bus, `${prefix}.wave`, WAVE_LABELS, WAVE_ICONS).el);
  const rate = new Knob({ bus, paramId: `${prefix}.rate`, label: 'RATE' });
  b.appendChild(row([
    rate.el,
    new Knob({ bus, paramId: `${prefix}.amount`, label: 'AMT' }).el,
  ]));

  const dest = new ParamDropdown(bus, `${prefix}.dest`, LFO_DEST_LABELS);
  b.appendChild(dest.el);

  // A greyed row says a destination is unavailable but not who holds it, and a
  // tooltip would be a hover-only affordance (ADR-014 law 6). So the reason is
  // a line of text — directly under the control it explains, not after SYNC.
  const taken = document.createElement('p');
  taken.className = styles.paramHint!;
  taken.dataset.testid = `dest-taken-${prefix}`;
  b.appendChild(taken);

  b.appendChild(new ParamDropdown(bus, `${prefix}.sync`, LFO_SYNC_LABELS).el);

  // While the rate is tempo-locked the knob is not what sets it (lfo.md
  // REQ-9), so dim it — the same treatment the BPM knob gets while
  // clock-slaved and SHAPE gets on the LADDER model. Dim, never hide: the
  // control keeps its place and its value, which is what it returns to on
  // 'free' (ADR-014).
  bus.subscribe(`${prefix}.sync`, (s) => rate.setDisabled(Math.round(s) > 0));
  b.appendChild(pulseRateDisclosure(bus, prefix, rate));

  return {
    refreshDest(): void {
      const blocked = blockedDests(bus.get(`${prefix}.dest`), bus.get(`${otherLfo(prefix)}.dest`));
      dest.setDisabledLabels(blocked.map((i) => LFO_DEST_LABELS[i]!));
      const name = blocked[0] === undefined ? '' : LFO_DEST_LABELS[blocked[0]]!;
      taken.textContent = name ? `${name} is used by ${LFO_NAMES[otherLfo(prefix)]}.` : '';
      taken.style.display = name ? '' : 'none';
    },
  };
}

/** The 2-knob `.spread` row, as `app.ts`'s `row()` builds it for every panel. */
function row(children: HTMLElement[]): HTMLElement {
  const r = document.createElement('div');
  r.className = `${styles.panelRow!} ${styles.spread!}`;
  for (const c of children) r.appendChild(c);
  return r;
}

/**
 * The rate is shared by every destination, but the PWM path clamps it
 * (oscillators.md REQ-9) — without this the knob would move above the cap with
 * nothing happening. Narrowing the param's own range is not an option: it would
 * make `preset-validate` reject every saved patch with a faster LFO.
 *
 * Two cues, deliberately on **one** subscription so they cannot drift apart: the
 * sentence, and a soft ceiling on the RATE knob that stops its arc filling
 * through the dead travel (knob-soft-ceiling.md). The arc is what gets noticed —
 * it is what sends the user to the sentence, which is ADR-014 law 1 (self-evident
 * beats explained) applied without giving up the explanation. Both are scoped to
 * `pulse`: every other destination really does run the full 0.05..20 Hz.
 *
 * The testid is per page: with two LFOs the same sentence appears twice, and
 * selecting it by text would break Playwright's strict mode (testids.md REQ-4).
 */
function pulseRateDisclosure(bus: ParamBus, prefix: LfoPrefix, rate: Knob): HTMLElement {
  const el = document.createElement('p');
  el.className = styles.paramHint!;
  el.dataset.testid = `pulse-hint-${prefix}`;
  el.textContent = `Pulse width follows the rate up to ${PWM_RATE_MAX} Hz.`;
  bus.subscribe(`${prefix}.dest`, (d) => {
    const pulse = Math.round(d) === PULSE_DEST;
    el.style.display = pulse ? '' : 'none';
    rate.setUiMax(pulse ? PWM_RATE_MAX : null);
  });
  return el;
}

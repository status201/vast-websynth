import styles from '../styles/tempo-lock.module.css';
import { Dropdown } from './dropdown';
import type { ParamBus } from '../../state/params';
import { syncIdFor } from '../../state/tempo-lock';
import {
  DIVISIONS,
  nearestDivision,
  sweetSpotsInRange,
  syncedValue,
  type TempoQuantity,
} from '../../utils/tempo';

/**
 * The tempo lock a `Knob` grows when its param is in `TEMPO_LOCKS` —
 * tempo-lock.md. Two pieces, mounted into the knob's existing footprint:
 *
 *   - a note glyph in the label row, lit while locked (REQ-2)
 *   - a chip that takes the dial's place while locked and opens the division
 *     menu (REQ-3)
 *
 * The lock holds **no state of its own**: it is a view of `<prefix>.sync > 0`
 * (REQ-4), so there is nothing extra to persist and nothing that can disagree
 * with a loaded preset.
 */

/** What the component needs back from the knob hosting it. */
export interface TempoLockHost {
  /** Swap the dial for the chip (or back). */
  setSynced(on: boolean): void;
  /** Re-run the knob's paint, so the readout picks up the derived value. */
  repaint(): void;
}

export interface TempoLock {
  /** The glyph button — goes in the label row. */
  lock: HTMLButtonElement;
  /** The division chip — goes where the dial is, as its **sibling**. */
  chip: HTMLElement;
  /** The value actually in charge, or `null` while free. */
  effectiveValue(): number | null;
  destroy(): void;
}

/**
 * Division labels with the space stripped — `1/16 D` becomes `1/16D`.
 *
 * A size decision, not a style one (REQ-3/REQ-9): the chip has to fit inside the
 * 30 px box a 22 px knob occupies, or locking would reflow the drum and sampler
 * FX rows. Used for the menu too, so the row you pick and the chip you get read
 * the same. `SYNC_LABELS` — the param's registered labels, and the thing every
 * saved patch indexes into — is untouched.
 */
const DIVISION_LABELS: string[] = DIVISIONS.map((d) => d.label.replace(/\s+/g, ''));

/**
 * An eighth note. Local to this component, as `dropdown.ts` keeps its magnifier —
 * but **exported**, because the help badge shows the same glyph inline when it
 * explains the lock (tempo-sync-help.md REQ-10). Drawing it twice would let the
 * explanation and the button drift apart.
 */
export function noteGlyph(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 10 12');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const stroke = (d: string): void => {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.3');
    p.setAttribute('stroke-linecap', 'round');
    svg.appendChild(p);
  };
  stroke('M6.2 1.2 L6.2 8.2'); // stem
  stroke('M6.2 1.2 C8.2 2.4 9.4 3.2 9.4 5.2'); // flag
  const head = document.createElementNS(ns, 'ellipse');
  head.setAttribute('cx', '3.7');
  head.setAttribute('cy', '8.7');
  head.setAttribute('rx', '2.7');
  head.setAttribute('ry', '2.1');
  head.setAttribute('fill', 'currentColor');
  head.setAttribute('transform', 'rotate(-20 3.7 8.7)');
  svg.appendChild(head);
  return svg;
}

export function createTempoLock(opts: {
  bus: ParamBus;
  paramId: string;
  quantity: TempoQuantity;
  /** The knob's own label ("RATE", "TIME") — used in the button's title. */
  label: string;
  host: TempoLockHost;
}): TempoLock {
  const { bus, paramId, quantity, host } = opts;
  const syncId = syncIdFor(paramId);
  const def = bus.def(paramId);
  if (!def) throw new Error(`Unknown param: ${paramId}`);

  const lock = document.createElement('button');
  lock.type = 'button';
  lock.className = styles.lock!;
  lock.dataset.testid = `tempolock-${paramId}`;
  lock.appendChild(noteGlyph());

  const chip = document.createElement('div');
  chip.className = styles.chip!;
  chip.dataset.testid = `tempodiv-${paramId}`;

  // 18 divisions, no `free` row: the glyph is the only way in and out, so a
  // second control that also unsyncs would be two answers to one question
  // (REQ-5, ADR-014 law 2).
  const menu = new Dropdown(DIVISION_LABELS, DIVISION_LABELS[0]);
  menu.el.title = 'Note division';
  chip.appendChild(menu.el);

  /** The stored index (1..18), or 0 while free. */
  const syncIndex = (): number => Math.round(bus.get(syncId));
  const locked = (): boolean => syncIndex() > 0;

  const effectiveValue = (): number | null =>
    syncedValue(syncIndex(), bus.get('transport.bpm'), quantity);

  menu.onChange((v) => {
    const i = DIVISION_LABELS.indexOf(v);
    if (i >= 0) bus.set(syncId, i + 1);
  });

  lock.addEventListener('click', () => {
    // Engaging picks the division nearest the knob's current value, so locking
    // does not jump the sound (REQ-4). Disengaging is a plain return to `free` —
    // the knob's own value was never rewritten, so it comes back exactly.
    bus.set(
      syncId,
      locked() ? 0 : nearestDivision(bus.get(paramId), bus.get('transport.bpm'), quantity),
    );
  });

  /**
   * Grey the divisions this param cannot reach at the current tempo (REQ-6) —
   * `1/1` is 4 s at 60 BPM, past a delay's 1.5 s. Greyed rather than dropped:
   * `setOptions` would silently rewrite a value that left the list
   * (dropdown.md REQ-10). Nothing is clamped in audio, so this cannot change how
   * any existing patch sounds.
   */
  const refreshReach = (): void => {
    const bpm = bus.get('transport.bpm');
    const reachable = new Set(
      sweetSpotsInRange(bpm, def.min, def.max, quantity).map((s) => s.label.replace(/\s+/g, '')),
    );
    menu.setDisabledOptions(DIVISION_LABELS.filter((l) => !reachable.has(l)));
  };

  const paint = (): void => {
    const on = locked();
    lock.classList.toggle('on', on);
    lock.setAttribute('aria-pressed', String(on));
    // Icon-only, so the name has to be spelled: `aria-label` for AT, `title` for
    // the pointer tooltip, both naming the *gesture* rather than the noun
    // (design-an-interaction step 4). Repainted together with the lit class from
    // this one function, so the state and its announcement cannot drift.
    const title = `${on ? 'Unlock' : 'Lock'} ${opts.label} ${on ? 'from' : 'to'} the tempo`;
    lock.title = title;
    lock.setAttribute('aria-label', title);
    const label = DIVISION_LABELS[syncIndex() - 1];
    if (label !== undefined) menu.setValue(label);
    host.setSynced(on);
    host.repaint();
  };

  const unsubs = [
    bus.subscribe(syncId, paint),
    bus.subscribe('transport.bpm', () => {
      refreshReach();
      // A locked knob's readout is derived from the tempo, so it moves when the
      // tempo does even though its own param has not changed.
      if (locked()) host.repaint();
    }),
  ];

  return {
    lock,
    chip,
    effectiveValue,
    destroy: (): void => {
      for (const u of unsubs) u();
      menu.destroy();
    },
  };
}

/** Exported for the tests that pin the chip's labels against `DIVISIONS`. */
export { DIVISION_LABELS };

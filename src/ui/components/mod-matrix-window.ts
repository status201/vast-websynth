import type { ParamBus } from '../../state/params';
import { LFO_DEST_LABELS } from '../../state/params';
import {
  MOD_ROWS, MOD_SOURCE_LABELS, MOD_DEST_LABELS, MOD_SRC, blockedDests,
} from '../../state/mod-routing';
import { FloatingWindow } from './floating-window';
import { Dropdown } from './dropdown';
import { ParamDropdown } from './param-dropdown';
import { Knob } from './knob';

import styles from '../styles/mod.module.css';

/**
 * The mod matrix window: eight rows of source → destination → depth.
 *
 * A `FloatingWindow` because it is non-modal — you patch a route and watch the
 * faceplate knobs answer while it plays, which is the whole feedback loop. It is also
 * the use case `specs/features/floating-window.md` was factored out for.
 *
 * Rows 0–1 are the two LFOs and are **not** editable as sources: they keep
 * `lfo.dest` / `lfo.amount`, so every preset written before the matrix still means
 * what it meant (mod-matrix.md REQ-2).
 *
 * Spec: `specs/features/mod-matrix.md`.
 */
export interface ModMatrixWindowController {
  toggle(): void;
  isOpen(): boolean;
  onChange(cb: (open: boolean) => void): () => void;
}

const NONE_SRC = MOD_SOURCE_LABELS[MOD_SRC.off]!;
const OFF_DEST = LFO_DEST_LABELS.indexOf('off');

export function createModMatrixWindowController(bus: ParamBus): ModMatrixWindowController {
  let win: FloatingWindow | null = null;
  const listeners = new Set<(open: boolean) => void>();
  const emit = (open: boolean): void => { for (const l of listeners) l(open); };

  function ensure(): FloatingWindow {
    if (win) return win;
    win = new FloatingWindow({
      title: 'Mod Matrix',
      testId: 'mod-window',
      onClose: () => emit(false),
    });
    win.body.appendChild(buildMatrix(bus));
    return win;
  }

  return {
    toggle(): void {
      const w = ensure();
      if (w.isOpen) { w.close(); return; }
      w.open();
      emit(true);
    },
    isOpen(): boolean { return win?.isOpen ?? false; },
    onChange(cb): () => void {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
  };
}

/** The table: a header row, the two LFO rows, then the six free rows. */
function buildMatrix(bus: ParamBus): HTMLElement {
  const root = document.createElement('div');
  root.className = styles.matrix!;

  const head = document.createElement('div');
  head.className = `${styles.row!} ${styles.head!}`;
  for (const label of ['Source', 'Destination', 'Amount']) {
    const c = document.createElement('span');
    c.textContent = label;
    head.appendChild(c);
  }
  root.appendChild(head);

  // Rows 0-1: the LFOs. Their source is fixed, so it is text rather than a picker —
  // a dropdown with one option is a control that lies about being a choice.
  root.appendChild(fixedRow(bus, 'LFO 1', 'lfo', 0));
  root.appendChild(fixedRow(bus, 'LFO 2', 'lfo2', 1));

  for (let n = 0; n < MOD_ROWS; n++) root.appendChild(freeRow(bus, n));

  const hint = document.createElement('p');
  hint.className = styles.hint!;
  hint.dataset.testid = 'mod-hint';
  // ADR-017's boundary, said once where someone would otherwise look for a missing
  // destination. Without it the short list reads as an omission.
  hint.textContent = 'Routes are summed in the audio engine, so they cost nothing to '
    + 'run. To move anything else — effect mixes, levels, tempo — use a Motion lane '
    + 'or the XY Pad.';
  root.appendChild(hint);

  return root;
}

/** One of the two grandfathered LFO rows (REQ-2). */
function fixedRow(bus: ParamBus, name: string, prefix: 'lfo' | 'lfo2', row: number): HTMLElement {
  const el = document.createElement('div');
  el.className = styles.row!;
  el.dataset.testid = `mod-row-${row}`;

  const src = document.createElement('span');
  src.className = styles.fixedSrc!;
  src.textContent = name;
  el.appendChild(src);

  const dest = new ParamDropdown(bus, `${prefix}.dest`, LFO_DEST_LABELS);
  dest.el.dataset.testid = `mod-dst-${row}`;
  el.appendChild(dest.el);

  el.appendChild(new Knob({ bus, paramId: `${prefix}.amount`, label: '', size: 32 }).el);

  // Same idle treatment as a free row, for the same reason: a route pointing at
  // nothing should look like one. An LFO's "off" destination is exactly that state,
  // so leaving these two undimmed would make identical rows read differently.
  bus.subscribe(`${prefix}.dest`, (d) => {
    el.classList.toggle(styles.idle!, Math.round(d) === OFF_DEST);
  });
  return el;
}

/** One of the six free rows. */
function freeRow(bus: ParamBus, n: number): HTMLElement {
  const row = n + 2;                       // display index: the LFOs are 0 and 1
  const el = document.createElement('div');
  el.className = styles.row!;
  el.dataset.testid = `mod-row-${row}`;

  const src = new Dropdown(MOD_SOURCE_LABELS, NONE_SRC);
  src.el.dataset.testid = `mod-src-${row}`;
  src.onChange((v) => {
    const i = MOD_SOURCE_LABELS.indexOf(v);
    if (i >= 0) bus.set(`mod.${n}.src`, i);
  });
  bus.subscribe(`mod.${n}.src`, (v) => {
    const label = MOD_SOURCE_LABELS[Math.round(v)];
    if (label !== undefined) src.setValue(label);
  });
  el.appendChild(src.el);

  const dest = new ParamDropdown(bus, `mod.${n}.dst`, MOD_DEST_LABELS);
  dest.el.dataset.testid = `mod-dst-${row}`;
  el.appendChild(dest.el);

  el.appendChild(new Knob({ bus, paramId: `mod.${n}.amt`, label: '', size: 32 }).el);

  // REQ-7: a per-voice source cannot drive a bus-wide destination. Greyed with the
  // reason on the option itself, never removed — the list must not reflow, and a
  // hover-only tooltip is an affordance that does not exist on touch (ADR-014 law 6).
  //
  // The ROW is never dimmed, only its cells would be: dimming the row is what would
  // make an unassigned route's own pickers unreachable (motion-sequencer.md REQ-16).
  const refresh = (): void => {
    const s = Math.round(bus.get(`mod.${n}.src`));
    const blocked = blockedDests(s).map((i) => MOD_DEST_LABELS[i]!);
    dest.setDisabledLabels(blocked);
    dest.el.title = blocked.length
      ? `${blocked.join(', ')} is one control for the whole synth, and `
        + `${MOD_SOURCE_LABELS[s]} is per-voice — eight voices cannot share it.`
      : '';
    el.classList.toggle(styles.idle!, s === MOD_SRC.off);
  };
  bus.subscribe(`mod.${n}.src`, refresh);
  bus.subscribe(`mod.${n}.dst`, refresh);

  return el;
}

// The launcher lives in `live-fx.ts` beside `xyPadLaunchButton`, so both wear the
// same faceplate button and share the "one controller, many launchers" rule.

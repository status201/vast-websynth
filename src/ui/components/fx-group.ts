import type { ParamBus } from '../../state/params';
import { Switch } from './switch';
import { Knob } from './knob';
import styles from '../styles/fx-group.module.css';

/**
 * Compact inline effect group for panel headers: divider, title, on/off
 * switch (`${onPrefix}.on`) and a row of small knobs. `opts.trailing`
 * appends one extra element after the knobs (e.g. a gain-reduction meter).
 *
 * While the effect is bypassed (`${onPrefix}.on` < 0.5) the knobs and the
 * trailing element are hidden — only divider, title and switch remain — and
 * they reappear when the param engages, whatever set it (switch click,
 * preset/song load). Param-driven visibility, not the user-driven
 * collapse-toggle.
 */
export function fxGroup(
  bus: ParamBus,
  title: string,
  onPrefix: string,
  knobs: Array<{ id: string; label: string }>,
  opts?: { knobSize?: number; trailing?: HTMLElement },
): HTMLElement {
  const group = document.createElement('div');
  group.className = styles.root!;
  group.dataset.testid = `fxgroup-${onPrefix}`;

  const divider = document.createElement('div');
  divider.className = styles.divider!;
  group.appendChild(divider);

  const label = document.createElement('span');
  label.textContent = title;
  label.className = styles.label!;
  group.appendChild(label);

  group.appendChild(new Switch(bus, `${onPrefix}.on`, 'on').el);

  const knobRow = document.createElement('div');
  knobRow.className = styles.knobs!;
  for (const k of knobs) {
    knobRow.appendChild(new Knob({ bus, paramId: k.id, label: k.label, size: opts?.knobSize ?? 22 }).el);
  }
  if (opts?.trailing) knobRow.appendChild(opts.trailing);
  group.appendChild(knobRow);

  bus.subscribe(`${onPrefix}.on`, (v) => {
    group.classList.toggle('collapsed', v < 0.5);
  });

  return group;
}

/**
 * The bare vertical rule `fxGroup` puts before its title, on its own.
 *
 * Exported so a row can separate something that is **not** an FX group with the same
 * mark — the Song row's MOD launcher, which is a door onto the patch's modulation
 * routing rather than one of the momentary Live FX gestures beside it. Reused rather
 * than re-drawn so the two rules in that row cannot drift apart.
 */
export function rowDivider(): HTMLElement {
  const el = document.createElement('div');
  el.className = styles.divider!;
  return el;
}

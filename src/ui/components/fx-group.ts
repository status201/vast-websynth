import type { ParamBus } from '../../state/params';
import { Switch } from './switch';
import { Knob } from './knob';
import styles from '../styles/fx-group.module.css';

/**
 * Compact inline effect group for panel headers: divider, title, on/off
 * switch (`${onPrefix}.on`) and a row of small knobs. `opts.trailing`
 * appends one extra element after the knobs (e.g. a gain-reduction meter).
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

  const divider = document.createElement('div');
  divider.className = styles.divider!;
  group.appendChild(divider);

  const label = document.createElement('span');
  label.textContent = title;
  label.className = styles.label!;
  group.appendChild(label);

  group.appendChild(new Switch(bus, `${onPrefix}.on`, 'on').el);

  for (const k of knobs) {
    group.appendChild(new Knob({ bus, paramId: k.id, label: k.label, size: opts?.knobSize ?? 22 }).el);
  }

  if (opts?.trailing) group.appendChild(opts.trailing);

  return group;
}

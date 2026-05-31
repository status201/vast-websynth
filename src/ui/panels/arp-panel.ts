import type { ParamBus } from '../../state/params';
import { ARP_PATTERN_LABELS, ARP_RATE_LABELS } from '../../state/params';
import { Switch } from '../components/switch';
import { Segmented } from '../components/segmented';
import { Knob } from '../components/knob';
import layout from '../styles/layout.module.css';
import styles from '../styles/arp.module.css';

export function buildArpPanel(bus: ParamBus): HTMLElement {
  const root = document.createElement('div');
  root.className = `${layout.patternPanel!} arp-panel`;
  const header = document.createElement('div');
  header.className = layout.patternPanelHeader!;
  header.appendChild(new Switch(bus, 'arp.on', 'arp').el);
  root.appendChild(header);

  const body = document.createElement('div');
  body.className = styles.body!;

  const patternGroup = group('Pattern', new Segmented(bus, 'arp.pattern', ARP_PATTERN_LABELS).el);
  body.appendChild(patternGroup);

  const rateGroup = group('Rate', new Segmented(bus, 'arp.rate', ARP_RATE_LABELS).el);
  body.appendChild(rateGroup);

    const knobs = document.createElement('div');
    knobs.className = styles.knobs!;
  knobs.appendChild(new Knob({ bus, paramId: 'arp.octaves', label: 'OCTAVES' }).el);
  knobs.appendChild(new Knob({ bus, paramId: 'arp.gate', label: 'GATE' }).el);
  body.appendChild(knobs);

  root.appendChild(body);

  return root;
}

function group(label: string, inner: HTMLElement): HTMLElement {
  const g = document.createElement('div');
  g.className = styles.group!;
  const l = document.createElement('div');
  l.className = styles.groupLabel!;
  l.textContent = label;
  g.appendChild(l);
  g.appendChild(inner);
  return g;
}

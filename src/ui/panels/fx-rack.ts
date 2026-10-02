import type { ParamBus } from '../../state/params';
import { Knob } from '../components/knob';
import { Switch } from '../components/switch';
import { fxPatchDecoration } from '../components/fx-patch-decoration';
import { createCollapseToggle } from '../components/collapse-toggle';
import { createSectionTitle } from '../components/section-title';
import { isCompact } from '../viewport';
import fxStyles from '../styles/fx-rack.module.css';

/**
 * The synth's insert-effect rack under the synth panels, behind its own
 * foldable FX bar (effects.md). `expand` unfolds it — the tour calls it to show
 * an effect. Takes only the bus, like the synth panels.
 */
export function buildFxRack(bus: ParamBus): { el: HTMLElement; expand: () => void } {
  const section = document.createElement('div');
  section.className = fxStyles.fxSection!;
  section.dataset.testid = 'fx';

  const bar = document.createElement('div');
  bar.className = fxStyles.fxSectionBar!;
  // The same heading the tabbed sections wear (section-title.md REQ-one-component-draws-every-heading).
  bar.appendChild(createSectionTitle({ text: 'FX', icon: 'waveBurst' }));
  const collapse = createCollapseToggle(section, 'websynth.ui.collapsed.fx', {
    defaultCollapsed: isCompact,
    trigger: bar, // whole FX bar toggles, not just the chevron
  });
  bar.appendChild(collapse.el);
  section.appendChild(bar);

  const fx = document.createElement('div');
  fx.className = fxStyles.fxRow!;

  for (const spec of RACK) fx.appendChild(fxPanel(bus, spec));

  // An odd effect count in the ≤992px 2-column grid leaves one cell empty; fill
  // it with the unpatched-cable scenery (fx-patch-decoration.md). Parity-keyed,
  // so the six effects shipping today drop it rather than push it onto a row of
  // its own — a seventh would bring it back with no change here.
  if (fx.childElementCount % 2 === 1) fx.appendChild(fxPatchDecoration());

  section.appendChild(fx);
  return { el: section, expand: collapse.expand };
}

/**
 * One effect: its title, its param prefix and its knobs. The prefix names the
 * whole panel — `${id}.on` is the bypass switch, `${id}.<knob>` each knob, and
 * `id` itself the info-badge help key.
 */
interface FxSpec {
  title: string;
  id: string;
  knobs: ReadonlyArray<readonly [param: string, label: string]>;
}

/** The rack, left to right — the order of the insert chain itself. */
const RACK: readonly FxSpec[] = [
  { title: 'Distortion', id: 'fx.dist', knobs: [['drive', 'DRIVE'], ['tone', 'TONE'], ['mix', 'MIX']] },
  { title: 'Wah', id: 'fx.wah', knobs: [['rate', 'RATE'], ['depth', 'DEPTH'], ['q', 'Q']] },
  { title: 'Phaser', id: 'fx.phaser', knobs: [['rate', 'RATE'], ['depth', 'DEPTH'], ['feedback', 'FB'], ['mix', 'MIX']] },
  { title: 'Delay', id: 'fx.delay', knobs: [['time', 'TIME'], ['feedback', 'FB'], ['mix', 'MIX']] },
  { title: 'Reverb', id: 'fx.reverb', knobs: [['size', 'SIZE'], ['damp', 'DAMP'], ['mix', 'MIX']] },
  // Last in the rack because it is last in the chain (sidechain-ducking.md
  // REQ-the-ducker-is-last-in-the-chain/REQ-ducking-adds-no-new-gesture): SRC is a discrete knob over the drum lanes + Any, the same
  // shape as the drum compressor's RATIO.
  { title: 'Duck', id: 'fx.duck', knobs: [['amount', 'AMT'], ['attack', 'ATK'], ['release', 'REL'], ['src', 'SRC']] },
];

function fxPanel(bus: ParamBus, { title, id, knobs }: FxSpec): HTMLElement {
  const el = document.createElement('div');
  el.className = fxStyles.fxPanel!;

  const header = document.createElement('div');
  header.className = fxStyles.fxHeader!;
  const t = document.createElement('div');
  t.className = fxStyles.fxTitle!;
  t.textContent = title;
  t.dataset.help = id;
  header.appendChild(t);
  header.appendChild(new Switch(bus, `${id}.on`, 'on').el);
  el.appendChild(header);

  const knobsEl = document.createElement('div');
  knobsEl.className = fxStyles.fxKnobs!;
  for (const [param, label] of knobs) {
    knobsEl.appendChild(new Knob({ bus, paramId: `${id}.${param}`, label }).el);
  }
  el.appendChild(knobsEl);

  return el;
}

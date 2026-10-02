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

  fx.appendChild(fxPanel('Distortion', bus, 'fx.dist.on', [
    { id: 'fx.dist.drive', label: 'DRIVE' },
    { id: 'fx.dist.tone', label: 'TONE' },
    { id: 'fx.dist.mix', label: 'MIX' },
  ], 'fx.dist'));

  fx.appendChild(fxPanel('Wah', bus, 'fx.wah.on', [
    { id: 'fx.wah.rate', label: 'RATE' },
    { id: 'fx.wah.depth', label: 'DEPTH' },
    { id: 'fx.wah.q', label: 'Q' },
  ], 'fx.wah'));

  fx.appendChild(fxPanel('Phaser', bus, 'fx.phaser.on', [
    { id: 'fx.phaser.rate', label: 'RATE' },
    { id: 'fx.phaser.depth', label: 'DEPTH' },
    { id: 'fx.phaser.feedback', label: 'FB' },
    { id: 'fx.phaser.mix', label: 'MIX' },
  ], 'fx.phaser'));

  fx.appendChild(fxPanel('Delay', bus, 'fx.delay.on', [
    { id: 'fx.delay.time', label: 'TIME' },
    { id: 'fx.delay.feedback', label: 'FB' },
    { id: 'fx.delay.mix', label: 'MIX' },
  ], 'fx.delay'));

  fx.appendChild(fxPanel('Reverb', bus, 'fx.reverb.on', [
    { id: 'fx.reverb.size', label: 'SIZE' },
    { id: 'fx.reverb.damp', label: 'DAMP' },
    { id: 'fx.reverb.mix', label: 'MIX' },
  ], 'fx.reverb'));

  // Last in the rack because it is last in the chain (sidechain-ducking.md
  // REQ-the-ducker-is-last-in-the-chain/REQ-ducking-adds-no-new-gesture): SRC is a discrete knob over the drum lanes + Any, the same
  // shape as the drum compressor's RATIO.
  fx.appendChild(fxPanel('Duck', bus, 'fx.duck.on', [
    { id: 'fx.duck.amount', label: 'AMT' },
    { id: 'fx.duck.attack', label: 'ATK' },
    { id: 'fx.duck.release', label: 'REL' },
    { id: 'fx.duck.src', label: 'SRC' },
  ], 'fx.duck'));

  // An odd effect count in the ≤992px 2-column grid leaves one cell empty; fill
  // it with the unpatched-cable scenery (fx-patch-decoration.md). Parity-keyed,
  // so the six effects shipping today drop it rather than push it onto a row of
  // its own — a seventh would bring it back with no change here.
  if (fx.childElementCount % 2 === 1) fx.appendChild(fxPatchDecoration());

  section.appendChild(fx);
  return { el: section, expand: collapse.expand };
}

function fxPanel(
  title: string,
  bus: ParamBus,
  onParam: string,
  knobs: Array<{ id: string; label: string }>,
  helpId: string,
): HTMLElement {
  const el = document.createElement('div');
  el.className = fxStyles.fxPanel!;

  const header = document.createElement('div');
  header.className = fxStyles.fxHeader!;
  const t = document.createElement('div');
  t.className = fxStyles.fxTitle!;
  t.textContent = title;
  t.dataset.help = helpId;
  header.appendChild(t);
  header.appendChild(new Switch(bus, onParam, 'on').el);
  el.appendChild(header);

  const knobsEl = document.createElement('div');
  knobsEl.className = fxStyles.fxKnobs!;
  for (const k of knobs) {
    knobsEl.appendChild(new Knob({ bus, paramId: k.id, label: k.label }).el);
  }
  el.appendChild(knobsEl);

  return el;
}

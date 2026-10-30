import type { ParamBus } from '../../state/params';
import { Knob, dimWhileModeSet } from '../components/knob';
import { Switch } from '../components/switch';
import { CHORUS_MODE_OVERRIDES } from '../../state/chorus';
import { DELAY_KNOBS, delayTypeDropdown, dimCharAtDigital } from '../components/delay-type-controls';
import { createFxSlot } from '../components/fx-slot-picker';
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

  for (const entry of RACK) fx.appendChild(fxPanel(bus, entry));

  // An odd effect count in the ≤992px 2-column grid leaves one cell empty; fill
  // it with the unpatched-cable scenery (fx-patch-decoration.md). Parity-keyed,
  // so the six panels shipping today (eight effects: the flanger and the chorus
  // share the Phaser's) drop it rather than push it onto a row of its own — a
  // seventh panel would bring it back with no change here. Imported here, not
  // statically, so dormant scenery costs the entry chunk nothing; a failed load
  // just leaves the cell empty (fx-patch-decoration.md REQ-decoration-is-parity-keyed, v3).
  if (fx.childElementCount % 2 === 1) {
    import('../components/fx-patch-decoration')
      .then((m) => fx.appendChild(m.fxPatchDecoration()))
      .catch(() => {});
  }

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
  /** A control that is the title, handed `title` as its legend: the delay's TYPE dropdown. */
  titleControl?: (bus: ParamBus, id: string, title: string) => HTMLElement;
  /** Wiring between the built knobs and the bus — which knobs a mode or type dims. */
  wire?: (bus: ParamBus, id: string, knobs: readonly Knob[]) => void;
}

/**
 * One rack panel: an effect of its own, or a slot two effects share behind a
 * caret by the title (fx-slot-picker.md) — the first is the one shown by default.
 */
type RackEntry = FxSpec | readonly FxSpec[];

/**
 * The Phaser's face, which the Flanger shares, so a view swap reflows nothing
 * (flanger.md REQ-the-flanger-shares-the-phaser-slot).
 */
const SWEEP_KNOBS: FxSpec['knobs'] = [['rate', 'RATE'], ['depth', 'DEPTH'], ['feedback', 'FB'], ['mix', 'MIX']];

/** The rack, left to right — the order of the insert chain itself. */
const RACK: readonly RackEntry[] = [
  { title: 'Distortion', id: 'fx.dist', knobs: [['drive', 'DRIVE'], ['tone', 'TONE'], ['mix', 'MIX']] },
  { title: 'Wah', id: 'fx.wah', knobs: [['rate', 'RATE'], ['depth', 'DEPTH'], ['q', 'Q']] },
  // The flanger and the chorus have no panels of their own; they share the
  // Phaser's, in chain order (fx-slot-picker.md REQ-the-slot-lists-its-effects-in-chain-order).
  [
    { title: 'Phaser', id: 'fx.phaser', knobs: SWEEP_KNOBS },
    { title: 'Flanger', id: 'fx.flanger', knobs: SWEEP_KNOBS },
    {
      title: 'Chorus', id: 'fx.chorus',
      knobs: [['rate', 'RATE'], ['depth', 'DEPTH'], ['mode', 'MODE'], ['mix', 'MIX']],
      wire: (bus, id, knobs) => dimWhileModeSet(bus, id, CHORUS_MODE_OVERRIDES, knobs),
    },
  ],
  // TYPE is the title (a DELAY legend over the type), CHAR dimmed at DIGITAL: the
  // header groups' knobs and dropdown (delay-types.md REQ-type-is-a-header-dropdown-and-char-a-knob).
  { title: 'Delay', id: 'fx.delay', knobs: DELAY_KNOBS, titleControl: delayTypeDropdown, wire: dimCharAtDigital },
  { title: 'Reverb', id: 'fx.reverb', knobs: [['size', 'SIZE'], ['damp', 'DAMP'], ['mix', 'MIX']] },
  // Last in the rack because it is last in the chain (sidechain-ducking.md
  // REQ-the-ducker-is-last-in-the-chain/REQ-ducking-adds-no-new-gesture): SRC is a discrete knob over the drum lanes + Any, the same
  // shape as the drum compressor's RATIO.
  { title: 'Duck', id: 'fx.duck', knobs: [['amount', 'AMT'], ['attack', 'ATK'], ['release', 'REL'], ['src', 'SRC']] },
];

function fxPanel(bus: ParamBus, entry: RackEntry): HTMLElement {
  const el = document.createElement('div');
  el.className = fxStyles.fxPanel!;

  if (!isSlot(entry)) {
    const view = fxView(bus, entry);
    el.append(view.header, view.knobs);
    return el;
  }

  // A slot: every view is built and stays subscribed; the slot shows one
  // (fx-slot-picker.md REQ-the-slot-shows-one-effect-at-a-time).
  const views = entry.map((spec) => {
    const view = fxView(bus, spec);
    const shell = document.createElement('div');
    shell.className = fxStyles.fxView!;
    shell.dataset.testid = `fxview-${spec.id}`;
    shell.append(view.header, view.knobs);
    el.appendChild(shell);
    return { prefix: spec.id, title: spec.title, el: shell, caretHost: view.titleRow, titleEl: view.title };
  });
  createFxSlot(bus, views);
  return el;
}

const isSlot = (e: RackEntry): e is readonly FxSpec[] => Array.isArray(e);

/**
 * An effect's face: header (title row + switch) and knob row. The title row
 * holds the title and, in a slot, the picker's caret after it; it carries
 * `data-help`, so the ⓘ badge lands after the caret rather than on it.
 */
function fxView(
  bus: ParamBus,
  { title, id, knobs, titleControl, wire }: FxSpec,
): { header: HTMLElement; knobs: HTMLElement; titleRow: HTMLElement; title: HTMLElement } {
  const header = document.createElement('div');
  header.className = fxStyles.fxHeader!;
  const titleRow = document.createElement('div');
  titleRow.className = fxStyles.fxTitleRow!;
  titleRow.dataset.help = id;
  let t: HTMLElement;
  if (titleControl) {
    t = titleControl(bus, id, title);
  } else {
    t = document.createElement('div');
    t.className = fxStyles.fxTitle!;
    t.textContent = title;
  }
  titleRow.appendChild(t);
  header.appendChild(titleRow);
  header.appendChild(new Switch(bus, `${id}.on`, 'on').el);

  const knobsEl = document.createElement('div');
  knobsEl.className = fxStyles.fxKnobs!;
  const built = knobs.map(([param, label]) => new Knob({ bus, paramId: `${id}.${param}`, label }));
  for (const k of built) knobsEl.appendChild(k.el);
  wire?.(bus, id, built);

  return { header, knobs: knobsEl, titleRow, title: t };
}

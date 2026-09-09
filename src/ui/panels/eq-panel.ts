import type { ParamBus } from '../../state/params';
import type { StudioApi } from '../studio-api';
import { readEqSettings, eqIsFlat, eqCurveParamIds } from '../../state/eq';
import {
  EQ_PRESET_CUSTOM, applyEqPreset, eqPresetNames, matchEqPreset, resetEq,
} from '../../state/eq-presets';
import { TabContainer } from '../components/tabs';
import { Switch } from '../components/switch';
import { Knob } from '../components/knob';
import { Dropdown } from '../components/dropdown';
import { createButton } from '../components/button';
import { EqGraph } from '../components/eq-graph';
import type { MachineState } from '../machine-status';
import styles from '../styles/eq.module.css';

/**
 * The EQUALIZER section — `specs/features/equalizer.md`.
 *
 * `EQUALIZER  ●SEQUENCER  ●DRUM MACHINE  ●SAMPLER`, folded by default, one
 * drawable EQ per lane. Almost nothing here is new machinery: `TabContainer`
 * already owns the fold, the persistence key, the LED-before-label and the
 * expand-then-activate click, so this is mostly a wiring file.
 *
 * The one thing worth reading twice is the LED (REQ-10). It is **inert** — the
 * component gives it `pointer-events: none` so a tab click always navigates —
 * and the real on/off is the `Switch` inside each page. It carries three states,
 * not two: `muted` means *engaged but flat*, which is otherwise invisible state
 * and so forbidden by ADR-014 law 5.
 */

interface Lane {
  /** TabContainer id. `eq-`-prefixed so `tab-<id>` cannot shadow the pattern
   *  row's `tab-seq` / `tab-drums` / `tab-sampler` (REQ-11, testids.md REQ-6). */
  id: string;
  /** Tab label. `.tab` uppercases it, so this is the one place it is title-case. */
  label: string;
  /** Param prefix. */
  prefix: string;
  /** Testid suffix. */
  key: string;
}

const LANES: readonly Lane[] = [
  { id: 'eq-seq', label: 'Sequencer', prefix: 'fx.eq', key: 'seq' },
  { id: 'eq-drums', label: 'Drum Machine', prefix: 'fx.drum.eq', key: 'drums' },
  { id: 'eq-sampler', label: 'Sampler', prefix: 'fx.sampler.eq', key: 'sampler' },
];

export interface EqPanel {
  el: HTMLElement;
  tabs: TabContainer;
  destroy(): void;
}

export function buildEqPanel(bus: ParamBus, engine: StudioApi): EqPanel {
  const disposers: Array<() => void> = [];
  const graphs = new Map<string, EqGraph>();

  const pages = LANES.map((lane) => ({
    id: lane.id,
    label: lane.label,
    indicator: true,
    content: buildLanePage(bus, engine, lane, disposers, graphs),
  }));

  const tabs = new TabContainer(pages, LANES[0]!.id, {
    title: 'Equalizer',
    // Cancels the shell's own horizontal padding, so the graph can reach the
    // same x as the scope canvas above it (REQ-18).
    pageClass: styles.pageShell!,
    collapsibleStoreKey: 'websynth.ui.collapsed.eq',
    // Unconditionally, unlike the pattern row's `isCompact`: this is a tool you
    // reach for, not a surface you live in (REQ-9).
    collapsedByDefault: () => true,
  });
  tabs.el.dataset.testid = 'eq-section';

  // The lamp per lane. Recomputed from the two things that can change it — the
  // on/off and the curve — so "on but flat" can never be reported as "shaping".
  for (const lane of LANES) {
    const paint = (): void => {
      tabs.setIndicator(lane.id, eqState(bus, lane.prefix));
    };
    disposers.push(bus.subscribe(`${lane.prefix}.on`, paint));
    for (const id of eqCurveParamIds(lane.prefix)) disposers.push(bus.subscribe(id, paint));
  }

  // Off-screen means off-duty, and a fold counts as off screen
  // (runtime-performance REQ-4). `onViewChange` fires on both a tab switch and a
  // collapse, which is exactly the pair that decides this.
  const syncVisibility = (): void => {
    for (const lane of LANES) graphs.get(lane.id)?.setVisible(tabs.isVisible(lane.id));
  };
  disposers.push(tabs.onViewChange(syncVisibility));
  syncVisibility();

  return {
    el: tabs.el,
    tabs,
    destroy(): void {
      for (const d of disposers) d();
      disposers.length = 0;
      for (const g of graphs.values()) g.destroy();
      graphs.clear();
    },
  };
}

/** The lamp's three states (REQ-10). */
function eqState(bus: ParamBus, prefix: string): MachineState {
  if (bus.get(`${prefix}.on`) < 0.5) return 'off';
  return eqIsFlat(readEqSettings(bus, prefix)) ? 'muted' : 'on';
}

function buildLanePage(
  bus: ParamBus,
  engine: StudioApi,
  lane: Lane,
  disposers: Array<() => void>,
  graphs: Map<string, EqGraph>,
): HTMLElement {
  // The page IS the grid (REQ-18): one gutter-wide column of controls, then
  // the graph. Same `--wheel-col 1fr` the wheels and scope use one row up.
  const page = document.createElement('div');
  page.className = styles.page!;

  const controls = document.createElement('div');
  controls.className = styles.controls!;
  controls.dataset.help = 'fx.eq';

  // ON and RESET share the top row; together they just fit the column.
  const switchRow = document.createElement('div');
  switchRow.className = styles.switchRow!;
  // The only control that switches the EQ on or off (REQ-10). Every control
  // built here registers its own teardown, so `destroy()` is the whole truth
  // rather than most of it — `Dropdown` in particular holds *document*-level
  // click and keydown listeners for its whole life, not just while open.
  const onSwitch = new Switch(bus, `${lane.prefix}.on`, 'on');
  disposers.push(() => onSwitch.destroy());
  switchRow.appendChild(onSwitch.el);

  const presetWrap = document.createElement('div');
  presetWrap.className = styles.presetWrap!;
  // `Custom` is a *report*, never a choice: it appears in the list only while it
  // is what the curve is, and `setDisabledOptions` renders it unpickable
  // (dropdown.md REQ-10). Picking it would have to mean something, and there is
  // nothing for it to mean.
  const preset = new Dropdown([...eqPresetNames(), EQ_PRESET_CUSTOM], eqPresetNames()[0]);
  preset.setDisabledOptions([EQ_PRESET_CUSTOM]);
  preset.el.dataset.testid = `eq-preset-${lane.key}`;
  preset.onChange((name) => applyEqPreset(bus, lane.prefix, name));
  disposers.push(() => preset.destroy());
  presetWrap.appendChild(preset.el);

  const reset = createButton({
    label: 'Reset',
    title: 'Flatten this EQ — leaves it switched on or off as it is',
    testId: `eq-reset-${lane.key}`,
    onClick: () => resetEq(bus, lane.prefix),
  });
  switchRow.appendChild(reset);

  controls.appendChild(switchRow);
  controls.appendChild(presetWrap);

  const graph = new EqGraph({
    bus,
    prefix: lane.prefix,
    lane: lane.key,
    // The response of a digital filter depends on the sample rate, so the
    // drawing must use the real one or it would disagree with the audio near
    // the top of the axis. `ctx` is already on StudioApi — no new member.
    sampleRate: engine.ctx.sampleRate,
  });
  graphs.set(lane.id, graph);

  // HP · LP · WIDTH side by side, where the three wheels sit in the row above.
  // Size 28 is not a taste call: three knob roots (`knob-size + 8`) plus two
  // 2px gaps must fit the column's ~112px of usable width.
  const knobs = document.createElement('div');
  knobs.className = styles.knobs!;
  for (const [suffix, label] of [['hp', 'HP'], ['lp', 'LP'], ['width', 'WIDTH']] as const) {
    const knob = new Knob({ bus, paramId: `${lane.prefix}.${suffix}`, label, size: 28 });
    disposers.push(() => knob.destroy());
    knobs.appendChild(knob.el);
  }
  controls.appendChild(knobs);

  page.appendChild(controls);
  page.appendChild(graph.el);

  // Keep the dropdown honest: the moment the curve stops being the named shape
  // it says so, rather than naming a shape that is no longer on screen
  // (ADR-014 law 5 — the scratch presets' rule).
  const syncPreset = (): void => {
    preset.setValue(matchEqPreset(readEqSettings(bus, lane.prefix)));
  };
  for (const id of eqCurveParamIds(lane.prefix)) {
    disposers.push(bus.subscribe(id, syncPreset));
  }

  return page;
}

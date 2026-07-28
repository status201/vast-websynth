import styles from '../styles/zoetrope.module.css';
import switchStyles from '../styles/switch.module.css';
import { Knob } from './knob';
import { Switch } from './switch';
import { Segmented } from './segmented';
import { Stepper } from './stepper';
import { createHoldButton } from './hold-button';
import { createCollapseToggle } from './collapse-toggle';
import { CycleStrip } from './cycle-strip';
import type { ParamBus } from '../../state/params';
import type { StudioApi } from '../studio-api';

const PREFIX = 'fx.zoetrope';
/** Counts worth landing on exactly; everything between stays reachable. */
const DEPTH_MAGNETS = [1, 2, 4, 8, 16, 32, 64] as const;

export interface ZoetropeRow {
  readonly el: HTMLElement;
  /**
   * The FX rack's own fold state. Telemetry is only worth paying for while the
   * module can actually be seen (zoetrope.md REQ-9).
   */
  setSectionCollapsed(collapsed: boolean): void;
  destroy(): void;
}

/**
 * The Zoetrope module — a full-width band below the FX grid.
 *
 * Laid out as header · knobs · controls · cycle strip · advanced expander. The
 * body collapses to the header alone while the effect is bypassed, using the
 * same param-driven `.collapsed` mechanism as `fx-group` (REQ-10), which also
 * means a bypassed module is doing no work at all: no strip, no telemetry.
 */
export function buildZoetropeRow(bus: ParamBus, engine: StudioApi): ZoetropeRow {
  const root = document.createElement('div');
  root.className = styles.root!;
  // The fx-group testid shape, so help badges anchor to the module root and stay
  // reachable while it is bypassed (fx-group.md REQ-5).
  root.dataset.testid = `fxgroup-${PREFIX}`;
  root.dataset.help = PREFIX;

  const disposers: Array<() => void> = [];
  const strip = new CycleStrip();

  // ---------- Header: title, chips, on switch ----------
  const header = document.createElement('div');
  header.className = styles.header!;

  const title = document.createElement('div');
  title.className = styles.title!;
  title.textContent = 'Zoetrope';
  header.appendChild(title);

  const chips = document.createElement('div');
  chips.className = styles.chips!;

  const pitchLock = new Switch(bus, `${PREFIX}.pitchlock`, 'pitch lock');
  pitchLock.el.classList.add(styles.chip!);
  pitchLock.el.title = 'Lock the cycle clock to the sounding pitch; off falls back to zero-crossing detection';
  chips.appendChild(pitchLock.el);
  disposers.push(() => pitchLock.destroy());

  const hz = document.createElement('div');
  hz.className = styles.chip!;
  hz.dataset.testid = 'zoetrope-hz';
  hz.textContent = 'tracking —';
  chips.appendChild(hz);
  header.appendChild(chips);

  const onSwitch = new Switch(bus, `${PREFIX}.on`, 'on');
  header.appendChild(onSwitch.el);
  disposers.push(() => onSwitch.destroy());
  root.appendChild(header);

  // ---------- Body (hidden while bypassed) ----------
  const body = document.createElement('div');
  body.className = styles.body!;

  const knobs = document.createElement('div');
  knobs.className = styles.knobs!;
  const knobDefs: Array<{ id: string; label: string; bipolar?: boolean }> = [
    { id: `${PREFIX}.scatter`, label: 'SCATTER' },
    { id: `${PREFIX}.chaos`, label: 'CHAOS' },
    { id: `${PREFIX}.smear`, label: 'SMEAR' },
    { id: `${PREFIX}.sieve`, label: 'SIEVE', bipolar: true },
    { id: `${PREFIX}.mix`, label: 'MIX' },
  ];
  for (const k of knobDefs) {
    const knob = new Knob({ bus, paramId: k.id, label: k.label, bipolar: k.bipolar });
    knobs.appendChild(knob.el);
    disposers.push(() => knob.destroy());
  }
  body.appendChild(knobs);

  // ---------- Controls: freeze, source, depth ----------
  const controls = document.createElement('div');
  controls.className = styles.controls!;

  const freeze = createHoldButton({
    mode: 'latch',
    bus,
    paramId: `${PREFIX}.freeze`,
    label: 'Freeze',
    testId: 'zoetrope-freeze',
    className: `${switchStyles.root!} ${styles.freeze!}`,
    title: 'Click to latch, hold to freeze only while held',
  });
  controls.appendChild(freeze.el);
  disposers.push(() => freeze.destroy());

  controls.appendChild(labelled('Source', () => {
    const seg = new Segmented(bus, `${PREFIX}.source`, ['Self', 'Drums']);
    disposers.push(() => seg.destroy());
    return seg.el;
  }));

  const depth = new Stepper({ bus, paramId: `${PREFIX}.depth`, label: 'Depth', magnets: DEPTH_MAGNETS });
  depth.el.classList.add(styles.depth!);
  controls.appendChild(depth.el);
  disposers.push(() => depth.destroy());

  body.appendChild(controls);

  // ---------- Cycle library ----------
  const stripWrap = document.createElement('div');
  stripWrap.className = styles.stripWrap!;

  const stripHead = document.createElement('div');
  stripHead.className = styles.stripHead!;
  const stripTitle = document.createElement('span');
  stripTitle.textContent = 'Cycle library';
  const reading = document.createElement('span');
  reading.dataset.testid = 'zoetrope-reading';
  reading.textContent = 'reading —';
  stripHead.appendChild(stripTitle);
  stripHead.appendChild(reading);
  stripWrap.appendChild(stripHead);

  stripWrap.appendChild(strip.el);

  const ends = document.createElement('div');
  ends.className = styles.stripEnds!;
  const oldest = document.createElement('span');
  oldest.textContent = 'oldest';
  const now = document.createElement('span');
  now.textContent = 'now';
  ends.appendChild(oldest);
  ends.appendChild(now);
  stripWrap.appendChild(ends);
  body.appendChild(stripWrap);

  // ---------- Advanced expander ----------
  const adv = document.createElement('div');
  adv.className = styles.adv!;
  adv.dataset.testid = 'zoetrope-adv';

  const advBar = document.createElement('div');
  advBar.className = styles.advBar!;
  const advTitle = document.createElement('span');
  advTitle.textContent = 'Advanced';
  advBar.appendChild(advTitle);
  const advToggle = createCollapseToggle(adv, 'websynth.ui.collapsed.zoetrope-adv', {
    defaultCollapsed: () => true,
    trigger: advBar,
  });
  advToggle.el.dataset.testid = 'zoetrope-adv-toggle';
  advBar.appendChild(advToggle.el);
  adv.appendChild(advBar);

  const advBody = document.createElement('div');
  advBody.className = styles.advBody!;

  const taps = new Stepper({ bus, paramId: `${PREFIX}.taps`, label: 'Avg taps' });
  advBody.appendChild(taps.el);
  disposers.push(() => taps.destroy());

  const subKnob = new Knob({ bus, paramId: `${PREFIX}.sub`, label: 'SUB', size: 34 });
  advBody.appendChild(subKnob.el);
  disposers.push(() => subKnob.destroy());

  const xfade = new Stepper({ bus, paramId: `${PREFIX}.xfadeFloor`, label: 'Xfade min' });
  advBody.appendChild(xfade.el);
  disposers.push(() => xfade.destroy());

  advBody.appendChild(labelled('Clear on note', () => {
    const sw = new Switch(bus, `${PREFIX}.clearOnNote`, 'on');
    disposers.push(() => sw.destroy());
    return sw.el;
  }));

  adv.appendChild(advBody);
  body.appendChild(adv);
  root.appendChild(body);

  // ---------- Telemetry gating ----------
  // Three independent reasons the display can't be seen; the worklet is only
  // asked to post while none of them hold.
  let engaged = false;
  let sectionCollapsed = false;
  let metering = false;

  const syncMetering = (): void => {
    const want = engaged && !sectionCollapsed && document.visibilityState !== 'hidden';
    if (want === metering) return;
    metering = want;
    engine.zoetrope.setMetering(want);
    if (!want) {
      strip.clear();
      writeText(hz, 'tracking —');
      writeText(reading, 'reading —');
    }
  };

  const onVisibility = (): void => syncMetering();
  document.addEventListener('visibilitychange', onVisibility);
  disposers.push(() => document.removeEventListener('visibilitychange', onVisibility));

  const unsubOn = bus.subscribe(`${PREFIX}.on`, (v) => {
    engaged = v >= 0.5;
    root.classList.toggle('collapsed', !engaged);
    syncMetering();
  });
  disposers.push(unsubOn);

  engine.zoetrope.onCycles((m) => {
    strip.update(m);
    // Guarded writes: this runs ~31 times a second and the text rarely changes
    // (runtime-performance REQ-7).
    writeText(hz, m.hz > 0 ? `tracking ${Math.round(m.hz)} hz` : 'tracking —');
    writeText(reading, `reading -${Math.max(0, m.lag - 1)}`);
  });

  return {
    el: root,
    setSectionCollapsed(collapsed: boolean): void {
      sectionCollapsed = collapsed;
      syncMetering();
    },
    destroy(): void {
      for (const d of disposers) d();
    },
  };
}

/** A small captioned control cluster — `Source`, `Clear on note`. */
function labelled(text: string, build: () => HTMLElement): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = styles.field!;
  const cap = document.createElement('div');
  cap.className = styles.fieldLabel!;
  cap.textContent = text;
  wrap.appendChild(cap);
  wrap.appendChild(build());
  return wrap;
}

function writeText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

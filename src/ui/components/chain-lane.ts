/**
 * One Song-tab chain lane — the chip row, its palette and the transpose/move/clear
 * toolbar (arrangement.md, song-mode.md). Built once per machine by the Song panel.
 */
import type { ParamBus } from '../../state/params';
import type { StudioApi } from '../studio-api';
import type { UiBridge } from '../ui-bridge';
import type { ChainLane } from '../../audio/transport/arrangement';
import { Knob } from './knob';
import { Switch } from './switch';
import type { LaneId } from '../../audio/transport/lane-mix';
import { MACHINE_TAB } from '../machine-status';
import { confirmDialog } from './dialog';
import { BANK_LABELS, REST, clampTranspose } from '../../state/patterns';
import { restIcon } from './rest-glyph';
import { createChainToggle } from './chain-toggle';
import { attachChipReorder } from './chip-reorder';
import switchStyles from '../styles/switch.module.css';
import bankStyles from '../styles/bank-bar.module.css';
import styles from '../styles/song-panel.module.css';
import { UI_ICONS } from './ui-icons';
import { plural } from '../../utils/format';
import { createWheelStepper } from '../wheel-steps';

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function buildChainLane(
  title: string,
  prefix: LaneId | 'motion',
  bus: ParamBus,
  lane: ChainLane,
  setChain: (steps: number[], enabled: boolean, transpose?: number[], origin?: number[]) => void,
  getPos: () => number,
  engine: StudioApi,
  bridge: UiBridge,
  opts: { mixer?: 'full' | 'mute' | 'none' } = {},
): HTMLElement {
  const root = el('div', styles.lane!);
  root.dataset.testid = `song-lane-${prefix}`;

  // Only the seq lane is pitched, so only it gets the transpose gestures at all
  // — an absent control, not a disabled one (arrangement.md REQ-a-seq-slot-carries-a-transpose: drums and the
  // sampler are unpitched, motion carries parameters).
  const pitched = prefix === 'seq';
  /**
   * Each slot's own index — the `origin` an edit rearranges alongside the steps,
   * so a playing lane stays on the bar it is on (arrangement.md
   * REQ-an-edit-keeps-the-lane-on-its-bar). `-1` marks a slot the edit adds.
   */
  const slotIds = (): number[] => lane.steps.map((_, i) => i);
  /** Write one slot's semitone offset, clamped, and re-render. */
  const setSlotTranspose = (idx: number, semis: number): void => {
    if (!pitched || idx < 0 || idx >= lane.steps.length) return;
    if (lane.steps[idx] === REST) return; // a rest plays nothing, so nothing to shift (arrangement-rest.md REQ-a-resting-lane-plays-nothing)
    const next = [...lane.transpose];
    next[idx] = clampTranspose(semis);
    if (next[idx] === lane.transpose[idx]) return;
    setChain([...lane.steps], lane.enabled, next, slotIds());
  };
  const nudgeSlot = (idx: number, delta: number): void =>
    setSlotTranspose(idx, (lane.transpose[idx] ?? 0) + delta);

  const head = el('div', styles.head!);

  // The title navigates to that machine's tab (machine-status.md REQ-lane-titles-navigate/REQ-the-navigation-link-is-visible-at-rest).
  // The launch glyph is aria-hidden — the aria-label already names the
  // destination, so it must not be announced twice.
  const titleBtn = document.createElement('button');
  titleBtn.type = 'button';
  titleBtn.className = styles.title!;
  titleBtn.dataset.testid = `song-lane-title-${prefix}`;
  titleBtn.setAttribute('aria-label', `Open the ${title} tab`);
  titleBtn.title = `Open the ${title} tab`;
  const arrow = el('span', styles.arrow!);
  arrow.innerHTML = UI_ICONS.launch;
  arrow.setAttribute('aria-hidden', 'true');
  titleBtn.append(el('span', '', title), arrow);
  titleBtn.addEventListener('click', () => { bridge.showTab(MACHINE_TAB[prefix]); });
  head.appendChild(titleBtn);

  // Shared with the machine headers' Chain button (machine-status.md REQ-lane-controls-live-on-both-surfaces), so
  // the two surfaces cannot drift. `.ctl` keeps this one compact for the lane
  // card; the machine headers take the default switch size beside their switches.
  const chainToggle = createChainToggle({
    getLane: () => lane,
    setChain,
    cuePlay: () => bridge.cuePlay(), // enabling is silent until Play (play-button-blink.md REQ-silent-actions-arm-a-green-cue)
    testId: `song-chain-${prefix}`,
    className: styles.ctl!,
  });
  head.appendChild(chainToggle.el);
  root.appendChild(head);

  // DJ mixer strip: mute / solo / volume, so the lane is operable from the Song
  // tab without switching machines. All controls bind straight to ParamBus, so
  // they stay in sync with the per-machine panels and persist with the song.
  // The non-audio motion lane gets 'mute' — a Mute switch only (nothing to mix).
  const mixer = opts.mixer ?? 'full';
  if (mixer !== 'none') {
    const mix = el('div', styles.mix!);
    mix.appendChild(new Switch(bus, `${prefix}.mute`, 'Mute').el);
    if (mixer === 'full') {
      mix.appendChild(new Switch(bus, `${prefix}.solo`, 'Solo').el);
      const vol = new Knob({ bus, paramId: `${prefix}.master`, label: 'Vol', size: 34 });
      vol.el.classList.add(styles.vol!);
      mix.appendChild(vol.el);
    }
    root.appendChild(mix);
  }

  const chips = el('div', styles.chips!);
  root.appendChild(chips);

  let sel = -1;

  const controls = el('div', styles.controls!);
  const addRow = el('div', styles.addRow!);
  /**
   * The palette offers exactly the banks this machine HAS (banks.md
   * REQ-a-machine-owns-its-bank-count), so it is rebuilt whenever that count
   * changes. There is no + arm here on purpose: growing a machine is an act on
   * the machine's own tab; the Song tab arranges what exists.
   */
  const renderAddRow = (): void => {
    addRow.replaceChildren();
    BANK_LABELS.slice(0, engine.patterns.bankCount(prefix)).forEach((label, i) => {
      const a = el('button', `${bankStyles.btn!} ${styles.add!}`, '') as HTMLButtonElement;
      a.dataset.testid = `chain-add-${prefix}-${i}`;
      a.title = `Add bank ${label}`;
      a.innerHTML = `<span class="${bankStyles.letter!}">${label}</span>`;
      a.addEventListener('click', () => { setChain([...lane.steps, i], lane.enabled, undefined, [...slotIds(), -1]); });
      addRow.appendChild(a);
    });
    // Rest: an always-empty bar. Appends the REST sentinel instead of a bank
    // index, so a lane can sit out a bar without spending a bank at all — still
    // the right tool for that even now banks are no longer scarce
    // (arrangement-rest.md REQ-rest-is-a-negative-sentinel). Always last.
    const rest = el('button', `${bankStyles.btn!} ${styles.add!} ${styles.addRest!}`, '') as HTMLButtonElement;
    rest.dataset.testid = `chain-add-rest-${prefix}`;
    rest.title = 'Add a rest (an empty bar)';
    rest.innerHTML = restIcon();
    rest.addEventListener('click', () => {
      setChain([...lane.steps, REST], lane.enabled, undefined, [...slotIds(), -1]);
    });
    addRow.appendChild(rest);
  };
  renderAddRow();
  engine.patterns.onBankCountChange(renderAddRow);
  controls.appendChild(addRow);

  const mk = (label: string, fn: () => void) => {
    const b = el('button', `${switchStyles.root!} ${styles.ctl!}`, label) as HTMLButtonElement;
    b.addEventListener('click', fn);
    return b;
  };
  /** As `mk`, for a button whose label is a drawn glyph (iconography.md). */
  const mkIcon = (glyph: string, fn: () => void) => {
    const b = mk('', fn);
    b.innerHTML = glyph;
    return b;
  };
  /** Swap the selected slot with its neighbour. The transpose swaps **with** it:
   *  the offset belongs to the slot, not to the position in the chain. */
  const moveSel = (to: number) => {
    if (sel < 0 || to < 0 || to >= lane.steps.length) return;
    const s = [...lane.steps];
    const t = [...lane.transpose];
    const o = slotIds();
    [s[to], s[sel]] = [s[sel]!, s[to]!];
    [t[to], t[sel]] = [t[sel]!, t[to]!];
    [o[to], o[sel]] = [o[sel]!, o[to]!];
    sel = to;
    setChain(s, lane.enabled, t, o);
  };
  /**
   * Move a slot to an arbitrary position — the drag's commit (arrangement.md
   * REQ-a-chip-is-dragged-to-its-place). A splice rather than `moveSel`'s swap, so a chip can travel the
   * length of the chain in one gesture; over a single position the two agree
   * exactly, which is what keeps the drag and the buttons one behaviour.
   */
  const reorderSlot = (fromIdx: number, to: number): void => {
    if (fromIdx < 0 || fromIdx >= lane.steps.length) return;
    if (to < 0 || to >= lane.steps.length || to === fromIdx) return;
    const s = [...lane.steps];
    const t = [...lane.transpose];
    const o = slotIds();
    // The inner splice removes; `to` is already in post-removal coordinates.
    s.splice(to, 0, ...s.splice(fromIdx, 1));
    t.splice(to, 0, ...t.splice(fromIdx, 1));
    o.splice(to, 0, ...o.splice(fromIdx, 1));
    sel = to; // the chip you dropped is the one − / + / ✕ now act on
    setChain(s, lane.enabled, t, o);
  };

  /**
   * Name a toolbar button three ways at once — testid, tooltip, screen reader.
   * `◀ ▶ ✕` had none of the three while `− + Clear` beside them had all of
   * them; arrangement.md REQ-a-chip-is-dragged-to-its-place makes the move buttons the precise path a drag falls back to,
   * so they owe the same tooltip everything else in the row has
   * (recipes/design-an-interaction.md step 4).
   */
  const labelled = (b: HTMLButtonElement, testId: string, text: string): HTMLButtonElement => {
    b.dataset.testid = testId;
    b.title = text;
    b.setAttribute('aria-label', text);
    return b;
  };
  controls.appendChild(labelled(
    mkIcon(UI_ICONS.triangleLeft, () => { moveSel(sel - 1); }),
    `chain-move-left-${prefix}`, 'Move the selected bar one place earlier'));
  controls.appendChild(labelled(
    mkIcon(UI_ICONS.triangleRight, () => { moveSel(sel + 1); }),
    `chain-move-right-${prefix}`, 'Move the selected bar one place later'));
  controls.appendChild(labelled(mkIcon(UI_ICONS.close, () => {
    if (sel >= 0) {
      const s = [...lane.steps];
      const t = [...lane.transpose];
      const o = slotIds();
      s.splice(sel, 1);
      t.splice(sel, 1);   // the offset belongs to the slot, so it goes with it
      o.splice(sel, 1);
      sel = -1;
      setChain(s, lane.enabled, t, o);
    }
  }), `chain-remove-${prefix}`, 'Remove the selected bar from the chain'));
  // Transpose the selected slot. Wheel is the fast path on a desktop, but this
  // app installs as a mobile PWA, so the gesture needs a touch-reachable twin
  // (arrangement.md gesture inventory).
  if (pitched) {
    controls.append(
      labelled(mkIcon(UI_ICONS.minus, () => { if (sel >= 0) nudgeSlot(sel, -1); }),
        'chain-transpose-down-seq', 'Transpose the selected bar down a semitone'),
      labelled(mkIcon(UI_ICONS.plus, () => { if (sel >= 0) nudgeSlot(sel, 1); }),
        'chain-transpose-up-seq', 'Transpose the selected bar up a semitone'),
    );
  }
  const clearBtn = mk('Clear', async () => {
    // Nothing to lose if the chain is already a single step — reset silently.
    if (lane.steps.length > 1) {
      const ok = await confirmDialog({
        title: 'Clear chain',
        message: `Clear the ${title} arrangement chain? It resets to a single bank.`,
        confirmLabel: 'Clear',
        danger: true,
      });
      if (!ok) return;
    }
    sel = -1;
    setChain([0], lane.enabled, [0]); // a reset, so the transpose goes too (arrangement REQ-a-seq-slot-carries-a-transpose)
  });
  clearBtn.dataset.testid = `chain-clear-${prefix}`;
  controls.appendChild(clearBtn);
  root.appendChild(controls);

  // Split rendering: the chip DOM is rebuilt only when the step list actually
  // changes; the playhead/selection classes update in place every tick. This
  // avoids tearing down and re-creating buttons (and re-attaching listeners)
  // on every bar advance during playback.
  let chipEls: HTMLButtonElement[] = [];
  /**
   * The chips' wheel, by scroll distance rather than per event (wheel-steps.md
   * REQ-a-wheel-gesture-steps-by-distance) — a touchpad swipe used to send a bar's transpose straight to
   * the clamp. One per LANE, outside `renderStructure`: each step rewrites a chip's
   * label and so rebuilds the chips, and a stepper rebuilt with them would start
   * a fresh gesture on every event, which is the bug over again.
   */
  const chipWheelStep = createWheelStepper();
  let lastKey = '';
  /** Disposer for the drag controller bound to the CURRENT chip DOM. */
  let detachReorder: (() => void) | null = null;

  const renderPlayState = () => {
    chainToggle.refresh();
    if (sel >= lane.steps.length) sel = -1;
    const pos = getPos();
    chipEls.forEach((c, idx) => {
      c.classList.toggle('sel', idx === sel);
      c.classList.toggle('playing', lane.enabled && idx === pos);
    });
  };

  const renderStructure = () => {
    // The controller holds the old buttons; drop it before they do.
    detachReorder?.();
    detachReorder = null;
    chips.innerHTML = '';
    chipEls = lane.steps.map((b, idx) => {
      const isRest = b === REST;
      const c = el('button', isRest ? `${styles.chip!} ${styles.rest!}` : styles.chip!) as HTMLButtonElement;
      c.dataset.testid = `chain-chip-${prefix}-${idx}`;
      // Every chip says how to move it: the drag has no other affordance, and
      // a gesture with none of the discoverability triple does not exist for
      // the user (recipes/design-an-interaction.md step 4).
      const DRAG_HINT = ' — drag to reorder';
      if (isRest) {
        c.dataset.rest = 'true';
        c.title = 'Rest (empty bar)' + DRAG_HINT;
        c.innerHTML = restIcon();
      } else {
        // The offset is ON the chip, never hidden behind a selection — a slot
        // that plays a different pitch has to look different (ADR-014).
        const semis = lane.transpose[idx] ?? 0;
        const label = BANK_LABELS[b] ?? '?';
        c.textContent = semis === 0 ? label : `${label}${semis > 0 ? '+' : ''}${semis}`;
        c.title = semis === 0
          ? `Bank ${label}${DRAG_HINT}`
          : `Bank ${label}, ${semis > 0 ? 'up' : 'down'} ${plural(Math.abs(semis), 'semitone')}${DRAG_HINT}`;
        if (semis !== 0) c.dataset.transposed = 'true';
      }
      c.addEventListener('click', () => { sel = idx === sel ? -1 : idx; renderPlayState(); });
      if (pitched && !isRest) {
        // Wheel = ±1 semitone. `passive: false` because the gesture is the
        // transpose, not a scroll — without preventDefault the Song panel
        // scrolls out from under the chip you are editing.
        c.addEventListener('wheel', (e) => {
          e.preventDefault();
          const dir = chipWheelStep(e);
          if (dir !== 0) nudgeSlot(idx, dir);
        }, { passive: false });
        // Double-click resets to +0, matching the knob double-tap idiom.
        c.addEventListener('dblclick', () => { setSlotTranspose(idx, 0); });
      }
      chips.appendChild(c);
      return c;
    });
    // Re-bound to the fresh buttons on every structural rebuild — including the
    // one a drop itself triggers, which is why the controller never touches the
    // DOM order and only reports the move (arrangement.md REQ-a-chip-is-dragged-to-its-place).
    detachReorder = attachChipReorder({ container: chips, chips: chipEls, onReorder: reorderSlot });
  };

  const render = () => {
    // The transpose is part of a chip's *label*, so it belongs in the key that
    // decides whether the DOM is rebuilt — otherwise nudging a slot changes the
    // lane but not what you see (renderPlayState only touches classes).
    const key = pitched
      ? lane.steps.join(',') + '|' + lane.transpose.join(',')
      : lane.steps.join(',');
    if (key !== lastKey) { lastKey = key; renderStructure(); }
    renderPlayState();
  };

  engine.arrangement.onChange(render);
  render();
  return root;
}

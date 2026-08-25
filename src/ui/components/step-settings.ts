import switchStyles from '../styles/switch.module.css';
import styles from '../styles/step-settings.module.css';
import type { StepSettings, TriggerCell } from '../../state/patterns';
import { MICRO_MAX, MICRO_UNITS } from '../../state/limits';
import { createButton } from './button';
import type { StepButton } from './step-button';

/**
 * Per-step settings edit row shared by the sequencer, drum and sampler
 * panels: velocity / gate / prob / micro sliders, the ratchet 1–4 group and the
 * tie LED button. The panel owns the selection cursor and hands in get/set for
 * the selected step; extra controls (the seq's note picker) can be prepended
 * into `el`. Testids: `<prefix>-vel/-gate/-prob/-micro/-ratchet(-<n>)/-tie`.
 */
export interface StepSettingsEditorOpts {
  testidPrefix: string; // 'seq' | 'drum' | 'sampler'
  get: () => StepSettings | undefined;
  set: (patch: Partial<StepSettings>) => void;
  gateMin?: number; // default 0.05
}

export class StepSettingsEditor {
  readonly el: HTMLElement;
  private readonly refreshers: Array<() => void> = [];

  constructor(opts: StepSettingsEditorOpts) {
    const { testidPrefix: prefix, get, set, gateMin = 0.05 } = opts;
    this.el = document.createElement('div');
    this.el.className = styles.edit!;

    const velSlider = makeSlider('Velocity', 0, 1, () => get()?.velocity ?? 0.8,
      (v) => set({ velocity: v }));
    velSlider.el.dataset.testid = `${prefix}-vel`;
    this.el.appendChild(velSlider.el);

    const gateSlider = makeSlider('Gate', gateMin, 1, () => get()?.gate ?? 1,
      (v) => set({ gate: v }));
    gateSlider.el.dataset.testid = `${prefix}-gate`;
    this.el.appendChild(gateSlider.el);

    const probSlider = makeSlider('Prob', 0, 1, () => get()?.prob ?? 1,
      (v) => set({ prob: v }));
    probSlider.el.dataset.testid = `${prefix}-prob`;
    this.el.appendChild(probSlider.el);

    // Micro — nudge this one step off the grid, in 1/24 of its own cell
    // (step-settings.md REQ-6). Bipolar, so it is centre-detented and snapped to
    // the integer notch ladder rather than sweeping continuously like the three
    // above; arrow keys give the single-notch precision a 25-position track
    // cannot (see the spec's gesture inventory).
    const microSlider = makeSlider('Micro', -MICRO_MAX, MICRO_MAX, () => get()?.micro ?? 0,
      (v) => set({ micro: v }), {
        center: true,
        stepper: true,
        snap: 1,
        keyStep: 1,
        resetTo: 0,
        format: microLabel,
        testid: `${prefix}-micro`,
        title: 'Micro-timing — drag, −/+ or the arrow keys to nudge this step early/late;'
          + ' double-click to reset',
      });
    this.el.appendChild(microSlider.el);

    // Ratchet — 1..4 sub-hits within the step.
    const ratchetCtrl = document.createElement('div');
    ratchetCtrl.className = styles.ctrl!;
    ratchetCtrl.dataset.testid = `${prefix}-ratchet`;
    const ratchetLabel = document.createElement('div');
    ratchetLabel.className = styles.ctrlLabel!;
    ratchetLabel.textContent = 'Ratchet';
    ratchetCtrl.appendChild(ratchetLabel);
    const ratchetBtns: HTMLButtonElement[] = [];
    for (let n = 1; n <= 4; n++) {
      const b = document.createElement('button');
      b.className = switchStyles.root!;
      b.textContent = String(n);
      b.dataset.testid = `${prefix}-ratchet-${n}`;
      b.title = `${n} hit${n > 1 ? 's' : ''} per step`;
      b.addEventListener('click', () => set({ ratchet: n }));
      ratchetBtns.push(b);
      ratchetCtrl.appendChild(b);
    }
    const refreshRatchet = () => {
      const r = Math.max(1, Math.round(get()?.ratchet ?? 1));
      ratchetBtns.forEach((b, i) => b.classList.toggle('on', i + 1 === r));
    };
    this.el.appendChild(ratchetCtrl);

    // Tie — hold this step into the next (seq: legato/slide; one-shots: skip the choke).
    const tieBtn = createButton({
      label: 'Tie',
      led: true,
      testId: `${prefix}-tie`,
      onClick: () => set({ tie: !get()?.tie }),
    });
    tieBtn.title = 'Tie — hold into the next step';
    const refreshTie = () => tieBtn.classList.toggle('on', !!get()?.tie);
    this.el.appendChild(tieBtn);

    this.refreshers.push(velSlider.refresh, gateSlider.refresh, probSlider.refresh,
      microSlider.refresh, refreshRatchet, refreshTie);
    this.refresh();
  }

  /** Repaint every control from the current selected step. */
  refresh(): void {
    for (const fn of this.refreshers) fn();
  }
}

/** The Micro readout: `0`, `+3/24`, `-12/24` — notches over the ladder they sit
 *  on, the fraction-of-a-step idiom Elektron's display uses. */
function microLabel(v: number): string {
  return v === 0 ? '0' : `${v > 0 ? '+' : ''}${v}/${MICRO_UNITS}`;
}

/** Tooltip fragment for a step: `vel 80% · gate 50% · prob 100% · ×3 · tie`. */
export function stepTitle(s: StepSettings): string {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return `vel ${pct(s.velocity)} · gate ${pct(s.gate)} · prob ${pct(s.prob)}`
    + (s.ratchet > 1 ? ` · ×${s.ratchet}` : '')
    + (s.tie ? ' · tie' : '')
    + (s.micro ? ` · micro ${microLabel(s.micro)}` : '');
}

/**
 * Repaint a one-shot trigger cell (drum track / sampler slot): lit state, the
 * per-step settings viz and the tooltip. The seq panel keeps its own painter —
 * it additionally writes the note name as the button label.
 */
export function paintTriggerCell(sb: StepButton, cell: TriggerCell): void {
  sb.setOn(cell.on);
  sb.setViz(cell);
  sb.el.title = stepTitle(cell);
}

/**
 * Options for the bipolar/stepped variant. Every one is absent for the three
 * unipolar sliders, which keep their exact pre-v3 behaviour.
 */
interface SliderOpts {
  /** Fill grows from the centre rather than the left edge (a bipolar value). */
  center?: boolean;
  /** Flank the track with −/+ buttons, one `keyStep` each. Requires `keyStep`. */
  stepper?: boolean;
  /** Quantise the dragged value to this increment (1 = integer notches). */
  snap?: number;
  /** Make the track focusable and let the arrow keys move by this much. */
  keyStep?: number;
  /** Value a double-click returns to. */
  resetTo?: number;
  /** Readout text; defaults to the normalized percentage. */
  format?: (v: number) => string;
  /** Tooltip on the track — states the gesture, not the noun (ADR-014 law 1). */
  title?: string;
  /** Mints the root testid plus `-track` / `-dec` / `-inc` / `-value` on the
   *  parts, at the factory rather than per caller (design-an-interaction step 3).
   *  Without it the parts are only reachable positionally, which breaks the
   *  moment the row grows a button. */
  testid?: string;
}

function makeSlider(
  label: string,
  min: number,
  max: number,
  get: () => number,
  set: (v: number) => void,
  opts: SliderOpts = {},
): { el: HTMLElement; refresh(): void } {
  const root = document.createElement('div');
  root.className = styles.slider!;
  if (opts.testid) root.dataset.testid = opts.testid;
  const l = document.createElement('div');
  l.className = styles.sliderLabel!;
  l.textContent = label;
  root.appendChild(l);

  const track = document.createElement('div');
  track.className = styles.sliderTrack! + (opts.center ? ` ${styles.sliderTrackCenter!}` : '');
  if (opts.title) track.title = opts.title;
  if (opts.testid) track.dataset.testid = `${opts.testid}-track`;
  const fill = document.createElement('div');
  fill.className = styles.sliderFill!;
  track.appendChild(fill);

  const valLabel = document.createElement('div');
  valLabel.className = styles.sliderValue!;

  const refresh = () => {
    const v = get();
    const n = (v - min) / (max - min);
    // scaleX, not width — see the .sliderFill comment (compositor, not layout).
    // A centre slider spans between the midpoint and the value, so it also needs
    // an offset: translate to the nearer end, then scale by the distance. Both
    // are still one composited transform.
    if (opts.center) {
      const from = Math.min(0.5, n);
      fill.style.transform = `translateX(${from * 100}%) scaleX(${Math.abs(n - 0.5)})`;
    } else {
      fill.style.transform = `scaleX(${n})`;
    }
    valLabel.textContent = opts.format ? opts.format(v) : `${Math.round(n * 100)}%`;
  };

  /** Snap, clamp, and write only on an actual change — a snapped drag reports the
   *  same notch for most of its moves, and each write is a PatternStore mutation
   *  with an undo entry behind it (pattern-undo.md). */
  const write = (v: number) => {
    const snapped = opts.snap ? Math.round(v / opts.snap) * opts.snap : v;
    const clamped = Math.max(min, Math.min(max, snapped));
    if (opts.snap && clamped === get()) return;
    set(clamped);
    refresh();
  };

  // − and + BRACKET the track rather than sitting at either end of the row: they
  // belong to the thing they move, and the readout still terminates the control
  // the way the unipolar sliders' percentage does.
  const stepBtn = (glyph: string, dir: number, tid: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = `${switchStyles.root!} ${styles.stepBtn!}`;
    b.textContent = glyph;
    b.title = `${dir > 0 ? 'Later' : 'Earlier'} by one notch`;
    if (opts.testid) b.dataset.testid = `${opts.testid}-${tid}`;
    b.addEventListener('click', () => write(get() + dir * (opts.keyStep ?? 1)));
    return b;
  };

  if (opts.stepper) root.appendChild(stepBtn('−', -1, 'dec'));
  root.appendChild(track);
  if (opts.stepper) root.appendChild(stepBtn('+', 1, 'inc'));
  root.appendChild(valLabel);
  if (opts.testid) valLabel.dataset.testid = `${opts.testid}-value`;

  // Drag listeners live on `window` only for the duration of a stroke, attached
  // on pointerdown and removed on up/cancel — the same discipline as Knob and
  // Strip (specs/recipes/add-a-ui-component.md, runtime-performance.md REQ-3).
  // Held from the constructor instead, three sliders x three editors put nine
  // pointermove handlers on every mouse move anywhere on the page.
  // The track box is measured once per stroke: reading it per move is a forced
  // layout, and the slider cannot move mid-drag.
  let bounds: { left: number; width: number } | null = null;

  const handle = (clientX: number) => {
    if (!bounds || bounds.width === 0) return;
    const n = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
    write(min + n * (max - min));
  };

  const onMove = (e: PointerEvent): void => handle(e.clientX);
  const onUp = (): void => {
    bounds = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };

  track.addEventListener('pointerdown', (e) => {
    if (bounds) return; // one stroke at a time
    const rect = track.getBoundingClientRect();
    bounds = { left: rect.left, width: rect.width };
    (e.target as Element).setPointerCapture?.(e.pointerId);
    handle(e.clientX);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });

  const keyStep = opts.keyStep;
  if (keyStep !== undefined) {
    track.tabIndex = 0;
    track.addEventListener('keydown', (e) => {
      const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (dir === 0) return;
      write(get() + dir * keyStep);
      e.preventDefault();
      // shortcuts.ts binds its global keys on `window` in the BUBBLE phase and
      // only skips text inputs, so an unstopped bare arrow would ALSO shift the
      // playable keyboard's octave — one gesture, two outcomes (ADR-014 law 2).
      // Stopping here keeps the fix local: shortcuts.ts stays untouched.
      e.stopPropagation();
    });
  }

  if (opts.resetTo !== undefined) {
    const resetTo = opts.resetTo;
    track.addEventListener('dblclick', (e) => {
      write(resetTo);
      e.preventDefault();
    });
  }

  return { el: root, refresh };
}

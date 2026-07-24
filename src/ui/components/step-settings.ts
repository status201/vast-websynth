import switchStyles from '../styles/switch.module.css';
import styles from '../styles/step-settings.module.css';
import type { StepSettings, TriggerCell } from '../../state/patterns';
import { createButton } from './button';
import type { StepButton } from './step-button';

/**
 * Per-step settings edit row shared by the sequencer, drum and sampler
 * panels: velocity / gate / prob sliders, the ratchet 1–4 group and the tie
 * LED button. The panel owns the selection cursor and hands in get/set for
 * the selected step; extra controls (the seq's note picker) can be prepended
 * into `el`. Testids: `<prefix>-vel/-gate/-prob/-ratchet(-<n>)/-tie`.
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

    this.refreshers.push(velSlider.refresh, gateSlider.refresh, probSlider.refresh, refreshRatchet, refreshTie);
    this.refresh();
  }

  /** Repaint every control from the current selected step. */
  refresh(): void {
    for (const fn of this.refreshers) fn();
  }
}

/** Tooltip fragment for a step: `vel 80% · gate 50% · prob 100% · ×3 · tie`. */
export function stepTitle(s: StepSettings): string {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return `vel ${pct(s.velocity)} · gate ${pct(s.gate)} · prob ${pct(s.prob)}`
    + (s.ratchet > 1 ? ` · ×${s.ratchet}` : '')
    + (s.tie ? ' · tie' : '');
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

function makeSlider(label: string, min: number, max: number, get: () => number, set: (v: number) => void): { el: HTMLElement; refresh(): void } {
  const root = document.createElement('div');
  root.className = styles.slider!;
  const l = document.createElement('div');
  l.className = styles.sliderLabel!;
  l.textContent = label;
  root.appendChild(l);

  const track = document.createElement('div');
  track.className = styles.sliderTrack!;
  const fill = document.createElement('div');
  fill.className = styles.sliderFill!;
  track.appendChild(fill);
  root.appendChild(track);

  const valLabel = document.createElement('div');
  valLabel.className = styles.sliderValue!;
  root.appendChild(valLabel);

  const refresh = () => {
    const v = get();
    const n = (v - min) / (max - min);
    // scaleX, not width — see the .sliderFill comment (compositor, not layout).
    fill.style.transform = `scaleX(${n})`;
    valLabel.textContent = `${Math.round(n * 100)}%`;
  };

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
    set(min + n * (max - min));
    refresh();
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

  return { el: root, refresh };
}

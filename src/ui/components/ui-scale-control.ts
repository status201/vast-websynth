// The Settings dialog's UI size row (ui-scale.md REQ-the-slider-commits-on-release):
// a native range over the stops, a live readout, and Reset. The scale is applied
// and stored on `change` — release, or one arrow-key step — never on `input`, so
// the page does not rescale under the finger mid-drag.
import { createButton } from './button';
import { UI_SCALE_STOPS, UI_SCALE_DEFAULT, writeUiScale } from '../../state/ui-scale';
import { applyUiScale, currentUiScale } from '../ui-scale';
import styles from '../styles/perf-settings.module.css';

export interface UiScaleControl {
  el: HTMLElement;
  destroy(): void;
}

const pctAt = (index: number): number => UI_SCALE_STOPS[index] ?? UI_SCALE_DEFAULT;
const stopIndex = (pct: number): number => Math.max(0, UI_SCALE_STOPS.indexOf(pct));

export function createUiScaleControl(): UiScaleControl {
  const el = document.createElement('div');

  const desc = document.createElement('div');
  desc.className = styles.desc!;
  desc.textContent =
    'Scales the whole interface, like your browser’s zoom. Saved on this device only.';

  const row = document.createElement('div');
  row.className = styles.modeRow!;
  const label = document.createElement('label');
  label.className = styles.modeLabel!;
  label.textContent = 'Size';
  label.htmlFor = 'ui-scale-slider';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.id = 'ui-scale-slider';
  slider.className = styles.scaleSlider!;
  slider.min = '0';
  slider.max = String(UI_SCALE_STOPS.length - 1);
  slider.step = '1';
  slider.dataset.testid = 'ui-scale-slider';

  const readout = document.createElement('span');
  readout.className = styles.scaleValue!;
  readout.dataset.testid = 'ui-scale-value';

  const reset = createButton({
    label: 'Reset',
    testId: 'ui-scale-reset',
    onClick: () => commit(UI_SCALE_DEFAULT),
  });
  reset.classList.add(styles.scaleReset!);

  row.append(label, slider, readout, reset);
  el.append(desc, row);

  function show(pct: number): void {
    readout.textContent = `${pct}%`;
    slider.setAttribute('aria-valuetext', `${pct}%`);
  }

  function render(): void {
    const pct = currentUiScale();
    slider.value = String(stopIndex(pct));
    show(pct);
    reset.disabled = pct === UI_SCALE_DEFAULT;
  }

  function commit(pct: number): void {
    writeUiScale(pct);
    applyUiScale(pct);
    render();
  }

  const onInput = (): void => show(pctAt(Number(slider.value)));
  const onChange = (): void => commit(pctAt(Number(slider.value)));
  slider.addEventListener('input', onInput);
  slider.addEventListener('change', onChange);

  render();
  return {
    el,
    destroy(): void {
      slider.removeEventListener('input', onInput);
      slider.removeEventListener('change', onChange);
    },
  };
}

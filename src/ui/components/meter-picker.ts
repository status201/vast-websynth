import type { ParamBus } from '../../state/params';
import { Dropdown } from './dropdown';
import { METER_PRESETS, meterLabel } from '../../state/meter';
import dropdownStyles from '../styles/dropdown.module.css';
import styles from '../styles/meter-picker.module.css';

/**
 * The time-signature control (meter.md REQ-5).
 *
 * One dropdown over two params. `transport.beats` and `transport.beatUnit` are
 * what the audio layer actually reads, but nobody thinks in "7 beats of an
 * eighth" — they think "7/8" — so the picker is the single place the two are
 * chosen together, and the raw pair is left to songs and the MCP authoring path.
 *
 * A combination outside {@link METER_PRESETS} (a song, a share link, an agent)
 * is **not** snapped to the nearest preset: it is appended to the list and shown
 * as itself. Showing "4/4" while the transport plays 11/8 would be the one
 * failure a picker must not have.
 */
export class MeterPicker {
  readonly el: HTMLElement;
  private readonly dd: Dropdown;
  private readonly unsubs: Array<() => void> = [];
  /** Suppresses the write-back while the subscription is painting the picker. */
  private painting = false;

  constructor(private readonly bus: ParamBus) {
    this.el = document.createElement('div');
    this.el.className = styles.root!;

    // No label for the meter, it's obvious what it is, and the label makes vertical alignment ugly.
/*
    const label = document.createElement('div');
    label.className = styles.label!;
    label.textContent = 'METER';
    this.el.appendChild(label);
*/

    this.dd = new Dropdown(METER_PRESETS.map((m) => m.label));
    this.dd.el.classList.add(dropdownStyles.compact!);
    this.dd.el.dataset.testid = 'meter-picker';
    this.dd.el.title = 'Time signature — the bar every machine follows';
    this.el.appendChild(this.dd.el);

    this.dd.onChange((v) => {
      if (this.painting) return;
      const preset = METER_PRESETS.find((m) => m.label === v);
      if (!preset) return;
      // Both, always: a bar length is the pair, and writing one at a time would
      // put the transport through a meter nobody asked for (5/4 on the way to
      // 5/8) — briefly, but the arrangement re-bases on every change.
      this.bus.set('transport.beats', preset.beats);
      this.bus.set('transport.beatUnit', preset.unit);
    });

    const paint = (): void => this.paint();
    this.unsubs.push(bus.subscribe('transport.beats', paint));
    this.unsubs.push(bus.subscribe('transport.beatUnit', paint));
  }

  private paint(): void {
    const label = meterLabel(this.bus.get('transport.beats'), this.bus.get('transport.beatUnit'));
    const known = METER_PRESETS.some((m) => m.label === label);
    // A custom meter joins the list rather than being rounded away. Rebuilt only
    // when it is genuinely off-list, so the common case touches no DOM.
    if (!known) {
      this.dd.setOptions(
        [...METER_PRESETS.map((m) => m.label), label],
        { dividerAfter: METER_PRESETS.length },
      );
    }
    this.painting = true;
    this.dd.setValue(label);
    this.painting = false;
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    this.dd.destroy();
  }
}

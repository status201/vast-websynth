// "Performance" button + modal: a device-scoped audio-quality preference
// (Auto / On / Off), persisted outside the ParamBus (see state/perf-mode.ts).
// On weak hardware Performance mode enlarges the audio buffer, lowers polyphony
// and lightens the visualiser, trading a little latency/voices/glitz for stable
// audio. Buffer + voice count are fixed at AudioContext build, so a change only
// takes full effect after a reload — the modal surfaces that when needed.
//
// The segmented control is the *preference* (what should decide); the status
// line states what that resolves to *on this device* — so "Auto" (set to
// auto-detect) is never confused with whether performance mode is engaged.
import { Modal } from './modal';
import { createButton } from './button';
import { readPerfPref, writePerfPref, resolvePerfActive, type PerfPref } from '../../state/perf-mode';
import segStyles from '../styles/segmented.module.css';
import switchStyles from '../styles/switch.module.css';
import styles from '../styles/perf-settings.module.css';

const OPTIONS: Array<{ value: PerfPref; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

export function createPerfSettingsButton(): HTMLButtonElement {
  const btn = createButton({ label: 'Perf', testId: 'perf-settings', onClick: open });

  // What the running engine was actually built with (buffer/voices are fixed at
  // AudioContext build). Captured once: the stored pref hasn't changed since
  // boot, so this equals the engine's live state. A later choice that resolves
  // differently is "pending" until a reload.
  const bootActive = resolvePerfActive();

  // Reflect the current preference's engaged state on the header button (like
  // the Help button's active state): orange when engaged (forced on OR
  // auto-detected on), green when forced off, neutral when auto + not engaged.
  // Also pulse it while the choice is pending a reload (not yet live).
  function syncButton(pref: PerfPref = readPerfPref()): void {
    const engaged = resolvePerfActive(pref);
    const state = engaged ? 'engaged' : pref === 'off' ? 'forced-off' : 'auto-idle';
    const pending = engaged !== bootActive;
    btn.dataset.perfState = state;
    btn.dataset.perfPending = pending ? '1' : '0';
    btn.classList.toggle(styles.engaged!, state === 'engaged');
    btn.classList.toggle(styles.forcedOff!, state === 'forced-off');
    btn.classList.toggle(styles.pending!, pending);
  }
  syncButton(); // initial state at boot

  function open(): void {
    let pref = readPerfPref();

    const modal = new Modal({ title: 'Performance' });

    const desc = document.createElement('div');
    desc.className = styles.desc!;
    desc.textContent =
      'Reduces audio crackle on slower devices by enlarging the audio buffer, ' +
      'lowering polyphony, and lightening the visualiser.';

    const modeRow = document.createElement('div');
    modeRow.className = styles.modeRow!;
    const modeLabel = document.createElement('span');
    modeLabel.className = styles.modeLabel!;
    modeLabel.textContent = 'Mode';

    const seg = document.createElement('div');
    seg.className = segStyles.root!;
    seg.dataset.testid = 'perf-mode';

    const buttons: HTMLButtonElement[] = OPTIONS.map((opt) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = opt.label;
      b.dataset.testid = `perf-mode-${opt.value}`;
      b.addEventListener('click', () => {
        pref = opt.value;
        writePerfPref(pref);
        render();
      });
      seg.appendChild(b);
      return b;
    });
    modeRow.appendChild(modeLabel);
    modeRow.appendChild(seg);

    const help = document.createElement('div');
    help.className = styles.help!;
    help.textContent = 'Auto turns it on automatically on slower hardware; On / Off override that.';

    const status = document.createElement('div');
    status.dataset.testid = 'perf-status';

    const reloadHint = document.createElement('div');
    reloadHint.className = `${styles.reloadHint!} hidden`;
    reloadHint.dataset.testid = 'perf-reload-hint';
    reloadHint.textContent = 'Not applied yet — buffer & polyphony changes take effect after a reload.';

    const reloadBtn = createButton({
      label: 'Reload now',
      testId: 'perf-reload',
      onClick: () => location.reload(),
    });
    reloadBtn.classList.add(styles.reloadBtn!, 'hidden');

    const closeBtn = createButton({
      label: 'Close',
      className: `${switchStyles.root!} ${Modal.closeBtnClass}`,
      onClick: () => modal.close(),
    });

    function render(): void {
      buttons.forEach((b, i) => b.classList.toggle('active', OPTIONS[i]!.value === pref));

      // Status: what the *selected* preference resolves to on this device.
      const active = resolvePerfActive(pref);
      let msg: string;
      if (pref === 'auto') {
        msg = active
          ? 'Performance mode is <strong>on</strong> here — slower hardware detected.'
          : 'Performance mode is <strong>off</strong> here — this device looks capable.';
      } else {
        msg = active
          ? 'Performance mode is <strong>forced on</strong>.'
          : 'Performance mode is <strong>forced off</strong>.';
      }
      status.className = `${styles.status!} ${active ? styles.statusOn! : styles.statusOff!}`;
      status.innerHTML = msg;

      // Keep the header button's engaged colour in sync as the pref changes.
      syncButton(pref);

      // Reload only matters when the selection changes what the engine is running.
      const needsReload = active !== bootActive;
      reloadHint.classList.toggle('hidden', !needsReload);
      reloadBtn.classList.toggle('hidden', !needsReload);
    }

    modal.body.appendChild(desc);
    modal.body.appendChild(modeRow);
    modal.body.appendChild(help);
    modal.body.appendChild(status);
    modal.body.appendChild(reloadHint);
    modal.body.appendChild(reloadBtn);
    modal.body.appendChild(closeBtn);
    render();
    modal.open();
  }

  return btn;
}

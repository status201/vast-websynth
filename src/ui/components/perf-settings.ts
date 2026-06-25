// "Performance" button + modal: a device-scoped audio-quality preference
// (Auto / On / Off), persisted outside the ParamBus (see state/perf-mode.ts).
// On weak hardware Performance mode enlarges the audio buffer, lowers polyphony
// and lightens the visualiser, trading a little latency/voices/glitz for stable
// audio. Buffer + voice count are fixed at AudioContext build, so a change only
// takes full effect after a reload — the modal surfaces that when needed.
import { Modal } from './modal';
import { createButton } from './button';
import { readPerfPref, writePerfPref, resolvePerfActive, type PerfPref } from '../../state/perf-mode';
import segStyles from '../styles/segmented.module.css';
import switchStyles from '../styles/switch.module.css';

const OPTIONS: Array<{ value: PerfPref; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

export function createPerfSettingsButton(): HTMLButtonElement {
  const btn = createButton({ label: 'Perf', testId: 'perf-settings', onClick: open });

  function open(): void {
    // What the running engine was actually built with — used to decide whether
    // the user's new choice needs a reload to take hold.
    const bootActive = resolvePerfActive();
    let pref = readPerfPref();

    const modal = new Modal({ title: 'Performance' });

    const desc = document.createElement('div');
    desc.className = Modal.tagClass;
    desc.textContent =
      'Reduces audio crackle on slower devices by enlarging the audio buffer, ' +
      'lowering polyphony, and lightening the visualiser. Auto detects weak hardware.';

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

    const reloadHint = document.createElement('div');
    reloadHint.className = `${Modal.tagClass} hidden`;
    reloadHint.dataset.testid = 'perf-reload-hint';
    reloadHint.textContent = 'Buffer & polyphony changes apply after reload.';

    const reloadBtn = createButton({
      label: 'Reload now',
      testId: 'perf-reload',
      onClick: () => location.reload(),
    });
    reloadBtn.classList.add('hidden');

    const closeBtn = createButton({
      label: 'Close',
      className: `${switchStyles.root!} ${Modal.closeBtnClass}`,
      onClick: () => modal.close(),
    });

    function render(): void {
      buttons.forEach((b, i) => b.classList.toggle('active', OPTIONS[i]!.value === pref));
      const needsReload = resolvePerfActive(pref) !== bootActive;
      reloadHint.classList.toggle('hidden', !needsReload);
      reloadBtn.classList.toggle('hidden', !needsReload);
    }

    modal.body.appendChild(desc);
    modal.body.appendChild(seg);
    modal.body.appendChild(reloadHint);
    modal.body.appendChild(reloadBtn);
    modal.body.appendChild(closeBtn);
    render();
    modal.open();
  }

  return btn;
}

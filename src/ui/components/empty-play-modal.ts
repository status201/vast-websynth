import { Modal } from './modal';
import { createButton } from './button';
import switchStyles from '../styles/switch.module.css';
import dialogStyles from '../styles/dialog.module.css';
import styles from '../styles/empty-play-modal.module.css';

/**
 * The "nothing to play yet" hint (empty-play-hint.md): shown instead of
 * starting a transport nobody could hear. Explains why Play would be silent,
 * what to do about it, and offers to start a demo. The "Don't show this
 * again" opt-out persists across sessions.
 */

/** localStorage flag: '1' = the user opted out of the hint. Device-scoped
 * (like websynth.perf) — never part of songs/presets (REQ-5). */
export const EMPTY_PLAY_HINT_KEY = 'websynth.hint.emptyplay';

export function emptyPlayHintDismissed(): boolean {
  try {
    return localStorage.getItem(EMPTY_PLAY_HINT_KEY) === '1';
  } catch {
    return false;
  }
}

export interface EmptyPlayModalOptions {
  /** Load a demo and start the transport; called after the modal closes.
   *  May be async — most demos are fetched on click (song-mode.md REQ-12). */
  onPlayDemo: () => void | Promise<void>;
}

export function openEmptyPlayModal(opts: EmptyPlayModalOptions): void {
  const modal = new Modal({ title: 'Nothing to play yet' });
  modal.body.dataset.testid = 'empty-play-modal';

  const intro = document.createElement('p');
  intro.className = dialogStyles.message!;
  intro.textContent =
    'Play runs the pattern machines — but no machine is switched on with '
    + 'steps to play, so starting the transport would be silent.';
  modal.body.appendChild(intro);

  const list = document.createElement('ul');
  list.className = styles.list!;
  for (const text of [
    'Switch on the Sequencer, Drum Machine or Sampler and light up a few steps in its grid.',
    'Load a song — or one of the demos — from the Song tab.',
    'Or let one rip right now with ▶ Play a demo.',
  ]) {
    const li = document.createElement('li');
    li.textContent = text;
    list.appendChild(li);
  }
  modal.body.appendChild(list);

  const aside = document.createElement('p');
  aside.className = styles.aside!;
  aside.textContent = 'The keyboard always plays live — no transport needed.';
  modal.body.appendChild(aside);

  const footer = document.createElement('div');
  footer.className = styles.footer!;

  // Persisted the moment it is checked, so every close path honours it (REQ-5).
  const dismiss = document.createElement('label');
  dismiss.className = styles.dismiss!;
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.dataset.testid = 'empty-play-dismiss';
  box.addEventListener('change', () => {
    try {
      if (box.checked) localStorage.setItem(EMPTY_PLAY_HINT_KEY, '1');
      else localStorage.removeItem(EMPTY_PLAY_HINT_KEY);
    } catch {
      /* private mode — the hint simply shows again next time */
    }
  });
  dismiss.appendChild(box);
  dismiss.appendChild(document.createTextNode("Don't show this again"));
  footer.appendChild(dismiss);

  const btns = document.createElement('div');
  btns.className = styles.btns!;
  btns.appendChild(createButton({
    label: 'Close',
    className: switchStyles.root!,
    testId: 'empty-play-close',
    onClick: () => modal.close(),
  }));
  const demoBtn = createButton({
    label: '▶ Play a demo',
    className: `${switchStyles.root!} ${styles.demoBtn!}`,
    testId: 'empty-play-demo',
    onClick: () => {
      modal.close();
      void opts.onPlayDemo();
    },
  });
  btns.appendChild(demoBtn);
  footer.appendChild(btns);
  modal.body.appendChild(footer);

  modal.open();
  demoBtn.focus();
}

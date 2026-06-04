// "Help" button (sits next to About). Opens a small chooser: take the guided
// tour, or switch on the contextual (i) help badges.
import { Modal } from './modal';
import { createButton } from './button';
import switchStyles from '../styles/switch.module.css';

export interface HelpDeps {
  startTour: () => void;
  toggleHelpMode: () => void;
}

export function createHelpButton(deps: HelpDeps): HTMLButtonElement {
  return createButton({ label: 'Help', testId: 'help-button', onClick: () => openHelpMenu(deps) });
}

function openHelpMenu(deps: HelpDeps): void {
  const modal = new Modal({ title: 'Help' });

  const intro = document.createElement('div');
  intro.className = Modal.metaClass;
  intro.innerHTML =
    'New to synths? Take the <strong>guided tour</strong> — it gets you to your first sound in ' +
    'a minute. Already exploring? Switch on the <strong>(i) badges</strong> for a quick note on ' +
    'each section.';
  modal.body.appendChild(intro);

  const tourBtn = createButton({
    label: 'Take the guided tour',
    className: `${switchStyles.root!} ${Modal.closeBtnClass}`,
    testId: 'help-start-tour',
    onClick: () => {
      modal.close();
      deps.startTour();
    },
  });

  const badgeBtn = createButton({
    label: 'Toggle help badges',
    className: `${switchStyles.root!} ${Modal.closeBtnClass}`,
    testId: 'help-toggle-badges',
    onClick: () => {
      modal.close();
      deps.toggleHelpMode();
    },
  });

  modal.body.appendChild(tourBtn);
  modal.body.appendChild(badgeBtn);
  modal.open();
}

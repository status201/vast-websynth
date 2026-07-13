// "Help" button (sits next to About). Opens a small chooser: take the guided
// tour, or switch on the contextual (i) help badges.
import { Modal } from './modal';
import { createButton } from './button';
import { HEADER_ICONS } from './header-icons';
import switchStyles from '../styles/switch.module.css';
import tourStyles from '../styles/tour.module.css';

export interface HelpDeps {
  startTour: () => void;
  toggleHelpMode: () => void;
  isHelpModeActive: () => boolean;
  onHelpModeChange: (cb: (active: boolean) => void) => void;
}

export function createHelpButton(deps: HelpDeps): HTMLButtonElement {
  const btn = createButton({
    label: 'Help',
    icon: HEADER_ICONS.help,
    title: 'Keyboard shortcuts & help',
    testId: 'help-button',
    onClick: () => openHelpMenu(deps),
  });
  // Light the Help button orange while the badges are showing, so it's clear
  // they can be toggled back off from here.
  deps.onHelpModeChange((active) => btn.classList.toggle(tourStyles.toggleActive!, active));
  return btn;
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
  // Reflect the current state so it reads as active (orange) when badges are on.
  badgeBtn.classList.toggle(tourStyles.toggleActive!, deps.isHelpModeActive());

  modal.body.appendChild(tourBtn);
  modal.body.appendChild(badgeBtn);
  modal.open();
}

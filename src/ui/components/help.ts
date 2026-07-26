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

/** Long-press window + travel slop, matching the step grids' gesture model
 *  (`grid-gestures.ts`) so a hold feels the same everywhere. */
const HOLD_MS = 350;
const SLOP_PX = 6;

const IDLE_TITLE = 'Help & Demo Tour — Shift+click or hold for badges';
const ACTIVE_TITLE = 'Turn off help badges';

export function createHelpButton(deps: HelpDeps): HTMLButtonElement {
  // Set by a fired long-press so the release's own click can't also open the
  // chooser modal behind the badges it just switched on (onboarding.md REQ-19).
  // Cleared on the next pointerdown too, so a hold whose release landed off the
  // button (no click at all) can't swallow a later, unrelated click.
  const hold = { fired: false };

  const btn = createButton({
    label: 'Help',
    icon: HEADER_ICONS.help,
    title: IDLE_TITLE,
    testId: 'help-button',
    // While the badges are showing the button is a one-click off switch (the
    // orange active state licenses that reading); otherwise it opens the menu.
    // A modifier skips the menu entirely and just toggles (REQ-19) — the same
    // outcome the hold gesture has, in either state.
    onClick: (ev) => {
      if (hold.fired) {
        hold.fired = false;
        return;
      }
      if (ev.shiftKey || ev.ctrlKey || ev.metaKey) deps.toggleHelpMode();
      else if (deps.isHelpModeActive()) deps.toggleHelpMode();
      else openHelpMenu(deps);
    },
  });
  attachHoldToggle(btn, deps, hold);
  // Light the Help button orange while the badges are showing, so it's clear
  // they can be toggled back off from here.
  deps.onHelpModeChange((active) => {
    btn.classList.toggle(tourStyles.toggleActive!, active);
    btn.title = active ? ACTIVE_TITLE : IDLE_TITLE;
  });
  return btn;
}

/**
 * Press-and-hold on the Help button toggles the badges (onboarding.md REQ-19) —
 * the touch route to the modifier-click above, since a phone has no Shift.
 * Deliberately does NOT `preventDefault()` the pointerdown: that would kill the
 * plain click this button still needs, so the fired hold flags `hold` and the
 * trailing click is swallowed by the click handler instead.
 */
function attachHoldToggle(
  btn: HTMLButtonElement,
  deps: HelpDeps,
  hold: { fired: boolean },
): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let startX = 0;
  let startY = 0;

  const cancel = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', cancel);
    document.removeEventListener('pointercancel', cancel);
  };

  function onMove(e: PointerEvent): void {
    // Travelled: the user is dragging (or scrolling), not holding.
    if (Math.abs(e.clientX - startX) < SLOP_PX && Math.abs(e.clientY - startY) < SLOP_PX) return;
    cancel();
  }

  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return; // left/touch only
    cancel();
    hold.fired = false; // a stale flag must never outlive its own gesture
    startX = e.clientX;
    startY = e.clientY;
    timer = setTimeout(() => {
      timer = undefined;
      hold.fired = true;
      deps.toggleHelpMode();
    }, HOLD_MS);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', cancel);
    document.addEventListener('pointercancel', cancel);
  });
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

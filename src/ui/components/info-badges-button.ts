// The header's ⓘ button: it toggles the info badges, and that is all it does
// (onboarding.md REQ-8). The glyph is deliberately the badges' own glyph — the
// button and the thing it switches on look the same, so there is nothing to
// learn. Help & About lives next door under the ? button.
import { createButton } from './button';
import { HEADER_ICONS } from './header-icons';
import tourStyles from '../styles/tour.module.css';

export interface InfoBadgesDeps {
  toggle: () => void;
  isActive: () => boolean;
  onChange: (cb: (active: boolean) => void) => void;
}

// The `(?)` is the keyboard route, named where the gesture is — the tooltip leg
// of the discoverability triple (recipes/design-an-interaction.md step 4).
const IDLE_TITLE = 'Show info badges (?)';
const ACTIVE_TITLE = 'Hide info badges (?)';

export function createInfoBadgesButton(deps: InfoBadgesDeps): HTMLButtonElement {
  const btn = createButton({
    label: 'Info badges',
    icon: HEADER_ICONS.info,
    title: IDLE_TITLE,
    testId: 'info-badges',
    onClick: deps.toggle,
  });

  // A toggle button, so the state is announced rather than left to the colour.
  const paint = (active: boolean): void => {
    btn.classList.toggle(tourStyles.toggleActive!, active);
    btn.setAttribute('aria-pressed', String(active));
    btn.title = active ? ACTIVE_TITLE : IDLE_TITLE;
  };
  paint(deps.isActive());
  deps.onChange(paint);

  return btn;
}

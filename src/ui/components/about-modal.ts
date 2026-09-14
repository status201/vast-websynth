// The About card itself: brand, version/copyright/source link, the tour-replay
// button, the shortcut reference, Play offline, the factory reset, and the Debug
// section.
//
// This is the lazy half of the About split — `about-button.ts` stays on the boot
// path and `import()`s this module on the click that opens it
// (runtime-performance.md REQ-1). The card's section order is a cross-spec
// invariant (factory-reset.md REQ-1, onboarding.md REQ-20, play-offline.md
// REQ-1), written down once in factory-reset.md "Layer touchpoints" — the
// appends below are that list. Do not reorder them.
import { Modal } from './modal';
import { createButton } from './button';
import { createBrand } from './brand';
import { confirmDialog } from './dialog';
import { restoreFactorySettings } from '../../state/factory-reset';
import { buildShortcuts } from './about-shortcuts';
import { buildOfflineSection } from './about-offline';
import { buildDebugSection } from './about-debug';
import type { AboutDeps } from './about-button';
import type { StudioApi } from '../studio-api';
import switchStyles from '../styles/switch.module.css';
import dialogStyles from '../styles/dialog.module.css';

declare const __APP_VERSION__: string;

export function buildModal(close: () => void, engine: StudioApi, deps: AboutDeps): {
  backdrop: HTMLElement;
  refreshDebug: () => void;
  disposeDebug: () => void;
  refreshOffline: () => void;
} {
  const backdrop = document.createElement('div');
  backdrop.className = `${Modal.backdropClass} hidden`;
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop) close();
  });

  const card = document.createElement('div');
  card.className = Modal.cardClass;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'About VAST G1-J8');

  // The real faceplate, not a flattened restatement of it (brand.md REQ-1).
  const brand = createBrand();

  const meta = document.createElement('div');
  meta.className = Modal.metaClass;
  const version = document.createElement('div');
  version.innerHTML = `Version <strong>${__APP_VERSION__}</strong>`;
  const copyright = document.createElement('div');
  copyright.innerHTML = `&copy; ${new Date().getFullYear()} <strong>Gijs Oliemans</strong>`;
  const source = document.createElement('div');
  const link = document.createElement('a');
  link.href = 'https://github.com/status201/vast-websynth';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'github.com/status201/vast-websynth';
  source.appendChild(link);
  meta.appendChild(version);
  meta.appendChild(copyright);
  meta.appendChild(source);

  // The one action in an otherwise reference-only modal, so it sits above the
  // reference (onboarding.md REQ-20). It is the app's only tour-replay route.
  const tourBtn = createButton({
    label: 'Take the guided tour',
    className: `${switchStyles.root!} ${Modal.closeBtnClass}`,
    testId: 'start-tour',
    onClick: () => {
      close();
      deps.startTour();
    },
  });

  const shortcuts = buildShortcuts();

  // Save every app file on the device (play-offline.md) — above the reset, the
  // constructive action before the destructive one.
  const offline = buildOfflineSection();

  const factoryReset = buildFactoryResetButton();

  const debug = buildDebugSection(engine);

  const closeBtn = createButton({
    label: 'Close',
    className: `${switchStyles.root!} ${Modal.closeBtnClass}`,
    onClick: close,
  });

  card.appendChild(brand);
  card.appendChild(meta);
  card.appendChild(tourBtn);
  card.appendChild(shortcuts.header);
  card.appendChild(shortcuts.row);
  card.appendChild(shortcuts.keys);
  card.appendChild(offline.root);
  card.appendChild(factoryReset);
  card.appendChild(debug.header);
  card.appendChild(debug.body);
  card.appendChild(closeBtn);
  backdrop.appendChild(card);
  return { backdrop, refreshDebug: debug.refresh, disposeDebug: debug.dispose, refreshOffline: offline.refresh };
}

/**
 * Destructive "Restore to Factory Settings" — wipes all origin-local storage and
 * the app's caches, then reloads (specs/features/factory-reset.md). Guarded by
 * the styled confirm, whose italic detail line is the classic Nintendo exit
 * dialog.
 */
function buildFactoryResetButton(): HTMLButtonElement {
  return createButton({
    label: 'Restore to Factory Settings',
    className: `${switchStyles.root!} ${Modal.closeBtnClass} ${dialogStyles.danger!}`,
    testId: 'factory-reset',
    onClick: async () => {
      const ok = await confirmDialog({
        title: 'Restore to Factory Settings',
        message: 'Are you sure? This erases all presets, songs, and settings saved on this device, then reloads the app. '
          // What happens to a saved offline copy (factory-reset.md REQ-8/REQ-9).
          // onLine is only a hint; the reset itself probes the server before deleting.
          + (navigator.onLine === false
            ? "You're offline, so a saved offline copy is kept."
            : 'A saved offline copy is downloaded again, fresh.'),
        detail: '“Everything not saved will be lost.”',
        confirmLabel: 'Restore',
        danger: true,
      });
      // Async only because the clip store (IndexedDB) and the caches are; the
      // reload happens inside, so nothing here needs the result.
      if (ok) void restoreFactorySettings();
    },
  });
}

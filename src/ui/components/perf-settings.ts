// The header's Settings button (gauge icon) — its dialog holds the theme picker
// (ui-themes.md) and, the part this file owns, the Performance mode: a device-scoped audio-quality preference in three
// tiers (Auto / Weak / Medium / Strong), persisted outside the ParamBus (see
// state/perf-mode.ts). Each tier maps to a PERF_PROFILE (buffer latency, polyphony,
// scope fps). The audio fields (buffer + voices) are fixed at AudioContext build, so
// crossing an *audio* boundary only takes full effect after a reload — the modal
// surfaces that. The scope fps is applied *live* via the onTierPreview callback.
//
// The segmented control is the *preference* (what should decide); the status line
// states the tier it resolves to *on this device* — so "Auto" is never confused with
// the concrete tier it picks.
import { createButton } from './button';
import { HEADER_ICONS } from './header-icons';
import { loadSurface } from './lazy-load-toast';
import {
  readPerfPref,
  resolveTier,
  sameAudioProfile,
  type PerfPref,
  type PerfTier,
} from '../../state/perf-mode';
import styles from '../styles/perf-settings.module.css';

/** Header-button colour class per tier (red / amber / green). */
const TIER_CLASS: Record<PerfTier, string> = {
  weak: styles.tierWeak!,
  medium: styles.tierMedium!,
  strong: styles.tierStrong!,
};

export interface PerfSettingsOptions {
  /** Apply the resolved tier's scope fps live (no reload needed for fps changes). */
  onTierPreview?: (tier: PerfTier) => void;
}

export function createPerfSettingsButton(opts: PerfSettingsOptions = {}): HTMLButtonElement {
  const btn = createButton({
    // The Settings dialog — theme, UI size and performance (ui-themes.md,
    // ui-scale.md); the gauge and the tier colour stay, since the tier is the
    // setting worth seeing at a glance.
    label: 'Settings — theme, UI size and performance',
    icon: HEADER_ICONS.perf,
    title: 'Settings — theme, UI size and performance',
    testId: 'perf-settings',
    onClick: () => void open(),
  });

  // The tier the running engine was actually built with (buffer/voices are fixed at
  // AudioContext build). Captured once: the stored pref hasn't changed since boot, so
  // this equals the engine's live audio state. A later choice whose audio profile
  // differs is "pending" until a reload.
  const bootTier = resolveTier();

  // Reflect the resolved tier on the header button: red (weak), amber (medium), green
  // (strong) — shown even under Auto. Pulse while a choice is pending a reload.
  function syncButton(pref: PerfPref = readPerfPref()): void {
    const tier = resolveTier(pref);
    const pending = !sameAudioProfile(tier, bootTier);
    btn.dataset.perfTier = tier;
    btn.dataset.perfPref = pref;
    btn.dataset.perfPending = pending ? '1' : '0';
    for (const t of ['weak', 'medium', 'strong'] as PerfTier[]) {
      btn.classList.toggle(TIER_CLASS[t], t === tier);
    }
    btn.classList.toggle(styles.pending!, pending);
  }
  syncButton(); // initial state at boot

  async function open(): Promise<void> {
    const m = await loadSurface('the settings', () => import('./perf-settings-modal'), () => void open());
    m?.openPerfSettingsModal({ bootTier, syncButton, onTierPreview: opts.onTierPreview });
  }

  return btn;
}

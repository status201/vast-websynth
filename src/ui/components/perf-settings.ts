// "Performance" button + modal: a device-scoped audio-quality preference in three
// tiers (Auto / Weak / Medium / Strong), persisted outside the ParamBus (see
// state/perf-mode.ts). Each tier maps to a PERF_PROFILE (buffer latency, polyphony,
// scope fps). The audio fields (buffer + voices) are fixed at AudioContext build, so
// crossing an *audio* boundary only takes full effect after a reload — the modal
// surfaces that. The scope fps is applied *live* via the onTierPreview callback.
//
// The segmented control is the *preference* (what should decide); the status line
// states the tier it resolves to *on this device* — so "Auto" is never confused with
// the concrete tier it picks.
import { Modal } from './modal';
import { createButton } from './button';
import { HEADER_ICONS } from './header-icons';
import {
  readPerfPref,
  writePerfPref,
  resolveTier,
  sameAudioProfile,
  PERF_PROFILES,
  type PerfPref,
  type PerfTier,
} from '../../state/perf-mode';
import segStyles from '../styles/segmented.module.css';
import switchStyles from '../styles/switch.module.css';
import styles from '../styles/perf-settings.module.css';

const OPTIONS: Array<{ value: PerfPref; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'weak', label: 'Weak' },
  { value: 'medium', label: 'Medium' },
  { value: 'strong', label: 'Strong' },
];

const TIER_LABEL: Record<PerfTier, string> = { weak: 'Weak', medium: 'Medium', strong: 'Strong' };
/** Editorial latency phrase per tier; the voice/fps numbers come from PERF_PROFILES. */
const TIER_LATENCY: Record<PerfTier, string> = {
  weak: 'larger audio buffer',
  medium: 'normal latency',
  strong: 'low latency',
};

/** Human summary of a tier for the modal status line (numbers sourced from PERF_PROFILES). */
function tierBlurb(tier: PerfTier): string {
  const p = PERF_PROFILES[tier];
  return `${TIER_LATENCY[tier]}, ${p.voiceCount} voices, ${p.fps} fps`;
}
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
    label: 'Performance settings',
    icon: HEADER_ICONS.perf,
    title: 'Performance settings',
    testId: 'perf-settings',
    onClick: open,
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

  function open(): void {
    let pref = readPerfPref();

    const modal = new Modal({ title: 'Performance' });

    const desc = document.createElement('div');
    desc.className = styles.desc!;
    desc.textContent =
      'Scales latency, polyphony, and the visualiser to this device. Weak adds buffer ' +
      'for crackle-free audio on slow hardware; Strong keeps latency low on fast machines.';

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
        // Apply the (live) scope fps immediately; audio changes still need a reload.
        opts.onTierPreview?.(resolveTier(pref));
        render();
      });
      seg.appendChild(b);
      return b;
    });
    modeRow.appendChild(modeLabel);
    modeRow.appendChild(seg);

    const help = document.createElement('div');
    help.className = styles.help!;
    help.textContent = 'Auto selects a tier from your hardware; Weak / Medium / Strong override that.';

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

      // Status: the tier the selected preference resolves to on this device.
      const tier = resolveTier(pref);
      const name = TIER_LABEL[tier];
      const blurb = tierBlurb(tier);
      status.className = styles.status!;
      status.innerHTML = pref === 'auto'
        ? `Auto selected <strong>${name}</strong> on this device — ${blurb}.`
        : `Forced to <strong>${name}</strong> — ${blurb}.`;

      // Keep the header button's tier colour in sync as the pref changes.
      syncButton(pref);

      // A reload only matters when the selection changes the engine's *audio* profile
      // (buffer/voices). Fps-only changes (e.g. Medium↔Strong) apply live.
      const needsReload = !sameAudioProfile(tier, bootTier);
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

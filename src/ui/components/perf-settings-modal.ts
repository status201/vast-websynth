// The Performance settings modal body (performance-mode.md). Split from
// `perf-settings.ts` so the header button — which shows the resolved tier from
// boot — stays eager and this loads with the click
// (runtime-performance.md REQ-boot-cost-matches-the-request).
import { Modal } from './modal';
import { createButton } from './button';
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

export interface PerfSettingsModalContext {
  /** The tier the running engine was built with (captured at boot by the button). */
  bootTier: PerfTier;
  /** Re-colour the header button for a preference. */
  syncButton: (pref: PerfPref) => void;
  onTierPreview?: (tier: PerfTier) => void;
}

export function openPerfSettingsModal(opts: PerfSettingsModalContext): void {
  const { bootTier, syncButton } = opts;
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

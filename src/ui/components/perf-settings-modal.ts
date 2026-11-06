// The Settings modal body: the theme picker (ui-themes.md
// REQ-choosing-a-theme-previews-it), the UI size (ui-scale.md), then the
// Performance tier (performance-mode.md). All three are how this device runs the
// app, never part of a song. Split from
// `perf-settings.ts` so the header button — which shows the resolved tier from
// boot — stays eager and this loads with the click
// (runtime-performance.md REQ-boot-cost-matches-the-request).
import { Modal } from './modal';
import { createButton } from './button';
import { createThemePicker } from './theme-picker';
import { createUiScaleControl } from './ui-scale-control';
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

/** A section heading inside the dialog — the Mode row's uppercase label, a size up so it heads its section. */
function sectionTitle(text: string): HTMLElement {
  const h = document.createElement('h3');
  h.className = styles.sectionTitle!;
  h.textContent = text;
  return h;
}

export interface PerfSettingsModalContext {
  /** The tier the running engine was built with (captured at boot by the button). */
  bootTier: PerfTier;
  /** Re-colour the header button for a preference. */
  syncButton: (pref: PerfPref) => void;
  onTierPreview?: (tier: PerfTier) => void;
}

/**
 * The Settings dialog: one section per device setting, each built by its own
 * owner — the theme picker by theme-picker.ts, the UI size by
 * ui-scale-control.ts, the tier below by `buildPerfSection` — so this only
 * composes them.
 */
export function openPerfSettingsModal(opts: PerfSettingsModalContext): void {
  const picker = createThemePicker();
  const scale = createUiScaleControl();
  const modal = new Modal({
    title: 'Settings',
    onClose: () => { picker.destroy(); scale.destroy(); },
  });

  const scaleTitle = sectionTitle('UI size');
  scaleTitle.classList.add(styles.sectionBreak!);
  const perfTitle = sectionTitle('Performance');
  perfTitle.classList.add(styles.sectionBreak!);

  const closeBtn = createButton({
    label: 'Close',
    className: `${switchStyles.root!} ${Modal.closeBtnClass}`,
    onClick: () => modal.close(),
  });

  modal.body.append(
    sectionTitle('Theme'), picker.el,
    scaleTitle, scale.el,
    perfTitle, ...buildPerfSection(opts),
    closeBtn,
  );
  modal.open();
}

/** The Performance section (performance-mode.md REQ-a-perf-button-opens-the-picker): the tier
 *  control, what it resolves to here, and the reload it may need. */
function buildPerfSection(opts: PerfSettingsModalContext): HTMLElement[] {
  const { bootTier, syncButton } = opts;
  let pref = readPerfPref();

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

  render();
  return [desc, modeRow, help, status, reloadHint, reloadBtn];
}

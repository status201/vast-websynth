import type { ShellDeps } from './deps';
import type { SyncStatus } from '../../audio/transport/sync/sync-types';
import type { Onboarding } from '../onboarding';
import type { PresetManagerOptions } from '../components/preset-manager-modal';
import { VOICING_LABELS } from '../../state/params';
import { Presets } from '../../state/preset';
import type { PerfTier } from '../../state/perf-mode';
import { Knob } from '../components/knob';
import { Segmented } from '../components/segmented';
import { MeterPicker } from '../components/meter-picker';
import { Dropdown } from '../components/dropdown';
import { createButton } from '../components/button';
import { HEADER_ICONS } from '../components/header-icons';
import { UI_ICONS } from '../components/ui-icons';
import { loadSurface } from '../components/lazy-load-toast';
import { createAboutButton } from '../components/about-button';
import { createBrand } from '../components/brand';
import { createInfoBadgesButton } from '../components/info-badges-button';
import { createPerfSettingsButton } from '../components/perf-settings';
import { createFullscreenButton } from '../components/fullscreen-button';
import { createPlayButton } from './play-button';
import switchStyles from '../styles/switch.module.css';
import headerStyles from '../styles/header.module.css';

/**
 * The preset manager loads on the click that opens it (runtime-performance.md
 * REQ-boot-cost-matches-the-request) — both the header button and the `openPresetImport` bridge hook, so a
 * dropped preset file pulls it in exactly like the button does.
 *
 * Only the import is guarded: a rejection means the chunk is missing and the
 * user gets a retry (lazy-load-failure.md), whereas a throw from the modal
 * itself is a bug and must not be dressed up as one.
 */
async function openPresetManagerModal(opts: PresetManagerOptions): Promise<void> {
  const m = await loadSurface(
    'the preset manager',
    () => import('../components/preset-manager-modal'),
    () => void openPresetManagerModal(opts),
  );
  m?.openPresetManagerModal(opts);
}

/**
 * The sticky app header: brand, the preset cluster (behind a hamburger below
 * 720px — responsive-header.md), the transport cluster and the voicing cluster.
 * Binds the bridge hooks its controls own: `openPresetImport`,
 * `toggleInfoBadges`, and — through the Play button — `toggleTransport` and
 * `cuePlay`.
 */
type HeaderDeps = Pick<ShellDeps, 'engine' | 'bus' | 'bridge' | 'session'>;

export function buildHeader(
  deps: HeaderDeps, onboarding: Onboarding,
  previewScopeTier: (tier: PerfTier) => void, loadDemo: (name: string) => Promise<void>,
): HTMLElement {
  const el = document.createElement('div');
  el.className = headerStyles.header!;
  el.dataset.testid = 'app-header';

  // Brand block (brand.md) — shared with the About and start modals. Only the
  // divider rule to its right is the header's own (brand.md REQ-brand-block-carries-no-framing).
  const brand = createBrand();
  brand.classList.add(headerStyles.headerBrand!);
  el.appendChild(brand);

  // Below 720px the preset cluster collapses behind this hamburger to keep the
  // sticky header compact; CSS parks it top-right and expands the cluster inline
  // while `.menuOpen` is set (see specs/features/responsive-header.md).
  const menuToggle = createButton({
    label: 'Toggle preset menu',
    icon: UI_ICONS.menu,
    testId: 'header-menu',
    className: `${switchStyles.root!} ${headerStyles.menuToggle!}`,
    onClick: () => {
      const open = el.classList.toggle(headerStyles.menuOpen!);
      menuToggle.setAttribute('aria-expanded', String(open));
    },
  });
  menuToggle.setAttribute('aria-expanded', 'false');
  el.appendChild(menuToggle);

  el.appendChild(buildPresetGroup(deps, onboarding, previewScopeTier));

  const spacer = document.createElement('div');
  spacer.className = headerStyles.headerSpacer!;
  el.appendChild(spacer);

  // Zero-height flex line break, active whenever the header wraps (≤1140px):
  // the transport cluster always starts the second row (voicing right-aligns
  // via auto margin), and below 720px the hamburger's auto margin owns row 1.
  const headerBreak = document.createElement('div');
  headerBreak.className = headerStyles.headerBreak!;
  el.appendChild(headerBreak);

  el.appendChild(buildTransportGroup(deps, loadDemo));
  el.appendChild(buildVoicingGroup(deps));

  return el;
}

/** The preset selector, the one Presets door, and the utility icon buttons. */
function buildPresetGroup(
  { engine, bus, bridge, session }: HeaderDeps, onboarding: Onboarding,
  previewScopeTier: (tier: PerfTier) => void,
): HTMLElement {
  const presetGroup = document.createElement('div');
  presetGroup.className = `${headerStyles.headerGroup!} ${headerStyles.presetGroup!}`;

  const dropdown = new Dropdown(Presets.list(), Presets.list()[0] ?? '');
  dropdown.el.dataset.testid = 'preset-select';

  /**
   * The preset list, with the loaded song's sound pinned on top (presets.md
   * REQ-a-songs-sound-is-a-selectable-entry). A stored preset of the same name drops out while the song is
   * loaded, so one label never renders twice and the pinned sound wins.
   */
  const presetOptions = (): string[] => {
    const song = session.songSound;
    if (!song) return Presets.list();
    return [song.name, ...Presets.list().filter((n) => n !== song.name)];
  };

  /** The pinned name currently rendered, so a rebuild happens only when the
   *  list actually changes (see `syncSelector`). */
  let pinnedInList: string | null = null;

  /**
   * Rebuild the options, then re-assert the label.
   *
   * The order is the requirement (presets.md REQ-rebuilding-options-never-relabels): `setOptions` falls back to
   * the first option when the current value is absent (dropdown.md REQ-selecting-an-option-closes-the-menu/REQ-set-options-never-strands-the-value),
   * and the displayed value here is often absent — a song name, or a dirty
   * "Ember *". Without the re-assert, a preset *import* — which changes no sound
   * at all — silently relabelled the header to "acid".
   */
  const refreshPresetOptions = (): void => {
    pinnedInList = session.songSound?.name ?? null;
    dropdown.setOptions(presetOptions(), { dividerAfter: pinnedInList ? 1 : 0 });
    dropdown.setValue(session.display);
  };

  /**
   * The selector mirrors the active sound (preset/song name + dirty marker) and
   * owns the pinned entry — one subscription keeps label, marker and list in step.
   *
   * Most emissions (`setActive`, `markDirty`) change only the *label*, so the
   * option list is rebuilt only when the pinned song changed. That keeps a dirty
   * transition off the DOM (runtime-performance.md) and, more to the point, stops
   * a stray param edit from tearing down an open menu under the user's focus.
   */
  const syncSelector = (): void => {
    if ((session.songSound?.name ?? null) !== pinnedInList) refreshPresetOptions();
    else dropdown.setValue(session.display);
  };
  session.subscribe(syncSelector);

  dropdown.onChange((name) => {
    const song = session.songSound;
    // The pinned entry restores the song's patch; everything else is a preset.
    const snap = song && name === song.name ? song.patch : Presets.load(name);
    if (snap) Presets.apply(bus, snap);
    session.setActive(name);
  });

  // One door for everything you can do with a sound — save, export a preset or
  // a bank, import (presets.md REQ-one-door-for-saving). The header stays a single button.
  const saveBtn = createButton({
    label: 'Presets — save, export, import',
    icon: HEADER_ICONS.save,
    title: 'Presets — save, export, import',
    testId: 'preset-save',
    onClick: () => void openPresetManagerModal({
      bus,
      session,
      onPresetsChanged: refreshPresetOptions,
    }),
  });

  // The paste door lives in the Song panel but preset imports belong to this
  // manager (and must refresh the dropdown above) — so they meet on the bridge
  // (paste-import.md REQ-paste-confirm-routes-by-kind).
  bridge.openPresetImport = (parse) => void openPresetManagerModal({
    bus,
    session,
    onPresetsChanged: refreshPresetOptions,
    initialImport: parse,
  });

  const presetLabel = document.createElement('span');
  presetLabel.className = headerStyles.presetLabel!;
  presetLabel.textContent = 'Preset:';
  presetGroup.appendChild(presetLabel);
  presetGroup.appendChild(dropdown.el);
  presetGroup.appendChild(saveBtn);
  // Inner spacer, active at the ≤1140px wrap step: keeps the dropdown + Save
  // left-aligned while pushing the utility icon buttons to the far right.
  const presetSpacer = document.createElement('div');
  presetSpacer.className = headerStyles.presetSpacer!;
  presetGroup.appendChild(presetSpacer);
  presetGroup.appendChild(
    createPerfSettingsButton({ onTierPreview: previewScopeTier }),
  );
  // ⓘ then ? — one toggles the badges, the other opens Help & About, and each
  // does only that (onboarding.md REQ-the-info-button-is-a-toggle/REQ-about-is-the-single-door-for-help).
  presetGroup.appendChild(
    createInfoBadgesButton({
      toggle: onboarding.toggleInfoBadges,
      isActive: onboarding.isInfoBadgesActive,
      onChange: onboarding.onInfoBadgesChange,
    }),
  );
  presetGroup.appendChild(
    createAboutButton(engine, { startTour: onboarding.startTour }),
  );
  // The `?` key's route to the badges (input-control.md REQ-question-mark-toggles-the-badges) — here rather
  // than in shortcuts.ts, which must not import the onboarding layer.
  bridge.toggleInfoBadges = onboarding.toggleInfoBadges;
  // Last in the row; absent (null) where the Fullscreen API is missing — iPhone Safari.
  const fullscreenBtn = createFullscreenButton();
  if (fullscreenBtn) presetGroup.appendChild(fullscreenBtn);
  return presetGroup;
}

/** Play, then BPM, SWING and the meter — the three things the grid is written against. */
function buildTransportGroup(
  deps: Pick<ShellDeps, 'engine' | 'bus' | 'bridge'>, loadDemo: (name: string) => Promise<void>,
): HTMLElement {
  const { engine, bus } = deps;
  const transport = document.createElement('div');
  transport.className = `${headerStyles.headerGroup!} ${headerStyles.transportGroup!}`;

  transport.appendChild(createPlayButton(deps, loadDemo));
  // Capture the BPM knob so it can dim + refuse input while slaved — the tempo
  // is then driven by the sync master (midi-clock-sync REQ-the-bpm-knob-shows-slaved). Keyed on the
  // *running* role, so a selected-but-disconnected Slave leaves the knob live
  // instead of freezing it at a vanished master's tempo (REQ-selected-mode-versus-active-role/REQ-an-armed-sync-section).
  const bpmKnob = new Knob({ bus, paramId: 'transport.bpm', label: 'BPM' });
  const applySlaved = (s: SyncStatus): void => {
    const slaved = s.activeMode === 'slave';
    bpmKnob.setDisabled(slaved);
    bpmKnob.el.title = slaved
      ? 'Tempo follows the sync master while slaved'
      : s.mode !== 'off'
        ? 'Sync is armed but nothing is connected — the tempo is yours'
        : '';
  };
  applySlaved(engine.sync.status);
  engine.sync.onStatus(applySlaved);
  transport.appendChild(bpmKnob.el);
  transport.appendChild(new Knob({ bus, paramId: 'transport.swing', label: 'SWING' }).el);
  // Beside BPM and SWING, because a meter is the third thing that defines the
  // grid everything else is written against (meter.md REQ-meter-is-two-bus-scalars).
  transport.appendChild(new MeterPicker(bus).el);
  return transport;
}

/** Voicing mode, Panic and the master volume. */
function buildVoicingGroup({ engine, bus }: Pick<ShellDeps, 'engine' | 'bus'>): HTMLElement {
  const right = document.createElement('div');
  right.className = `${headerStyles.headerGroup!} ${headerStyles.voicingGroup!}`;

  const voicing = new Segmented(bus, 'voicing.mode', VOICING_LABELS);
  right.appendChild(voicing.el);

  const panicBtn = createButton({ label: 'Panic', testId: 'panic', onClick: () => engine.panic() });
  right.appendChild(panicBtn);

  const masterKnob = new Knob({ bus, paramId: 'master.volume', label: 'VOL' });
  right.appendChild(masterKnob.el);
  return right;
}

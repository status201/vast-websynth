/**
 * The app's assembly: builds the five regions in page order — header, synth
 * panels, FX rack, MACHINES row, bottom column — and wires the hooks that cross
 * them, each bound late by the region that owns its state (the tour's FX expand,
 * the demo loader, the scope's live performance knobs). The regions themselves
 * live in `shell/` and `panels/`; nothing is built here (architecture.md).
 */
import { pinAppliedSong } from '../state/preset-session';
import { Song, DEMO_SONGS } from '../state/song';
import { PERF_PROFILES, type PerfTier } from '../state/perf-mode';
import { setScopeStatsSource } from '../state/debug-sources';
import { createOnboarding, type Onboarding } from './onboarding';
import type { TourCtx } from './onboarding/tour';
import type { ShellDeps } from './shell/deps';
import { buildHeader } from './shell/header';
import { buildSynthPanels } from './panels/synth-panels';
import { buildFxRack } from './panels/fx-rack';
import { buildPatternRow } from './shell/pattern-row';
import { buildBottom } from './shell/bottom';

export function mountApp(root: HTMLElement, deps: ShellDeps): Onboarding {
  const { engine, bus, bridge, session, xy } = deps;
  root.innerHTML = '';

  // Late-bound hooks, filled once their panels are built; the tour calls them.
  let fxExpand: () => void = () => {};
  // Scope fps + analyser fftSize are applied live when the perf tier changes;
  // bound once buildBottom runs.
  let setScopeFps: (fps: number) => void = () => {};
  let setScopeFft: (fftSize: number) => void = () => {};
  // Apply both live scope knobs for a tier (perf-mode: fps + fftSize are live).
  const previewScopeTier = (tier: PerfTier): void => {
    setScopeFps(PERF_PROFILES[tier].fps);
    setScopeFft(PERF_PROFILES[tier].analyserFftSize);
  };
  // Default loads a demo without UI sync; replaced by the Song panel's own
  // loader (which also syncs the slot dropdown) once buildPatternRow runs.
  // Only the built-in is reachable here — the drop-in and zip demos are
  // fetched on click and so are inherently async (song-mode.md REQ-song-lane-titles-navigate) — but
  // this fallback is replaced a few lines below and never actually used.
  // The real unknown-name fallback lives in `resolveDemoName` (REQ-a-taller-bar-pins-the-peak, v18),
  // which `SongPanel.loadDemo` applies to every caller including the tour.
  let songLoadDemo: (name: string) => Promise<void> = async (name) => {
    const file = DEMO_SONGS[name] ?? Object.values(DEMO_SONGS)[0];
    if (file) {
      Song.apply(file, bus, engine.patterns, engine.arrangement, xy, engine.sampler);
      pinAppliedSong(session, file.name, bus);
    }
  };

  // Runtime hooks for the tour. `bridge.toggleTransport` is set inside
  // buildHeader (runs before any tour starts), so reading it lazily is safe.
  const ctx: TourCtx = {
    bus,
    engine,
    toggleTransport: () => bridge.toggleTransport(),
    applyDemo: (name) => songLoadDemo(name),
    resumeAudio: () => engine.resume(),
    expandFx: () => fxExpand(),
  };
  const onboarding = createOnboarding(ctx);

  // The header's empty-play hint loads a demo through the same late-bound
  // loader the tour uses (rebound to the Song panel's dropdown-syncing loader
  // once buildPatternRow runs below).
  root.appendChild(buildHeader(deps, onboarding, previewScopeTier, (name) => songLoadDemo(name)));
  root.appendChild(buildSynthPanels(bus));
  const fx = buildFxRack(bus);
  fxExpand = fx.expand;
  root.appendChild(fx.el);
  const patternRow = buildPatternRow(deps);
  songLoadDemo = patternRow.loadDemo;
  // Share links import bytes; OS-launched song files (installed-PWA
  // file_handlers) arrive as a File and take the Song panel's Import-button door,
  // sized before they are read (pwa-install.md REQ-one-import-parse-path,
  // untrusted-input.md REQ-a-file-is-sized-before-it-is-read).
  bridge.importSongBytes = patternRow.importSongBytes;
  bridge.importSongFile = patternRow.importSongFile;
  root.appendChild(patternRow.el);
  const bottom = buildBottom(deps);
  setScopeFps = (fps) => bottom.scope.setFps(fps);
  setScopeFft = (fftSize) => bottom.scope.setFftSize(fftSize);
  // Whether the panel is actually painting, for the Debug row (scope.md REQ-the-panel-says-whether-it-is-drawing).
  // Same late-bound idiom as the two knobs above — the owner of the state binds it.
  setScopeStatsSource(() => bottom.scope.health);
  root.appendChild(bottom.el);

  return onboarding;
}

import type { UndoMachine } from '../../state/pattern-undo';
import type { ShellDeps } from './deps';
import { createEffectiveXy } from '../../state/xy-effective';
import { TabContainer } from '../components/tabs';
import { createXyPadWindowController } from '../components/xy-pad-window';
import { createModMatrixWindowController } from '../components/mod-matrix-window';
import {
  ARP_TAB, KEY_TAB, MACHINE_IDS, MACHINE_TAB,
  readArpStatus, readKeyStatus, readMachineStatus,
  subscribeArpStatus, subscribeKeyStatus, subscribeMachineStatus,
} from '../machine-status';
import { buildArpPanel } from '../panels/arp-panel';
import { buildKeyPanel } from '../panels/key-panel';
import { buildSeqPanel } from '../panels/seq-panel';
import { buildDrumPanel } from '../panels/drum-panel';
import { buildSamplerPanel } from '../panels/sampler-panel';
import { buildMotionPanel } from '../panels/motion-panel';
import { buildSongPanel } from '../panels/song-panel';
import type { MachinePanel } from '../panels/step-panel-scaffold';
import { isCompact } from '../viewport';
import patternRowStyles from '../styles/pattern-row.module.css';

/**
 * The MACHINES row: the seven pattern tabs (Arpeggiator, Key, the four step
 * machines, Song) in one foldable TabContainer. It owns the routing that
 * depends on which tab is in front — Ctrl+Z and Delete go to the machine
 * behind it, Step Input disarms when its grid leaves the screen, and a hidden
 * panel stops repainting — and binds the bridge hooks for them
 * (`undoActiveMachine`, `clearSelectedStep`, `showTab`).
 *
 * Returns the Song panel's demo loader and song importer, which the rest of
 * the app reaches through `mountApp`'s late-bound hooks.
 */
export function buildPatternRow({ engine, bus, bridge, session, xy, patternUndo }: ShellDeps): {
  el: HTMLElement;
  loadDemo: (name: string) => Promise<void>;
  importSongBytes: (bytes: Uint8Array, name: string) => Promise<boolean>;
} {
  // One shared XY Pad window controller for every launcher (Song panel, LIVE FX
  // window, Motion panel) — they must all toggle the SAME window (xy-pad.md).
  // The pad's axes follow the *effective* assignment (a motion play bank's
  // override wins while motion is on), so its labels stay truthful per bar.
  const effectiveXy = createEffectiveXy(xy, engine.patterns, engine.arrangement, bus);
  const xyWin = createXyPadWindowController(bus, xy, effectiveXy);
  // One controller for the whole app, like `xyWin`: every launcher must toggle the
  // SAME window, never spawn a second (mod-matrix.md, floating-window.md REQ-floating-window-reopens).
  const modWin = createModMatrixWindowController(bus);
  const song = buildSongPanel(bus, engine, session, xy, bridge, xyWin, modWin);
  // Hoisted out of the tabs array: the panel is built before the TabContainer
  // exists, so this is the only way to keep a handle on it (see below).
  const seq = buildSeqPanel(bus, engine, patternUndo, bridge);
  const drums = buildDrumPanel(bus, engine, patternUndo, bridge);
  const sampler = buildSamplerPanel(bus, engine, patternUndo, bridge);
  const motion = buildMotionPanel(bus, engine, xy, xyWin, patternUndo, bridge);
  const tabs = new TabContainer([
    { id: 'arp', label: 'Arpeggiator', content: buildArpPanel(bus), indicator: true },
    { id: 'key', label: 'Key', content: buildKeyPanel(bus), indicator: true },
    { id: 'seq', label: 'Sequencer', content: seq.el, indicator: true },
    { id: 'drums', label: 'Drum Machine', content: drums.el, indicator: true },
    { id: 'sampler', label: 'Sampler', content: sampler.el, indicator: true },
    { id: 'motion', label: 'Motion', content: motion.el, indicator: true },
    { id: 'song', label: 'Song', content: song.el },
  ], 'arp', {
    // `compact`: seven tabs leave no room for the word at <=1140px, so only the
    // icon stays there (section-title.md REQ-compact-drops-text-not-icon).
    title: { text: 'Machines', icon: 'padMachine', compact: true },
    collapsibleStoreKey: 'websynth.ui.collapsed.pattern',
    collapsedByDefault: isCompact,
  });
  tabs.el.classList.add(patternRowStyles.patternRow!);
  tabs.el.dataset.testid = 'pattern-row';

  // Ctrl/Cmd+Z routes to the machine behind the active tab (pattern-undo.md
  // REQ-ctrl-z-undoes-the-active-machine). Arp/Song (and empty stacks) return false so the key falls through.
  const TAB_MACHINE: Record<string, UndoMachine> = {
    seq: 'seq', drums: 'drum', sampler: 'sampler', motion: 'motion',
  };
  bridge.undoActiveMachine = () => {
    const m = TAB_MACHINE[tabs.activeId];
    if (!m || !patternUndo.canUndo(m)) return false;
    patternUndo.undo(m);
    return true;
  };

  // Delete/Backspace clears the selected step of the machine behind the active
  // tab (step-grid-editing.md REQ-delete-clears-the-selected-step) — the same routing shape as Ctrl+Z above.
  // Motion is absent on purpose: it has no selection cursor (REQ-motion-keeps-its-own-gesture).
  const TAB_PANEL: Record<string, MachinePanel> = { seq, drums, sampler };
  bridge.clearSelectedStep = () => {
    const panel = TAB_PANEL[tabs.activeId];
    if (!panel) return false;
    panel.clearSelectedStep();
    return true;
  };

  // Step Input is armed only while its own grid is on screen (sequencer.md
  // REQ-step-input-arms-only-on-screen): switching tabs or folding the row disarms it, so notes played
  // elsewhere — held chords on the Arpeggiator tab, say — can never overwrite
  // the sequencer bank behind the user's back.
  tabs.onViewChange(() => { if (!tabs.isVisible('seq')) seq.disarmStepInput(); });

  // A hidden panel keeps its subscriptions but does no repainting: all four
  // would otherwise sweep a playhead every 16th (and Motion re-project its SVG
  // graph every bar) against DOM nobody can see. `isVisible` is false for the
  // whole row when it is folded too, so a collapsed pattern row costs nothing.
  // Each gate replays the current state on reveal — see VisibilityGate.
  // (runtime-performance.md REQ-no-work-for-offscreen-dom)
  const gated: Array<[string, { gate: { set(v: boolean): void } }]> = [
    ['seq', seq], ['drums', drums], ['sampler', sampler], ['motion', motion],
  ];
  const syncGates = (): void => {
    for (const [id, panel] of gated) panel.gate.set(tabs.isVisible(id));
  };
  tabs.onViewChange(syncGates);
  syncGates(); // the panels were built before the tabs existed

  // The Song panel's lane titles navigate here (machine-status.md REQ-lane-titles-navigate).
  bridge.showTab = (id) => tabs.reveal(id);

  // Machine status LEDs (machine-status.md REQ-machine-state-has-one-source-of-truth/REQ-a-machine-has-three-states). `subscribe` fires
  // immediately with the current value, so this also paints the initial state.
  subscribeMachineStatus(bus, () => {
    const status = readMachineStatus(bus);
    for (const m of MACHINE_IDS) tabs.setIndicator(MACHINE_TAB[m], status[m]);
  });
  // The arp is not a machine — no lane, so no mute or solo — but whether it is
  // armed changes what the keyboard does, which is worth reading at a glance
  // mid-performance (machine-status.md REQ-the-arpeggiator-tab-has-a-lamp).
  subscribeArpStatus(bus, () => tabs.setIndicator(ARP_TAB, readArpStatus(bus)));
  // Same reasoning for the key: an active scale silently re-pitches every note, so
  // "is anything re-pitching me?" must be answerable without opening the tab.
  subscribeKeyStatus(bus, () => tabs.setIndicator(KEY_TAB, readKeyStatus(bus)));

  return { el: tabs.el, loadDemo: song.loadDemo, importSongBytes: song.importBytes };
}

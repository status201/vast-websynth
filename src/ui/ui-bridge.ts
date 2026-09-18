import type { PresetParse } from '../state/preset-file';

export class UiBridge {
  pressKey = (_note: number): void => {};
  releaseKey = (_note: number): void => {};
  toggleTransport = (): void => {};
  /** Import raw song/project bytes (rewired to `SongPanel.importBytes`) —
   * drives OS file launches and share links into the one import path
   * (pwa-install.md REQ-one-import-parse-path, song-share-link.md REQ-boot-consumes-a-present-hash). Resolves to whether the
   * song applied, so a share link only consumes its hash on success. */
  importSongBytes = async (_bytes: Uint8Array, _name: string): Promise<boolean> => false;
  /** Open the preset import wizard on its review step with an already-parsed
   * payload (paste-import.md REQ-paste-confirm-routes-by-kind). The preset manager is owned by the header
   * (where the dropdown that must refresh lives) while the paste door is in the
   * Song panel, so the two meet here rather than importing each other. */
  openPresetImport = (_parse: PresetParse): void => {};
  /** Undo the active machine tab's last grid edit (Ctrl/Cmd+Z routing —
   * pattern-undo.md REQ-ctrl-z-undoes-the-active-machine). Returns whether an undo actually ran, so the
   * shortcut only preventDefaults when it did. Assigned in buildPatternRow;
   * the default no-op leaves the key to the browser. */
  undoActiveMachine = (): boolean => false;
  /** Clear the selected step on the active machine tab (Delete/Backspace —
   * step-grid-editing.md REQ-delete-clears-the-selected-step). Same late-bound seam as undoActiveMachine:
   * returns whether it acted, so the key falls through on the Arp/Song/Motion
   * tabs (Motion has no selection cursor — REQ-question-mark-toggles-the-badges). */
  clearSelectedStep = (): boolean => false;
  /** Toggle the ⓘ info badges — the `?` key's route (input-control.md REQ-question-mark-toggles-the-badges,
   * onboarding.md REQ-the-info-button-gesture-inventory). Lives here rather than in `shortcuts.ts` so the
   * shortcut layer never imports the onboarding layer, exactly like
   * `toggleTransport`. Assigned in buildHeader, where onboarding exists. */
  toggleInfoBadges = (): void => {};
  /** Reveal a pattern-row tab by id, expanding the row if it is collapsed
   * (machine-status.md REQ-lane-titles-navigate/REQ-reveal-beats-activate) — drives the Song panel's lane titles.
   * Assigned in buildPatternRow, which is where `tabs` first exists: the Song
   * panel is built one line earlier (its el IS a tab's content), so it can
   * never hold a TabContainer reference directly. */
  showTab = (_id: string): void => {};
  /** Something just happened that stays silent until the transport runs —
   * a demo/song load, an import, a machine or chain enable — so the header
   * fast-blinks the Play LED green while stopped (play-button-blink.md
   * REQ-silent-actions-arm-a-green-cue). Assigned in buildHeader; the default is a safe no-op. */
  cuePlay = (): void => {};
  /** Open/close the RECORD floating window (Shift+R — record-window.md REQ-shift-r-toggles-the-record-window).
   * Same late-bound seam as `toggleInfoBadges`, so `shortcuts.ts` never reaches
   * into a panel: the Song panel assigns it when it builds the launcher. */
  toggleRecordWindow = (): void => {};
}

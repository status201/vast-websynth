export class UiBridge {
  pressKey = (_note: number): void => {};
  releaseKey = (_note: number): void => {};
  toggleTransport = (): void => {};
  /** Import raw song/project bytes (rewired to `SongPanel.importBytes`) —
   * drives OS file launches and share links into the one import path
   * (pwa-install.md REQ-7, song-share-link.md REQ-3). Resolves to whether the
   * song applied, so a share link only consumes its hash on success. */
  importSongBytes = async (_bytes: Uint8Array, _name: string): Promise<boolean> => false;
  /** Undo the active machine tab's last grid edit (Ctrl/Cmd+Z routing —
   * pattern-undo.md REQ-10). Returns whether an undo actually ran, so the
   * shortcut only preventDefaults when it did. Assigned in buildPatternRow;
   * the default no-op leaves the key to the browser. */
  undoActiveMachine = (): boolean => false;
  /** Clear the selected step on the active machine tab (Delete/Backspace —
   * step-grid-editing.md REQ-5). Same late-bound seam as undoActiveMachine:
   * returns whether it acted, so the key falls through on the Arp/Song/Motion
   * tabs (Motion has no selection cursor — REQ-9). */
  clearSelectedStep = (): boolean => false;
  /** Reveal a pattern-row tab by id, expanding the row if it is collapsed
   * (machine-status.md REQ-5/REQ-7) — drives the Song panel's lane titles.
   * Assigned in buildPatternRow, which is where `tabs` first exists: the Song
   * panel is built one line earlier (its el IS a tab's content), so it can
   * never hold a TabContainer reference directly. */
  showTab = (_id: string): void => {};
  /** Something just happened that stays silent until the transport runs —
   * a demo/song load, an import, a machine or chain enable — so the header
   * fast-blinks the Play LED green while stopped (play-button-blink.md
   * REQ-3). Assigned in buildHeader; the default is a safe no-op. */
  cuePlay = (): void => {};
}

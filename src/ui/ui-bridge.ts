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
  /** Something just happened that stays silent until the transport runs —
   * a demo/song load, an import, a machine or chain enable — so the header
   * fast-blinks the Play LED green while stopped (play-button-blink.md
   * REQ-3). Assigned in buildHeader; the default is a safe no-op. */
  cuePlay = (): void => {};
}

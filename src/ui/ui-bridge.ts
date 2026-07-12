export class UiBridge {
  pressKey = (_note: number): void => {};
  releaseKey = (_note: number): void => {};
  toggleTransport = (): void => {};
  /** Import raw song/project bytes (rewired to `SongPanel.importBytes`) —
   * drives OS file launches and share links into the one import path
   * (pwa-install.md REQ-7, song-share-link.md REQ-3). Resolves to whether the
   * song applied, so a share link only consumes its hash on success. */
  importSongBytes = async (_bytes: Uint8Array, _name: string): Promise<boolean> => false;
}

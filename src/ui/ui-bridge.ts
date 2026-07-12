export class UiBridge {
  pressKey = (_note: number): void => {};
  releaseKey = (_note: number): void => {};
  toggleTransport = (): void => {};
  /** Import raw song/project bytes (rewired to `SongPanel.importBytes`) —
   * drives OS file launches into the one import path (pwa-install.md REQ-7). */
  importSongBytes = async (_bytes: Uint8Array, _name: string): Promise<void> => {};
}

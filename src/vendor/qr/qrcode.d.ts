// Hand-written types for the vendored qrcode-generator build (MIT, see ./LICENSE).
// Only the subset we use (byte-mode encode + module read-out) is declared; the
// library also ships image/SVG/ASCII renderers we don't use.

export interface QrCode {
  /** Append data (default byte mode). */
  addData(data: string): void;
  /** Build the module matrix (call after addData). */
  make(): void;
  /** The matrix side length in modules. */
  getModuleCount(): number;
  /** Whether the module at (row, col) is dark. */
  isDark(row: number, col: number): boolean;
}

/** `typeNumber` 0 = auto-pick the smallest version; EC level 'L' | 'M' | 'Q' | 'H'. */
export function qrcode(
  typeNumber: number,
  errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H',
): QrCode;

export default qrcode;

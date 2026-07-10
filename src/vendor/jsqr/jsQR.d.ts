// Hand-written types for the vendored jsQR build (Apache-2.0, see ./LICENSE).
// Self-contained (the shipped index.d.ts split types across ./decoder, ./locator
// which this single-file bundle doesn't expose). Only the subset we use — decode
// an RGBA frame to its string payload — is declared.

export interface Point {
  x: number;
  y: number;
}

export interface QRCode {
  /** The decoded text payload. */
  data: string;
  /** Raw decoded bytes. */
  binaryData: number[];
  version: number;
  location: {
    topRightCorner: Point;
    topLeftCorner: Point;
    bottomRightCorner: Point;
    bottomLeftCorner: Point;
  };
}

export interface Options {
  inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst';
}

/** Decode a QR from an RGBA pixel buffer; null when no code is found. */
declare function jsQR(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: Options,
): QRCode | null;

export default jsQR;

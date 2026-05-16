// Hand-written types for the vendored lamejs build (MIT, see ./LICENSE).
// Only the subset we use is declared.

export class Mp3Encoder {
  constructor(channels: number, sampleRate: number, kbps: number);
  encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
  flush(): Int8Array;
}

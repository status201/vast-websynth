// Audio measurement for rendered takes — the numbers that actually caught
// something during the Zoetrope investigation, kept so they can be re-run.
//
//   node scripts/audio-metrics.mjs bench/take.wav
//   node scripts/audio-metrics.mjs --compare bench/before.wav bench/after.wav
//   node scripts/audio-metrics.mjs bench/take.wav --f0 220 --above 1760
//
// Zero dependencies, no DOM: pure functions over a Float32Array so the same
// code can back a regression test later. See specs/recipes/verify-audio-by-ear.md.
//
// The metrics, and why each one is here:
//
//   bursts        Runs of consecutive samples whose step is far above the local
//                 norm. Splice/discontinuity artefacts show up as SHORT RUNS at
//                 a high rate; this is what exposed the artefact in a user's
//                 recording (~325 bursts/s) when a peak/RMS check saw nothing.
//   energyAbove   Share of energy above a stated bandwidth. Feed a source with
//                 a known harmonic ceiling and anything above it was *generated*
//                 — aliasing, or steps. This is what exposed the `sieve` control.
//   tonality      Energy ON an f0 harmonic comb vs BETWEEN its harmonics. A big
//                 rise means diffuse material was forced onto a pitch, which is
//                 the "buzzy robot" failure mode of cycle splicing.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- WAV decode

/** Decode a RIFF/WAVE file (PCM 16/24/32 or float32) into planar channels. */
export function decodeWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = buf.subarray(pos + 8, pos + 8 + size);
    if (id === 'fmt ') {
      fmt = {
        format: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bits: body.readUInt16LE(14),
      };
    } else if (id === 'data') {
      data = body;
    }
    pos += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk');

  const { channels, bits, format } = fmt;
  const bytes = bits / 8;
  const frames = Math.floor(data.length / (channels * bytes));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const o = (i * channels + c) * bytes;
      let v;
      if (format === 3 && bits === 32) v = data.readFloatLE(o);
      else if (bits === 16) v = data.readInt16LE(o) / 32768;
      else if (bits === 24) v = ((data[o] | (data[o + 1] << 8) | (data[o + 2] << 16)) << 8) / 2147483648;
      else if (bits === 32) v = data.readInt32LE(o) / 2147483648;
      else throw new Error(`unsupported PCM format ${format}/${bits}-bit`);
      out[c][i] = v;
    }
  }
  return { sampleRate: fmt.sampleRate, channels: out, frames };
}

// ------------------------------------------------------------------ metrics

/** Peak, RMS and health counts. */
export function levels(x) {
  let peak = 0;
  let sum = 0;
  let nonFinite = 0;
  let clipped = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!Number.isFinite(v)) { nonFinite++; continue; }
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    if (a >= 0.999) clipped++;
    sum += v * v;
  }
  return { peak, rms: Math.sqrt(sum / (x.length || 1)), nonFinite, clipped };
}

/**
 * Discontinuity bursts. A splice artefact is a *run* of a few samples whose
 * step dwarfs the local norm, repeating at the splice rate — so the run count
 * and rate matter more than any single maximum.
 */
export function bursts(x, sampleRate) {
  const n = x.length;
  if (n < 3) return { threshold: 0, samples: 0, runs: 0, perSecond: 0, longest: 0, maxStep: 0, medianStep: 0 };
  const d = new Float32Array(n - 1);
  for (let i = 1; i < n; i++) d[i - 1] = Math.abs(x[i] - x[i - 1]);
  const sorted = Float32Array.from(d).sort();
  const q = (p) => sorted[Math.floor(p * (sorted.length - 1))];
  const median = q(0.5);
  const threshold = Math.max(median * 12, 0.02);

  let samples = 0;
  let runs = 0;
  let longest = 0;
  let cur = 0;
  for (let i = 0; i < d.length; i++) {
    if (d[i] > threshold) {
      samples++;
      cur++;
      if (cur > longest) longest = cur;
    } else {
      if (cur) runs++;
      cur = 0;
    }
  }
  if (cur) runs++;
  return {
    threshold, samples, runs, longest,
    perSecond: runs / (n / sampleRate),
    maxStep: q(1), medianStep: median,
  };
}

/** Goertzel magnitude-squared of one frequency over a Hann-windowed window. */
function power(win, freq, sampleRate) {
  const w = (2 * Math.PI * freq) / sampleRate;
  const coeff = 2 * Math.cos(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < win.length; i++) {
    s0 = win[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/** Hann-windowed slice from the middle of the take (skips attack + release). */
function window_(x, size = 1 << 14) {
  const n = Math.min(size, x.length);
  const start = Math.max(0, (x.length >> 1) - (n >> 1));
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = x[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

/** Log-spaced spectrum, dB relative to the strongest bin. */
export function spectrum(x, sampleRate, ratio = Math.SQRT2) {
  const win = window_(x);
  const out = [];
  let ref = 0;
  for (let f = 55; f < sampleRate / 2; f *= ratio) {
    const p = Math.sqrt(power(win, f, sampleRate)) / win.length;
    out.push([Math.round(f), p]);
    if (p > ref) ref = p;
  }
  return out.map(([f, p]) => [f, 20 * Math.log10(p / (ref || 1e-30))]);
}

/**
 * Share of energy above `fMin`, in dB. Drive the graph with material of a known
 * harmonic ceiling and everything above it was generated by the processing.
 */
export function energyAbove(x, sampleRate, fMin) {
  const win = window_(x);
  let hi = 0;
  let all = 0;
  for (let f = 55; f < sampleRate / 2; f *= 1.12) {
    const p = power(win, f, sampleRate);
    all += p;
    if (f > fMin) hi += p;
  }
  return 10 * Math.log10(hi / (all || 1e-30) + 1e-30);
}

/** Energy on the f0 harmonic comb vs between its harmonics, in dB. */
export function tonality(x, sampleRate, f0, harmonics = 40) {
  const win = window_(x);
  let on = 0;
  let off = 0;
  for (let k = 1; k <= harmonics; k++) {
    if (k * f0 >= sampleRate / 2) break;
    on += power(win, k * f0, sampleRate);
    off += power(win, (k + 0.5) * f0, sampleRate);
  }
  return 10 * Math.log10((on + 1e-30) / (off + 1e-30));
}

/** Everything, for one mono signal. */
export function analyze(x, sampleRate, { f0 = 0, above = 0 } = {}) {
  return {
    seconds: x.length / sampleRate,
    ...levels(x),
    bursts: bursts(x, sampleRate),
    energyAbove: above > 0 ? energyAbove(x, sampleRate, above) : null,
    tonality: f0 > 0 ? tonality(x, sampleRate, f0) : null,
  };
}

/** Mono down-mix, since these metrics describe the take rather than the image. */
export function mono({ channels }) {
  if (channels.length === 1) return channels[0];
  const [l, r] = channels;
  const out = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) out[i] = (l[i] + r[i]) * 0.5;
  return out;
}

export function load(path) {
  const wav = decodeWav(readFileSync(path));
  return { ...wav, x: mono(wav) };
}

// ---------------------------------------------------------------------- CLI

function fmt(n, w = 8, p = 4) {
  return (typeof n === 'number' ? n.toFixed(p) : String(n)).padStart(w);
}

function report(label, a) {
  console.log(`\n${label}`);
  console.log(`  ${a.seconds.toFixed(2)}s   peak ${fmt(a.peak)}   rms ${fmt(a.rms)}` +
    `   nonFinite ${a.nonFinite}   clipped ${a.clipped}`);
  const b = a.bursts;
  console.log(`  steps: median ${fmt(b.medianStep, 8, 5)}  max ${fmt(b.maxStep, 8, 5)}` +
    `   ratio ${fmt(b.maxStep / (b.medianStep || 1e-9), 7, 0)}x`);
  console.log(`  bursts: ${String(b.runs).padStart(6)}  (${b.perSecond.toFixed(0)}/s)` +
    `   longest run ${b.longest}   over ${b.threshold.toFixed(4)}`);
  if (a.energyAbove !== null) console.log(`  energy above band: ${fmt(a.energyAbove, 8, 1)} dB`);
  if (a.tonality !== null) console.log(`  harmonic-comb dominance: ${fmt(a.tonality, 8, 1)} dB`);
}

function main(argv) {
  const args = argv.slice(2);
  const flag = (name, def = null) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : def;
  };
  const f0 = Number(flag('f0', 0));
  const above = Number(flag('above', 0));
  const showSpectrum = args.includes('--spectrum');

  const cmp = args.indexOf('--compare');
  if (cmp >= 0) {
    const [pa, pb] = [args[cmp + 1], args[cmp + 2]];
    if (!pa || !pb) throw new Error('--compare needs two files');
    const A = load(pa);
    const B = load(pb);
    const a = analyze(A.x, A.sampleRate, { f0, above });
    const b = analyze(B.x, B.sampleRate, { f0, above });
    report(pa, a);
    report(pb, b);
    console.log('\ndelta (B - A)');
    console.log(`  peak ${fmt(b.peak - a.peak)}   rms ${fmt(b.rms - a.rms)}`);
    console.log(`  bursts/s ${fmt(b.bursts.perSecond - a.bursts.perSecond, 8, 0)}` +
      `   maxStep ${fmt(b.bursts.maxStep - a.bursts.maxStep, 8, 5)}`);
    if (a.energyAbove !== null) console.log(`  energy above band ${fmt(b.energyAbove - a.energyAbove, 8, 1)} dB`);
    if (a.tonality !== null) console.log(`  harmonic-comb ${fmt(b.tonality - a.tonality, 8, 1)} dB`);
    return;
  }

  const path = args.find((a) => !a.startsWith('--') && /\.wav$/i.test(a));
  if (!path) {
    console.error('usage: node scripts/audio-metrics.mjs <file.wav> [--f0 220] [--above 1760] [--spectrum]');
    console.error('       node scripts/audio-metrics.mjs --compare <a.wav> <b.wav>');
    process.exitCode = 1;
    return;
  }
  const { x, sampleRate } = load(path);
  report(path, analyze(x, sampleRate, { f0, above }));
  if (showSpectrum) {
    console.log('\n  spectrum (dB rel. peak bin)');
    for (const [f, db] of spectrum(x, sampleRate)) {
      console.log(`  ${String(f).padStart(6)} Hz ${db.toFixed(1).padStart(7)}  ${'#'.repeat(Math.max(0, Math.round((db + 70) / 2)))}`);
    }
  }
}

// `pathToFileURL`, not string-building: a Windows path yields file:///C:/… and a
// hand-rolled `file://` + path never matches.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv);

// Zoetrope — period-locked cycle splicer. VAST G1-J5, last insert on the synth
// chain.
//
// Slices the input at exact cycle boundaries derived from the sounding pitch,
// keeps a rolling library of those cycles, and rebuilds the output by
// concatenating cycles drawn from anywhere in that history — each resampled to
// the current period on the way out. Splices land at matched waveform phase, so
// no windowing is needed and pitch stays exact.
//
// Inputs
//   0  main signal (the synth FX chain output)
//   1  external signal (the drum bus) — recorded with the same cycle
//      boundaries, so its cycles replay at the voice's pitch
//
// Boundary detection has two modes. With `frequency` > 15 the cycle grid is
// derived from the pitch directly (exact, immune to a noisy waveform); with
// `frequency` at 0 it falls back to rising zero crossings. Switching between
// them re-anchors the write cursors — they track a virtual grid that means
// nothing in the other mode, and a stale cursor points into history the ring
// buffer has already overwritten (see `reanchor`).
//
// Cost: the only per-sample work that scales is the sieve's tap average, and it
// is skipped entirely at the default sieve of 0. When it does run, the tap
// indices and their read positions/increments are resolved once per output
// cycle and advanced by addition — never recomputed per sample (ADR-010).
//
// Messages in
//   'clear'                          drop the library (e.g. on note-on)
//   {type:'meter', on:true|false}    enable display telemetry (default OFF)
//   {type:'pattern', values:[...]}   RESERVED — per-step lag table (pattern mode)
//   {type:'step', index:n}           RESERVED — sequencer step (pattern mode)
//
// Messages out (only while metering, and only once the library is non-empty)
//   {type:'cycles', peaks:Float32Array, head:int, lag:int, count:int, hz:number}
//
// `selectMode` / `pattern` / `step` are the reserved pattern-mode surface: the
// DSP honours them, but nothing binds them yet (zoetrope.md REQ-12).

const STORE_SIZE = 1 << 17; // 131072 samples ≈ 2.7 s at 48 kHz
const MAX_CYCLES = 512;
const MAX_TAPS = 16;
const MIN_CYCLE = 24; // shortest accepted cycle, samples (~2 kHz at 48 kHz)
const METER_INTERVAL_BLOCKS = 12; // 12 × 128 frames ≈ 31 Hz at 48 kHz
// Output is a linear combination of stored samples with bounded coefficients,
// so this never engages in normal use — it is the ADR-010 "stable" backstop.
const OUT_CLAMP = 4;

function readInterp(buf, pos) {
  const p = pos % STORE_SIZE;
  const i0 = p | 0;
  const fr = p - i0;
  const i1 = i0 + 1 === STORE_SIZE ? 0 : i0 + 1;
  const a = buf[i0];
  return a + (buf[i1] - a) * fr;
}

class ZoetropeProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Connect the sounding pitch here; 0 selects zero-crossing detection.
      { name: 'frequency', defaultValue: 0, minValue: 0, maxValue: 20000, automationRate: 'a-rate' },
      { name: 'scatter', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'chaos', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'smear', defaultValue: 0.25, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'sieve', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 12, minValue: 1, maxValue: 64, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'freeze', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'source', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'selectMode', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'taps', defaultValue: 8, minValue: 2, maxValue: 16, automationRate: 'k-rate' },
      { name: 'sub', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'xfadeFloor', defaultValue: 16, minValue: 4, maxValue: 256, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();

    // The external store is allocated on the first block that actually carries
    // an input-1 signal, so a Self-only session holds half the memory.
    this.storeA = [new Float32Array(STORE_SIZE), new Float32Array(STORE_SIZE)];
    this.storeB = null;
    this.writePos = 0;

    this.cycStart = new Float64Array(MAX_CYCLES);
    this.cycLen = new Float64Array(MAX_CYCLES);
    this.cycPeak = new Float32Array(MAX_CYCLES);
    this.cycHead = -1;
    this.cycCount = 0;
    this.runPeak = 0;

    // Write side — the boundary detector.
    this.phase = 0;
    this.curStart = 0;
    this.lastCross = 0;
    this.prevIn = 0;
    this.pitched = false; // which detector ran last block

    // Read side — the splicer.
    this.outPhase = 1e9; // forces a cycle start on the first sample
    this.outPeriod = 0;
    this.rd = 0;
    this.rdInc = 1;
    this.pv = 0;
    this.pvInc = 1;
    this.xf = 0;
    this.xfLen = 0;
    this.lastLag = 1;
    this.alt = 0;
    // Alternate-cycle gain (the `sub` octave). Crossfaded like the audio,
    // because a bare polarity flip at the splice is a full-scale step.
    this.curGain = 1;
    this.prevGain = 1;
    this.chaosX = 0.31830988;
    // Running estimate of the zero-crossing cycle length, used to reject the
    // false crossings a polyphonic or bright signal is full of.
    this.zcEst = 0;
    this.zcArmed = false;

    // Sieve taps, resolved once per output cycle (never per sample).
    this.tapPos = new Float64Array(MAX_TAPS);
    this.tapInc = new Float64Array(MAX_TAPS);
    this.tapCount = 0;

    // Reserved for pattern mode (zoetrope.md REQ-12).
    this.pattern = new Int32Array(16).fill(1);
    this.patternLen = 16;
    this.step = 0;

    this.metering = false;
    this.meterBlocks = 0;
    this.meterBuf = new Float32Array(MAX_CYCLES);

    this.port.onmessage = (e) => {
      const d = e.data;
      if (d === 'clear') {
        this.cycCount = 0;
        this.cycHead = -1;
        this.outPhase = 1e9;
        this.tapCount = 0;
        return;
      }
      if (!d || typeof d !== 'object') return;
      if (d.type === 'meter') {
        this.metering = !!d.on;
        this.meterBlocks = 0;
      } else if (d.type === 'pattern' && d.values && d.values.length) {
        const n = Math.min(d.values.length, this.pattern.length);
        for (let i = 0; i < n; i++) this.pattern[i] = Math.max(1, d.values[i] | 0);
        this.patternLen = n;
      } else if (d.type === 'step') {
        this.step = d.index | 0;
      }
    };
  }

  /**
   * Logistic map. r below ~3.57 settles into a short repeating orbit (the
   * playhead visibly bounces between a few fixed cycles); above it the orbit is
   * chaotic. That is the whole point of the `chaos` knob, and it is why the
   * cycle-library display teaches the effect.
   */
  nextRand(chaos) {
    const r = 3.2 + 0.79 * chaos;
    let x = r * this.chaosX * (1 - this.chaosX);
    if (!(x > 0 && x < 1)) x = 0.5; // the map's fixed points are absorbing
    this.chaosX = x;
    return x;
  }

  /**
   * Point the write cursors at the live write head. Called whenever the
   * boundary detector changes mode: `curStart`/`phase` (pitched) and
   * `lastCross` (zero crossing) each track a grid the other mode does not
   * advance, so carrying one across would record cycles whose start points into
   * long-overwritten history.
   */
  reanchor() {
    this.curStart = this.writePos;
    this.lastCross = this.writePos;
    this.phase = 0;
    this.prevIn = 0;
    // The zero-crossing lock describes the mode we are leaving, so re-acquire.
    this.zcEst = 0;
    this.zcArmed = false;
  }

  pushCycle(start, len) {
    this.cycHead = (this.cycHead + 1) % MAX_CYCLES;
    this.cycStart[this.cycHead] = start;
    this.cycLen[this.cycHead] = len;
    this.cycPeak[this.cycHead] = this.runPeak;
    this.runPeak = 0;
    if (this.cycCount < MAX_CYCLES) this.cycCount++;
  }

  /** Ring index of the cycle `lag` back from the head (1 = newest). */
  cycleAt(lag) {
    return (this.cycHead - (lag - 1) + MAX_CYCLES * 2) % MAX_CYCLES;
  }

  /** False once a cycle's samples have been overwritten by the write head. */
  valid(idx) {
    return this.cycStart[idx] >= this.writePos - STORE_SIZE + 8;
  }

  process(inputs, outputs, params) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const inA = inputs[0];
    const nOut = output.length;
    const frames = output[0].length;

    if (!inA || inA.length === 0) {
      for (let c = 0; c < nOut; c++) output[c].fill(0);
      return true;
    }

    const inB = inputs[1] && inputs[1].length ? inputs[1] : null;
    if (inB && !this.storeB) {
      this.storeB = [new Float32Array(STORE_SIZE), new Float32Array(STORE_SIZE)];
    }

    // Hoist the channel arrays — the sample loop must not index them twice per
    // sample through a Math.min (runtime-performance: no per-sample overhead
    // that a block-level hoist removes).
    const aL = inA[0];
    const aR = inA.length > 1 ? inA[1] : aL;
    const bL = inB ? inB[0] : null;
    const bR = inB ? (inB.length > 1 ? inB[1] : bL) : null;

    const freq = params.frequency;
    const freqFixed = freq.length === 1;
    const scatter = params.scatter[0];
    const chaos = params.chaos[0];
    const smear = params.smear[0];
    const sieve = params.sieve[0];
    const depth = params.depth[0] | 0;
    const mix = params.mix[0];
    const frozen = params.freeze[0] > 0.5;
    const usePattern = params.selectMode[0] > 0.5;
    const taps = Math.min(MAX_TAPS, Math.max(2, params.taps[0] | 0));
    const sub = params.sub[0];
    const xfFloor = params.xfadeFloor[0];

    const srcSel = params.source[0] > 0.5 && this.storeB ? 1 : 0;
    const store = srcSel ? this.storeB : this.storeA;
    const readL = store[0];
    const readR = store[1];
    // Peak metering follows whichever source is being recorded, so the library
    // bars describe the audio you are actually hearing back. `bL` can be absent
    // for a block even once storeB exists (input 1 disconnected mid-stream), so
    // the read side keeps its store while the peak falls back to the main input.
    const peakSrc = srcSel && bL ? bL : aL;

    const sieveAmt = sieve < 0 ? -sieve : sieve;
    const sieveOn = sieveAmt > 0.001;
    const residue = sieve > 0;

    const storeAL = this.storeA[0];
    const storeAR = this.storeA[1];
    const writeExt = this.storeB !== null && bL !== null;
    const storeBL = writeExt ? this.storeB[0] : null;
    const storeBR = writeExt ? this.storeB[1] : null;

    const tapPos = this.tapPos;
    const tapInc = this.tapInc;
    // Resolved at the last cycle boundary, which is usually in an earlier block
    // (a cycle at 146 Hz spans ~2.6 blocks) — so this carries in, never resets.
    let tapN = this.tapCount;
    let wasPitched = this.pitched;
    let writePos = this.writePos;
    let runPeak = this.runPeak;
    let outPhase = this.outPhase;
    let outPeriod = this.outPeriod;
    let rd = this.rd;
    let rdInc = this.rdInc;
    let pv = this.pv;
    let pvInc = this.pvInc;
    let xf = this.xf;
    let xfLen = this.xfLen;

    for (let i = 0; i < frames; i++) {
      const f = freqFixed ? freq[0] : freq[i];
      const target = f > 15 ? sampleRate / f : 0;
      const pitched = target > 0;
      if (pitched !== wasPitched) {
        this.writePos = writePos;
        this.reanchor();
        wasPitched = pitched;
      }

      const dryL = aL[i];
      const dryR = aR[i];

      if (!frozen) {
        const w = writePos % STORE_SIZE;
        storeAL[w] = dryL;
        storeAR[w] = dryR;
        if (storeBL) {
          storeBL[w] = bL[i];
          storeBR[w] = bR[i];
        }
        writePos++;

        const s = peakSrc[i];
        const a = s < 0 ? -s : s;
        if (a > runPeak) runPeak = a;

        if (pitched) {
          this.phase += 1;
          if (this.phase >= target) {
            this.runPeak = runPeak;
            this.pushCycle(this.curStart, target);
            runPeak = 0;
            this.curStart += target;
            this.phase -= target;
          }
        } else {
          // Zero-crossing detection, with two guards that matter enormously on
          // real material. Without them a polyphonic or bright signal produces
          // cycle lengths swinging over an order of magnitude (measured 24..250
          // samples on a 3-note chord), and `rdInc` resampling swings with them
          // — which is audible as gritty, incoherent splicing.
          //
          //  1. Hysteresis: the signal must dip below -h before a rising cross
          //     above +h counts, so harmonic wiggles around zero don't trigger.
          //  2. Coherence: a candidate length is only accepted if it is in the
          //     same ballpark as the running estimate, so the detector locks on
          //     to one period instead of chasing every partial.
          const h = runPeak * 0.05;
          if (dryL < -h) this.zcArmed = true;
          if (this.zcArmed && this.prevIn < 0 && dryL >= 0) {
            const len = writePos - this.lastCross;
            if (len > (STORE_SIZE >> 2)) {
              // Stale cursor (a mode change or a long silence) — re-anchor
              // rather than record a cycle spanning overwritten history.
              this.lastCross = writePos;
              this.zcEst = 0;
              this.zcArmed = false;
            } else if (len >= MIN_CYCLE && (this.zcEst === 0 || (len > this.zcEst * 0.6 && len < this.zcEst * 1.7))) {
              this.runPeak = runPeak;
              this.pushCycle(this.lastCross, len);
              runPeak = 0;
              this.lastCross = writePos;
              // Slow EMA: follows a real pitch change within a few cycles but
              // ignores a single rogue measurement.
              this.zcEst = this.zcEst === 0 ? len : this.zcEst * 0.8 + len * 0.2;
              this.zcArmed = false;
            } else if (this.zcEst > 0 && len > this.zcEst * 2.5) {
              // Nothing plausible for a while — the pitch probably moved a long
              // way. Drop the lock and re-acquire from here.
              this.lastCross = writePos;
              this.zcEst = 0;
              this.zcArmed = false;
            }
          }
          this.prevIn = dryL;
        }
      }

      if (this.cycCount < 2) {
        // Nothing to splice yet — pass the input through untouched.
        for (let c = 0; c < nOut; c++) output[c][i] = c === 0 ? dryL : dryR;
        continue;
      }

      if (outPhase >= outPeriod) {
        // ----- New output cycle: choose a source cycle and set up the read -----
        this.writePos = writePos;
        outPeriod = Math.max(MIN_CYCLE, target > 0 ? target : this.cycLen[this.cycHead]);
        outPhase = 0;

        pv = rd;
        pvInc = rdInc;

        let lag = 1;
        const r = this.nextRand(chaos);
        if (usePattern) {
          lag = this.pattern[((this.step % this.patternLen) + this.patternLen) % this.patternLen];
        } else if (scatter > 0 && r < scatter) {
          lag = 1 + Math.floor((r / scatter) * depth);
        }
        const reach = Math.min(this.cycCount, depth);
        lag = Math.max(1, Math.min(lag, reach));

        let idx = this.cycleAt(lag);
        if (!this.valid(idx)) {
          idx = this.cycHead;
          lag = 1;
        }
        this.lastLag = lag;

        rd = this.cycStart[idx];
        rdInc = this.cycLen[idx] / outPeriod;
        xf = 0;
        xfLen = Math.max(xfFloor, Math.min(smear * outPeriod, outPeriod));
        this.alt ^= 1;
        // `sub` gates or inverts alternate cycles. Stepping the gain at the
        // splice is a full-scale discontinuity (measured 44x the artefact rate
        // of a bypassed render), so it rides the same crossfade as the audio.
        this.prevGain = this.curGain;
        this.curGain = this.alt ? 1 : 1 - 2 * sub;

        // Resolve the sieve taps once, here. Positions advance by addition in
        // the sample loop; nothing below recomputes an index.
        tapN = 0;
        if (sieveOn) {
          for (let k = 0; k < taps; k++) {
            if (lag + k > this.cycCount) break;
            const ti = this.cycleAt(lag + k);
            if (!this.valid(ti)) break;
            tapPos[k] = this.cycStart[ti];
            tapInc[k] = this.cycLen[ti] / outPeriod;
            tapN++;
          }
        }
      }

      const blending = xf < xfLen;
      const t = blending ? xf / xfLen : 1;
      const gain = blending ? this.prevGain + (this.curGain - this.prevGain) * t : this.curGain;

      for (let c = 0; c < nOut; c++) {
        const buf = c === 0 ? readL : readR;
        let y = readInterp(buf, rd);
        if (blending) {
          const b = readInterp(buf, pv);
          y = b + (y - b) * t;
        }

        if (tapN > 1) {
          let sum = 0;
          for (let k = 0; k < tapN; k++) sum += readInterp(buf, tapPos[k]);
          const avg = sum / tapN;
          y = residue ? y - avg * sieveAmt : y + (avg - y) * sieveAmt;
        }

        const dry = c === 0 ? dryL : dryR;
        let out = dry + (y * gain - dry) * mix;
        // ADR-010: bounded and finite for any input at any setting.
        out = out > OUT_CLAMP ? OUT_CLAMP : out < -OUT_CLAMP ? -OUT_CLAMP : out === out ? out : 0;
        output[c][i] = out;
      }

      for (let k = 0; k < tapN; k++) tapPos[k] += tapInc[k];
      rd += rdInc;
      pv += pvInc;
      xf++;
      outPhase++;
    }

    this.pitched = wasPitched;
    this.tapCount = tapN;
    this.writePos = writePos;
    this.runPeak = runPeak;
    this.outPhase = outPhase;
    this.outPeriod = outPeriod;
    this.rd = rd;
    this.rdInc = rdInc;
    this.pv = pv;
    this.pvInc = pvInc;
    this.xf = xf;
    this.xfLen = xfLen;

    if (this.metering && ++this.meterBlocks >= METER_INTERVAL_BLOCKS) {
      this.meterBlocks = 0;
      // Only the window `depth` can actually reach into — the library holds up
      // to MAX_CYCLES, but nothing can ever play a cycle older than `depth`, so
      // reporting the rest would be a display of unreachable history (and
      // 512 one-pixel bars). `lag` is clamped to the same window.
      const n = Math.min(this.cycCount, depth);
      if (n > 0) {
        for (let k = 0; k < n; k++) this.meterBuf[k] = this.cycPeak[this.cycleAt(n - k)];
        // A subarray view, structured-cloned by postMessage — never sliced and
        // transferred, so the audio thread allocates nothing per frame.
        this.port.postMessage({
          type: 'cycles',
          peaks: this.meterBuf.subarray(0, n),
          head: this.cycHead,
          lag: this.lastLag,
          count: n,
          hz: outPeriod > 0 ? sampleRate / outPeriod : 0,
        });
      }
    }

    return true;
  }
}

registerProcessor('zoetrope', ZoetropeProcessor);

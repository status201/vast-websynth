// Two selectable 4-pole filter models sharing one processor (ADR-016):
//   model 0 = LADDER — Moog-style, per-stage saturation (ladder-filter.md)
//   model 1 = POLY   — bass-preserving multimode      (filter-models.md)
// The model branch sits OUTSIDE the sample loop, so the ladder's recurrence is
// untouched and its output stays bit-identical to the frozen naive reference.
//
// Cutoff is expressed as a MIDI note number (linear-in-pitch), so envelope/LFO
// modulators can sum in semitones via Web Audio's AudioParam input summation.
//
// Saturation (LADDER): a cheap, bounded, odd-symmetric rational nonlinearity is
// applied at the input *and* at every pole — the transistor-ladder character
// that gives smooth overdrive and self-limiting self-oscillation. `sat'(0) === 1`,
// so at low level / low resonance the response matches the linear ladder
// (existing presets are preserved). The feedback is taken from saturated states
// so the loop is bounded — it cannot run away to NaN regardless of resonance.

// Bounded to ±1, slope 1 at the origin. Cheaper than tanh (no transcendental).
function sat(x) {
  return x / (1 + Math.abs(x));
}

// Make-up gain to offset the passband level lost as resonance rises (LADDER).
const RES_MAKEUP = 0.25;

// POLY's input rail. The LADDER's stages feed back sat(s_n), so at DC
// sat(s_n) === v and the state settles at sat^-1(v) — the cascade *undoes* the
// input saturation, which is why the ladder measures near-unity at low
// frequency despite saturating every stage. POLY's stages are linear, so
// nothing undoes it: sat() at the input would show up directly as level-
// dependent compression, the exact growl POLY exists not to have. So POLY
// saturates against a wider rail — slope 1 at the origin, bounded to ±3, which
// is transparent at instrument levels (~1.5 dB at a 0.5 peak) while `drive`
// still bites hard when pushed (~6 dB at drive 6).
const POLY_HEADROOM = 3;
function satWide(x) {
  return POLY_HEADROOM * sat(x / POLY_HEADROOM);
}

// POLY (filter-models.md REQ-3): resonance compensation as a *pre*-gain on the
// loop input rather than a post-gain on the output. The ladder's closed-loop DC
// gain is 1/(1+res), so a (1 + res*BASS_COMP) pre-gain pins it at 1 — the body
// stays put as the peak rises, instead of sagging under it. 1 is exact unity.
const BASS_COMP = 1;
// Level match against LADDER at the *default* resonance (0.5), so flipping the
// switch is an A/B of character, not of loudness (REQ-10). Above that POLY is
// louder — that is REQ-3 working. Dialled by ear, like RES_MAKEUP (ADR-010).
const POLY_TRIM = 0.85;

// POLY pole-mix anchors (REQ-6), as coefficients over [v, s0, s1, s2, s3].
// Binomial — HP_n is (1 - LP)^n applied to the loop input — so the four stage
// outputs the cascade already computed yield LP24/LP12/BP12/HP24 for ~5 mul.
// Feedback always stays on s3, so the resonant peak tracks cutoff in every mode.
const SHAPE_ANCHORS = [
  [0, 0, 0, 0, 1],    // 0.00  LP24  dark
  [0, 0, 1, 0, 0],    // 0.33  LP12  open
  [0, 2, -2, 0, 0],   // 0.67  BP12  hollow
  [1, -4, 6, -4, 1],  // 1.00  HP24  thin
];

// Resolve the five mix coefficients for a shape position into `out`.
function mixCoeffs(shape, out) {
  const t = (shape < 0 ? 0 : shape > 1 ? 1 : shape) * 3;
  let seg = t | 0;
  if (seg > 2) seg = 2;
  const f = t - seg;
  const a = SHAPE_ANCHORS[seg];
  const b = SHAPE_ANCHORS[seg + 1];
  for (let k = 0; k < 5; k++) out[k] = a[k] + (b[k] - a[k]) * f;
}

// One channel's filter state: 4 pole states + the 4 carried saturations (REQ-12).
// POLY uses slots 0..3 and 7 (the half-sample feedback tap); slots 4..6 are the
// LADDER-only carries, re-primed whenever the model changes (REQ-9).
function newChannelState() {
  return new Float64Array(8);
}

class LadderFilterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'cutoffNote',
        defaultValue: 110,
        minValue: 0,
        maxValue: 135,
        automationRate: 'a-rate',
      },
      {
        name: 'resonance',
        defaultValue: 0,
        minValue: 0,
        maxValue: 4.2,
        automationRate: 'a-rate',
      },
      {
        name: 'drive',
        defaultValue: 1,
        minValue: 0.5,
        maxValue: 8,
        automationRate: 'k-rate',
      },
      // Which model runs (filter-models.md REQ-1). k-rate: the branch is per
      // block, never per sample. Defaults to 0 = LADDER, so a node nobody has
      // told about models behaves exactly as it always did (ADR-006).
      {
        name: 'model',
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate',
      },
      // POLY pole-mix morph (REQ-6). a-rate so the LFO can sum into it and
      // sweep the filter's *type*; ignored entirely by the LADDER path (REQ-7).
      {
        name: 'shape',
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'a-rate',
      },
    ];
  }

  constructor() {
    super();
    // Per-channel state, 8 slots (REQ-12):
    //   0..3  the four pole states s0..s3
    //   4..6  sat(s0), sat(s1), sat(s2) carried from the previous sample
    //   7     sat(s3) from the previous sample — the feedback's half-sample tap
    // The carried saturations are not extra state: each is exactly the value the
    // previous sample already computed, so caching them is a pure speed change.
    // sat(0) === 0, so zeroing the whole array leaves it self-consistent.
    this.state = [newChannelState(), newChannelState()];
    // Idle gating: the voice's oscillators feed us forever and the amp VCA is
    // downstream, so silence detection can never fire — the host posts an
    // explicit active flag instead. Defaults ON so a lost message can only
    // cost CPU, never silence a note. Any step is masked by the closed VCA.
    this.active = true;
    this.port.onmessage = (e) => {
      const on = !!e.data;
      if (!on) {
        // Zero state so reactivation starts from a clean filter.
        for (const s of this.state) if (s) s.fill(0);
      }
      this.active = on;
    };
    // Block-constant cutoff cache (REQ-11): the pole coefficient `g` only
    // depends on the cutoff value, so when a block is all-equal we compute it
    // once and reuse it across blocks until the value changes. NaN forces the
    // first compute.
    this.lastCutoff = NaN;
    this.lastG = 0;
    // Block-constant shape cache (REQ-8), the same trick as the cutoff hoist.
    this.lastShape = NaN;
    this.coef = new Float64Array(5);
    // Scratch for the per-sample fallback when shape is genuinely modulated.
    this.coefScratch = new Float64Array(5);
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    if (!this.active) {
      for (let ch = 0; ch < output.length; ch++) output[ch].fill(0);
      return true;
    }

    const channels = output.length;
    const sr = sampleRate;
    const drive = params.drive[0];
    const cutoffArr = params.cutoffNote;
    const resArr = params.resonance;
    const resStatic = resArr.length === 1;

    // Block-constant cutoff hoist (REQ-11): env + LFO are always wired to
    // cutoffNote, so the host hands us a full 128-length array — but it is
    // all-equal whenever the cutoff is held/unmodulated (the common case). Then
    // the pole coefficient `g` (a Math.pow + Math.exp) is computed once per
    // block and cached across blocks, instead of per sample × channel. Full
    // scan with early exit, so a genuinely modulated block pays ~1 compare and
    // falls back to the per-sample path below.
    const c0 = cutoffArr[0];
    let cutoffConst = true;
    for (let i = 1; i < cutoffArr.length; i++) {
      if (cutoffArr[i] !== c0) { cutoffConst = false; break; }
    }
    let gBlock = 0;
    if (cutoffConst) {
      if (c0 !== this.lastCutoff) {
        this.lastCutoff = c0;
        // MIDI note → Hz (clamped < Nyquist) → one-pole coefficient. Identical
        // expression to the per-sample path, so a constant block is bit-exact.
        const freq = 440 * Math.pow(2, (c0 - 69) / 12);
        const fNorm = Math.min(Math.max(freq / sr, 0.0001), 0.49);
        this.lastG = 1 - Math.exp(-2 * Math.PI * fNorm);
      }
      gBlock = this.lastG;
    }

    // Which model runs this block (filter-models.md REQ-2). One compare per
    // render quantum, never per sample.
    const model = params.model[0] >= 0.5 ? 1 : 0;

    // Block-constant shape hoist (REQ-8), the cutoff hoist's twin: the LFO is
    // permanently connected to `shape`, so a full 128-length array always
    // arrives — all-equal whenever nothing is sweeping it, the common case.
    // Resolved once per block and cached across blocks; a modulated block falls
    // back to the per-sample lerp inside the POLY loop.
    const shapeArr = params.shape;
    const sh0 = shapeArr[0];
    let shapeConst = true;
    for (let i = 1; i < shapeArr.length; i++) {
      if (shapeArr[i] !== sh0) { shapeConst = false; break; }
    }
    const coef = this.coef;
    if (model === 1 && shapeConst && sh0 !== this.lastShape) {
      this.lastShape = sh0;
      mixCoeffs(sh0, coef);
    }

    for (let ch = 0; ch < channels; ch++) {
      const inCh = input && input[ch] ? input[ch] : null;
      const outCh = output[ch];
      let s = this.state[ch];
      if (!s) {
        s = newChannelState();
        this.state[ch] = s;
      }

      // Hoist the state into locals for the sample loop — the carried
      // saturations (q0..q3prev) turn 10 sat() calls per sample into 5 (REQ-12).
      let s0 = s[0], s1 = s[1], s2 = s[2], s3 = s[3];
      let q0 = s[4], q1 = s[5], q2 = s[6], q3prev = s[7];

      if (model === 1) {
        // ---- POLY: bass-preserving multimode (filter-models.md) ----
        // Saturation only at the input and on the feedback tap; the four stages
        // stay linear (REQ-4). Two sat() calls per sample against the ladder's
        // five — the glassier model is also the cheaper one.
        let mv = coef[0], m0 = coef[1], m1 = coef[2], m2 = coef[3], m3 = coef[4];
        const scratch = this.coefScratch;

        for (let i = 0; i < outCh.length; i++) {
          const res = resStatic ? resArr[0] : resArr[i];

          let g;
          if (cutoffConst) {
            g = gBlock;
          } else {
            const freq = 440 * Math.pow(2, (cutoffArr[i] - 69) / 12);
            const fNorm = Math.min(Math.max(freq / sr, 0.0001), 0.49);
            g = 1 - Math.exp(-2 * Math.PI * fNorm);
          }

          // Only when the shape is genuinely being swept (REQ-8).
          if (!shapeConst) {
            mixCoeffs(shapeArr[i], scratch);
            mv = scratch[0]; m0 = scratch[1]; m1 = scratch[2];
            m2 = scratch[3]; m3 = scratch[4];
          }

          const x = inCh ? inCh[i] : 0;

          const q3 = sat(s3);
          const fb = (q3 + q3prev) * 0.5;

          // Drive saturates the input alone (against the wide rail), so
          // resonance behaviour stays independent of it. The (1 + res*BASS_COMP)
          // pre-gain is the bass-preservation trick: it cancels the 1/(1+res)
          // the feedback subtraction would otherwise cost the low end (REQ-3).
          const v = satWide(x * drive) * (1 + res * BASS_COMP) - res * fb;

          s0 += g * (v - s0);
          s1 += g * (s0 - s1);
          s2 += g * (s1 - s2);
          s3 += g * (s2 - s3);
          q3prev = q3;

          // Pole mix (REQ-6). |v| is bounded by (1 + res) + res and the four
          // linear one-poles cannot exceed it, so this stays finite (REQ-5).
          outCh[i] = (mv * v + m0 * s0 + m1 * s1 + m2 * s2 + m3 * s3) * POLY_TRIM;
        }

        // POLY never reads the LADDER-only carries, so they would go stale
        // across a POLY episode. Re-prime them from the pole states once per
        // block, so a switch back to LADDER resumes a self-consistent
        // recurrence (filter-models.md REQ-9). The pole states themselves carry
        // over untouched — they mean the same thing in both models, so the
        // switch is a character crossfade, not a reset.
        q0 = sat(s0); q1 = sat(s1); q2 = sat(s2);
      } else {
        // ---- LADDER: the original recurrence, untouched (ladder-filter.md) ----
        for (let i = 0; i < outCh.length; i++) {
          const res = resStatic ? resArr[0] : resArr[i];

          // One-pole coefficient: hoisted (constant block) or per-sample. MIDI
          // note → Hz, clamped just under Nyquist. Same math either way.
          let g;
          if (cutoffConst) {
            g = gBlock;
          } else {
            const freq = 440 * Math.pow(2, (cutoffArr[i] - 69) / 12);
            const fNorm = Math.min(Math.max(freq / sr, 0.0001), 0.49);
            g = 1 - Math.exp(-2 * Math.PI * fNorm);
          }

          const x = inCh ? inCh[i] : 0;

          // sat(s3) is needed twice — by the feedback tap and by stage 4's own
          // update — so compute it once. The other half of the half-sample tap is
          // last sample's sat(s3) (which is what `s4 = s3` used to hold).
          const q3 = sat(s3);

          // Half-sample feedback delay smooths self-oscillation; taking it from
          // saturated states bounds the loop (|fb| < 1, so it can't run away).
          const fb = (q3 + q3prev) * 0.5;

          // Input drive + saturation, then a saturated one-pole per stage.
          // `v` carries each stage's saturated output into the next stage's input
          // — and that same value is next sample's sat() of this stage's state.
          let v = sat((x - res * fb) * drive);
          s0 += g * (v - q0);
          v = q0 = sat(s0);
          s1 += g * (v - q1);
          v = q1 = sat(s1);
          s2 += g * (v - q2);
          v = q2 = sat(s2);
          s3 += g * (v - q3);
          q3prev = q3;

          // Level compensation as resonance rises (filter loses passband gain)
          outCh[i] = s3 * (1 + res * RES_MAKEUP);
        }
      }

      s[0] = s0; s[1] = s1; s[2] = s2; s[3] = s3;
      s[4] = q0; s[5] = q1; s[6] = q2; s[7] = q3prev;
    }
    return true;
  }
}

registerProcessor('ladder-filter', LadderFilterProcessor);

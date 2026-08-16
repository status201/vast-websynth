const WAVE_TYPES: OscillatorType[] = ['sine', 'triangle', 'sawtooth', 'square'];

/** Index of `square` in WAVE_TYPES — the only wave pulse width applies to. */
const SQUARE = 3;

/** Duty-bank resolution (oscillators.md REQ-6). A full LFO cycle sweeps the bank
 *  up and back, so this caps smoothness at slow rates where the control loop is
 *  no longer the limit. Each entry is one shared `PeriodicWave`. */
export const PWM_BANK_SIZE = 128;
export const PWM_MIN_WIDTH = 0.5;
export const PWM_MAX_WIDTH = 0.95;

/** Harmonics per wave. Enough that the pulse edge stays crisp well below the
 *  lowest musical fundamental; the browser band-limits per octave from here. */
const PWM_HARMONICS = 512;

/**
 * The shared duty bank, scoped to the AudioContext (a `PeriodicWave` is
 * context-bound). All voices index the same waves, so nothing is built per voice.
 *
 * **Sparse: one entry is built the first time that width is used, never the whole
 * bank** (oscillators.md REQ-6b, runtime-performance.md REQ-2). `PWM_BANK_SIZE` is
 * the bank's *resolution*, not a wave count a patch pays for up front — Blink
 * expands each `PeriodicWave` into band-limited wave tables costing ~670 KB of
 * **native** memory, so building all 128 eagerly cost ~86 MB in one synchronous
 * burst, taken the first time any square oscillator's width left 0.5. A patch that
 * parks the width at one index needs exactly one of them.
 *
 * That memory never shows in a heap snapshot (the tables are native, not JS), which
 * is why it went unnoticed; the only signal is the tab's total. Note that
 * `PWM_HARMONICS` is not a lever on it — per-entry cost follows Blink's table size,
 * which is set by the sample rate, not the partial count.
 *
 * A pulse of duty `d` has Fourier cosine amplitudes `(2/(nπ))·sin(nπd)`. Index 0
 * is the DC term, which Web Audio ignores — so the pulse stays centred at every
 * width instead of drifting a DC offset into the filter as it sweeps.
 */
const bankCache = new WeakMap<BaseAudioContext, (PeriodicWave | undefined)[]>();

/** The `PeriodicWave` for bank entry `idx`, built on first use and memoized. */
function dutyWave(ctx: BaseAudioContext, idx: number): PeriodicWave {
  let bank = bankCache.get(ctx);
  if (!bank) {
    bank = new Array<PeriodicWave | undefined>(PWM_BANK_SIZE);
    bankCache.set(ctx, bank);
  }
  const cached = bank[idx];
  if (cached) return cached;

  const d = PWM_MIN_WIDTH + (PWM_MAX_WIDTH - PWM_MIN_WIDTH) * (idx / (PWM_BANK_SIZE - 1));
  const real = new Float32Array(PWM_HARMONICS + 1);
  const imag = new Float32Array(PWM_HARMONICS + 1);
  for (let n = 1; n <= PWM_HARMONICS; n++) {
    real[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * d);
  }
  // Identical construction and arguments to the eager bank it replaces, so the
  // wave reaching `setPeriodicWave` is the same one — only built later.
  const wave = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  bank[idx] = wave;
  return wave;
}

/** Bank index for a width, clamped into range. `0` is an exact square. */
function bankIndex(width: number): number {
  const t = (width - PWM_MIN_WIDTH) / (PWM_MAX_WIDTH - PWM_MIN_WIDTH);
  return Math.max(0, Math.min(PWM_BANK_SIZE - 1, Math.round(t * (PWM_BANK_SIZE - 1))));
}

/**
 * Long-lived oscillator wrapper. OscillatorNode is one-shot, so we start it
 * once and gate audibility downstream via the amp VCA.
 */
export class Osc {
  readonly out: GainNode;
  private readonly osc: OscillatorNode;
  private octave = 0;
  private detuneCents = 0;
  private waveIdx = 2;
  private pulseWidth = PWM_MIN_WIDTH;
  /** The bank entry currently applied, or -1 when the native type is in use.
   *  Lets the control loop call `setPulseWidth` at will and only touch the node
   *  when the duty actually moves to a new entry. */
  private appliedIdx = -1;

  constructor(private readonly ctx: AudioContext) {
    this.osc = ctx.createOscillator();
    this.osc.type = 'sawtooth';
    this.osc.frequency.value = 440;
    this.osc.detune.value = 0;

    this.out = ctx.createGain();
    this.out.gain.value = 0.7;
    this.osc.connect(this.out);
    this.osc.start();
  }

  /** Set carrier frequency. Optional glide via setTargetAtTime.
   *
   *  Non-finite input is dropped rather than written: an `AudioParam` value is a
   *  WebIDL *restricted* float, so `setValueAtTime(Infinity)` throws a TypeError
   *  — and `midiToHz` returns Infinity for a big enough note. Import validation
   *  bounds notes to 0..127 and the clock isolates a throwing listener
   *  (ADR-015); this is the third, cheapest layer, and it keeps a silent note
   *  from becoming an exception in the first place. */
  setFrequency(hz: number, when: number, glideSec: number): void {
    if (!Number.isFinite(hz)) return;
    const f = this.osc.frequency;
    if (glideSec <= 0.001) {
      f.cancelScheduledValues(when);
      f.setValueAtTime(hz, when);
    } else {
      f.cancelScheduledValues(when);
      f.setTargetAtTime(hz, when, glideSec / 3);
    }
  }

  setWave(idx: number): void {
    const i = Math.max(0, Math.min(WAVE_TYPES.length - 1, Math.round(idx)));
    const t = WAVE_TYPES[i];
    if (!t) return;
    this.waveIdx = i;
    // Setting a native type discards any applied PeriodicWave, so the cached
    // bank entry is stale either way.
    this.osc.type = t;
    this.appliedIdx = -1;
    // Re-apply the standing width, so switching *to* square picks up a knob
    // position (or an in-flight PWM sweep) set while another wave was live.
    if (i === SQUARE) this.applyWidth();
  }

  /** Pulse width (duty cycle), `0.5`..`0.95` — `0.5` is a plain square wave.
   *  Ignored unless this oscillator's wave is square (oscillators.md REQ-5).
   *  Called from the PWM control loop at `PWM_CONTROL_HZ`, so it must stay cheap
   *  and do nothing when the duty has not moved to a new bank entry. */
  setPulseWidth(width: number): void {
    if (!Number.isFinite(width)) return;
    this.pulseWidth = Math.max(PWM_MIN_WIDTH, Math.min(PWM_MAX_WIDTH, width));
    if (this.waveIdx === SQUARE) this.applyWidth();
  }

  private applyWidth(): void {
    const idx = bankIndex(this.pulseWidth);
    if (idx === this.appliedIdx) return;
    this.appliedIdx = idx;
    if (idx === 0) {
      // Exactly 50% — the native band-limited square, i.e. the pre-v2 sound.
      this.osc.type = 'square';
      return;
    }
    // Swapping the wave on the *live* node preserves its phase, so a sweep is
    // continuous and never clicks (oscillators.md REQ-6).
    this.osc.setPeriodicWave(dutyWave(this.ctx, idx));
  }

  setOctave(o: number): void {
    this.octave = o;
    this.applyDetune();
  }

  setDetuneCents(c: number): void {
    this.detuneCents = c;
    this.applyDetune();
  }

  setLevel(v: number): void {
    this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  /** The OscillatorNode's detune AudioParam — for connecting LFO / pitch bend. */
  get detuneParam(): AudioParam {
    return this.osc.detune;
  }

  private applyDetune(): void {
    // Octave + fine detune. LFO/pitchBend modulate via separate AudioNode → detune connection.
    const cents = this.octave * 1200 + this.detuneCents;
    this.osc.detune.setTargetAtTime(cents, this.ctx.currentTime, 0.005);
  }
}

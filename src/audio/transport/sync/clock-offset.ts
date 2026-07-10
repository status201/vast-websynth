/**
 * NTP-style clock-offset estimator (pure — no clocks, no `performance`, no RTC).
 *
 * Two WebRTC peers do not share a clock the way two ends of one MIDI cable
 * effectively do, so a message stamped with the *sender's* `performance.now()`
 * means nothing to the receiver until we know the offset between the two
 * clocks. We measure it from ping/pong round-trips:
 *
 *   a   = local time the ping was sent        (T1)
 *   b   = remote time echoed in the pong       (T2 ≈ T3, remote replies at once)
 *   now = local time the pong was received     (T4)
 *   rtt    = now − a
 *   offset = b − (a + rtt/2)      // remote ≈ local + offset
 *
 * Delivery jitter inflates some round-trips, and a high-RTT sample carries a
 * correspondingly wrong offset, so we keep a window of recent RTTs and accept a
 * raw offset into the EMA only when its RTT is within `RTT_GATE ×` the window
 * minimum (lowest-RTT filtering — the same trick NTP uses). 1 Hz sampling then
 * tracks the two devices' `performance.now()` drift over a long session.
 *
 * `toLocal(remoteAtMs)` maps a sender-domain timestamp into the receiver's
 * domain (`remoteAtMs − offset`); the WebRTC transport calls it before handing
 * a message to the sync core, so the core's timing math is transport-agnostic.
 */

const SAMPLE_WINDOW = 16;
const EMA_ALPHA = 0.25;
const RTT_GATE = 1.5;

export interface OffsetSample {
  /** Local send time of the ping (performance.now() ms). */
  a: number;
  /** Remote time echoed in the pong (its performance.now() ms). */
  b: number;
  /** Local receive time of the pong (performance.now() ms). */
  now: number;
}

export interface ClockOffsetEstimatorOptions {
  sampleWindow?: number;
  emaAlpha?: number;
  rttGate?: number;
}

export class ClockOffsetEstimator {
  private readonly sampleWindow: number;
  private readonly emaAlpha: number;
  private readonly rttGate: number;
  /** Recent RTTs, newest last — the min drives lowest-RTT filtering. */
  private rtts: number[] = [];
  private ema: number | null = null;

  constructor(opts?: ClockOffsetEstimatorOptions) {
    this.sampleWindow = opts?.sampleWindow ?? SAMPLE_WINDOW;
    this.emaAlpha = opts?.emaAlpha ?? EMA_ALPHA;
    this.rttGate = opts?.rttGate ?? RTT_GATE;
  }

  addSample({ a, b, now }: OffsetSample): void {
    const rtt = now - a;
    if (rtt < 0) return; // a clock ran backwards / bad sample
    this.rtts.push(rtt);
    if (this.rtts.length > this.sampleWindow) this.rtts.shift();
    const minRtt = Math.min(...this.rtts);
    // Reject samples whose round-trip was noticeably slower than the best seen —
    // their symmetry assumption (T2 ≈ T3) is least trustworthy.
    if (rtt > this.rttGate * minRtt) return;
    const offset = b - (a + rtt / 2);
    this.ema = this.ema === null ? offset : this.ema + this.emaAlpha * (offset - this.ema);
  }

  /** remote ≈ local + offset; null until the first sample is accepted. */
  get offsetMs(): number | null {
    return this.ema;
  }

  /** Convert a sender-domain timestamp into the local domain (identity until warm). */
  toLocal(remoteAtMs: number): number {
    return this.ema === null ? remoteAtMs : remoteAtMs - this.ema;
  }

  reset(): void {
    this.rtts = [];
    this.ema = null;
  }
}

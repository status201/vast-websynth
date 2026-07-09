import type { Clock } from '../clock';
import type { SyncMessage } from './sync-types';

/**
 * Master role: mirror the local transport onto a `SyncTransport`.
 *
 * Hooks `clock.onStart`/`onStop`/`onTick`, so *any* local start/stop (Play
 * button, arp auto-start, recorder, panic) broadcasts — the role is
 * transport-source-agnostic by construction.
 *
 * Pulses: MIDI clock is 24 PPQN = 6 pulses per 16th, but `onTick`'s `when`
 * includes the swing offset on odd 16ths and MIDI clock is *straight*
 * (hardware convention: the slave applies its own shuffle). So we act on
 * **even ticks only** — never swung — and emit 12 pulses spanning two 16ths
 * from the unswung grid time. BPM ramps (e.g. Tape Stop) are still tracked at
 * 8th-note granularity. Pulses ride the look-ahead: `when` is a future
 * AudioContext time, converted to the performance.now() domain via the
 * injected `toPerfMs` so `MIDIOutput.send(data, timestamp)` fires them with
 * hardware timing.
 */
export class SyncMaster {
  private unsubs: Array<() => void> = [];

  constructor(
    private readonly clock: Clock,
    private readonly send: (msg: SyncMessage, atMs?: number) => void,
    private readonly toPerfMs: (audioTime: number) => number,
  ) {}

  enable(): void {
    if (this.unsubs.length) return;
    this.unsubs.push(
      this.clock.onStart(() => this.send({ type: 'start' })),
      this.clock.onStop(() => this.send({ type: 'stop' })),
      this.clock.onTick(this.onTick),
    );
    // Becoming master mid-play: tell slaves to join now (they align to bar 0).
    if (this.clock.playing) this.send({ type: 'start' });
  }

  disable(): void {
    if (!this.unsubs.length) return;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    // Don't leave slaves free-running silently after the role goes away.
    if (this.clock.playing) this.send({ type: 'stop' });
  }

  private onTick = (step: number, when: number): void => {
    if ((step & 1) === 1) return; // odd 16ths may be swung; covered by the even tick
    const pulseS = this.clock.sixteenthDuration() / 6;
    for (let i = 0; i < 12; i++) {
      this.send({ type: 'pulse' }, this.toPerfMs(when + i * pulseS));
    }
  };
}

import { type TickTimer, defaultTickTimer } from './transport/tick-timer';

/**
 * Background audio watchdog — see `specs/features/audio-lifecycle.md` REQ-9..REQ-12.
 *
 * Some devices cannot keep a hidden page's audio thread fed: a Pixel 8a crackles
 * continuously the moment the app is backgrounded (screen off *or* just switched
 * away from), while a Samsung tablet on the same build plays through it fine. A
 * larger buffer, fewer voices, a bounded transport and a registered Media Session
 * all failed to fix it, which points at the OS throttling the renderer — nothing
 * this app can override.
 *
 * What it *can* do is notice, and go quiet instead of crackling. So: while the
 * page is hidden, measure whether the audio is actually breaking up, and suspend
 * the context when it is. **No user-agent check** — gating on "is Android" would
 * have stopped the tablet that works. A device that does not underrun never trips.
 *
 * Two signals, coarse to precise:
 *  - `AudioContext.renderCapacity.underrunRatio` (Chrome 115+) is the audio
 *    thread's own count of quanta that missed their deadline — the crackle itself.
 *  - Audio-clock drift (`ctx.currentTime` vs `performance.now()`) is the fallback,
 *    and the only one that catches a renderer that is not underrunning because it
 *    is not running at all.
 */

/** Sampling window, seconds. Two bad ones in a row trip, so ~1 s to act. */
const SAMPLE_S = 0.5;
/** Fraction of render quanta underrunning that counts as "breaking up". At a
 *  128-frame quantum that is ~4 glitches a second — plainly audible. */
const UNDERRUN_TRIP = 0.01;
/** Audio time must keep up with wall time to at least this ratio. */
const DRIFT_TRIP = 0.9;
/** Consecutive bad windows before acting — one absorbs the hide transition itself. */
const BAD_WINDOWS = 2;

/** The slice of `document` this needs; injectable so jsdom tests can drive it. */
export interface VisibilityDoc {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', fn: () => void): void;
}

export interface WatchdogOptions {
  /** Called once when the audio is measurably breaking up while hidden. */
  onGlitch: () => void;
  /** True while a real-time capture must not be interrupted (REQ-11). */
  isBusy?: () => boolean;
  doc?: VisibilityDoc;
  /** Sampling wakeups; worker-backed by default so throttling cannot blind it. */
  timer?: TickTimer;
  now?: () => number;
}

/** What the Debug panel renders (audio-lifecycle.md REQ-12). */
export interface WatchdogDiagnostics {
  /** Whether `renderCapacity` exists here — false means drift-only. */
  supported: boolean;
  /** True while the page is hidden and the context is being watched. */
  watching: boolean;
  /** Last window's underrun ratio (0 when unsupported/idle). */
  underrunRatio: number;
  /** Worst underrun ratio seen this session — survives the return to foreground. */
  worstUnderrunRatio: number;
  /** Last window's audio-time / wall-time ratio (1 = keeping up). */
  driftRatio: number;
  /** How many times the watchdog has suspended the context this session. */
  suspensions: number;
}

export class BackgroundAudioWatchdog {
  private readonly doc: VisibilityDoc | null;
  private readonly timer: TickTimer;
  private readonly now: () => number;
  private readonly isBusy: () => boolean;

  private watching = false;
  private badWindows = 0;
  /** Wall/audio baseline for the drift window. */
  private wall0 = 0;
  private audio0 = 0;
  private lastUnderrun = 0;
  private worstUnderrun = 0;
  private lastDrift = 1;
  private suspensions = 0;

  constructor(private readonly ctx: AudioContext, private readonly opts: WatchdogOptions) {
    this.doc = opts.doc ?? (typeof document !== 'undefined' ? document : null);
    // Lazy by construction: the WorkerTimer spawns its worker on first start(),
    // so a session that is never backgrounded pays nothing for this.
    this.timer = opts.timer ?? defaultTickTimer();
    this.now = opts.now ?? (() => performance.now());
    this.isBusy = opts.isBusy ?? (() => false);
  }

  /** Begin following the page's visibility. Call once, after the graph exists. */
  start(): void {
    this.doc?.addEventListener('visibilitychange', () => {
      if (this.doc?.hidden) this.beginWatch();
      else this.endWatch();
    });
  }

  get diagnostics(): WatchdogDiagnostics {
    return {
      supported: !!this.ctx.renderCapacity,
      watching: this.watching,
      underrunRatio: this.lastUnderrun,
      worstUnderrunRatio: this.worstUnderrun,
      driftRatio: this.lastDrift,
      suspensions: this.suspensions,
    };
  }

  private beginWatch(): void {
    // Nothing to measure on a context that is not rendering: if the OS suspended
    // it, the foreground re-arm is what brings it back (audio-lifecycle REQ-4).
    if (this.watching || this.ctx.state !== 'running') return;
    this.watching = true;
    this.badWindows = 0;
    this.rebase();
    this.ctx.renderCapacity?.addEventListener('update', this.onCapacity);
    this.ctx.renderCapacity?.start({ updateInterval: SAMPLE_S });
    this.timer.start(this.onSample, SAMPLE_S * 1000);
  }

  private endWatch(): void {
    if (!this.watching) return;
    this.watching = false;
    this.badWindows = 0;
    this.timer.stop();
    this.ctx.renderCapacity?.stop();
    this.ctx.renderCapacity?.removeEventListener('update', this.onCapacity);
  }

  private rebase(): void {
    this.wall0 = this.now();
    this.audio0 = this.ctx.currentTime;
  }

  /**
   * The precise signal. `underrunRatio` is reported per window by the audio
   * thread itself, so a bad window here is not an inference — it is a count of
   * deadlines missed.
   */
  private onCapacity = (e: AudioRenderCapacityEvent): void => {
    if (!this.watching) return;
    this.lastUnderrun = e.underrunRatio;
    if (e.underrunRatio > this.worstUnderrun) this.worstUnderrun = e.underrunRatio;
    this.judge(e.underrunRatio > UNDERRUN_TRIP);
  };

  /**
   * The fallback, and the only signal that catches a renderer which is not
   * underrunning because it has stopped running: audio time that cannot keep up
   * with wall time. Deliberately measured across whatever gap the wakeup
   * actually had — a throttled wakeup an entire minute late is itself the
   * evidence, as long as both clocks are read over the same span.
   */
  private onSample = (): void => {
    if (!this.watching) return;
    // A context the OS suspended under us has nothing to measure or to suspend.
    if (this.ctx.state !== 'running') { this.endWatch(); return; }
    const wall = (this.now() - this.wall0) / 1000;
    if (wall < SAMPLE_S) return; // too short a span to judge
    const audio = this.ctx.currentTime - this.audio0;
    this.lastDrift = wall > 0 ? audio / wall : 1;
    this.rebase();
    // With renderCapacity present, drift only escalates a window that signal
    // cannot see at all (a frozen thread reports no updates, so no underruns).
    this.judge(this.lastDrift < DRIFT_TRIP);
  };

  /** Two bad windows in a row is the trip; anything clean resets the count. */
  private judge(bad: boolean): void {
    if (!bad) { this.badWindows = 0; return; }
    // A capture is recording the live output in real time — suspending mid-take
    // truncates the file, which is worse than a damaged one (REQ-11).
    if (this.isBusy()) return;
    if (++this.badWindows < BAD_WINDOWS) return;
    this.endWatch();
    this.suspensions++;
    this.opts.onGlitch();
  }
}

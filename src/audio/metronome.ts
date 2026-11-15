/**
 * A beat source plus an optional click, for recording against the tempo
 * (specs/features/metronome.md).
 *
 * While the transport plays, beats are the clock's own ticks that land on a
 * beat (REQ-beats-follow-the-transport-while-playing). While it is stopped, a
 * small look-ahead timer keeps time on its own at the current BPM
 * (REQ-beats-run-free-while-stopped), continuing from the last transport beat so
 * stopping the song does not jolt the light. It only ever READS the clock.
 *
 * The click goes straight to `ctx.destination` — never the master bus — so no
 * export, master recording or render can contain it
 * (REQ-the-click-is-outside-the-master-bus).
 *
 * Nothing runs until something `acquire()`s it, and the last release takes
 * every timer and subscription with it (REQ-a-metronome-runs-only-while-held).
 * It is imported by the sample studio's lazy chunk only, so it costs nothing at
 * boot.
 */

/** The narrow view of the transport clock the metronome reads. */
export interface MetronomeClock {
  readonly playing: boolean;
  sixteenthDuration(): number;
  onTick(fn: (step: number, when: number) => void): () => void;
  onStart(fn: () => void): () => void;
  onStop(fn: () => void): () => void;
}

export interface MetronomeHost {
  readonly ctx: {
    readonly currentTime: number;
    readonly destination: AudioNode;
    createOscillator(): OscillatorNode;
    createGain(): GainNode;
  };
  readonly clock: MetronomeClock;
  /** Bar length in 16th ticks (meter.md REQ-bar-ticks-is-the-arrangement-bar-line). */
  readonly barTicks: number;
  /** Beat length in 16th ticks. */
  readonly beatTicks: number;
}

/** One beat, handed out when scheduled — up to the look-ahead before `when`. */
export interface Beat {
  /** Audio-context time the beat sounds at. */
  when: number;
  downbeat: boolean;
  /** Beat within its bar, 0-based. */
  index: number;
  /** Whether the transport produced it (else the free run did). */
  playing: boolean;
}

export interface Metronome {
  /** Hold the metronome running; returns its release (idempotent). */
  acquire(): () => void;
  /** The audible click. Off by default. */
  readonly click: boolean;
  setClick(on: boolean): void;
  onBeat(fn: (b: Beat) => void): () => void;
  /**
   * Start a one-bar count and return the audio time of the downbeat a take
   * should start on. The click sounds for every beat before it, whatever
   * `setClick` says (REQ-a-count-in-forces-the-click).
   */
  countIn(): number;
  /** End a count early: no more forced clicks. */
  cancelCountIn(): void;
  /** One beat in seconds at the current tempo and meter. */
  beatDuration(): number;
}

/** How often the free run wakes, and how far ahead it schedules. The clock's own numbers. */
const POLL_MS = 25;
const LOOKAHEAD_S = 0.1;
/** Where a fresh free run (or a stopped count-in) puts its first beat. */
const LEAD_S = 0.1;
/** The click: a short sine blip, a fifth higher on the downbeat. */
const CLICK_LEVEL = 0.28;
const CLICK_DECAY_S = 0.04;
const FREQ_DOWNBEAT = 1760;
const FREQ_BEAT = 1175;

interface PendingClick {
  when: number;
  forced: boolean;
  osc: OscillatorNode;
  gain: GainNode;
}

export function createMetronome(host: MetronomeHost): Metronome {
  const { ctx, clock } = host;
  const listeners = new Set<(b: Beat) => void>();
  const pending = new Set<PendingClick>();

  let holds = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let unsubs: Array<() => void> = [];
  let click = false;
  /** Beats strictly before this time click regardless of `click`. */
  let forceUntil = -Infinity;

  /** The free run's next beat. */
  let nextWhen = 0;
  let nextIndex = 0;
  /** The newest beats handed out — where a free run finds the last one heard. */
  const recent: Beat[] = [];
  /** The newest transport tick that landed on a beat — never a swung step, so
   *  extrapolating a downbeat from it is exact. */
  let lastBeatTick: { step: number; when: number } | null = null;

  const beatTicks = (): number => Math.max(1, Math.round(host.beatTicks));
  const beatsPerBar = (): number => Math.max(1, Math.round(host.barTicks / beatTicks()));
  const beatDur = (): number => beatTicks() * clock.sixteenthDuration();

  const scheduleClick = (b: Beat, forced: boolean): void => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = b.downbeat ? FREQ_DOWNBEAT : FREQ_BEAT;
    // Anchored on the beat itself, never a cancel: the envelope is written
    // once, ahead of time, into a node that lives for this one click.
    gain.gain.setValueAtTime(0, b.when);
    gain.gain.linearRampToValueAtTime(b.downbeat ? CLICK_LEVEL : CLICK_LEVEL * 0.7, b.when + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, b.when + CLICK_DECAY_S);
    osc.connect(gain);
    gain.connect(ctx.destination);
    const rec: PendingClick = { when: b.when, forced, osc, gain };
    pending.add(rec);
    osc.onended = (): void => {
      pending.delete(rec);
      try { osc.disconnect(); } catch { /* already */ }
      try { gain.disconnect(); } catch { /* already */ }
    };
    osc.start(b.when);
    osc.stop(b.when + CLICK_DECAY_S + 0.01);
  };

  /** Silence clicks not yet heard. `keepForced`: leave a running count alone. */
  const dropFutureClicks = (keepForced: boolean): void => {
    const now = ctx.currentTime;
    for (const rec of [...pending]) {
      if (rec.when <= now || (keepForced && rec.forced)) continue;
      pending.delete(rec);
      try { rec.osc.stop(); } catch { /* not started yet is fine on some engines */ }
      try { rec.osc.disconnect(); } catch { /* already */ }
      try { rec.gain.disconnect(); } catch { /* already */ }
    }
  };

  const emit = (b: Beat): void => {
    recent.push(b);
    if (recent.length > 16) recent.shift();
    const forced = b.when < forceUntil;
    if (click || forced) scheduleClick(b, forced && !click);
    for (const fn of listeners) {
      try { fn(b); } catch { /* a display may not stop the beat */ }
    }
  };

  // ---- free run (REQ-beats-run-free-while-stopped) ----

  const pump = (): void => {
    const now = ctx.currentTime;
    const dur = beatDur();
    if (!(dur > 0)) return;
    // A throttled tab can wake late: skip what is already past rather than
    // firing a burst of stale beats at once.
    while (nextWhen < now - 0.05) {
      nextWhen += dur;
      nextIndex = (nextIndex + 1) % beatsPerBar();
    }
    const horizon = now + LOOKAHEAD_S;
    while (nextWhen < horizon) {
      emit({ when: nextWhen, downbeat: nextIndex === 0, index: nextIndex, playing: false });
      nextIndex = (nextIndex + 1) % beatsPerBar();
      nextWhen += beatDur();
    }
  };

  const startFreeRun = (): void => {
    const now = ctx.currentTime;
    // Continue from the newest beat already HEARD — one handed out ahead of a
    // stop never sounded, so it is no phase to continue from.
    const heard = [...recent].reverse().find((b) => b.when <= now) ?? null;
    if (heard) {
      nextWhen = heard.when + beatDur();
      nextIndex = (heard.index + 1) % beatsPerBar();
    } else {
      nextWhen = now + LEAD_S;
      nextIndex = 0;
    }
    clearInterval(timer);
    timer = setInterval(pump, POLL_MS);
    pump();
  };

  const stopFreeRun = (): void => {
    clearInterval(timer);
    timer = undefined;
  };

  // ---- following the transport (REQ-beats-follow-the-transport-while-playing) ----

  const onTick = (step: number, when: number): void => {
    const bt = beatTicks();
    if (step % bt !== 0) return;
    lastBeatTick = { step, when };
    const bar = Math.max(1, Math.round(host.barTicks));
    emit({
      when,
      downbeat: step % bar === 0,
      index: Math.floor((step % bar) / bt),
      playing: true,
    });
  };

  const onStart = (): void => {
    stopFreeRun();
    // Free-run clicks already scheduled ahead would double the transport's beat.
    dropFutureClicks(false);
    recent.length = 0;
  };

  const onStop = (): void => {
    lastBeatTick = null;
    dropFutureClicks(false);
    if (holds > 0) startFreeRun();
  };

  const startAll = (): void => {
    unsubs = [clock.onTick(onTick), clock.onStart(onStart), clock.onStop(onStop)];
    if (!clock.playing) startFreeRun();
  };

  const stopAll = (): void => {
    for (const u of unsubs) u();
    unsubs = [];
    stopFreeRun();
    forceUntil = -Infinity;
    dropFutureClicks(false);
    recent.length = 0;
    lastBeatTick = null;
  };

  return {
    acquire(): () => void {
      holds++;
      if (holds === 1) startAll();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds--;
        if (holds === 0) stopAll();
      };
    },

    get click(): boolean { return click; },

    setClick(on: boolean): void {
      click = on;
      if (!on) dropFutureClicks(true);
    },

    onBeat(fn: (b: Beat) => void): () => void {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },

    countIn(): number {
      const now = ctx.currentTime;
      const dur = beatDur();
      const bpb = beatsPerBar();
      let downbeat: number;
      if (clock.playing && lastBeatTick) {
        // The next transport downbeat at least one beat away, extrapolated
        // from the newest beat tick at the current tempo.
        const sd = clock.sixteenthDuration();
        const bar = Math.max(1, Math.round(host.barTicks));
        let step = (Math.floor(lastBeatTick.step / bar) + 1) * bar;
        downbeat = lastBeatTick.when + (step - lastBeatTick.step) * sd;
        while (downbeat - now < dur) {
          step += bar;
          downbeat += bar * sd;
        }
      } else {
        // Stopped: restart the free run so the counted bar starts now.
        if (holds > 0 && !clock.playing) {
          dropFutureClicks(false);
          // The old phase's beats handed out ahead are void now.
          for (let i = recent.length - 1; i >= 0; i--) {
            if (recent[i]!.when > now) recent.splice(i, 1);
          }
          nextWhen = now + LEAD_S;
          nextIndex = 0;
        }
        downbeat = now + LEAD_S + bpb * dur;
      }
      // Half a beat short of the downbeat, so float error can never let the
      // downbeat itself count as a count beat.
      forceUntil = downbeat - dur / 2;
      // Beats already handed out inside the look-ahead missed their click.
      if (!click) {
        for (const b of recent) {
          if (b.when > now && b.when < forceUntil) scheduleClick(b, true);
        }
      }
      if (!clock.playing && holds > 0) pump();
      return downbeat;
    },

    cancelCountIn(): void {
      forceUntil = -Infinity;
      if (!click) dropFutureClicks(false);
    },

    beatDuration: beatDur,
  };
}

/** Exposed for tests: the scheduling constants. */
export const METRONOME_TIMING = { POLL_MS, LOOKAHEAD_S, LEAD_S } as const;

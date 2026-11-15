/**
 * The sample studio's transport strip (sample-recorder.md
 * REQ-the-transport-is-in-reach): Play/Stop, the beat light, the BPM and the
 * metronome's CLICK.
 *
 * Play is the header's own button, reached through `toggleTransport`
 * (transport-window.md REQ-play-pause-is-not-a-second-truth) — this strip never
 * starts the clock itself. The beat light paints each beat when it is HEARD
 * (transport-position.md REQ-the-playhead-is-drawn-when-it-is-heard), and hands
 * the same moment to `onHeardBeat` listeners, so a count-in display stays in
 * step with the light rather than with the scheduler.
 *
 * It owns its subscriptions; `destroy()` takes every one of them off.
 */
import recStyles from '../styles/record-sound.module.css';
import type { StudioApi } from '../studio-api';
import type { Beat, Metronome } from '../../audio/metronome';
import { audibleTimeline } from '../audible';
import { createButton } from './button';
import { UI_ICONS } from './ui-icons';

export interface StudioTransportOptions {
  engine: StudioApi;
  metronome: Metronome;
  /** The header's Play — the only way this strip moves the transport. */
  toggleTransport: () => void;
  /** Told when the user flips CLICK, so the studio can remember the choice. */
  onClickChange?: (on: boolean) => void;
}

export interface StudioTransport {
  readonly el: HTMLElement;
  /** Called with every beat at the moment it is heard. Returns an unsubscribe. */
  onHeardBeat(fn: (b: Beat) => void): () => void;
  destroy(): void;
}

/** How long the beat light stays lit. */
const FLASH_MS = 110;

export function createStudioTransport(opts: StudioTransportOptions): StudioTransport {
  const { engine, metronome } = opts;
  const heard = new Set<(b: Beat) => void>();
  const offs: Array<() => void> = [];
  let destroyed = false;

  const el = document.createElement('div');
  el.className = recStyles.transport!;

  const play = createButton({ label: 'Play', iconBefore: UI_ICONS.play, testId: 'rec-transport-toggle' });
  play.title = 'Start or stop the song — the header’s own Play';
  play.addEventListener('click', () => opts.toggleTransport());

  const led = document.createElement('span');
  led.className = recStyles.led!;
  led.dataset.testid = 'rec-beat-led';
  led.setAttribute('aria-hidden', 'true');

  const bpm = document.createElement('span');
  bpm.className = recStyles.bpm!;
  bpm.dataset.testid = 'rec-bpm';

  const click = createButton({ label: 'Click', led: true, testId: 'rec-click' });
  click.title = 'Metronome click at the song’s tempo. Never part of an export.';
  el.append(play, led, bpm, click);

  const showBpm = (): void => { bpm.textContent = `${Math.round(engine.clock.bpm)} BPM`; };

  /** Play's face follows the transport: ▶ Play, or ■ Stop while it runs. */
  const syncPlay = (): void => {
    const playing = engine.clock.playing;
    play.classList.toggle('on', playing);
    play.innerHTML = (playing ? UI_ICONS.stop : UI_ICONS.play)
      + `<span class="icon-label">${playing ? 'Stop' : 'Play'}</span>`;
    showBpm();
  };
  offs.push(engine.clock.onStart(syncPlay), engine.clock.onStop(syncPlay));
  syncPlay();

  const syncClick = (): void => {
    click.classList.toggle('on', metronome.click);
    click.setAttribute('aria-pressed', String(metronome.click));
  };
  click.addEventListener('click', () => {
    metronome.setClick(!metronome.click);
    syncClick();
    opts.onClickChange?.(metronome.click);
  });
  syncClick();

  const FLASH = [recStyles.ledPlay!, recStyles.ledFree!, recStyles.ledDown!];
  let ledTimer = 0;
  const audible = audibleTimeline(engine);
  offs.push(metronome.onBeat((b) => {
    audible.at(b.when, () => {
      if (destroyed) return;
      led.classList.remove(...FLASH);
      // Restart the flash even when beats are closer than its decay.
      void led.offsetWidth;
      led.classList.add(b.playing ? recStyles.ledPlay! : recStyles.ledFree!);
      if (b.downbeat) led.classList.add(recStyles.ledDown!);
      led.dataset.beat = String(b.index + 1);
      window.clearTimeout(ledTimer);
      ledTimer = window.setTimeout(() => led.classList.remove(...FLASH), FLASH_MS);
      showBpm();
      for (const fn of heard) fn(b);
    });
  }));

  return {
    el,
    onHeardBeat(fn: (b: Beat) => void): () => void {
      heard.add(fn);
      return () => { heard.delete(fn); };
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      for (const off of offs) off();
      offs.length = 0;
      heard.clear();
      window.clearTimeout(ledTimer);
    },
  };
}

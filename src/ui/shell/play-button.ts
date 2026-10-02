import type { ShellDeps } from './deps';
import { demoNames } from '../../state/song';
import { anythingToPlay } from '../../audio/transport/anything-to-play';
import { createButton, setButtonLabel } from '../components/button';
import { openEmptyPlayModal, emptyPlayHintDismissed } from '../components/empty-play-modal';
import switchStyles from '../styles/switch.module.css';
import headerStyles from '../styles/header.module.css';

/**
 * The header's Play/Stop button and the LED state machine it wears
 * (play-button-blink.md): red and blinking with the beat while playing; a slow
 * orange "attract" pulse while stopped, escalated to a fast green cue once
 * something silent has been armed (a demo loaded, a step machine switched on).
 *
 * Binds `bridge.toggleTransport` (Space, the tour) and `bridge.cuePlay`, so it
 * must be built before anything calls either.
 */
export function createPlayButton(
  { engine, bus, bridge }: Pick<ShellDeps, 'engine' | 'bus' | 'bridge'>,
  loadDemo: (name: string) => Promise<void>,
): HTMLButtonElement {
  const playBtn = createButton({
    label: 'Play',
    className: `${switchStyles.root!} ${headerStyles.playBtn!}`,
    led: true,
    testId: 'transport-play',
    onClick: () => {
      // Starting an all-silent transport helps nobody — explain instead
      // (empty-play-hint.md REQ-play-on-empty-shows-the-hint). Stops are never intercepted, nor is a
      // sync master/slave (an empty clock legitimately drives external gear).
      if (!engine.clock.playing
        && !emptyPlayHintDismissed()
        && engine.sync.activeMode === 'off'
        && !anythingToPlay((id) => bus.get(id), engine.patterns, engine.arrangement, engine.sampler.buffers)) {
        openEmptyPlayModal({
          // Awaited: all but the built-in demo are fetched (song-mode.md
          // REQ-drop-in-demos-are-fetched-on-click), and the re-entry below re-runs the has-anything-to-play
          // check — clicking Play before the song lands just reopens this modal.
          onPlayDemo: async () => {
            const names = demoNames();
            await loadDemo(names[Math.floor(Math.random() * names.length)]!);
            playBtn.click(); // re-entry: the demo gives the check something to play
          },
        });
        return;
      }
      engine.clock.toggle();
      syncPlay();
    },
  });
  // Reflect the clock state so Panic/Esc (which stop the transport
  // directly) and the Space-bar shortcut all keep the button in sync.
  const syncPlay = () => {
    const playing = engine.clock.playing;
    playBtn.classList.toggle('on', playing); // keeps `on` global state class for :global(.on) selectors in CSS

    setButtonLabel(playBtn, playing ? 'Stop' : 'Play');
  };
  engine.clock.onStart(syncPlay);
  engine.clock.onStop(syncPlay);

  // --- Play-button LED blink (specs/features/play-button-blink.md) ---
  // Playing: red, blinking with the beat. Stopped: a slow orange "attract"
  // pulse so the transport is discoverable; loading a demo escalates it to a
  // fast green cue until playback starts.
  let blinkVisible = true;

  const setBlink = (v: boolean) => {
    blinkVisible = v;
    playBtn.classList.toggle('blink', !v);
  };

  engine.clock.onTick((step) => {
    const nb = (step & 3) < 2;
    if (nb !== blinkVisible) setBlink(nb);
  });

  let cueArmed = false;
  const refreshIdleBlink = () => {
    const stopped = !engine.clock.playing;
    playBtn.classList.toggle('attract', stopped && !cueArmed);
    playBtn.classList.toggle('cue', stopped && cueArmed);
  };
  engine.clock.onStart(() => { setBlink(true); cueArmed = false; refreshIdleBlink(); });
  engine.clock.onStop(() => { setBlink(true); refreshIdleBlink(); });
  bridge.cuePlay = () => {
    if (engine.clock.playing) return; // already audible — nothing to nudge
    cueArmed = true;
    refreshIdleBlink();
  };
  // Turning a step machine on is silent until Play, so it cues too (REQ-silent-actions-arm-a-green-cue).
  // Listening on the bus catches every surface (panel switch, song apply,
  // author-dialect auto-enable). The arp is excluded: it auto-starts the
  // transport on a held key, so there is no silent dead-end.
  for (const id of ['seq.on', 'drum.on', 'sampler.on']) {
    bus.subscribe(id, (v) => { if (v >= 0.5) bridge.cuePlay(); });
  }
  refreshIdleBlink();

  bridge.toggleTransport = () => playBtn.click();
  return playBtn;
}

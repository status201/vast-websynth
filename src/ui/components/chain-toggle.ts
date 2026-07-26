import type { ChainLane } from '../../audio/transport/arrangement';
import switchStyles from '../styles/switch.module.css';

export interface ChainToggleOpts {
  /** The lane whose `enabled` flag this button reflects and flips. */
  getLane(): ChainLane;
  setChain(steps: number[], enabled: boolean): void;
  /** Enabling a chain is silent until Play, so nudge the Play LED. */
  cuePlay(): void;
  testId: string;
  /** Extra class for the host's sizing (the Song panel's cramped lane cards
   *  pass their compact `.ctl`; the machine headers want the default switch
   *  size, matching the Mute/Solo switches beside them). */
  className?: string;
}

export interface ChainToggle {
  readonly el: HTMLButtonElement;
  /** Re-read `lane.enabled` and repaint the LED. */
  refresh(): void;
}

/**
 * The **Chain** on/off button — one implementation behind both the Song tab's
 * lane cards and the machine headers (machine-status.md REQ-9), so the two can
 * never drift in behaviour, state or looks. It is a switch-styled button rather
 * than a `Switch` because a chain's enabled flag lives on `Arrangement`, not on
 * `ParamBus`: it is part of the song's arrangement, not a scalar param.
 */
export function createChainToggle(opts: ChainToggleOpts): ChainToggle {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = opts.className
    ? `${switchStyles.root!} ${opts.className}`
    : switchStyles.root!;
  el.dataset.testid = opts.testId;
  el.title = 'Play this machine\'s banks as a chain, one per bar';
  el.innerHTML =
    `<span class="${switchStyles.led!}"></span>` +
    `<span class="${switchStyles.label!} switch-label">Chain</span>`;
  el.addEventListener('click', () => {
    const lane = opts.getLane();
    if (!lane.enabled) opts.cuePlay(); // enabling is silent until Play
    opts.setChain([...lane.steps], !lane.enabled);
  });

  const refresh = (): void => {
    el.classList.toggle('on', opts.getLane().enabled);
  };
  refresh();
  return { el, refresh };
}

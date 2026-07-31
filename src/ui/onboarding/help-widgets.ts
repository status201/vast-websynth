// Dynamic bodies for the ⓘ info badges: the BPM-aware "sweet spots" list
// (click a note value to snap the knob) and the mutual-dependency explainers
// (live derived numbers). Kept out of help-content.ts so that file stays a flat
// copy deck; imported there by value, and only the HelpContext *type* comes back
// the other way — no runtime import cycle.
import type { HelpContext } from './help-content';
import { sweetSpotsInRange, spotValue, noteToHz, type TempoQuantity } from './tempo-sync';
import styles from '../styles/tour.module.css';

const BPM_ID = 'transport.bpm';

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  html?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html !== undefined) node.innerHTML = html;
  return node;
};

/** kHz above 1000, else whole Hz. */
function fmtHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${hz.toFixed(0)} Hz`;
}

/** A sweet-spot's value formatted for its button: ms/s for time, Hz for rate. */
function fmtSpot(seconds: number, hz: number, quantity: TempoQuantity): string {
  if (quantity === 'time') {
    return seconds >= 1 ? `${seconds.toFixed(2)} s` : `${Math.round(seconds * 1000)} ms`;
  }
  return `${hz.toFixed(2)} Hz`;
}

/** Testid-safe slug for a division label ("1/8 D" → "18D"). */
const slug = (label: string): string => label.replace(/[^\w]/g, '');

/**
 * The BPM-synced "sweet spots" list for a tempo knob. Reads the live
 * `transport.bpm` and the knob's range, lists the in-range note divisions, and
 * snaps the knob (then closes) when one is clicked.
 */
export function renderTempoSync(
  ctx: HelpContext,
  paramId: string,
  quantity: TempoQuantity,
): HTMLElement {
  const { bus, close } = ctx;
  const bpm = bus.get(BPM_ID);
  const def = bus.def(paramId);
  const min = def?.min ?? 0;
  const max = def?.max ?? Number.POSITIVE_INFINITY;

  const wrap = el('div');
  wrap.appendChild(
    el(
      'p',
      undefined,
      quantity === 'time'
        ? `Sync the echo to the beat. At <strong>${Math.round(bpm)} BPM</strong> these note ` +
            `lengths line up in time — tap one to set <strong>${def ? labelOf(paramId) : 'the delay'}</strong> exactly.`
        : `Match the movement to the beat. At <strong>${Math.round(bpm)} BPM</strong> these note ` +
            `values give an in-time rate — tap one to set it.`,
    ),
  );

  const spots = sweetSpotsInRange(bpm, min, max, quantity);
  const current = bus.get(paramId);

  // Mark the row nearest the current value, but only if it is genuinely on a
  // sweet spot (within 1%), so a free-dialled value doesn't light a random row.
  let nearest = '';
  let best = Number.POSITIVE_INFINITY;
  for (const s of spots) {
    const d = Math.abs(spotValue(s, quantity) - current);
    if (d < best) {
      best = d;
      nearest = s.label;
    }
  }
  const currentIsSpot = best / Math.max(Math.abs(current), 1e-9) < 0.01;

  const grid = el('div', styles.sweetGrid!);
  for (const s of spots) {
    const value = spotValue(s, quantity);
    const btn = el('button', styles.sweetBtn!);
    btn.type = 'button';
    btn.dataset.testid = `sweet-${paramId}-${slug(s.label)}`;
    if (currentIsSpot && s.label === nearest) btn.classList.add('on');
    btn.appendChild(el('span', styles.sweetName!, s.label));
    btn.appendChild(el('span', styles.sweetVal!, fmtSpot(s.seconds, s.hz, quantity)));
    btn.addEventListener('click', () => {
      bus.set(paramId, value);
      close();
    });
    grid.appendChild(btn);
  }
  wrap.appendChild(grid);

  wrap.appendChild(
    el(
      'p',
      styles.sweetFoot!,
      '<strong>D</strong> = dotted (·1½) &nbsp; <strong>T</strong> = triplet. ' +
        'Values follow the tempo — change BPM and reopen to refresh.',
    ),
  );
  return wrap;
}

/** Human label for the delay a badge sits on (synth / drum / sampler). */
function labelOf(paramId: string): string {
  if (paramId.startsWith('fx.drum.')) return 'the drum delay';
  if (paramId.startsWith('fx.sampler.')) return 'the sampler delay';
  return 'the delay';
}

// ---- Mutual-dependency explainers (display-only, live derived numbers) ----

const RESO_SELF_OSC = 3.5; // resonance (of 4.2) where the ladder starts to sing

export function renderFilterCutoff(ctx: HelpContext): HTMLElement {
  const { bus } = ctx;
  const cutoff = bus.get('filter.cutoff');
  const reso = bus.get('filter.resonance');
  const hz = fmtHz(noteToHz(cutoff));
  const wrap = el('div');
  wrap.appendChild(
    el(
      'p',
      undefined,
      `How bright or dark the sound is — the filter cuts everything above this point, ` +
        `right now about <strong>${hz}</strong>. Sweeping it is the single most recognisable ` +
        `synth move. Drag to change, double-click to reset, hold <strong>Shift</strong> for fine control.`,
    ),
  );
  wrap.appendChild(
    el(
      'p',
      undefined,
      `It works hand-in-hand with two neighbours: <strong>RESO</strong> emphasises the ` +
        `frequencies right here (past ~${RESO_SELF_OSC} it self-oscillates into a pure sine at this ` +
        `pitch, currently ${hz}${reso >= RESO_SELF_OSC ? ' — <strong>and it is now</strong>' : ''}), and the ` +
        `filter <strong>ENV</strong> pushes this point up or down over time.`,
    ),
  );
  return wrap;
}

export function renderFilterResonance(ctx: HelpContext): HTMLElement {
  const { bus } = ctx;
  const reso = bus.get('filter.resonance');
  const cutoffHz = fmtHz(noteToHz(bus.get('filter.cutoff')));
  const wrap = el('div');
  wrap.appendChild(
    el(
      'p',
      undefined,
      `Boosts the frequencies right at the <strong>cutoff</strong> for a vocal, whistling edge. ` +
        `Push it high together with a cutoff sweep for that squelchy acid-bass sound.`,
    ),
  );
  wrap.appendChild(
    el(
      'p',
      undefined,
      `Past about <strong>${RESO_SELF_OSC}</strong> the filter <strong>self-oscillates</strong> — it ` +
        `sings a pure sine at the cutoff (now ~${cutoffHz}), even with no note playing. ` +
        `You are currently at <strong>${reso.toFixed(2)}</strong>` +
        `${reso >= RESO_SELF_OSC ? ' — into self-oscillation.' : '.'}`,
    ),
  );
  return wrap;
}

export function renderFilterEnvAmount(ctx: HelpContext): HTMLElement {
  const { bus } = ctx;
  const cutoff = bus.get('filter.cutoff');
  const env = bus.get('filter.envAmount'); // semitones, ±48
  const fromHz = fmtHz(noteToHz(cutoff));
  const toHz = fmtHz(noteToHz(cutoff + env));
  const dir = env > 0 ? 'up to' : env < 0 ? 'down to' : 'at';
  const wrap = el('div');
  wrap.appendChild(
    el(
      'p',
      undefined,
      `How far the <strong>Filter Envelope</strong> moves the cutoff, in semitones. ` +
        `Positive opens the filter as a note hits; negative closes it.`,
    ),
  );
  wrap.appendChild(
    el(
      'p',
      undefined,
      `From the current cutoff (~<strong>${fromHz}</strong>) a full envelope sweeps ${dir} ` +
        `<strong>${toHz}</strong> (${env >= 0 ? '+' : ''}${env.toFixed(0)} st). ` +
        `The A/D/S/R knobs shape <em>how</em> it gets there.`,
    ),
  );
  return wrap;
}

export function renderUnisonDetune(ctx: HelpContext): HTMLElement {
  const { bus } = ctx;
  const voices = Math.round(bus.get('unison.voices'));
  const detune = bus.get('unison.detune'); // cents, 0–50
  const wrap = el('div');
  wrap.appendChild(
    el(
      'p',
      undefined,
      `<strong>SPREAD</strong> detunes the stacked <strong>UNISON</strong> voices apart for a ` +
        `thick, wide sound — the more voices and the wider the spread, the bigger and more ` +
        `chorused it gets.`,
    ),
  );
  wrap.appendChild(
    el(
      'p',
      undefined,
      voices <= 1
        ? `Unison is currently <strong>off</strong> (1 voice), so SPREAD does nothing yet — ` +
            `raise UNISON to 2–4 voices to hear it.`
        : `Right now: <strong>${voices} voices</strong> spread across ` +
            `<strong>±${(detune / 2).toFixed(0)} cents</strong> (${detune.toFixed(0)} cents total).`,
    ),
  );
  return wrap;
}

export function renderCompThreshold(ctx: HelpContext, prefix: 'fx.drum.comp' | 'fx.master.comp'): HTMLElement {
  const { bus } = ctx;
  const thr = bus.get(`${prefix}.threshold`);
  const ratioDef = bus.def(`${prefix}.ratio`);
  const ratioIdx = Math.round(bus.get(`${prefix}.ratio`));
  const ratio = ratioDef?.labels?.[ratioIdx] ?? String(ratioIdx);
  const makeup = bus.get(`${prefix}.makeup`);
  const wrap = el('div');
  wrap.appendChild(
    el(
      'p',
      undefined,
      `<strong>THR</strong> is the level where compression starts. Only peaks louder than it get ` +
        `turned down; everything quieter passes untouched.`,
    ),
  );
  wrap.appendChild(
    el(
      'p',
      undefined,
      `Right now: squashing above <strong>${thr.toFixed(0)} dB</strong> at <strong>${ratio}</strong>. ` +
        `Lower THR or a harder RATIO = more squash — then add <strong>GAIN</strong> ` +
        `(now ${makeup.toFixed(0)} dB) to bring the level back up. Watch the bar to see it work.`,
    ),
  );
  return wrap;
}

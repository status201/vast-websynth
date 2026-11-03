// Dynamic bodies for the ⓘ info badges: the BPM-aware "sweet spots" list
// (click a note value to snap the knob) and the mutual-dependency explainers
// (live derived numbers). Kept out of help-content.ts so that file stays a flat
// copy deck; imported there by value, and only the HelpContext *type* comes back
// the other way — no runtime import cycle.
import type { HelpContext } from './help-content';
import {
  SYNC_LABELS,
  noteToHz,
  spotValue,
  sweetSpotsInRange,
  syncedValue,
  type TempoQuantity,
} from '../../utils/tempo';
import { syncIdFor, tempoLockFor } from '../../state/tempo-lock';
import { PHASE_TIME_CONSTANTS, type Adsr } from '../../utils/envelope-curve';
import { envelopeGraph } from './envelope-graph';
import { noteGlyph } from '../components/tempo-lock';
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

  // While the knob is tempo-locked its own param is not what is heard, so both
  // halves of this badge move to the lock: the marked row is the locked division,
  // and clicking a row re-locks rather than writing a value nothing reads. A row
  // that did nothing would be a gesture with no outcome (ADR-014 law 2) — one this
  // badge introduced the day the lock shipped (tempo-lock.md REQ-the-lock-menu-lists-divisions-only). Read before
  // the intro paragraph, which has to say which of the two a tap will do.
  const syncId = tempoLockFor(paramId) === undefined ? null : syncIdFor(paramId);
  const lockedIndex = syncId === null ? 0 : Math.round(bus.get(syncId));

  const wrap = el('div');
  wrap.appendChild(
    el(
      'p',
      undefined,
      lockedIndex > 0
        ? `At <strong>${Math.round(bpm)} BPM</strong> this knob's lock reads as the values ` +
            `below — tap one to change the <strong>division</strong> it follows.`
        : quantity === 'time'
          ? `Sync the echo to the beat. At <strong>${Math.round(bpm)} BPM</strong> these note ` +
              `lengths line up in time — tap one to set <strong>${def ? labelOf(paramId) : 'the delay'}</strong> exactly.`
          : `Match the movement to the beat. At <strong>${Math.round(bpm)} BPM</strong> these note ` +
              `values give an in-time rate — tap one to set it.`,
    ),
  );

  const spots = sweetSpotsInRange(bpm, min, max, quantity);
  const current = syncedValue(lockedIndex, bpm, quantity) ?? bus.get(paramId);

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
      if (syncId !== null && lockedIndex > 0) bus.set(syncId, SYNC_LABELS.indexOf(s.label));
      else bus.set(paramId, value);
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

  // The note glyph is a button, and nothing about a 9x11 icon says so
  // (tempo-sync-help.md REQ-the-badge-introduces-the-tempo-lock). This badge is already the place a user looks to
  // ask "how do I get this in time?", so it is where the lock gets introduced —
  // ADR-014 law 1 puts self-evident above explained, but an icon that opens a
  // whole mode has to be explained *somewhere*, and it is one rung up from the
  // help modal being the only mention.
  if (syncId !== null) wrap.appendChild(lockNote(lockedIndex > 0));

  return wrap;
}

/**
 * The footnote introducing the tempo lock, with the real glyph inlined so the
 * thing described and the thing on the faceplate are the same drawing.
 */
function lockNote(locked: boolean): HTMLElement {
  const p = el('p', styles.sweetFoot!);
  const glyph = noteGlyph();
  glyph.style.width = '9px';
  glyph.style.height = '11px';
  glyph.style.verticalAlign = '-1px';
  glyph.style.margin = '0 2px';

  // Explicit spaces around the glyph: it is an inline SVG between two text nodes,
  // so nothing else puts any there and "the ♩beside" is what you get.
  p.appendChild(document.createTextNode(locked ? 'Tempo-locked: the ' : 'Tap the '));
  p.appendChild(glyph);
  p.appendChild(
    document.createTextNode(
      locked
        ? ' beside this knob’s label is lit, so it follows the tempo. Tap it again to ' +
            'unlock and get the knob — and the value it was holding — back.'
        : ' beside this knob’s label to lock it to the tempo instead: the knob becomes the ' +
            'note division it is running at, and follows the song when the BPM changes.',
    ),
  );
  return p;
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
      `<strong>SPRD</strong> (spread) detunes the stacked <strong>UNI</strong> (unison) voices apart for a ` +
        `thick, wide sound — the more voices and the wider the spread, the bigger and more ` +
        `chorused it gets.`,
    ),
  );
  wrap.appendChild(
    el(
      'p',
      undefined,
      voices <= 1
        ? `Unison is currently <strong>off</strong> (1 voice), so SPRD does nothing yet — ` +
            `raise UNI (unison) to 2–4 voices to hear it.`
        : `Right now: <strong>${voices} voices</strong> spread across ` +
            `<strong>±${(detune / 2).toFixed(0)} cents</strong> (${detune.toFixed(0)} cents total).`,
    ),
  );
  return wrap;
}

// ---- The ADSR help under the AMP / FILTER ENV badges (envelope-help-graph.md) ----
// The copy lives here; the drawing is envelope-graph.ts.

type EnvWhich = 'amp' | 'fil';

const ENV_KNOBS: readonly { key: keyof Adsr; name: string; kind: 'time' | 'level' }[] = [
  { key: 'attack', name: 'Attack', kind: 'time' },
  { key: 'decay', name: 'Decay', kind: 'time' },
  { key: 'sustain', name: 'Sustain', kind: 'level' },
  { key: 'release', name: 'Release', kind: 'time' },
];

/** Everything that differs between the two envelopes' help. */
const ENV_HELP: Record<EnvWhich, { title: string; axis: string; intro: string; knobs: Record<keyof Adsr, string> }> = {
  amp: {
    title: 'Amp envelope',
    axis: 'volume',
    intro:
      'Shapes the <strong>volume</strong> of a note over time, from the moment you press a key ' +
      'until it has faded out.',
    knobs: {
      attack: 'how long the note takes to rise to full volume (0 = instant, like a pluck; high = a slow swell)',
      decay: 'how long it takes to fall from the peak down to the sustain level',
      sustain: 'how loud it <em>stays</em> while you keep holding the key, however long that is',
      release: 'how long it takes to fade to silence after you let go',
    },
  },
  fil: {
    title: 'Filter envelope',
    axis: 'cutoff',
    intro:
      'The same A / D / S / R shape, but instead of volume it moves the <strong>filter ' +
      'cutoff</strong> over time — great for plucks that open bright then close, or slow sweeps.',
    knobs: {
      attack: 'how long the cutoff takes to sweep to its peak',
      decay: 'how long it takes to fall back from the peak to the sustain level',
      sustain: 'where the cutoff <em>stays</em> while you keep holding the key, however long that is',
      release: 'how long it takes to return to the cutoff knob’s setting after you let go',
    },
  },
};

/** Reads one envelope's four params and their knob-formatted readouts. */
function readEnv(ctx: HelpContext, which: EnvWhich): { env: Adsr; values: Record<keyof Adsr, string> } {
  const env = {} as Adsr;
  const values = {} as Record<keyof Adsr, string>;
  for (const { key } of ENV_KNOBS) {
    const id = `env.${which}.${key}`;
    const v = ctx.bus.get(id);
    env[key] = v;
    values[key] = ctx.bus.def(id)?.format?.(v) ?? v.toFixed(2);
  }
  return { env, values };
}

/**
 * The live ADSR help body for the AMP ENV (`'amp'`) or FILTER ENV (`'fil'`)
 * badge: copy naming each knob as a time or a level, the graph of the current
 * envelope, and — for the filter — the sweep in Hz (envelope-help-graph.md).
 */
/** The MULTI / SINGLE paragraph, per envelope: each panel's switch decides only its own. */
const TRIGGER_HELP: Record<EnvWhich, string> = {
  amp:
    '<strong>MULTI / SINGLE</strong> (Mono only): with MULTI every note starts this envelope ' +
    'again. With SINGLE, a note played while another key is still held carries on at the level ' +
    'it has reached, so a legato line has one attack and only a detached note re-strikes.',
  fil:
    '<strong>MULTI / SINGLE</strong> (Mono only): the same choice for the filter. Set AMP ENV to ' +
    'SINGLE and this to MULTI, and a legato line keeps its level while every note still gets its ' +
    'own filter sweep. The other way round, one sweep opens across a phrase of re-struck notes.',
};

export function renderEnvelopeHelp(ctx: HelpContext, which: EnvWhich): HTMLElement {
  const help = ENV_HELP[which];
  const { env, values } = readEnv(ctx, which);
  const wrap = el('div');

  wrap.appendChild(
    el('p', undefined, `${help.intro} Three of the knobs are <em>times</em>; one is a <em>level</em>:`),
  );

  const list = el('ul');
  for (const k of ENV_KNOBS) {
    const kind = k.kind === 'time' ? '<em>time</em>' : '<em>level</em>, not a time';
    list.appendChild(
      el(
        'li',
        undefined,
        `<strong>${k.name[0]}</strong>${k.name.slice(1)} (${kind}): ${help.knobs[k.key]}. ` +
          `Now <strong>${values[k.key]}</strong>.`,
      ),
    );
  }
  wrap.appendChild(list);

  wrap.appendChild(envelopeGraph(env, { title: help.title, axis: help.axis, values }));

  if (which === 'fil') {
    wrap.appendChild(el('p', undefined, filterSweepCaption(ctx, env.sustain)));
    wrap.appendChild(
      el(
        'p',
        undefined,
        "How <em>strongly</em> it pushes the cutoff is set by the filter's <strong>ENV</strong> " +
          'knob; the ADSR knobs here set the shape of that movement.',
      ),
    );
    // envelopes.md REQ-filter-env-follows-velocity — the fifth knob on this panel.
    wrap.appendChild(
      el(
        'p',
        undefined,
        '<strong>VEL</strong>: how much playing harder deepens the sweep. At 0 every note sweeps ' +
          'the full depth; turned up, soft notes sweep less and sound darker.',
      ),
    );
  }
  // voicing.md REQ-single-trigger-legatos-a-mono-line — the switch at the top of each panel.
  wrap.appendChild(el('p', undefined, TRIGGER_HELP[which]));

  const pct = Math.round((1 - Math.exp(-PHASE_TIME_CONSTANTS)) * 100);
  wrap.appendChild(
    el(
      'p',
      styles.sweetFoot!,
      `Each time is how long the curve takes to get ~${pct}% of the way there; it then eases ` +
        'in the rest. The graph is your current setting — change a knob and reopen to refresh.',
    ),
  );
  return wrap;
}

/** The filter envelope in cutoff terms (REQ-the-filter-graph-speaks-in-hertz). */
function filterSweepCaption(ctx: HelpContext, sustain: number): string {
  const { bus } = ctx;
  const cutoff = bus.get('filter.cutoff');
  const amount = bus.get('filter.envAmount'); // semitones, ±48
  const st = `${amount >= 0 ? '+' : '−'}${Math.abs(amount).toFixed(0)} st`;
  if (Math.abs(amount) < 0.5) {
    return 'The filter’s <strong>ENV</strong> knob is at <strong>0</strong>, so this shape ' +
      'currently does nothing to the cutoff — turn ENV up (or down) to hear it.';
  }
  const base = fmtHz(noteToHz(cutoff));
  const peak = fmtHz(noteToHz(cutoff + amount));
  const held = fmtHz(noteToHz(cutoff + amount * sustain));
  const [lead, verb, way] =
    amount > 0
      ? [`With <strong>ENV</strong> at ${st},`, 'opens', 'up']
      : [`With <strong>ENV</strong> at ${st} the sweep runs <strong>down</strong>:`, 'closes', 'down'];
  return (
    `${lead} a note ${verb} the cutoff from ~<strong>${base}</strong> ${way} to ` +
    `~<strong>${peak}</strong>, settles at ~<strong>${held}</strong> while held, and returns to ` +
    `${base} on release.`
  );
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

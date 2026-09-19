// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  HELP_TOPICS, TOUR_STEPS, DEMO_FOR_TOUR, EQ_BAND_ROLES,
} from '../../src/ui/onboarding/help-content';
import { iconLabel } from '../../src/ui/components/ui-icons';
import { demoNames } from '../../src/state/song';
import { EQ_BANDS } from '../../src/state/eq';
import { MOTION_TRACK_COUNT, MOTION_TRACK_LABELS } from '../../src/state/patterns';
import { formatHzFull } from '../../src/ui/components/scope';

/** The Clear button as help copy renders it — the caret is an icon, not a `▾`
 *  (iconography.md REQ-a-control-glyph-is-inline-svg), so the assertions go through the same helper. */
const CLEAR_BTN = iconLabel('caretDown', 'Clear', 'after');

/** A topic's authored copy — asserts it exists and is static (not a widget). */
function bodyOf(id: keyof typeof HELP_TOPICS): string {
  const t = HELP_TOPICS[id];
  expect(t, id).toBeTruthy();
  expect(typeof t.body, id).toBe('string');
  return t.body as string;
}

/** The two transport-sync help topics (onboarding.md REQ-the-sync-section-has-two-topics / midi-clock-sync v2). */
describe('help-content sync topics', () => {
  it('has a `sync` topic explaining Master/Slave + USB-MIDI', () => {
    const t = HELP_TOPICS['sync'];
    expect(t).toBeTruthy();
    expect(t.title).toContain('Sync');
    expect(typeof t.body).toBe('string');
    const body = t.body as string;
    expect(body).toContain('Master');
    expect(body).toContain('Slave');
    expect(body).toMatch(/USB|loopMIDI/);
  });

  it('has a `sync.wifi` topic explaining the pairing steps', () => {
    const t = HELP_TOPICS['sync.wifi'];
    expect(t).toBeTruthy();
    expect(t.title.toLowerCase()).toContain('wifi');
    expect(typeof t.body).toBe('string');
    const body = t.body as string;
    expect(body).toContain('Create link');
    expect(body).toContain('Join');
  });
});

/** The Motion machine topic (onboarding.md REQ-a-motion-topic-anchors-to-the-tab / motion-sequencer.md REQ-each-motion-step-is-a-mini-xy-pad). */
describe('help-content motion topic', () => {
  it('has a `motion` topic explaining the Y/X graph view', () => {
    const t = HELP_TOPICS['motion'];
    expect(t).toBeTruthy();
    expect(t.title).toContain('Motion');
    expect(typeof t.body).toBe('string');
    const body = t.body as string;
    // The confusing bit the badge exists for: the one-axis-at-a-time graph.
    expect(body).toMatch(/Y \/ X/);
    expect(body).toContain('one at a time');
    expect(body).toContain('never move');
  });

  it('explains the extra single-param lanes (v7)', () => {
    const body = bodyOf('motion');
    expect(body).toContain('four more lanes');
    expect(body).toContain('per bank');
    // Motion's Clear lists lanes, not a selected row (step-grid-editing REQ-clear-menu-clears-in-bulk).
    // Its caret is drawn, so assert against the helper rather than a character.
    expect(body).toContain(CLEAR_BTN);
  });

  // The two short per-lane badges (onboarding.md REQ-the-motion-tab-carries-two-lane-badges / motion-sequencer.md v6).
  it('has a short `motion.xy` topic for the XY lane', () => {
    const t = HELP_TOPICS['motion.xy'];
    expect(t).toBeTruthy();
    expect(t.title).toContain('XY');
    const body = bodyOf('motion.xy');
    expect(body).toMatch(/anchor/i);
    expect(body).toContain('SLIDE');
    expect(body).toContain('Y / X');
  });

  it('has a short `motion.tracks` topic for the single-param lanes', () => {
    const t = HELP_TOPICS['motion.tracks'];
    expect(t).toBeTruthy();
    // The lane letters run A..MOTION_TRACK_COUNT, so the title names the range
    // rather than the two it used to have (motion-sequencer.md REQ-extra-single-param-tracks-per-bank).
    expect(t.title).toMatch(
      new RegExp(`A-${MOTION_TRACK_LABELS[MOTION_TRACK_COUNT - 1]!}`),
    );
    const body = bodyOf('motion.tracks');
    expect(body).toContain('per bank');
    expect(body).toContain('SLIDE');
    // The fold is the reason four lanes fit where two did (REQ-an-empty-motion-lane-starts-folded).
    expect(body).toContain('folded');
  });
});

/** The grid gesture vocabulary reaches every step grid (onboarding.md REQ-help-copy-covers-the-gesture-model). */
describe('help-content grid gestures', () => {
  it.each(['seq', 'drums', 'sampler'] as const)('%s names every gesture', (id) => {
    const body = bodyOf(id);
    expect(body).toContain('drag');
    expect(body).toContain('Press and hold');
    expect(body).toContain('right-click');
    expect(body).toContain('Delete');
    expect(body).toContain(CLEAR_BTN);
    expect(body).toContain('Ctrl+Z');
  });

  it('uses identical words on all three, so the vocabulary cannot drift', () => {
    const shared = bodyOf('seq').match(/<p><strong>Editing faster:.*?<\/p>/s)?.[0];
    expect(shared).toBeTruthy();
    expect(bodyOf('drums')).toContain(shared);
    expect(bodyOf('sampler')).toContain(shared);
  });
});

/** The sequencer's four tracks (sequencer.md REQ-four-tracks-per-bank/REQ-poly-voicing-gates-the-extra-tracks,
 *  sequencer.md REQ-per-track-mute, onboarding.md REQ-help-copy-covers-the-gesture-model). */
describe('help-content seq topic', () => {
  it('explains the four tracks and the poly gate', () => {
    const body = bodyOf('seq');
    expect(body).toContain('Four tracks');
    expect(body).toContain('Poly');
    expect(body).toContain('mute');
  });
});

/** The Render button's badge (onboarding.md REQ-seq-render-has-a-help-badge / render-to-sampler.md REQ-the-render-button-carries-a-badge). */
describe('help-content seq.render topic', () => {
  it('explains the import and why the bar plays twice', () => {
    const t = HELP_TOPICS['seq.render'];
    expect(t).toBeTruthy();
    expect(t.title).toMatch(/sampler/i);
    const body = bodyOf('seq.render');
    expect(body).toMatch(/sampler slot/i);
    // The whole point of the badge: the two-pass tail bake reads as a hang.
    expect(body).toMatch(/twice/i);
    expect(body).toMatch(/reverb/i);
    // Both disabled reasons (render-to-sampler.md REQ-a-render-is-refused-while-busy).
    expect(body).toMatch(/no steps/i);
    expect(body).toMatch(/MIDI clock/i);
  });
});

/**
 * The two topics that teach time-stretch (time-stretch.md REQ-the-editor-gains-a-fit-row/REQ-the-slot-fit-button-is-a-quick-fit).
 *
 * In-app copy has no other gate — it is the surface that goes stale silently when
 * a feature lands, so the claims a user reads are pinned here like any contract.
 */
describe('help-content time-stretch copy', () => {
  it('the sampler topic covers FIT, both modes, and that pitch stays put', () => {
    const body = bodyOf('sampler');
    expect(body).toMatch(/FIT/);
    expect(body).toMatch(/Rhythmic/i);
    expect(body).toMatch(/Tonal/i);
    expect(body).toMatch(/sixteenths/i);
    // The distinction that makes the feature worth having.
    expect(body).toMatch(/pitch stays/i);
    // …and its converse, so the two are never confused for each other.
    expect(body).toMatch(/Shift/);
    expect(body).toMatch(/Undo/);
  });

  it('the pitch topic points at the editor for length-without-pitch', () => {
    const body = bodyOf('sampler.pitch');
    // It still has to say PITCH is varispeed — that is the knob's whole character.
    expect(body).toMatch(/length/i);
    // But it must no longer read as if that were the only option.
    expect(body).toMatch(/Fit/);
    expect(body).toMatch(/Shift/);
  });
});

/** The header Presets button (onboarding.md REQ-a-presets-topic-anchors-to-the-picker). */
describe('help-content presets topic', () => {
  it('separates a preset from a song and covers export/import', () => {
    const t = HELP_TOPICS['presets'];
    expect(t.title).toContain('Preset');
    const body = bodyOf('presets');
    expect(body).toContain('one <em>sound</em>');
    expect(body).toContain('song');
    expect(body).toContain('Export preset');
    expect(body).toContain('Export bank');
    // The import wizard's whole point: nothing is written until you confirm.
    expect(body).toContain('review');
    expect(body).toContain('until you confirm');
  });
});

/** The gesture tour step (onboarding.md REQ-the-tour-teaches-the-grid-gestures). */
describe('the tour', () => {
  it('teaches the grid gestures on the drum grid, before the Song-tab steps', () => {
    const i = TOUR_STEPS.findIndex((s) => s.title === 'Paint a pattern');
    expect(i).toBeGreaterThan(-1);
    const step = TOUR_STEPS[i]!;
    // Not `panel-seq`: the previous step already spotlights it, and an unmoved
    // spotlight reads as "nothing happened".
    expect(step.target).toBe('panel-drums');
    expect(step.precondition).toBeTypeOf('function');
    expect(String(step.body)).toContain('Drag');
    expect(TOUR_STEPS.findIndex((s) => s.title === 'Arrange a full song')).toBeGreaterThan(i);
  });
});

/** Playhead-ruler + Song-transport badges (onboarding.md REQ-the-playhead-ruler-carries-a-badge). */
describe('help-content transport-position topics', () => {
  const LANES = ['seq', 'drum', 'sampler', 'motion'] as const;

  it('has one ruler topic per machine tab', () => {
    for (const lane of LANES) {
      const t = HELP_TOPICS[`transport.ruler.${lane}`];
      expect(t, lane).toBeTruthy();
    }
  });

  it('shares ONE topic object across the four ids (identical copy by construction)', () => {
    const first = HELP_TOPICS['transport.ruler.seq'];
    for (const lane of LANES) expect(HELP_TOPICS[`transport.ruler.${lane}`]).toBe(first);
  });

  it('the ruler copy covers what the grid playhead cannot say, plus the keys', () => {
    const body = bodyOf('transport.ruler.seq');
    expect(body).toContain('stopped');            // it shows position while stopped
    expect(body).toMatch(/switched off/);         // …and on a disabled machine
    expect(body).toMatch(/bank/);                 // …and across banks
    expect(body).toContain('Home');
    expect(body).toContain('Shift');
  });

  it('has a `transport.song` topic covering the scrubber and the window', () => {
    const t = HELP_TOPICS['transport.song'];
    expect(t).toBeTruthy();
    expect(t.title.toLowerCase()).toContain('transport');
    const body = bodyOf('transport.song');
    expect(body).toContain('bar.step');
    expect(body).toMatch(/chains? above|chain/);  // cells line up with chain slots
    expect(body).toMatch(/floating window|window/);
    expect(body).toMatch(/external clock|export|render/); // when seeking is refused
  });

  // live-fx-window.md REQ-live-fx-row-carries-a-help-badge — the sibling badge on the row below the transport.
  it('has a `song.fx` topic naming every control in the Live FX row', () => {
    const t = HELP_TOPICS['song.fx'];
    expect(t).toBeTruthy();
    const body = bodyOf('song.fx');
    for (const control of ['DJ', 'Fill', 'Stutter', 'Drop', 'Tape', 'XY']) {
      expect(body).toContain(control);
    }
    expect(body).toMatch(/momentary|hold/);        // the buttons are not latches
    expect(body).toMatch(/floating window|window/); // what LIVE FX adds
    expect(body).toContain('external clock');       // Tape Stop while slaved
    // The compressor sharing the row has its own badge; don't duplicate it.
    expect(body).not.toMatch(/compressor/i);
  });
});

/** The scale/chord badges (onboarding.md REQ-about-is-the-single-door-for-help). */
// input-control.md REQ-pitch-bend-is-quote-and-slash (v15, regression) — the topic taught `.` for five
// versions after the key was unbound; nothing held it to the real binding.
describe('help-content pitchBend topic', () => {
  it("names ' (up) and / (down) — never the unbound .", () => {
    const body = bodyOf('pitchBend');
    expect(body).toContain("<strong>'</strong>");
    expect(body).toContain('<strong>/</strong>');
    expect(body).not.toContain('<strong>.</strong>');
  });
});

describe('help-content key & chord topics', () => {
  it('has a `key` topic that leads with the non-destructive promise', () => {
    const t = HELP_TOPICS['key'];
    expect(t).toBeTruthy();
    expect(t.title).toContain('Key');
    const body = bodyOf('key');
    // The two things the panel itself cannot say, and the reason the filter is
    // safe to leave switched on.
    expect(body).toMatch(/never rewritten/i);
    expect(body).toContain('chromatic');
    // Every note source is affected, which is the surprising part.
    for (const source of ['sequencer', 'arpeggiator', 'keyboard']) {
      expect(body, source).toContain(source);
    }
    // The map's colours have no on-screen legend beyond three words.
    for (const colour of ['orange', 'yellow', 'brown']) {
      expect(body, colour).toContain(colour);
    }
    // Where to make it permanent — that lives on another tab.
    expect(body).toContain('Snap');
  });

  it('has a `seq.chord` topic decoding the numerals and the four-track write', () => {
    const t = HELP_TOPICS['seq.chord'];
    expect(t).toBeTruthy();
    expect(t.title).toContain('Chord');
    const body = bodyOf('seq.chord');
    expect(body).toMatch(/one note per track|across the tracks/i);
    expect(body).toContain('Undo');            // the whole chord is one undo
    expect(body).toMatch(/greyed out|disabled/); // why the list can be dead
    expect(body).toContain('major');           // the numerals a non-musician lacks
    expect(body).toContain('minor');
    expect(body).toContain('POLY');            // tracks 2-4 need it
  });
});

/**
 * song-mode.md REQ-drop-in-demos-are-fetched-on-click (v18). The tour names its demo by string constant, while
 * `src/state/demos/` is a drop-in directory anyone may rename in. `loadDemo`
 * now falls back to the first demo, so an orphaned constant no longer breaks the
 * tour — but it would quietly demonstrate a song the script was not written for,
 * which is worth a warning. Reads the constant rather than spelling a name, so
 * adding or editing a demo can never fail this.
 */
describe('the tour names a demo that exists', () => {
  it('DEMO_FOR_TOUR is a registered demo', () => {
    expect(demoNames()).toContain(DEMO_FOR_TOUR);
  });
});

/**
 * The Equalizer's badges (onboarding.md REQ-the-equalizer-carries-seven-badges, equalizer.md REQ-the-eq-explains-itself-through-badges). The panel
 * says almost nothing about itself in words: eight abbreviations, a lamp that
 * looks like a switch, a dropdown that switches the EQ on. This is what a player
 * reads instead, so its claims are pinned like any other contract.
 */
describe('help-content equalizer topics', () => {
  const LANES = ['seq', 'drums', 'sampler'] as const;

  it('shares ONE graph topic and ONE knobs topic across the three lanes', () => {
    const graph = HELP_TOPICS['eq.graph.seq'];
    const knobs = HELP_TOPICS['eq.knobs.seq'];
    expect(graph).not.toBe(knobs);
    for (const lane of LANES) {
      expect(HELP_TOPICS[`eq.graph.${lane}`], lane).toBe(graph);
      expect(HELP_TOPICS[`eq.knobs.${lane}`], lane).toBe(knobs);
    }
  });

  it('decodes every band label, at the frequency the filters use', () => {
    const body = bodyOf('eq.graph.seq');
    for (const band of EQ_BANDS) {
      // A band added or renamed in the table without prose here would render
      // as "SIB (8 kHz) — ." — a label with nothing behind it.
      expect(EQ_BAND_ROLES[band.label], band.label).toBeTruthy();
      expect(body, band.label).toContain(
        `<strong>${band.label}</strong> (${formatHzFull(band.hz)})`,
      );
    }
    expect(body).toMatch(/sibilance/i);
    expect(body).toMatch(/presence/i);
  });

  it('names the graph gestures and how to read the axis', () => {
    const body = bodyOf('eq.graph.seq');
    expect(body).toContain('Drag');
    expect(body).toContain('Shift');
    expect(body).toContain('Double-tap');
    expect(body).toMatch(/hover/i);
    expect(body).toContain('0 dB');
    expect(body).toContain('5k');
    expect(body).toContain('Zones');
  });

  it('the section topic says the lamp only reports, and what Custom and Reset do', () => {
    const t = HELP_TOPICS['eq'];
    expect(t.title).toBe('Equalizer');
    const body = bodyOf('eq');
    expect(body).toMatch(/only report/);
    // The three lamp states, in the words a player sees.
    expect(body).toMatch(/off/);
    expect(body).toMatch(/flat/);
    expect(body).toMatch(/shaping/);
    expect(body).toContain('<strong>on</strong> switch');
    expect(body).toContain('Custom');
    expect(body).toContain('Reset');
    expect(body).toMatch(/switches the EQ on/);
    expect(body).toMatch(/no undo/);
    expect(body).toMatch(/preset/);
    expect(body).toMatch(/song/);
  });

  it('the knobs topic explains HP, LP and Q, and that Q skips the shelves', () => {
    const t = HELP_TOPICS['eq.knobs.seq'];
    expect(t.title).toContain('Q');
    const body = bodyOf('eq.knobs.seq');
    expect(body).toContain('<strong>HP</strong>');
    expect(body).toContain('<strong>LP</strong>');
    expect(body).toContain('<strong>Q</strong>');
    expect(body).toMatch(/high-pass/);
    expect(body).toMatch(/low-pass/);
    expect(body).toContain('<strong>off</strong>');
    // Up is narrower — the reason the knob is no longer called WIDTH.
    expect(body).toMatch(/narrower/);
    expect(body).toMatch(/shelves/);
  });

  it('no topic still sends the player to a WIDTH knob on the EQ', () => {
    for (const id of ['eq', 'eq.graph.seq', 'eq.knobs.seq'] as const) {
      expect(bodyOf(id), id).not.toContain('WIDTH');
    }
  });

  it('the Spectrum topic points at the Equalizer for fixing a zone', () => {
    expect(bodyOf('scope')).toContain('Equalizer');
  });
});

/** The mod matrix badge (onboarding.md REQ-the-mod-launcher-carries-a-badge). */
describe('help-content mod topic', () => {
  it('has a `mod` topic covering bipolar depth, the knob colours and the boundary', () => {
    const t = HELP_TOPICS['mod'];
    expect(t).toBeTruthy();
    expect(t.title).toContain('Mod');
    const body = bodyOf('mod');
    // "MOD" names nothing a newcomer knows, so the copy has to say what a route is.
    expect(body).toMatch(/source/i);
    expect(body).toMatch(/destination/i);
    // The three things the window itself cannot show.
    expect(body).toMatch(/bipolar/i);
    expect(body).toMatch(/invert/i);
    for (const colour of ['green', 'yellow']) expect(body, colour).toContain(colour);
    // ADR-017's boundary — without it the short list reads as a missing feature.
    expect(body).toContain('Motion');
    expect(body).toContain('XY Pad');
  });
});

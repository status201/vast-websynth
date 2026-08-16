import type { ParamBus } from '../../state/params';
import { NOTE_LABELS, SCALE_LABELS, CHORD_LABELS } from '../../state/params';
import { ParamDropdown } from '../components/param-dropdown';
import { type KeyState, keyRole, onKeyChange, readKeyState } from '../key-roles';
import layout from '../styles/layout.module.css';
import styles from '../styles/arp.module.css';
import map from '../styles/key.module.css';

const WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11];              // C D E F G A B
const BLACK_OFFSETS = [                                    // semitone, white key it follows
  { semi: 1, after: 0 }, { semi: 3, after: 1 }, { semi: 6, after: 3 },
  { semi: 8, after: 4 }, { semi: 10, after: 5 },
];
const OCTAVES = 2;
const WHITE_PER_OCTAVE = WHITE_OFFSETS.length;
const WHITE_TOTAL = WHITE_PER_OCTAVE * OCTAVES;

/**
 * The KEY tab: the global key, and the chord memory that plays off it.
 *
 * A pure control panel with no grid — the Arpeggiator tab is the precedent for a
 * pattern-row tab shaped like this. It lives here rather than on the synth faceplate
 * because that grid is exactly eight panels in eight columns and a ninth would wrap
 * (panel-tabs.md).
 *
 * Spec: `specs/features/scale-quantization.md`, `specs/features/chord-tools.md`.
 */
export function buildKeyPanel(bus: ParamBus): HTMLElement {
  const root = document.createElement('div');
  root.className = `${layout.patternPanel!} key-panel`;

  // Reading order, and therefore DOM order: the picture, then the controls that set
  // it, then the sentence saying what they add up to. One centred row when there is
  // room; wraps in place when there is not, never reorders (REQ-9).
  const body = document.createElement('div');
  body.className = map.row!;

  // Three dropdowns *describe* a key; a keyboard *shows* it, and where the semitones
  // fall is the part that teaches (REQ-9).
  const keyMap = buildKeyMap();
  const mapGroup = group('Notes in this key', keyMap.el);
  mapGroup.className += ` ${map.mapGroup!}`;
  mapGroup.appendChild(keyMap.legend);
  body.appendChild(mapGroup);

  // The three share a wrapper so they wrap as one unit instead of splitting across
  // rows — "root" on one line and "scale" on the next would read as two settings.
  const controls = document.createElement('div');
  controls.className = map.controls!;
  body.appendChild(controls);

  const root_ = new ParamDropdown(bus, 'scale.root', NOTE_LABELS);
  root_.el.dataset.testid = 'key-root';
  controls.appendChild(group('Root', root_.el));

  const scale = new ParamDropdown(bus, 'scale.type', SCALE_LABELS);
  scale.el.dataset.testid = 'key-scale';
  controls.appendChild(group('Scale', scale.el));

  const chord = new ParamDropdown(bus, 'chord.voicing', CHORD_LABELS);
  chord.el.dataset.testid = 'key-chord';
  controls.appendChild(group('Chord memory', chord.el));

  // One line that says what the current combination will actually do, rather than
  // three controls the user has to simulate in their head (ADR-014).
  const hint = document.createElement('p');
  hint.className = `${layout.paramHint!} ${map.hint!}`;
  hint.dataset.testid = 'key-hint';
  body.appendChild(hint);

  const refresh = (): void => {
    // Chromatic admits every note, so every key lights — and choosing a scale then
    // visibly *removes* notes, which is the teaching moment (REQ-9). `key-roles` owns
    // that derivation; the playable keyboard reads the very same state (REQ-10).
    const state = readKeyState(bus);
    const { active } = state;
    const voicing = Math.round(bus.get('chord.voicing'));
    const mono = bus.get('voicing.mode') < 0.5;

    keyMap.paint(state);
    // Chord memory has two ways of being inert, and a silent control is exactly what
    // the hint exists to prevent — name whichever one applies (chord-tools.md REQ-7/8).
    if (!active) {
      hint.textContent = 'Chromatic — notes play exactly as written. '
        + 'Choose a scale to quantize every note and unlock the chord tools.';
    } else if (voicing === 0) {
      hint.textContent = `Every note snaps into ${NOTE_LABELS[state.root]} `
        + `${SCALE_LABELS[Math.round(bus.get('scale.type'))]}. Stored notes are never rewritten.`;
    } else if (mono) {
      hint.textContent = `Chord memory is off while VOICE is mono — `
        + `four notes would fight one voice. Switch to poly to hear ${CHORD_LABELS[voicing]}.`;
    } else {
      hint.textContent = `One key plays a ${CHORD_LABELS[voicing]} from the scale. `
        + `The arpeggiator picks it up too.`;
    }
    // Chord memory needs degrees to stack, and chromatic has none.
    chord.setDisabledLabels(active ? [] : CHORD_LABELS.slice(1));
  };
  onKeyChange(bus, refresh);
  // Not one of KEY_PARAMS: mono changes nothing about the picture, only what the hint
  // has to say about why chord memory is silent.
  bus.subscribe('voicing.mode', refresh);

  root.appendChild(body);
  return root;
}

/** One key of the map, plus the label slot the root writes into. */
interface MapKey { el: HTMLElement; label: HTMLElement }

/** What each `data-role` says on hover — the colour code, spelled out. */
const ROLE_TEXT: Record<string, string> = {
  root: 'root', chord: 'chord tone', scale: 'in scale', out: 'not in scale',
};

/**
 * A two-octave keyboard map (scale-quantization.md REQ-9).
 *
 * Real piano topology — the five black keys inset at their true positions — because
 * *where* the semitones fall is what teaches. Stylised palette: both rows are muted
 * panel tones, so every bit of colour is spent on meaning rather than on being
 * white-and-black.
 *
 * No listeners are attached anywhere: this is a readout, and the app's real keyboard
 * is always on screen (see the spec's gesture inventory).
 */
function buildKeyMap(): { el: HTMLElement; legend: HTMLElement; paint: (s: KeyState) => void } {
  const el = document.createElement('div');
  el.className = map.map!;
  el.dataset.testid = 'key-map';

  // Semitone (0..23) → its key. Built white-first so the blacks stack above them.
  const keys = new Map<number, MapKey>();
  const add = (semi: number, cls: string, left?: number): void => {
    const k = document.createElement('div');
    k.className = cls;
    k.dataset.testid = `key-map-${semi}`;
    if (left !== undefined) k.style.left = `${left}%`;
    const label = document.createElement('span');
    label.className = map.rootLabel!;
    k.appendChild(label);
    el.appendChild(k);
    keys.set(semi, { el: k, label });
  };

  for (let o = 0; o < OCTAVES; o++) {
    for (let i = 0; i < WHITE_PER_OCTAVE; i++) add(o * 12 + WHITE_OFFSETS[i]!, map.white!);
  }
  for (let o = 0; o < OCTAVES; o++) {
    for (const b of BLACK_OFFSETS) {
      // Centred on the boundary between two white keys, as a share of the whole row.
      const left = ((o * WHITE_PER_OCTAVE + b.after + 1) / WHITE_TOTAL) * 100;
      add(o * 12 + b.semi, map.black!, left);
    }
  }

  const legend = document.createElement('div');
  legend.className = map.legend!;
  legend.dataset.testid = 'key-legend';
  // Dropdown order, not precedence order: the legend sits directly under Root / Scale /
  // Chord memory and a reader pairs them positionally (REQ-9).
  const legendItems = (['root', 'scale', 'chord'] as const).map((role) => {
    const item = document.createElement('span');
    item.className = map.legendItem!;
    const sw = document.createElement('i');
    sw.className = map.swatch!;
    sw.dataset.role = role;
    item.appendChild(sw);
    item.appendChild(document.createTextNode(role === 'scale' ? 'in scale' : role));
    legend.appendChild(item);
    return { role, item };
  });

  function paint(s: KeyState): void {
    for (const [semi, k] of keys) {
      const pc = semi % 12;
      // Falling precedence — resolved by `key-roles`, so this map and the playable
      // keyboard cannot disagree about which note is the root.
      const role = keyRole(pc, s);
      k.el.dataset.role = role;
      k.label.textContent = role === 'root' ? NOTE_LABELS[pc]! : '';
      k.el.title = `${NOTE_LABELS[pc]} — ${ROLE_TEXT[role]}`;
    }
    // A legend entry for a colour nothing is currently wearing is just noise.
    for (const { role, item } of legendItems) {
      item.classList.toggle('hidden', role === 'chord' && s.chord.size === 0);
    }
  }

  return { el, legend, paint };
}

function group(label: string, inner: HTMLElement): HTMLElement {
  const g = document.createElement('div');
  g.className = styles.group!;
  const l = document.createElement('div');
  l.className = styles.groupLabel!;
  l.textContent = label;
  g.appendChild(l);
  g.appendChild(inner);
  return g;
}

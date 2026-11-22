// The poster's look: canvas size, fonts, the two palettes, the wire types and
// the text styles. One layout, two palettes — the posters differ only in which
// PALETTES entry the renderer is handed.

export const W = 7300;
export const H = 3760;
export const HEAD = 34; // block title band
export const LINE = 18; // body line pitch
export const SANS = `'Segoe UI', 'Helvetica Neue', Arial, system-ui, sans-serif`;
export const MONO = `ui-monospace, 'Cascadia Mono', Consolas, 'DejaVu Sans Mono', monospace`;

export const PALETTES = {
  light: {
    bg: '#f4f0e6', region: '#fbf9f3', regionEdge: '#d9d0bd', band: '#f6f2e8',
    panel: '#ffffff', edge: '#3b342b', text: '#1d1a15', dim: '#4f473d', faint: '#8b8274',
    heading: '#1d1a15', headOp: 0.16, guide: '#d9d0bd',
    cat: {
      input: '#2f6db3', time: '#2e7d32', machine: '#a8740a', voice: '#cf4f0f',
      mod: '#d97706', fx: '#6a3fb5', master: '#b3261e', drum: '#8a5a12', sampler: '#0f766e',
    },
    wire: {
      audio: '#1565c0', stereo: '#1565c0', note: '#a87700', vel: '#8d6e3f', cv: '#e0570f',
      clock: '#2e7d32', trig: '#d32f2f', auto: '#7b3fbf', buf: '#7a7166',
    },
  },
  dark: {
    bg: '#0e0a06', region: '#15100b', regionEdge: '#3d2e1b', band: '#191310',
    panel: '#1f1a15', edge: '#5d4628', text: '#e8d8b6', dim: '#b9a58f', faint: '#8f7a63',
    heading: '#f4cd5e', headOp: 0.22, guide: '#3d2e1b',
    cat: {
      input: '#6ea8dc', time: '#6fb86a', machine: '#f4cd5e', voice: '#e8742e',
      mod: '#ffb051', fx: '#c58cff', master: '#ff6a52', drum: '#e0a458', sampler: '#4fc1b0',
    },
    wire: {
      audio: '#5ab0ff', stereo: '#5ab0ff', note: '#f4cd5e', vel: '#d6c09a', cv: '#ff8a3d',
      clock: '#6fcf7f', trig: '#ff5a4a', auto: '#c58cff', buf: '#a89372',
    },
  },
};

// Wire types: what travels on the wire. Width / dash are the same in both
// palettes. The order is the legend's order.
export const WIRE_TYPES = {
  audio: { w: 4, dash: '', name: 'AUDIO (mono)' },
  stereo: { w: 9, dash: '', name: 'AUDIO (stereo)' },
  note: { w: 2.6, dash: '12 6', name: 'NOTE · GATE · TRIGGER' },
  vel: { w: 1.8, dash: '', name: 'VELOCITY' },
  cv: { w: 2.6, dash: '', name: 'MODULATION (CV)' },
  clock: { w: 2.8, dash: '1 7', name: 'CLOCK · SYNC' },
  trig: { w: 2.6, dash: '6 5', name: 'DRUM HIT → DUCK' },
  auto: { w: 2.4, dash: '12 5 2 5', name: 'PARAMETER AUTOMATION' },
  buf: { w: 5, dash: '', name: 'SAMPLE DATA (offline)' },
};

// Text and block styles, as presentation attributes rather than a <style> sheet:
// the app inlines this SVG under a CSP with no `style-src 'unsafe-inline'`
// (specs/features/signal-flow-map.md), which drops a <style> element and every
// style="" attribute. w weight · s size · f fill (a palette role) · ls letter
// spacing · it italic · mono monospace · stroke/sw a palette role and width.
export const TEXT_STYLES = {
  blk: { f: 'panel', stroke: 'edge', sw: 1.6 },
  bt: { w: 700, s: 17, f: 'text', ls: 0.8 },
  btag: { w: 600, s: 11.5, mono: 1, ls: 0.4 },
  bl: { s: 13.4, f: 'dim' },
  blb: { w: 700, s: 13.4, f: 'text' },
  blf: { it: 1, s: 12.8, f: 'faint' },
  mk: { w: 700, s: 12.5, f: 'dim', ls: 0.5 },
  pl: { w: 700, s: 12.5, ls: 0.3 },
  'pl-l': { w: 800, s: 11.5, f: 'panel' },
  wl: { w: 700, s: 12, ls: 0.4 },
  nt: { it: 1, s: 13, f: 'faint' },
  sn: { w: 700, s: 12.5, f: 'text', ls: 0.6 },
  sn2: { s: 11.5, f: 'faint', ls: 0.4 },
  sig: { w: 700 },
  vca: { w: 800, s: 18, ls: 1 },
  vbadge: { w: 800, s: 15, f: 'panel', ls: 2 },
  bdg: { w: 800, s: 10.5, f: 'panel', ls: 0.6 },
  rn: { w: 800, s: 19, f: 'bg' },
  rt: { w: 800, s: 26, f: 'heading', ls: 2 },
  rs: { it: 1, s: 16, f: 'faint' },
  bandt: { w: 800, s: 18, ls: 6 },
  frt: { w: 800, s: 15, ls: 1.5 },
  colh: { w: 800, s: 15, f: 'faint', ls: 2 },
  ct: { w: 800, s: 17, ls: 1.5 },
  cl: { s: 15, f: 'dim' },
  cb: { w: 700, s: 15, f: 'text' },
  lr: { w: 800, s: 46, f: 'text' },
  out: { w: 800, s: 30, f: 'heading', ls: 3 },
  h1: { w: 900, s: 78, f: 'heading', ls: 3 },
  h2: { w: 300, s: 64, f: 'text', ls: 14 },
  h3: { s: 21, f: 'dim' },
  h4: { it: 1, s: 17, f: 'faint' },
  ver: { w: 700, s: 22, mono: 1, f: 'faint' },
  kt: { w: 600, s: 14, f: 'dim', ls: 0.4 },
  lgh: { w: 800, s: 15, f: 'faint', ls: 2 },
  ft: { it: 1, s: 14, f: 'faint' },
};

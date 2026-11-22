// The icon <symbol>s every block, tile and legend entry <use>s, drawn in
// currentColor so one symbol serves every section colour and both palettes.

import { fpath, n, seeded } from './geometry.mjs';
import { SANS } from './theme.mjs';

const stroke = (w) => `fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;
const ST = stroke(2.6);
const STT = stroke(1.6);
const FILL = 'fill="currentColor" fill-opacity="0.22" stroke="currentColor" stroke-width="2" stroke-linejoin="round"';

export function iconSymbols() {
  const s = {};
  const sine = (x0, w, y0, a, cyc = 1, ph = 0) => fpath((t) => [x0 + w * t, y0 - a * Math.sin(2 * Math.PI * (cyc * t + ph))]);
  s.sine = ['0 0 80 48', `<path ${ST} d="${sine(4, 72, 24, 18)}"/>`];
  s.tri = ['0 0 80 48', `<path ${ST} d="M4 24 L22 6 L58 42 L76 24"/>`];
  s.saw = ['0 0 80 48', `<path ${ST} d="M4 40 L40 8 V40 L76 8 V40"/>`];
  s.square = ['0 0 80 48', `<path ${ST} d="M4 40 V8 H30 V40 H52 V8 H62 V40 H76"/>`];
  s.waves4 = ['0 0 212 44', [
    `<path ${ST} d="${sine(4, 42, 22, 16)}"/>`,
    `<path ${ST} d="M58 22 L68 6 L88 38 L98 22"/>`,
    `<path ${ST} d="M112 38 L132 6 V38 L152 6 V38"/>`,
    `<path ${ST} d="M166 38 V6 H180 V38 H194 V6 H200 V38 H208"/>`,
  ].join('')];
  const noiseRnd = seeded(11);
  s.noise = ['0 0 80 48', `<path ${stroke(1.8)} d="${fpath((t) => [4 + 72 * t, 24 + (noiseRnd() - 0.5) * 38], 46)}"/>`];
  s.adsr = ['0 0 80 48', `<path ${STT} stroke-dasharray="3 4" d="M4 44 H76"/><path ${ST} d="M4 44 L18 5 L32 22 H58 L76 44"/>`
    + `<g fill="currentColor" font-family="${SANS}" font-size="8" font-weight="700" text-anchor="middle"><text x="10" y="40">A</text><text x="28" y="40">D</text><text x="45" y="40">S</text><text x="68" y="40">R</text></g>`];
  s.filter = ['0 0 80 48', `<path ${STT} d="M4 45 H76 M4 4 V45"/><path ${ST} d="M6 18 H36 C44 18 46 4 50 8 C55 13 60 36 76 42"/>`];
  s.eq = ['0 0 80 48', `<path ${STT} stroke-dasharray="3 4" d="M4 26 H76"/><path ${ST} d="M4 30 C10 30 12 14 20 14 S30 36 38 36 S48 18 56 18 S68 30 76 28"/>`
    + `<g fill="currentColor"><circle cx="20" cy="14" r="3"/><circle cx="38" cy="36" r="3"/><circle cx="56" cy="18" r="3"/></g>`];
  s.dirt = ['0 0 80 48', `<path ${STT} stroke-dasharray="3 4" d="M4 13 H76 M4 35 H76"/><path ${ST} d="${fpath((t) => [4 + 72 * t, 24 - 11 * Math.max(-1, Math.min(1, 1.9 * Math.sin(2 * Math.PI * 1.5 * t)))])}"/>`];
  s.wah = ['0 0 80 48', `<path ${ST} d="M4 42 C26 42 30 10 40 10 C50 10 54 42 76 42"/><path ${STT} d="M22 4 H58 M22 4 l6 -3 M22 4 l6 3 M58 4 l-6 -3 M58 4 l-6 3"/>`];
  s.phaser = ['0 0 80 48', `<path ${ST} d="${fpath((t) => [4 + 72 * t, 10 + 32 * Math.pow(Math.abs(Math.cos(Math.PI * 2 * t + Math.PI / 2)), 6)], 90)}"/>`];
  s.flanger = ['0 0 80 48', `<path ${ST} d="${fpath((t) => [4 + 72 * t, 42 - 32 * Math.abs(Math.cos(Math.PI * 5 * t))], 120)}"/>`];
  s.chorus = ['0 0 80 48', `<path ${ST} d="${sine(4, 72, 24, 15, 1.5)}"/><path ${ST} stroke-opacity="0.5" d="${sine(4, 72, 24, 15, 1.5, 0.12)}"/>`];
  s.delay = ['0 0 80 48', `<path ${STT} d="M4 44 H76"/><path ${stroke(5)} d="M10 44 V6 M26 44 V16 M42 44 V24 M58 44 V31 M72 44 V36"/>`];
  const reverbRnd = seeded(5);
  s.reverb = ['0 0 80 48', `<path ${STT} d="M4 44 H76"/><path ${stroke(1.4)} d="${Array.from({ length: 24 }, (_, i) => {
    const x = 8 + i * 2.8;
    const h = 38 * Math.exp(-i / 9) * (0.55 + 0.45 * reverbRnd());
    return `M${n(x)} 44 V${n(44 - h)}`;
  }).join(' ')}"/><path ${ST} d="M8 6 C24 16 44 36 76 42"/>`];
  s.duck = ['0 0 80 48', `<path ${ST} d="M4 8 H12 L16 32 C22 32 26 8 36 8 H38 L42 32 C48 32 52 8 62 8 H76"/><g fill="currentColor"><path d="M12 46 l4 -7 l4 7 z"/><path d="M38 46 l4 -7 l4 7 z"/></g>`];
  s.pan = ['0 0 80 48', `<circle cx="40" cy="24" r="11" ${ST}/><path ${ST} d="M40 24 L46 15"/><path ${STT} d="M4 24 H24 M56 24 H76 M4 24 l6 -4 M4 24 l6 4 M76 24 l-6 -4 M76 24 l-6 4"/>`
    + `<g fill="currentColor" font-family="${SANS}" font-size="10" font-weight="700" text-anchor="middle"><text x="12" y="42">L</text><text x="68" y="42">R</text></g>`];
  s.comp = ['0 0 80 48', `<path ${ST} d="M10 42 A30 30 0 0 1 70 42"/><path ${STT} d="M16 30 l4 3 M26 20 l3 4 M40 15 v5 M54 20 l-3 4 M64 30 l-4 3"/><path ${stroke(3)} d="M40 42 L28 20"/><circle cx="40" cy="42" r="3" fill="currentColor"/>`
    + `<text x="58" y="40" fill="currentColor" font-family="${SANS}" font-size="9" font-weight="700">GR</text>`];
  s.dj = ['0 0 80 48', `<path ${STT} d="M4 45 H76"/><path ${ST} d="M4 12 H38 C48 12 50 34 56 44"/><path ${ST} stroke-opacity="0.55" d="M24 44 C30 34 32 12 42 12 H76"/>`];
  s.scope = ['0 0 80 48', `<rect x="3" y="3" width="74" height="42" rx="5" ${STT}/><path ${STT} stroke-opacity="0.4" d="M3 24 H77 M40 3 V45"/><path ${ST} d="${sine(8, 64, 24, 13, 2)}"/>`];
  s.speaker = ['0 0 64 64', `<path ${FILL} d="M8 22 H20 L36 8 V56 L20 42 H8 Z"/><path ${ST} d="M44 24 A12 12 0 0 1 44 40 M50 16 A22 22 0 0 1 50 48 M56 9 A32 32 0 0 1 56 55"/>`];
  s.piano = ['0 0 214 60', (() => {
    let g = '';
    for (let i = 0; i < 14; i++) g += `<rect x="${2 + i * 15}" y="2" width="15" height="56" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/>`;
    for (let o = 0; o < 2; o++) for (const k of [0, 1, 3, 4, 5]) g += `<rect x="${2 + o * 105 + k * 15 + 10}" y="2" width="10" height="34" rx="1.5" fill="currentColor"/>`;
    return g;
  })()];
  s.qwerty = ['0 0 214 60', (() => {
    let g = '';
    const lit = new Set(['0-1', '0-2', '0-4', '0-5', '0-6', '1-0', '1-1', '1-2', '1-3', '1-4', '1-5', '1-6']);
    for (let r = 0; r < 2; r++) for (let i = 0; i < 11; i++) {
      const x = 4 + r * 9 + i * 18.5;
      const y = 4 + r * 28;
      g += `<rect x="${n(x)}" y="${y}" width="15" height="22" rx="3" ${lit.has(`${r}-${i}`) ? FILL : STT}/>`;
    }
    return g;
  })()];
  s.din = ['0 0 64 56', `<circle cx="32" cy="28" r="24" ${ST}/><rect x="28" y="46" width="8" height="6" fill="currentColor"/>`
    + `<g fill="currentColor">${[180, 135, 90, 45, 0].map((a) => {
      const r = 15;
      const x = 32 + r * Math.cos((a * Math.PI) / 180);
      const y = 28 - r * Math.sin((a * Math.PI) / 180);
      return `<circle cx="${n(x)}" cy="${n(y)}" r="3"/>`;
    }).join('')}</g>`];
  s.wheels = ['0 0 80 56', `<rect x="18" y="4" width="16" height="48" rx="5" ${ST}/><rect x="46" y="4" width="16" height="48" rx="5" ${ST}/>`
    + `<path ${STT} d="M20 14 H32 M20 22 H32 M20 30 H32 M20 38 H32 M48 18 H60 M48 26 H60 M48 34 H60 M48 42 H60"/>`];
  s.xy = ['0 0 80 56', `<rect x="14" y="3" width="52" height="50" rx="4" ${ST}/><path ${STT} stroke-dasharray="2 4" d="M40 3 V53 M14 28 H66"/>`
    + `<path ${STT} d="M24 44 C30 30 40 34 52 16"/><circle cx="52" cy="16" r="5" fill="currentColor"/>`];
  s.livefx = ['0 0 80 56', `<rect x="8" y="4" width="28" height="22" rx="4" ${FILL}/><rect x="44" y="4" width="28" height="22" rx="4" ${STT}/><rect x="8" y="30" width="28" height="22" rx="4" ${STT}/><rect x="44" y="30" width="28" height="22" rx="4" ${STT}/>`
    + `<path fill="currentColor" d="M24 7 L15 17 H21 L18 24 L28 13 H22 Z"/>`];
  s.wifi = ['0 0 80 56', `<path ${ST} d="M14 22 A36 36 0 0 1 66 22 M22 31 A25 25 0 0 1 58 31 M30 40 A13 13 0 0 1 50 40"/><circle cx="40" cy="48" r="4" fill="currentColor"/>`];
  s.mic = ['0 0 80 56', `<rect x="30" y="2" width="20" height="32" rx="10" ${FILL}/><path ${ST} d="M22 24 A18 18 0 0 0 58 24 M40 42 V52 M30 53 H50"/>`];
  s.file = ['0 0 80 56', `<path ${ST} d="M22 2 H48 L60 14 V54 H22 Z M48 2 V14 H60"/><path ${STT} d="M28 34 V38 M33 28 V44 M38 31 V41 M43 24 V48 M48 30 V42 M53 33 V39"/>`];
  s.clock = ['0 0 80 56', `<circle cx="40" cy="28" r="24" ${ST}/><path ${ST} d="M40 28 V12 M40 28 L52 34"/>`
    + `<path ${STT} d="M40 6 v4 M62 28 h-4 M40 50 v-4 M18 28 h4"/>`];
  s.sync = ['0 0 80 56', `<path ${ST} d="M20 24 A20 20 0 0 1 58 18 M60 32 A20 20 0 0 1 22 38"/><path fill="currentColor" d="M58 8 L62 22 L49 19 Z M22 48 L18 34 L31 37 Z"/>`];
  s.arrange = ['0 0 80 56', (() => {
    const rows = [[[4, 22], [28, 22], [52, 24]], [[4, 34], [40, 36]], [[4, 14], [20, 14], [36, 14], [52, 24]], [[16, 30], [48, 28]]];
    return rows.map((r, i) => r.map(([x, w]) => `<rect x="${x}" y="${4 + i * 13}" width="${w - 3}" height="10" rx="2" ${i % 2 ? STT : FILL}/>`).join('')).join('');
  })()];
  s.metro = ['0 0 80 56', `<path ${FILL} d="M26 54 L34 4 H46 L54 54 Z"/><path ${ST} d="M40 46 L60 10"/><rect x="47" y="24" width="8" height="6" fill="currentColor" transform="rotate(-60 51 27)"/>`];
  s.chord = ['0 0 80 56', `<path ${STT} stroke-opacity="0.5" d="M6 12 H74 M6 22 H74 M6 32 H74 M6 42 H74"/>`
    + `<g fill="currentColor"><ellipse cx="34" cy="42" rx="7" ry="5"/><ellipse cx="34" cy="32" rx="7" ry="5"/><ellipse cx="34" cy="22" rx="7" ry="5"/></g><path ${ST} d="M41 42 V6"/>`];
  s.arp = ['0 0 80 56', `<path ${STT} stroke-opacity="0.5" d="M4 14 H76 M4 24 H76 M4 34 H76 M4 44 H76"/>`
    + `<g fill="currentColor">${[0, 1, 2, 3].map((i) => `<ellipse cx="${14 + i * 17}" cy="${46 - i * 10}" rx="6" ry="4.5"/>`).join('')}</g>`
    + `<path ${ST} d="${[0, 1, 2, 3].map((i) => `M${20 + i * 17} ${46 - i * 10} V${24 - i * 10 + 6}`).join(' ')}"/>`];
  s.seqgrid = ['0 0 80 56', (() => {
    const on = new Set(['0-0', '0-4', '1-2', '1-6', '2-1', '2-3', '2-5', '2-7', '3-0', '3-3', '3-6']);
    let g = '';
    for (let r = 0; r < 4; r++) for (let c = 0; c < 8; c++) g += `<rect x="${4 + c * 9.2}" y="${4 + r * 12.5}" width="7" height="10" rx="1.5" ${on.has(`${r}-${c}`) ? 'fill="currentColor"' : STT}/>`;
    return g;
  })()];
  s.drum = ['0 0 80 56', `<ellipse cx="40" cy="18" rx="26" ry="8" ${ST}/><path ${ST} d="M14 18 V42 A26 8 0 0 0 66 42 V18"/><path ${STT} d="M14 30 L66 30"/><path ${ST} d="M30 4 L52 16 M60 2 L46 14"/>`];
  s.pads = ['0 0 80 56', (() => {
    let g = '';
    for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) g += `<rect x="${4 + c * 19}" y="${4 + r * 25}" width="15" height="21" rx="3" ${r === 0 && c === 1 ? FILL : STT}/>`;
    return g;
  })()];
  s.motion = ['0 0 80 56', `<path ${ST} d="M4 46 C16 46 18 12 32 14 S48 40 56 36 S68 10 76 10"/><g fill="currentColor"><circle cx="4" cy="46" r="4"/><circle cx="32" cy="14" r="4"/><circle cx="56" cy="36" r="4"/><circle cx="76" cy="10" r="4"/></g>`];
  s.knobs = ['0 0 80 56', [14, 40, 66].map((x, i) => `<circle cx="${x}" cy="28" r="10" ${ST}/><path ${ST} d="M${x} 28 L${n(x + 9 * Math.sin([-2, 0.6, 2][i]))} ${n(28 - 9 * Math.cos([-2, 0.6, 2][i]))}"/>`).join('')];
  s.poly = ['0 0 80 56', [0, 1, 2].map((i) => `<rect x="${6 + i * 9}" y="${4 + i * 8}" width="46" height="30" rx="4" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-width="2"/>`).join('')
    + `<path ${ST} d="${sine(28, 34, 37, 7)}"/>`];
  s.matrix = ['0 0 80 56', `<path ${STT} stroke-opacity="0.6" d="M8 8 H72 M8 20 H72 M8 32 H72 M8 44 H72 M14 4 V50 M30 4 V50 M46 4 V50 M62 4 V50"/>`
    + `<g fill="currentColor"><circle cx="14" cy="20" r="4.5"/><circle cx="30" cy="8" r="4.5"/><circle cx="46" cy="44" r="4.5"/><circle cx="62" cy="32" r="4.5"/></g>`];
  s.random = ['0 0 80 48', `<path ${ST} d="M4 30 H16 V12 H28 V38 H40 V20 H52 V32 H64 V14 H76"/>`];
  s.vel = ['0 0 80 48', `<path ${stroke(5)} d="M10 44 V36 M24 44 V28 M38 44 V20 M52 44 V12 M66 44 V5"/>`];
  s.studio = ['0 0 80 56', `<path ${STT} d="${Array.from({ length: 22 }, (_, i) => {
    const x = 8 + i * 3;
    const a = 4 + 18 * Math.abs(Math.sin(i * 0.9)) * Math.exp(-i / 18);
    return `M${x} ${n(28 - a)} V${n(28 + a)}`;
  }).join(' ')}"/><path ${ST} d="M18 4 H12 V52 H18 M58 4 H64 V52 H58"/>`];
  s.record = ['0 0 80 56', `<circle cx="40" cy="28" r="22" ${ST}/><circle cx="40" cy="28" r="12" fill="currentColor"/>`];
  s.fader = ['0 0 80 56', `<path ${STT} d="M40 4 V52"/><rect x="28" y="18" width="24" height="12" rx="2" ${FILL}/><path ${STT} d="M22 10 H26 M22 24 H26 M22 38 H26 M22 50 H26"/>`];
  // Drum and sampler tiles.
  s.kick = ['0 0 56 48', `<circle cx="28" cy="24" r="20" ${ST}/><circle cx="28" cy="24" r="7" ${FILL}/>`];
  s.snare = ['0 0 56 48', `<ellipse cx="28" cy="15" rx="22" ry="6" ${ST}/><path ${ST} d="M6 15 V33 A22 6 0 0 0 50 33 V15"/><path ${STT} d="M10 24 L46 24 M14 30 L42 30"/>`];
  s.hatc = ['0 0 56 48', `<path ${ST} d="M6 22 Q28 12 50 22 M6 27 Q28 17 50 27"/><path ${STT} d="M28 4 V44"/>`];
  s.hato = ['0 0 56 48', `<path ${ST} d="M6 16 Q28 6 50 16 M6 32 Q28 22 50 32"/><path ${STT} d="M28 4 V44"/>`];
  s.tom = ['0 0 56 48', `<ellipse cx="28" cy="12" rx="18" ry="6" ${ST}/><path ${ST} d="M10 12 V36 A18 6 0 0 0 46 36 V12"/>`];
  s.clap = ['0 0 56 48', `<path ${FILL} d="M18 44 L12 18 Q12 12 18 13 L24 30 Z"/><path ${FILL} d="M38 44 L44 18 Q44 12 38 13 L32 30 Z"/><path ${STT} d="M28 4 V12 M18 6 L22 12 M38 6 L34 12"/>`];
  s.wavesm = ['0 0 56 48', `<path ${STT} d="${Array.from({ length: 16 }, (_, i) => {
    const x = 6 + i * 2.9;
    const a = 3 + 16 * Math.abs(Math.sin(i * 1.3 + 0.4)) * Math.exp(-i / 10);
    return `M${n(x)} ${n(24 - a)} V${n(24 + a)}`;
  }).join(' ')}"/>`];
  // The speaker's outer wave bulges past its viewBox: let it, rather than clip it flat.
  const OVERFLOW = new Set(['speaker']);
  return Object.entries(s)
    .map(([id, [vb, body]]) => `<symbol id="sf-i-${id}" viewBox="${vb}"${OVERFLOW.has(id) ? ' overflow="visible"' : ''}>${body}</symbol>`)
    .join('\n');
}

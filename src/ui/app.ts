import type { Engine } from '../audio/engine';
import type { ParamBus } from '../state/params';
import { WAVE_LABELS, LFO_DEST_LABELS, VOICING_LABELS, GLIDE_MODE_LABELS } from '../state/params';
import { Knob } from './components/knob';
import { Switch } from './components/switch';
import { Segmented } from './components/segmented';
import { Strip } from './components/strip';
import { Scope } from './components/scope';
import { Keyboard } from './components/keyboard';
import { TabContainer } from './components/tabs';
import { Dropdown } from './components/dropdown';
import { createButton, setButtonLabel } from './components/button';
import { createAboutButton } from './components/about';
import { Presets } from '../state/preset';
import { buildArpPanel } from './panels/arp-panel';
import { buildSeqPanel } from './panels/seq-panel';
import { buildDrumPanel } from './panels/drum-panel';
import { buildSamplerPanel } from './panels/sampler-panel';
import { buildSongPanel } from './panels/song-panel';

export function mountApp(root: HTMLElement, engine: Engine, bus: ParamBus): void {
  root.innerHTML = '';

  root.appendChild(buildHeader(engine, bus));
  root.appendChild(buildMain(bus));
  root.appendChild(buildFx(bus));
  root.appendChild(buildPatternRow(engine, bus));
  root.appendChild(buildBottom(engine, bus));
}

function panel(title: string, build: (body: HTMLElement) => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'panel';
  const t = document.createElement('div');
  t.className = 'panel-title';
  t.textContent = title;
  el.appendChild(t);
  const body = document.createElement('div');
  body.className = 'panel-body';
  build(body);
  el.appendChild(body);
  return el;
}

function buildHeader(engine: Engine, bus: ParamBus): HTMLElement {
  const el = document.createElement('div');
  el.className = 'header';

  // Brand block: VAST G1-J5 / Vast Audio Synthesis Technology
  const brand = document.createElement('div');
  brand.className = 'brand';
  const brandRow = document.createElement('div');
  brandRow.className = 'brand-row';
  const brandName = document.createElement('span');
  brandName.className = 'brand-name';
  brandName.textContent = 'VAST';
  const brandModel = document.createElement('span');
  brandModel.className = 'brand-model';
  brandModel.textContent = 'G1-J5';
  brandRow.appendChild(brandName);
  brandRow.appendChild(brandModel);
  const brandTag = document.createElement('div');
  brandTag.className = 'brand-tagline';
  brandTag.textContent = 'Vast Audio Synthesis Technology';
  brand.appendChild(brandRow);
  brand.appendChild(brandTag);
  el.appendChild(brand);

  const presetGroup = document.createElement('div');
  presetGroup.className = 'header-group';

  const dropdown = new Dropdown(Presets.list(), Presets.list()[0] ?? '');
  dropdown.onChange((name) => {
    const p = Presets.load(name);
    if (p) Presets.apply(bus, p);
  });

  const saveBtn = createButton({
    label: 'Save',
    onClick: () => {
      const name = prompt('Preset name:', dropdown.value);
      if (!name) return;
      Presets.save(name, Presets.capture(bus));
      dropdown.setOptions(Presets.list());
      dropdown.setValue(name);
    },
  });

  const presetLabel = document.createElement('span');
  presetLabel.textContent = 'Preset:';
  presetGroup.appendChild(presetLabel);
  presetGroup.appendChild(dropdown.el);
  presetGroup.appendChild(saveBtn);
  presetGroup.appendChild(createAboutButton());
  el.appendChild(presetGroup);

  const spacer = document.createElement('div');
  spacer.className = 'header-spacer';
  el.appendChild(spacer);

  // Transport group
  const transport = document.createElement('div');
  transport.className = 'header-group transport-group';

  const playBtn = createButton({
    label: 'Play',
    className: 'switch play-btn',
    led: true,
    onClick: () => {
      engine.clock.toggle();
      syncPlay();
    },
  });
  // Reflect the clock state so Panic/Esc (which stop the transport
  // directly) and the Space-bar shortcut all keep the button in sync.
  const syncPlay = () => {
    const playing = engine.clock.playing;
    playBtn.classList.toggle('on', playing);
    setButtonLabel(playBtn, playing ? 'Stop' : 'Play');
  };
  engine.clock.onStart(syncPlay);
  engine.clock.onStop(syncPlay);
  // Exposed so the Space-bar shortcut keeps the button visuals in sync.
  (window as any).__transportToggle = () => playBtn.click();
  transport.appendChild(playBtn);
  transport.appendChild(new Knob({ bus, paramId: 'transport.bpm', label: 'BPM' }).el);

  el.appendChild(transport);

  const right = document.createElement('div');
  right.className = 'header-group';

  const voicing = new Segmented(bus, 'voicing.mode', VOICING_LABELS);
  right.appendChild(voicing.el);

  const panicBtn = createButton({ label: 'Panic', onClick: () => engine.panic() });
  right.appendChild(panicBtn);

  const masterKnob = new Knob({ bus, paramId: 'master.volume', label: 'VOL' });
  right.appendChild(masterKnob.el);

  el.appendChild(right);

  return el;
}

function buildPatternRow(engine: Engine, bus: ParamBus): HTMLElement {
  const tabs = new TabContainer([
    { id: 'arp', label: 'Arpeggiator', content: buildArpPanel(bus) },
    { id: 'seq', label: 'Sequencer', content: buildSeqPanel(bus, engine) },
    { id: 'drums', label: 'Drum Machine', content: buildDrumPanel(bus, engine) },
    { id: 'sampler', label: 'Sampler', content: buildSamplerPanel(bus, engine) },
    { id: 'song', label: 'Song', content: buildSongPanel(bus, engine) },
  ], 'drums');
  tabs.el.classList.add('pattern-row');
  return tabs.el;
}

function buildMain(bus: ParamBus): HTMLElement {
  const main = document.createElement('div');
  main.className = 'main';

  main.appendChild(panel('OSC 1', (b) => {
    b.appendChild(new Segmented(bus, 'osc1.wave', WAVE_LABELS).el);
    b.appendChild(row([
      new Knob({ bus, paramId: 'osc1.octave', label: 'OCT' }).el,
      new Knob({ bus, paramId: 'osc1.detune', label: 'TUNE' }).el,
      new Knob({ bus, paramId: 'osc1.level', label: 'LEVEL' }).el,
    ]));
  }));

  main.appendChild(panel('OSC 2', (b) => {
    b.appendChild(new Segmented(bus, 'osc2.wave', WAVE_LABELS).el);
    b.appendChild(row([
      new Knob({ bus, paramId: 'osc2.octave', label: 'OCT' }).el,
      new Knob({ bus, paramId: 'osc2.detune', label: 'TUNE' }).el,
      new Knob({ bus, paramId: 'osc2.level', label: 'LEVEL' }).el,
    ]));
  }));

  main.appendChild(panel('SUB / UNI', (b) => {
    b.appendChild(new Segmented(bus, 'sub.wave', WAVE_LABELS).el);
    b.appendChild(row([
      new Knob({ bus, paramId: 'sub.octave', label: 'S.OCT' }).el,
      new Knob({ bus, paramId: 'sub.level', label: 'S.LVL' }).el,
    ]));
    b.appendChild(row([
      new Knob({ bus, paramId: 'unison.voices', label: 'UNISON' }).el,
      new Knob({ bus, paramId: 'unison.detune', label: 'SPREAD' }).el,
    ]));
  }));

  main.appendChild(panel('MIXER', (b) => {
    b.appendChild(row([
      new Knob({ bus, paramId: 'mixer.noise', label: 'NOISE' }).el,
      new Knob({ bus, paramId: 'mixer.glide', label: 'GLIDE' }).el,
      new Knob({ bus, paramId: 'analog.drift', label: 'DRIFT' }).el,
    ]));
    b.appendChild(new Segmented(bus, 'glide.mode', GLIDE_MODE_LABELS).el);
  }));

  main.appendChild(panel('FILTER', (b) => {
    b.appendChild(row([
      new Knob({ bus, paramId: 'filter.cutoff', label: 'CUTOFF' }).el,
      new Knob({ bus, paramId: 'filter.resonance', label: 'RESO' }).el,
    ]));
    b.appendChild(row([
      new Knob({ bus, paramId: 'filter.drive', label: 'DRIVE' }).el,
      new Knob({ bus, paramId: 'filter.envAmount', label: 'ENV' }).el,
    ]));
  }));

  main.appendChild(panel('AMP ENV', (b) => {
    b.appendChild(row([
      new Knob({ bus, paramId: 'env.amp.attack', label: 'A' }).el,
      new Knob({ bus, paramId: 'env.amp.decay', label: 'D' }).el,
      new Knob({ bus, paramId: 'env.amp.sustain', label: 'S' }).el,
      new Knob({ bus, paramId: 'env.amp.release', label: 'R' }).el,
    ]));
  }));

  main.appendChild(panel('FILTER ENV', (b) => {
    b.appendChild(row([
      new Knob({ bus, paramId: 'env.fil.attack', label: 'A' }).el,
      new Knob({ bus, paramId: 'env.fil.decay', label: 'D' }).el,
      new Knob({ bus, paramId: 'env.fil.sustain', label: 'S' }).el,
      new Knob({ bus, paramId: 'env.fil.release', label: 'R' }).el,
    ]));
  }));

  main.appendChild(panel('LFO', (b) => {
    b.appendChild(new Segmented(bus, 'lfo.wave', WAVE_LABELS).el);
    b.appendChild(row([
      new Knob({ bus, paramId: 'lfo.rate', label: 'RATE' }).el,
      new Knob({ bus, paramId: 'lfo.amount', label: 'AMT' }).el,
    ]));
    b.appendChild(new Segmented(bus, 'lfo.dest', LFO_DEST_LABELS).el);
  }));

  return main;
}

function buildFx(bus: ParamBus): HTMLElement {
  const fx = document.createElement('div');
  fx.className = 'fx-row';

  fx.appendChild(fxPanel('Distortion', bus, 'fx.dist.on', [
    { id: 'fx.dist.drive', label: 'DRIVE' },
    { id: 'fx.dist.tone', label: 'TONE' },
    { id: 'fx.dist.mix', label: 'MIX' },
  ]));

  fx.appendChild(fxPanel('Wah', bus, 'fx.wah.on', [
    { id: 'fx.wah.rate', label: 'RATE' },
    { id: 'fx.wah.depth', label: 'DEPTH' },
    { id: 'fx.wah.q', label: 'Q' },
  ]));

  fx.appendChild(fxPanel('Phaser', bus, 'fx.phaser.on', [
    { id: 'fx.phaser.rate', label: 'RATE' },
    { id: 'fx.phaser.depth', label: 'DEPTH' },
    { id: 'fx.phaser.feedback', label: 'FB' },
  ]));

  fx.appendChild(fxPanel('Delay', bus, 'fx.delay.on', [
    { id: 'fx.delay.time', label: 'TIME' },
    { id: 'fx.delay.feedback', label: 'FB' },
    { id: 'fx.delay.mix', label: 'MIX' },
  ]));

  fx.appendChild(fxPanel('Reverb', bus, 'fx.reverb.on', [
    { id: 'fx.reverb.size', label: 'SIZE' },
    { id: 'fx.reverb.damp', label: 'DAMP' },
    { id: 'fx.reverb.mix', label: 'MIX' },
  ]));

  return fx;
}

function fxPanel(title: string, bus: ParamBus, onParam: string, knobs: Array<{ id: string; label: string }>): HTMLElement {
  const el = document.createElement('div');
  el.className = 'fx-panel';

  const header = document.createElement('div');
  header.className = 'fx-header';
  const t = document.createElement('div');
  t.className = 'fx-title';
  t.textContent = title;
  header.appendChild(t);
  header.appendChild(new Switch(bus, onParam, 'on').el);
  el.appendChild(header);

  const knobsEl = document.createElement('div');
  knobsEl.className = 'fx-knobs';
  for (const k of knobs) {
    knobsEl.appendChild(new Knob({ bus, paramId: k.id, label: k.label }).el);
  }
  el.appendChild(knobsEl);

  return el;
}

function buildBottom(engine: Engine, bus: ParamBus): HTMLElement {
  const bottom = document.createElement('div');
  bottom.className = 'bottom';

  const top = document.createElement('div');
  top.className = 'bottom-top';

  const wheels = document.createElement('div');
  wheels.className = 'wheels';
  wheels.appendChild(new Strip({ bus, paramId: 'master.pitchBend', label: 'PITCH', springBack: true }).el);
  wheels.appendChild(new Strip({ bus, paramId: 'master.modWheel', label: 'MOD' }).el);
  top.appendChild(wheels);

  const scopeWrap = document.createElement('div');
  scopeWrap.className = 'scope-wrap';
  const scope = new Scope(engine.analyser);
  scopeWrap.appendChild(scope.el);
  const toggle = document.createElement('button');
  toggle.className = 'switch scope-toggle';
  toggle.textContent = 'Wave';
  let isWave = true;
  toggle.addEventListener('click', () => {
    isWave = !isWave;
    scope.setMode(isWave ? 'wave' : 'spectrum');
    toggle.textContent = isWave ? 'Wave' : 'Spectrum';
  });
  scopeWrap.appendChild(toggle);
  top.appendChild(scopeWrap);

  bottom.appendChild(top);

  const kbWrap = document.createElement('div');
  kbWrap.className = 'keyboard-wrap';
  const keyboard = new Keyboard({ bus, startOctave: 3, octaves: 3 });
  kbWrap.appendChild(keyboard.el);
  bottom.appendChild(kbWrap);

  // Expose for shortcuts module
  (window as any).__synthKeyboard = keyboard;

  // Light up the on-screen keys in time with the sequencer. The clock
  // schedules ~100 ms ahead, so defer each highlight to its audible moment.
  const seqTimers = new Set<number>();
  const at = (t: number, fn: () => void) => {
    const ms = Math.max(0, (t - engine.ctx.currentTime) * 1000);
    const id = window.setTimeout(() => { seqTimers.delete(id); fn(); }, ms);
    seqTimers.add(id);
  };
  engine.seq.onNote((note, when, releaseAt) => {
    at(when, () => keyboard.seqHighlight(note, true));
    at(releaseAt, () => keyboard.seqHighlight(note, false));
  });
  engine.clock.onStop(() => {
    for (const id of seqTimers) clearTimeout(id);
    seqTimers.clear();
    keyboard.clearSeqHighlights();
  });

  return bottom;
}

function row(children: HTMLElement[]): HTMLElement {
  const r = document.createElement('div');
  r.className = 'panel-row';
  for (const c of children) r.appendChild(c);
  return r;
}

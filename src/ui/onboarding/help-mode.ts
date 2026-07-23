// Help mode: while on, small (i) badges hover over each section; clicking one
// opens a contextual explanation in a Modal. While off there is zero added
// chrome, so the synth still looks like a real instrument.
import { Modal } from '../components/modal';
import { createButton } from '../components/button';
import switchStyles from '../styles/switch.module.css';
import styles from '../styles/tour.module.css';
import { HELP_TOPICS, type TopicId } from './help-content';
import type { ParamBus } from '../../state/params';

interface Anchor {
  topic: TopicId;
  /** Locate the element the badge should pin to (null = skip if absent). */
  find: () => Element | null;
  /**
   * Where to place the badge relative to its anchor. 'corner' (default) tucks
   * it into the anchor's top-right corner — good for full-width panels and
   * controls. 'after' sits just to the right of a content-width label so it
   * doesn't cover the text (the FX effect titles, whose on/off switch is pushed
   * to the far right, leaving a gap).
   */
  place?: 'corner' | 'after';
}

/** Badge diameter — keep in sync with `.badge` width/height in tour.module.css. */
const BADGE_SIZE = 20;

const byTestId = (id: string): Element | null => document.querySelector(`[data-testid="${id}"]`);
const byHelp = (name: string): Element | null => document.querySelector(`[data-help="${name}"]`);

// One anchor per topic (so `help-badge-<topic>` testids stay unique). Most pin
// to an existing data-testid; section panels pin via a `data-help` attribute.
const ANCHORS: Anchor[] = [
  { topic: 'transport', find: () => byTestId('transport-play') },
  { topic: 'transport.swing', find: () => byTestId('knob-transport.swing') },
  { topic: 'voicing', find: () => byTestId('seg-voicing.mode') },
  { topic: 'panic', find: () => byTestId('panic') },
  // The header's one door for sounds — save / export preset / export bank /
  // import-with-review (presets.md REQ-9, onboarding.md REQ-12).
  { topic: 'presets', find: () => byTestId('preset-save') },
  { topic: 'oscillators', find: () => byHelp('oscillators') },
  { topic: 'subuni', find: () => byHelp('subuni') },
  { topic: 'mixer', find: () => byHelp('mixer') },
  { topic: 'filter', find: () => byHelp('filter') },
  { topic: 'filter.cutoff', find: () => byTestId('knob-filter.cutoff') },
  { topic: 'filter.resonance', find: () => byTestId('knob-filter.resonance') },
  { topic: 'ampenv', find: () => byHelp('ampenv') },
  { topic: 'filterenv', find: () => byHelp('filterenv') },
  { topic: 'lfo', find: () => byHelp('lfo') },
  { topic: 'fx', find: () => byTestId('fx') },
  { topic: 'fx.dist', find: () => byHelp('fx.dist'), place: 'after' },
  { topic: 'fx.wah', find: () => byHelp('fx.wah'), place: 'after' },
  { topic: 'fx.phaser', find: () => byHelp('fx.phaser'), place: 'after' },
  { topic: 'fx.delay', find: () => byHelp('fx.delay'), place: 'after' },
  { topic: 'fx.reverb', find: () => byHelp('fx.reverb'), place: 'after' },
  // Pin to the group root, not the GR meter — the meter hides while the
  // compressor is bypassed (fx-group collapse) and help must stay reachable.
  { topic: 'fx.drum.comp', find: () => byTestId('fxgroup-fx.drum.comp') },
  { topic: 'fx.master.comp', find: () => byTestId('fxgroup-fx.master.comp') },
  { topic: 'arp', find: () => byTestId('tab-arp') },
  { topic: 'seq', find: () => byTestId('tab-seq') },
  { topic: 'seq.prob', find: () => byTestId('seq-prob') },
  { topic: 'seq.ratchet', find: () => byTestId('seq-ratchet') },
  { topic: 'seq.tie', find: () => byTestId('seq-tie') },
  // "Import into sampler" (render-to-sampler.md REQ-10): the section is
  // unexplained on screen and the two-pass render looks like a hang.
  { topic: 'seq.render', find: () => byTestId('seq-import-render') },
  { topic: 'drums', find: () => byTestId('tab-drums') },
  { topic: 'sampler', find: () => byTestId('tab-sampler') },
  { topic: 'motion', find: () => byTestId('tab-motion') },
  // Short per-lane Motion badges (onboarding.md REQ-14): pinned to the panel via
  // data-help, so they hide/reposition on tab switch like the other in-panel badges.
  { topic: 'motion.xy', find: () => byHelp('motion.xy') },
  { topic: 'motion.tracks', find: () => byHelp('motion.tracks') },
  { topic: 'song', find: () => byTestId('tab-song') },
  // Per-button badges on the Song panel's file/audio controls (the Save vs
  // Export confusion lives here). They pin to existing testids and reposition
  // /hide on tab switch via the same reflow path as the seq-step badges.
  { topic: 'song.load', find: () => byTestId('song-load') },
  { topic: 'song.save', find: () => byTestId('song-save') },
  { topic: 'song.import', find: () => byTestId('song-import') },
  { topic: 'song.export', find: () => byTestId('song-export') },
  { topic: 'song.new', find: () => byTestId('song-new') },
  { topic: 'song.exportAudio', find: () => byTestId('song-export-audio') },
  { topic: 'song.record', find: () => byTestId('song-record') },
  // Transport-sync section (Song tab): the mode control + the WiFi pairing button.
  { topic: 'sync', find: () => byTestId('sync-mode-master') },
  { topic: 'sync.wifi', find: () => byTestId('sync-wifi-link') },
  { topic: 'keyboard', find: () => byTestId('keyboard') },
  { topic: 'pitchBend', find: () => byTestId('strip-master.pitchBend') },
  { topic: 'transpose', find: () => byTestId('strip-keyboard.transpose') },
  { topic: 'modWheel', find: () => byTestId('strip-master.modWheel') },
  { topic: 'scope', find: () => byTestId('scope-toggle') },
  // Tempo "sweet spots" — delay times (ms) + LFO/phaser/wah rates (Hz). The
  // drum/sampler ones sit on their tabs and stay hidden until that panel lays
  // out (same reflow path as the Song per-button badges above).
  { topic: 'fx.delay.time', find: () => byTestId('knob-fx.delay.time') },
  { topic: 'lfo.rate', find: () => byTestId('knob-lfo.rate') },
  { topic: 'fx.wah.rate', find: () => byTestId('knob-fx.wah.rate') },
  { topic: 'fx.phaser.rate', find: () => byTestId('knob-fx.phaser.rate') },
  { topic: 'fx.drum.delay.time', find: () => byTestId('knob-fx.drum.delay.time') },
  { topic: 'fx.drum.phaser.rate', find: () => byTestId('knob-fx.drum.phaser.rate') },
  { topic: 'fx.sampler.delay.time', find: () => byTestId('knob-fx.sampler.delay.time') },
  { topic: 'fx.sampler.phaser.rate', find: () => byTestId('knob-fx.sampler.phaser.rate') },
  // Relationship explainers (live derived numbers).
  { topic: 'filter.envAmount', find: () => byTestId('knob-filter.envAmount') },
  { topic: 'unison.detune', find: () => byTestId('knob-unison.detune') },
  { topic: 'fx.drum.comp.threshold', find: () => byTestId('knob-fx.drum.comp.threshold') },
  { topic: 'fx.master.comp.threshold', find: () => byTestId('knob-fx.master.comp.threshold') },
];

export class HelpMode {
  private active = false;
  private layer: HTMLElement | null = null;
  private badges: Array<{ el: HTMLElement; anchor: Element; place: 'corner' | 'after'; inHeader: boolean }> = [];
  private rafQueued = false;
  private ro: ResizeObserver | null = null;
  private headerEl: Element | null = null;

  /** The bus is threaded in so dynamic (function) topic bodies can read live
   *  params — e.g. the BPM-aware delay "sweet spots". */
  constructor(private readonly bus: ParamBus) {}

  get isActive(): boolean {
    return this.active;
  }

  toggle(): void {
    if (this.active) this.disable();
    else this.enable();
  }

  enable(): void {
    if (this.active) return;
    this.active = true;

    const layer = document.createElement('div');
    layer.className = styles.badgeLayer!;
    layer.dataset.testid = 'help-badge-layer';
    document.body.appendChild(layer);
    this.layer = layer;
    this.headerEl = byTestId('app-header');

    for (const a of ANCHORS) {
      const anchor = a.find();
      if (!anchor) continue;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = styles.badge!;
      el.textContent = 'i';
      el.dataset.testid = `help-badge-${a.topic}`;
      el.setAttribute('aria-label', `Help: ${HELP_TOPICS[a.topic].title}`);
      el.addEventListener('click', () => this.openTopic(a.topic));
      layer.appendChild(el);
      this.badges.push({
        el,
        anchor,
        place: a.place ?? 'corner',
        inHeader: this.headerEl?.contains(anchor) ?? false,
      });
    }

    this.position();
    window.addEventListener('resize', this.reflow, true);
    window.addEventListener('scroll', this.reflow, true);
    // Collapsing/expanding a panel (or switching tabs) reflows the layout
    // without a scroll/resize event — and when the faceplate fits the viewport
    // the body doesn't even change height. So observe the containers that DO
    // resize on those toggles; any one resizing repositions every badge.
    this.ro = new ResizeObserver(() => this.reflow());
    this.ro.observe(document.body);
    for (const sel of ['[data-testid="fx"]', '[data-testid="pattern-row"]', '[data-testid="panel-seq"]']) {
      const el = document.querySelector(sel);
      if (el) this.ro.observe(el);
    }
  }

  disable(): void {
    if (!this.active) return;
    this.active = false;
    window.removeEventListener('resize', this.reflow, true);
    window.removeEventListener('scroll', this.reflow, true);
    this.ro?.disconnect();
    this.ro = null;
    this.layer?.remove();
    this.layer = null;
    this.badges = [];
    this.headerEl = null;
  }

  private readonly reflow = (): void => {
    if (this.rafQueued || !this.active) return;
    this.rafQueued = true;
    requestAnimationFrame(() => {
      this.rafQueued = false;
      if (this.active) this.position();
    });
  };

  private position(): void {
    // Bottom edge of the sticky header — content badges that scroll up into
    // this band must hide (they'd otherwise paint over the header).
    const headerBottom = this.headerEl?.getBoundingClientRect().bottom ?? 0;
    for (const { el, anchor, place, inHeader } of this.badges) {
      const r = anchor.getBoundingClientRect();
      // Hidden (collapsed/zero-size) anchors → hide the badge rather than pin
      // it to (0,0).
      if (r.width === 0 && r.height === 0) {
        el.style.display = 'none';
        continue;
      }
      let left: number;
      let top: number;
      if (place === 'after') {
        // Just right of a content-width label, vertically centred on it.
        left = r.right + 4;
        top = r.top + r.height / 2 - BADGE_SIZE / 2;
      } else {
        left = r.right - 14;
        top = r.top - 6;
      }
      // A content control scrolled under the sticky header → hide its badge.
      // Header-anchored controls (transport/voicing/panic) never scroll away.
      if (!inHeader && top < headerBottom) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    }
  }
  private openTopic(id: TopicId): void {
    const topic = HELP_TOPICS[id];
    const modal = new Modal({ title: topic.title });
    const content = document.createElement('div');
    content.className = Modal.metaClass;
    if (typeof topic.body === 'string') {
      content.innerHTML = topic.body;
    } else {
      // Dynamic body (BPM-aware "sweet spots" / relationship badges): build live
      // DOM with access to the bus and a close() for click-to-snap.
      content.appendChild(topic.body({ bus: this.bus, close: () => modal.close() }));
    }
    modal.body.appendChild(content);
    modal.body.appendChild(
      createButton({
        label: 'Close',
        className: `${switchStyles.root!} ${Modal.closeBtnClass}`,
        onClick: () => modal.close(),
      }),
    );
    modal.open();
  }
}

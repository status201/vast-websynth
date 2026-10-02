import type { ShellDeps } from './deps';
import type { Scope } from '../components/scope';
import type { ResizeHandle } from '../components/resize-handle';
import { Strip } from '../components/strip';
import { Keyboard } from '../components/keyboard';
import { keyboardRange, whiteKeyPx } from '../keyboard-range';
import { onKeyChange, readKeyState } from '../key-roles';
import { buildEqPanel } from '../panels/eq-panel';
import { isPhone } from '../viewport';
import { buildScopePanel } from './scope-panel';
import bottomStyles from '../styles/bottom.module.css';

/**
 * The bottom column: the PITCH/OCT/MOD strips beside the scope, the EQUALIZER
 * section, and the keyboard. Binds the bridge's `pressKey` / `releaseKey`, and
 * lights the keys for the key in play and for sequencer notes as they sound.
 * Returns the scope, whose fps and analyser size the header's performance
 * setting changes live.
 */
export function buildBottom(
  { engine, bus, bridge }: Pick<ShellDeps, 'engine' | 'bus' | 'bridge'>,
): { el: HTMLElement; scope: Scope; scopeResize: ResizeHandle } {
  const bottom = document.createElement('div');
  bottom.className = bottomStyles.bottom!;

  const top = document.createElement('div');
  top.className = bottomStyles.bottomTop!;

  const wheels = document.createElement('div');
  wheels.className = bottomStyles.wheels!;
  wheels.appendChild(new Strip({ bus, paramId: 'master.pitchBend', label: 'PITCH', springBack: true }).el);
  wheels.appendChild(new Strip({ bus, paramId: 'keyboard.transpose', label: 'OCT' }).el);
  wheels.appendChild(new Strip({ bus, paramId: 'master.modWheel', label: 'MOD' }).el);
  top.appendChild(wheels);

  const scopePanel = buildScopePanel(engine, bottom);
  top.appendChild(scopePanel.el);

  bottom.appendChild(top);

  // The EQUALIZER section, between the scope and the keyboard (equalizer.md
  // REQ-the-eq-is-a-third-bottom-row). It is the content-sized middle item of the same column: `--scope-h`
  // still sizes the scope row alone, so the scope's resize handle is untouched, and an
  // expanded EQ is absorbed by the keyboard's floor — the behaviour
  // scope.md REQ-a-scope-resize-handle already describes for a grown scope, now with a second
  // grower under it. Folded by default, so the resting layout costs only the bar.
  const eq = buildEqPanel(bus, engine);
  bottom.appendChild(eq.el);

  const kbWrap = document.createElement('div');
  kbWrap.className = bottomStyles.keyboardWrap!;
  kbWrap.dataset.testid = 'keyboard';
  // The octave count follows the width the keys get (keyboard-range.md): the base
  // range until laid out — 2 octaves on a phone, 3 elsewhere — then the observer,
  // which fires after layout and before paint, grows it on a wide screen so no
  // white key outgrows MAX_WHITE_PX. setRange is a no-op unless the count changes.
  // The same observation hands CSS the white-key width, which bounds the key
  // height (keyboard-range.md REQ-key-height-follows-key-width). Whole px, and written
  // only when it changes (runtime-performance.md REQ-dom-writes-are-guarded-on-what-is-rendered);
  // the width never depends on the height, so this cannot feed back.
  const phone = isPhone();
  const keyboard = new Keyboard({ bus, ...keyboardRange(0, phone) });
  kbWrap.appendChild(keyboard.el);
  if (typeof ResizeObserver !== 'undefined') {
    let keyW = '';
    new ResizeObserver((entries) => {
      const width = entries[entries.length - 1]!.contentRect.width;
      const range = keyboardRange(width, isPhone());
      keyboard.setRange(range);
      const next = `${whiteKeyPx(width, range.octaves)}px`;
      if (next !== keyW) bottom.style.setProperty('--kb-key-w', (keyW = next));
    }).observe(keyboard.el);
  }
  bottom.appendChild(kbWrap);

  // Visual-only: reflect computer-keyboard input on the on-screen keys. The note
  // itself is fired once by installShortcuts (bus.noteOn); highlighting here must
  // not also touch the bus or a single key double-fires. See input-control.md REQ-a-key-emits-exactly-one-note-on.
  bridge.pressKey = (n) => keyboard.highlight(n, true);
  bridge.releaseKey = (n) => keyboard.highlight(n, false);

  // Wear the current key, so which notes are in play is legible from where the fingers
  // already are rather than only on the KEY tab (scale-quantization.md REQ-the-key-is-shown-where-you-play). Wired
  // here, not inside Keyboard, so the component stays free of music theory. Chromatic
  // passes `null`: a restriction that restricts nothing is not worth drawing.
  onKeyChange(bus, () => {
    const state = readKeyState(bus);
    keyboard.setKeyRoles(state.active ? state : null);
  });

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

  return { el: bottom, scope: scopePanel.scope, scopeResize: scopePanel.scopeResize };
}

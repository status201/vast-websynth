import type { StudioApi } from '../studio-api';
import { Scope } from '../components/scope';
import { ResizeHandle } from '../components/resize-handle';
import {
  SCOPE_H_MIN, SCOPE_H_MAX, SCOPE_H_DEFAULT, SCOPE_H_STEP,
  readScopeHeight, writeScopeHeight,
} from '../../state/scope-height';
import { PERF_PROFILES, resolveTier } from '../../state/perf-mode';
import switchStyles from '../styles/switch.module.css';
import bottomStyles from '../styles/bottom.module.css';

/**
 * The scope panel: the CRT screen, the canvas, its Wave/Spectrum, Mono/Stereo
 * and Zones toggles, and the resize grip on its top edge (scope.md).
 *
 * The grip resizes `resizeTarget` — the bottom column, whose `--scope-h` sizes
 * the scope row, so the wheels beside it grow too. It writes the stored height
 * onto the target in its constructor, so build this before the column is
 * mounted and a taller scope is there from the first paint. The grip is returned
 * beside the scope, so its destroy() can sit wherever the scope's does.
 */
export function buildScopePanel(
  engine: StudioApi, resizeTarget: HTMLElement,
): { el: HTMLElement; scope: Scope; scopeResize: ResizeHandle } {
  // Read once here; the ResizeHandle below writes it onto the target in its
  // constructor (scope REQ-the-scope-height-persists). The CSS default covers "nothing stored".
  const scopeHeight = readScopeHeight();

  const scopeWrap = document.createElement('div');
  scopeWrap.className = bottomStyles.scopeWrap!;
  // Static CRT screen underlay (gradient + inset vignette) behind the transparent
  // canvas, so the 60fps redraw never re-rasters the decoration. (scope REQ-no-per-frame-layout-read)
  const scopeScreen = document.createElement('div');
  scopeScreen.className = bottomStyles.scopeScreen!;
  scopeWrap.appendChild(scopeScreen);
  const scope = new Scope(
    { mono: engine.analyser, left: engine.analyserL, right: engine.analyserR },
    { fps: PERF_PROFILES[resolveTier()].fps },
  );
  scopeWrap.appendChild(scope.el);
  let isWave = true;
  const toggle = overlayButton(bottomStyles.scopeToggle!, 'scope-toggle', 'Wave', () => {
    isWave = !isWave;
    scope.setMode(isWave ? 'wave' : 'spectrum');
    toggle.textContent = isWave ? 'Wave' : 'Spectrum';
    // The problem-band overlay only means anything over a frequency axis, so its
    // button rides the view rather than sitting on the panel forever (scope REQ-a-zones-toggle).
    zonesToggle.hidden = isWave;
  });
  scopeWrap.appendChild(toggle);
  // Mono/Stereo toggle — orthogonal to Wave/Spectrum. Defaults to Mono.
  let isStereo = false;
  const chanToggle = overlayButton(bottomStyles.scopeChannelsToggle!, 'scope-channels-toggle', 'Mono', () => {
    isStereo = !isStereo;
    scope.setChannels(isStereo ? 'stereo' : 'mono');
    chanToggle.textContent = isStereo ? 'Stereo' : 'Mono';
  });
  scopeWrap.appendChild(chanToggle);
  // Problem-frequency overlay — bottom-right, the one corner free of chrome, which
  // is also why the spectrum plot reserves a gutter there (scope REQ-a-zones-toggle). Hidden
  // until the view that gives it meaning is on screen; declared BEFORE the
  // Wave/Spectrum handler above runs, but after that button so tab order still
  // reads left-to-right, top-to-bottom.
  const zonesToggle = overlayButton(bottomStyles.scopeZonesToggle!, 'scope-zones-toggle', 'Zones', () => {
    const on = !scope.zonesOn;
    scope.setZones(on);
    zonesToggle.classList.toggle('on', on);
  });
  zonesToggle.title = 'Shade the four problem bands — mud, boxy, nasal, harsh';
  zonesToggle.hidden = true;
  scopeWrap.appendChild(zonesToggle);
  // Resize grip on the panel's top edge. A SIBLING of the canvas, like the two
  // toggles above — that is what keeps a press on it from reaching the canvas
  // click listener and resetting the peak-hold (scope REQ-clicking-the-graph-resets-the-peak/REQ-a-scope-resize-handle). It resizes
  // the shared grid row, so the PITCH/OCT/MOD strips grow with the scope.
  const scopeResize = new ResizeHandle({
    target: resizeTarget,
    cssVar: '--scope-h',
    min: SCOPE_H_MIN,
    max: SCOPE_H_MAX,
    initial: scopeHeight,
    defaultValue: SCOPE_H_DEFAULT,
    step: SCOPE_H_STEP,
    onCommit: writeScopeHeight,
    testId: 'scope-resize-handle',
    label: 'Scope height',
    title: 'Drag to resize the scope — double-click to reset',
    className: bottomStyles.scopeResize!,
  });
  scopeWrap.appendChild(scopeResize.el);
  return { el: scopeWrap, scope, scopeResize };
}

/** One of the switch-styled text buttons overlaid on the scope's corners; `cls` places it. */
function overlayButton(cls: string, testId: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = `${switchStyles.root!} ${cls}`;
  b.dataset.testid = testId;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

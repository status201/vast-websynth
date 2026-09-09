/**
 * Canvas text that stays readable on top of whatever is behind it.
 *
 * Hoisted out of `Scope` when the EQ graph needed the same treatment
 * (scope.md REQ-30, equalizer.md REQ-13). Both draw small mono labels over
 * saturated shapes — the Spectrum's bars, the EQ's filled curve — and the
 * alternative was a second copy that would drift the first time either was
 * tuned. It is deliberately a plain function rather than a mixin or a base
 * class: it needs nothing from either component but the 2D context.
 */

/**
 * A dark outline under the fill, so a label sitting on a full-height bar stays
 * legible. An outline rather than `shadowBlur`: omnidirectional, crisper at
 * 10px, and it does not reintroduce canvas shadows to components that dropped
 * them for cost (scope.md REQ-8). A handful of short strings a frame is a
 * different order of expense from shadowing every bar.
 *
 * Sets `lineWidth`, `lineJoin`, `strokeStyle` and `fillStyle` on the context and
 * does not restore them — every caller sets its own fill before its next draw,
 * and a `save`/`restore` pair per label was measurable in the Spectrum's loop.
 */
export function haloText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fill: string,
): void {
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

import type { NoteBend } from './transport/note-output';

/** The shortest ramp a bend is given — a linear ramp needs an end after its start. */
const MIN_BEND_S = 0.001;

/**
 * Schedule one note's bend on a voice's bend param, in cents
 * (step-settings.md REQ-bend-shapes-are-scoop-and-fall / REQ-a-bend-zero-schedules-nothing).
 *
 * `dirty` says whether the param may be away from 0 — a previous note bent it —
 * and the return value is the new flag. An unbent note on a clean param writes
 * nothing at all, so the default path is bit-identical to a voice without the
 * feature. Every other path cancels from `when` and **pins** a value there before
 * ramping: a bare cancel leaves Gecko ramping from the last *assigned* value
 * rather than the curve's (architecture.md, `tests/audio/no-unanchored-cancel.test.ts`),
 * and the cancel itself is what stops a stolen voice's scheduled fall from
 * landing on the new note.
 *
 * - scoop: pinned `semis` away at `when`, ramping to 0 by `when + dur`.
 * - fall: pinned at 0 at `when`, ramping to `semis` away by `when + dur`, then
 *   held until the next note on this voice resets it.
 */
export function scheduleBend(
  param: AudioParam,
  bend: NoteBend | undefined,
  when: number,
  dirty: boolean,
): boolean {
  if (!bend || !bend.semis) {
    if (!dirty) return false;
    param.cancelScheduledValues(when);
    param.setValueAtTime(0, when);
    return false;
  }
  const cents = bend.semis * 100;
  const end = when + Math.max(MIN_BEND_S, bend.dur);
  const [from, to] = bend.shape === 'fall' ? [0, cents] : [cents, 0];
  param.cancelScheduledValues(when);
  param.setValueAtTime(from, when);
  param.linearRampToValueAtTime(to, end);
  return true;
}

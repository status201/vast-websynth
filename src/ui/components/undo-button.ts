import { createButton } from './button';
import type { PatternUndo, UndoMachine } from '../../state/pattern-undo';

/**
 * Per-machine Undo button for the pattern panel headers (pattern-undo.md
 * REQ-9): testid `undo-<machine>`, disabled while that machine's stack is
 * empty (the shared switch `:disabled` look).
 */
export function createUndoButton(undo: PatternUndo, machine: UndoMachine): HTMLButtonElement {
  const btn = createButton({
    label: 'Undo',
    title: 'Undo the last grid edit (Ctrl+Z)',
    testId: `undo-${machine}`,
    onClick: () => undo.undo(machine),
  });
  const refresh = (): void => { btn.disabled = !undo.canUndo(machine); };
  refresh();
  undo.onChange(refresh);
  return btn;
}

/**
 * The open-modal stack, kept apart from `components/modal.ts` so a module can ask
 * "is a modal open?" without importing Modal's stylesheet — in this layer import
 * order is cascade order (src/ui/CLAUDE.md), and `shortcuts.ts` must not move
 * where the modal CSS lands.
 *
 * Holds every open (not yet closed) modal, oldest first; the last is the one on
 * top. See specs/recipes/add-a-modal-dialog.md (v5) and input-control.md
 * REQ-shortcuts-yield-to-an-open-modal.
 */
const stack: object[] = [];

export function pushModal(m: object): void {
  stack.push(m);
}

export function removeModal(m: object): void {
  const at = stack.indexOf(m);
  if (at >= 0) stack.splice(at, 1);
}

/** Whether `m` is the top modal — the only one that answers Escape. */
export function isTopModal(m: object): boolean {
  return stack[stack.length - 1] === m;
}

/** Whether any modal is open. One still fading out is closed already. */
export function anyModalOpen(): boolean {
  return stack.length > 0;
}

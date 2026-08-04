import { Modal } from './modal';
import { createButton } from './button';
import switchStyles from '../styles/switch.module.css';
import styles from '../styles/dialog.module.css';

/**
 * Promise-returning confirm / prompt / alert / choose dialogs — the styled
 * replacement for the browser's native `confirm()` / `prompt()` / `alert()`
 * (`chooseDialog` has no native counterpart). Each is a thin
 * layer over the shared {@link Modal} (backdrop / centred card / fade /
 * Escape-to-close / backdrop-click) that adds only the layout + a resolved
 * promise. Escape and a backdrop click both count as **cancel**; the promise
 * settles exactly once (a `settled` latch), mirroring `Modal.onClose`.
 *
 * See `specs/features/dialog.md`.
 */

export interface ConfirmOptions {
  title: string;
  message: string;
  /** Italic muted second paragraph below the message (supporting copy). */
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Render the affirmative button in a destructive (red) style. */
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  /** Optional label line shown above the input. */
  message?: string;
  /** Pre-filled value; selected on open so a retype overwrites it. */
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface AlertOptions {
  title: string;
  message: string;
  okLabel?: string;
}

/** One answer in a {@link chooseDialog}. `id` is what the promise resolves to. */
export interface Choice {
  id: string;
  label: string;
  /** Render this button in the destructive (red) style. */
  danger?: boolean;
}

export interface ChooseOptions {
  title: string;
  message: string;
  /** Italic muted second paragraph below the message (supporting copy). */
  detail?: string;
  /** Two or more, in button order. The **last** is the affirmative (focused). */
  choices: Choice[];
  /** Adds a leading dismiss button (resolving null). Omitted → Escape only. */
  cancelLabel?: string;
}

function messagePara(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = styles.message!;
  p.textContent = text;
  return p;
}

/** The italic muted supporting line under the message (REQ-7) — confirm + choose. */
function detailPara(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = `${styles.message!} ${styles.detail!}`;
  p.dataset.testid = 'dialog-detail';
  p.textContent = text;
  return p;
}

function actionsRow(): HTMLDivElement {
  const row = document.createElement('div');
  row.className = styles.actions!;
  return row;
}

/** A switch-styled action button; `danger` recolours it for destructive intent. */
function actionButton(
  label: string,
  testId: string,
  onClick: () => void,
  danger = false,
): HTMLButtonElement {
  const className = danger ? `${switchStyles.root!} ${styles.danger!}` : switchStyles.root!;
  return createButton({ label, className, testId, onClick });
}

/**
 * Ask a yes/no question. Resolves `true` on the affirmative button, `false` on
 * Cancel, Escape, or a backdrop click.
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const resolveOnce = (v: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const modal = new Modal({ title: opts.title, onClose: () => resolveOnce(false) });
    modal.body.appendChild(messagePara(opts.message));
    if (opts.detail) modal.body.appendChild(detailPara(opts.detail));

    const row = actionsRow();
    row.appendChild(actionButton(opts.cancelLabel ?? 'Cancel', 'dialog-cancel', () => modal.close()));
    const confirm = actionButton(
      opts.confirmLabel ?? 'OK',
      'dialog-confirm',
      () => { resolveOnce(true); modal.close(); },
      opts.danger,
    );
    row.appendChild(confirm);
    modal.body.appendChild(row);

    modal.open();
    confirm.focus();
  });
}

/**
 * Ask for a line of text. Resolves the input's current string on confirm (which
 * may be empty — callers keep their `if (!value) return` guard, like native
 * `prompt`), or `null` on Cancel, Escape, or a backdrop click.
 */
export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const resolveOnce = (v: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const modal = new Modal({ title: opts.title, onClose: () => resolveOnce(null) });
    if (opts.message) modal.body.appendChild(messagePara(opts.message));

    const input = document.createElement('input');
    input.type = 'text';
    input.className = styles.input!;
    input.dataset.testid = 'dialog-input';
    if (opts.defaultValue) input.value = opts.defaultValue;
    if (opts.placeholder) input.placeholder = opts.placeholder;

    const submit = (): void => { resolveOnce(input.value); modal.close(); };
    // Enter confirms. Escape is owned by Modal's capture-phase handler.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    modal.body.appendChild(input);

    const row = actionsRow();
    row.appendChild(actionButton(opts.cancelLabel ?? 'Cancel', 'dialog-cancel', () => modal.close()));
    row.appendChild(actionButton(opts.confirmLabel ?? 'OK', 'dialog-confirm', submit));
    modal.body.appendChild(row);

    modal.open();
    input.focus();
    input.select();
  });
}

/** Show a message with a single OK button. Resolves when dismissed. */
export function alertDialog(opts: AlertOptions): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const resolveOnce = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const modal = new Modal({ title: opts.title, onClose: () => resolveOnce() });
    modal.body.appendChild(messagePara(opts.message));

    const ok = createButton({
      label: opts.okLabel ?? 'OK',
      className: `${switchStyles.root!} ${Modal.closeBtnClass}`,
      testId: 'dialog-confirm',
      onClick: () => { resolveOnce(); modal.close(); },
    });
    modal.body.appendChild(ok);

    modal.open();
    ok.focus();
  });
}

/**
 * Ask a question whose answers are two (or more) **positive actions** rather
 * than yes/no. Resolves the chosen `id`; **every** dismissal — the optional
 * dismiss button, Escape, a backdrop click — resolves `null`.
 *
 * That null is the whole point (dialog.md REQ-8). A `confirmDialog` would have
 * to spend one of its two answers on `false`, which is also what Escape returns,
 * so dismissing it would silently *perform* the second action. Here "neither"
 * stays sayable, so a stray Escape does nothing.
 *
 * The **last** choice is the affirmative: it is focused on open and is what
 * Enter takes, so order the buttons with the likelier (or least destructive)
 * answer last.
 */
export function chooseDialog(opts: ChooseOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const resolveOnce = (v: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const modal = new Modal({ title: opts.title, onClose: () => resolveOnce(null) });
    modal.body.appendChild(messagePara(opts.message));
    if (opts.detail) modal.body.appendChild(detailPara(opts.detail));

    const row = actionsRow();
    if (opts.cancelLabel !== undefined) {
      row.appendChild(actionButton(opts.cancelLabel, 'dialog-cancel', () => modal.close()));
    }
    let affirmative: HTMLButtonElement | undefined;
    for (const choice of opts.choices) {
      affirmative = actionButton(
        choice.label,
        `dialog-choice-${choice.id}`,
        () => { resolveOnce(choice.id); modal.close(); },
        choice.danger,
      );
      row.appendChild(affirmative);
    }
    modal.body.appendChild(row);

    modal.open();
    affirmative?.focus();
  });
}

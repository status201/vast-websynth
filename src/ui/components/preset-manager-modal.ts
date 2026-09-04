import { Modal } from './modal';
import { createButton } from './button';
import { promptDialog } from './dialog';
import { showToast } from './toast';
import type { ParamBus } from '../../state/params';
import type { PresetSession } from '../../state/preset-session';
import { Presets, type Snapshot } from '../../state/preset';
import {
  buildBankFile, buildPresetFile, bankFilename, presetFilename, parsePresetPayload,
  planImport, type ImportPlan, type ImportPolicy, type PresetParse,
} from '../../state/preset-file';
import { buildFailureReport, isCapped } from '../failure-report';
import { copyText, flashCopied } from '../clipboard';
import switchStyles from '../styles/switch.module.css';
import segmentedStyles from '../styles/segmented.module.css';
import dialogStyles from '../styles/dialog.module.css';
import styles from '../styles/preset-manager.module.css';

/**
 * The preset manager — `specs/features/presets.md` REQ-9/REQ-10. One door for
 * everything you can do with a sound, rather than four sibling buttons in an
 * already-crowded header (ADR-014 law 1).
 *
 * Import is a **two-step wizard**: choosing a file never writes anything, it
 * moves the modal to a review list with a per-import conflict policy and a
 * confirm button that states the exact count. All of the decision-making is the
 * pure `planImport`; this file only renders it.
 */
export interface PresetManagerOptions {
  bus: ParamBus;
  session: PresetSession;
  /** Refresh the header dropdown after the stored set changes. */
  onPresetsChanged: () => void;
  /**
   * Open straight on the import review step with an already-parsed payload —
   * what the paste door hands over (paste-import.md REQ-7). A failed parse
   * lands on the home step showing its reason, exactly like a bad file.
   */
  initialImport?: PresetParse;
}

type BankScope = 'modified' | 'all';

/**
 * Replace a scroll box's contents with one row per message. `textContent`, never
 * `innerHTML`: every string here is quoted out of a file the user was handed.
 */
function fillRows(box: HTMLElement, cls: string, messages: string[]): void {
  box.innerHTML = '';
  for (const msg of messages) {
    const row = document.createElement('div');
    row.className = cls;
    row.textContent = msg;
    box.appendChild(row);
  }
}

function download(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function openPresetManagerModal(opts: PresetManagerOptions): void {
  const modal = new Modal({ title: 'Presets' });
  modal.body.dataset.testid = 'preset-manager';

  // ---- shared chrome ----
  const home = document.createElement('div');
  const review = document.createElement('div');
  review.dataset.testid = 'preset-import-review';
  review.style.display = 'none';
  modal.body.appendChild(home);
  modal.body.appendChild(review);

  const makeRow = (title: string, desc: string, testId: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = styles.row!;
    b.dataset.testid = testId;
    const t = document.createElement('span');
    t.className = styles.rowTitle!;
    t.textContent = title;
    const d = document.createElement('span');
    d.className = styles.rowDesc!;
    d.textContent = desc;
    b.appendChild(t);
    b.appendChild(d);
    return b;
  };

  // ================= step 1: home =================
  const rows = document.createElement('div');
  rows.className = styles.rows!;

  const saveRow = makeRow(
    'Save current sound',
    'Store the patch you are hearing under a name, in this browser.',
    'preset-mgr-save',
  );
  const exportPresetRow = makeRow(
    'Export preset (.preset.websynth.json)',
    'One file holding the sound you are hearing right now.',
    'preset-mgr-export-preset',
  );
  const exportBankRow = makeRow(
    'Export bank (.bank.websynth.json)',
    'One file holding many presets — for backup or sharing a whole set.',
    'preset-mgr-export-bank',
  );
  const importRow = makeRow(
    'Import…',
    'Read a preset or bank file. You review what lands before anything is written.',
    'preset-mgr-import',
  );
  rows.append(saveRow, exportPresetRow, exportBankRow, importRow);
  home.appendChild(rows);

  // Bank scope — which presets the bank export includes (REQ-8).
  let scope: BankScope = 'modified';
  const scopeRow = document.createElement('div');
  scopeRow.className = styles.scopeRow!;
  const scopeLabel = document.createElement('span');
  scopeLabel.className = styles.scopeLabel!;
  scopeLabel.textContent = 'Bank:';
  scopeRow.appendChild(scopeLabel);

  const scopeSel = document.createElement('div');
  scopeSel.className = segmentedStyles.root!;
  const scopeBtns: HTMLButtonElement[] = [];
  const bankNames = (s: BankScope): string[] => (s === 'all' ? Presets.list() : Presets.modified());
  ([['modified', 'Mine'], ['all', 'All']] as [BankScope, string][]).forEach(([value, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.testid = `preset-mgr-bank-scope-${value}`;
    if (value === scope) b.classList.add('active');
    b.addEventListener('click', () => {
      scope = value;
      for (const c of scopeBtns) c.classList.toggle('active', c === b);
      renderHome();
    });
    b.textContent = label;
    scopeBtns.push(b);
    scopeSel.appendChild(b);
  });
  scopeRow.appendChild(scopeSel);
  home.appendChild(scopeRow);

  const scopeNote = document.createElement('p');
  scopeNote.className = styles.note!;
  home.appendChild(scopeNote);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.style.display = 'none';
  fileInput.dataset.testid = 'preset-mgr-file';
  home.appendChild(fileInput);

  const homeActions = document.createElement('div');
  homeActions.className = dialogStyles.actions!;
  homeActions.appendChild(createButton({
    label: 'Close',
    className: switchStyles.root!,
    testId: 'preset-mgr-close',
    onClick: () => modal.close(),
  }));
  home.appendChild(homeActions);

  function renderHome(): void {
    const names = bankNames(scope);
    exportBankRow.disabled = names.length === 0;
    scopeNote.textContent = names.length === 0
      ? 'Nothing to export yet — save a sound, or switch to All for the factory set.'
      : `${names.length} preset${names.length === 1 ? '' : 's'}: ${names.slice(0, 6).join(', ')}${names.length > 6 ? '…' : ''}`;
  }

  // ---- actions ----
  saveRow.addEventListener('click', () => {
    void (async () => {
      const name = await promptDialog({
        title: 'Save preset',
        message: 'Preset name:',
        defaultValue: opts.session.label,
        confirmLabel: 'Save',
      });
      if (!name) return;
      const snap = Presets.capture(opts.bus);
      Presets.save(name, snap);
      // The saved patch becomes the new double-tap reset target — the pre-v4
      // behaviour, kept here so Save has exactly one implementation.
      opts.bus.setBaselines(snap);
      opts.session.setActive(name);
      opts.onPresetsChanged();
      renderHome();
      showToast({ message: `Saved preset "${name}"`, testId: 'preset-toast' });
    })();
  });

  exportPresetRow.addEventListener('click', () => {
    // The LIVE sound, not a stored slot: Export and Save must never disagree
    // about what "this preset" means (REQ-9).
    const name = opts.session.label;
    download(presetFilename(name), buildPresetFile(name, Presets.capture(opts.bus)));
  });

  exportBankRow.addEventListener('click', () => {
    const names = bankNames(scope);
    if (names.length === 0) return;
    const name = scope === 'all' ? 'websynth-all' : 'websynth-bank';
    download(bankFilename(name), buildBankFile(name, Presets.entries(names)));
  });

  importRow.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    void (async () => {
      const f = fileInput.files?.[0];
      fileInput.value = '';
      if (!f) return;
      // With the bus the registry checks run too — as warnings, so a preset from
      // a newer build still imports (preset-authoring.md REQ-8).
      const parsed = parsePresetPayload(await f.text(), opts.bus);
      if (!parsed.ok) {
        showErrors(parsed.errors, f.name);
        return;
      }
      incoming = parsed.presets;
      incomingWarnings = parsed.warnings ?? [];
      showReview();
    })();
  });

  // ================= step 2: import review =================
  let incoming: Record<string, Snapshot> = {};
  /** What the parse warned about — shown on the review step, never blocking. */
  let incomingWarnings: string[] = [];
  let policy: ImportPolicy = 'rename';

  const reviewIntro = document.createElement('p');
  reviewIntro.className = styles.note!;
  review.appendChild(reviewIntro);

  const list = document.createElement('div');
  list.className = styles.reviewList!;
  review.appendChild(list);

  const policyRow = document.createElement('div');
  policyRow.className = styles.scopeRow!;
  const policyLabel = document.createElement('span');
  policyLabel.className = styles.scopeLabel!;
  policyLabel.textContent = 'Name clash:';
  policyRow.appendChild(policyLabel);

  const policySel = document.createElement('div');
  policySel.className = segmentedStyles.root!;
  const policyBtns: HTMLButtonElement[] = [];
  ([['rename', 'Keep both'], ['overwrite', 'Overwrite'], ['skip', 'Skip']] as [ImportPolicy, string][])
    .forEach(([value, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.dataset.testid = `preset-import-policy-${value}`;
      if (value === policy) b.classList.add('active');
      b.addEventListener('click', () => {
        policy = value;
        for (const c of policyBtns) c.classList.toggle('active', c === b);
        renderReview();
      });
      policyBtns.push(b);
      policySel.appendChild(b);
    });
  policyRow.appendChild(policySel);
  review.appendChild(policyRow);

  // ---- the problem strip (REQ-16) ----
  // A count line, every message in a scroll box built from the review list's
  // metrics, and a Copy control. It used to be one <div> holding errors[0].
  const errorBlock = document.createElement('div');
  errorBlock.dataset.testid = 'preset-import-errors';
  errorBlock.style.display = 'none';

  const errors = document.createElement('div');
  errors.className = styles.errors!;
  errorBlock.appendChild(errors);

  const errorList = document.createElement('div');
  errorList.className = `${styles.reviewList!} ${styles.errorList!}`;
  errorBlock.appendChild(errorList);

  const errorActions = document.createElement('div');
  errorActions.className = styles.errorActions!;
  const COPY_LABEL = 'Copy errors';
  let errorReport = '';
  const copyErrors: HTMLButtonElement = createButton({
    label: COPY_LABEL,
    className: switchStyles.root!,
    testId: 'preset-import-copy',
    // Built from the message array, not read back off the rows (REQ-16).
    onClick: () => flashCopied(copyErrors, COPY_LABEL, copyText(errorReport)),
  });
  errorActions.appendChild(copyErrors);
  errorBlock.appendChild(errorActions);
  home.insertBefore(errorBlock, homeActions);

  // ---- the warning block (REQ-16) ----
  // On the review step, beside the rows the user is deciding about. A warning
  // says what will not survive the load, so it never blocks Import.
  const warnBlock = document.createElement('div');
  warnBlock.dataset.testid = 'preset-import-warnings';
  warnBlock.style.display = 'none';
  const warnHead = document.createElement('div');
  warnHead.className = styles.warnHead!;
  warnBlock.appendChild(warnHead);
  const warnList = document.createElement('div');
  warnList.className = `${styles.reviewList!} ${styles.warnList!}`;
  warnBlock.appendChild(warnList);
  review.appendChild(warnBlock);

  const reviewActions = document.createElement('div');
  reviewActions.className = dialogStyles.actions!;
  reviewActions.appendChild(createButton({
    label: 'Back',
    className: switchStyles.root!,
    testId: 'preset-import-back',
    onClick: () => showHome(),
  }));
  const confirmBtn = createButton({
    label: 'Import',
    className: switchStyles.root!,
    testId: 'preset-import-confirm',
    onClick: () => applyImport(),
  });
  reviewActions.appendChild(confirmBtn);
  review.appendChild(reviewActions);

  const CHIP: Record<string, string> = {
    new: styles.chipNew!,
    identical: styles.chipIdentical!,
    conflict: styles.chipConflict!,
  };

  let plan: ImportPlan = { rows: [], writes: [], counts: { new: 0, identical: 0, conflict: 0, writes: 0 } };

  function renderReview(): void {
    plan = planImport(incoming, Presets.entries(Presets.list()), policy);
    list.innerHTML = '';
    for (const row of plan.rows) {
      const el = document.createElement('div');
      el.className = styles.reviewRow!;
      el.dataset.testid = `preset-import-row-${row.source}`;

      const name = document.createElement('span');
      name.className = styles.reviewName!;
      name.textContent = row.source;
      el.appendChild(name);

      // Only show a target when the policy actually moves it — otherwise the
      // arrow is noise on every single row.
      if (row.target !== row.source) {
        const target = document.createElement('span');
        target.className = styles.reviewTarget!;
        target.textContent = `→ ${row.target}`;
        el.appendChild(target);
      }

      const chip = document.createElement('span');
      chip.className = `${styles.chip!} ${CHIP[row.status] ?? ''}`;
      chip.textContent = row.status;
      el.appendChild(chip);
      list.appendChild(el);
    }

    const c = plan.counts;
    const parts = [`${c.new} new`];
    if (c.conflict) parts.push(`${c.conflict} clashing`);
    if (c.identical) parts.push(`${c.identical} already identical`);
    reviewIntro.textContent = `This file holds ${plan.rows.length} preset${plan.rows.length === 1 ? '' : 's'} — ${parts.join(', ')}. Your current sound is not touched.`;
    policyRow.style.display = c.conflict ? '' : 'none';
    confirmBtn.disabled = c.writes === 0;
    confirmBtn.textContent = c.writes === 0
      ? 'Nothing to import'
      : `Import ${c.writes} preset${c.writes === 1 ? '' : 's'}`;

    // What the file gets wrong but can still be loaded with (REQ-16). Rendered
    // here, next to the decision, and never touching confirmBtn.disabled.
    const w = incomingWarnings;
    warnBlock.style.display = w.length === 0 ? 'none' : '';
    warnHead.textContent = `${w.length} ${w.length === 1 ? 'warning' : 'warnings'} — it will import anyway`;
    fillRows(warnList, styles.warnRow!, w);
  }

  function applyImport(): void {
    for (const w of plan.writes) {
      const snap = incoming[w.source];
      if (snap) Presets.save(w.target, snap);
    }
    const n = plan.writes.length;
    opts.onPresetsChanged();
    modal.close();
    showToast({
      message: `Imported ${n} preset${n === 1 ? '' : 's'} — pick one from the Preset menu`,
      testId: 'preset-toast',
    });
  }

  /**
   * Report a refused file — **every** message it produced (REQ-16). This strip is
   * the only place they are ever shown: the paste door raises no dialog of its
   * own, so its failures land here too.
   */
  function showErrors(list_: string[], file?: string): void {
    const n = list_.length;
    errors.textContent = n === 0
      ? 'Could not read that file.'
      : `${n} ${n === 1 ? 'problem' : 'problems'} — nothing was imported`;

    fillRows(errorList, styles.errorRow!, list_);
    errorList.style.display = n === 0 ? 'none' : '';
    errorActions.style.display = n === 0 ? 'none' : '';
    errorReport = buildFailureReport({
      title: 'Preset import failed', file, errors: list_, capped: isCapped(list_),
    });
    errorBlock.style.display = '';
  }

  function showHome(): void {
    errorBlock.style.display = 'none';
    review.style.display = 'none';
    home.style.display = '';
    renderHome();
  }

  function showReview(): void {
    errorBlock.style.display = 'none';
    home.style.display = 'none';
    review.style.display = '';
    renderReview();
  }

  renderHome();
  // A pasted payload skips step 1 entirely: the user already chose what to
  // import, so landing on the file-picker home would be a step backwards.
  if (opts.initialImport) {
    if (opts.initialImport.ok) {
      incoming = opts.initialImport.presets;
      incomingWarnings = opts.initialImport.warnings ?? [];
      showReview();
    } else {
      // The paste door shows no errors of its own (paste-import.md REQ-7), so
      // this strip is the only place a bad pasted payload is ever explained.
      showErrors(opts.initialImport.errors, 'pasted text');
    }
  }
  modal.open();
}

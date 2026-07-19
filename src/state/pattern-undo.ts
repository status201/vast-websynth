import type { PatternStore, PatternMutation } from './patterns';
import { UndoHistory } from './undo';

/**
 * Per-machine step-grid undo (`specs/features/pattern-undo.md`): four
 * independent stacks (seq/drum/sampler/motion) recording the pre-state of
 * every `PatternStore` mutation via its `onMutate` hook, so every caller —
 * panel clicks, StepSettingsEditor drags, the seq note dial, motion pads,
 * BankBar copies — is covered at one choke point. `restore()` (song load /
 * import / New / session-undo) fires `onBulkRestore`, which clears all
 * stacks: stale bank history must never survive a load.
 *
 * Undo applies into the bank the change was made in — switching the edit
 * bank back first when needed — through the standard setters, so panels
 * repaint and the session autosave arms exactly as for a hand edit.
 */
export type UndoMachine = 'seq' | 'drum' | 'sampler' | 'motion';

const MACHINES: readonly UndoMachine[] = ['seq', 'drum', 'sampler', 'motion'];

function machineOf(m: PatternMutation): UndoMachine {
  switch (m.kind) {
    case 'seq': case 'seq-copy': return 'seq';
    case 'drum': case 'drum-copy': return 'drum';
    case 'sampler': case 'sampler-copy': return 'sampler';
    default: return 'motion';
  }
}

/** Same-target key so a drag coalesces into one undo step; copies never do. */
function coalesceKey(m: PatternMutation): string | undefined {
  switch (m.kind) {
    case 'seq': return `seq:${m.bank}:${m.index}`;
    case 'drum': return `drum:${m.bank}:${m.track}:${m.step}`;
    case 'sampler': return `sampler:${m.bank}:${m.slot}:${m.step}`;
    case 'motion': return `motion:${m.bank}:${m.index}`;
    case 'motion-assign': return `motion-assign:${m.bank}`;
    default: return undefined;
  }
}

export class PatternUndo {
  private readonly stacks: Record<UndoMachine, UndoHistory<PatternMutation>>;
  private applying = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly patterns: PatternStore,
    opts?: { depth?: number; coalesceMs?: number },
  ) {
    this.stacks = {
      seq: new UndoHistory(opts),
      drum: new UndoHistory(opts),
      sampler: new UndoHistory(opts),
      motion: new UndoHistory(opts),
    };
    for (const m of MACHINES) this.stacks[m].onChange(() => this.emit());

    patterns.onMutate((m) => {
      if (this.applying) return; // undo must never record undo (REQ-8)
      this.stacks[machineOf(m)].push(m, coalesceKey(m));
    });
    patterns.onBulkRestore(() => this.clearAll());
  }

  canUndo(m: UndoMachine): boolean {
    return this.stacks[m].size > 0;
  }

  /** Revert the machine's most recent edit; no-op while its stack is empty. */
  undo(machine: UndoMachine): void {
    const entry = this.stacks[machine].pop();
    if (!entry) return;
    this.applying = true;
    try {
      this.apply(entry);
    } finally {
      this.applying = false;
    }
  }

  clearAll(): void {
    for (const m of MACHINES) this.stacks[m].clear();
  }

  /** Fires whenever any machine's stack size changes (buttons repaint). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /**
   * Write an entry's pre-state back through the standard setters. Mutations
   * always target the edit bank, so first navigate the edit bank to the
   * entry's bank (REQ-5) — the revert is then visible where it happens.
   */
  private apply(entry: PatternMutation): void {
    const p = this.patterns;
    switch (entry.kind) {
      case 'seq':
        p.setSeqEditBank(entry.bank);
        p.setSeqStep(entry.index, { ...entry.before });
        break;
      case 'drum':
        p.setDrumEditBank(entry.bank);
        p.setDrumCell(entry.track, entry.step, { ...entry.before });
        break;
      case 'sampler':
        p.setSamplerEditBank(entry.bank);
        p.setSamplerCell(entry.slot, entry.step, { ...entry.before });
        break;
      case 'motion':
        p.setMotionEditBank(entry.bank);
        p.setMotionStep(entry.index, { ...entry.before });
        break;
      case 'motion-assign':
        p.setMotionEditBank(entry.bank);
        p.setMotionAssign(entry.before ? { ...entry.before } : null);
        break;
      case 'seq-copy':
        p.setSeqEditBank(entry.bank);
        entry.before.forEach((s, i) => p.setSeqStep(i, { ...s }));
        break;
      case 'drum-copy':
        p.setDrumEditBank(entry.bank);
        entry.before.forEach((row, t) => row.forEach((c, s) => p.setDrumCell(t, s, { ...c })));
        break;
      case 'sampler-copy':
        p.setSamplerEditBank(entry.bank);
        entry.before.forEach((row, t) => row.forEach((c, s) => p.setSamplerCell(t, s, { ...c })));
        break;
      case 'motion-copy':
        p.setMotionEditBank(entry.bank);
        entry.before.forEach((s, i) => p.setMotionStep(i, { ...s }));
        p.setMotionAssign(entry.beforeAssign ? { ...entry.beforeAssign } : null);
        break;
    }
  }
}

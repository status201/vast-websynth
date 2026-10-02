import type { StudioApi } from '../studio-api';
import type { ParamBus } from '../../state/params';
import type { PresetSession } from '../../state/preset-session';
import type { XyPadStore } from '../../state/xy-pad';
import type { PatternUndo } from '../../state/pattern-undo';
import type { UiBridge } from '../ui-bridge';

/**
 * Everything the app shell is built from, as `main.ts` hands it to `mountApp`.
 * Each region takes only the slice it reads — `Pick<ShellDeps, …>` in its
 * signature — so a region's dependencies are visible at a glance and a new
 * one is a type error at the one call site, not a seventh positional argument.
 */
export interface ShellDeps {
  engine: StudioApi;
  bus: ParamBus;
  bridge: UiBridge;
  session: PresetSession;
  xy: XyPadStore;
  patternUndo: PatternUndo;
}

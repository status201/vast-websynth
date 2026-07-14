/**
 * Restore to Factory Settings — wipe every piece of device-local state and
 * reload into the boot-time defaults (specs/features/factory-reset.md).
 *
 * The reload is mandatory: clearing storage does not reset live in-memory
 * state (ParamBus values, pattern banks, the preset index read at boot), and
 * perf-mode's audio knobs are boot-time-only. `reload` is injectable so the
 * helper is testable under jsdom, where `location.reload` is unimplemented.
 */
export function restoreFactorySettings(reload: () => void = () => location.reload()): void {
  try { localStorage.clear(); } catch { /* storage may be unavailable */ }
  try { sessionStorage.clear(); } catch { /* storage may be unavailable */ }
  reload();
}

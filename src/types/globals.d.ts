// Build-time constants injected by Vite's `define` (vite.config.ts). Declared
// once here rather than per module that reads them.

/** `package.json`'s version, stamped at build time. Compare and key on this one. */
declare const __APP_VERSION__: string;

/**
 * The version plus SemVer build metadata, e.g. `2.22.1+7.c09145c` (commits past
 * the release tag, then the commit; `.dirty` for uncommitted changes). Display
 * only — never parse or compare it (build-id.md REQ-two-constants-release-and-build).
 */
declare const __APP_BUILD__: string;

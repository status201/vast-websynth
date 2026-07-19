import { defineConfig } from 'vitest/config';

/**
 * Check-only runner for the demo canonicalizer (`npm run check:demos`). Same
 * entry as `clean:demos`, but `CLEAN_DEMOS_CHECK` (injected here — env-in-config
 * keeps the npm script cross-platform) makes it write nothing and fail on any
 * demo that isn't byte-identical to its canonical pretty-printed form. Run by CI
 * so a minified drop-in can't land unnoticed.
 */
export default defineConfig({
  test: {
    include: ['scripts/clean-demos.ts'],
    environment: 'node',
    env: { CLEAN_DEMOS_CHECK: '1' },
  },
});

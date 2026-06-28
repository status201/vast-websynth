import { defineConfig } from 'vitest/config';

/**
 * Isolated runner for the demo canonicalizer (`npm run clean:demos`). Kept out of
 * the main suite — vite.config.ts globs `tests/**`, and this entry rewrites source
 * files rather than asserting. vitest is used only because it is the one
 * Vite-aware TS runner available (Node can't resolve extensionless imports).
 */
export default defineConfig({
  test: {
    include: ['scripts/clean-demos.ts'],
    environment: 'node',
  },
});

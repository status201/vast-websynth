import { defineConfig } from 'vitest/config';

/**
 * Isolated runner for the parameter-reference generator (`npm run gen:params`).
 * Kept out of the main suite — vite.config.ts globs `tests/**`, and this entry
 * writes files rather than asserting. vitest is used only because it is the one
 * Vite-aware TS runner available (Node can't resolve extensionless imports).
 */
export default defineConfig({
  test: {
    include: ['scripts/gen-params.ts'],
    environment: 'node',
  },
});

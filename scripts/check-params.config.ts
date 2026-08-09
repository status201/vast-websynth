import { defineConfig } from 'vitest/config';

/**
 * Check-only runner for the parameter-reference generator
 * (`npm run check:params`). Same entry as `gen:params`, but `GEN_PARAMS_CHECK`
 * (injected here — env-in-config keeps the npm script cross-platform) makes it
 * write nothing and fail on any published file that isn't byte-identical to its
 * generated form. Run by CI so a parameter added without regenerating can't ship.
 */
export default defineConfig({
  test: {
    include: ['scripts/gen-params.ts'],
    environment: 'node',
    env: { GEN_PARAMS_CHECK: '1' },
  },
});

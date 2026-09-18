/**
 * E2E against an **installed** Chrome instead of Playwright's pinned Chromium.
 * `npm run e2e:chrome`; see `e2e/CLAUDE.md`.
 *
 * Why this exists: `npx playwright install` fetches its browser from
 * `cdn.playwright.dev`, which 307-redirects to `storage.googleapis.com`. Where
 * the route to that host black-holes — an IPv6 path with no working fallback is
 * the case this was written for, and a locked-down network behaves the same — the
 * installer's 30 s request timeout fires and there is no browser to run at all.
 * `channel: 'chrome'` uses whatever Chrome is already on the machine.
 *
 * This is a **local escape hatch, not the contract.** CI runs the pinned build,
 * which is the one the suite is written against; a spec that passes under only
 * one of the two has found a real difference rather than a flake. The known ones:
 * real Chrome throttles background tabs where the headless shell does not (which
 * `motion.spec.ts` REQ-the-motion-frame-loop-is-visibility-independent exercises), and parallelism costs more, so prefer
 * `E2E_WORKERS=1` here.
 *
 * There is no Firefox equivalent — Playwright drives a *patched* Gecko build, so
 * a stock Firefox cannot stand in for it.
 */
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  // Layered over every project rather than a copy of them, so this file cannot
  // drift from the viewport, launch flags and timeouts the real config sets.
  projects: (base.projects ?? []).map((p) => ({
    ...p,
    use: { ...p.use, channel: 'chrome' as const },
  })),
});

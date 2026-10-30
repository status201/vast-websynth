import notes from './demo-notes.json';

/**
 * The demos' hand-written blurbs, filename → text (demo-library.md
 * REQ-demo-prose-lives-apart). **Lazy-only** (REQ-the-blurbs-load-after-boot):
 * the prose is most of what the demo index used to weigh and grows with every
 * demo, while the boot path needs none of it. The library imports this inside
 * its own chunk; the Song panel `import()`s it on idle to fill its tooltips.
 * Never import it from a module on the boot path.
 */
export const DEMO_BLURBS: Readonly<Record<string, string>> = notes;

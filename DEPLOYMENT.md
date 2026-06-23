# Deployment

WebSynth is a static site. Build, then serve the output folder.

```bash
npm run build   # → dist/
```

Deploy the **contents of `dist/`** as the web root. It contains the hashed
`index.html`, `dist/assets/` (JS/CSS), and `dist/worklets/` (the AudioWorklets,
copied from `public/`). Any static host works (Netlify, Vercel, GitHub Pages,
S3, nginx, …). HTTPS is required for the AudioWorklet API and MIDI.

## Hosting at the domain root (default)

No configuration needed. Serve `dist/` at `https://example.com/`.

## Hosting in a subfolder

The AudioWorklets are loaded by **absolute path** (`/worklets/recorder.js`,
`/worklets/ladder-filter.js`). With the default config they resolve to the
domain root, so under a subpath they 404 and audio never starts.

To host at e.g. `https://example.com/synth/`, set `base` in
`vite.config.ts`:

```ts
export default defineConfig({
  base: '/synth/',   // must match the subfolder, leading + trailing slash
  // …
});
```

Then rebuild (`npm run build`) and deploy `dist/` into that subfolder. Vite
rewrites the asset and worklet URLs to `/synth/…` accordingly.

## Versioned releases

`npm run release -- <version|major|minor|patch>` (`scripts/release.mjs`, zero
dependencies) cuts a versioned release artifact. It:

1. Bumps `package.json` and promotes the CHANGELOG `[Unreleased]` section to a
   dated heading.
2. Runs `npm run build`.
3. Zips `dist/` into **`dist-v<version>.zip`** (the deployable build).
4. Writes the release notes to `dist-v<version>.notes.md`.
5. **Prints** the exact `git` (commit / tag / push) and `gh release create …`
   commands. It never touches git or GitHub itself — nothing is published until
   you run the printed commands.

```bash
npm run release -- 1.4.0            # explicit version
npm run release -- minor            # or major / minor / patch
npm run release -- 1.4.0 --dry-run  # preview; write/build nothing
```

Flags:

| Flag | Effect |
| --- | --- |
| `--dry-run` | Preview the changes; write and build nothing. |
| `--yes`, `-y` | Skip the confirmation prompt. |
| `--skip-build` | Bump the files but skip the build + zip (e.g. `dist/` is already built). |
| `--help`, `-h` | Show usage. |

Attaching the zip to the GitHub release needs the [`gh` CLI](https://cli.github.com/)
authenticated (`gh auth status`); the printed playbook includes a manual
browser-upload fallback if you don't have it. Both `dist-v<version>.zip` and the
notes file are gitignored (`dist-v*`).

**To deploy a published release:** download `dist-v<version>.zip` from the GitHub
release, unzip it, and serve the **contents of the `dist/` folder** as the web
root (see the top of this file). The zip's `dist/` is byte-for-byte the same
build the release was cut from.

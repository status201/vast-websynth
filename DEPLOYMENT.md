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

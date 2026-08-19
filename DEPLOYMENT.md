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

## Security headers

The **Content-Security-Policy is a `<meta>` tag in `index.html`**, so it ships
with the build and needs no host configuration anywhere
(`specs/features/untrusted-input.md` REQ-10).

Three headers cannot be set that way — `frame-ancestors` / `X-Frame-Options` are
ignored in `<meta>`, and the others are transport-level — so `dist/_headers`
carries them in **Netlify / Cloudflare Pages** format, where it is picked up
automatically. It is an inert text file on every other host, so **if you deploy
elsewhere, set these yourself**:

```
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: geolocation=(), payment=(), interest-cohort=()
```

<details>
<summary>nginx</summary>

```nginx
add_header X-Frame-Options            "DENY"        always;
add_header X-Content-Type-Options     "nosniff"     always;
add_header Referrer-Policy            "no-referrer" always;
add_header Permissions-Policy         "geolocation=(), payment=(), interest-cohort=()" always;
```
</details>

<details>
<summary>Vercel (<code>vercel.json</code>)</summary>

```json
{
  "headers": [{
    "source": "/(.*)",
    "headers": [
      { "key": "X-Frame-Options",        "value": "DENY" },
      { "key": "X-Content-Type-Options", "value": "nosniff" },
      { "key": "Referrer-Policy",        "value": "no-referrer" }
    ]
  }]
}
```
</details>

<details>
<summary>Apache (<code>.htaccess</code>)</summary>

```apache
Header always set X-Frame-Options "DENY"
Header always set X-Content-Type-Options "nosniff"
Header always set Referrer-Policy "no-referrer"
```
</details>

**GitHub Pages and S3 (without CloudFront) cannot set response headers at all.**
The `<meta>` CSP still applies there; the app is simply framable. That is an
accepted trade-off for those hosts, not an oversight.

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

### Before a major version

A major bump is the only time backward-compatibility shims may be dropped. They
are listed here rather than in the code they live in, because the question "can
this go yet?" is only ever asked at release time. **Add a row whenever you leave
one behind; delete the row when you remove it.**

| Shim | Since | Why it exists | Safe to drop when |
| --- | --- | --- | --- |
| `websynth.session` read fallback (`state/session-autosave.ts`) | 2.9 | Sessions moved to one key per tab ([session-autosave](specs/features/session-autosave.md) REQ-12). The old single key is still read once so an in-progress session survives the upgrade; it is never written. | Anyone who has opened the app since 2.9 has been migrated by their first autosave. Dropping it only costs a user who has not opened it since — their unsaved session, not their saved songs. |

Song *file* versions are not on this list: they are additive by design and every
version from v1 still loads with no migration step (ADR-007), so a major bump is
not a licence to stop reading them.

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

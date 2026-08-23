# Deployment

WebSynth is a static site. Build, then serve the output folder. (The repo also
ships an *optional* MCP server you can host alongside it — that is a separate,
skippable artifact; see [Hosting the MCP server](#hosting-the-mcp-server). The
app itself never talks to it and works exactly the same without it.)

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

## Hosting the MCP server

Optional, and entirely separate from the static site. `mcp-v<version>.zip`
contains a small Node server that exposes the song/preset authoring tools over
**Streamable HTTP**, so anyone can add them as a Claude connector without
cloning this repo:

```bash
claude mcp add --transport http websynth https://vast.status201.com/mcp
```

It is **authless and read-only** — eight tools, all pure functions over a public
document format, no filesystem writes. See
[mcp-server](specs/features/mcp-server.md) REQ-9/10/11 for the contract and
[ADR-020](specs/decisions/adr-020-remote-mcp-is-authless-and-read-only.md) for
why those two go together.

> **Never enable a Node.js application on the site's own domain.** Plesk's
> Node.js extension puts Phusion Passenger in front of the whole document root,
> which changes how static files are served. `/worklets/*.js` must arrive with a
> JavaScript MIME type or `audioWorklet.addModule` throws and **the app loads but
> makes no sound**; `/sw.js` must stay at root scope, and `/site.webmanifest`
> must keep its type. The layout below keeps Passenger on a subdomain of its own
> and reaches it by proxy, so nginx serves `dist/` for every path but `/mcp`.

### Getting the bundle

`npm run release` produces `mcp-v<version>.zip`, but you usually want it *before*
committing to a version number — deploy the server, point Claude at it, find out
whether the Plesk config is right. So:

```bash
npm run pack:mcp                 # -> mcp-v<version>.zip
npm run pack:mcp -- --out /tmp/x.zip
```

It touches nothing else: no version bump, no CHANGELOG, no git. Both paths call
the same packer, so what you test is byte-for-byte the layout a release ships.
The only difference is a provenance line in the bundle's `README.txt` recording
the commit it came from and whether the tree was dirty — worth reading when you
are trying to work out what a box is actually running.

### Requirements

- Node **≥ 20**, and **prefer an even-numbered major**. The bundle is compiled
  `target: 'node20'` and uses no API newer than that, so 20.x is exactly what it
  was built for. Odd majors (21, 23, …) are never LTS: they stop getting security
  patches within months of release, and Plesk panels often still list one — a box
  offering "21.7.3 or 20.20.2" should be set to **20.20.2**, which is both LTS and
  years newer despite the lower number. That matters more here than for most apps,
  because this endpoint is public and unauthenticated, so its HTTP parser is
  reachable by anyone.
- **No dependencies.** There is no `dependencies` block (ADR-003) — do not run
  `npm install` on the server; there is nothing to install.
- The zip ships `dist/song-core.mjs` prebuilt. The deployed entry deliberately
  does *not* self-build ([mcp-server](specs/features/mcp-server.md) REQ-3): a
  missing bundle fails loudly at boot rather than shelling out to a bundler on
  an unauthenticated request.

### Plesk, panel only (no shell)

1. **Add a subdomain** — e.g. `mcp.status201.com` — and enable **Let's Encrypt**
   on it.
2. Unzip `mcp-v<version>.zip` and put the **contents of `websynth-mcp/`** in the
   subdomain's **Application Root**, *not* in `httpdocs`. Nothing in the bundle
   should be publicly downloadable; Passenger serves the app, not the folder.
3. **Node.js** on that subdomain:

   | Field | Value |
   | --- | --- |
   | Node.js version | the newest **LTS** the panel offers — 20.x or above (see below) |
   | Application Root | where you unzipped (one level above Document Root) |
   | Document Root | `httpdocs` — leave it empty |
   | Application Startup File | `app.js` |
   | Application Mode | production |

   Do **not** click "NPM install".
4. On **`vast.status201.com`** → *Apache & nginx Settings* → **Additional nginx
   directives**:

   ```nginx
   location ^~ /mcp {
       proxy_pass            https://mcp.status201.com/;
       proxy_ssl_server_name on;
       proxy_set_header      Host mcp.status201.com;
       proxy_set_header      X-Forwarded-Proto https;
       proxy_set_header      X-Forwarded-For $remote_addr;
       proxy_http_version    1.1;
       client_max_body_size  1m;
       proxy_read_timeout    30s;
   }
   ```

   - `^~` stops any regex `location` Plesk injects from claiming the path, and
     the longer prefix already beats the document root's `location /`. Every
     other path keeps being served from `dist/` exactly as before.
   - The trailing `/` on `proxy_pass` strips the `/mcp` prefix, so the app is
     reached at `/`. It accepts the POST on any path
     ([mcp-server](specs/features/mcp-server.md) REQ-9e), so the mount point is
     not baked into the code.
   - **`X-Forwarded-For` is overwritten (`$remote_addr`), not appended.** The
     rate limiter keys on the first hop; appending would let an unauthenticated
     caller choose its own bucket by sending the header itself. This is the one
     line the code cannot enforce, and the first thing to check if the limiter
     ever looks ineffective.
   - `client_max_body_size 1m` mirrors `MAX_MCP_REQUEST_BYTES`, so oversized
     bodies are refused at the edge and never reach Node.

### With root SSH (simpler, if you have it)

Skip the subdomain. Run `app.js` under a systemd unit on `127.0.0.1:8787`
(`PORT` and `HOST` are read from the environment) and change the directive's
first four lines to a single `proxy_pass http://127.0.0.1:8787;`. Nothing else
differs.

### Verifying a deploy

**Check the subdomain first, then the proxy.** In that order the two failures
cannot be confused: the first says whether the Node app runs at all, the second
whether nginx reaches it. Doing it the other way round makes one error message
stand for both problems.

```bash
# 1. The app itself, straight at the origin — no proxy involved.
curl -s https://mcp.status201.com/healthz            # {"ok":true,"version":"…"}
```

If that fails, nothing below can pass: fix the Plesk Node.js app first (see
"When it doesn't work"). If it succeeds:

```bash
# 2. Through the proxy on the main domain.
#    NOTE the path: the directive matches `^~ /mcp` and proxy_pass's trailing
#    slash strips that prefix, so the health check is /mcp/healthz — /healthz at
#    the root is NOT proxied and will always be Plesk's own 404.
curl -s  https://vast.status201.com/mcp/healthz      # {"ok":true,"version":"…"}
curl -si https://vast.status201.com/mcp | head -1    # 405 — there is no SSE stream
curl -s  https://vast.status201.com/mcp -X POST \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'   # 8 tools, no save_*
```

### When it doesn't work

The failure tells you which half is wrong, if you read what produced it:

| What you see on `/mcp` | What it means |
| --- | --- |
| A **Plesk error page** (`<!DOCTYPE html>`, `/error_docs/styles.css`) — 404 or 403 | nginx never proxied: the request was served by the static site. The `location ^~ /mcp` block is missing, wasn't saved, or Plesk rejected the config. Nothing reached Node. |
| **502 / 504** | The block *is* live and nginx tried, but could not reach the upstream. The Node app is stopped, or the subdomain's certificate/SNI is failing. |
| **405** with `Allow: POST` | It works. That is our answer — `GET` offers no stream by design (REQ-9b). |
| A JSON-RPC body | It works. |

The distinction that matters: **a Plesk-styled error page is never from us.** This
server only ever answers JSON, so any HTML means the request did not get to it.

The same rule applies one level down, on the **subdomain** itself:

| What you see on `https://<subdomain>/healthz` | What it means |
| --- | --- |
| A **Plesk 404** | nginx served that subdomain *statically* — Passenger never saw the request. Node.js is not enabled or not running on it, so an empty `httpdocs` answered instead. Start with step 1 below. |
| A **Passenger error page** or a **500** | Passenger *is* wired in and tried to start the app, and the app failed. This is the good kind of failure: the reason is in the log (step 4). |
| **JSON** | The app is healthy. Any remaining problem is the nginx directive on the main domain, not the server. |

A clean static 404 and a Passenger error mean opposite things — the first says the
runtime was never invoked, the second says it was. Reading which one you have
saves checking the app for a fault that is really a panel toggle.

Plesk specifics worth checking, in order:

1. **Node.js is enabled on the subdomain at all.** The panel's button is a
   toggle: if it reads *"Enable Node.js"* it is currently **off**, and nginx is
   serving `httpdocs` statically. It should read *"Disable Node.js"*. This is the
   usual cause of a clean Plesk 404 on the subdomain.
2. The **Application Startup File is `app.js`**, and the files sit in the
   *Application Root* — `app.js` and `dist/song-core.mjs` directly in it, **not**
   in `httpdocs`. Put them in `httpdocs` and Passenger never finds the entry.
3. **Restart App** after replacing any file. Plesk does not pick up changes on
   its own, so a fixed deploy can keep serving the broken one.
4. **Apache & nginx Settings → Additional nginx directives** on the *main* domain
   actually contains the block, and the page was **saved without an error**.
   Plesk validates the config on save and refuses invalid input — a block that
   never applied often means a save that silently failed.
5. Node's own output: the app logs `[websynth-mcp] ready (http, v…)` on a
   successful boot, and a missing `dist/song-core.mjs` fails loudly at start
   rather than at the first request.

The half that actually breaks — **the static site must be unchanged**:

```bash
curl -si https://vast.status201.com/worklets/ladder-filter.js | grep -i content-type
curl -si https://vast.status201.com/sw.js | grep -i content-type
curl -si https://vast.status201.com/site.webmanifest | head -1
```

Then hard-reload the site and **confirm it makes sound** — that is the real
assertion behind the worklet MIME type; a header check can pass while the
browser still refuses the module. Check DevTools → Application → Service Workers
still shows the worker active at scope `/`.

Finally, add the connector from a machine that has never cloned this repo.

### Firewall

Anthropic's outbound traffic comes from `160.79.104.0/21`. Nothing needs
allowlisting for an open endpoint, but if a WAF or fail2ban sits in front, that
range must not be throttled — Claude's request pattern can resemble scraping.

## Versioned releases

`npm run release -- <version|major|minor|patch>` (`scripts/release.mjs`, zero
dependencies) cuts a versioned release artifact. It:

1. Bumps `package.json` and promotes the CHANGELOG `[Unreleased]` section to a
   dated heading.
2. Runs `npm run build`.
3. Zips `dist/` into **`dist-v<version>.zip`** (the deployable build).
4. Runs `npm run build:mcp` and zips the MCP server into
   **`mcp-v<version>.zip`** — see [Hosting the MCP server](#hosting-the-mcp-server).
5. Writes the release notes to `dist-v<version>.notes.md`.
6. **Prints** the exact `git` (commit / tag / push) and `gh release create …`
   commands. It never touches git or GitHub itself — nothing is published until
   you run the printed commands.

Both zips go on the same GitHub release. They are independent: the site can be
updated without redeploying the MCP server and vice versa.

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
| `websynth.session` read fallback (`state/session-autosave.ts`) | 2.9 | Sessions moved to one key per browser tab ([session-autosave](specs/features/session-autosave.md) REQ-12). The old single key is still read once so an in-progress session survives the upgrade; it is never written. | Anyone who has opened the app since 2.9 has been migrated by their first autosave. Dropping it only costs a user who has not opened it since — their unsaved session, not their saved songs. |

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

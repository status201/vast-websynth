# Build id (which build is running)

```yaml
id: build-id
status: implemented
version: 1
owner: core
related:
  - version-skew     # compares __APP_VERSION__, never the build id
  - failure-report   # its context header names the build id
  - play-offline     # the offline manifest records __APP_VERSION__
source:
  - scripts/lib/build-id.mjs          # formatBuildId + buildId
  - vite.config.ts                    # the two defines
  - src/types/globals.d.ts            # their declarations
  - src/ui/components/about-modal.ts  # shows __APP_BUILD__
  - src/ui/components/about-debug.ts  # opens the debug report with it
  - src/ui/failure-report.ts          # opens the failure report with it
```

## Background / Why

The app knows its version from `package.json`, stamped in at build time. A build
made from commits after a release carried the release's number unchanged, so the
About card of a dev or preview build passed for the release itself, and a
screenshot or a bug report could not say which code was running. The build id adds
SemVer build metadata — how far past the release, and at which commit — while the
release number that other code compares and keys on stays exactly what it was.

## Requirements

- **REQ-two-constants-release-and-build** — The build defines two strings (Vite
  `define` in `vite.config.ts`, declared in `src/types/globals.d.ts`).
  `__APP_VERSION__` is `package.json`'s version and is what code **compares or keys
  on**: version-skew's `isNewerVersion`, the service worker's `?v=`, the offline
  manifest. `__APP_BUILD__` is for **display** only, and nothing parses it.
- **REQ-build-id-counts-commits-past-the-release** — `__APP_BUILD__` is
  `<version>+<n>.<hash>`, where `n` is the number of commits since the tag
  `v<version>` and `hash` is HEAD's abbreviated commit (7 characters, more when
  git needs them to be unique), both from
  `git describe --tags --long --dirty --abbrev=7 --match v<version>`. Example:
  `2.22.1+7.c09145c`.
- **REQ-a-modified-tree-says-so** — When the working tree has uncommitted changes
  to tracked files, the build id ends in `.dirty` (`2.22.1+7.c09145c.dirty`, and
  `2.22.1+0.c09145c.dirty` on the tag itself): the commit alone does not name the
  code that was built.
- **REQ-a-release-build-reads-the-plain-version** — `__APP_BUILD__` is the plain
  version when `n` is 0 on a clean tree (built on the release tag) and when no tag
  `v<version>` exists, dirty or not. The second case is `npm run release`, which bumps `package.json` and
  builds before its commit and tag exist: the tag is matched by the version
  exactly, never the nearest one, so a release is never measured against the
  previous release's tag.
- **REQ-build-id-never-fails-the-build** — With no git, no tags (a shallow CI
  checkout), output that does not parse, or any error from `git`, `__APP_BUILD__`
  is the plain version.
- **REQ-about-shows-the-build-id** — The About card's version line reads
  `Version <__APP_BUILD__>`.
- **REQ-reports-name-the-build** — Every copyable report opens with
  `VAST G1-J8 <__APP_BUILD__>`: the Debug section's report ([debug-panel](debug-panel.md))
  and the failure report ([failure-report](failure-report.md)), so a pasted report
  names the exact build it came from.

## Technical design

### Contract / public interface

```ts
// scripts/lib/build-id.mjs — Node built-ins only
formatBuildId(version: string, describe: string): string  // pure: parses `v…-<n>-g<hash>`
buildId(version: string, cwd?: string): string             // git describe in cwd (default process.cwd()), 5 s timeout, never throws
```

### Layer touchpoints & ordering

`vite.config.ts` calls `buildId` once when the config is evaluated, passing its own
folder as `cwd` so the right repository is described wherever vite is started.
`vite dev` therefore shows the commit (and dirty state) the server started on until
it restarts; a build reads the commit it was built from.

## Scenarios (BDD)

```gherkin
Scenario: A build past the release names its distance and commit
  Given git describe answers "v2.22.1-7-gc09145c" for version 2.22.1
  When the build id is formatted
  Then it is "2.22.1+7.c09145c"
# pinned by: tests/scripts/build-id.test.ts

Scenario: A build on the release tag is the release
  Given git describe answers "v2.22.1-0-gc09145c" for version 2.22.1
  When the build id is formatted
  Then it is "2.22.1"
# pinned by: tests/scripts/build-id.test.ts

Scenario: Uncommitted changes are marked
  Given git describe answers "v2.22.1-7-gc09145c-dirty" for version 2.22.1
  When the build id is formatted
  Then it is "2.22.1+7.c09145c.dirty"
  And "v2.22.1-0-gc09145c-dirty" gives "2.22.1+0.c09145c.dirty"
# pinned by: tests/scripts/build-id.test.ts

Scenario: No tag, no git or unparseable output falls back to the version
  Given git describe fails or answers something that is not "v…-<n>-g<hash>"
  When the build id is formatted
  Then it is the plain version
# pinned by: tests/scripts/build-id.test.ts

Scenario: The About card shows the build id
  Given the About card is open
  Then its version line reads "Version " followed by __APP_BUILD__
# pinned by: tests/ui/about.test.ts + by eye on `vite preview`

Scenario: A copied report names the build
  When the Debug section's report or a failure report is built
  Then its first line begins "VAST G1-J8 " followed by __APP_BUILD__
# pinned by: tests/ui/about.test.ts, tests/ui/failure-report.test.ts
```

## Tests & verification

- Unit: `tests/scripts/build-id.test.ts` — `npx vitest run tests/scripts/build-id.test.ts`
- By eye: `npm run build && npx vite preview`, open About, compare with
  `git describe --tags --long`.

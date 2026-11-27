# Package managers: winget, Flathub and Homebrew

Issue #3467. Developers and Linux users install apps from package managers, and each listing is
one more place to find memrynote. This folder holds the drafts and the steps for each. Nothing has
been submitted, and no PR has been opened in another repo.

Checked on 2026-11-18 against release `v2026-11-11` (app version `2026.1111.1`).

| Manager  | State                                                                   | Kaan's next step                                                       |
| -------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| winget   | Manifest drafted in `winget/`                                           | Test it in the Windows VM, then open the PR to `microsoft/winget-pkgs` |
| Homebrew | Our tap updates on every release. Main-repo cask drafted in `homebrew/` | Let a user submit it now, or submit it himself at 225 stars            |
| Flathub  | Blocked. No manifest drafted, see below                                 | Decide whether to take on the source build and the sandbox work        |

## winget

### The manifest

`winget/` holds the three files winget-pkgs expects for one version, in its 1.10.0 schema:

- `MemryNote.MemryNote.yaml`, the version file.
- `MemryNote.MemryNote.installer.yaml`, which points at the Velopack installer
  `MemryNote-Setup-win-x64.exe` on the GitHub release, with its SHA-256 from the release.
- `MemryNote.MemryNote.locale.en-US.yaml`, with the name, description, license and links.

Why these values:

- The installer is the Velopack `Setup.exe`, since new installs use Velopack
  (`apps/docs/src/contribute/releasing.md`). The NSIS `setup.exe` stops shipping once no NSIS
  installs remain.
- Velopack installs per user to `%LocalAppData%\<packId>`, so `Scope: user` and the install path
  `%LocalAppData%\MemryNote`. `packId` is `MemryNote` in `scripts/velopack-release-utils.mjs`.
- Velopack's `Setup.exe` takes `--silent` (`-s`) to hide every dialog. winget's validation runs a
  silent install, so this switch matters.
- `ProductCode` is the Apps & Features key. Velopack names it after `packId`, and `Publisher`
  after `packAuthors` (`memrynote`). Confirm both on a real install, step 2 below.
- `PackageVersion` is the app version, `2026.1111.1`. winget compares versions part by part, and
  the calendar-shaped versions sort correctly (`2026.1015` < `2026.1111` < `2026.1201`).
- `UpgradeBehavior: install` runs the new `Setup.exe` over the old install, which is how Velopack
  updates outside its own updater.

### Steps for Kaan

1. Regenerate the hashes if a newer release is out by then. Change `PackageVersion`, the URL's
   tag, `ReleaseDate` and `InstallerSha256` (from `gh release view <tag> --json assets`), in all
   three files where they appear.
2. Test in the Windows VM (`vm-repro` skill): `winget settings --enable LocalManifestFiles`, then
   `winget install --manifest <folder>`, then `winget list memrynote`. Check that the app installs
   with no dialog, starts, and shows as `MemryNote` from `memrynote` in Apps & Features. Then
   `winget uninstall MemryNote.MemryNote`. Fix `ProductCode` or `Publisher` if they differ.
3. Validate with `winget validate --manifest <folder>`.
4. Fork `microsoft/winget-pkgs`, copy the files to `manifests/m/MemryNote/MemryNote/2026.1111.1/`,
   and open the PR from your account. The validation bot installs the app in a VM and labels the
   PR. Answer its comments yourself.

### Keeping it current

After the first PR merges, each release needs a new version folder in winget-pkgs. Proposal: a
`publish-winget.yml` workflow that `pnpm release` dispatches after publishing, next to the
Homebrew dispatch it already makes. The workflow runs
[Komac](https://github.com/russellbanks/Komac):

```bash
komac update MemryNote.MemryNote \
  --version "$APP_VERSION" \
  --urls "https://github.com/memrynote/memry/releases/download/$TAG/MemryNote-Setup-win-x64.exe" \
  --submit
```

Komac downloads the installer, hashes it, copies the rest of the manifest from the last version,
and opens the PR from a fork. It needs a classic token with `public_repo` from the account that
owns the fork, stored as a repo secret (for example `WINGET_TOKEN`). Kaan creates the token. This
change is not made here, since the first manifest has to be accepted before updates make sense.

## Homebrew

### Today

`brew install --cask memrynote/tap/memry` already works. `pnpm release` dispatches
`.github/workflows/publish-homebrew-cask.yml`, which renders the cask with
`scripts/generate-homebrew-cask.mjs` and pushes it to `memrynote/homebrew-tap`.

### The main cask repo

A listing in `Homebrew/homebrew-cask` lets people run `brew install --cask memrynote` without the
tap. Homebrew's notability rule for a GitHub project:

- Submitted by someone who isn't the maintainer: 75 stars, or 30 forks or watchers.
- Submitted by the maintainer: 225 stars, or 90 forks or watchers.

memrynote passes the first bar and not yet the second. So a user can submit the cask today, and
Kaan can submit it himself once the repo passes 225 stars. The README already asks for stars with
this reason.

`homebrew/memrynote.rb` is the cask for the main repo. It differs from the tap's cask:

- The token is `memrynote`, from the app name `MemryNote.app`, as Homebrew's token rules require.
  The tap uses `memry`.
- `auto_updates true`, because the app updates itself through electron-updater. Without it,
  `brew upgrade` would fight the in-app updater.
- `depends_on macos: ">= :monterey"` states the minimum as a comparison, as the Cask Cookbook
  shows it.
- The livecheck regex matches only the current `MemryNote-` asset names. The tap's regex also
  accepts the old `Memry-` names.
- The `zap` block has no comments. The tap's comments explain the history to us, not to Homebrew.

It was checked with `ruby -c` and against the `v2026-11-11` assets. It was not run through
`brew audit`.

### Steps

For whoever submits (a user now, or Kaan after 225 stars):

1. Update `version` and both `sha256` values to the latest release.
2. `brew audit --new --cask memrynote` and `brew style --fix memrynote` in a local
   `homebrew-cask` checkout, then `brew install --cask ./memrynote.rb` and `brew uninstall --zap`.
3. Open the PR to `Homebrew/homebrew-cask`. Homebrew's AI rules apply: say in the PR that AI
   helped draft the cask and which tool, have a human review every line, put a human author on
   every commit, and answer review comments without AI.

After the main cask merges:

- Point `publish-homebrew-cask.yml` at the main cask instead of the tap. Homebrew's own autobump
  usually picks up new GitHub releases through the livecheck, so the workflow may only need to
  stop.
- Add a `tap_migrations.json` to `memrynote/homebrew-tap` that sends `memry` to
  `homebrew/cask/memrynote`, so tap users move over on their next `brew update`. Check that a
  migration can rename the token. If not, keep the tap cask updating until its users are gone.
- Change the README install line to `brew install --cask memrynote`.

## Flathub

Flathub is blocked. These are the requirements that matter for memrynote, from
`docs.flathub.org/docs/for-app-authors/requirements` on 2026-11-18, and what each would take.

### AI policy

- "Flathub manifests must not contain AI-generated or AI-assisted content."
- "AI tools or agents must not open or automate Flathub submission pull requests, or generate
  their commit messages, descriptions, review comments, or replies."
- Submitters must disclose AI-generated code in the application, with the affected parts and the
  approximate extent. Reviewers may reject a submission because of it.

So this folder has no Flatpak manifest: an agent wrote everything in this branch, and Flathub
forbids AI help on the manifest. Kaan writes the manifest and the PR himself. memrynote's code is
largely written with AI agents, and the submission has to say so. That alone may lead reviewers to
reject it.

### Build from source

"All source available submissions must be built entirely from source code", with no network access
during the build. Repackaging the `.deb` or AppImage from the release is not allowed for an
open-source app submitted by its developer. memrynote must:

- Build the desktop app offline from the monorepo. Every npm package has to be listed as a source
  in a generated dependency manifest. `flatpak-builder-tools`' Node generator reads npm and yarn
  lockfiles. Check whether it reads `pnpm-lock.yaml`. If it doesn't, that is the largest single
  piece of work.
- Build the native modules (`better-sqlite3`, `keytar`, `sharp`) from source inside the build,
  against the Electron headers.
- Use `org.electronjs.Electron2.BaseApp`, the base Flathub expects for Electron apps.
- Ship `aarch64` too, or add a `flathub.json` that limits the build to `x86_64`. Linux releases are
  x86_64 only today.

### Metadata in the upstream repo

These files belong in this repo, not in the submission:

- An AppStream metainfo file, `com.memrynote.memry.metainfo.xml`, that passes
  `flatpak run --command=flatpak-builder-lint org.flatpak.Builder appstream`. It needs the
  description, screenshots, release history, `AGPL-3.0-only` license and content rating.
- A `.desktop` file with `MimeType=x-scheme-handler/memry;` for deep links.
- A 256 x 256 or larger PNG icon. `apps/desktop/build/icon.png` is 1024 x 1024.

### App ID and verification

The app ID would be `com.memrynote.memry`, the same as the Electron `appId`. To get the verified
badge, Flathub asks for a token at `https://memrynote.com/.well-known/org.flathub.VerifiedApps.txt`,
which the landing site would serve from `apps/landing/public/.well-known/`.

### Sandbox

Flathub wants static permissions at a minimum and portals where one exists. What the app needs and
what breaks:

| App behavior                                           | Under Flatpak                                                                                                                                                                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vault in any folder, watched for changes               | The file chooser portal gives access to the picked folder, but file watching through the document portal is unreliable. `--filesystem=home` works and reviewers question it. Decide which, and test the watcher. |
| Secrets in the OS keyring (`safeStorage`, `keytar`)    | `--talk-name=org.freedesktop.secrets`.                                                                                                                                                                           |
| Sync, Google Calendar, AI providers                    | `--share=network`.                                                                                                                                                                                               |
| Window, GPU                                            | `--socket=wayland`, `--socket=fallback-x11`, `--share=ipc`, `--device=dri`.                                                                                                                                      |
| The AI agent starts Claude Code or Codex from the host | Needs `flatpak-spawn --host`, which means `--talk-name=org.freedesktop.Flatpak`. Flathub reviewers rarely accept that. The feature would need to be off, or limited to local models, in the Flatpak build.       |
| The `memrynote` CLI, installed to `~/.local/bin`       | The installed link would point inside the sandbox. It needs a wrapper that runs `flatpak run --command=memrynote com.memrynote.memry`.                                                                           |
| In-app updates (electron-updater)                      | Must be off. Flathub updates the app. The app has to detect Flatpak (`FLATPAK_ID` is set) and hide the updater.                                                                                                  |

### What memrynote must change before a submission

1. Make the desktop app build offline from source, including the pnpm dependency manifest and the
   native modules.
2. Add the metainfo file, the desktop file and the icon to the repo.
3. Detect Flatpak and turn off the updater, the CLI install and host-spawned agents.
4. Decide on the vault folder permission and test file watching under it.
5. Write the Flatpak manifest and the submission without AI, and disclose the AI share of the
   code.

Named blocker for the issue: the Flathub AI policy, then the offline source build.

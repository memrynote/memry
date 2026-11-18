# Releasing the desktop app

A release runs in two places. GitHub Actions builds the Tauri app (`apps/desktop-tauri`), signs, notarizes and packs macOS, packs Linux, and stages unsigned Windows payloads. Your Mac packs the Windows Velopack packages and signs them with Authenticode, because the Certum code-signing key lives in a hardware-backed cloud keystore that CI cannot reach. The publish also runs from your Mac.

## What the release workflow builds

`publish-release.yml` builds the draft release's commit and uploads workflow artifacts only. It never writes to the release.

1. `setup-release` checks that the draft has no assets and targets `main`, resolves the version, and checks that `SYNC_SERVER_URL` is the production sync origin `https://sync.memrynote.com` with no port, path, credentials, query or fragment. It uploads `release-inputs-<version>`, which holds three files:
   - `version.conf.json`: the version overlay that every `tauri build --config` reads.
   - `release-notes.md`: the humanized notes of the draft, which `vpk --releaseNotes` puts in the feed. The draft must carry the humanized marker for the resolved tag. Run `pnpm release:humanize` first.
   - `delta.json`: the `--delta` of each pack target. A target gets a delta only when the previous published release holds a Tauri package of its channel (`shouldPackDelta`), so the first Tauri release packs `None` everywhere.
2. `build-macos` (`macos-15` arm64, `macos-15-intel` x64) and `build-linux` (`ubuntu-22.04`) build the bundles, then sign, check, pack and stage them:
   - The worker sidecar and pdfium come from `build-sidecars.mjs`. The build runs `tauri build --config src-tauri/tauri.release.conf.json --config version.conf.json` with the five `build_env.rs` values from repository secrets (`UNSPLASH_ACCESS_KEY` from `MEMRY_UNSPLASH_ACCESS_KEY`).
   - Every payload is checked by `assert-payload.mjs`, by `assert-production-config.mjs post` (production sync URL and feed present, no staging or rehearsal URL), against the version, and by `smoke-worker.mjs`.
   - macOS signs inside-out, packs, notarizes and staples with vpk, checks the designated requirement against the `v2026-10-15` Electron app, and builds a notarized dmg with `make-dmg.sh`.
   - Linux repacks the deb as Electron's `memrynote` package (`repack-deb.sh`), installs it in a clean `ubuntu:22.04` container, and runs `check-glibc.sh` on the AppDir and the deb.
3. `build-windows` (`windows-2022` x64, `windows-11-arm` arm64) builds, stages and checks the pack directory, and uploads it as `memry-windows-payload-<target>-<version>` for the Mac to pack and sign.
4. `stage-release` writes `latest-mac.yml` and `latest-linux.yml` from the staged bytes. It validates the mac feed and runs `required-assets.mjs --set ci`, which fails on any missing or unexpected file. It then uploads `memry-release-<version>` and `release-metadata-<version>`. `release-metadata.json` records the sha256 of each Windows payload zip under `windowsPayloads` (`target`, `name`, `sha256`), and the step fails when either zip is missing.

Every bundle build removes `export-bindings`. Tauri bundles every `[[bin]]` of the crate, and that one is a development tool.

## Prerequisites

- `vpk`. Install it with `brew install --cask dotnet-sdk && dotnet tool install -g vpk`.
- `jsign`, `osslsigncode`, and `openjdk`. Install them with `brew install jsign osslsigncode openjdk`.
- SimplySign Desktop, which provides `/usr/local/lib/libSimplySignPKCS.dylib`.
- `~/.config/memrynote/simplysign-pkcs11.cfg`.
- `~/.config/memrynote/certum-chain.pem`.
- The signing PIN in the macOS Keychain under the service name `memry-sign-pin`.

`pnpm release` checks every item above before it dispatches anything. When one is missing, it names the exact fix for that item.

## Before the release: provider smoke check

Before each desktop release, run the built-in agent backend against DeepSeek:

```bash
MEMRY_SMOKE_BASE_URL=https://api.deepseek.com/v1 \
MEMRY_SMOKE_MODEL=deepseek-v4-flash \
MEMRY_SMOKE_API_KEY=<your key> \
pnpm --filter @memry/desktop smoke:local-provider
```

The script runs the app's own capability probe, one vault tool round trip and a reasoning check, then sends each optional field the app can add to a request (`reasoning_effort` `high` and `max`, `thinking` disabled). It prints `PASS` or `FAIL` for each check and exits 1 when any check fails. It never prints the key: every output line, including an error the provider sends back, has the key replaced with `[key]`. A failure means a DeepSeek user would hit it in this build, so fix it before releasing. The same script works against any OpenAI-compatible endpoint.

## Running a release

```bash
pnpm release -- --humanize --yes
```

The script runs these steps in order:

1. Checks the signing session.
2. Humanizes the draft release notes.
3. Dispatches `publish-release.yml` and watches the run (`dispatch`, `build`).
4. Downloads the staged assets, the release metadata, the release inputs and both Windows payload zips (`download`).
5. Packs and signs the Windows x64 and arm64 Velopack packages (`pack-windows`). Each payload zip must match the sha256 that `release-metadata.json` records for it. It must not name a path outside its pack dir, and it must not unpack a symbolic link. The packs use the notes and the `--delta` from `release-inputs-<version>`, the same ones macOS and Linux used. A delta pack downloads the previous release's full package of its own channel. If `delta.json` asks for a delta and that package is missing from the previous release, the step stops before it signs anything. To recover, upload the missing `-full.nupkg` to the previous release (`gh release upload <previous tag> <file>`), then rerun `pnpm release`. If you still have that release's `.release-state/<draft>/assets`, the file is there. `--restart` does not help, because CI picks the delta from the previous release's `releases.<channel>.json`, not from its full package.
6. Copies the signed `MemryNote-Setup-win-x64.exe` to `MemryNote-<version>-setup.exe` and writes the three bridge feeds from the staged bytes (`bridge`).
7. Verifies the release before anything is uploaded (`verify`):
   - The staged files are exactly the release asset set (`required-assets.mjs --set release`).
   - Every file each feed lists matches its `sha512` and `size`. `latest.yml` lists only `MemryNote-<version>-setup.exe`, and that file is byte for byte the x64 Setup.
   - Both Setups, the `-setup.exe` copy and every PE file in both full packages pass `osslsigncode` against the Certum chain. The exception is `third-party-signed.json`: the WebView2 bootstrapper must keep its pinned bytes and Microsoft's signature. Every file that starts with `MZ` must be a PE file. An archive under `lib/app` fails the step unless `finish-release.mjs` allow-lists it (`archivesWithoutCode`), because no check reads the PE files inside it.
8. Deletes each draft asset that is not in the verified set, then uploads every verified asset (`upload`).
9. Publishes the draft release (`publish`). Before it does, the draft's asset names, sizes and GitHub sha256 digests must equal the verified files.
10. Dispatches the Homebrew cask bump.

After the release is published, run `pnpm release:reddit -- --tag <tag>`. It prints a copy/paste-ready Reddit title and body.

## The one manual step

Log in to SimplySign Desktop with the OTP from the phone app. The script opens SimplySign Desktop and waits for you to press Enter. A session lasts about two hours, so the script re-checks the session after the CI build and may ask you a second time. `--yes` does not skip this step. The login is a precondition, not a confirmation.

## Resuming a failed release

The script keeps its state under `.release-state/<draft-tag>/`, which is gitignored. Run the same command again to pick up where the script stopped. It does not re-dispatch a workflow run that already succeeded. A fresh download of the artifacts redoes the Windows packs and the feeds. To throw the state away and start over, pass `--restart`. The script refuses a state written by the Electron `pnpm release` and names the directory to remove.

## What ships on Windows

Each Windows target ships one Velopack set. The x64 target uses channel `win`, so Electron's Velopack installs find it:

- `MemryNote-Setup-win-x64.exe`
- `MemryNote-<version>-full.nupkg`
- a `-delta.nupkg`, only when the previous release holds a Tauri package of the channel
- `releases.win.json`
- `RELEASES`

The arm64 target uses channel `win-arm64` and ships `MemryNote-win-arm64-Setup.exe`, `MemryNote-<version>-win-arm64-{full,delta}.nupkg`, `releases.win-arm64.json` and `RELEASES-win-arm64`.

While `BRIDGES_WIN_LINUX` is on, Electron's NSIS installs update through `latest.yml`. It names `MemryNote-<version>-setup.exe`, a byte copy of the signed x64 Setup. The release has no NSIS installer, no `-win.zip` and no blockmaps.

vpk names the Setup `MemryNote-win-Setup.exe`, and `pnpm release` renames it to
`MemryNote-Setup-win-x64.exe` before signing is verified and anything is uploaded. Never upload a
`MemryNote-win-Setup.exe`, not even by hand: NSIS builds v2026-09-12 to v2026-10-25 send a `HEAD`
for that name on every update check, and on a `200` they download it and arm a hand-off whose
script hangs, so they never update and download it again the next session. On a `404` they
install the `latest.yml` installer instead. Releases up to v2026-10-25 keep the old name; the
landing download and the smoke test accept both.

## Downloads and the Homebrew cask

Two consumers outside the app read release asset names. Both read the latest published release, so
each one works whether that release came from the Electron or the Tauri pipeline.

The landing download endpoint, `apps/landing/api/download.ts`, redirects
`/api/download?platform=<platform>` to the matching asset. The first matcher that hits wins, and a
platform without a match redirects to the releases page. `api/download.test.ts` pins both asset
sets.

| Platform        | Asset, in order of preference                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `mac-arm64`     | `*-arm64.dmg`                                                                                                                          |
| `mac-x64`       | `*-x64.dmg`                                                                                                                            |
| `windows`       | `MemryNote-Setup-win-x64.exe`, then `MemryNote-win-Setup.exe` (tags up to v2026-10-25), then `*-setup.exe`                             |
| `windows-arm64` | `MemryNote-win-arm64-Setup.exe`, then the `windows` order. Electron releases carry no ARM64 Setup, and Windows on ARM runs the x64 one |
| `linux`         | `*.AppImage`. Only the versioned AppImage may be uploaded                                                                              |
| `linux-deb`     | `*.deb`                                                                                                                                |

`publish-homebrew-cask.yml` renders the cask with `scripts/generate-homebrew-cask.mjs` from the two
`MemryNote-<version>-<arch>.dmg` files and pushes it to `memrynote/homebrew-tap`. The cask sets
`depends_on macos: :ventura`, because the Tauri app needs macOS 13. Its `zap` list removes the
Tauri app's directories (`com.memrynote.memry` under `Application Support`, `Logs` and `WebKit`,
and Velopack's `Caches/velopack/MemryNote`) and every directory an Electron build wrote. It never
removes the vault. The generator's self-check runs in `pnpm test:release`
(`scripts/generate-homebrew-cask.test.mjs`).

## Windows signing

Every Windows file of ours is Authenticode-signed with the Certum key, which lives in a hardware-backed cloud keystore your Mac reaches through SimplySign. CI cannot reach it, so CI never signs. `vpk --signTemplate` runs `scripts/sign-windows-binary.sh` on every file it packs. The script signs each PE file, skips other files, and skips the names in `scripts/release/third-party-signed.json`. The only listed file is Microsoft's WebView2 bootstrapper, which keeps Microsoft's signature.

`latest.yml` is written after signing, from the signed bytes, so electron-updater's `sha512` check matches the file it downloads. The `verify` step checks every signature and every feed digest again before upload. Any failure aborts the release with nothing uploaded.

## Diagnosing a failed NSIS to Velopack migration

An existing NSIS install migrates by downloading `MemryNote-Setup-win-x64.exe`,
verifying its Authenticode signature, and running a detached `.cmd` on quit that
uninstalls NSIS and installs the Velopack build.

When a user reports that an update "did nothing" and the app is still on the old
version, ask for these two files:

| File                                             | Meaning                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `%APPDATA%\memrynote\logs\installer-handoff.log` | The script's own transcript: one line per step with its exit code. |
| `%APPDATA%\memrynote\logs\velopack-setup.log`    | Written by `Setup.exe`. Absent means Setup never ran.              |

Read the transcript's last line first:

- no file at all — the script never started; the hand-off was never armed
- `copy-uninstaller failed` — the NSIS uninstaller was missing or locked
- `uninstall exit=<n>` is the last line — the uninstaller hung or the machine
  went down mid-migration
- `result=nsis` — Velopack did not install and the NSIS fallback took over, so
  the user has the new version on the old install layout
- `result=failed no-nsis-fallback` — nothing installed; the user stays on the old
  version and needs a manual `MemryNote-Setup-win-x64.exe`

A successful migration ends `result=velopack` and reports
`app_update_installed` with `action=migrated, source=velopack-handoff` on the next
launch. Telemetry counts that event: if it stays at zero while
`UPDATE_INSTALL_DID_NOT_APPLY` with `source=velopack-handoff` climbs, migration is
broken for everyone, not for one reporter.

## Smoke test

Pass `--smoke` to `pnpm release` to dispatch the smoke test once the release is published, or dispatch it by hand:

```bash
gh workflow run velopack-smoke.yml \
  -f release_tag=<previous tag> \
  -f from_version=<previous version> \
  -f to_version=<new version> \
  -f update_tag=<new tag>
```

The workflow installs the previous release's signed Setup.exe on a real Windows runner, checks the install layout and the Authenticode status, applies the new release's package with `Update.exe`, and launches the app before and after. `update_tag` defaults to `release_tag`, so a single tag holding both an installer and a newer package also works. The smoke test is skipped when the previous release predates Velopack and carries no Velopack Setup.

## Update bridge rehearsal

The Tauri app (`apps/desktop-tauri`) reaches existing Electron installs through the same feeds they read today. Step 07 (#3524) proves that path on a throwaway GitHub repo, `memrynote/memry-update-rehearsal`, before any real release depends on it. Nothing here touches the production feed.

### Channels and asset names

Velopack names assets from the channel. The default channel of an OS drops the channel from nupkg names, and every other channel adds `-<channel>`. All packs share one GitHub release, so every OS and arch pair has its own channel. `UpdateManager` reads the channel from the installed `sq.version`. The one exception is an x64 install on an ARM64 PC, which moves to `win-arm64` with its next update (`apps/desktop-tauri/src-tauri/src/updater/channel.rs`). `scripts/release/vpk-args.mjs` owns the table, and `vpk-args.test.mjs` pins every argument list.

| Target        | `--runtime` | `--channel` | `--mainExe`     | Setup or portable asset            |
| ------------- | ----------- | ----------- | --------------- | ---------------------------------- |
| Windows x64   | `win-x64`   | `win`       | `Memrynote.exe` | `MemryNote-Setup-win-x64.exe`      |
| Windows arm64 | `win-arm64` | `win-arm64` | `Memrynote.exe` | `MemryNote-win-arm64-Setup.exe`    |
| macOS arm64   | `osx-arm64` | `osx-arm64` | `MemryNote`     | `MemryNote-osx-arm64-Portable.zip` |
| macOS x64     | `osx-x64`   | `osx-x64`   | `MemryNote`     | `MemryNote-osx-x64-Portable.zip`   |
| Linux x64     | `linux-x64` | `linux`     | `memrynote`     | `MemryNote.AppImage`               |

Windows x64 keeps today's production package names, so Electron installs on channel `win` find the Tauri pack. Its Setup is the exception. Electron builds `v2026-09-12` to `v2026-10-25` request vpk's name, `MemryNote-win-Setup.exe`, on every update check, and a release that answers arms a hand-off that hangs, so no release may carry it. `vpk-args.mjs` owns the rule (`RETIRED_SETUP_NAME`, `X64_SETUP_NAME`). `renameToPublished` in `vpk-pack.mjs` renames vpk's output and its `assets.win.json` entry right after `vpk pack`, in `vpk-pack.mjs`, `release.mjs` and the rehearsal. `assertPublishable` refuses an upload set that holds the old name, in `release.mjs` and the rehearsal publish. The first Tauri pack of a channel uses `--delta None`, because a delta against an Electron full package is as large as the full package and the client would prefer it. Windows packs add `--framework webview2` and no VC++ redistributable. The exe links vcruntime statically and takes the C runtime from the UCRT that ships with Windows 10 and later. A Setup started by an old Electron build runs with its dialogs on (`/S` is not Velopack's `--silent`), so a declared prerequisite the machine lacks would stop the migration at a dialog. `pe-imports.mjs` fails a pack, and the rehearsal's Windows payload job, when the exe imports a DLL of the redistributable (`VCRUNTIME*`, `CONCRT*`, `VCCORLIB*`, `VCOMP*` and `VCAMP*` with a version number, `MSVCP`, `MSVCR`, `MFC` and `MFCM` from version 7.0 (`MSVCP70` to `MSVCP140_ATOMIC_WAIT`, `MFC140U`), and the debug `UCRTBASED`) or a UCRT API set Windows does not ship. Windows' own `msvcrt.dll`, `msvcp_win.dll`, `msvcp60.dll`, `mfc42.dll`, `mfc42u.dll` and `ucrtbase.dll` pass. `rehearse.mjs build` pins the rehearsal branch and memry's `--source-ref` to commits, and dispatches only when the rehearsal repo's copy of the workflow matches memry's copy at the source commit, so a stale copy cannot skip that step. It takes the run id from the URL `gh workflow run` prints (gh 2.101), or else from the newest run created since the dispatch, and stops when that run started from another rehearsal commit. It cancels such a run only when gh printed its id, since a listed run may be another dispatch's, and says when the cancel failed. Without `--source-ref` it builds the `source_ref` default of the rehearsal repo's copy of the workflow. `vpk` is pinned to 1.2.161, the same version as the `velopack` crate. `vpk` 1.2.x has no `--version` flag: check `vpk -h | head -3` for `Velopack CLI 1.2.161`.

### WebView2 bootstrapper

Velopack's Setup installs the WebView2 runtime (`--framework webview2`), but a user can remove it later. Without it no window opens. So every Windows pack also ships Microsoft's bootstrapper at `webview2\MicrosoftEdgeWebview2Setup.exe`. A launch that finds no runtime runs the bootstrapper in `main`, before the Tauri runtime starts (`updater/webview2.rs`). It cannot wait for a later boot stage: `tauri-runtime-wry` checks for WebView2 once, when the runtime starts, and opens no webview in a process that started without it, even after the install (#3915).

The packed file is pinned. `scripts/release/webview2-bootstrapper.json` holds the file's own download address, its SHA-256 and its size.

- Before `vpk pack`, `node scripts/release/webview2-bootstrapper.mjs <pack-dir>` downloads that address. It keeps the file only when the size and hash match the pin.
- `vpk-pack.mjs` refuses a `win-*` pack without the pinned file.
- The rehearsal checks the file again inside each full package, for signed and unsigned packs alike. The check covers the pin and Microsoft's Authenticode signature.
- `sign-windows-binary.sh` skips the file, so Microsoft's signature stays on it.

When Microsoft retires the pinned address, the pack fails on the download. Run `node scripts/release/webview2-bootstrapper.mjs --update` on the Mac to move the pin. The script follows Microsoft's link to the current bootstrapper and writes the new pin only when the file's signature verifies against `scripts/release/microsoft-roots.pem` with `Microsoft Corporation` as the signer. Commit the changed pin with the release.

### The in-app updater

The Tauri app updates itself through Velopack (`apps/desktop-tauri/src-tauri/src/updater/`, with the state machine, markers and severity rules in `crates/memry-desktop/src/updater/`).

- **Feed.** A production build compiles in `https://github.com/memrynote/memry`; a rehearsal build compiles in `MEMRY_UPDATE_FEED_URL` instead (`velopack_backend.rs`). Velopack reads a github.com feed through the REST API, which allows 60 unauthenticated requests an hour per IP: one for a check, one more for a download. Electron's Velopack backend reads the feed the same way. A rehearsal build on a github.com feed sends `MEMRY_REHEARSAL_FEED_TOKEN` when the launch sets it, which the M3, M4 and M4r proof jobs do with the workflow's token so a busy runner IP does not hit the limit; a production build never reads the variable.
- **When.** Nothing of the updater runs before the window except reading `sq.version` for the version it reports. The service starts 10 s after the main window shows, reads its marker files, then checks; later checks run every 4 hours. A download starts on its own only with **Automatically download updates** on.
- **Channel.** `UpdateManager` takes the channel from the installed `sq.version`. The one exception is an x64 install running under emulation on an ARM64 PC, the only Windows build Electron shipped. It moves to the native `win-arm64` pack on its next update, through a full package, because a delta does not cross architectures (`channel.rs`). A release without the `win-arm64` pack leaves such installs on x64 until a release carries it.
- **Install.** **Restart now** and a normal quit both hand the downloaded release to Velopack's updater, which waits up to 60 s for the app to exit. Restart now relaunches the new version; a quit installs silently and opens nothing. Only the running instance's quit installs, and only the default profile updates: a `MEMRY_DEVICE` profile never opens the install.

The updater keeps four files in the app's data directory. Each keeps the Electron name and keys, so a file the last Electron build wrote reads the same in the first Tauri launch.

| File                          | Written                                                                                            | Read                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `update-install-attempt.json` | by the quit, before the hand-off: `fromVersion`, `toVersion`, `startedAt`, `installer`, `fromArch` | at the next launch. A different running version reports `app_update_installed`; the same version reports `UPDATE_INSTALL_DID_NOT_APPLY` and shows the install-failed dialog. The file is then deleted.                                                                                                                                          |
| `update-install-health.json`  | after each failed install of one release: `consecutiveFailures`, `escalated`                       | at launch. The third failure in a row escalates once and offers the manual installer; a good install clears it.                                                                                                                                                                                                                                 |
| `pending-update-install.json` | by the quit on macOS, while Velopack's updater runs                                                | by the relaunch guard. A launch of the old build during the swap shows the "Installing update" splash for 2 s and exits. It holds the single-instance lock until then, so a launch that hands itself to it meanwhile, such as the updater's start of the new build after Restart now, is opened again once it has exited (`relaunch_guard.rs`). |
| `nsis-leftover.json`          | on Windows, at the first launch that finds the NSIS install an Electron build left                 | by the leftover removal, which deletes that install a day later (`nsis_host.rs`)                                                                                                                                                                                                                                                                |

### Bridge feeds

`scripts/release/bridge-feeds.mjs` writes `latest-mac.yml`, `latest-linux.yml` and `latest.yml` in the electron-builder layout: `version`, `files[]` (`url`, base64 `sha512`, `size`), then `path` and `sha512` of the first file, then `releaseDate`. The hash and size come from the exact uploaded bytes, after signing. There is no `blockMapSize` and no blockmap asset: electron-updater logs the missing blockmap and downloads the full file.

- `latest-mac.yml` ends with `minimumSystemVersion: 22.0.0`. Darwin 22 is macOS 13, so electron-updater 6.6.2 and newer on macOS 12 skip the release. `scripts/validate-mac-update-manifest.mjs` checks the key.
- `latest.yml` lists `MemryNote-<version>-setup.exe`, a byte copy of the signed `MemryNote-Setup-win-x64.exe`. An NSIS install downloads Velopack's Setup through electron-updater. An Electron build with the fixed hand-off (#3702) then downloads the same bytes from `MemryNote-Setup-win-x64.exe`; an older one finds no `MemryNote-win-Setup.exe`, declines, and runs the `latest.yml` installer.

### Squirrel.Mac designated requirement

Squirrel.Mac installs an update bundle only when it satisfies the designated requirement of the running app. The Tauri bundle meets the Electron app's requirement through three facts: `identifier` in `tauri.conf.json` is `com.memrynote.memry`, the bundle is signed with the same Developer ID certificate (same Team ID), and `vpk` signs with the hardened runtime and keeps the Info.plist identifier. `scripts/release/check-mac-designated-requirement.sh <old.app> <new.app>` extracts the requirement from the old app and verifies the new one against it. It exits non-zero on failure.

### Procedure

1. Build the Electron baselines. `scripts/rehearsal/build-electron-rehearsal.mjs <tag> <feed_repo>` checks out a production tag in a worktree, replaces `VELOPACK_FEED_URL` and `GITHUB_RELEASE_DOWNLOAD_BASE`, and builds with `-c.publish.*` overrides that point `app-update.yml` at the rehearsal repo. It never edits the main tree. The workflow job `build-electron-rehearsal` runs it on four runners.
2. Dispatch `update-bridge-rehearsal.yml` with `version` (`2099.101.1`, then `2099.101.2`), `feed_repo` and `previous_tag`. It builds and packs macOS and Linux and builds the Windows payload zips.
3. On the Mac, `node scripts/rehearsal/rehearse.mjs assemble <version>` packs and signs both Windows packs, verifies them with `osslsigncode`, and writes the feeds. `publish <version> --confirm-repo memrynote/memry-update-rehearsal` creates the release. Both Windows and the publish step need the maintainer's Mac and approval.
4. Drive an Electron rehearsal install with `scripts/rehearsal/drive-electron-update.mjs <cdp-port>`. Pin the rollout bucket first: write `00000000-0000-4000-8000-000000000000` to `<userData>/.updaterId`.
5. On the Windows VM, install a local baseline with `winvm.sh install-local <path> [--nsis]` (`scripts/rehearsal/winvm-install-local.patch` adds the command to the vm-repro skill's `winvm.sh`).

### Packaging decision

Windows ships only the Velopack Setup. The NSIS-position file is a byte copy of it, so `apps/desktop/build/installer.nsh`, the electron-builder `nsis` and `zip` Windows targets and `afterPack: scripts/prune-packaged-app.mjs` have no Tauri counterpart and are deleted with `apps/desktop` in Step 43 (#3560). Linux keeps `AppImage` and `deb`, executable name `memrynote` and category `Utility`, set in `tauri.linux.conf.json`. Platform overlays `tauri.windows.conf.json`, `tauri.macos.conf.json` and `tauri.linux.conf.json` set `mainBinaryName` to `Memrynote`, `MemryNote` and `memrynote`, the executable names `vpk --mainExe` expects. Tauri bundles every `[[bin]]` of the crate, so the pack steps remove `export-bindings` before signing.

### Results

The rehearsal repo `memrynote/memry-update-rehearsal` (public) carries the workflow and the releases `rehearsal-2099.101.1` to `rehearsal-2099.101.3`. Windows rows ran on 2026-10-27 on the ARM64 VM, macOS rows on tart on 2026-10-26, W2 on the VM and on `windows-2022` and `windows-11-arm` runners. R2 (`2099.101.1`) is the baseline and R3 (`2099.101.2`) the update; R4 (`2099.101.3`, macOS and Linux only) gave M3 a Velopack-installed delta base. The table holds the outcome of each row.

| Id  | Environment                                                                   | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | Windows 11 ARM64 VM, Electron rehearsal build, Velopack install, R2           | pass 2026-10-27 (VM, x64 under Prism): `current\Memrynote.exe` is the Tauri binary, `sq.version` 2099.101.1 `win-x64`, no `app.asar`, `main.log` start marker and `update-probe: up-to-date`. While the packs declared `vcredist143-x64`, a clean image needed the x64 VC++ runtime first: Setup installed it, then cancelled with "restart required"; after a reboot it installed. Since 2026-10-30 (#3555) they declare none, and WB3 on 2026-10-31 (`2099.101.18`, clean VM with only the Arm64 redist) installed with no VC++ step                                                                                                                              |
| W2  | same VM, NSIS install, R2                                                     | pass after #3660 (2026-10-27, Electron build of the fix branch, feed fixed to the rehearsal repo): ARM64 VM `installer-handoff.log` ends `result=velopack`, `relaunch exit=0`; the NSIS uninstall key and `Programs\Memrynote` are gone; `sq.version` 2099.101.2 after the probe applied the delta; Tauri runs from `%LOCALAPPDATA%\MemryNote\current`. Same on `windows-2022` and `windows-11-arm` runners (rehearsal run 40574578973). Before the fix: the detached `cmd.exe` has no console, so `tasklist \| find` hung; `Setup.exe --silent` never starts the app; the signature check failed on an inherited `PSModulePath` (x64) or timed out at 60 s (ARM64) |
| W3  | same VM, R2 to R3 delta                                                       | pass 2026-10-27 (VM, x64): `update-probe: available version=2099.101.2 deltas=1`, downloaded, applied, `sq.version` 2099.101.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| W4  | same VM, native arm64 Setup, R2 to R3                                         | pass 2026-10-27 (VM): PE machine `0xAA64`, channel `win-arm64`, R2 to R3 applied with `deltas=1`, `sq.version` 2099.101.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| W5  | clean snapshot without VC++                                                   | superseded 2026-10-30 (#3555): the packs no longer declare `vcredist143-*`. Was: pass 2026-10-27 (VM, Arm64 runtime removed): nuspec listed `webview2,vcredist143-arm64`; Setup downloaded and installed the Arm64 redist silently (14.44.35211) and the app started                                                                                                                                                                                                                                                                                                                                                                                                |
| M1  | tart `macos-sonoma-base`, arm64                                               | pass 2026-10-26: Squirrel install, notarized, DR ok, probe `up-to-date`; no auto-relaunch (ShipIt cannot spawn)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| M2  | `macos-15-intel` CI job                                                       | pass (run 40388750063)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| M3  | M1 VM after R3                                                                | pass 2026-10-26: R3 to R4 via Velopack base: `deltas=1`, downloaded, applied, relaunched, 2099.101.3 `up-to-date`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| M4  | tart `macos-monterey-base`, `v2026-10-15`                                     | pass: Electron refuses (OS 21.6.0 < 22.0.0), state `up-to-date`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| M4b | tart `macos-monterey-base`, `v2026.4.28`                                      | blocked: the oldest tag build fails with EMFILE on macos-15 even at `ulimit -n 65536`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| L1  | `ubuntu-24.04` x64 CI job under `xvfb-run`, AppImage packed on `ubuntu-22.04` | pass (run 40388750063)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

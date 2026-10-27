# Releasing the desktop app

A release runs in two places. GitHub Actions builds and signs the macOS artifacts, notarizes them, builds and signs Linux, and stages the Windows artifacts. Your Mac packs the Windows Velopack packages and signs them with Authenticode, because the Certum code-signing key lives in a hardware-backed cloud keystore that CI cannot reach. The publish also runs from your Mac.

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
3. Dispatches `publish-release.yml` and watches the run.
4. Downloads the workflow artifacts.
5. Packs and signs the Velopack package.
6. Verifies both signatures with `osslsigncode`.
7. Uploads every asset to the draft release.
8. Publishes the draft release.
9. Dispatches the Homebrew cask bump.

After the release is published, run `pnpm release:reddit -- --tag <tag>`. It prints a copy/paste-ready Reddit title and body.

## The one manual step

Log in to SimplySign Desktop with the OTP from the phone app. The script opens SimplySign Desktop and waits for you to press Enter. A session lasts about two hours, so the script re-checks the session after the CI build and may ask you a second time. `--yes` does not skip this step. The login is a precondition, not a confirmation.

## Resuming a failed release

The script keeps its state under `.release-state/<draft-tag>/`, which is gitignored. Run the same command again to pick up where the script stopped. It does not re-dispatch a workflow run that already succeeded. To throw the state away and start over, pass `--restart`.

## What ships on Windows

Both Windows installer families ship during the transition.

The NSIS set keeps existing installs updating through electron-updater:

- `MemryNote-<version>-setup.exe`
- `latest.yml`
- the blockmaps
- `MemryNote-<version>-win.zip`

The Velopack set is what new installs and the Velopack updater use:

- `MemryNote-win-Setup.exe`
- `MemryNote-<version>-full.nupkg`
- a `-delta.nupkg`, written only when the previous release's full package was available
- `releases.win.json`
- `RELEASES`

The NSIS assets stop shipping once telemetry shows that no NSIS installs remain.

## Windows signing

Both Windows installer families are Authenticode-signed with the Certum key, which
lives in a hardware-backed cloud keystore your Mac reaches through SimplySign. CI
cannot reach it, so CI never signs.

- the Velopack set is signed while it is packed, through `vpk --signTemplate`
- the NSIS `MemryNote-<version>-setup.exe` is built unsigned on the CI Windows
  runner and signed afterwards on your Mac, before anything is uploaded

Signing rewrites the installer, so `pnpm release` also regenerates its `.blockmap`
and rewrites the `sha512` and `size` in `latest.yml`. This is not optional:
electron-updater refuses any download whose bytes do not match that digest, so a
signed installer paired with the CI manifest would stop every remaining NSIS
install from updating. All three move together in one step.

Every signed artifact is then verified with `osslsigncode` against the Certum
chain before upload — the Velopack `Setup.exe`, the packaged `Memrynote.exe`, and
the NSIS installer. A verification failure aborts the release with nothing
uploaded.

## Diagnosing a failed NSIS to Velopack migration

An existing NSIS install migrates by downloading `MemryNote-win-Setup.exe`,
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
  version and needs a manual `MemryNote-win-Setup.exe`

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

The workflow installs the previous release's signed Setup.exe on a real Windows runner, checks the install layout and the Authenticode status, applies the new release's package with `Update.exe`, and launches the app before and after. `update_tag` defaults to `release_tag`, so a single tag holding both an installer and a newer package also works. The smoke test is skipped when the previous release predates Velopack and carries no `MemryNote-win-Setup.exe`.

## Update bridge rehearsal

The Tauri app (`apps/desktop-tauri`) reaches existing Electron installs through the same feeds they read today. Step 07 (#3524) proves that path on a throwaway GitHub repo, `memrynote/memry-update-rehearsal`, before any real release depends on it. Nothing here touches the production feed.

### Channels and asset names

Velopack names assets from the channel. The default channel of an OS drops the channel from nupkg names, and every other channel adds `-<channel>`. All packs share one GitHub release, so every OS and arch pair has its own channel. `UpdateManager` reads the channel from the installed `sq.version`, so the app has no channel code. `scripts/release/vpk-args.mjs` owns the table, and `vpk-args.test.mjs` pins every argument list.

| Target        | `--runtime` | `--channel` | `--mainExe`     | Setup or portable asset            |
| ------------- | ----------- | ----------- | --------------- | ---------------------------------- |
| Windows x64   | `win-x64`   | `win`       | `Memrynote.exe` | `MemryNote-win-Setup.exe`          |
| Windows arm64 | `win-arm64` | `win-arm64` | `Memrynote.exe` | `MemryNote-win-arm64-Setup.exe`    |
| macOS arm64   | `osx-arm64` | `osx-arm64` | `MemryNote`     | `MemryNote-osx-arm64-Portable.zip` |
| macOS x64     | `osx-x64`   | `osx-x64`   | `MemryNote`     | `MemryNote-osx-x64-Portable.zip`   |
| Linux x64     | `linux-x64` | `linux`     | `memrynote`     | `MemryNote.AppImage`               |

Windows x64 keeps today's production names, so Electron installs on channel `win` find the Tauri pack. The first Tauri pack of a channel uses `--delta None`, because a delta against an Electron full package is as large as the full package and the client would prefer it. Windows packs add `--framework webview2,vcredist143-<arch>`. `vpk` is pinned to 1.2.161, the same version as the `velopack` crate. `vpk` 1.2.x has no `--version` flag: check `vpk -h | head -3` for `Velopack CLI 1.2.161`.

### Bridge feeds

`scripts/release/bridge-feeds.mjs` writes `latest-mac.yml`, `latest-linux.yml` and `latest.yml` in the electron-builder layout: `version`, `files[]` (`url`, base64 `sha512`, `size`), then `path` and `sha512` of the first file, then `releaseDate`. The hash and size come from the exact uploaded bytes, after signing. There is no `blockMapSize` and no blockmap asset: electron-updater logs the missing blockmap and downloads the full file.

- `latest-mac.yml` ends with `minimumSystemVersion: 22.0.0`. Darwin 22 is macOS 13, so electron-updater 6.6.2 and newer on macOS 12 skip the release. `scripts/validate-mac-update-manifest.mjs` checks the key.
- `latest.yml` lists `MemryNote-<version>-setup.exe`, a byte copy of the signed `MemryNote-win-Setup.exe`. An NSIS install downloads Velopack's Setup through electron-updater. The hand-off script then downloads the same bytes from `MemryNote-win-Setup.exe`.

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

The rehearsal repo `memrynote/memry-update-rehearsal` (public) carries the workflow and the releases `rehearsal-2099.101.1` to `rehearsal-2099.101.3`. Windows rows ran on 2026-10-27 on the ARM64 VM, macOS rows on tart on 2026-10-26, W2 on a `windows-2022` runner. R2 (`2099.101.1`) is the baseline and R3 (`2099.101.2`) the update; R4 (`2099.101.3`, macOS and Linux only) gave M3 a Velopack-installed delta base. The table holds the outcome of each row.

| Id  | Environment                                                                   | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W1  | Windows 11 ARM64 VM, Electron rehearsal build, Velopack install, R2           | pass 2026-10-27 (VM, x64 under Prism): `current\Memrynote.exe` is the Tauri binary, `sq.version` 2099.101.1 `win-x64`, no `app.asar`, `main.log` start marker and `update-probe: up-to-date`. A clean image needs the x64 VC++ runtime first: Setup installed it, then cancelled with "restart required"; after a reboot it installed                                                                                                                                          |
| W2  | same VM, NSIS install, R2                                                     | FAIL on 2 of 4 checks (CI `windows-2022` x64, runs 40491826536, 40492573782, 40493330380; the VM hangs earlier): electron-updater downloaded `MemryNote-2099.101.1-setup.exe`, the hand-off armed, Tauri runs from `%LOCALAPPDATA%\MemryNote\current` (`sq.version` 2099.101.2 after the probe applied the delta). The NSIS uninstall key and `Programs\Memrynote` stay, and `installer-handoff.log` is never written. On the ARM64 VM the script hangs at its first `tasklist | find`, so the app quits and never relaunches |
| W3  | same VM, R2 to R3 delta                                                       | pass 2026-10-27 (VM, x64): `update-probe: available version=2099.101.2 deltas=1`, downloaded, applied, `sq.version` 2099.101.2                                                                                                                                                                                                                                                                                                                                                 |
| W4  | same VM, native arm64 Setup, R2 to R3                                         | pass 2026-10-27 (VM): PE machine `0xAA64`, channel `win-arm64`, R2 to R3 applied with `deltas=1`, `sq.version` 2099.101.2                                                                                                                                                                                                                                                                                                                                                      |
| W5  | clean snapshot without VC++                                                   | pass 2026-10-27 (VM, Arm64 runtime removed): nuspec lists `webview2,vcredist143-arm64`; Setup downloaded and installed the Arm64 redist silently (14.44.35211) and the app started                                                                                                                                                                                                                                                                                             |
| M1  | tart `macos-sonoma-base`, arm64                                               | pass 2026-10-26: Squirrel install, notarized, DR ok, probe `up-to-date`; no auto-relaunch (ShipIt cannot spawn)                                                                                                                                                                                                                                                                                                                                                                |
| M2  | `macos-15-intel` CI job                                                       | pass (run 40388750063)                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| M3  | M1 VM after R3                                                                | pass 2026-10-26: R3 to R4 via Velopack base: `deltas=1`, downloaded, applied, relaunched, 2099.101.3 `up-to-date`                                                                                                                                                                                                                                                                                                                                                              |
| M4  | tart `macos-monterey-base`, `v2026-10-15`                                     | pass: Electron refuses (OS 21.6.0 < 22.0.0), state `up-to-date`                                                                                                                                                                                                                                                                                                                                                                                                                |
| M4b | tart `macos-monterey-base`, `v2026.4.28`                                      | blocked: the oldest tag build fails with EMFILE on macos-15 even at `ulimit -n 65536`                                                                                                                                                                                                                                                                                                                                                                                          |
| L1  | `ubuntu-24.04` x64 CI job under `xvfb-run`, AppImage packed on `ubuntu-22.04` | pass (run 40388750063)                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

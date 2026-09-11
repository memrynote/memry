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

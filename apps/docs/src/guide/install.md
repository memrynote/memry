---
description: Download and install memrynote on macOS, Windows, or Linux, including Homebrew and manual installer options.
---

# Install memrynote

Download the desktop app from **[memrynote.com/download/desktop](https://memrynote.com/download/desktop)**.
The download page detects your platform and offers installers for:

- **macOS** — Apple Silicon and Intel
- **Windows** — the installer lets you choose the install location, so you can
  install to a drive other than `C:`. Each release also ships a
  `MemryNote-<version>-win.zip` on the
  [GitHub releases page](https://github.com/memrynote/memry/releases) — unzip and
  run `Memrynote.exe` directly if the installer fails on your machine
- **Linux** — AppImage and `.deb`

On macOS you can also install with [Homebrew](https://brew.sh):

```sh
brew install --cask memrynote/tap/memry
```

After installing, head to [First Run & Vault Setup](./first-run) to create your encrypted vault.

## Automatic Updates

memrynote checks for updates in the background and prompts you to restart when one is
ready. Both the check and the download are optional — turn either off in
**Settings → General**.

The install itself runs after the app has closed. If the installer does not apply the
update, memrynote tells you on the next launch and offers to download the installer so
you can run it yourself. Running it over your existing install is enough — your vault
and settings are untouched, and you do not need to uninstall first.

It is still worth reporting, because the app's log holds the reason. Send us the log
file along with the report:

- **Windows** — `%APPDATA%\memrynote\logs\main.log`
- **macOS** — `~/Library/Logs/memrynote/main.log`
- **Linux** — `~/.config/memrynote/logs/main.log`

On Windows, an update can also be blocked by a file in the install folder being held
open — antivirus and leftover memrynote processes are the usual causes. The installer
works around this on its own now, and it writes an `install.log` next to the app
(typically `%LOCALAPPDATA%\Programs\memrynote`) that names the file it could not move.
That log is the most useful thing you can send us if an update still fails.

A failed Windows update can no longer remove the app. The installer keeps the old
version in a backup folder next to the install folder until the new files are fully in
place, and restores it automatically — at the next Windows sign-in at the latest — if
anything interrupts the install, including shutting the PC down mid-update. For the same
reason, an update is no longer installed while Windows itself is shutting down; it
simply applies the next time you quit the app.

One caveat if you are already affected. On Windows the step that removes the old files
is run by the version you currently have installed, not by the one being installed — so
these workarounds only take effect on updates _away from_ a build that contains them. If
your updates are failing today, install the latest version manually once
(uninstall from **Settings → Apps**, then run the installer from
[the download page](https://memrynote.com/download); your vault and settings are kept).
Updates after that run on their own.

## Run from Source

Use the source workflow if you are contributing or testing local changes.

### Prerequisites

- Node.js 24.x, using the version pinned by `.nvmrc`
- pnpm 10.30+
- Git

### Setup

```bash
git clone https://github.com/memrynote/memry.git
cd memry
nvm use
pnpm install
pnpm dev:desktop
```

## Sync Server Development

The sync server is a Cloudflare Workers app. Run it separately when working on sync
behavior.

```bash
pnpm dev:sync-server
```

## Before a Pull Request

Run the focused checks for the area you changed. For broad changes, use the full gates.

```bash
pnpm lint
pnpm typecheck
pnpm test
```

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

The install itself runs after the app has closed. If the app reopens on the same
version, the installer did not apply the update. That is worth reporting: the app now
records the attempt and reports it on the next launch, and its log holds the reason.

Send us the log file along with the report:

- **Windows** — `%APPDATA%\memrynote\logs\main.log`
- **macOS** — `~/Library/Logs/memrynote/main.log`
- **Linux** — `~/.config/memrynote/logs/main.log`

As a workaround, download the current installer from the
[download page](https://memrynote.com/download/desktop) and run it over your existing
install. Your vault and settings are untouched — you do not need to uninstall first.

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

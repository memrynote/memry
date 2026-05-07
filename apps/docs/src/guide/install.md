# Install Memry

Memry is not publicly released yet. Download links and packaged installers will be added
here once the first stable release is available.

## Current Status

The project is in active development. If you want to follow progress, watch the
[GitHub repository](https://github.com/memrynote/memry) or join the community around the
project before installing a public build.

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

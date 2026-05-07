# Architecture

Memry is a pnpm monorepo with a desktop app, sync server, and shared TypeScript packages.

## Main Packages

| Path                 | Purpose                                                         |
| -------------------- | --------------------------------------------------------------- |
| `apps/desktop`       | Electron, React, Vite, main process, renderer, and preload code |
| `apps/sync-server`   | Cloudflare Workers sync API backed by D1 and R2                 |
| `packages/contracts` | Shared IPC and API contract definitions                         |
| `packages/db-schema` | Drizzle schemas for local and index databases                   |
| `packages/shared`    | Shared utilities used across packages                           |

## Privacy Model

Memry treats the local device as the trusted boundary. Workspace data is encrypted before
sync and decrypted only on user devices. The sync server coordinates delivery and storage,
but it is not designed to read plaintext note content.

## Local Data

The desktop app uses local SQLite storage for workspace data. This keeps core app flows
available offline and makes sync an enhancement rather than a hard dependency.

## Sync Data

The sync system stores metadata in Cloudflare D1 and encrypted payloads in R2. Large sync
items avoid D1 row-size limits by keeping encrypted payload data in object storage.

## Verification Gates

Common repo checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm ipc:check
```

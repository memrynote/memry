---
description: How memrynote's Electron desktop app, Cloudflare Workers sync server, and shared packages fit together in the monorepo.
---

# Architecture

memrynote is a pnpm + Turborepo monorepo with an Electron desktop app, a Cloudflare Workers sync server, and shared TypeScript packages.

## Top-Level Map

| Path                 | Purpose                                                   |
| -------------------- | --------------------------------------------------------- |
| `apps/desktop`       | Electron 43 + React 19 + Vite. Main / renderer / preload. |
| `apps/sync-server`   | Cloudflare Workers + Hono. D1 + R2.                       |
| `apps/docs`          | This documentation site (VitePress).                      |
| `packages/contracts` | IPC and API contracts (Zod).                              |
| `packages/db-schema` | Drizzle ORM schemas.                                      |
| `packages/shared`    | Shared utilities.                                         |

## Trust Boundary

The user's device is trusted. The server is not. Everything that leaves the device is encrypted; the server stores ciphertext and serves it back.

## Local Storage

Two SQLite databases via better-sqlite3 + Drizzle:

- **Data DB** — notes, journals, tasks, projects, inbox, templates, settings.
- **Index DB** — full-text search, link graph, embedding vectors.

→ [Local Storage (Dual SQLite)](/architecture/local-storage)

## Sync

- **D1**: encrypted sync item metadata (vector clocks, blob keys, hashes).
- **R2**: encrypted payload blobs (avoids the 1 MB D1 row limit).
- **Hybrid sync**: bulk snapshots through `SyncItemHandler` plus incremental Yjs updates through `/sync/crdt/updates`.

- **Bootstrap**: a fresh device opens a time-boxed elevated window, then seeds note bodies from immutable compaction packs before the item-granular pull.

→ [Sync Protocol](/architecture/sync-protocol) · [CRDT & Notes Sync](/architecture/crdt) · [Sync Item Handlers](/architecture/sync-handlers) · [Vault Packs](/architecture/vault-packs)

## Cryptography

XChaCha20-Poly1305 + Ed25519 + Argon2id, all via libsodium. Per-device sealing of the vault key. Constant-time comparisons.

→ [Cryptography](/architecture/cryptography)

## IPC Boundary

Shared Zod contracts in `packages/contracts`. Validated at typecheck time via `pnpm ipc:check`.

→ [IPC Boundary](/architecture/ipc)

## Observability

Local logging via electron-log; switchable telemetry that ships only enums and surface names.

→ [Observability & Telemetry](/architecture/observability)

## Verification Gates

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm ipc:check
```

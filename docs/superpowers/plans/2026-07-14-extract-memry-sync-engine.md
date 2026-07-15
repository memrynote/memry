# Extract @memry/sync-engine Implementation Plan

> Agentic workers: use the `superpowers:subagent-driven-development` sub-skill to execute this plan. Each task's steps use `- [ ]` checkbox syntax; check a box only when its exact verification evidence is green. Do not batch tasks — one file-group per task, run the sync suite after each, keep desktop green throughout.

**Goal:** Move the desktop sync **engine core + protocol machinery** out of `apps/desktop/src/main/sync/` into `packages/sync-core/src/` behind formal DI seams so it is `electron`/`node`-free and reusable by the future mobile client, while desktop consumes it first through one-line re-export stubs and the existing sync test suite verifies every step.

**Architecture:** `@memry/sync-core` keeps its npm name (all current `@memry/sync-core` importers keep working) and grows a `./engine` subpath export. The DI shape already exists as `SyncEngineDeps` in `engine/sync-context.ts`; this plan formalizes the ambient platform couplings (`electron.net`, `ws`, `electron-log`, `BrowserWindow`, `worker_threads`, `../crypto`, `../telemetry`) into named seams configured once by the desktop composition root (`runtime.ts`, which STAYS in desktop). Every moved file leaves a one-line re-export at its old path so `runtime.ts` and `ipc/sync-core-handlers.ts` import unchanged; every moved test moves with its code and runs under a new `sync-core` vitest project (forks pool) as the red→green gate.

**Tech Stack:** TypeScript (ESM, `.ts` extension imports), Vitest (forks pool for native `better-sqlite3`), Drizzle ORM (`BaseSQLiteDatabase` generic), `zod` v4, `jose`, `pako`, `@memry/contracts` (wire-format source of truth), `@memry/db-schema`, `@memry/crypto` (crypto seam — extracted by the crypto workstream, a hard prerequisite of this plan).

---

## Global Constraints

Copy these project-wide rules verbatim; every task obeys them.

- Backward compatibility is MANDATORY for production installs: every change must work for existing installs, no DB resets, sync protocol / IPC contracts / vault file formats / settings shapes must tolerate data written by older app versions.
- DB schema changes go through additive, hand-written D1/data-DB migrations that preserve existing rows (Drizzle snapshots broken past 0021; data-DB migrations are hand-written).
- Sync-server deploys BEFORE desktop/mobile clients for every additive change (D6 sync item types, D8 settings-push, entitlement_grants).
- Crypto parameters are IMMUTABLE and byte-identical across clients: Argon2id v1.3 ops=3, mem=64 MiB, parallelism=1; BLAKE2b crypto_kdf_derive_from_key with exact 8-char contexts (memryvlt/memrysgn/memryvrf/memrykve/memrylnk/memrymac/memrysas); base64 = sodium.base64_variants.ORIGINAL (standard alphabet, padded); cryptoVersion=1; canonical CBOR in CBOR_FIELD_ORDER.
- E2E-encrypted: server never sees plaintext; it verifies Ed25519 via WebCrypto and validates envelope lengths only.
- Offline-first: SQLite local storage is canonical on mobile; CRDT (Yjs) for note/journal bodies, field-level vector clocks for tasks/projects/calendar; correctness never depends on background execution.
- @blocknote/\*, yjs, and zod pinned IDENTICALLY to desktop across clients; a CI check fails the mobile build on drift; BlockNote bumps gated on the markdown round-trip / byte-preservation golden suite.
- @memry/contracts is the single wire-format source of truth; mobile MUST import, never copy (copying breaks cross-device crypto/signature interop).
- No Co-Authored-By trailer on commit messages.
- Prettier: single quotes, no semicolons, 100-char width, no trailing commas.
- RTL safety: new code uses logical Tailwind/RN props (ms-/me-, ps-/pe-, start-/end-) that flip automatically in RTL; RN uses I18nManager.forceRTL instead of document.dir.
- Extraction principle: move files, re-export from old paths, tests move with the code, desktop consumes the new package first — each extraction keeps desktop green, verified by the existing suite before mobile exists.
- Logging via createLogger('Scope') seam (never raw console.\*); user-facing errors via extractErrorMessage(err, fallback).
- WCAG AA + reduced-motion + RTL accessibility per PRODUCT.md; personality calm, private, crafted.

**Version pins (respect exactly):** `yjs = ~13.6.29`, `y-protocols = ^1.0.7`, `zod = ^4.3.4` (must match `packages/contracts`), `drizzle-orm = ^0.45.2`, `cborg = ^4.5.8`, desktop-side `libsodium-wrappers-sumo ^0.8.2`. Do NOT add `electron`, `ws`, `keytar`, `worker_threads`, or `node:*` as direct dependencies of `packages/sync-core` — those cross the boundary only through seams and `@memry/crypto`.

**Prerequisite:** `@memry/crypto` (the crypto workstream) must land first. Tasks 4, 9, 12, 13 import from `@memry/crypto`. If crypto has not landed when this plan starts, sequence after it — do not fork a second copy of the crypto files.

---

## Scope

**In scope (move to `packages/sync-core/src/`):** `engine/*` (sync-context, index, sync-state-manager, quarantine-manager, crdt-sync-coordinator, push-coordinator, pull-coordinator, corrupt-item-tracker, error-recovery-handler, full-sync-runner), `engine.ts`, `queue.ts`, `retry.ts`, `vector-clock.ts`, `field-merge.ts`, `offline-clock.ts`, `apply-item.ts`, `sync-errors.ts`, `encrypt.ts`, `decrypt.ts`, `compress.ts`, `manifest-check.ts`, `initial-seed.ts`, `token-manager.ts`, `device-keys.ts`, `auth-retry.ts`, `vault-adoption.ts`, `http-client.ts`, `websocket.ts`, `network.ts`, `worker-bridge.ts`, `worker-protocol.ts`, plus their `*.test.ts`.

**Out of scope — DO NOT move (stay in desktop):**

- The 15 record item-handlers (`sync/item-handlers/`) — separate concern; reached via the `HandlerRegistry` seam.
- The desktop composition root `runtime.ts` — rewired, not moved.
- `certificate-pinning.ts` / `certificate-pins.ts` — desktop-only pinned agent; supplied through the `WebSocketFactory` seam.
- **Composition/orchestration-coupled files deferred to the later `@memry/platform` + `@memry/app-kernel` workstream** (confirmed by reading their import blocks — they pull desktop-only modules that need `FileStore`/`KeyValueStore`/feature-service seams not defined here):
  - `local-mutations.ts` — imports `getFilterSyncService`/`getInboxSyncService`/`getJournalSyncService`/`getNoteSyncService` (desktop feature-sync, boundary-blocked) + `getDatabase`.
  - `device-registration.ts` — imports `./runtime`, `../store`, `../database/client`, `../calendar/google/sync-service`, `getOrCreateVaultUuid`.
  - `linking-service.ts` — imports `../database/client`, `../calendar/google/provider-auth-transfer`, `./vault-transfer`.
  - `vault-provisioning.ts` — imports `../database/client`, `../database/migrate`, `../vault/init`, `../vault`, `../store`.
    These four keep their current desktop paths and are untouched by this plan.

---

## File Structure

### Created

| Path                                                | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/sync-core/src/seams.ts`                   | The DI seam surface: type interfaces (`Logger`, `HttpClient`, `WebSocketFactory`, `EmitEvents`, `SecretStore`, `DeviceInfo`, `Telemetry`, `DrizzleDb`, `HandlerRegistry`, `WorkerBridge`, `CrdtProvider`, `SyncItemHandlerLike`, `ApplyContextLike`, `ApplyResult`) **plus** the configure-once ambient singletons (`configureSyncCore`, `createLogger`, `trackMainEvent`, `emitToRenderer`, `getHttpFetch`, `getSyncServerUrl`, `getSyncVaultHeaders`) that let each moved file change only its import path, never its call sites. Zero `electron`/`node`/`ws` imports. |
| `packages/sync-core/src/seams.test.ts`              | Unit test: default logger is a no-op, `configureSyncCore` installs host impls, and importing the module pulls in no platform module.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/sync-core/src/apply-item.package.test.ts` | Package-level unit test for `ItemApplier` against a **fake** `HandlerRegistry` (unknown-type → `'skipped'`, bad JSON → `'parse_error'`, upsert/delete routing). The existing desktop `apply-item.test.ts` stays in desktop because it exercises real desktop handlers.                                                                                                                                                                                                                                                                                                   |

### Modified

| Path                                              | Change                                                                                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/sync-core/package.json`                 | Add `./engine` subpath export; add deps `drizzle-orm@^0.45.2`, `jose`, `pako`, `@memry/db-schema` (workspace:_), `@memry/crypto` (workspace:_).                                                   |
| `packages/sync-core/src/index.ts`                 | Grow root barrel from 4 lines to the full machinery + `seams` surface.                                                                                                                            |
| `packages/sync-core/tsconfig.json`                | Keep `include: ["src/**/*"]`; ensure new files compile; no test files in the tsc program (already excluded).                                                                                      |
| `apps/desktop/config/vitest.config.ts`            | Add a `sync-core` vitest project (`pool: 'forks'`, node env) that globs `../../packages/sync-core/src/**`; remove the sync-core glob from the `shared` project so those tests run once.           |
| `apps/desktop/src/main/sync/*.ts` + `engine/*.ts` | Each moved file becomes a one-line re-export stub (`export * from '@memry/sync-core/...'`).                                                                                                       |
| `apps/desktop/src/main/sync/runtime.ts`           | STAYS. Calls `configureSyncCore({...})` once at startup with concrete seam impls; constructs `NetworkMonitor` with `createElectronNetworkDeps()`; passes `handlerRegistry` into `SyncEngineDeps`. |
| `apps/desktop/src/main/sync/apply-item.test.ts`   | STAYS in desktop; updated to pass a real `HandlerRegistry` (`{ getHandler, getRemoteSyncAdapter }` from `./item-handlers`) into `ItemApplier`.                                                    |

---

## Task 1: Package scaffolding + seams + vitest wiring

**Files:**

- Create: `packages/sync-core/src/seams.ts`, `packages/sync-core/src/seams.test.ts`
- Modify: `packages/sync-core/package.json`, `packages/sync-core/src/index.ts`, `apps/desktop/config/vitest.config.ts`

**Interfaces:**

- Produces:
  - `interface Logger { info(msg: string, ...a: unknown[]): void; warn(...): void; error(...): void; debug(...): void }`
  - `createLogger(scope: string): Logger`
  - `type HttpFetch = (url: string, init?: RequestInit) => Promise<Response>`; `interface HttpClient { fetch: HttpFetch }`
  - `interface WebSocketFactory { create(url: string, opts: { headers: Record<string,string> }): import('ws').WebSocket | WebSocket }`
  - `type EmitEvents = (channel: string, data: unknown) => void`; `emitToRenderer(channel: string, data: unknown): void`
  - `interface SecretStore { storeKey(entry, key: Uint8Array): Promise<void>; retrieveKey(entry): Promise<Uint8Array | null>; deleteKey(entry): Promise<void> }`
  - `interface DeviceInfo { getPlatform(): string; getDeviceName(): string; getAppVersion(): string }`
  - `type Telemetry = (surface: string, props?: Record<string, unknown>) => void`; `trackMainEvent(surface: string, props?): void`
  - `type DrizzleDb = BaseSQLiteDatabase<'sync', unknown, typeof dataSchema>`
  - `type ApplyResult = 'applied' | 'skipped' | 'conflict' | 'parse_error'`
  - `interface ApplyContextLike { db: DrizzleDb; emit: EmitEvents; vaultKey?: Uint8Array }`
  - `interface SyncItemHandlerLike { schema: { parse(i: unknown): unknown }; applyUpsert(ctx: ApplyContextLike, id: string, data: unknown, clock: VectorClock): ApplyResult; applyDelete(ctx: ApplyContextLike, id: string, clock?: VectorClock): ApplyResult }`
  - `interface HandlerRegistry { getHandler(type: SyncItemType): SyncItemHandlerLike | undefined; getRemoteSyncAdapter(type: SyncItemType): RemoteSyncAdapter<DrizzleDb, EmitEvents> | undefined; getAllRemoteSyncAdapters(): RemoteSyncAdapter<DrizzleDb, EmitEvents>[] }`
  - `interface WorkerBridge { /* re-exports SyncWorkerBridge shape — filled in Task 11 */ }`
  - `interface CrdtProvider { /* opaque; supplied by desktop */ }`
  - `configureSyncCore(host: Partial<{ logger: (scope: string) => Logger; http: HttpFetch; telemetry: Telemetry; emit: EmitEvents; syncServerUrl: string; vaultHeaders: () => Promise<Record<string,string>> }>): void`
  - `getHttpFetch(): HttpFetch`, `getSyncServerUrl(): string`, `getSyncVaultHeaders(): Promise<Record<string,string>>`

**Steps:**

- [ ] **Step 1: Write the failing test.** Create `packages/sync-core/src/seams.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureSyncCore, createLogger, emitToRenderer, getHttpFetch } from './seams.ts'

afterEach(() => {
  configureSyncCore({ logger: undefined, http: undefined, emit: undefined })
})

describe('sync-core seams', () => {
  it('#given no host configured #then createLogger returns a no-op logger', () => {
    const log = createLogger('Test')
    expect(() => log.info('hi', { a: 1 })).not.toThrow()
    expect(() => log.error('boom')).not.toThrow()
  })

  it('#given a host logger #when configured #then createLogger delegates to it', () => {
    const info = vi.fn()
    configureSyncCore({ logger: () => ({ info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) })
    createLogger('Scope').info('msg', 1)
    expect(info).toHaveBeenCalledWith('msg', 1)
  })

  it('#given a host emit #when emitToRenderer called #then forwards channel+data', () => {
    const emit = vi.fn()
    configureSyncCore({ emit })
    emitToRenderer('sync:status', { state: 'idle' })
    expect(emit).toHaveBeenCalledWith('sync:status', { state: 'idle' })
  })

  it('#given no http host #then getHttpFetch falls back to globalThis.fetch', () => {
    expect(getHttpFetch()).toBe(globalThis.fetch)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL.** `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project sync-core seams` — after Step 5 wires the project. Before the impl exists it fails with `Cannot find module './seams.ts'` / `configureSyncCore is not a function`.

- [ ] **Step 3: Minimal implementation.** Create `packages/sync-core/src/seams.ts`:

```ts
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type * as dataSchema from '@memry/db-schema/data-schema'
import type { SyncItemType, VectorClock } from '@memry/contracts/sync-api'
import type { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import type { RemoteSyncAdapter } from './adapter.ts'

export interface Logger {
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
  debug(msg: string, ...args: unknown[]): void
}

export type HttpFetch = (url: string, init?: RequestInit) => Promise<Response>
export interface HttpClient {
  fetch: HttpFetch
}

export interface WebSocketFactory {
  create(url: string, opts: { headers: Record<string, string> }): WebSocketLike
}
export interface WebSocketLike {
  on(event: string, cb: (...args: unknown[]) => void): void
  send(data: string): void
  close(code?: number, reason?: string): void
  ping(): void
  readonly readyState: number
}

export type EmitEvents = (channel: string, data: unknown) => void

type KeychainEntry = (typeof KEYCHAIN_ENTRIES)[keyof typeof KEYCHAIN_ENTRIES]
export interface SecretStore {
  storeKey(entry: KeychainEntry, key: Uint8Array): Promise<void>
  retrieveKey(entry: KeychainEntry): Promise<Uint8Array | null>
  deleteKey(entry: KeychainEntry): Promise<void>
}

export interface DeviceInfo {
  getPlatform(): string
  getDeviceName(): string
  getAppVersion(): string
}

export type Telemetry = (surface: string, props?: Record<string, unknown>) => void

export type DrizzleDb = BaseSQLiteDatabase<'sync', unknown, typeof dataSchema>

export type ApplyResult = 'applied' | 'skipped' | 'conflict' | 'parse_error'
export interface ApplyContextLike {
  db: DrizzleDb
  emit: EmitEvents
  vaultKey?: Uint8Array
}
export interface SyncItemHandlerLike {
  schema: { parse(input: unknown): unknown }
  applyUpsert(ctx: ApplyContextLike, itemId: string, data: unknown, clock: VectorClock): ApplyResult
  applyDelete(ctx: ApplyContextLike, itemId: string, clock?: VectorClock): ApplyResult
}
export interface HandlerRegistry {
  getHandler(type: SyncItemType): SyncItemHandlerLike | undefined
  getRemoteSyncAdapter(type: SyncItemType): RemoteSyncAdapter<DrizzleDb, EmitEvents> | undefined
  getAllRemoteSyncAdapters(): RemoteSyncAdapter<DrizzleDb, EmitEvents>[]
}

// Configure-once ambient singletons — set by the host composition root at startup
// so each moved file changes only its import path, never its call sites.
const noopLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} }
let loggerFactory: (scope: string) => Logger = () => noopLogger
let httpFetch: HttpFetch = (url, init) => globalThis.fetch(url, init)
let telemetry: Telemetry = () => {}
let emit: EmitEvents = () => {}
let syncServerUrl: string | undefined
let vaultHeaders: () => Promise<Record<string, string>> = async () => ({})

export interface SyncCoreHost {
  logger: ((scope: string) => Logger) | undefined
  http: HttpFetch | undefined
  telemetry: Telemetry | undefined
  emit: EmitEvents | undefined
  syncServerUrl: string | undefined
  vaultHeaders: (() => Promise<Record<string, string>>) | undefined
}

export function configureSyncCore(host: Partial<SyncCoreHost>): void {
  if ('logger' in host) loggerFactory = host.logger ?? (() => noopLogger)
  if ('http' in host) httpFetch = host.http ?? ((url, init) => globalThis.fetch(url, init))
  if ('telemetry' in host) telemetry = host.telemetry ?? (() => {})
  if ('emit' in host) emit = host.emit ?? (() => {})
  if ('syncServerUrl' in host) syncServerUrl = host.syncServerUrl
  if ('vaultHeaders' in host) vaultHeaders = host.vaultHeaders ?? (async () => ({}))
}

export const createLogger = (scope: string): Logger => loggerFactory(scope)
export const trackMainEvent: Telemetry = (surface, props) => telemetry(surface, props)
export const emitToRenderer: EmitEvents = (channel, data) => emit(channel, data)
export const getHttpFetch = (): HttpFetch => httpFetch
export const getSyncVaultHeaders = (): Promise<Record<string, string>> => vaultHeaders()
export function getSyncServerUrl(): string {
  if (syncServerUrl) return syncServerUrl
  const url = process.env.SYNC_SERVER_URL
  if (url) return url
  if (process.env.NODE_ENV === 'development') return 'http://localhost:8787'
  throw new Error('SYNC_SERVER_URL environment variable is not configured')
}
```

Add to `packages/sync-core/package.json` dependencies (keep alphabetical): `"@memry/crypto": "workspace:*"`, `"@memry/db-schema": "workspace:*"`, `"drizzle-orm": "^0.45.2"`, `"jose": "^5.9.6"`, `"pako": "^2.1.0"`; and add the subpath export:

```json
"exports": {
  ".": "./src/index.ts",
  "./engine": "./src/engine/index.ts"
}
```

(Confirm the `jose`/`pako` versions against `apps/desktop/package.json` before writing — match exactly.) Add `seams` to the root barrel `packages/sync-core/src/index.ts`:

```ts
export * from './adapter.ts'
export * from './crdt-sync.ts'
export * from './record-sync.ts'
export * from './registry.ts'
export * from './seams.ts'
```

- [ ] **Step 4: Wire the vitest project.** In `apps/desktop/config/vitest.config.ts`, remove `'../../packages/sync-core/src/**/*.{test,spec}.{ts,tsx}'` from the `shared` project's `include`, and add a new project after `main`:

```ts
{
  extends: true,
  test: {
    name: 'sync-core',
    root: appRoot,
    environment: 'node',
    include: ['../../packages/sync-core/src/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    isolate: true
  }
}
```

Run `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project sync-core` — expect PASS: `seams.test.ts` (4) + existing `record-sync.test.ts` + `registry.test.ts` green. Then `pnpm typecheck` — expect PASS.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(sync-core): add DI seam surface and sync-core vitest project"`

---

## Task 2: Move `http-client.ts` + `retry.ts`

**Files:**

- Move: `apps/desktop/src/main/sync/http-client.ts` → `packages/sync-core/src/http-client.ts`; `apps/desktop/src/main/sync/retry.ts` → `packages/sync-core/src/retry.ts`
- Move (tests): `http-client.test.ts`, `retry.test.ts` → `packages/sync-core/src/`
- Create (stubs): `apps/desktop/src/main/sync/http-client.ts`, `apps/desktop/src/main/sync/retry.ts` (re-export)

**Interfaces:**

- Consumes: `getHttpFetch`, `getSyncVaultHeaders`, `getSyncServerUrl` (Task 1).
- Produces: `getFromServer`, `postToServer`, `deleteFromServer`, `patchToServer`, `syncFetch`, `getSyncVaultHeaders` (re-exported), `pushCrdtSnapshot`, `fetchCrdtSnapshot`, `SyncServerError`, `NetworkError`, `RateLimitError`, `parseRetryAfterHeader`, `FetchFn`; `withRetry`, `sleep`, `DeadLetterError`, `RetryOptions`, `RetryResult`.

**Steps:**

- [ ] **Step 1: Move the test files.** `git mv apps/desktop/src/main/sync/http-client.test.ts packages/sync-core/src/http-client.test.ts` and `git mv apps/desktop/src/main/sync/retry.test.ts packages/sync-core/src/retry.test.ts`. Their imports are `./http-client` / `./retry` — unchanged (intra-package).

- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project sync-core http-client retry` → FAIL: `Cannot find module './http-client'` (impl not yet in package).

- [ ] **Step 3: Move + rewrite the impl.** `git mv apps/desktop/src/main/sync/http-client.ts packages/sync-core/src/http-client.ts` and `git mv apps/desktop/src/main/sync/retry.ts packages/sync-core/src/retry.ts`. In `packages/sync-core/src/http-client.ts` replace the top `import { net } from 'electron'` and the local `getSyncServerUrl` + `getSyncVaultHeaders` with seam calls:

```ts
import { getHttpFetch, getSyncServerUrl, getSyncVaultHeaders } from './seams.ts'
import { withRetry } from './retry.ts'
```

Delete the file-local `function getSyncServerUrl()` and `export async function getSyncVaultHeaders()` (now provided by the seam and re-exported below). In `syncFetch`, change the default fetch impl:

```ts
const fetchImpl = fetchFn ?? getHttpFetch()
```

Re-export the seam helper so existing importers keep resolving `getSyncVaultHeaders` from `./http-client`:

```ts
export { getSyncVaultHeaders } from './seams.ts'
```

`retry.ts` imports only `./http-client` — append `.ts`: `import { NetworkError, RateLimitError, SyncServerError } from './http-client.ts'`. (`http-client.ts` internal `import { withRetry } from './retry'` → `'./retry.ts'`.)

- [ ] **Step 4: Leave re-export stubs + run.** Create `apps/desktop/src/main/sync/http-client.ts`:

```ts
export * from '@memry/sync-core/http-client'
```

Wait — the package root barrel does not export a `/http-client` subpath. Instead re-export through the package modules the desktop imports. Add machinery re-exports to `packages/sync-core/src/index.ts` (append):

```ts
export * from './http-client.ts'
export * from './retry.ts'
```

Then the stub is `export * from '@memry/sync-core'`. To avoid a giant surface leaking, prefer the direct file re-export via the package's internal path alias used elsewhere — but `@memry/sync-core` only exposes `.` and `./engine`. Use the root barrel: `apps/desktop/src/main/sync/http-client.ts` → `export * from '@memry/sync-core'` re-exports every machinery symbol, which is broader than needed. Keep it scoped instead by re-exporting the named symbols the desktop tree imports:

```ts
export {
  getFromServer,
  postToServer,
  deleteFromServer,
  patchToServer,
  syncFetch,
  getSyncVaultHeaders,
  pushCrdtSnapshot,
  fetchCrdtSnapshot,
  parseRetryAfterHeader,
  SyncServerError,
  NetworkError,
  RateLimitError
} from '@memry/sync-core'
export type { FetchFn, CrdtSnapshotResponse, CrdtBatchPullResponse } from '@memry/sync-core'
```

And `apps/desktop/src/main/sync/retry.ts`:

```ts
export { withRetry, sleep, DeadLetterError } from '@memry/sync-core'
export type { RetryOptions, RetryResult } from '@memry/sync-core'
```

Run `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project sync-core http-client retry` → PASS (both suites). Then `pnpm --filter @memry/desktop test:main` → PASS (desktop resolves through the stubs). Then `pnpm typecheck` → PASS.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "refactor(sync-core): move http-client and retry behind HttpClient seam"`

---

## Task 3: Move pure leaves — `vector-clock.ts`, `field-merge.ts`, `compress.ts`

**Files:**

- Move: `vector-clock.ts`, `field-merge.ts`, `compress.ts` (+ `vector-clock.test.ts`, `field-merge.test.ts`) → `packages/sync-core/src/`
- Create (stubs): the three old desktop paths.

**Interfaces:**

- Produces: `createClock`, `increment`, `merge`, `compare`, `getTick`, `VectorClock`, `ClockComparison` (vector-clock); `TASK_SYNCABLE_FIELDS`, `PROJECT_SYNCABLE_FIELDS`, `initAllFieldClocks`, field-clock merge helpers, `FieldClocks` (field-merge); `compressPayload`, `decompressPayload` (compress).

**Steps:**

- [ ] **Step 1: Move tests.** `git mv` `vector-clock.test.ts` and `field-merge.test.ts` into `packages/sync-core/src/`. (`compress.ts` has no standalone test; its coverage rides in `encrypt.test.ts`/`decrypt.test.ts`, moved in Task 9.) Their imports (`./vector-clock`, `./field-merge`) are intra-package.

- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project sync-core vector-clock field-merge` → FAIL: `Cannot find module './vector-clock'`.

- [ ] **Step 3: Move impls + rewrite intra imports.** `git mv` the three impl files into `packages/sync-core/src/`. `vector-clock.ts` and `compress.ts` have no relative imports (only `@memry/contracts` / `pako`) — no change beyond nothing. `field-merge.ts` imports `./vector-clock` — append `.ts`: `import { merge as mergeClock } from './vector-clock.ts'` and `import { compare as compareClock } from './vector-clock.ts'`. Append to `packages/sync-core/src/index.ts`:

```ts
export * from './vector-clock.ts'
export * from './field-merge.ts'
export * from './compress.ts'
```

- [ ] **Step 4: Stubs + run.** Stub `apps/desktop/src/main/sync/vector-clock.ts`:

```ts
export * from '@memry/sync-core'
```

(vector-clock's symbols are already surfaced by the root barrel.) Stub `field-merge.ts` and `compress.ts` the same way. Run `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project sync-core vector-clock field-merge` → PASS. `pnpm --filter @memry/desktop test:main` → PASS. `pnpm typecheck` → PASS.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "refactor(sync-core): move pure vector-clock, field-merge, compress leaves"`

---

## Task 4: Move `sync-errors.ts`

**Files:**

- Move: `sync-errors.ts` + `sync-errors.test.ts` → `packages/sync-core/src/`
- Create (stub): `apps/desktop/src/main/sync/sync-errors.ts`

**Interfaces:**

- Consumes: `SyncServerError`, `NetworkError`, `RateLimitError` (`./http-client.ts`), `DeadLetterError` (`./retry.ts`), `CryptoError` (`@memry/crypto`).
- Produces: `classifyError(error: unknown): SyncErrorInfo`, `SyncErrorInfo`, `SyncErrorCategory`.

**Steps:**

- [ ] **Step 1: Move the test.** `git mv apps/desktop/src/main/sync/sync-errors.test.ts packages/sync-core/src/sync-errors.test.ts`.

- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project sync-core sync-errors` → FAIL: module not found.

- [ ] **Step 3: Move + rewrite.** `git mv apps/desktop/src/main/sync/sync-errors.ts packages/sync-core/src/sync-errors.ts`. Rewrite its imports:

```ts
import type { SyncErrorCategory } from '@memry/contracts/ipc-sync-ops'
import { CryptoError } from '@memry/crypto'
import { SyncServerError, NetworkError, RateLimitError } from './http-client.ts'
import { DeadLetterError } from './retry.ts'
```

(`CryptoError` was `../crypto/crypto-errors` → now `@memry/crypto`. Confirm `@memry/crypto` re-exports `CryptoError` from its barrel; if it exports a subpath, use `@memry/crypto/crypto-errors`.) Append `export * from './sync-errors.ts'` to the barrel.

- [ ] **Step 4: Stub + run.** `apps/desktop/src/main/sync/sync-errors.ts` → `export * from '@memry/sync-core'`. Run the moved suite → PASS; `pnpm --filter @memry/desktop test:main` → PASS; `pnpm typecheck` → PASS.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "refactor(sync-core): move sync-errors classifyError, route CryptoError to @memry/crypto"`

---

## Task 5: Move `network.ts`

**Files:**

- Move: `network.ts` + `network.test.ts` → `packages/sync-core/src/`
- Create: `apps/desktop/src/main/sync/network-electron-deps.ts` (holds the `require('electron')` factory that must NOT live in the package)
- Create (stub): `apps/desktop/src/main/sync/network.ts`

**Interfaces:**

- Produces: `class NetworkMonitor` (constructor now REQUIRES `deps: NetworkMonitorDeps`), `NetworkMonitorDeps`.
- Produces (desktop): `createElectronNetworkDeps(): NetworkMonitorDeps`.

**Steps:**

- [ ] **Step 1: Move the test + add the failing expectation.** `git mv apps/desktop/src/main/sync/network.test.ts packages/sync-core/src/network.test.ts`. The moved package copy must construct `NetworkMonitor` WITH explicit `deps` (it cannot fall back to electron). Confirm the existing test already passes a fake `deps`; if any case constructs `new NetworkMonitor(debounce)` with no deps, update it to pass a stub `deps`. Add one assertion documenting the seam boundary:

```ts
it('#given no deps #then constructor throws (no electron fallback in the package)', () => {
  // @ts-expect-error deliberately omitting required deps
  expect(() => new NetworkMonitor(2000)).toThrow()
})
```

- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project sync-core network` → FAIL: module not found / constructor does not throw.

- [ ] **Step 3: Move + strip electron.** `git mv apps/desktop/src/main/sync/network.ts packages/sync-core/src/network.ts`. Delete the `createElectronDeps()` function and make `deps` required:

```ts
constructor(debounceMs: number | undefined, deps: NetworkMonitorDeps) {
  super()
  this.setMaxListeners(MAX_NETWORK_MONITOR_LISTENERS)
  this.deps = deps
  this.debounceMs = debounceMs ?? DEFAULT_DEBOUNCE_MS
  this._online = this.deps.getIsOnline()
}
```

Create `apps/desktop/src/main/sync/network-electron-deps.ts` with the removed factory:

```ts
import type { NetworkMonitorDeps } from '@memry/sync-core'

export function createElectronNetworkDeps(): NetworkMonitorDeps {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy import avoids Electron in tests
  const electron = require('electron') as typeof import('electron')
  return {
    getIsOnline: () => electron.net.online,
    onResume: (cb) => electron.powerMonitor.on('resume', cb),
    onSuspend: (cb) => electron.powerMonitor.on('suspend', cb),
    offResume: (cb) => electron.powerMonitor.removeListener('resume', cb),
    offSuspend: (cb) => electron.powerMonitor.removeListener('suspend', cb)
  }
}
```

Append `export * from './network.ts'` to the barrel.

- [ ] **Step 4: Stub + rewire caller + run.** Stub `apps/desktop/src/main/sync/network.ts` → `export * from '@memry/sync-core'`. In `runtime.ts`, change the `new NetworkMonitor(...)` call to pass deps: `new NetworkMonitor(undefined, createElectronNetworkDeps())` (import from `./network-electron-deps`). Run the moved suite → PASS; `pnpm --filter @memry/desktop test:main` → PASS; `pnpm typecheck` → PASS.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "refactor(sync-core): move NetworkMonitor, keep electron powerMonitor deps in desktop"`

---

## Task 6: Move `websocket.ts`

**Files:**

- Move: `websocket.ts` + `websocket.test.ts` → `packages/sync-core/src/`
- Create (stub): `apps/desktop/src/main/sync/websocket.ts`

**Interfaces:**

- Consumes: `WebSocketFactory`, `WebSocketLike`, `createLogger`, `getSyncVaultHeaders` (seams / http-client).
- Produces: `class WebSocketManager` (constructor `deps` gains `wsFactory: WebSocketFactory`), `WebSocketManagerDeps`, `WebSocketMessage`, `CLOSE_CODE_DEVICE_REVOKED`, `CLOSE_CODE_VERSION_INCOMPATIBLE`.

**Steps:**

- [ ] **Step 1: Move the test.** `git mv apps/desktop/src/main/sync/websocket.test.ts packages/sync-core/src/websocket.test.ts`. If the existing test mocks `ws` and/or `./certificate-pinning`, replace those mocks with a fake `WebSocketFactory` passed via `deps.wsFactory` (a small `EventEmitter`-backed `WebSocketLike`). This is the only non-mechanical edit in this task; keep the same behavioral assertions (heartbeat timeout, 4004/4009 close handling, reconnect backoff).

- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project sync-core websocket` → FAIL: module not found / `ws` import present.

- [ ] **Step 3: Move + seam the factory.** `git mv apps/desktop/src/main/sync/websocket.ts packages/sync-core/src/websocket.ts`. Replace the top imports:

```ts
import { EventEmitter } from 'events'
import { z } from 'zod'
import {
  createLogger,
  getSyncVaultHeaders,
  type WebSocketFactory,
  type WebSocketLike
} from './seams.ts'
```

Delete `import WebSocket from 'ws'` and `import { createPinnedAgent, CertificatePinningError } from './certificate-pinning'` and `import { getSyncVaultHeaders } from './http-client'`. Add `wsFactory: WebSocketFactory` to `WebSocketManagerDeps`; replace the `new WebSocket(url, { headers, agent })` construction with `this.deps.wsFactory.create(url, { headers })`; type the socket field as `WebSocketLike | null`. Certificate-pinning + `CertificatePinningError` handling moves into the desktop factory (Task 16) — the manager only sees the `WebSocketLike` and its close codes. Append `export * from './websocket.ts'` to the barrel.

- [ ] **Step 4: Stub + run.** Stub `apps/desktop/src/main/sync/websocket.ts` → `export * from '@memry/sync-core'`. Run the moved suite → PASS; `pnpm --filter @memry/desktop test:main` → PASS; `pnpm typecheck` → PASS.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "refactor(sync-core): move WebSocketManager behind WebSocketFactory seam"`

---

## Task 7: Move `queue.ts`

**Files:**

- Move: `queue.ts` + `queue.test.ts` → `packages/sync-core/src/`
- Create (stub): `apps/desktop/src/main/sync/queue.ts`

**Interfaces:**

- Consumes: `DrizzleDb`, `createLogger` (seams).
- Produces: `class SyncQueueManager` (constructor `db: DrizzleDb`), `QueueStats`, `EnqueueInput`, `DEFAULT_MAX_ATTEMPTS`, `ERROR_RETENTION_DAYS`.

**Steps:**

- [ ] **Step 1: Move the test.** `git mv apps/desktop/src/main/sync/queue.test.ts packages/sync-core/src/queue.test.ts`. It uses `@tests/utils/test-db` (`createTestDataDb`) — the `@tests` alias resolves because the `sync-core` vitest project extends the same base config. If the test mocks `'../lib/logger'`, delete that mock (the package default logger is a no-op).

- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project sync-core queue` → FAIL: module not found.

- [ ] **Step 3: Move + widen the DB type.** `git mv apps/desktop/src/main/sync/queue.ts packages/sync-core/src/queue.ts`. Replace `import type { DataDb } from '../database'` and `import { createLogger } from '../lib/logger'` with:

```ts
import { createLogger, type DrizzleDb } from './seams.ts'
```

Change `constructor(private readonly db: DataDb)` → `constructor(private readonly db: DrizzleDb)`. Everything else (drizzle-orm operators, `@memry/db-schema/schema/sync-queue`, `@memry/contracts/sync-api`) is unchanged. Append `export * from './queue.ts'` to the barrel.

- [ ] **Step 4: Stub + run.** Stub `apps/desktop/src/main/sync/queue.ts` → `export * from '@memry/sync-core'`. Run moved suite → PASS. `pnpm --filter @memry/desktop test:main` → PASS. `pnpm typecheck` → PASS. If `better-sqlite3` throws `ERR_DLOPEN_FAILED`/`NODE_MODULE_VERSION`, run `pnpm --filter @memry/desktop rebuild:node` and re-run.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "refactor(sync-core): move SyncQueueManager on DrizzleDb generic"`

---

## Task 8: Move `offline-clock.ts`

**Files:**

- Move: `offline-clock.ts` → `packages/sync-core/src/` (its coverage rides in `field-merge.test.ts`/`local-mutations` desktop tests; no standalone test file to move — confirm with `ls apps/desktop/src/main/sync/offline-clock.test.ts` first)
- Create (stub): `apps/desktop/src/main/sync/offline-clock.ts`

**Interfaces:**

- Consumes: `increment` (`./vector-clock.ts`), `initAllFieldClocks`, `TASK_SYNCABLE_FIELDS`, `PROJECT_SYNCABLE_FIELDS` (`./field-merge.ts`), `createLogger`, `DrizzleDb` (seams).
- Produces: `incrementTaskClocksOffline`, `incrementProjectClocksOffline`, `incrementInboxClockOffline`, `incrementFilterClockOffline` (verify exact export names by reading the file body before moving).

**Steps:**

- [ ] **Step 1: Read + confirm exports.** `rtk grep -n "export" apps/desktop/src/main/sync/offline-clock.ts` and note the exact exported symbols so the stub re-exports them. Check for a `.test.ts`; if present, `git mv` it too and follow the standard failing-first order.

- [ ] **Step 2: Run baseline.** `pnpm --filter @memry/desktop test:main` — capture the current green so any offline-clock consumer test (e.g. `local-mutations.test.ts`, which stays in desktop) is the regression gate.

- [ ] **Step 3: Move + rewrite imports.** `git mv apps/desktop/src/main/sync/offline-clock.ts packages/sync-core/src/offline-clock.ts`. Rewrite:

```ts
import { increment } from './vector-clock.ts'
import { initAllFieldClocks, TASK_SYNCABLE_FIELDS, PROJECT_SYNCABLE_FIELDS } from './field-merge.ts'
import { createLogger, type DrizzleDb } from './seams.ts'
```

Replace `import type { DataDb } from '../database/client'` usages with the `DrizzleDb` seam type. Append `export * from './offline-clock.ts'` to the barrel.

- [ ] **Step 4: Stub + run.** Note: `check-architecture-boundaries.js` lists `sync/offline-clock` in `blockedFeatureSyncImports`. Read that script's logic first; the block targets the _desktop_ path being imported by feature code. Keep the desktop stub path so the boundary rule still resolves:

```ts
export * from '@memry/sync-core'
```

Run `pnpm --filter @memry/desktop test:main` → PASS (offline-clock consumers green through the stub). `pnpm check:architecture` → PASS. `pnpm typecheck` → PASS.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "refactor(sync-core): move offline-clock onto DrizzleDb seam"`

---

## Task 9: Move `encrypt.ts` + `decrypt.ts`

**Files:**

- Move: `encrypt.ts`, `decrypt.ts` + `encrypt.test.ts`, `decrypt.test.ts` → `packages/sync-core/src/`
- Create (stubs): the two old desktop paths.

**Interfaces:**

- Consumes: `@memry/crypto` (`encrypt`, `decrypt`, `wrapFileKey`, `unwrapFileKey`, `signPayload`, `verifySignature`, `generateFileKey`, `secureCleanup`), `compressPayload`/`decompressPayload` (`./compress.ts`), `CBOR_FIELD_ORDER` (`@memry/contracts/cbor-ordering`), `sodium` (via `@memry/crypto`'s ready gate — do NOT import `libsodium-wrappers-sumo` directly).
- Produces: per-item `encryptItem`/`decryptItem` (confirm exact export names from the file bodies), `EncryptItemInput`, `SignatureVerificationError`.

**Steps:**

- [ ] **Step 1: Move tests.** `git mv` `encrypt.test.ts` and `decrypt.test.ts` into `packages/sync-core/src/`. These are the byte-compat gate — they assert crypto params are byte-identical. Do not weaken any assertion.

- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project sync-core encrypt decrypt` → FAIL: module not found.

- [ ] **Step 3: Move + route crypto to `@memry/crypto`.** `git mv` both impls. In `encrypt.ts` replace:

```ts
import { encrypt, wrapFileKey } from '@memry/crypto'
import { signPayload } from '@memry/crypto'
import { generateFileKey, secureCleanup } from '@memry/crypto'
import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'
import { compressPayload } from './compress.ts'
```

Delete `import sodium from 'libsodium-wrappers-sumo'`; if the file calls `sodium.*` directly, route those calls through the `@memry/crypto` primitives (the crypto workstream exposes the exact `SodiumProvider` surface behind `ready()`). In `decrypt.ts` replace with `import { decrypt, unwrapFileKey } from '@memry/crypto'`, `import { verifySignature } from '@memry/crypto'`, `import { secureCleanup } from '@memry/crypto'`, and `import { decompressPayload } from './compress.ts'`. Append `export * from './encrypt.ts'` and `export * from './decrypt.ts'` to the barrel.

- [ ] **Step 4: Stubs + run.** Stub `encrypt.ts` and `decrypt.ts` desktop paths → `export * from '@memry/sync-core'`. Run the moved suite → PASS (byte-compat green). `pnpm --filter @memry/desktop test:main` → PASS. `pnpm typecheck` → PASS.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "refactor(sync-core): move encrypt/decrypt onto @memry/crypto"`

---

## Task 10: Move `manifest-check.ts` + `initial-seed.ts`

**Files:**

- Move: `manifest-check.ts`, `initial-seed.ts` + `manifest-check.test.ts`, `initial-seed.test.ts` → `packages/sync-core/src/`
- Create (stubs): the two old desktop paths.

**Interfaces:**

- Consumes: `withRetry` (`./retry.ts`), `getFromServer` (`./http-client.ts`), `SyncQueueManager` (`./queue.ts`), `DrizzleDb`, `HandlerRegistry` (seams — `initial-seed` needs `getAllRemoteSyncAdapters`), `createLogger`.
- Produces: manifest integrity check exports + seed exports (read the file bodies to confirm exact names).

**Steps:**

- [ ] **Step 1: Move tests.** `git mv` `manifest-check.test.ts` and `initial-seed.test.ts`. If `initial-seed.test.ts` relies on the real `getAllRemoteSyncAdapters` from desktop item-handlers, update it to pass a `HandlerRegistry` stub (or the real desktop registry object) into the seeder. Keep behavioral assertions unchanged.

- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project sync-core manifest-check initial-seed` → FAIL: module not found.

- [ ] **Step 3: Move + seam the registry.** `git mv` both impls. In `manifest-check.ts`:

```ts
import { withRetry } from './retry.ts'
import { getFromServer } from './http-client.ts'
import type { SyncQueueManager } from './queue.ts'
import { createLogger, type DrizzleDb } from './seams.ts'
```

Replace `import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'` + `type DrizzleDb = ...` with the seam `DrizzleDb`. In `initial-seed.ts` replace `import { getAllRemoteSyncAdapters } from './item-handlers'` with an injected `HandlerRegistry` parameter — change the seed entry function to accept `registry: HandlerRegistry` and call `registry.getAllRemoteSyncAdapters()` instead of the static import; replace the `BetterSQLite3Database` type with the seam `DrizzleDb`. Append `export * from './manifest-check.ts'` and `export * from './initial-seed.ts'` to the barrel.

- [ ] **Step 4: Stubs + run.** Stub both desktop paths → `export * from '@memry/sync-core'`. The desktop caller of the seed function (in `engine.ts` / `runtime.ts`) now passes the registry — wired in Tasks 15/16; until then keep desktop compiling by having the stub-side caller pass `{ getHandler, getRemoteSyncAdapter, getAllRemoteSyncAdapters }` from `./item-handlers`. Run the moved suite → PASS. `pnpm --filter @memry/desktop test:main` → PASS. `pnpm typecheck` → PASS.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "refactor(sync-core): move manifest-check and initial-seed with HandlerRegistry seam"`

---

## Task 11: Move `worker-protocol.ts` + `worker-bridge.ts`

**Files:**

- Move: `worker-protocol.ts`, `worker-bridge.ts` + `worker-bridge.test.ts` → `packages/sync-core/src/`
- Create: `apps/desktop/src/main/sync/worker-bridge-node.ts` (the concrete `worker_threads` construction stays desktop)
- Create (stubs): `worker-protocol.ts`, `worker-bridge.ts` old paths.

**Interfaces:**

- Produces: all `worker-protocol.ts` message types (pure — no platform deps); `interface SyncWorkerBridge` (the optional `WorkerBridge` seam shape — `start()`, `encryptBatch(...)`, `decryptBatch(...)`, `dispose()`; read the file to copy the exact method signatures).
- Produces (desktop): `class NodeSyncWorkerBridge implements SyncWorkerBridge` wrapping `worker_threads`.

**Steps:**

- [ ] **Step 1: Move the test.** `git mv apps/desktop/src/main/sync/worker-bridge.test.ts packages/sync-core/src/worker-bridge.test.ts`. If it constructs the concrete `worker_threads`-backed bridge, split: keep the concrete-Worker cases in a desktop test `worker-bridge-node.test.ts` (created here, staying under `test:main`), and keep in the package copy only the cases that exercise the interface/protocol against a fake worker. `worker_threads` must never be imported by a package test.

- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project sync-core worker-bridge` → FAIL.

- [ ] **Step 3: Move protocol + extract the interface.** `git mv apps/desktop/src/main/sync/worker-protocol.ts packages/sync-core/src/worker-protocol.ts` (pure types — imports unchanged). Split `worker-bridge.ts`: move the `SyncWorkerBridge` interface + protocol wiring types into `packages/sync-core/src/worker-bridge.ts` (import `createLogger` from `./seams.ts`, import protocol types from `./worker-protocol.ts`), and move the concrete `class` that does `new Worker(join(__dirname, 'sync-worker.js'))` into `apps/desktop/src/main/sync/worker-bridge-node.ts` as `NodeSyncWorkerBridge implements SyncWorkerBridge` (imports `worker_threads`, `path`, and the interface from `@memry/sync-core`). Append `export * from './worker-protocol.ts'` and `export * from './worker-bridge.ts'` to the barrel.

- [ ] **Step 4: Stubs + run.** Stub `worker-protocol.ts` → `export * from '@memry/sync-core'`. Stub `worker-bridge.ts` → `export * from '@memry/sync-core'` plus `export { NodeSyncWorkerBridge } from './worker-bridge-node'` so `runtime.ts` (which constructs the bridge) keeps importing from `./worker-bridge`. Run the moved suite + the new desktop `worker-bridge-node.test.ts` → PASS. `pnpm --filter @memry/desktop test:main` → PASS. `pnpm typecheck` → PASS.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "refactor(sync-core): move worker protocol + bridge interface, keep worker_threads in desktop"`

---

## Task 12: Refactor + move `apply-item.ts` (HandlerRegistry seam)

**Files:**

- Modify (pre-move): `apps/desktop/src/main/sync/apply-item.ts` — inject the registry.
- Move: `apply-item.ts` → `packages/sync-core/src/apply-item.ts`
- Create: `packages/sync-core/src/apply-item.package.test.ts` (fake-registry unit test)
- Keep in desktop: `apps/desktop/src/main/sync/apply-item.test.ts` (updated to inject the real registry)
- Create (stub): `apps/desktop/src/main/sync/apply-item.ts`

**Interfaces:**

- Consumes: `HandlerRegistry`, `ApplyResult`, `ApplyContextLike`, `EmitEvents`, `DrizzleDb`, `createLogger` (seams).
- Produces: `class ItemApplier` with constructor `(db: DrizzleDb, emitToWindows: EmitEvents, registry: HandlerRegistry, adapters?: SyncAdapterRegistry<DrizzleDb, EmitEvents>)`; `ApplyItemInput`; re-export `ApplyResult`, `EmitToWindows` (alias of `EmitEvents`).

**Steps:**

- [ ] **Step 1: Write the failing package test.** Create `packages/sync-core/src/apply-item.package.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import type { HandlerRegistry, SyncItemHandlerLike } from './seams.ts'
import { ItemApplier } from './apply-item.ts'

function fakeRegistry(handler?: SyncItemHandlerLike): HandlerRegistry {
  return {
    getHandler: () => handler,
    getRemoteSyncAdapter: () => undefined,
    getAllRemoteSyncAdapters: () => []
  }
}

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o))

describe('ItemApplier (package, fake registry)', () => {
  it('#given unknown type #then skipped', () => {
    const applier = new ItemApplier({} as never, vi.fn(), fakeRegistry())
    expect(
      applier.apply({ itemId: 'x', type: 'task', operation: 'update', content: enc({ id: 'x' }) })
    ).toBe('skipped')
  })

  it('#given invalid JSON #then parse_error', () => {
    const handler: SyncItemHandlerLike = {
      schema: { parse: (i) => i },
      applyUpsert: vi.fn(() => 'applied' as const),
      applyDelete: vi.fn(() => 'applied' as const)
    }
    const applier = new ItemApplier({} as never, vi.fn(), fakeRegistry(handler))
    const bad = new Uint8Array([0xff, 0xfe])
    expect(applier.apply({ itemId: 'x', type: 'task', operation: 'update', content: bad })).toBe(
      'parse_error'
    )
  })

  it('#given create #then routes to handler.applyUpsert', () => {
    const applyUpsert = vi.fn(() => 'applied' as const)
    const handler: SyncItemHandlerLike = {
      schema: { parse: (i) => i },
      applyUpsert,
      applyDelete: vi.fn(() => 'applied' as const)
    }
    const applier = new ItemApplier({} as never, vi.fn(), fakeRegistry(handler))
    applier.apply({ itemId: 'x', type: 'task', operation: 'create', content: enc({ id: 'x' }) })
    expect(applyUpsert).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project sync-core apply-item.package` → FAIL: module not found / constructor arity.

- [ ] **Step 3: Refactor + move.** In `apps/desktop/src/main/sync/apply-item.ts` first replace the static import with an injected registry, then `git mv` to the package. Final package `apply-item.ts`:

```ts
import type { VectorClock, SyncItemType } from '@memry/contracts/sync-api'
import type { SyncAdapterRegistry } from './registry.ts'
import {
  createLogger,
  type ApplyResult,
  type DrizzleDb,
  type EmitEvents,
  type HandlerRegistry
} from './seams.ts'

export type EmitToWindows = EmitEvents
export type { ApplyResult }

const log = createLogger('ItemApplier')

export interface ApplyItemInput {
  itemId: string
  type: SyncItemType
  operation: 'create' | 'update' | 'delete'
  content: Uint8Array
  clock?: VectorClock
  deletedAt?: number
  vaultKey?: Uint8Array
}

export class ItemApplier {
  constructor(
    private db: DrizzleDb,
    private emitToWindows: EmitEvents,
    private registry: HandlerRegistry,
    private adapters?: SyncAdapterRegistry<DrizzleDb, EmitEvents>
  ) {}

  apply(input: ApplyItemInput): ApplyResult {
    const ctx = { db: this.db, emit: this.emitToWindows, vaultKey: input.vaultKey }
    const adapter =
      this.adapters?.getRemote(input.type) ?? this.registry.getRemoteSyncAdapter(input.type)
    const handler = adapter ? null : this.registry.getHandler(input.type)
    // ...rest of the original body unchanged (delete branch, JSON parse, schema.parse, upsert branch)...
  }
}
```

(Preserve the original method body verbatim below the `handler` line — only the two static-call sites `getRemoteSyncAdapter(input.type)` / `getHandler(input.type)` become `this.registry.*`.) Append `export * from './apply-item.ts'` to the barrel.

- [ ] **Step 4: Keep desktop test green + stub.** Update `apps/desktop/src/main/sync/apply-item.test.ts` (STAYS in desktop): add `import { getHandler, getRemoteSyncAdapter, getAllRemoteSyncAdapters } from './item-handlers'` and construct `new ItemApplier(db, emit, { getHandler, getRemoteSyncAdapter, getAllRemoteSyncAdapters })`. Stub `apps/desktop/src/main/sync/apply-item.ts` → `export * from '@memry/sync-core'`. Run `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project sync-core apply-item.package` → PASS; `pnpm --filter @memry/desktop test:main` (runs desktop `apply-item.test.ts` through the stub against real handlers) → PASS; `pnpm typecheck` → PASS.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "refactor(sync-core): move ItemApplier behind HandlerRegistry seam"`

---

## Task 13: Move `token-manager.ts`

**Files:**

- Move: `token-manager.ts` + `token-manager.test.ts` → `packages/sync-core/src/`
- Create (stub): `apps/desktop/src/main/sync/token-manager.ts`

**Interfaces:**

- Consumes: `storeKey`, `retrieveKey` (`@memry/crypto` SecretStore), `emitToRenderer`, `createLogger` (seams), `postToServer`, `SyncServerError` (`./http-client.ts`), `decodeJwt` (`jose`), `KEYCHAIN_ENTRIES`/`SYNC_EVENTS`/`RefreshTokenResponseSchema` (`@memry/contracts`).
- Produces: `storeToken`, `retrieveToken`, `extractJtiFromToken`, `isTokenExpired`, `scheduleTokenRefresh`, `setOnTokenRefreshed`, `ACCESS_TOKEN_EXPIRY_SECONDS` (confirm the full export list by reading the file before stubbing).

**Steps:**

- [ ] **Step 1: Move the test.** `git mv apps/desktop/src/main/sync/token-manager.test.ts packages/sync-core/src/token-manager.test.ts`. If it mocks `'../crypto'` (storeKey/retrieveKey) or `electron` `BrowserWindow`, re-point: mock `@memry/crypto` for the secret store, and assert renderer emissions by configuring a spy `emit` via `configureSyncCore({ emit })` in `beforeEach`.

- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project sync-core token-manager` → FAIL.

- [ ] **Step 3: Move + rewrite.** `git mv` the impl. Replace the header:

```ts
import { decodeJwt } from 'jose'
import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import { SYNC_EVENTS } from '@memry/contracts/ipc-sync'
import { RefreshTokenResponseSchema } from '@memry/contracts/auth-api'
import { storeKey, retrieveKey } from '@memry/crypto'
import { postToServer, SyncServerError } from './http-client.ts'
import { createLogger, emitToRenderer } from './seams.ts'
```

Delete `import { BrowserWindow } from 'electron'`. Replace the `const windows = BrowserWindow.getAllWindows()` broadcast block (around line 82) with a single `emitToRenderer(SYNC_EVENTS.<event>, payload)` call carrying the same channel + payload the loop used. Append `export * from './token-manager.ts'` to the barrel.

- [ ] **Step 4: Stub + run.** Stub `apps/desktop/src/main/sync/token-manager.ts` → `export * from '@memry/sync-core'`. Run the moved suite → PASS; `pnpm --filter @memry/desktop test:main` → PASS; `pnpm typecheck` → PASS.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "refactor(sync-core): move token-manager onto SecretStore + EmitEvents seams"`

---

## Task 14: Move `device-keys.ts` + `auth-retry.ts` + `vault-adoption.ts`

**Files:**

- Move: `device-keys.ts`, `auth-retry.ts`, `vault-adoption.ts` + `device-keys.test.ts`, `auth-retry.test.ts`, `vault-adoption.test.ts` → `packages/sync-core/src/`
- Create (stubs): the three old desktop paths.

**Interfaces:**

- Consumes: `@memry/crypto` (device-keys crypto + `vault-adoption` `VAULT_KEY_VERIFIER_SETTING` — confirm this constant is re-exported by `@memry/crypto` from its `vault-key-state` module; if it stays a contracts constant, import from `@memry/contracts`), `getFromServer`/`withRetry` (`./http-client.ts`/`./retry.ts`), `DrizzleDb`, `createLogger` (seams), `SyncServerError` (`./http-client.ts`, for auth-retry).
- Produces: `getDeviceSigningKey` + device-keys exports; `withAuthRetry`, `AuthRetryDeps`; vault-adoption `adoptVaultLocally` (confirm names).

**Steps:**

- [ ] **Step 1: Move tests.** `git mv` the three `*.test.ts`. Re-point any `'../crypto'` / `'../lib/logger'` mocks to `@memry/crypto` / delete (default no-op logger). `device-keys.test.ts` uses `@tests/utils/test-db` — resolves via the alias.

- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project sync-core device-keys auth-retry vault-adoption` → FAIL.

- [ ] **Step 3: Move + rewrite.** `git mv` all three impls. `device-keys.ts` header:

```ts
import { eq } from 'drizzle-orm'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { DeviceKeysResponseSchema } from '@memry/contracts/sync-api'
import { createLogger, type DrizzleDb } from './seams.ts'
import { getFromServer } from './http-client.ts'
import { withRetry } from './retry.ts'
```

Delete `import sodium from 'libsodium-wrappers-sumo'` — route any `sodium.*` calls through `@memry/crypto`; replace `import type { DrizzleDb } from './item-handlers'` with the seam type. `auth-retry.ts`: change `import { SyncServerError } from './http-client'` → `'./http-client.ts'` (no other change; it is already seam-free). `vault-adoption.ts`: replace `import type { DataDb } from '../database/types'` → seam `DrizzleDb`, `import { VAULT_KEY_VERIFIER_SETTING } from '../crypto/vault-key-state'` → `@memry/crypto`, `import { createLogger } from '../lib/logger'` → `'./seams.ts'`. Append `export * from './device-keys.ts'`, `export * from './auth-retry.ts'`, `export * from './vault-adoption.ts'` to the barrel.

- [ ] **Step 4: Stubs + run.** Stub the three desktop paths → `export * from '@memry/sync-core'`. Run the moved suite → PASS; `pnpm --filter @memry/desktop test:main` → PASS; `pnpm typecheck` → PASS.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "refactor(sync-core): move device-keys, auth-retry, vault-adoption"`

---

## Task 15: Move the `engine/` coordinators

**Files:**

- Move: `engine/sync-context.ts`, `engine/sync-state-manager.ts`, `engine/quarantine-manager.ts`, `engine/crdt-sync-coordinator.ts`, `engine/push-coordinator.ts`, `engine/pull-coordinator.ts`, `engine/corrupt-item-tracker.ts`, `engine/error-recovery-handler.ts`, `engine/full-sync-runner.ts`, `engine/index.ts` → `packages/sync-core/src/engine/`
- Move (tests): `engine/corrupt-item-tracker.test.ts`, `engine/crdt-sync-coordinator.test.ts`, `engine/error-recovery-handler.test.ts`, `engine/quarantine-manager.test.ts`, `engine/sync-state-manager.test.ts`, `engine/pull-apply-order.test.ts` → `packages/sync-core/src/engine/`
- Create (stub): `apps/desktop/src/main/sync/engine/index.ts`

**Interfaces:**

- Consumes: all seams; `SyncQueueManager`, `NetworkMonitor`, `WebSocketManager`, `ItemApplier`, `SyncErrorInfo` (all now intra-package `./..`).
- Produces (`engine/index.ts` barrel, unchanged export list): `SyncStateManager`, `QuarantineManager`, `CrdtSyncCoordinator`, `PushCoordinator`, `PullCoordinator`, `CorruptItemTracker`, `ErrorRecoveryHandler`, `FullSyncRunner`, `SyncContext`, `SyncEngineDeps`, `SyncEngineOptions`, `QuarantineEntry`, `SYNC_STATE_KEYS` and all numeric constants.

**Steps:**

- [ ] **Step 1: Move `sync-context.ts` first + retype deps.** `git mv apps/desktop/src/main/sync/engine/sync-context.ts packages/sync-core/src/engine/sync-context.ts`. Replace the desktop-typed imports at the top:

```ts
import type { SyncQueueManager } from '../queue.ts'
import type { NetworkMonitor } from '../network.ts'
import type { WebSocketManager } from '../websocket.ts'
import type { ItemApplier } from '../apply-item.ts'
import type { SyncErrorInfo } from '../sync-errors.ts'
import type { SyncAdapterRegistry } from '../registry.ts'
import type { SyncStatusValue } from '@memry/contracts/ipc-sync-ops'
import type { DrizzleDb, EmitEvents, CrdtProvider, WorkerBridge } from '../seams.ts'
```

Replace the `SyncEngineDeps` field types: `db: DrizzleDb`, `emitToRenderer: EmitEvents`, `adapters?: SyncAdapterRegistry<DrizzleDb, EmitEvents>`, `crdtProvider?: CrdtProvider`, `workerBridge?: WorkerBridge`, and add `handlerRegistry: HandlerRegistry` (import from `../seams.ts`) so `engine.ts` can build the `ItemApplier`. Keep every constant (`PUSH_BATCH_SIZE`, `PULL_PAGE_LIMIT`, `SYNC_STATE_KEYS`, `yieldToEventLoop`, etc.) byte-identical.

- [ ] **Step 2: Move the 8 coordinators + barrel; run, expect FAIL first.** `git mv` the eight coordinator impls and `engine/index.ts` and the six engine test files into `packages/sync-core/src/engine/`. Before fixing imports, run `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project sync-core engine/` → FAIL (unresolved `../lib/logger`, `../crypto`, `../telemetry/track`, `../item-handlers`). In each coordinator rewrite the ambient imports: `../lib/logger` → `./` neighbors are wrong; use `../seams.ts` (`createLogger`); `../telemetry/track` `trackMainEvent` → `../seams.ts`; `../crypto*` → `@memry/crypto`; any `../queue`/`../apply-item`/`../sync-errors`/`../http-client` → append `.ts`. `pull-coordinator.ts` (largest, 23K — `PULL_APPLY_ORDER`, deferred-FK retries, crypto circuit-breaker) and `crdt-sync-coordinator.ts` keep their logic verbatim; only import paths change. If a coordinator test mocks `'../../lib/logger'`, delete the mock (default no-op) or re-point to `../seams.ts`.

- [ ] **Step 3: Fix `engine/index.ts` intra imports.** The barrel's relative imports (`./sync-context`, `./sync-state-manager`, ...) gain `.ts` extensions. No export names change.

- [ ] **Step 4: Stub + run.** Stub `apps/desktop/src/main/sync/engine/index.ts`:

```ts
export * from '@memry/sync-core/engine'
```

Run `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project sync-core engine/` → PASS (6 suites). `pnpm --filter @memry/desktop test:main` → PASS (desktop `engine.ts`, still in desktop this task, imports coordinators via the stub barrel). `pnpm typecheck` → PASS.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "refactor(sync-core): move engine coordinators behind seam-typed SyncEngineDeps"`

---

## Task 16: Move `engine.ts`, add `./engine` export, rewire `runtime.ts`, full verification

**Files:**

- Move: `engine.ts` → `packages/sync-core/src/engine/engine.ts`; move tests `engine.test.ts`, `engine-pull.test.ts`, `engine-push.test.ts`, `engine-crdt.test.ts`, `engine-retries.test.ts`, `sign-verify-roundtrip.test.ts`, `corrupt-recovery.test.ts` → `packages/sync-core/src/`
- Modify: `packages/sync-core/src/engine/index.ts` (add `SyncEngine`), `apps/desktop/src/main/sync/engine.ts` (stub), `apps/desktop/src/main/sync/runtime.ts` (composition root), `apps/desktop/config/vitest.config.ts` (already done)
- Verify: architecture/contract boundary checks + full suites.

**Interfaces:**

- Consumes: all seams + coordinators.
- Produces: `class SyncEngine` (constructor `SyncEngineDeps`), re-export `SyncEngineDeps`, `SyncEngineOptions`.

**Steps:**

- [ ] **Step 1: Move engine tests.** `git mv` the seven engine-level test files into `packages/sync-core/src/`. Re-point their `'../lib/logger'` / `'../crypto'` / `'../telemetry/track'` mocks to `@memry/crypto` / delete (default no-op) / `configureSyncCore` spies. Where a test builds `SyncEngineDeps`, add `handlerRegistry` (a stub `{ getHandler, getRemoteSyncAdapter, getAllRemoteSyncAdapters }`).

- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project sync-core engine` → FAIL: `engine/engine.ts` not present / unresolved ambient imports.

- [ ] **Step 3: Move + rewrite `engine.ts`.** `git mv apps/desktop/src/main/sync/engine.ts packages/sync-core/src/engine/engine.ts`. Rewrite the header imports:

```ts
import { EventEmitter } from 'events'
import { createSyncAdapterRegistry } from '../registry.ts'
import { createLogger, trackMainEvent, secureCleanupSafe } from '../seams.ts'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
// ...contracts types unchanged...
import { secureCleanup } from '@memry/crypto'
import { getFromServer } from '../http-client.ts'
import { classifyError } from '../sync-errors.ts'
import { ItemApplier } from '../apply-item.ts'
import { FullSyncRunner } from './full-sync-runner.ts'
import type { SyncContext, SyncEngineDeps, SyncEngineOptions } from './sync-context.ts'
import {
  PUSH_BATCH_SIZE,
  PULL_PAGE_LIMIT,
  STALE_CURSOR_THRESHOLD_MS,
  SYNC_STATE_KEYS
} from './sync-context.ts'
import { SyncStateManager } from './sync-state-manager.ts'
import { QuarantineManager } from './quarantine-manager.ts'
import { CrdtSyncCoordinator } from './crdt-sync-coordinator.ts'
import { PushCoordinator } from './push-coordinator.ts'
// ...pull-coordinator, corrupt-item-tracker, error-recovery-handler as ./*.ts...
```

(Drop the `secureCleanupSafe` line if not real — this is illustrative; the true edit is `../crypto/index` → `@memry/crypto` and `../telemetry/track` → `../seams.ts`, `../lib/logger` → `../seams.ts`.) Where `engine.ts` constructs `new ItemApplier(deps.db, deps.emitToRenderer, deps.adapters)`, change to `new ItemApplier(deps.db, deps.emitToRenderer, deps.handlerRegistry, deps.adapters)`. Add `SyncEngine` to `packages/sync-core/src/engine/index.ts`:

```ts
export { SyncEngine } from './engine.ts'
export type { SyncEngineDeps, SyncEngineOptions } from './sync-context.ts'
```

The `package.json` `./engine` subpath export (added in Task 1) now resolves `@memry/sync-core/engine`.

- [ ] **Step 4: Stub `engine.ts` + rewire `runtime.ts`.** Stub `apps/desktop/src/main/sync/engine.ts`:

```ts
export * from '@memry/sync-core/engine'
```

so `runtime.ts`'s `import { SyncEngine, type SyncEngineDeps } from './engine'` keeps resolving. In `runtime.ts`, add one `configureSyncCore({...})` call at startup (before any engine construction) wiring the concrete seam impls:

```ts
import { configureSyncCore } from '@memry/sync-core'
import { net } from 'electron'
import log from 'electron-log'
import { BrowserWindow } from 'electron'
import { trackMainEvent } from '../telemetry/track'
import { getDatabase } from '../database'
import { getOrCreateVaultUuid } from '../agent/storage/vault-id'
import { getHandler, getRemoteSyncAdapter, getAllRemoteSyncAdapters } from './item-handlers'
import { createElectronNetworkDeps } from './network-electron-deps'
import { createPinnedWebSocketFactory } from './certificate-pinning' // returns a WebSocketFactory using ws + pinned agent

configureSyncCore({
  logger: (scope) => log.scope(scope),
  http: (url, init) => net.fetch(url, init),
  telemetry: (surface, props) => trackMainEvent(surface as never, props as never),
  emit: (channel, data) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, data)
  },
  vaultHeaders: async () => {
    const vaultId = getOrCreateVaultUuid(getDatabase())
    return vaultId ? { 'X-Memry-Vault-Id': vaultId } : {}
  }
})
```

Wire the remaining injected deps into the `new SyncEngine({...})` call: `handlerRegistry: { getHandler, getRemoteSyncAdapter, getAllRemoteSyncAdapters }`, `ws: new WebSocketManager({ ...existing, wsFactory: createPinnedWebSocketFactory() })`, and `network: new NetworkMonitor(undefined, createElectronNetworkDeps())`. Create `createPinnedWebSocketFactory` in `certificate-pinning.ts` (desktop) returning `{ create(url, { headers }) { return new WebSocket(url, { headers, agent: createPinnedAgent() }) } }` wrapped to the `WebSocketLike` shape (the class stays desktop; only the factory is new). Confirm `initial-seed`'s seed entry (Task 10) is called with the registry.

- [ ] **Step 5: Full verification + document deferrals + commit.** Run in order:
  - `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project sync-core` → PASS (all moved sync suites).
  - `pnpm --filter @memry/desktop test:main` → PASS (desktop composition green through stubs; if `better-sqlite3` `ERR_DLOPEN_FAILED`, `pnpm --filter @memry/desktop rebuild:node` then re-run).
  - `pnpm typecheck` → PASS.
  - `pnpm ipc:check` → PASS (no contract drift; if handler shapes changed, `pnpm ipc:generate` first).
  - `pnpm check:architecture` and `pnpm check:contracts` → PASS.
  - Add a CI guard: extend `scripts/check-architecture-boundaries.js` to assert `packages/sync-core/src/**` contains no `from 'electron'`, `from 'ws'`, `from 'keytar'`, `from 'worker_threads'`, `require('electron')`, or `from 'node:*'` import (grep-based; the moved files must stay platform-free). Run it → PASS.
  - `git diff --check` → clean.
  - Confirm the four deferred files (`local-mutations.ts`, `device-registration.ts`, `linking-service.ts`, `vault-provisioning.ts`) still live at their desktop paths and still pass their desktop tests under `test:main`.
  - Commit: `git add -A && git commit -m "refactor(sync-core): move SyncEngine, add ./engine export, wire desktop composition root"`

---

## Verification summary (run before declaring the workstream done)

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project sync-core  # moved suites
pnpm --filter @memry/desktop test:main    # desktop stays green through re-export stubs
pnpm typecheck                            # all packages incl. grown sync-core
pnpm ipc:check                            # contract boundary intact
pnpm check:architecture                   # + new no-electron/ws/keytar/worker_threads/node guard on packages/sync-core
pnpm check:contracts
git diff --check
```

Desktop must be green at every task boundary. `@memry/sync-core` must import zero `electron`/`ws`/`keytar`/`worker_threads`/`node:*` modules at import time — that guard is the mobile-readiness gate. The 15 item-handlers, `runtime.ts`, `certificate-pinning.ts`, and the four deferred composition files remain in desktop by design.

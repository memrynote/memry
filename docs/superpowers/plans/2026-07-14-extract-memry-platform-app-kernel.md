# Extract @memry/platform + @memry/app-kernel Implementation Plan

> Agentic workers: use the **superpowers:subagent-driven-development** sub-skill to execute this plan. Every step below uses `- [ ]` checkbox syntax; check a box only when its exact verification evidence is green. Do not batch steps; one action per step, strict TDD ordering for new code, extraction-move ordering for moved code.

**Goal:** Formalize the three host-platform seams (`FileStore`, `KeyValueStore`, `SecretStore`) as a Hermes-safe `@memry/platform` package, and split the DB-only service factories out of `@memry/app-core` into a portable `@memry/app-kernel` whose `createKernelServices` takes already-opened Drizzle DBs instead of opening `better-sqlite3` itself — with desktop consuming both first and the existing `app-core` integration suite as the green gate.

**Architecture:** `@memry/platform` contains interfaces only at its root barrel plus a pure-Node `fs-file-store` under `./node`; desktop supplies the `KeyValueStore`/`SecretStore` adapters (they need `electron`/`keytar`, so they live in `apps/desktop`, never in the package). `@memry/app-kernel` holds the pure-DB service factories (tasks, settings, tags, reminders, bookmarks, saved-filters, calendar, agent, graph, search-tools, ids) typed against a widened `DataDb = BaseSQLiteDatabase<'sync', unknown, typeof dataSchema>`; `@memry/app-core`'s `createMemryApp` stays the Node/desktop host (it still opens the DBs via `openDatabases` and builds the fs-bound services) and now delegates the DB-only services to `createKernelServices`. `createMemryApp`'s public signature stays `({ vaultPath })` so `apps/cli` is untouched.

**Tech Stack:** TypeScript (ESM, `.ts` extension imports), `drizzle-orm` `^0.45.2` (`drizzle-orm/sqlite-core` `BaseSQLiteDatabase`), `better-sqlite3` `^12.5.0` (stays in the Node host only), `nanoid` `^5.1.6`, `node:fs/promises`/`node:path` for the reference `FileStore`, `keytar` + `libsodium-wrappers-sumo` (desktop `SecretStore`, owned by the `@memry/crypto` workstream), Vitest (desktop adapter tests via `test:main`), `node --test` (package tests, mirroring `@memry/app-core`).

---

## Global Constraints

Copied verbatim from the shared mobile-port spine. These bind every task below.

- Backward compatibility is MANDATORY for production installs: every change must work for existing installs, no DB resets, sync protocol / IPC contracts / vault file formats / settings shapes must tolerate data written by older app versions.
- DB schema changes go through additive, hand-written D1/data-DB migrations that preserve existing rows (Drizzle snapshots broken past 0021; data-DB migrations are hand-written).
- Sync-server deploys BEFORE desktop/mobile clients for every additive change (D6 sync item types, D8 settings-push, entitlement_grants).
- Crypto parameters are IMMUTABLE and byte-identical across clients: Argon2id v1.3 ops=3, mem=64 MiB, parallelism=1; BLAKE2b crypto_kdf_derive_from_key with exact 8-char contexts (memryvlt/memrysgn/memryvrf/memrykve/memrylnk/memrymac/memrysas); base64 = sodium.base64_variants.ORIGINAL (standard alphabet, padded); cryptoVersion=1; canonical CBOR in CBOR_FIELD_ORDER.
- E2E-encrypted: server never sees plaintext; it verifies Ed25519 via WebCrypto and validates envelope lengths only.
- Offline-first: SQLite local storage is canonical on mobile; CRDT (Yjs) for note/journal bodies, field-level vector clocks for tasks/projects/calendar; correctness never depends on background execution.
- `@blocknote/*`, `yjs`, and `zod` pinned IDENTICALLY to desktop across clients; a CI check fails the mobile build on drift; BlockNote bumps gated on the markdown round-trip / byte-preservation golden suite.
- `@memry/contracts` is the single wire-format source of truth; mobile MUST import, never copy (copying breaks cross-device crypto/signature interop).
- No Co-Authored-By trailer on commit messages.
- Prettier: single quotes, no semicolons, 100-char width, no trailing commas.
- RTL safety: new code uses logical Tailwind/RN props (ms-/me-, ps-/pe-, start-/end-) that flip automatically in RTL; RN uses I18nManager.forceRTL instead of document.dir.
- Extraction principle: move files, re-export from old paths, tests move with the code, desktop consumes the new package first — each extraction keeps desktop green, verified by the existing suite before mobile exists.
- Logging via `createLogger('Scope')` seam (never raw `console.*`); user-facing errors via `extractErrorMessage(err, fallback)`.
- WCAG AA + reduced-motion + RTL accessibility per PRODUCT.md; personality calm, private, crafted.

**Relevant version pins:** `drizzle-orm = ^0.45.2` (+ drizzle-kit, babel-plugin-inline-import); desktop opener stays `better-sqlite3 (drizzle-orm/better-sqlite3)`, mobile later swaps to `op-sqlite (drizzle-orm/op-sqlite)`; `zod = ^4.3.4` (must match `packages/contracts`).

**Seam interfaces produced by this workstream (exact spine signatures):**

- `SecretStore` — `storeKey(entry: KeychainEntry, key: Uint8Array): Promise<void>; retrieveKey(entry: KeychainEntry): Promise<Uint8Array | null>; deleteKey(entry: KeychainEntry): Promise<void>`. Interface in `@memry/platform`; desktop impl = keytar (`keychain.ts`, owned by `@memry/crypto`), mobile = expo-secure-store. `KEYCHAIN_ENTRIES`: master-key/device-signing-key/access-token/refresh-token/setup-token.
- `KeyValueStore` — `get<T>(key: string): T | undefined; set(key: string, value: unknown): void; delete(key: string): void`. Interface in `@memry/platform`; desktop impl wraps `store.ts` userData JSON, mobile = react-native-mmkv.
- `FileStore` — `readFile(path: string): Promise<Uint8Array>; writeFile(path: string, data: Uint8Array): Promise<void>; exists(path: string): Promise<boolean>; delete(path: string): Promise<void>`. Interface + pure-Node impl in `@memry/platform`; desktop = node fs, mobile = expo-file-system (attachments only, no note-file vault).
- `DrizzleDb` — kernel accepts `BaseSQLiteDatabase<'sync', unknown, typeof dataSchema>` (generalized from `BetterSQLite3Database`) instead of opening `better-sqlite3`; desktop passes `better-sqlite3`, mobile later passes `op-sqlite`.

---

## File Structure

### Created

| Path                                                     | Responsibility                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/platform/package.json`                         | `@memry/platform` manifest. `type: module`, private, AGPL. Exports `.` (interfaces) + `./node` (pure fs impl). Dep on `@memry/contracts` only — NO electron/keytar/better-sqlite3, so the package is Hermes-safe. Scripts mirror `@memry/app-core` (`node --test`, `tsc`).                        |
| `packages/platform/tsconfig.json`                        | Extends `@memry/typescript-config/node.json`; typecheck-only, excludes `*.test.ts`.                                                                                                                                                                                                               |
| `packages/platform/src/index.ts`                         | Root barrel: re-exports the three interfaces + `KeychainEntry`. Interfaces only (no impls) so mobile imports types without pulling Node code.                                                                                                                                                     |
| `packages/platform/src/file-store.ts`                    | `FileStore` interface (4 methods per spine).                                                                                                                                                                                                                                                      |
| `packages/platform/src/key-value-store.ts`               | `KeyValueStore` interface (get/set/delete per spine).                                                                                                                                                                                                                                             |
| `packages/platform/src/secret-store.ts`                  | `SecretStore` interface + re-export of `KeychainEntry` from `@memry/contracts/crypto`.                                                                                                                                                                                                            |
| `packages/platform/src/node/fs-file-store.ts`            | `createFsFileStore(baseDir): FileStore` over `node:fs/promises` + `node:path`. Reference impl, consumed by the desktop host; no electron.                                                                                                                                                         |
| `packages/platform/src/node/fs-file-store.test.ts`       | `node --test` round-trip test for `createFsFileStore`.                                                                                                                                                                                                                                            |
| `apps/desktop/src/main/platform/key-value-store.ts`      | `desktopKeyValueStore: KeyValueStore` delegating to `store.get`/`store.set` (`store.ts`).                                                                                                                                                                                                         |
| `apps/desktop/src/main/platform/key-value-store.test.ts` | Vitest test mocking `../store`, asserting delegation.                                                                                                                                                                                                                                             |
| `apps/desktop/src/main/platform/secret-store.ts`         | `desktopSecretStore: SecretStore` forwarding to `storeKey`/`retrieveKey`/`deleteKey` (`crypto/keychain.ts`).                                                                                                                                                                                      |
| `apps/desktop/src/main/platform/secret-store.test.ts`    | Vitest test mocking `../crypto/keychain`, asserting delegation.                                                                                                                                                                                                                                   |
| `packages/app-kernel/package.json`                       | `@memry/app-kernel` manifest. Deps: `@memry/contracts`, `@memry/db-schema`, `@memry/domain-notes`, `@memry/shared`, `@memry/storage-data`, `drizzle-orm`, `nanoid`. devDep `@memry/app-core` (type-only, for host-service types). NO `better-sqlite3`, NO `node:fs`. Exports `.` + `./reminders`. |
| `packages/app-kernel/tsconfig.json`                      | Extends `@memry/typescript-config/node.json`, mirrors app-core.                                                                                                                                                                                                                                   |
| `packages/app-kernel/src/db-types.ts`                    | `export type DataDb = BaseSQLiteDatabase<'sync', unknown, typeof dataSchema>` — driver-agnostic DB type; replaces the moved factories' `./database.ts` import.                                                                                                                                    |
| `packages/app-kernel/src/index.ts`                       | Kernel barrel: `export *` from every moved factory + `create-kernel`.                                                                                                                                                                                                                             |
| `packages/app-kernel/src/create-kernel.ts`               | `createKernelServices(deps: KernelDeps): KernelServices` — the "already-opened DB + injected host services" variant.                                                                                                                                                                              |
| `packages/app-kernel/src/create-kernel.test.ts`          | `node --test` unit test: construction returns all 11 DB-only services from injected deps.                                                                                                                                                                                                         |

### Moved (git mv `packages/app-core/src/<f>.ts` → `packages/app-kernel/src/<f>.ts`)

`tasks.ts`, `settings.ts`, `tags.ts`, `reminders.ts`, `bookmarks.ts`, `saved-filters.ts`, `calendar.ts`, `agent.ts`, `graph.ts`, `search-tools.ts`, `ids.ts` — internal imports repointed to `./db-types.ts` (DataDb) and to `@memry/app-core` (type-only host-service types).

### Modified

| Path                                 | Change                                                                                                                                                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/app-core/src/ids.ts`       | Replaced with shim: `export { createId } from '@memry/app-kernel'` (5 host files import `./ids.ts`).                                                                                                                                                  |
| `packages/app-core/src/reminders.ts` | Replaced with shim: `export * from '@memry/app-kernel/reminders'` (preserves `@memry/app-core/reminders` subpath export).                                                                                                                             |
| `packages/app-core/src/inbox.ts`     | `import type { TasksService } from './tasks.ts'` → `from '@memry/app-kernel'`.                                                                                                                                                                        |
| `packages/app-core/src/locale.ts`    | `import type { SettingsService } from './settings.ts'` → `from '@memry/app-kernel'`.                                                                                                                                                                  |
| `packages/app-core/src/memry-app.ts` | Import moved factories from `@memry/app-kernel`; collapse the inline DB-only-service block into a single `createKernelServices(...)` call; reorder so `locale` is built after kernel `settings`. Signature `createMemryApp({ vaultPath })` UNCHANGED. |
| `packages/app-core/src/index.ts`     | Add `export type { NotesService } from './notes.ts'`, `InboxService`, `TemplatesService` (kernel type-only imports need them) + `export * from '@memry/app-kernel'` (external consumers keep resolving moved types).                                  |
| `packages/app-core/package.json`     | Add dep `@memry/app-kernel: workspace:*`. `better-sqlite3` + `drizzle-orm` stay (host still opens DBs). `./reminders` + `./markdown` subpath exports unchanged.                                                                                       |
| `apps/desktop/package.json`          | Add dep `@memry/platform: workspace:*`.                                                                                                                                                                                                               |

### Explicitly NOT changed

- `packages/app-core/src/database.ts` (`openDatabases`, `BetterSQLite3Database`) — stays in the Node host; the driver opener is not portable.
- `packages/app-core/src/paths.ts` (`ensureVaultLayout`, direct `node:fs`) — stays in the host.
- `packages/app-core/src/markdown.ts` — NOT moved; app-core's `./markdown` export is unchanged (kernel does NOT re-export it).
- `apps/cli/src/run.ts` — no edit; only smoke-verified (signature preserved).
- `CreateMemryAppInput` gets NO speculative `platform` param (YAGNI: nothing in the kernel consumes `FileStore`/`KeyValueStore`/`SecretStore` yet; mobile's composition root wires adapters directly in later workstreams). Keeping `({ vaultPath })` also satisfies the cli-compat constraint.

---

### Task 1: `@memry/platform` package — seam interfaces + pure-Node FileStore

**Files:**

- Create: `packages/platform/package.json`, `packages/platform/tsconfig.json`, `packages/platform/src/index.ts`, `packages/platform/src/file-store.ts`, `packages/platform/src/key-value-store.ts`, `packages/platform/src/secret-store.ts`, `packages/platform/src/node/fs-file-store.ts`
- Test: `packages/platform/src/node/fs-file-store.test.ts`

**Interfaces:**

- Consumes: `KeychainEntry` from `@memry/contracts/crypto` (`{ service: string; account: string }`, confirmed at `packages/contracts/src/crypto.ts:65`).
- Produces: `interface FileStore`, `interface KeyValueStore`, `interface SecretStore`, `createFsFileStore(baseDir: string): FileStore`, re-export `type KeychainEntry`.

- [ ] **Step 1: Write the failing test.** Create `packages/platform/src/node/fs-file-store.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFsFileStore } from './fs-file-store.ts'

test('createFsFileStore round-trips bytes, mkdirs parents, reports and clears existence', async () => {
  const base = mkdtempSync(join(tmpdir(), 'memry-fs-'))
  const store = createFsFileStore(base)
  const bytes = new Uint8Array([1, 2, 3, 4])

  assert.equal(await store.exists('a/b.bin'), false)
  await store.writeFile('a/b.bin', bytes)
  assert.equal(await store.exists('a/b.bin'), true)

  const read = await store.readFile('a/b.bin')
  assert.deepEqual([...read], [1, 2, 3, 4])

  await store.delete('a/b.bin')
  assert.equal(await store.exists('a/b.bin'), false)
})

test('createFsFileStore delete is idempotent on a missing path', async () => {
  const base = mkdtempSync(join(tmpdir(), 'memry-fs-'))
  const store = createFsFileStore(base)
  await store.delete('missing.bin')
  assert.equal(await store.exists('missing.bin'), false)
})
```

- [ ] **Step 2: Create the package skeleton so the test can resolve.** Create `packages/platform/package.json`:

```json
{
  "name": "@memry/platform",
  "version": "0.1.0",
  "private": true,
  "license": "AGPL-3.0-only",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./node": "./src/node/fs-file-store.ts"
  },
  "types": "./src/index.ts",
  "scripts": {
    "test": "node --no-warnings --experimental-strip-types --experimental-transform-types --test src/node/*.test.ts",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@memry/contracts": "workspace:*"
  },
  "devDependencies": {
    "@memry/typescript-config": "workspace:*",
    "@types/node": "^25.0.3"
  }
}
```

Create `packages/platform/tsconfig.json`:

```json
{
  "extends": "@memry/typescript-config/node.json",
  "compilerOptions": {
    "allowImportingTsExtensions": true
  },
  "include": ["src/**/*"],
  "exclude": ["**/*.test.ts"]
}
```

Then run `pnpm install` from the repo root to link the new workspace package.

- [ ] **Step 3: Run it, expect FAIL.** `pnpm --filter @memry/platform test` — fails because `./fs-file-store.ts` does not exist yet:

```
Error: Cannot find module '.../packages/platform/src/node/fs-file-store.ts'
```

- [ ] **Step 4: Write the interfaces.** Create `packages/platform/src/file-store.ts`:

```ts
export interface FileStore {
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array): Promise<void>
  exists(path: string): Promise<boolean>
  delete(path: string): Promise<void>
}
```

Create `packages/platform/src/key-value-store.ts`:

```ts
export interface KeyValueStore {
  get<T>(key: string): T | undefined
  set(key: string, value: unknown): void
  delete(key: string): void
}
```

Create `packages/platform/src/secret-store.ts`:

```ts
import type { KeychainEntry } from '@memry/contracts/crypto'

export type { KeychainEntry }

export interface SecretStore {
  storeKey(entry: KeychainEntry, key: Uint8Array): Promise<void>
  retrieveKey(entry: KeychainEntry): Promise<Uint8Array | null>
  deleteKey(entry: KeychainEntry): Promise<void>
}
```

Create `packages/platform/src/index.ts`:

```ts
export type { FileStore } from './file-store.ts'
export type { KeyValueStore } from './key-value-store.ts'
export type { SecretStore, KeychainEntry } from './secret-store.ts'
```

- [ ] **Step 5: Minimal implementation of the fs impl.** Create `packages/platform/src/node/fs-file-store.ts`:

```ts
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { FileStore } from '../file-store.ts'

export function createFsFileStore(baseDir: string): FileStore {
  const full = (path: string): string => resolve(baseDir, path)

  return {
    async readFile(path) {
      return new Uint8Array(await readFile(full(path)))
    },
    async writeFile(path, data) {
      const target = full(path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, data)
    },
    async exists(path) {
      try {
        await access(full(path))
        return true
      } catch {
        return false
      }
    },
    async delete(path) {
      await rm(full(path), { force: true })
    }
  }
}
```

- [ ] **Step 6: Run tests, expect PASS.** `pnpm --filter @memry/platform test`:

```
# tests 2
# pass 2
# fail 0
```

Then `pnpm --filter @memry/platform typecheck` — no output (exit 0).

- [ ] **Step 7: Commit.**

```
git add packages/platform pnpm-lock.yaml
git commit -m "feat(platform): add @memry/platform with FileStore/KeyValueStore/SecretStore seams + node fs impl"
```

---

### Task 2: Desktop platform adapters (KeyValueStore over store.ts, SecretStore over keychain.ts)

**Files:**

- Create: `apps/desktop/src/main/platform/key-value-store.ts`, `apps/desktop/src/main/platform/secret-store.ts`
- Test: `apps/desktop/src/main/platform/key-value-store.test.ts`, `apps/desktop/src/main/platform/secret-store.test.ts`
- Modify: `apps/desktop/package.json` (add `@memry/platform` dep)

**Interfaces:**

- Consumes: `KeyValueStore`, `SecretStore` from `@memry/platform`; `store` (`{ get, set }`) from `apps/desktop/src/main/store.ts` (confirmed `store.get`/`store.set` at `store.ts:176-185`, no `delete`); `storeKey`/`retrieveKey`/`deleteKey` from `apps/desktop/src/main/crypto/keychain.ts` (owned by `@memry/crypto` workstream — coordinate; interface lands here first). `KEYCHAIN_ENTRIES` from `@memry/contracts/crypto`.
- Produces: `desktopKeyValueStore: KeyValueStore`, `desktopSecretStore: SecretStore`.

- [ ] **Step 1: Add the package dep.** Edit `apps/desktop/package.json` dependencies, add `"@memry/platform": "workspace:*"`, then run `pnpm install` from the repo root.

- [ ] **Step 2: Write the failing KeyValueStore test.** Create `apps/desktop/src/main/platform/key-value-store.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const get = vi.fn()
const set = vi.fn()
vi.mock('../store', () => ({ store: { get, set } }))

import { desktopKeyValueStore } from './key-value-store'

describe('desktopKeyValueStore', () => {
  beforeEach(() => {
    get.mockReset()
    set.mockReset()
  })

  it('delegates get to store.get', () => {
    get.mockReturnValue('/vault')
    expect(desktopKeyValueStore.get<string>('currentVault')).toBe('/vault')
    expect(get).toHaveBeenCalledWith('currentVault')
  })

  it('delegates set to store.set', () => {
    desktopKeyValueStore.set('currentVault', '/vault')
    expect(set).toHaveBeenCalledWith('currentVault', '/vault')
  })

  it('delete writes undefined through store.set', () => {
    desktopKeyValueStore.delete('currentVault')
    expect(set).toHaveBeenCalledWith('currentVault', undefined)
  })
})
```

- [ ] **Step 3: Write the failing SecretStore test.** Create `apps/desktop/src/main/platform/secret-store.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'

const storeKey = vi.fn().mockResolvedValue(undefined)
const retrieveKey = vi.fn().mockResolvedValue(null)
const deleteKey = vi.fn().mockResolvedValue(undefined)
vi.mock('../crypto/keychain', () => ({ storeKey, retrieveKey, deleteKey }))

import { desktopSecretStore } from './secret-store'

describe('desktopSecretStore', () => {
  it('forwards storeKey/retrieveKey/deleteKey to the keychain', async () => {
    const key = new Uint8Array([9])
    await desktopSecretStore.storeKey(KEYCHAIN_ENTRIES.MASTER_KEY, key)
    expect(storeKey).toHaveBeenCalledWith(KEYCHAIN_ENTRIES.MASTER_KEY, key)

    await desktopSecretStore.retrieveKey(KEYCHAIN_ENTRIES.MASTER_KEY)
    expect(retrieveKey).toHaveBeenCalledWith(KEYCHAIN_ENTRIES.MASTER_KEY)

    await desktopSecretStore.deleteKey(KEYCHAIN_ENTRIES.MASTER_KEY)
    expect(deleteKey).toHaveBeenCalledWith(KEYCHAIN_ENTRIES.MASTER_KEY)
  })
})
```

- [ ] **Step 4: Run them, expect FAIL.** `pnpm --filter @memry/desktop test:main` — both new files fail to resolve their impl module:

```
Error: Failed to resolve import "./key-value-store" ...
Error: Failed to resolve import "./secret-store" ...
```

(If instead you see `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` from `better-sqlite3`, run `pnpm --filter @memry/desktop rebuild:node` and re-run.)

- [ ] **Step 5: Minimal KeyValueStore impl.** Create `apps/desktop/src/main/platform/key-value-store.ts`:

```ts
import type { KeyValueStore } from '@memry/platform'
import { store } from '../store'

type StoreKey = Parameters<typeof store.get>[0]

// store.ts is a schema-typed userData JSON cache with no `delete`; the KeyValueStore
// seam is generic-string-keyed (mobile MMKV). We cast the key to the schema key type
// and model `delete` as writing undefined (JSON.stringify drops it, so the next read
// falls back to the schema default).
export const desktopKeyValueStore: KeyValueStore = {
  get<T>(key: string): T | undefined {
    return store.get(key as StoreKey) as T | undefined
  },
  set(key: string, value: unknown): void {
    store.set(key as StoreKey, value as never)
  },
  delete(key: string): void {
    store.set(key as StoreKey, undefined as never)
  }
}
```

- [ ] **Step 6: Minimal SecretStore impl.** Create `apps/desktop/src/main/platform/secret-store.ts`:

```ts
import type { SecretStore } from '@memry/platform'
import { deleteKey, retrieveKey, storeKey } from '../crypto/keychain'

// Thin adapter so main-process consumers get the SecretStore seam. keytar stays in
// keychain.ts (owned by the @memry/crypto workstream); this file only re-shapes it.
export const desktopSecretStore: SecretStore = {
  storeKey,
  retrieveKey,
  deleteKey
}
```

- [ ] **Step 7: Run tests, expect PASS.** `pnpm --filter @memry/desktop test:main`:

```
✓ src/main/platform/key-value-store.test.ts (3)
✓ src/main/platform/secret-store.test.ts (1)
```

(other main tests unchanged / still green).

- [ ] **Step 8: Commit.**

```
git add apps/desktop/src/main/platform apps/desktop/package.json pnpm-lock.yaml
git commit -m "feat(desktop): add KeyValueStore/SecretStore platform adapters over store.ts + keychain.ts"
```

---

### Task 3: Scaffold `@memry/app-kernel` + move the DB-only factories (extraction, existing suite = green gate)

This is an **extraction** task: move files, repoint imports, leave re-export shims at the old paths for host importers, then run the existing `@memry/app-core` integration suite (`memry-app.test.ts`, 33 KB — the only automated guard) as the red→green. `createKernelServices` is NOT introduced yet (Task 4); `memry-app.ts` keeps building the DB-only services inline but imports the factories from `@memry/app-kernel`.

**Files:**

- Create: `packages/app-kernel/package.json`, `packages/app-kernel/tsconfig.json`, `packages/app-kernel/src/db-types.ts`, `packages/app-kernel/src/index.ts`
- Move: `tasks.ts`, `settings.ts`, `tags.ts`, `reminders.ts`, `bookmarks.ts`, `saved-filters.ts`, `calendar.ts`, `agent.ts`, `graph.ts`, `search-tools.ts`, `ids.ts` (`packages/app-core/src/*` → `packages/app-kernel/src/*`)
- Modify: `packages/app-core/src/ids.ts` (shim), `packages/app-core/src/reminders.ts` (shim), `packages/app-core/src/inbox.ts`, `packages/app-core/src/locale.ts`, `packages/app-core/src/memry-app.ts`, `packages/app-core/src/index.ts`, `packages/app-core/package.json`
- Test (gate, not moved): `packages/app-core/src/memry-app.test.ts` stays; it is the red→green.

**Interfaces:**

- Consumes: `BaseSQLiteDatabase` from `drizzle-orm/sqlite-core`; `dataSchema` from `@memry/db-schema/data-schema`; host-service types `NotesService`/`InboxService`/`TemplatesService` from `@memry/app-core` (type-only).
- Produces: `type DataDb = BaseSQLiteDatabase<'sync', unknown, typeof dataSchema>`; kernel barrel re-exporting `createTasksService`/`TasksService`/`TaskRecord`/`ProjectRecord`, `createSettingsService`/`SettingsService`, `createTagsService`/`TagsService`, `createRemindersService`/`RemindersService`, `createBookmarksService`/`BookmarksService`, `createSavedFiltersService`/`SavedFiltersService`, `createCalendarService`/`CalendarService`, `createAgentService`/`AgentService`, `createGraphService`/`GraphService`, `createSearchReasonsService`/`createSearchStatsService`/`createSearchTagsService`/`SearchStats`/`SearchReasonsService`, `createId`.

- [ ] **Step 1: Establish the green baseline.** Run `pnpm --filter @memry/app-core test` and confirm the existing suite passes BEFORE any move (record the pass count; it must be identical after the move):

```
# pass N   # fail 0
```

- [ ] **Step 2: Create the kernel package skeleton.** Create `packages/app-kernel/package.json`:

```json
{
  "name": "@memry/app-kernel",
  "version": "0.1.0",
  "private": true,
  "license": "AGPL-3.0-only",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./reminders": "./src/reminders.ts"
  },
  "types": "./src/index.ts",
  "scripts": {
    "test": "node --no-warnings --experimental-strip-types --experimental-transform-types --test src/*.test.ts",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@memry/contracts": "workspace:*",
    "@memry/db-schema": "workspace:*",
    "@memry/domain-notes": "workspace:*",
    "@memry/shared": "workspace:*",
    "@memry/storage-data": "workspace:*",
    "drizzle-orm": "^0.45.2",
    "nanoid": "^5.1.6"
  },
  "devDependencies": {
    "@memry/app-core": "workspace:*",
    "@memry/typescript-config": "workspace:*",
    "@types/node": "^25.0.3"
  }
}
```

Create `packages/app-kernel/tsconfig.json`:

```json
{
  "extends": "@memry/typescript-config/node.json",
  "compilerOptions": {
    "allowImportingTsExtensions": true
  },
  "include": ["src/**/*"],
  "exclude": ["**/*.test.ts"]
}
```

Create `packages/app-kernel/src/db-types.ts`:

```ts
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type * as dataSchema from '@memry/db-schema/data-schema'

// Driver-agnostic DB type. better-sqlite3's BetterSQLite3Database<S> is
// BaseSQLiteDatabase<'sync', RunResult, S>, so the desktop driver is assignable to
// this widened type unchanged; op-sqlite (async) reconciliation is a later mobile
// workstream. Keeping 'sync' preserves every synchronous .get()/.all()/.run() call
// in the moved factories, so desktop stays byte-for-byte green.
export type DataDb = BaseSQLiteDatabase<'sync', unknown, typeof dataSchema>
```

Then `pnpm install` from the repo root.

- [ ] **Step 3: Move the 11 factory files.** Run:

```
git mv packages/app-core/src/tasks.ts packages/app-kernel/src/tasks.ts
git mv packages/app-core/src/settings.ts packages/app-kernel/src/settings.ts
git mv packages/app-core/src/tags.ts packages/app-kernel/src/tags.ts
git mv packages/app-core/src/reminders.ts packages/app-kernel/src/reminders.ts
git mv packages/app-core/src/bookmarks.ts packages/app-kernel/src/bookmarks.ts
git mv packages/app-core/src/saved-filters.ts packages/app-kernel/src/saved-filters.ts
git mv packages/app-core/src/calendar.ts packages/app-kernel/src/calendar.ts
git mv packages/app-core/src/agent.ts packages/app-kernel/src/agent.ts
git mv packages/app-core/src/graph.ts packages/app-kernel/src/graph.ts
git mv packages/app-core/src/search-tools.ts packages/app-kernel/src/search-tools.ts
git mv packages/app-core/src/ids.ts packages/app-kernel/src/ids.ts
```

- [ ] **Step 4: Repoint the DB type import in the moved DB factories.** In each of `packages/app-kernel/src/{tasks,settings,tags,reminders,bookmarks,saved-filters,calendar,search-tools}.ts`, replace `import type { DataDb } from './database.ts'` with `import type { DataDb } from './db-types.ts'`. (These are the 8 files that imported `DataDb`; `agent.ts`, `graph.ts`, `ids.ts` do not.)

- [ ] **Step 5: Repoint host-service type imports to `@memry/app-core` (type-only).** Edit the moved files:
  - `packages/app-kernel/src/graph.ts`: `import type { NotesService } from './notes.ts'` → `import type { NotesService } from '@memry/app-core'`. (Its `import type { TasksService } from './tasks.ts'` stays intra-kernel.)
  - `packages/app-kernel/src/tags.ts`: `import type { NotesService } from './notes.ts'` → `import type { NotesService } from '@memry/app-core'`.
  - `packages/app-kernel/src/search-tools.ts`: change `import type { InboxService } from './inbox.ts'`, `import type { NotesService } from './notes.ts'`, `import type { TemplatesService } from './templates.ts'` all to `from '@memry/app-core'`. (Its `./tags.ts` and `./tasks.ts` type imports stay intra-kernel.)

  These are `import type` (erased at build), so no runtime/bundle cycle is created — only a type-only devDependency on `@memry/app-core`, which is exactly the resolution called out in the workstream risk notes.

- [ ] **Step 6: Write the kernel barrel.** Create `packages/app-kernel/src/index.ts`:

```ts
export * from './ids.ts'
export * from './tasks.ts'
export * from './settings.ts'
export * from './tags.ts'
export * from './reminders.ts'
export * from './bookmarks.ts'
export * from './saved-filters.ts'
export * from './calendar.ts'
export * from './agent.ts'
export * from './graph.ts'
export * from './search-tools.ts'
```

(If `tsc` later reports a duplicate-export collision between two of these modules, replace the offending `export *` line with an explicit `export { ... }` / `export type { ... }` for that module — do NOT drop symbols. `create-kernel.ts` is added to this barrel in Task 4.)

- [ ] **Step 7: Leave shims + repoint host importers in app-core.** Create `packages/app-core/src/ids.ts` (shim — 5 host files import `./ids.ts`):

```ts
export { createId } from '@memry/app-kernel'
```

Create `packages/app-core/src/reminders.ts` (shim — preserves the `@memry/app-core/reminders` subpath export):

```ts
export * from '@memry/app-kernel/reminders'
```

Edit `packages/app-core/src/inbox.ts`: `import type { TasksService } from './tasks.ts'` → `import type { TasksService } from '@memry/app-kernel'`.
Edit `packages/app-core/src/locale.ts`: `import type { SettingsService } from './settings.ts'` → `import type { SettingsService } from '@memry/app-kernel'`.

- [ ] **Step 8: Repoint `memry-app.ts` factory imports (no logic change yet).** In `packages/app-core/src/memry-app.ts`, replace the moved factories' relative imports with a single import from `@memry/app-kernel`. Remove these lines:

```ts
import type { AgentService } from './agent.ts'
import { createAgentService } from './agent.ts'
import type { BookmarksService } from './bookmarks.ts'
import { createBookmarksService } from './bookmarks.ts'
import type { CalendarService } from './calendar.ts'
import { createCalendarService } from './calendar.ts'
import type { GraphService } from './graph.ts'
import { createGraphService } from './graph.ts'
import type { RemindersService } from './reminders.ts'
import { createRemindersService } from './reminders.ts'
import type { SettingsService } from './settings.ts'
import { createSettingsService } from './settings.ts'
import type { SavedFiltersService } from './saved-filters.ts'
import { createSavedFiltersService } from './saved-filters.ts'
import type { SearchReasonsService, SearchStats } from './search-tools.ts'
import {
  createSearchReasonsService,
  createSearchStatsService,
  createSearchTagsService
} from './search-tools.ts'
import type { TagsService } from './tags.ts'
import { createTagsService } from './tags.ts'
import type { TaskRecord, TasksService } from './tasks.ts'
import { createTasksService } from './tasks.ts'
```

and replace them with:

```ts
import {
  createAgentService,
  createBookmarksService,
  createCalendarService,
  createGraphService,
  createRemindersService,
  createSavedFiltersService,
  createSearchReasonsService,
  createSearchStatsService,
  createSearchTagsService,
  createSettingsService,
  createTagsService,
  createTasksService
} from '@memry/app-kernel'
import type {
  AgentService,
  BookmarksService,
  CalendarService,
  GraphService,
  RemindersService,
  SavedFiltersService,
  SearchReasonsService,
  SearchStats,
  SettingsService,
  TagsService,
  TaskRecord,
  TasksService
} from '@memry/app-kernel'
```

Leave the `createMemryApp` body's inline service construction unchanged in this task.

- [ ] **Step 9: Add the host-service type exports + kernel re-export to app-core barrel.** Edit `packages/app-core/src/index.ts` to:

```ts
export * from './memry-app.ts'
export * from '@memry/app-kernel'
export type { NotesService } from './notes.ts'
export type { InboxService } from './inbox.ts'
export type { TemplatesService } from './templates.ts'
```

(`export * from '@memry/app-kernel'` keeps external consumers of moved types resolving; the three `export type` lines satisfy the kernel's type-only `@memry/app-core` imports from Step 5.)

- [ ] **Step 10: Add the app-core → app-kernel dependency.** Edit `packages/app-core/package.json` dependencies, add `"@memry/app-kernel": "workspace:*"`. Leave `better-sqlite3`, `drizzle-orm`, and the `./reminders` + `./markdown` exports as-is. Run `pnpm install` from the repo root.

- [ ] **Step 11: Typecheck both packages.** Run `pnpm --filter @memry/app-kernel typecheck` then `pnpm --filter @memry/app-core typecheck` — both exit 0. (A duplicate-export error here means fix Step 6 per its note; a `DataDb` assignment error means the widened type in Step 2 is wrong.)

- [ ] **Step 12: Run the app-core integration suite, expect PASS (unchanged count).** `pnpm --filter @memry/app-core test`:

```
# pass N   # fail 0
```

`N` must equal the baseline from Step 1. (Native `ERR_DLOPEN_FAILED` → `pnpm --filter @memry/desktop rebuild:node`, then re-run.)

- [ ] **Step 13: Commit.**

```
git add packages/app-kernel packages/app-core pnpm-lock.yaml
git commit -m "refactor(app-kernel): extract DB-only service factories from app-core into @memry/app-kernel"
```

---

### Task 4: Introduce `createKernelServices` and consume it from `createMemryApp`

**Files:**

- Create: `packages/app-kernel/src/create-kernel.ts`
- Test: `packages/app-kernel/src/create-kernel.test.ts`
- Modify: `packages/app-kernel/src/index.ts` (export create-kernel), `packages/app-core/src/memry-app.ts` (collapse inline block into `createKernelServices`)

**Interfaces:**

- Consumes: `DataDb` from `./db-types.ts`; the 11 moved factories (intra-kernel); host-service types `NotesService`/`InboxService`/`TemplatesService` from `@memry/app-core` (type-only); `createTasksService` from `@memry/app-kernel` (host builds `tasks` before `inbox`, then injects it).
- Produces:
  - `interface KernelDeps { dataDb: DataDb; notes: NotesService; tasks: TasksService; inbox: InboxService; templates: TemplatesService }`
  - `interface KernelServices { settings: SettingsService; tags: TagsService; reminders: RemindersService; bookmarks: BookmarksService; savedFilters: SavedFiltersService; calendar: CalendarService; agent: AgentService; graph: GraphService; searchStats: () => Promise<SearchStats>; searchReasons: SearchReasonsService; searchTags: () => Promise<string[]> }`
  - `createKernelServices(deps: KernelDeps): KernelServices`

- [ ] **Step 1: Write the failing test.** Create `packages/app-kernel/src/create-kernel.test.ts` (factories close over their deps and do not query at construction, so structural stubs suffice for a construction-shape assertion):

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createKernelServices } from './create-kernel.ts'

test('createKernelServices returns all 11 DB-only services from injected deps', () => {
  const stub = {} as never
  const services = createKernelServices({
    dataDb: stub,
    notes: stub,
    tasks: stub,
    inbox: stub,
    templates: stub
  })

  assert.ok(services.settings)
  assert.ok(services.tags)
  assert.ok(services.reminders)
  assert.ok(services.bookmarks)
  assert.ok(services.savedFilters)
  assert.ok(services.calendar)
  assert.ok(services.agent)
  assert.ok(services.graph)
  assert.equal(typeof services.searchStats, 'function')
  assert.ok(services.searchReasons)
  assert.equal(typeof services.searchTags, 'function')
})
```

- [ ] **Step 2: Run it, expect FAIL.** `pnpm --filter @memry/app-kernel test`:

```
Error: Cannot find module '.../packages/app-kernel/src/create-kernel.ts'
```

- [ ] **Step 3: Minimal implementation.** Create `packages/app-kernel/src/create-kernel.ts`:

```ts
import type { InboxService, NotesService, TemplatesService } from '@memry/app-core'
import type { DataDb } from './db-types.ts'
import { createAgentService, type AgentService } from './agent.ts'
import { createBookmarksService, type BookmarksService } from './bookmarks.ts'
import { createCalendarService, type CalendarService } from './calendar.ts'
import { createGraphService, type GraphService } from './graph.ts'
import { createRemindersService, type RemindersService } from './reminders.ts'
import { createSavedFiltersService, type SavedFiltersService } from './saved-filters.ts'
import {
  createSearchReasonsService,
  createSearchStatsService,
  createSearchTagsService,
  type SearchReasonsService,
  type SearchStats
} from './search-tools.ts'
import { createSettingsService, type SettingsService } from './settings.ts'
import { createTagsService, type TagsService } from './tags.ts'
import type { TasksService } from './tasks.ts'

export interface KernelDeps {
  dataDb: DataDb
  notes: NotesService
  tasks: TasksService
  inbox: InboxService
  templates: TemplatesService
}

export interface KernelServices {
  settings: SettingsService
  tags: TagsService
  reminders: RemindersService
  bookmarks: BookmarksService
  savedFilters: SavedFiltersService
  calendar: CalendarService
  agent: AgentService
  graph: GraphService
  searchStats: () => Promise<SearchStats>
  searchReasons: SearchReasonsService
  searchTags: () => Promise<string[]>
}

// The already-opened-DB variant: the Node/desktop host (and later the mobile
// composition root) opens the DBs and builds the fs-bound services (notes, inbox,
// templates) + tasks, then hands them here. This factory owns only the DB-only
// services, typed against the driver-agnostic DataDb.
export function createKernelServices(deps: KernelDeps): KernelServices {
  const { dataDb, notes, tasks, inbox, templates } = deps

  const settings = createSettingsService(dataDb)
  const tags = createTagsService({ dataDb, notes })
  const reminders = createRemindersService(dataDb)
  const bookmarks = createBookmarksService(dataDb)
  const savedFilters = createSavedFiltersService(dataDb)
  const calendar = createCalendarService(dataDb)
  const agent = createAgentService(settings)
  const graph = createGraphService({ notes, tasks })
  const searchStats = createSearchStatsService({ notes, tasks, inbox })
  const searchReasons = createSearchReasonsService(dataDb)
  const searchTags = createSearchTagsService({ tags, templates })

  return {
    settings,
    tags,
    reminders,
    bookmarks,
    savedFilters,
    calendar,
    agent,
    graph,
    searchStats,
    searchReasons,
    searchTags
  }
}
```

- [ ] **Step 4: Export it from the barrel.** Append to `packages/app-kernel/src/index.ts`:

```ts
export * from './create-kernel.ts'
```

- [ ] **Step 5: Run the kernel test, expect PASS.** `pnpm --filter @memry/app-kernel test`:

```
# pass 1   # fail 0
```

- [ ] **Step 6: Consume `createKernelServices` from `createMemryApp`.** In `packages/app-core/src/memry-app.ts`, add `createKernelServices` to the value import from `@memry/app-kernel` (added in Task 3 Step 8). Then in the `createMemryApp` body, keep building `notes`, `folders`, `folderView`, `properties`, `tasks`, `inbox`, `templates` as today, and REPLACE the inline block that currently builds `tags`, `reminders`, `settings`, `bookmarks`, `savedFilters`, `calendar`, `agent`, `graph`, `searchStats`, `searchReasons`, `searchTags` (and move `locale` below it, since it needs `settings`). The new ordering is:

```ts
const tasks = createTasksService(databases.dataDb)
const inbox = createInboxService({ dataDb: databases.dataDb, vaultPath, notes, tasks })
const templates = createTemplatesService(vaultPath)

const {
  settings,
  tags,
  reminders,
  bookmarks,
  savedFilters,
  calendar,
  agent,
  graph,
  searchStats,
  searchReasons,
  searchTags
} = createKernelServices({ dataDb: databases.dataDb, notes, tasks, inbox, templates })

const locale = createLocaleService({ vaultPath, settings })
const sync = createSyncService({ dataDb: databases.dataDb, vaultPath, config })
const versions = createVersionsService({ vaultPath, indexDb: databases.indexDb, notes })
const attachments = createAttachmentsService({ vaultPath, config, notes })
const importFiles = createImportFilesService({ vaultPath, config, dataDb: databases.dataDb })
const exportHtml = createExportHtmlService({ notes })
const exportPdf = createExportPdfService({ notes })
const exportMarkdown = createExportMarkdownService({ vaultPath, notes })
```

Delete the now-removed inline `const settings = ...` / `const tags = ...` / `const reminders = ...` / `const bookmarks = ...` / `const savedFilters = ...` / `const calendar = ...` / `const agent = ...` / `const graph = ...` / `const searchStats = ...` / `const searchReasons = ...` / `const searchTags = ...` / the old `const locale = ...` line. The returned `MemryApp` object literal (which references `tasks`, `settings`, `tags`, `reminders`, `bookmarks`, `savedFilters`, `calendar`, `agent`, `graph`, `searchStats`, `searchReasons`, `searchTags`, `locale`) is unchanged.

- [ ] **Step 7: Typecheck app-core.** `pnpm --filter @memry/app-core typecheck` — exit 0. (`DataDb` is `BaseSQLiteDatabase<'sync', ...>` and `databases.dataDb` is `BetterSQLite3Database<...>` which is assignable to it, so the `createKernelServices({ dataDb: databases.dataDb, ... })` call typechecks.)

- [ ] **Step 8: Run the app-core integration suite, expect PASS (unchanged count).** `pnpm --filter @memry/app-core test`:

```
# pass N   # fail 0
```

`N` equals the Task 3 baseline — this proves the delegation is behavior-preserving.

- [ ] **Step 9: Commit.**

```
git add packages/app-kernel packages/app-core
git commit -m "feat(app-kernel): add createKernelServices and consume it from createMemryApp"
```

---

### Task 5: Whole-repo verification — cli smoke, typecheck, architecture boundaries

No new product code. This task proves the split is invisible to every existing consumer of `@memry/app-core` (notably `apps/cli` and `apps/desktop` main), that the `./reminders` subpath still resolves, and that the two new packages don't violate architecture boundaries.

**Files:**

- Verify only (no edits expected). If a consumer breaks, the fix is a re-export in `packages/app-core/src/index.ts` — do not edit the consumer.

**Interfaces:**

- Consumes: `createMemryApp({ vaultPath })` from `@memry/app-core` (signature preserved), `@memry/app-core/reminders` subpath.
- Produces: nothing new.

- [ ] **Step 1: Confirm the `./reminders` subpath resolves through the shim.** Run:

```
node --no-warnings --experimental-strip-types -e "import('@memry/app-core/reminders').then((m) => { if (typeof m.createRemindersService !== 'function') throw new Error('reminders subpath broken'); console.log('reminders subpath OK') })"
```

Expected: `reminders subpath OK`. (Run from `packages/app-core` so the workspace resolver is in scope; if native `ERR_DLOPEN_FAILED`, `pnpm --filter @memry/desktop rebuild:node` first.)

- [ ] **Step 2: Repo-wide typecheck (covers cli + desktop + all packages).** `pnpm typecheck` — exit 0. This is the cli-compat gate: `apps/cli/src/run.ts` imports `createMemryApp` from `@memry/app-core`, whose signature is unchanged, so it must typecheck without edits.

- [ ] **Step 3: cli smoke run.** Build/run the CLI against a throwaway vault to prove `createMemryApp` still wires end-to-end through the kernel:

```
TMPVAULT="$(mktemp -d)"
pnpm --filter @memry/cli exec node --no-warnings --experimental-strip-types src/run.ts --vault "$TMPVAULT" --help
```

Expected: the CLI prints its usage/help without throwing (no unresolved-import or `createKernelServices` error). If `run.ts` has no `--help`, run its lightest read command (e.g. list notes) against `$TMPVAULT`; a clean exit is the pass. (Native load error → `pnpm --filter @memry/desktop rebuild:node`.)

- [ ] **Step 4: Architecture boundary check.** `pnpm check:architecture` — exit 0. Confirms `@memry/platform` pulls no electron/keytar/better-sqlite3, and `@memry/app-kernel` pulls no `better-sqlite3`/`node:fs` (the type-only `@memry/app-core` devDep is erased and must not surface as a runtime import).

- [ ] **Step 5: Verify the kernel package has no better-sqlite3 runtime coupling.** Run:

```
rg -n "better-sqlite3|from 'node:fs'|from \"node:fs\"" packages/app-kernel/src
```

Expected: no matches (empty output). This is the concrete portability assertion — the kernel is driver-agnostic and fs-free.

- [ ] **Step 6: Full desktop main suite regression.** `pnpm --filter @memry/desktop test:main` — green (the platform adapters from Task 2 plus every existing main test). Confirms nothing downstream of the app-core public surface regressed.

- [ ] **Step 7: Commit.**

```
git add -A
git commit -m "refactor(app-core): verify kernel/platform split keeps cli, typecheck, and architecture green"
```

---

## Verification Summary (run before handing off)

```
pnpm --filter @memry/platform test
pnpm --filter @memry/platform typecheck
pnpm --filter @memry/app-kernel test
pnpm --filter @memry/app-kernel typecheck
pnpm --filter @memry/app-core test
pnpm --filter @memry/desktop test:main
pnpm typecheck
pnpm check:architecture
```

All green = desktop consumes `@memry/platform` + `@memry/app-kernel` with zero behavior change, the `@memry/app-core` public surface (`createMemryApp({ vaultPath })`, `@memry/app-core/reminders`, `@memry/app-core/markdown`) is preserved, and the kernel is driver-agnostic — ready for the deferred mobile-scaffold workstream to pass an `op-sqlite` `DataDb` and mobile platform adapters into `createKernelServices`.

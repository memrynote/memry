# Account Vault Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Signed-in devices discover all account vaults (with E2E-encrypted names), show cloud-only vaults in the switcher, and download them on demand via a path-confirm dialog.

**Architecture:** Server `sync_vaults` gains encrypted name columns + a `POST /sync/vaults` registration route. A new main-process `vault-directory.ts` service fetches/decrypts/caches the account vault list, self-registers local vaults, and provisions remote vaults via existing `createDormantVault`. Renderer adds an "In your account" switcher section + download dialog. Linking stops eagerly provisioning non-primary vaults.

**Tech Stack:** Hono + D1 (sync-server), Electron main (libsodium, electron-store), Zod IPC contracts, React 19 + Picker UI, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-09-account-vault-directory-design.md`

**Key facts discovered during research (trust these, don't re-derive):**
- `sync_vaults` table already exists (`apps/sync-server/schema/d1.sql:117`); rows are inserted by `ensureSyncVaultAllowed` (`apps/sync-server/src/services/entitlements.ts:187`) from `paidSyncMiddleware` on first push. Empty vaults have no row until registered.
- `listUserVaults` (`apps/sync-server/src/services/sync.ts:618`) currently derives vaults from `sync_items` — empty vaults invisible. Route: `sync.get('/vaults', ...)` at `apps/sync-server/src/routes/sync.ts:60`, registered BEFORE `paidSyncMiddleware` deliberately.
- Master key: OS keychain `retrieveKey(KEYCHAIN_ENTRIES.MASTER_KEY)`. Vault key = `deriveKey(masterKey, KEY_DERIVATION_CONTEXTS.VAULT_KEY, 32)` — account-global, NOT per-vault (see `getOrInitializeLocalVaultKey` in `apps/desktop/src/main/crypto/vault-key-state.ts`).
- `encrypt(plaintext, key, aad?)` → `{ciphertext, nonce}` / `decrypt(ciphertext, nonce, key, aad?)` exported from `apps/desktop/src/main/crypto` (index re-exports `encryption.ts`).
- HTTP: `getFromServer<T>(path, token)` / `postToServer<T>(path, body, token)` in `apps/desktop/src/main/sync/http-client.ts`. Token: `retrieveToken(KEYCHAIN_ENTRIES.ACCESS_TOKEN)` from `apps/desktop/src/main/sync/token-manager.ts`.
- `createDormantVault(folderPath, serverVaultUuid)` in `apps/desktop/src/main/sync/vault-provisioning.ts` — transiently repoints the data.db singleton; the vault to be opened must be `selectVault`ed LAST.
- `selectVault(input)` at `apps/desktop/src/main/vault/index.ts:330` calls `createVaultInfo` + `upsertVault`.
- Vault IPC handlers: `apps/desktop/src/main/ipc/vault-handlers.ts` using `createHandler`/`createValidatedHandler` from `./validate`.
- Linking eager provisioning loop to remove: `apps/desktop/src/main/sync/linking-service.ts` inside `finalizeVaultChoice` (~line 586).
- Sign-in AND linking both flow through `persistKeysAndRegisterDevice` (`apps/desktop/src/main/sync/device-registration.ts:89`) — single refresh trigger covers both.
- i18n: `packages/i18n/src/locales/<lang>/common.json`, keys under `phaseF.componentsVaultSwitcher.*`. Run `pnpm --filter @memry/desktop i18n:check`.
- Switcher: `apps/desktop/src/renderer/src/components/vault-switcher.tsx` (Picker-based; has working-tree changes — build on them, don't revert).
- Entitlements: `getSyncEntitlement(db, userId)`, `isPaidSyncEntitlementActive(entitlement)`, `ensureSyncVaultAllowed(db, userId, vaultId, entitlement)` in `apps/sync-server/src/services/entitlements.ts`.

---

### Task 1: Server — encrypted name columns + registration route

**Files:**
- Modify: `apps/sync-server/schema/d1.sql:117` (sync_vaults CREATE TABLE)
- Modify: `apps/sync-server/src/services/sync.ts:612-640` (UserVaultSummary, listUserVaults, new setVaultName)
- Modify: `apps/sync-server/src/routes/sync.ts:44-62` (POST /vaults)
- Test: `apps/sync-server/src/routes/sync.test.ts` (extend `describe('GET /sync/vaults')` block at :308, add POST describe)
- Check: `apps/sync-server/schema/d1.test.ts` (update if it asserts sync_vaults columns)

- [ ] **Step 1.1: Write failing tests** in `sync.test.ts` after the existing GET /sync/vaults describe. Follow the harness used at :305-320 (`app.request(path, init, env, executionCtx)`, existing auth fixtures):

```typescript
describe('POST /sync/vaults', () => {
  it('registers an empty vault that then appears in GET with zero items', async () => {
    const res = await app.request(
      '/sync/vaults',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vaultUuid: 'empty-vault-uuid',
          encryptedName: 'b64-name-ciphertext',
          nameNonce: 'b64-nonce'
        })
      },
      env,
      executionCtx
    )
    expect(res.status).toBe(200)

    const list = await app.request('/sync/vaults', { method: 'GET' }, env, executionCtx)
    const body = (await list.json()) as { vaults: Array<Record<string, unknown>> }
    const entry = body.vaults.find((v) => v.vaultUuid === 'empty-vault-uuid')
    expect(entry).toMatchObject({
      itemCount: 0,
      encryptedName: 'b64-name-ciphertext',
      nameNonce: 'b64-nonce'
    })
  })

  it('upserts the name on re-registration', async () => {
    // POST same vaultUuid twice with different encryptedName; GET returns the second
  })

  it('rejects invalid payloads with 400', async () => {
    const res = await app.request(
      '/sync/vaults',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      env,
      executionCtx
    )
    expect(res.status).toBe(400)
  })

  it('returns 402 when the user has no active paid sync entitlement', async () => {
    // use/extend the existing unpaid-user fixture pattern from this file
  })
})
```

Also update the existing GET test expectation (:314) — response entries now include `encryptedName: null, nameNonce: null` for vaults registered without names, and vaults appear even with zero items once registered.

- [ ] **Step 1.2: Run** `pnpm test:sync-server -- sync.test` → new tests FAIL (404 on POST, missing fields on GET).

- [ ] **Step 1.3: Implement.**

`d1.sql` — add two nullable columns to the CREATE TABLE (pre-production, edit in place):

```sql
CREATE TABLE sync_vaults (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL,
  encrypted_name TEXT,
  name_nonce TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, vault_id)
);
```

`services/sync.ts` — replace `UserVaultSummary` + `listUserVaults`, add `setVaultName`:

```typescript
export interface UserVaultSummary {
  vaultUuid: string
  itemCount: number
  createdAt: number | null
  encryptedName: string | null
  nameNonce: string | null
}

export const listUserVaults = async (
  db: D1Database,
  userId: string
): Promise<UserVaultSummary[]> => {
  const { results } = await db
    .prepare(
      `SELECT sv.vault_id AS vaultUuid,
              COALESCE(cnt.itemCount, 0) AS itemCount,
              sv.created_at AS createdAt,
              sv.encrypted_name AS encryptedName,
              sv.name_nonce AS nameNonce
       FROM sync_vaults sv
       LEFT JOIN (
         SELECT user_id, vault_id, COUNT(*) AS itemCount
         FROM sync_items
         WHERE deleted_at IS NULL
         GROUP BY user_id, vault_id
       ) cnt ON cnt.user_id = sv.user_id AND cnt.vault_id = sv.vault_id
       WHERE sv.user_id = ?
       ORDER BY itemCount DESC`
    )
    .bind(userId)
    .all<UserVaultSummary>()
  return (results ?? []).map((r) => ({
    vaultUuid: r.vaultUuid,
    itemCount: Number(r.itemCount),
    createdAt: r.createdAt ?? null,
    encryptedName: r.encryptedName ?? null,
    nameNonce: r.nameNonce ?? null
  }))
}

export const setVaultName = async (
  db: D1Database,
  userId: string,
  vaultId: string,
  encryptedName: string,
  nameNonce: string
): Promise<void> => {
  await db
    .prepare(
      `UPDATE sync_vaults SET encrypted_name = ?, name_nonce = ?, updated_at = ?
       WHERE user_id = ? AND vault_id = ?`
    )
    .bind(encryptedName, nameNonce, Math.floor(Date.now() / 1000), userId, vaultId)
    .run()
}
```

NOTE this changes listUserVaults semantics: only registered vaults are listed. The desktop self-registration (Task 4) closes the loop; any pushing vault already gets a row from `ensureSyncVaultAllowed`.

`routes/sync.ts` — after `sync.get('/vaults', ...)` (:60), still BEFORE `sync.use('*', paidSyncMiddleware)`:

```typescript
const RegisterVaultSchema = z.object({
  vaultUuid: z.string().min(1).max(128),
  encryptedName: z.string().min(1).max(2048),
  nameNonce: z.string().min(1).max(128)
})

const handleRegisterVault = async (c: Context<AppContext>): Promise<Response> => {
  const userId = c.get('userId')!
  const parsed = RegisterVaultSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'Invalid vault registration payload' }, 400)
  }
  const entitlement = await getSyncEntitlement(c.env.DB, userId)
  if (!isPaidSyncEntitlementActive(entitlement)) {
    return c.json({ error: 'Active sync subscription required' }, 402)
  }
  await ensureSyncVaultAllowed(c.env.DB, userId, parsed.data.vaultUuid, entitlement)
  await setVaultName(
    c.env.DB,
    userId,
    parsed.data.vaultUuid,
    parsed.data.encryptedName,
    parsed.data.nameNonce
  )
  return c.json({ success: true })
}

sync.post('/vaults', vaultsRateLimit, handleRegisterVault)
```

Import `getSyncEntitlement`, `isPaidSyncEntitlementActive`, `ensureSyncVaultAllowed` from `../services/entitlements` and `setVaultName` from `../services/sync` (check exact `isPaidSyncEntitlementActive` signature at entitlements.ts:113 — adapt if it takes extra args). `ensureSyncVaultAllowed` throws `AppError` 402 on vault-limit — existing error middleware maps it.

- [ ] **Step 1.4: Run** `pnpm test:sync-server` → all pass (fix any d1.test.ts column assertions).

- [ ] **Step 1.5: Commit** `feat(sync-server): vault registration with encrypted names`

---

### Task 2: Contracts + preload + store types

**Files:**
- Modify: `packages/contracts/src/ipc-channels.ts:33-55` (VaultChannels)
- Modify: `packages/contracts/src/vault-api.ts` (types, schema, handlers, client API)
- Modify: `apps/desktop/src/preload/api/vault.ts`
- Modify: `apps/desktop/src/preload/index.d.ts` (vault section — grep `reveal()` to find it)
- Modify: `apps/desktop/src/main/store.ts` (StoredVaultInfo, SyncStoreData, cache helpers)

- [ ] **Step 2.1:** `ipc-channels.ts` — add to `VaultChannels.invoke`:

```typescript
    LIST_ACCOUNT: 'vault:list-account',
    DOWNLOAD_REMOTE: 'vault:download-remote'
```

- [ ] **Step 2.2:** `vault-api.ts` — add `vaultUuid?: string` to `VaultInfo`, plus:

```typescript
export interface AccountVaultInfo {
  vaultUuid: string
  /** Decrypted display name; null when absent or undecryptable */
  name: string | null
  itemCount: number
  createdAt: number | null
  /** Path of the local copy, null when the vault is cloud-only */
  localPath: string | null
  /** Default destination folder for download */
  suggestedPath: string
}

export const DownloadRemoteVaultSchema = z.object({
  vaultUuid: z.string().min(1),
  parentPath: z.string().optional()
})
```

Handlers interface additions:

```typescript
  [VaultChannels.invoke.LIST_ACCOUNT]: () => Promise<AccountVaultInfo[]>

  [VaultChannels.invoke.DOWNLOAD_REMOTE]: (
    input: z.infer<typeof DownloadRemoteVaultSchema>
  ) => Promise<SelectVaultResponse>
```

`VaultClientAPI` additions:

```typescript
  listAccount(): Promise<AccountVaultInfo[]>
  downloadRemote(vaultUuid: string, parentPath?: string): Promise<SelectVaultResponse>
```

- [ ] **Step 2.3:** `preload/api/vault.ts` — add to `vaultApi`:

```typescript
  listAccount: () => invoke(VaultChannels.invoke.LIST_ACCOUNT),
  downloadRemote: (vaultUuid: string, parentPath?: string) =>
    invoke(VaultChannels.invoke.DOWNLOAD_REMOTE, { vaultUuid, parentPath })
```

Mirror in `preload/index.d.ts` vault api type.

- [ ] **Step 2.4:** `store.ts` — add `vaultUuid?: string` to `StoredVaultInfo`; add to `SyncStoreData`:

```typescript
  accountVaultsCache?: {
    fetchedAt: number
    vaults: Array<{
      vaultUuid: string
      name: string | null
      itemCount: number
      createdAt: number | null
    }>
  }
```

with helpers next to the other sync store accessors:

```typescript
export type AccountVaultsCache = NonNullable<SyncStoreData['accountVaultsCache']>

export function getAccountVaultsCache(): AccountVaultsCache | undefined {
  return store.get('sync').accountVaultsCache
}

export function setAccountVaultsCache(cache: AccountVaultsCache): void {
  store.set('sync', { ...store.get('sync'), accountVaultsCache: cache })
}
```

(Match the actual accessor style used in store.ts for the sync section.)

- [ ] **Step 2.5:** Run `pnpm ipc:generate` then `pnpm ipc:check` → green. `pnpm --filter @memry/desktop typecheck:node` → only pre-existing failures.

- [ ] **Step 2.6: Commit** `feat(contracts): listAccount + downloadRemote vault IPC`

---

### Task 3: Main — vault name crypto (TDD)

**Files:**
- Create: `apps/desktop/src/main/sync/vault-name-crypto.ts`
- Test: `apps/desktop/src/main/sync/vault-name-crypto.test.ts`

- [ ] **Step 3.1: Failing test** (real libsodium, like `crypto.test.ts` — `await initCrypto()` or `await sodium.ready` in beforeAll):

```typescript
import { describe, it, expect, beforeAll } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import { encryptVaultName, decryptVaultName } from './vault-name-crypto'

describe('vault name crypto', () => {
  let key: Uint8Array
  beforeAll(async () => {
    await sodium.ready
    key = sodium.randombytes_buf(32)
  })

  it('round-trips a vault name', () => {
    const { encryptedName, nameNonce } = encryptVaultName('Research Vault', key, 'uuid-1')
    expect(decryptVaultName(encryptedName, nameNonce, key, 'uuid-1')).toBe('Research Vault')
  })

  it('returns null when AAD (vault uuid) does not match', () => {
    const { encryptedName, nameNonce } = encryptVaultName('Research Vault', key, 'uuid-1')
    expect(decryptVaultName(encryptedName, nameNonce, key, 'uuid-2')).toBeNull()
  })

  it('returns null on garbage input', () => {
    expect(decryptVaultName('!!!', '???', key, 'uuid-1')).toBeNull()
  })
})
```

- [ ] **Step 3.2:** Run `pnpm --filter @memry/desktop test:main -- vault-name-crypto` → FAIL (module missing).

- [ ] **Step 3.3: Implement:**

```typescript
import sodium from 'libsodium-wrappers-sumo'

import { decrypt, encrypt } from '../crypto'

const NAME_AAD_PREFIX = 'vault-name-v1'

const aadFor = (vaultUuid: string): Uint8Array =>
  new TextEncoder().encode(`${NAME_AAD_PREFIX}:${vaultUuid}`)

const toB64 = (input: Uint8Array): string =>
  sodium.to_base64(input, sodium.base64_variants.ORIGINAL)

const fromB64 = (input: string): Uint8Array =>
  sodium.from_base64(input, sodium.base64_variants.ORIGINAL)

export function encryptVaultName(
  name: string,
  key: Uint8Array,
  vaultUuid: string
): { encryptedName: string; nameNonce: string } {
  const { ciphertext, nonce } = encrypt(new TextEncoder().encode(name), key, aadFor(vaultUuid))
  return { encryptedName: toB64(ciphertext), nameNonce: toB64(nonce) }
}

export function decryptVaultName(
  encryptedName: string,
  nameNonce: string,
  key: Uint8Array,
  vaultUuid: string
): string | null {
  try {
    const plaintext = decrypt(fromB64(encryptedName), fromB64(nameNonce), key, aadFor(vaultUuid))
    return new TextDecoder().decode(plaintext)
  } catch {
    return null
  }
}
```

- [ ] **Step 3.4:** Test passes. **Commit** `feat(sync): vault name encryption helpers`

---

### Task 4: Main — vault-directory service (TDD)

**Files:**
- Create: `apps/desktop/src/main/sync/vault-directory.ts`
- Test: `apps/desktop/src/main/sync/vault-directory.test.ts`

- [ ] **Step 4.1: Failing tests.** Mock collaborators with `vi.mock` (pattern: see `vault-transfer.test.ts` / other sync tests):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./http-client', () => ({ getFromServer: vi.fn(), postToServer: vi.fn() }))
vi.mock('./token-manager', () => ({ retrieveToken: vi.fn(async () => 'token') }))
vi.mock('../crypto', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  retrieveKey: vi.fn(async () => new Uint8Array(32))
}))
vi.mock('../store', () => ({
  getVaults: vi.fn(() => []),
  getCurrentVaultPath: vi.fn(() => null),
  getAccountVaultsCache: vi.fn(() => undefined),
  setAccountVaultsCache: vi.fn()
}))
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/docs') } }))
```

Cases:
1. `refreshVaultDirectory({force:true})` fetches `/sync/vaults`, decrypts names, writes cache via `setAccountVaultsCache` (encrypt a fixture name with the real helpers + the same all-zero key the `retrieveKey` mock returns, after `deriveKey`; simplest: spy on the derived key by exporting `getNameKey` for tests or encrypt the fixture using the production derivation in the test).
2. Undecryptable name → cache entry has `name: null`.
3. Self-registration: local vault `{path:'/v/a', name:'Alpha', vaultUuid:'uuid-a'}` absent from server response → `postToServer('/sync/vaults', {vaultUuid:'uuid-a', ...}, 'token')` called.
4. Name heal: server has `uuid-a` but decrypted name ≠ local `name` → re-POST.
5. Throttle: second non-forced call within 30s does not hit `getFromServer` again (export `__resetThrottleForTests()`).
6. `listAccountVaults()` merges cache + local registry → `localPath` set for local uuids, null otherwise; `suggestedPath` under the default parent.
7. No token / no master key → refresh is a silent no-op.

- [ ] **Step 4.2:** Run → FAIL (module missing).

- [ ] **Step 4.3: Implement** `vault-directory.ts`:

```typescript
import fs from 'fs'
import path from 'path'
import { app } from 'electron'

import { KEYCHAIN_ENTRIES, KEY_DERIVATION_CONTEXTS } from '@memry/contracts/crypto'
import type { AccountVaultInfo, SelectVaultResponse } from '@memry/contracts/vault-api'

import { retrieveKey, secureCleanup } from '../crypto'
import { deriveKey } from '../crypto/keys'
import { createLogger } from '../lib/logger'
import {
  getAccountVaultsCache,
  getCurrentVaultPath,
  getVaults,
  setAccountVaultsCache
} from '../store'
import { getFromServer, postToServer } from './http-client'
import { retrieveToken } from './token-manager'
import { decryptVaultName, encryptVaultName } from './vault-name-crypto'

const log = createLogger('VaultDirectory')

const REFRESH_THROTTLE_MS = 30_000

interface ServerVaultEntry {
  vaultUuid: string
  itemCount: number
  createdAt: number | null
  encryptedName: string | null
  nameNonce: string | null
}

let lastRefreshAt = 0

export function __resetThrottleForTests(): void {
  lastRefreshAt = 0
}

async function getNameKey(): Promise<Uint8Array | null> {
  const masterKey = await retrieveKey(KEYCHAIN_ENTRIES.MASTER_KEY)
  if (!masterKey) return null
  try {
    return await deriveKey(masterKey, KEY_DERIVATION_CONTEXTS.VAULT_KEY, 32)
  } finally {
    secureCleanup(masterKey)
  }
}

export async function refreshVaultDirectory(opts?: { force?: boolean }): Promise<void> {
  if (!opts?.force && Date.now() - lastRefreshAt < REFRESH_THROTTLE_MS) return

  const token = await retrieveToken(KEYCHAIN_ENTRIES.ACCESS_TOKEN)
  if (!token) return
  const nameKey = await getNameKey()
  if (!nameKey) return

  try {
    const { vaults } = await getFromServer<{ vaults: ServerVaultEntry[] }>('/sync/vaults', token)
    lastRefreshAt = Date.now()

    const remote = vaults.map((v) => ({
      vaultUuid: v.vaultUuid,
      name:
        v.encryptedName && v.nameNonce
          ? decryptVaultName(v.encryptedName, v.nameNonce, nameKey, v.vaultUuid)
          : null,
      itemCount: v.itemCount,
      createdAt: v.createdAt
    }))
    setAccountVaultsCache({ fetchedAt: Date.now(), vaults: remote })

    // Self-registration + name heal: every local vault with a known uuid must
    // exist on the server under its current name (auto-sync-all policy).
    const remoteByUuid = new Map(remote.map((v) => [v.vaultUuid, v]))
    for (const local of getVaults()) {
      if (!local.vaultUuid) continue
      const entry = remoteByUuid.get(local.vaultUuid)
      if (entry && entry.name === local.name) continue
      const { encryptedName, nameNonce } = encryptVaultName(local.name, nameKey, local.vaultUuid)
      try {
        await postToServer(
          '/sync/vaults',
          { vaultUuid: local.vaultUuid, encryptedName, nameNonce },
          token
        )
      } catch (err) {
        log.info('Vault self-registration skipped', { vaultUuid: local.vaultUuid, err })
      }
    }
  } catch (err) {
    log.warn('Vault directory refresh failed', err)
  } finally {
    secureCleanup(nameKey)
  }
}

function defaultParentDir(): string {
  const current = getCurrentVaultPath()
  if (current) return path.dirname(current)
  return path.join(app.getPath('documents'), 'Memry')
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function suggestVaultFolder(
  vault: { vaultUuid: string; name: string | null },
  parent: string = defaultParentDir()
): string {
  const fallback = `memry-vault-${vault.vaultUuid.slice(0, 8)}`
  const base = (vault.name ? slugify(vault.name) : '') || fallback
  let candidate = path.join(parent, base)
  let suffix = 2
  while (fs.existsSync(candidate)) {
    candidate = path.join(parent, `${base}-${suffix++}`)
  }
  return candidate
}

export function listAccountVaults(): AccountVaultInfo[] {
  const cache = getAccountVaultsCache()
  const localByUuid = new Map(
    getVaults()
      .filter((v) => v.vaultUuid)
      .map((v) => [v.vaultUuid as string, v])
  )
  return (cache?.vaults ?? []).map((v) => ({
    vaultUuid: v.vaultUuid,
    name: v.name,
    itemCount: v.itemCount,
    createdAt: v.createdAt,
    localPath: localByUuid.get(v.vaultUuid)?.path ?? null,
    suggestedPath: suggestVaultFolder(v)
  }))
}

export async function downloadRemoteVault(input: {
  vaultUuid: string
  parentPath?: string
}): Promise<SelectVaultResponse> {
  const { selectVault } = await import('../vault')

  const existing = getVaults().find((v) => v.vaultUuid === input.vaultUuid)
  if (existing) return selectVault({ path: existing.path })

  const cached = getAccountVaultsCache()?.vaults.find((v) => v.vaultUuid === input.vaultUuid)
  const parent = input.parentPath ?? defaultParentDir()
  fs.mkdirSync(parent, { recursive: true })
  const folder = suggestVaultFolder(
    { vaultUuid: input.vaultUuid, name: cached?.name ?? null },
    parent
  )

  const { createDormantVault } = await import('./vault-provisioning')
  createDormantVault(folder, input.vaultUuid)
  // createDormantVault repoints the data.db singleton — open the new vault NOW.
  return selectVault({ path: folder })
}
```

- [ ] **Step 4.4:** Tests pass (`pnpm --filter @memry/desktop test:main -- vault-directory`). Add `downloadRemoteVault` tests with mocked `../vault` + `./vault-provisioning` (existing-local short-circuits to selectVault; cloud-only creates dormant then selects).

- [ ] **Step 4.5: Commit** `feat(sync): account vault directory service`

---

### Task 5: Main — IPC handlers, uuid stamping, triggers

**Files:**
- Modify: `apps/desktop/src/main/ipc/vault-handlers.ts` (two new handlers)
- Modify: `apps/desktop/src/main/vault/index.ts:330-360` (stamp vaultUuid in selectVault)
- Modify: `apps/desktop/src/main/sync/runtime.ts` (refresh after engine start)
- Modify: `apps/desktop/src/main/sync/device-registration.ts:89+` (refresh after registration)
- Test: extend `apps/desktop/src/main/ipc/vault-handlers` coverage if a test file exists; otherwise covered by Task 4 unit tests + typecheck

- [ ] **Step 5.1:** `vault-handlers.ts` — register inside `registerVaultHandlers()`:

```typescript
  ipcMain.handle(
    VaultChannels.invoke.LIST_ACCOUNT,
    createHandler(async () => {
      const { refreshVaultDirectory, listAccountVaults } = await import('../sync/vault-directory')
      await refreshVaultDirectory()
      return listAccountVaults()
    })
  )

  ipcMain.handle(
    VaultChannels.invoke.DOWNLOAD_REMOTE,
    createValidatedHandler(DownloadRemoteVaultSchema, async (input) => {
      const { downloadRemoteVault } = await import('../sync/vault-directory')
      return downloadRemoteVault(input)
    })
  )
```

Import `DownloadRemoteVaultSchema` from `@memry/contracts/vault-api`.

- [ ] **Step 5.2:** `vault/index.ts` selectVault — stamp uuid after `const vaultInfo = createVaultInfo(vaultPath)`:

```typescript
    try {
      const { getOrCreateVaultUuid } = await import('../agent/storage/vault-id')
      const { getDatabase } = await import('../database/client')
      vaultInfo.vaultUuid = getOrCreateVaultUuid(getDatabase())
    } catch {
      // best-effort: uuid re-stamps on next open; directory skips uuid-less vaults
    }
```

(Use static imports instead if vault/index.ts already imports these modules without cycles.)

- [ ] **Step 5.3:** `runtime.ts` — in the start path, after the engine is created and `engine.start()` succeeds (search `engine.start()` / `startPromise`), add:

```typescript
    void import('./vault-directory').then(({ refreshVaultDirectory }) =>
      refreshVaultDirectory({ force: true })
    )
```

- [ ] **Step 5.4:** `device-registration.ts` — at the end of `persistKeysAndRegisterDevice` success path (after master key stored + vault bound):

```typescript
  void import('./vault-directory')
    .then(({ refreshVaultDirectory }) => refreshVaultDirectory({ force: true }))
    .catch(() => {})
```

This single hook covers password sign-in AND QR linking (both call persistKeysAndRegisterDevice).

- [ ] **Step 5.5:** `pnpm --filter @memry/desktop typecheck:node && pnpm --filter @memry/desktop test:main` → green (pre-existing failures exempt). **Commit** `feat(vault): account vault IPC + directory refresh triggers`

---

### Task 6: Linking — stop eager non-primary provisioning

**Files:**
- Modify: `apps/desktop/src/main/sync/linking-service.ts` (~:586, finalizeVaultChoice)
- Test: `apps/desktop/src/main/sync/linking-service.test.ts` (update assertions)

- [ ] **Step 6.1:** Update the linking-service test that asserts `createDormantVault` is called for every selected vault — it must now assert it is NOT called for non-primary uuids (primary vault folder creation stays). Run → FAIL.

- [ ] **Step 6.2:** In `finalizeVaultChoice`, delete the loop:

```typescript
    // Create the dormant vaults first; each transiently repoints the data.db
    // singleton, so the primary must be opened LAST.
    for (const uuid of input.selectedVaultUuids) {
      if (uuid === input.primaryVaultUuid) continue
      createDormantVault(path.join(input.parentFolderPath, dormantVaultFolderName(uuid)), uuid)
    }
```

Keep the IPC contract (`selectedVaultUuids`) unchanged for now — extras are simply ignored; non-primary vaults surface in the switcher's "In your account" section instead. Keep primary handling: it still uses `createDormantVault` + `selectVault`? — NO: primary goes through `dormantVaultFolderName(primary)` + `selectVault({path: primaryFolder})`. Verify whether the primary folder is created by `createDormantVault` elsewhere or `selectVault` initializes it; if the deleted loop was the only `createDormantVault` use for non-primaries, the primary path already works via the existing `primaryFolder` flow above the loop — leave it intact, but the primary's dormant creation (if it relied on the loop's `createDormantVault` for adoption) must keep adopting the server uuid. Check the surrounding code: the primary vault must end up with `adoptVaultLocally(db, primaryVaultUuid)` — if that only happened via `createDormantVault`, call `createDormantVault(primaryFolder, input.primaryVaultUuid)` explicitly before `selectVault`.

- [ ] **Step 6.3:** `pnpm --filter @memry/desktop test:main -- linking-service` → green. **Commit** `feat(linking): defer non-primary vault download to vault directory`

---

### Task 7: Renderer — switcher section + download dialog

**Files:**
- Create: `apps/desktop/src/renderer/src/hooks/use-account-vaults.ts`
- Create: `apps/desktop/src/renderer/src/components/download-vault-dialog.tsx`
- Modify: `apps/desktop/src/renderer/src/components/vault-switcher.tsx`
- Modify: `packages/i18n/src/locales/*/common.json` (all locales; check parity with `pnpm --filter @memry/desktop i18n:check`)
- Test: `apps/desktop/src/renderer/src/components/download-vault-dialog.test.tsx`, extend switcher coverage (follow mock harness in `app-sidebar.test.tsx`)

- [ ] **Step 7.1:** Hook:

```typescript
import { useCallback, useState } from 'react'
import type { AccountVaultInfo } from '@memry/contracts/vault-api'

export function useAccountVaults(): {
  accountVaults: AccountVaultInfo[]
  refresh: () => Promise<void>
} {
  const [accountVaults, setAccountVaults] = useState<AccountVaultInfo[]>([])
  const refresh = useCallback(async () => {
    try {
      setAccountVaults(await window.api.vault.listAccount())
    } catch {
      // offline or signed out — keep last known list
    }
  }, [])
  return { accountVaults, refresh }
}
```

- [ ] **Step 7.2:** i18n keys in every `packages/i18n/src/locales/<lang>/common.json` under `phaseF.componentsVaultSwitcher` (match how recent keys like `signInToSync` were handled across locales):

```json
"inYourAccount": "In your account",
"itemsCount": "{{count}} items",
"untitledVault": "Vault",
"downloadVaultTitle": "Download “{{name}}”",
"downloadLocation": "Location",
"changeLocation": "Change…",
"download": "Download",
"downloadFailed": "Could not download the vault"
```

- [ ] **Step 7.3:** `download-vault-dialog.tsx` (AlertDialog pattern copied from the remove-vault dialog in vault-switcher.tsx):

```tsx
'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from '@/lib/icons'

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { AccountVaultInfo } from '@memry/contracts/vault-api'
import { useT } from '@memry/i18n/renderer'

interface DownloadVaultDialogProps {
  vault: AccountVaultInfo | null
  onClose: () => void
}

export function DownloadVaultDialog({ vault, onClose }: DownloadVaultDialogProps) {
  const { t } = useT('common')
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setParentPath(null)
    setDownloading(false)
    setError(null)
  }, [vault?.vaultUuid])

  if (!vault) return null

  const folderName = vault.suggestedPath.split('/').pop() ?? vault.vaultUuid.slice(0, 8)
  const displayPath = parentPath ? `${parentPath}/${folderName}` : vault.suggestedPath

  const handleChange = async (): Promise<void> => {
    const picked = await window.api.syncIdentity.pickVaultFolder()
    if (picked) setParentPath(picked)
  }

  const handleDownload = async (): Promise<void> => {
    setDownloading(true)
    setError(null)
    try {
      const result = await window.api.vault.downloadRemote(vault.vaultUuid, parentPath ?? undefined)
      if (!result.success) {
        setError(result.error ?? t('phaseF.componentsVaultSwitcher.downloadFailed'))
        setDownloading(false)
        return
      }
      onClose()
    } catch (err) {
      setError(extractErrorMessage(err, t('phaseF.componentsVaultSwitcher.downloadFailed')))
      setDownloading(false)
    }
  }

  return (
    <AlertDialog open={!!vault} onOpenChange={(o) => !o && !downloading && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('phaseF.componentsVaultSwitcher.downloadVaultTitle', {
              name: vault.name ?? t('phaseF.componentsVaultSwitcher.untitledVault')
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('phaseF.componentsVaultSwitcher.itemsCount', { count: vault.itemCount })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">
            {t('phaseF.componentsVaultSwitcher.downloadLocation')}
          </div>
          <div className="flex items-center gap-2">
            <span className="flex-1 truncate rounded border px-2 py-1 text-xs" dir="ltr">
              {displayPath}
            </span>
            <Button variant="outline" size="sm" onClick={handleChange} disabled={downloading}>
              {t('phaseF.componentsVaultSwitcher.changeLocation')}
            </Button>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <AlertDialogFooter>
          <Button variant="outline" onClick={onClose} disabled={downloading}>
            {t('phaseF.componentsVaultSwitcher.cancel')}
          </Button>
          <Button onClick={handleDownload} disabled={downloading}>
            {downloading && <Loader2 className="size-3.5 animate-spin" />}
            {t('phaseF.componentsVaultSwitcher.download')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
```

(Verify the actual `window.api` namespace for `pickVaultFolder` — defined in `apps/desktop/src/preload/api/sync-identity.ts:41`; grep preload `index.ts` for how that api object is named on `window.api`.)

- [ ] **Step 7.4:** `vault-switcher.tsx` changes:
  - Add state + hook: `const { accountVaults, refresh } = useAccountVaults()`, `const [vaultToDownload, setVaultToDownload] = useState<AccountVaultInfo | null>(null)`.
  - Refresh on open: change `onOpenChange={setOpen}` to `onOpenChange={(o) => { setOpen(o); if (o && isAuthenticated) void refresh() }}`.
  - `const remoteOnly = accountVaults.filter((v) => !v.localPath)`.
  - Section after the local vault list (before the `open-vault` separator):

```tsx
              {isAuthenticated && remoteOnly.length > 0 && (
                <>
                  <Picker.Separator />
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
                    {tPhaseF('phaseF.componentsVaultSwitcher.inYourAccount')}
                  </div>
                  {remoteOnly.map((vault) => (
                    <button
                      key={vault.vaultUuid}
                      type="button"
                      onClick={() => {
                        setOpen(false)
                        setVaultToDownload(vault)
                      }}
                      className="flex w-full items-center gap-2.5 rounded-[5px] px-2 py-1.5 hover:bg-accent transition-colors cursor-pointer"
                    >
                      <Cloud className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate text-start text-muted-foreground">
                        {vault.name ?? tPhaseF('phaseF.componentsVaultSwitcher.untitledVault')}
                      </span>
                      <span className="text-[10px] text-muted-foreground/60">
                        {tPhaseF('phaseF.componentsVaultSwitcher.itemsCount', {
                          count: vault.itemCount
                        })}
                      </span>
                    </button>
                  ))}
                </>
              )}
```

  - Render `<DownloadVaultDialog vault={vaultToDownload} onClose={() => setVaultToDownload(null)} />` next to the remove AlertDialog.

- [ ] **Step 7.5: Tests.** `download-vault-dialog.test.tsx`: renders suggested path; Change button updates displayed path from mocked picker; Download calls `window.api.vault.downloadRemote` with `(uuid, undefined)` by default and `(uuid, pickedParent)` after change; failure renders error text. Switcher: section hidden when unauthenticated / no remote-only vaults; visible with entries when present (mock `window.api.vault.listAccount`). Follow `app-sidebar.test.tsx` window.api mock harness.

- [ ] **Step 7.6:** `pnpm --filter @memry/desktop test:renderer -- download-vault vault-switcher && pnpm --filter @memry/desktop i18n:check && pnpm --filter @memry/desktop typecheck:web` → green. **Commit** `feat(vault): In-your-account switcher section + download dialog`

---

### Task 8: Full verification + docs gate

- [ ] **Step 8.1:** `pnpm lint && pnpm typecheck && pnpm test` (pre-existing failures per CLAUDE.md exempt: websocket.test.ts, folders.test.ts).
- [ ] **Step 8.2:** `pnpm ipc:generate && pnpm ipc:check && git diff --check`.
- [ ] **Step 8.3:** Docs gate: `pnpm docs:ai-update --base <base_commit>` (or manual `apps/docs/src` update covering vault download + registration), then `pnpm docs:impact --base <base_commit> --strict && pnpm docs:build`.
- [ ] **Step 8.4:** Manual two-device verify (two-device E2E automation deferred — bootstrap-key harness can't decrypt pulled content, and adoption is already unit-covered): run `pnpm --filter @memry/desktop dev:a` (signed in, create vault "Research") and `pnpm --filter @memry/desktop dev:b` (same account) → open switcher on B → "In your account" shows Research → download → confirm path dialog → vault opens and pulls.
- [ ] **Step 8.5: Commit** remaining docs as `docs: account vault directory`.

**Not in scope (per spec):** WebSocket push, per-vault opt-out, PATCH rename route (no local rename feature), remote vault deletion.

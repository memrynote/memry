# Multi-Vault Linking Picker Implementation Plan (Phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. This builds on Phase 1 (`2026-06-09-multi-device-vault-adoption.md`), already merged on branch `multi-device-vault-adoption`.

**Goal:** When a joining device's account has 2+ vaults, let the user pick a parent folder and check which server vault(s) to pull; each checked vault becomes its own local vault folder (adopting that server vault's `vault_uuid`); the first checked vault opens + syncs immediately, the rest are created + adopted but dormant (switchable later).

**Architecture:** The initiator enumerates the account's vaults via a new `GET /sync/vaults` and sends the full list (uuid + itemCount + createdAt) in the existing encrypted vault-transfer (Phase 1 already carries the optional `itemCount`/`createdAt` fields). The joiner's `completeLinkingQr` branches: `<= 1` vault → Phase 1 auto-adopt; `>= 2` → it stashes the decrypted master key + the vault list in an ephemeral `pendingVaultChoice` (with a TTL + `secureCleanup`) and returns the list to the renderer instead of finalizing. The renderer shows a picker; on confirm it calls a new `finalizeVaultChoice` IPC, which (1) creates each dormant vault from primitives, (2) `selectVault({ path })` the primary, (3) runs the Phase 1 `finalizeLinking` (adopt + register) for the primary. Because the desktop holds ONE open `data.db` at a time and computes the `X-Memry-Vault-Id` header per request from the current vault's `vault_metadata`, dormant vaults sync only once the user switches to them (they reuse the account-wide master key + the already-registered device).

**Tech Stack:** TypeScript, Zod, Hono/D1 (sync-server), Drizzle/better-sqlite3, libsodium, React 19 + Vite (renderer), Electron IPC (legacy `registerCommand` pattern — no RPC codegen for the device domain), i18next, Vitest.

**Security note (must respect):** Between `completeLinkingQr` returning the list and the user confirming the pick, the decrypted **master key is held in main-process memory** (`pendingVaultChoice`). It MUST be `secureCleanup`'d on: successful finalize, cancel, TTL expiry, and any error path — exactly like the existing `pendingLinkCompletion`. Never log it. Never send it to the renderer (the renderer only ever sees opaque `vaultUuid` + counts/dates).

---

## File Structure

**Sync-server**

- `apps/sync-server/src/routes/sync.ts` — add `GET /sync/vaults` handler + route registration (MODIFY).
- `apps/sync-server/src/services/sync.ts` (or wherever `getChanges`/`getManifest` live) — add `listUserVaults(db, userId)` (MODIFY/locate).
- `apps/sync-server/src/routes/sync.test.ts` — handler test (MODIFY).

**Contracts**

- `packages/contracts/src/ipc-devices.ts` — `CompleteLinkingQrResult.vaults?`, new channels `FINALIZE_VAULT_CHOICE` + `PICK_VAULT_FOLDER`, input/output schemas + interfaces (MODIFY).

**Desktop main**

- `apps/desktop/src/main/sync/vault-transfer.ts` — add `buildVaultTransfer(vaults)` (MODIFY).
- `apps/desktop/src/main/sync/linking-service.ts` — initiator enrichment; joiner branch + `pendingVaultChoice`; `finalizeVaultChoice` (MODIFY) + test.
- `apps/desktop/src/main/sync/vault-provisioning.ts` — NEW: `createDormantVault(folderPath, serverVaultUuid)` + `dormantVaultFolderName(uuid)`.
- `apps/desktop/src/main/sync/vault-provisioning.test.ts` — NEW.
- `apps/desktop/src/main/ipc/auth-device-handlers.ts` — register `FINALIZE_VAULT_CHOICE` + `PICK_VAULT_FOLDER` (MODIFY).
- `apps/desktop/src/preload/api/sync-identity.ts` — add the two methods (MODIFY).
- `apps/desktop/src/preload/index.d.ts` — add method signatures to the `syncLinking` interface (MODIFY).

**Desktop renderer**

- `apps/desktop/src/renderer/src/contexts/auth-context.tsx` — add `'linking-vault-picker'` step + `vaults` to `WizardData` (MODIFY).
- `apps/desktop/src/renderer/src/components/sync/linking-pending.tsx` — branch to picker when `result.vaults.length >= 2` (MODIFY).
- `apps/desktop/src/renderer/src/components/sync/vault-picker-step.tsx` — NEW: parent folder + checkbox list + confirm.
- `apps/desktop/src/renderer/src/components/sync/vault-picker-step.test.tsx` — NEW.
- `apps/desktop/src/renderer/src/pages/settings/setup-wizard.tsx` — render the new step (MODIFY).

**i18n**

- `packages/i18n/src/locales/en/settings.json` — strings under `setup.linking` (MODIFY).

---

## Task 1: Server — `GET /sync/vaults` (TDD)

**Files:**

- Modify: `apps/sync-server/src/routes/sync.ts` (handler + register on the `recordSync`/`sync` routers near `:348-358`)
- Modify: the sync service module that holds `getChanges` (add `listUserVaults`)
- Test: `apps/sync-server/src/routes/sync.test.ts`

- [ ] **Step 1: Write the failing test** in `sync.test.ts` (mirror existing handler tests; they bind a mock D1 and an authed context). Assert `GET /sync/vaults` returns vaults grouped from `sync_items` with item counts and `created_at` from `sync_vaults`:

```ts
it('lists the user vaults with item counts and created dates', async () => {
  // Arrange D1 mock so the grouped query returns two vaults
  // (follow the existing prepare().bind().all() mock shape used by other sync.test.ts cases)
  const res = await app.request('/sync/vaults', { headers: authHeaders }, env, executionCtx)
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.vaults).toEqual([
    { vaultUuid: 'v-a', itemCount: 367, createdAt: 1000 },
    { vaultUuid: 'v-b', itemCount: 4, createdAt: 2000 }
  ])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/sync-server test -- sync`
Expected: FAIL — 404 / route not found.

- [ ] **Step 3: Implement.** Add `listUserVaults` to the sync service:

```ts
export interface UserVaultSummary {
  vaultUuid: string
  itemCount: number
  createdAt: number | null
}

export const listUserVaults = async (
  db: D1Database,
  userId: string
): Promise<UserVaultSummary[]> => {
  const { results } = await db
    .prepare(
      `SELECT si.vault_id AS vaultUuid,
              COUNT(*) AS itemCount,
              sv.created_at AS createdAt
       FROM sync_items si
       LEFT JOIN sync_vaults sv ON sv.user_id = si.user_id AND sv.vault_id = si.vault_id
       WHERE si.user_id = ? AND si.deleted_at IS NULL
       GROUP BY si.vault_id
       ORDER BY itemCount DESC`
    )
    .bind(userId)
    .all<{ vaultUuid: string; itemCount: number; createdAt: number | null }>()
  return results.map((r) => ({
    vaultUuid: r.vaultUuid,
    itemCount: Number(r.itemCount),
    createdAt: r.createdAt ?? null
  }))
}
```

Add the handler in `sync.ts` and register it on BOTH the `recordSync` and `sync` routers next to `/status` (rate-limited with the existing `statusRateLimit`, behind the same auth/paid-sync middleware the other read routes use — note `paid-sync` would call `ensureSyncVaultAllowed`; this endpoint must NOT be gated by a single vault, so register it under `authMiddleware` only, like `/storage` if that one skips paid-sync — verify which middleware `/storage` uses and match the "read, not vault-scoped" pattern):

```ts
const handleListVaults = async (c: Context<AppContext>): Promise<Response> => {
  const userId = c.get('userId')!
  const vaults = await listUserVaults(c.env.DB, userId)
  return c.json({ vaults })
}
```

```ts
sync.get('/vaults', statusRateLimit, handleListVaults)
recordSync.get('/vaults', statusRateLimit, handleListVaults)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/sync-server test -- sync`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/sync-server/src/routes/sync.ts apps/sync-server/src/services/*.ts apps/sync-server/src/routes/sync.test.ts
git commit -m "feat(sync): GET /sync/vaults lists account vaults with item counts"
```

---

## Task 2: Client — `buildVaultTransfer` + initiator enrichment

**Files:**

- Modify: `apps/desktop/src/main/sync/vault-transfer.ts`
- Modify: `apps/desktop/src/main/sync/linking-service.ts` (`approveDeviceLinking`)
- Test: `apps/desktop/src/main/sync/vault-transfer.test.ts`

- [ ] **Step 1: Failing test** — add to `vault-transfer.test.ts` that `buildVaultTransfer` maps a server vault list into the transfer payload (version 1, entries carry uuid+itemCount+createdAt):

```ts
it('builds a transfer from a server vault list', () => {
  const t = buildVaultTransfer([
    { vaultUuid: 'v-a', itemCount: 367, createdAt: 1000 },
    { vaultUuid: 'v-b', itemCount: 4, createdAt: 2000 }
  ])
  expect(t).toEqual({
    version: 1,
    vaults: [
      { vaultUuid: 'v-a', itemCount: 367, createdAt: 1000 },
      { vaultUuid: 'v-b', itemCount: 4, createdAt: 2000 }
    ]
  })
})
```

- [ ] **Step 2: Run → fail** (`buildVaultTransfer` not exported).
      Run: `pnpm --filter @memry/desktop test:main -- vault-transfer`

- [ ] **Step 3: Implement.** In `vault-transfer.ts`:

```ts
export interface ServerVaultSummary {
  vaultUuid: string
  itemCount?: number
  createdAt?: number | null
}

export function buildVaultTransfer(vaults: ServerVaultSummary[]): VaultTransfer {
  return {
    version: VAULT_TRANSFER_VERSION,
    vaults: vaults.map((v) => ({
      vaultUuid: v.vaultUuid,
      ...(v.itemCount !== undefined && { itemCount: v.itemCount }),
      ...(v.createdAt != null && { createdAt: v.createdAt })
    }))
  }
}
```

In `linking-service.ts` `approveDeviceLinking`, replace the Phase 1 `collectVaultTransfer(getDatabase())` build with: fetch the account vaults and build from the full list; fall back to the current-vault-only transfer if the call fails or returns empty:

```ts
let transfer
try {
  const { vaults } = await getFromServer<{ vaults: ServerVaultSummary[] }>(
    '/sync/vaults',
    accessToken
  )
  transfer = vaults.length > 0 ? buildVaultTransfer(vaults) : collectVaultTransfer(getDatabase())
} catch (err) {
  log.warn('Could not enumerate account vaults; falling back to current vault', {
    error: err instanceof Error ? err.message : 'unknown'
  })
  transfer = collectVaultTransfer(getDatabase())
}
const vaultTransfer = encryptVaultTransfer({ transfer, sessionId, encKey, macKey })
```

(Update the import to add `buildVaultTransfer, type ServerVaultSummary` and keep `collectVaultTransfer`/`encryptVaultTransfer`.)

- [ ] **Step 4: Run → pass.** `pnpm --filter @memry/desktop test:main -- vault-transfer` and `typecheck:node`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/sync/vault-transfer.ts apps/desktop/src/main/sync/vault-transfer.test.ts apps/desktop/src/main/sync/linking-service.ts
git commit -m "feat(linking): initiator enumerates + transfers full account vault list"
```

---

## Task 3: Main — dormant vault provisioning (TDD)

**Files:**

- Create: `apps/desktop/src/main/sync/vault-provisioning.ts`
- Test: `apps/desktop/src/main/sync/vault-provisioning.test.ts`

`createDormantVault` initializes a vault at `folderPath` (structure + migrations + data.db) WITHOUT making it current or starting its sync runtime, adopts the given server `vault_uuid`, and registers it in the store's vault list. Compose from existing primitives (verify exact import paths against `vault/index.ts` / `vault/init.ts` / `database/client.ts` / `store.ts`): `initVault`, `getDataDbPath`, `runMigrations`, `initDatabase`, `getDatabase`, `adoptVaultLocally`, `createVaultInfo`, `upsertVault`.

- [ ] **Step 1: Failing test** — `createDormantVault` writes the adopted uuid into that vault's `vault_metadata` and adds it to the store. Use a tmp dir (`fs.mkdtempSync(os.tmpdir())`) for the folder path; mock `store`'s `upsertVault` with `vi.fn()`; after the call, open the dormant data.db and assert `getOrCreateVaultUuid` returns the server uuid.

```ts
it('creates a dormant vault adopting the server uuid without opening it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-dormant-'))
  createDormantVault(dir, 'server-vault-uuid')
  // open the created data.db directly and assert the adopted uuid + store registration
  // (assert upsertVault called with a StoredVaultInfo for `dir`; assert vault_metadata row == 'server-vault-uuid')
})
```

- [ ] **Step 2: Run → fail.** `pnpm --filter @memry/desktop test:main -- vault-provisioning` (run `rebuild:node` first if `ERR_DLOPEN_FAILED`).

- [ ] **Step 3: Implement** in `vault-provisioning.ts`:

```ts
import path from 'path'

import { createLogger } from '../lib/logger'
import { getDatabase, initDatabase, runMigrations } from '../database/client'
import { getDataDbPath, initVault, createVaultInfo } from '../vault'
import { upsertVault } from '../store'
import { adoptVaultLocally } from './vault-adoption'

const logger = createLogger('Sync:VaultProvisioning')

export function dormantVaultFolderName(vaultUuid: string): string {
  return `memry-vault-${vaultUuid.slice(0, 8)}`
}

/**
 * Create a local vault at `folderPath`, adopt `serverVaultUuid` into its
 * vault_metadata, and register it in the store — WITHOUT opening it as the
 * current vault or starting its sync runtime. Used to provision the "dormant"
 * vaults a user chose to pull during multi-vault linking; they sync only once
 * the user switches to them (reusing the account master key + registered device).
 *
 * NOTE: this transiently points the shared data.db singleton at `folderPath`.
 * Callers MUST open the intended primary vault (via selectVault) afterward so
 * the singleton ends on the correct current vault.
 */
export function createDormantVault(folderPath: string, serverVaultUuid: string): void {
  initVault(folderPath)
  const dataDbPath = getDataDbPath(folderPath)
  runMigrations(dataDbPath)
  initDatabase(dataDbPath)
  adoptVaultLocally(getDatabase(), serverVaultUuid)
  upsertVault(createVaultInfo(folderPath))
  logger.info('Provisioned dormant vault', { folderPath, serverVaultUuid })
}
```

(If `getDataDbPath` / `initVault` / `createVaultInfo` are not exported from `../vault`, export them or import from their defining modules — verify and adjust; do not duplicate logic.)

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/sync/vault-provisioning.ts apps/desktop/src/main/sync/vault-provisioning.test.ts
git commit -m "feat(linking): provision dormant vaults adopting a server uuid"
```

---

## Task 4: Main — joiner branch + `pendingVaultChoice` + `finalizeVaultChoice` (TDD)

**Files:**

- Modify: `apps/desktop/src/main/sync/linking-service.ts`
- Test: `apps/desktop/src/main/sync/linking-service.test.ts`

- [ ] **Step 1: Failing tests** in `linking-service.test.ts` (extend the Phase 1 suite; mock `./vault-transfer`, `./vault-adoption`, `./vault-provisioning`, and `../vault`):

```ts
it('returns the vault list and defers finalize when 2+ vaults', async () => {
  // decryptVaultTransfer mock returns two vaults
  mockDecryptVaultTransfer.mockReturnValue({
    version: 1,
    vaults: [
      { vaultUuid: 'v-a', itemCount: 367 },
      { vaultUuid: 'v-b', itemCount: 4 }
    ]
  })
  const res = await completeLinkingQr(SESSION_ID)
  expect(res.success).toBe(true)
  expect(res.vaults).toEqual([
    { vaultUuid: 'v-a', itemCount: 367, createdAt: undefined },
    { vaultUuid: 'v-b', itemCount: 4, createdAt: undefined }
  ])
  expect(mockFinalizeLinkingDeps.persistKeysAndRegisterDevice).not.toHaveBeenCalled()
})

it('finalizeVaultChoice provisions dormant vaults, opens the primary, then registers', async () => {
  // First drive completeLinkingQr with 2 vaults to populate pendingVaultChoice, then:
  await finalizeVaultChoice({
    sessionId: SESSION_ID,
    parentFolderPath: '/tmp/parent',
    selectedVaultUuids: ['v-a', 'v-b'],
    primaryVaultUuid: 'v-a'
  })
  expect(mockCreateDormantVault).toHaveBeenCalledWith(
    expect.stringContaining('v-b'.slice(0, 8)),
    'v-b'
  )
  expect(mockSelectVault).toHaveBeenCalledWith({ path: expect.stringContaining('v-a'.slice(0, 8)) })
  // adopt+register happened for primary (selectVault before persistKeys)
  expect(mockSelectVault.mock.invocationCallOrder[0]).toBeLessThan(
    mockPersistKeysAndRegisterDevice.mock.invocationCallOrder[0]
  )
})
```

- [ ] **Step 2: Run → fail.** `pnpm --filter @memry/desktop test:main -- linking-service`

- [ ] **Step 3: Implement** in `linking-service.ts`:

(a) Ephemeral state + cleanup, next to `pendingLinkCompletion`:

```ts
interface PendingVaultChoice {
  sessionId: string
  masterKey: Uint8Array
  setupToken: string
  importedProviderAuth?: GoogleProviderAuthTransfer
  initialWarning?: string
  vaults: VaultTransfer['vaults']
  expiresAt: number
}

let pendingVaultChoice: PendingVaultChoice | null = null

export const clearPendingVaultChoice = (): void => {
  if (pendingVaultChoice) {
    secureCleanup(pendingVaultChoice.masterKey)
    pendingVaultChoice = null
  }
}
```

(b) In `completeLinkingQr`, replace the Phase 1 `void finalizeLinking(...)` tail with a branch:

```ts
const vaults = adoptedTransfer?.vaults ?? []
if (vaults.length >= 2) {
  pendingVaultChoice = {
    sessionId,
    masterKey,
    setupToken,
    importedProviderAuth,
    initialWarning: importWarning,
    vaults,
    expiresAt: pendingLinkCompletion.expiresAt
  }
  clearPendingLinkCompletion()
  log.info('Multiple vaults available — deferring finalize for user choice', {
    sessionId,
    count: vaults.length
  })
  return {
    success: true,
    vaults: vaults.map((v) => ({
      vaultUuid: v.vaultUuid,
      itemCount: v.itemCount,
      createdAt: v.createdAt
    }))
  }
}

const adoptedVaultUuid = vaults[0]?.vaultUuid
void finalizeLinking(masterKey, setupToken, adoptedVaultUuid, importedProviderAuth, importWarning)
log.info('Linking approved — finalizing device registration in background')
return { success: true }
```

(Capture the decrypted transfer into `adoptedTransfer` where Phase 1 currently sets `adoptedVaultUuid`. Do NOT `secureCleanup(masterKey)` on the defer path — ownership moves to `pendingVaultChoice`.)

(c) New exported `finalizeVaultChoice`:

```ts
export async function finalizeVaultChoice(input: {
  sessionId: string
  parentFolderPath: string
  selectedVaultUuids: string[]
  primaryVaultUuid: string
}): Promise<{ success: boolean; error?: string }> {
  if (!pendingVaultChoice || pendingVaultChoice.sessionId !== input.sessionId) {
    return { success: false, error: 'No pending vault choice for this session' }
  }
  if (isExpired(pendingVaultChoice.expiresAt)) {
    clearPendingVaultChoice()
    return { success: false, error: 'Linking session has expired' }
  }
  if (!input.selectedVaultUuids.includes(input.primaryVaultUuid)) {
    return { success: false, error: 'Primary vault must be among the selected vaults' }
  }

  const { masterKey, setupToken, importedProviderAuth, initialWarning } = pendingVaultChoice
  pendingVaultChoice = null // ownership moves to finalizeLinking; do not double-clean

  try {
    const { createDormantVault, dormantVaultFolderName } = await import('./vault-provisioning')
    const path = await import('path')
    const { selectVault } = await import('../vault')

    const primaryFolder = path.join(
      input.parentFolderPath,
      dormantVaultFolderName(input.primaryVaultUuid)
    )

    for (const uuid of input.selectedVaultUuids) {
      if (uuid === input.primaryVaultUuid) continue
      createDormantVault(path.join(input.parentFolderPath, dormantVaultFolderName(uuid)), uuid)
    }

    const selected = await selectVault({ path: primaryFolder })
    if (!selected.success) {
      throw new Error(selected.error ?? 'Failed to open the primary vault')
    }

    await finalizeLinking(
      masterKey,
      setupToken,
      input.primaryVaultUuid,
      importedProviderAuth,
      initialWarning
    )
    return { success: true }
  } catch (err) {
    log.error('finalizeVaultChoice failed', err)
    secureCleanup(masterKey)
    const message = err instanceof Error ? err.message : 'Vault selection failed'
    emitLinkingFinalized({ error: message })
    return { success: false, error: message }
  }
}
```

(`finalizeLinking` already `secureCleanup`s `masterKey` and emits the finalized event on its own success/failure paths — so on the happy path we hand ownership to it; only the pre-`finalizeLinking` catch cleans up here.)

- [ ] **Step 4: Run → pass.** `pnpm --filter @memry/desktop test:main -- linking-service` + `typecheck:node`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/sync/linking-service.ts apps/desktop/src/main/sync/linking-service.test.ts
git commit -m "feat(linking): defer finalize for 2+ vaults and finalize on user choice"
```

---

## Task 5: IPC contract + handlers + preload (follow `ipc-contract-change` skill — legacy path)

**Files:**

- Modify: `packages/contracts/src/ipc-devices.ts`
- Modify: `apps/desktop/src/main/ipc/auth-device-handlers.ts`
- Modify: `apps/desktop/src/preload/api/sync-identity.ts`
- Modify: `apps/desktop/src/preload/index.d.ts`

- [ ] **Step 1: Contract** — in `ipc-devices.ts` add channels, extend the result, add schemas/interfaces:

```ts
// DEVICE_CHANNELS:
  FINALIZE_VAULT_CHOICE: 'sync:finalize-vault-choice',
  PICK_VAULT_FOLDER: 'sync:pick-vault-folder'
```

```ts
export interface LinkingVaultSummary {
  vaultUuid: string
  itemCount?: number
  createdAt?: number | null
}

// extend CompleteLinkingQrResult:
  vaults?: LinkingVaultSummary[]

export interface FinalizeVaultChoiceInput {
  sessionId: string
  parentFolderPath: string
  selectedVaultUuids: string[]
  primaryVaultUuid: string
}
export interface FinalizeVaultChoiceResult {
  success: boolean
  error?: string
}
export interface PickVaultFolderResult {
  path: string | null
}

export const FinalizeVaultChoiceSchema = z.object({
  sessionId: z.string().min(1),
  parentFolderPath: z.string().min(1),
  selectedVaultUuids: z.array(z.string().min(1)).min(1),
  primaryVaultUuid: z.string().min(1)
})
```

- [ ] **Step 2: Main handlers** — in `auth-device-handlers.ts`, register both (match the file's existing import alias for the channels object — it imports the channel map as `SYNC_CHANNELS`):

```ts
registerCommand(
  SYNC_CHANNELS.FINALIZE_VAULT_CHOICE,
  FinalizeVaultChoiceSchema,
  async (input) => {
    const { finalizeVaultChoice } = await import('../sync/linking-service')
    return finalizeVaultChoice(input)
  },
  'Failed to finalize vault choice'
)

registerCommand(
  SYNC_CHANNELS.PICK_VAULT_FOLDER,
  z.object({}),
  async () => {
    const { pickVaultFolder } = await import('../vault')
    return { path: await pickVaultFolder() }
  },
  'Failed to pick folder'
)
```

Export a thin `pickVaultFolder()` from `apps/desktop/src/main/vault/index.ts` that calls the existing `showFolderPicker()` (it's currently a private function — export it or add `export const pickVaultFolder = () => showFolderPicker()`).

- [ ] **Step 3: Preload** — in `sync-identity.ts` add to the `syncLinking` object:

```ts
  finalizeVaultChoice: (input: FinalizeVaultChoiceInput) =>
    invoke(SYNC_CHANNELS.FINALIZE_VAULT_CHOICE, input),
  pickVaultFolder: () => invoke(SYNC_CHANNELS.PICK_VAULT_FOLDER, {})
```

In `preload/index.d.ts`, add the two method signatures to the `syncLinking` client interface and re-export the new types.

- [ ] **Step 4: Regenerate + verify**

```bash
pnpm ipc:generate
pnpm ipc:check
pnpm typecheck
```

Expected: `ipc:check` green; types resolve.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/ipc-devices.ts apps/desktop/src/main/ipc/auth-device-handlers.ts apps/desktop/src/main/vault/index.ts apps/desktop/src/preload/api/sync-identity.ts apps/desktop/src/preload/index.d.ts apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts apps/desktop/src/preload/generated-rpc.ts
git commit -m "feat(linking): IPC for finalizeVaultChoice + pickVaultFolder"
```

(Only stage generated files that actually changed.)

---

## Task 6: Renderer — wizard step + picker component (TDD where practical)

**Files:**

- Modify: `apps/desktop/src/renderer/src/contexts/auth-context.tsx`
- Modify: `apps/desktop/src/renderer/src/components/sync/linking-pending.tsx`
- Create: `apps/desktop/src/renderer/src/components/sync/vault-picker-step.tsx`
- Test: `apps/desktop/src/renderer/src/components/sync/vault-picker-step.test.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/settings/setup-wizard.tsx`

- [ ] **Step 1: auth-context** — add `'linking-vault-picker'` to the `WizardStep` union (`:24`) and `vaults?: LinkingVaultSummary[]` to `WizardData` (`:35`); thread `vaults` through the `WIZARD_SET_STEP` reducer case like the other optional fields, and expose it on the context state (e.g. `wizardVaults`).

- [ ] **Step 2: linking-pending branch** — in `poll` (`:35`), when `result.success` and `result.vaults && result.vaults.length >= 2`, advance to the picker instead of `onComplete()`:

```ts
if (result.success) {
  if (intervalRef.current) clearInterval(intervalRef.current)
  if (result.vaults && result.vaults.length >= 2) {
    onPickVaults(result.vaults)
    return
  }
  setStatus('completing')
  onComplete()
  return
}
```

Add an `onPickVaults` prop; `setup-wizard.tsx` wires it to `setWizardStep('linking-vault-picker', { vaults })`.

- [ ] **Step 3: Write the failing component test** `vault-picker-step.test.tsx` (mirror an existing sync component test, e.g. the suite that already renders linking components). Stub `window.api.syncLinking.pickVaultFolder` + `finalizeVaultChoice`. Verify: renders one row per vault with item count; "Pull selected" disabled until a folder is chosen AND ≥1 vault checked; on confirm, calls `finalizeVaultChoice` with the chosen `parentFolderPath`, the checked `selectedVaultUuids`, and `primaryVaultUuid` = first checked.

```tsx
it('finalizes with the chosen folder and checked vaults', async () => {
  // pickVaultFolder resolves '/tmp/parent'; render with two vaults; check both; click Pull selected
  expect(window.api.syncLinking.finalizeVaultChoice).toHaveBeenCalledWith({
    sessionId: 'sess-1',
    parentFolderPath: '/tmp/parent',
    selectedVaultUuids: ['v-a', 'v-b'],
    primaryVaultUuid: 'v-a'
  })
})
```

- [ ] **Step 4: Run → fail** (component missing). Run: `pnpm --filter @memry/desktop test:renderer -- vault-picker-step`

- [ ] **Step 5: Implement `vault-picker-step.tsx`** — props `{ sessionId: string; vaults: LinkingVaultSummary[]; onError: (msg: string) => void }`. Use logical Tailwind classes (`ms/me`, `ps/pe`, `text-start`), `useT('settings')` for strings, and `extractErrorMessage`. Two steps: a "choose parent folder" button calling `pickVaultFolder()`, and a checkbox list of vaults (label `t('setup.linking.vaultRow', { count, date })`); "Pull selected" calls `finalizeVaultChoice`. On success, the existing `onLinkingFinalized` listener (auth-context `:306`) drives the transition to authenticated — no extra navigation needed. Order checked uuids by the list order; `primaryVaultUuid` = first checked. Disable the button while submitting (fire from `onPointerDown` per the documented submit-button gotcha if it disables on click).

- [ ] **Step 6: Run → pass.** `pnpm --filter @memry/desktop test:renderer -- vault-picker-step`

- [ ] **Step 7: setup-wizard** — add a `case 'linking-vault-picker'` rendering `<VaultPickerStep sessionId={wizardLinkingSessionId} vaults={wizardVaults} onError={...} />`, and pass `onPickVaults` to `LinkingPending`.

- [ ] **Step 8: i18n** — add to `packages/i18n/src/locales/en/settings.json` under `setup.linking`:

```json
"vaultPickerTitle": "Choose what to pull",
"vaultPickerDescription": "This account has multiple vaults. Pick a folder and the vault(s) to add to this device.",
"vaultPickerFolderLabel": "Store vaults in folder",
"vaultPickerChooseFolder": "Choose folder",
"vaultRow": "Vault — {{count}} items · {{date}}",
"vaultPickerPrimaryHint": "Opens now",
"vaultPickerDormantHint": "Added, opens when you switch to it",
"vaultPickerConfirm": "Pull selected"
```

Run: `pnpm --filter @memry/desktop i18n:check`

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/renderer/src/contexts/auth-context.tsx apps/desktop/src/renderer/src/components/sync/linking-pending.tsx apps/desktop/src/renderer/src/components/sync/vault-picker-step.tsx apps/desktop/src/renderer/src/components/sync/vault-picker-step.test.tsx apps/desktop/src/renderer/src/pages/settings/setup-wizard.tsx packages/i18n/src/locales/en/settings.json
git commit -m "feat(linking): vault picker step for multi-vault linking"
```

---

## Task 7: Full verification gate

- [ ] **Step 1: Run the gate.**

```bash
pnpm typecheck
pnpm lint
pnpm test:sync-server
pnpm --filter @memry/desktop test:main
pnpm --filter @memry/desktop test:renderer
pnpm ipc:generate && pnpm ipc:check
pnpm --filter @memry/desktop i18n:check
git diff --check
```

Expected: all PASS.

- [ ] **Step 2: Manual multi-vault verification (controller-run, document result).**

1. `pnpm dev:sync-server`; on `dev:a` create 2 vaults with notes (vaults V1, V2) so the account has 2+ vaults.
2. `dev:b` fresh → link via QR → after approval the picker should appear listing V1 + V2 with item counts.
3. Pick a parent folder, check both, confirm. Verify the primary opens + pulls its items; the dormant vault appears in the vault switcher and pulls its items once opened.
4. Inspect dev D1: `device_sync_state` shows the b device against the chosen vault(s).

---

## Self-Review

- **Spec coverage:** 2+ vault picker (Task 6) reading the transferred list (Task 2) sourced from `GET /sync/vaults` (Task 1); "create many, sync one" via dormant provisioning (Task 3) + primary open/register (Task 4); folder-first picker (Task 6) reusing the `openDirectory` dialog (Task 5 `pickVaultFolder`); deferred finalize with safe master-key handling (Task 4). `<=1` vault still auto-adopts (Phase 1, untouched branch in Task 4).
- **Placeholder scan:** code provided per step; the few "verify export path / which middleware /storage uses" notes are genuine lookups the implementer must confirm against the live files (signatures were captured but exact export surfaces can drift) — not hand-waves.
- **Type consistency:** `LinkingVaultSummary` (contract) ↔ `ServerVaultSummary` (main) ↔ `UserVaultSummary` (server) all carry `vaultUuid`/`itemCount`/`createdAt`; `FinalizeVaultChoiceInput` fields match `finalizeVaultChoice` param and the renderer call; `dormantVaultFolderName` used consistently in Task 3/4.
- **Security:** master key held in `pendingVaultChoice` with TTL + `secureCleanup` on every exit path; never sent to renderer or logged.
- **Conventions:** legacy IPC path per `ipc-contract-change`; logical Tailwind + `useT` + `extractErrorMessage` in the renderer; `createLogger` in main; submit-button `onPointerDown` gotcha noted.

## Open risk to flag to the human before merge

The desktop sync runtime is single-vault-at-a-time; dormant vaults only sync when the user switches to them. Confirm the vault switcher path (`selectVault`) cleanly starts sync for a dormant vault that already has an adopted `vault_metadata` + shared master key (expected: yes — header is per-request and the device is registered — but this is the least-tested path and should be exercised in the Task 7 manual step).

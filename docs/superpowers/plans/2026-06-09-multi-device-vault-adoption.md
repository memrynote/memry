# Multi-Device Vault Adoption & Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any signed-in device discover, pull, and switch between the user's vaults — vaults created on device A become pullable on device B from both onboarding and Settings → Vault.

**Architecture:** The vault _entity_ stays a server-derived list (`GET /sync/vaults`), not a synced object. The local registry learns each vault's `vaultUuid` so local↔remote can be deduped. Two new main primitives — `listRemoteVaults()` and `pullRemoteVault(uuid, parentFolder)` — back two new IPC channels (`vault:list-remote`, `vault:pull-remote`). A renderer hook `useVaultDirectory()` merges local + remote into 4 row states consumed by reworked Settings and onboarding UIs. Scenario 3 (QR adoption) already shipped on `main`; we extract its dormant-create+open into the shared `pullRemoteVault` primitive.

**Tech Stack:** Electron (main/renderer/preload), React 19, Zod contracts (`packages/contracts`), better-sqlite3 + Drizzle, electron-store, Vitest, Playwright (two-profile E2E).

---

## File Structure

**Modify:**

- `packages/contracts/src/ipc-channels.ts` — add `LIST_REMOTE`, `PULL_REMOTE` to `VaultChannels.invoke`.
- `packages/contracts/src/vault-api.ts` — `vaultUuid?` on `VaultInfo`; `RemoteVaultSummary` type; `PullRemoteVaultSchema`; handler + client signatures.
- `apps/desktop/src/main/store.ts` — `vaultUuid?` on `StoredVaultInfo`; `createVaultInfo` preserves uuid.
- `apps/desktop/src/main/vault/index.ts` — `toVaultInfo` passthrough; `backfillVaultUuid` helper wired into `openVault` + `selectVault`.
- `apps/desktop/src/main/sync/linking-service.ts` — `finalizeVaultChoice` uses `pullRemoteVault` for the primary.
- `apps/desktop/src/main/ipc/vault-handlers.ts` — register the two new channels.
- `apps/desktop/src/preload/api/vault.ts` — `listRemote`, `pullRemote`.
- `apps/desktop/src/preload/index.d.ts` — `vaultUuid?` on `VaultInfo`; `RemoteVaultSummary`; client method types.
- `apps/desktop/src/renderer/src/pages/settings/vault-section.tsx` — list rework.
- `apps/desktop/src/renderer/src/components/vault-onboarding.tsx` — open-existing dialog.

**Create:**

- `apps/desktop/src/main/sync/remote-vaults.ts` — `listRemoteVaults()` + `pullRemoteVault()`.
- `apps/desktop/src/main/sync/remote-vaults.test.ts`
- `apps/desktop/src/renderer/src/hooks/use-vault-directory.ts` — merge/dedupe hook.
- `apps/desktop/src/renderer/src/hooks/use-vault-directory.test.tsx`
- `apps/desktop/src/renderer/src/components/vault-select-dialog.tsx` — shared onboarding/settings selection dialog.
- `apps/desktop/tests/e2e/multi-device-vault-adoption.e2e.ts`

**Key facts (verified):**

- Store: `apps/desktop/src/main/store.ts` — `StoredVaultInfo` L12-19, `getVaults` L161, `upsertVault` L168, `findVault` L195, `createVaultInfo` L144-157.
- `toVaultInfo` at `apps/desktop/src/main/vault/index.ts:130-139`; `openVault` ends ~L325 (after `startSyncRuntime()` L315); `selectVault` L330-363.
- UUID read helper: `getOrCreateVaultUuid(db)` at `apps/desktop/src/main/agent/storage/vault-id.ts:9` (reads `vault_metadata` singleton, idempotent).
- Remote list call: `getFromServer<{ vaults: ServerVaultSummary[] }>('/sync/vaults', token)` (see `linking-service.ts:693`). Token via `getValidAccessToken()` from `apps/desktop/src/main/sync/token-manager.ts` (returns `null` when signed out).
- Server `listUserVaults` returns `{ vaultUuid, itemCount, createdAt: number | null }` (`apps/sync-server/src/services/sync.ts:618`); route `GET /sync/vaults`.
- Dormant primitive: `createDormantVault(folderPath, uuid)` + `dormantVaultFolderName(uuid)` in `apps/desktop/src/main/sync/vault-provisioning.ts`.
- `finalizeVaultChoice` create-loop + open at `linking-service.ts:577-596`.
- Renderer IPC via `window.api.vault.*` (preload `vaultApi`); folder picker already exposed as `window.api.syncLinking.pickVaultFolder()` (`apps/desktop/src/preload/api/sync-identity.ts`).
- Existing tests to mirror: `store.test.ts`, `sync/vault-provisioning.test.ts`, `ipc/vault-handlers.test.ts`, `hooks/use-vault.test.tsx`; E2E two-device fixtures `tests/e2e/fixtures/sync-auth-fixtures.ts` (`bootstrappedSyncPair`).

---

## Task 1: Contracts — vaultUuid, RemoteVaultSummary, two channels

**Files:**

- Modify: `packages/contracts/src/ipc-channels.ts`
- Modify: `packages/contracts/src/vault-api.ts`

> Use the `ipc-contract-change` skill for this task. After editing run `pnpm ipc:generate` then `pnpm ipc:check`.

- [ ] **Step 1: Add channels.** In `ipc-channels.ts` `VaultChannels.invoke`, after `REVEAL: 'vault:reveal'` add:

```ts
    REVEAL: 'vault:reveal',
    LIST_REMOTE: 'vault:list-remote',
    PULL_REMOTE: 'vault:pull-remote'
```

- [ ] **Step 2: Extend types in `vault-api.ts`.** Add `vaultUuid?` to `VaultInfo`:

```ts
export interface VaultInfo {
  path: string
  name: string
  noteCount: number
  taskCount: number
  lastOpened: string
  isDefault: boolean
  vaultUuid?: string
}
```

After `VaultConfig`, add the remote summary type and pull schema:

```ts
export interface RemoteVaultSummary {
  vaultUuid: string
  itemCount: number
  createdAt: number | null
}

export const PullRemoteVaultSchema = z.object({
  vaultUuid: z.string().min(1),
  parentFolderPath: z.string().min(1)
})
```

- [ ] **Step 3: Add handler + client signatures.** In `VaultHandlers` after `REVEAL`:

```ts
  [VaultChannels.invoke.LIST_REMOTE]: () => Promise<RemoteVaultSummary[]>

  [VaultChannels.invoke.PULL_REMOTE]: (
    input: z.infer<typeof PullRemoteVaultSchema>
  ) => Promise<SelectVaultResponse>
```

In `VaultClientAPI` after `reveal()`:

```ts
  listRemote(): Promise<RemoteVaultSummary[]>
  pullRemote(vaultUuid: string, parentFolderPath: string): Promise<SelectVaultResponse>
```

- [ ] **Step 4: Mirror preload types.** In `apps/desktop/src/preload/index.d.ts`: add `vaultUuid?: string` to its `VaultInfo` (L56), add `RemoteVaultSummary` interface, and add `listRemote`/`pullRemote` to the vault client type (match `VaultClientAPI`).

- [ ] **Step 5: Regenerate + verify.**

Run: `pnpm ipc:generate && pnpm ipc:check && pnpm --filter @memry/contracts typecheck`
Expected: ipc map regenerated, `ipc:check` passes, contracts typecheck clean.

- [ ] **Step 6: Commit.**

```bash
git add packages/contracts apps/desktop/src/preload/index.d.ts apps/desktop/src/main/ipc/generated 2>/dev/null; git commit -m "feat(vault): contracts for listRemote + pullRemote + vaultUuid"
```

---

## Task 2: Local registry learns vaultUuid (store)

**Files:**

- Modify: `apps/desktop/src/main/store.ts:12-19,144-157`
- Test: `apps/desktop/src/main/store.test.ts`

- [ ] **Step 1: Failing test.** Add to `store.test.ts` (mirror existing `createVaultInfo` setup — temp dir vault):

```ts
it('createVaultInfo preserves an existing vaultUuid', () => {
  const dir = makeTempVault() // reuse the helper used by other createVaultInfo tests
  upsertVault({ ...createVaultInfo(dir), vaultUuid: 'uuid-123' })
  const info = createVaultInfo(dir)
  expect(info.vaultUuid).toBe('uuid-123')
})
```

- [ ] **Step 2: Run — fails** (`vaultUuid` not on type / undefined).

Run: `pnpm --filter @memry/desktop test:main -- store.test`
Expected: FAIL.

- [ ] **Step 3: Implement.** `StoredVaultInfo` (L12): add `vaultUuid?: string`. In `createVaultInfo` (L144) return object add:

```ts
    isDefault: existingVault?.isDefault ?? getVaults().length === 0,
    vaultUuid: existingVault?.vaultUuid
```

- [ ] **Step 4: Run — passes.**

Run: `pnpm --filter @memry/desktop test:main -- store.test`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/main/store.ts apps/desktop/src/main/store.test.ts && git commit -m "feat(vault): store vaultUuid on the local registry"
```

---

## Task 3: Backfill vaultUuid on open (vault/index)

**Files:**

- Modify: `apps/desktop/src/main/vault/index.ts:130-139,315-325,330-363`
- Test: `apps/desktop/src/main/vault/index.test.ts` (create if absent; otherwise add to existing)

- [ ] **Step 1: Implement `toVaultInfo` passthrough.** In `toVaultInfo` (L130) return object, add `vaultUuid: stored.vaultUuid`.

- [ ] **Step 2: Add `backfillVaultUuid` helper** (export for testing) near `getAllVaults`:

```ts
import { getOrCreateVaultUuid } from '../agent/storage/vault-id'
import { getDatabase } from '../database/client'

/**
 * Record the open vault's uuid into its registry entry. Idempotent; safe to
 * call after the data.db is initialized (uuid already minted by the sync
 * runtime / metadata singleton).
 */
export function backfillVaultUuid(vaultPath: string): void {
  const existing = findVault(vaultPath)
  if (!existing || existing.vaultUuid) return
  try {
    const uuid = getOrCreateVaultUuid(getDatabase())
    upsertVault({ ...existing, vaultUuid: uuid })
  } catch (error) {
    logger.warn('Failed to backfill vault uuid', error)
  }
}
```

(Ensure `findVault` is imported from `../store`.)

- [ ] **Step 3: Wire into `openVault`.** Immediately after `await startSyncRuntime()` (L315), add `backfillVaultUuid(vaultPath)`. Wire into `selectVault`: after `touchVault(vaultPath)` (L355) add `backfillVaultUuid(vaultPath)` (covers a freshly created vault whose registry row didn't exist at openVault time).

- [ ] **Step 4: Failing test.** Add `apps/desktop/src/main/vault/index.test.ts` (mirror `vault-provisioning.test.ts` db setup — init a vault dir, run migrations, init db, adopt a uuid via `adoptVaultLocally`, upsert a registry row, then call `backfillVaultUuid`):

```ts
it('backfillVaultUuid stamps the open vault uuid onto its registry row', () => {
  const dir = initTestVault()
  adoptVaultLocally(getDatabase(), 'uuid-abc')
  upsertVault(createVaultInfo(dir))
  backfillVaultUuid(dir)
  expect(findVault(dir)?.vaultUuid).toBe('uuid-abc')
})
```

- [ ] **Step 5: Run — fails then implement satisfied → passes.**

Run: `pnpm --filter @memry/desktop test:main -- vault/index.test`
Expected: PASS after Steps 1-3.

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src/main/vault/index.ts apps/desktop/src/main/vault/index.test.ts && git commit -m "feat(vault): backfill vaultUuid into registry on open"
```

---

## Task 4: `listRemoteVaults` + `pullRemoteVault` primitives

**Files:**

- Create: `apps/desktop/src/main/sync/remote-vaults.ts`
- Create: `apps/desktop/src/main/sync/remote-vaults.test.ts`
- Modify: `apps/desktop/src/main/sync/linking-service.ts:577-596`

- [ ] **Step 1: Create `remote-vaults.ts`.**

```ts
import { join } from 'path'
import type { RemoteVaultSummary, SelectVaultResponse } from '@memry/contracts/vault-api'
import { createLogger } from '../lib/logger'
import { getVaults } from '../store'
import { selectVault } from '../vault'
import { getFromServer } from './http-client'
import { getValidAccessToken } from './token-manager'
import { createDormantVault, dormantVaultFolderName } from './vault-provisioning'

const logger = createLogger('Sync:RemoteVaults')

/** List the signed-in account's vaults. Returns [] when signed out or on error. */
export async function listRemoteVaults(): Promise<RemoteVaultSummary[]> {
  const token = await getValidAccessToken()
  if (!token) return []
  try {
    const { vaults } = await getFromServer<{ vaults: RemoteVaultSummary[] }>('/sync/vaults', token)
    return vaults
  } catch (error) {
    logger.warn('Failed to list remote vaults', error)
    return []
  }
}

/**
 * Pull a remote vault into a new local folder and open it. If the uuid is
 * already pulled locally, switch to the existing vault instead of re-pulling.
 */
export async function pullRemoteVault(
  vaultUuid: string,
  parentFolderPath: string
): Promise<SelectVaultResponse> {
  const existing = getVaults().find((v) => v.vaultUuid === vaultUuid)
  if (existing) {
    return selectVault({ path: existing.path })
  }
  const folder = join(parentFolderPath, dormantVaultFolderName(vaultUuid))
  createDormantVault(folder, vaultUuid)
  return selectVault({ path: folder })
}
```

- [ ] **Step 2: Failing test `remote-vaults.test.ts`** (mock `token-manager`, `http-client`, `vault`, `vault-provisioning`, `store`). Cover: signed-out → `[]`; network error → `[]`; happy list; pull dedupe → `switchVault`/`selectVault` existing; pull new → `createDormantVault` + `selectVault` new folder.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./token-manager', () => ({ getValidAccessToken: vi.fn() }))
vi.mock('./http-client', () => ({ getFromServer: vi.fn() }))
vi.mock('../vault', () => ({ selectVault: vi.fn() }))
vi.mock('../store', () => ({ getVaults: vi.fn() }))
vi.mock('./vault-provisioning', () => ({
  createDormantVault: vi.fn(),
  dormantVaultFolderName: (u: string) => `memry-vault-${u.slice(0, 8)}`
}))

import { getValidAccessToken } from './token-manager'
import { getFromServer } from './http-client'
import { selectVault } from '../vault'
import { getVaults } from '../store'
import { createDormantVault } from './vault-provisioning'
import { listRemoteVaults, pullRemoteVault } from './remote-vaults'

beforeEach(() => vi.clearAllMocks())

describe('listRemoteVaults', () => {
  it('returns [] when signed out', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue(null)
    expect(await listRemoteVaults()).toEqual([])
    expect(getFromServer).not.toHaveBeenCalled()
  })
  it('returns [] on network error', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('t')
    vi.mocked(getFromServer).mockRejectedValue(new Error('net'))
    expect(await listRemoteVaults()).toEqual([])
  })
  it('returns the server vault list', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('t')
    vi.mocked(getFromServer).mockResolvedValue({
      vaults: [{ vaultUuid: 'a', itemCount: 3, createdAt: 1 }]
    })
    expect(await listRemoteVaults()).toEqual([{ vaultUuid: 'a', itemCount: 3, createdAt: 1 }])
  })
})

describe('pullRemoteVault', () => {
  it('switches to an already-pulled vault instead of re-pulling', async () => {
    vi.mocked(getVaults).mockReturnValue([{ path: '/v/a', vaultUuid: 'a' } as never])
    vi.mocked(selectVault).mockResolvedValue({ success: true, vault: null })
    await pullRemoteVault('a', '/parent')
    expect(createDormantVault).not.toHaveBeenCalled()
    expect(selectVault).toHaveBeenCalledWith({ path: '/v/a' })
  })
  it('creates a dormant vault then opens it when not pulled', async () => {
    vi.mocked(getVaults).mockReturnValue([])
    vi.mocked(selectVault).mockResolvedValue({ success: true, vault: null })
    await pullRemoteVault('abcd1234ef', '/parent')
    expect(createDormantVault).toHaveBeenCalledWith('/parent/memry-vault-abcd1234', 'abcd1234ef')
    expect(selectVault).toHaveBeenCalledWith({ path: '/parent/memry-vault-abcd1234' })
  })
})
```

- [ ] **Step 3: Run — passes.** Run: `pnpm --filter @memry/desktop test:main -- remote-vaults.test`. Expected: PASS.

- [ ] **Step 4: Refactor `finalizeVaultChoice` (DRY).** Replace L577-596 create-loop + primary open so the primary goes through `pullRemoteVault`:

```ts
const { createDormantVault, dormantVaultFolderName } = await import('./vault-provisioning')
const { pullRemoteVault } = await import('./remote-vaults')
const path = await import('path')

// Non-primary dormant vaults first (each transiently repoints the singleton).
for (const uuid of input.selectedVaultUuids) {
  if (uuid === input.primaryVaultUuid) continue
  createDormantVault(path.join(input.parentFolderPath, dormantVaultFolderName(uuid)), uuid)
}

const selected = await pullRemoteVault(input.primaryVaultUuid, input.parentFolderPath)
if (!selected.success) {
  throw new Error(selected.error ?? 'Failed to open the primary vault')
}
```

- [ ] **Step 5: Verify linking tests still pass.** Run: `pnpm --filter @memry/desktop test:main -- linking-service.test`. Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src/main/sync/remote-vaults.ts apps/desktop/src/main/sync/remote-vaults.test.ts apps/desktop/src/main/sync/linking-service.ts && git commit -m "feat(vault): listRemoteVaults + pullRemoteVault primitives, finalize reuse"
```

---

## Task 5: IPC handlers + preload wiring

**Files:**

- Modify: `apps/desktop/src/main/ipc/vault-handlers.ts`
- Modify: `apps/desktop/src/preload/api/vault.ts`
- Test: `apps/desktop/src/main/ipc/vault-handlers.test.ts`

- [ ] **Step 1: Register handlers.** In `registerVaultHandlers`, import `{ listRemoteVaults, pullRemoteVault }` from `'../sync/remote-vaults'` and `{ PullRemoteVaultSchema }` from contracts, then add:

```ts
ipcMain.handle(
  VaultChannels.invoke.LIST_REMOTE,
  createHandler(() => listRemoteVaults())
)
ipcMain.handle(
  VaultChannels.invoke.PULL_REMOTE,
  createValidatedHandler(PullRemoteVaultSchema, (input) =>
    pullRemoteVault(input.vaultUuid, input.parentFolderPath)
  )
)
```

- [ ] **Step 2: Preload.** In `vaultApi` add:

```ts
  reveal: () => invoke(VaultChannels.invoke.REVEAL),
  listRemote: () => invoke(VaultChannels.invoke.LIST_REMOTE),
  pullRemote: (vaultUuid: string, parentFolderPath: string) =>
    invoke(VaultChannels.invoke.PULL_REMOTE, { vaultUuid, parentFolderPath })
```

- [ ] **Step 3: Handler test.** Add to `vault-handlers.test.ts` (mirror existing handler-registration assertions): assert `LIST_REMOTE` and `PULL_REMOTE` are registered and delegate to the mocked primitives.

- [ ] **Step 4: Verify.**

Run: `pnpm ipc:generate && pnpm ipc:check && pnpm --filter @memry/desktop test:main -- vault-handlers.test && pnpm --filter @memry/desktop typecheck:node`
Expected: all PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/main/ipc/vault-handlers.ts apps/desktop/src/preload apps/desktop/src/main/ipc/generated 2>/dev/null && git commit -m "feat(vault): IPC + preload for listRemote/pullRemote"
```

---

## Task 6: `useVaultDirectory` merge hook

**Files:**

- Create: `apps/desktop/src/renderer/src/hooks/use-vault-directory.ts`
- Create: `apps/desktop/src/renderer/src/hooks/use-vault-directory.test.tsx`

Row model:

```ts
export type VaultRowState = 'active' | 'synced' | 'local-only' | 'not-pulled'

export interface VaultDirectoryRow {
  state: VaultRowState
  vaultUuid?: string
  path?: string
  name: string
  itemCount?: number
  createdAt?: number | null
}
```

- [ ] **Step 1: Failing test.** Mock `window.api.vault.getAll` + `listRemote`. Assert merge → 4 states:

```tsx
// local A is current → active; local B has uuid present remotely → synced;
// local C has no uuid → local-only; remote D not local → not-pulled.
```

Cases: active (path === currentVault), synced (local uuid ∈ remote), local-only (no uuid or uuid ∉ remote), not-pulled (remote uuid with no local match, `name` = `Vault · {itemCount} items · {date}`). Also: signed-out (`listRemote` → `[]`) yields no not-pulled rows; dedupe (remote uuid that matches a local vault does NOT produce a duplicate not-pulled row).

- [ ] **Step 2: Implement hook.**

```ts
import { useCallback, useEffect, useState } from 'react'

function notPulledLabel(itemCount: number, createdAt: number | null): string {
  const date = createdAt ? new Date(createdAt).toLocaleDateString() : 'unknown'
  return `Vault · ${itemCount} items · ${date}`
}

export function useVaultDirectory() {
  const [rows, setRows] = useState<VaultDirectoryRow[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const [local, remote] = await Promise.all([
      window.api.vault.getAll(),
      window.api.vault.listRemote().catch(() => [])
    ])
    const remoteByUuid = new Map(remote.map((r) => [r.vaultUuid, r]))
    const localUuids = new Set(local.vaults.map((v) => v.vaultUuid).filter(Boolean) as string[])

    const localRows: VaultDirectoryRow[] = local.vaults.map((v) => {
      const isCurrent = v.path === local.currentVault
      const state: VaultRowState = isCurrent
        ? 'active'
        : v.vaultUuid && remoteByUuid.has(v.vaultUuid)
          ? 'synced'
          : 'local-only'
      return { state, vaultUuid: v.vaultUuid, path: v.path, name: v.name }
    })

    const notPulled: VaultDirectoryRow[] = remote
      .filter((r) => !localUuids.has(r.vaultUuid))
      .map((r) => ({
        state: 'not-pulled',
        vaultUuid: r.vaultUuid,
        name: notPulledLabel(r.itemCount, r.createdAt),
        itemCount: r.itemCount,
        createdAt: r.createdAt
      }))

    setRows([...localRows, ...notPulled])
  }, [])

  useEffect(() => {
    void refresh().finally(() => setLoading(false))
  }, [refresh])

  return { rows, loading, refresh }
}
```

- [ ] **Step 3: Run — passes.** Run: `pnpm --filter @memry/desktop test:renderer -- use-vault-directory`. Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add apps/desktop/src/renderer/src/hooks/use-vault-directory.ts apps/desktop/src/renderer/src/hooks/use-vault-directory.test.tsx && git commit -m "feat(vault): useVaultDirectory merge/dedupe hook"
```

---

## Task 7: Settings → Vault rework

**Files:**

- Modify: `apps/desktop/src/renderer/src/pages/settings/vault-section.tsx`
- Test: `apps/desktop/src/renderer/src/pages/settings/vault-section.test.tsx` (create)

Behavior: render a vault list from `useVaultDirectory()`. Each row: name/label + state badge. Row menu — **Switch** (`window.api.vault.switch(path)`), **Reveal** (`window.api.vault.reveal()`), **Remove** (`window.api.vault.remove(path)`); **Pull…** for `not-pulled` (`window.api.syncLinking.pickVaultFolder()` → if `path` chosen, `window.api.vault.pullRemote(uuid, path)` → `refresh()`). Keep the existing storage breakdown below the list. Add i18n keys under `settings` `vault.*` for new strings (states, actions); run `i18n:check`.

- [ ] **Step 1: Failing test** — render with mocked `useVaultDirectory` returning all 4 row states; assert each renders with its badge, the active row has no Switch, a not-pulled row exposes Pull.
- [ ] **Step 2: Implement** the list + per-row menu; pull flow guards a cancelled folder pick (`path === null` → no-op).
- [ ] **Step 3: Run — passes.** `pnpm --filter @memry/desktop test:renderer -- vault-section && pnpm --filter @memry/desktop i18n:check`.
- [ ] **Step 4: Commit.** `git commit -m "feat(vault): settings vault list with switch/pull/remove"`.

---

## Task 8: Onboarding "Open existing vault" dialog

**Files:**

- Create: `apps/desktop/src/renderer/src/components/vault-select-dialog.tsx`
- Modify: `apps/desktop/src/renderer/src/components/vault-onboarding.tsx`
- Test: `apps/desktop/src/renderer/src/components/vault-select-dialog.test.tsx`

Behavior: the **Open existing vault** `ActionRow` opens `VaultSelectDialog` (the **Create new vault** row keeps today's folder picker). Dialog lists local known vaults + not-pulled remote (from `useVaultDirectory`) + a **Browse for folder…** fallback. Select local → `switchVault(path)`. Select remote → `syncLinking.pickVaultFolder()` → `vault.pullRemote(uuid, path)`. Browse → `selectVault()` (native picker). Signed out (no not-pulled rows) → local + browse only. Add i18n keys under `common` `phaseF.componentsVaultOnboarding.*`; run `i18n:check`.

- [ ] **Step 1: Failing test** — render dialog with mocked directory: local + not-pulled rows + browse button present; signed-out variant shows no remote section; selecting a not-pulled row triggers pickVaultFolder→pullRemote.
- [ ] **Step 2: Implement** `VaultSelectDialog` + wire the onboarding row to open it (replace its `onClick={onPick}` with dialog-open).
- [ ] **Step 3: Run — passes.** `pnpm --filter @memry/desktop test:renderer -- vault-select-dialog && pnpm --filter @memry/desktop i18n:check`.
- [ ] **Step 4: Commit.** `git commit -m "feat(vault): onboarding open-existing vault selection dialog"`.

---

## Task 9: E2E — profiles A/B, all scenarios

**Files:**

- Create: `apps/desktop/tests/e2e/multi-device-vault-adoption.e2e.ts`

Use the authenticated two-device harness (`tests/e2e/fixtures/sync-auth-fixtures.ts`, `bootstrappedSyncPair`) so A and B share an account. Build it up case by case; each `test` asserts a single observable outcome. If a step needs a harness helper that doesn't exist (e.g. programmatic create-and-push of a second vault, or a UI hook id), add the minimal helper under `tests/e2e/utils/` and a `data-testid` in the component rather than loosening the assertion. **Do not** weaken assertions to make a flaky case "pass" — see CLAUDE.md "Do not check off phase/checklist work unless the exact verification evidence is green."

Cases to cover (one test each):

- [ ] **C1 — Seed remote (scenario 1):** A (signed in) creates a vault, adds a note, and the vault pushes; `GET /sync/vaults` (or the Settings list on A) shows it as `synced`.
- [ ] **C2 — Two vaults seed:** A creates a 2nd vault, opens it (pushes); both appear remotely.
- [ ] **C3 — Onboarding lists remote (scenario 2):** B (signed in, no local vault for these uuids) opens the onboarding "Open existing vault" dialog → sees 2 not-pulled rows labelled `Vault · N items · {date}`.
- [ ] **C4 — Pull from onboarding:** B pulls vault #1 → it opens, syncs, and A's note content appears in B's vault.
- [ ] **C5 — Switch between vaults:** B (now with one local vault) switches between its local vault and back; active badge tracks the open vault.
- [ ] **C6 — Pull second from Settings (scenario, G1):** B pulls vault #2 from Settings → Vault → it opens and syncs.
- [ ] **C7 — Dedupe guard:** Pulling an already-pulled uuid switches to the existing local vault (no duplicate folder); assert no second `memry-vault-*` dir for that uuid.
- [ ] **C8 — Signed-out onboarding:** with B signed out, the dialog shows local + browse only, no remote section, no crash.

- [ ] **Step 1:** Scaffold the spec importing the auth fixture; implement C1 first; run `pnpm --filter @memry/desktop exec electron-vite build` then `pnpm test:e2e -- multi-device-vault-adoption`.
- [ ] **Step 2:** Implement C2–C8 incrementally, rebuilding `out/` before each e2e run (see CLAUDE.md "Memry E2E stale build").
- [ ] **Step 3: Full suite green.** Run: `pnpm test:e2e -- multi-device-vault-adoption`. Expected: all cases PASS (capture output).
- [ ] **Step 4: Commit.** `git commit -m "test(vault): e2e multi-device vault adoption A/B coverage"`.

---

## Final verification

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test` (desktop + sync-server)
- [ ] `pnpm test:e2e -- multi-device-vault-adoption`
- [ ] `pnpm ipc:check`
- [ ] `git diff --check`
- [ ] Docs gate: `pnpm docs:impact --base origin/main --strict` (update `apps/docs/src` or `pnpm docs:ai-update --base origin/main` if `missing-docs`), then `pnpm docs:build`.

## Self-review notes (spec coverage)

- G1 Settings rework → Task 7. G2 onboarding dialog → Task 8. G3 vaultUuid registry → Tasks 2-3. G4 standalone pull primitive → Task 4.
- Locked decisions: only-open-vault-syncs (unchanged runtime), uuid+count+date label (Task 6 `notPulledLabel`), onboarding+settings entry points (Tasks 7-8), derived list not synced object (Task 4 `listRemoteVaults`, no CRDT).
- Error handling: signed-out/network → `[]` (Task 4 + hook), empty-dir validation reuses `validateVaultPath` inside `selectVault`, dedupe guard (Task 4 `pullRemoteVault`, Task 6 dedupe, C7), switch mid-sync uses existing `closeVault` drain.
- Scenario 3 (QR) not rebuilt; only the shared primitive extracted (Task 4 Step 4).

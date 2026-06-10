# Free-Plan Sync Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a free/unpaid user's sign-in from triggering a `402` sync crash by gating sync on entitlement (cache-first), and start the sync runtime when a user becomes paid.

**Architecture:** Add a pure entitlement-cache module backed by the existing `store`. Gate `startSyncRuntime()` on a cache-first entitlement check (known-unpaid → no server call). Make the existing reconcile + manual-refresh paths _start_ the runtime (not just full-sync a running one) on activation. Surface a new `local_only` sync status. Import cycles are avoided by keeping the cache module pure and using a dynamic import inside the gate.

**Tech Stack:** Electron main (TypeScript), Vitest, the existing `@memry/contracts` IPC types, the existing `apps/desktop/src/main/billing/paddle-billing.ts` flow.

**Spec:** `docs/superpowers/specs/2026-06-11-free-plan-sync-gating-design.md`

---

## File Structure

- **Create** `apps/desktop/src/main/billing/entitlement-cache.ts` — pure cache (store-backed) + `isPaidBillingStatus`. Imports only `store` + type-only `BillingStatus`. No runtime billing/runtime deps.
- **Create** `apps/desktop/src/main/billing/entitlement-cache.test.ts`
- **Modify** `apps/desktop/src/main/store.ts` — add `CachedEntitlement` type + `entitlement?` on `SyncStoreData`.
- **Modify** `packages/contracts/src/ipc-sync-ops.ts` — add `'local_only'` to `SyncStatusValue`.
- **Modify** `apps/desktop/src/main/billing/paddle-billing.ts` — `resolveEntitlementForSyncStart()`; cache on fetch; reconcile starts runtime.
- **Modify** `apps/desktop/src/main/sync/runtime.ts` — the gate + `emitLocalOnly()`.
- **Modify** `apps/desktop/src/main/sync/runtime.test.ts` — mock `paddle-billing`; gate tests.
- **Modify** `apps/desktop/src/main/ipc/sync-core-handlers.ts` — `TRIGGER_SYNC` starts runtime; `GET_STATUS` returns `local_only`.
- **Modify** `apps/desktop/src/main/ipc/sync-core-handlers.test.ts` — handler tests.

> **Native modules note:** these are mocked unit tests (no real `better-sqlite3`). If any run errors with `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION`, run `pnpm --filter @memry/desktop rebuild:node` once, then re-run.

---

### Task 1: Add `local_only` to `SyncStatusValue`

**Files:**

- Modify: `packages/contracts/src/ipc-sync-ops.ts:26`

- [ ] **Step 1: Edit the union**

In `packages/contracts/src/ipc-sync-ops.ts`, change line 26 from:

```ts
export type SyncStatusValue = 'idle' | 'syncing' | 'offline' | 'error'
```

to:

```ts
export type SyncStatusValue = 'idle' | 'syncing' | 'offline' | 'error' | 'local_only'
```

- [ ] **Step 2: Typecheck the contracts package**

Run: `pnpm --filter @memry/contracts typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add packages/contracts/src/ipc-sync-ops.ts
git commit -m "feat(contracts): add local_only sync status value"
```

---

### Task 2: Add `CachedEntitlement` to the store schema

**Files:**

- Modify: `apps/desktop/src/main/store.ts:25-33` (the `SyncStoreData` interface)

- [ ] **Step 1: Add the type and field**

In `apps/desktop/src/main/store.ts`, add a `CachedEntitlement` interface directly above `SyncStoreData`, and add the `entitlement?` field to `SyncStoreData`:

```ts
export interface CachedEntitlement {
  isPaid: boolean
  plan: string
  status: string
}

export interface SyncStoreData {
  recoveryPhraseConfirmed?: boolean
  email?: string
  /** Server device id for this install; seeds device rows in newly provisioned vault DBs */
  deviceId?: string
  /** Last known account vault list (decrypted names) for offline switcher display */
  accountVaultsCache?: AccountVaultsCache
  /** Cache-first entitlement snapshot; gates whether sync runs without a server call */
  entitlement?: CachedEntitlement
}
```

(Keep the existing `AccountVaultsCache` interface as-is.)

- [ ] **Step 2: Typecheck desktop node**

Run: `pnpm --filter @memry/desktop typecheck:node`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/store.ts
git commit -m "feat(desktop): add entitlement cache field to sync store"
```

---

### Task 3: Create the pure entitlement-cache module

**Files:**

- Create: `apps/desktop/src/main/billing/entitlement-cache.ts`
- Test: `apps/desktop/src/main/billing/entitlement-cache.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/billing/entitlement-cache.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

const storeData: { sync: Record<string, unknown> } = { sync: {} }
const storeGet = vi.fn((key: string) => (storeData as Record<string, unknown>)[key])
const storeSet = vi.fn((key: string, value: unknown) => {
  ;(storeData as Record<string, unknown>)[key] = value
})

vi.mock('../store', () => ({
  store: {
    get: (key: string) => storeGet(key),
    set: (key: string, value: unknown) => storeSet(key, value)
  }
}))

import {
  isPaidBillingStatus,
  getCachedEntitlement,
  setCachedEntitlementFromStatus
} from './entitlement-cache'
import type { BillingStatus } from './paddle-billing'

function status(plan: string, statusValue: string): BillingStatus {
  return {
    plan: plan as BillingStatus['plan'],
    status: statusValue as BillingStatus['status'],
    source: 'paddle',
    email: null,
    limits: { storageLimit: 0, maxFileSize: 0, maxVaults: 0, versionHistoryDays: 0 },
    usage: { storageUsed: 0 },
    expiresAt: null,
    canManageBilling: false
  }
}

describe('entitlement-cache', () => {
  beforeEach(() => {
    storeData.sync = {}
    vi.clearAllMocks()
  })

  it('isPaidBillingStatus is true only for a non-free active plan', () => {
    expect(isPaidBillingStatus(status('plus', 'active'))).toBe(true)
    expect(isPaidBillingStatus(status('pro', 'active'))).toBe(true)
    expect(isPaidBillingStatus(status('free', 'active'))).toBe(false)
    expect(isPaidBillingStatus(status('plus', 'canceled'))).toBe(false)
    expect(isPaidBillingStatus(status('plus', 'past_due'))).toBe(false)
  })

  it('getCachedEntitlement returns null when nothing cached', () => {
    expect(getCachedEntitlement()).toBeNull()
  })

  it('setCachedEntitlementFromStatus writes a cache and getCachedEntitlement reads it', () => {
    const written = setCachedEntitlementFromStatus(status('plus', 'active'))
    expect(written).toEqual({ isPaid: true, plan: 'plus', status: 'active' })
    expect(getCachedEntitlement()).toEqual({ isPaid: true, plan: 'plus', status: 'active' })
  })

  it('caches an unpaid status as isPaid=false', () => {
    setCachedEntitlementFromStatus(status('free', 'inactive'))
    expect(getCachedEntitlement()).toEqual({ isPaid: false, plan: 'free', status: 'inactive' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/billing/entitlement-cache.test.ts`
Expected: FAIL — cannot resolve `./entitlement-cache` / functions not defined.

- [ ] **Step 3: Write the module**

Create `apps/desktop/src/main/billing/entitlement-cache.ts`:

```ts
import { store, type CachedEntitlement } from '../store'
import type { BillingStatus } from './paddle-billing'

export type { CachedEntitlement }

export function isPaidBillingStatus(s: BillingStatus): boolean {
  return s.plan !== 'free' && s.status === 'active'
}

export function getCachedEntitlement(): CachedEntitlement | null {
  return store.get('sync').entitlement ?? null
}

export function setCachedEntitlementFromStatus(s: BillingStatus): CachedEntitlement {
  const cached: CachedEntitlement = {
    isPaid: isPaidBillingStatus(s),
    plan: s.plan,
    status: s.status
  }
  store.set('sync', { ...store.get('sync'), entitlement: cached })
  return cached
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/billing/entitlement-cache.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/billing/entitlement-cache.ts apps/desktop/src/main/billing/entitlement-cache.test.ts
git commit -m "feat(desktop): add pure entitlement cache module"
```

---

### Task 4: Add `resolveEntitlementForSyncStart` + cache-on-fetch + reconcile-starts-runtime

**Files:**

- Modify: `apps/desktop/src/main/billing/paddle-billing.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/billing/paddle-billing.activation.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

const getValidAccessToken = vi.fn()
const getFromServer = vi.fn()
const postToServer = vi.fn()
const getSyncEngine = vi.fn()
const startSyncRuntime = vi.fn()
const setCachedEntitlementFromStatus = vi.fn((s) => ({
  isPaid: s.plan !== 'free' && s.status === 'active',
  plan: s.plan,
  status: s.status
}))
const getCachedEntitlement = vi.fn(() => null)
const isPaidBillingStatus = vi.fn((s) => s.plan !== 'free' && s.status === 'active')

vi.mock('../sync/token-manager', () => ({ getValidAccessToken }))
vi.mock('../sync/http-client', () => ({ getFromServer, postToServer }))
vi.mock('../sync/runtime', () => ({ getSyncEngine, startSyncRuntime }))
vi.mock('./entitlement-cache', () => ({
  setCachedEntitlementFromStatus,
  getCachedEntitlement,
  isPaidBillingStatus
}))
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))
vi.mock('../lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }))

import { resolveEntitlementForSyncStart, reconcileBillingAndSync } from './paddle-billing'

const paidStatus = {
  plan: 'plus',
  status: 'active',
  source: 'paddle',
  email: null,
  limits: { storageLimit: 0, maxFileSize: 0, maxVaults: 0, versionHistoryDays: 0 },
  usage: { storageUsed: 0 },
  expiresAt: null,
  canManageBilling: true
}

describe('paddle-billing activation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getValidAccessToken.mockResolvedValue('access-token')
  })

  it('resolveEntitlementForSyncStart returns cached unpaid WITHOUT a server call', async () => {
    getCachedEntitlement.mockReturnValue({ isPaid: false, plan: 'free', status: 'inactive' })
    const result = await resolveEntitlementForSyncStart()
    expect(result.isPaid).toBe(false)
    expect(getFromServer).not.toHaveBeenCalled()
  })

  it('resolveEntitlementForSyncStart fetches + caches when cache is unknown', async () => {
    getCachedEntitlement.mockReturnValue(null)
    getFromServer.mockResolvedValue(paidStatus)
    const result = await resolveEntitlementForSyncStart()
    expect(getFromServer).toHaveBeenCalledWith('/auth/billing', 'access-token')
    expect(setCachedEntitlementFromStatus).toHaveBeenCalledWith(paidStatus)
    expect(result.isPaid).toBe(true)
  })

  it('reconcileBillingAndSync caches + starts the runtime when active', async () => {
    postToServer.mockResolvedValue(paidStatus)
    await reconcileBillingAndSync({ transactionId: 'txn_1' })
    expect(setCachedEntitlementFromStatus).toHaveBeenCalledWith(paidStatus)
    expect(startSyncRuntime).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/billing/paddle-billing.activation.test.ts`
Expected: FAIL — `resolveEntitlementForSyncStart` is not exported; reconcile does not call `startSyncRuntime`.

- [ ] **Step 3: Modify `paddle-billing.ts`**

In `apps/desktop/src/main/billing/paddle-billing.ts`:

(a) Update the runtime import (line 4) and add the cache import:

```ts
import { getSyncEngine, startSyncRuntime } from '../sync/runtime'
import {
  getCachedEntitlement,
  isPaidBillingStatus,
  setCachedEntitlementFromStatus,
  type CachedEntitlement
} from './entitlement-cache'
```

(b) Cache on fetch — update `getBillingStatus` (lines 57-63):

```ts
export async function getBillingStatus(): Promise<
  BillingStatus | (BillingActionResult & { status?: never })
> {
  const token = await getValidAccessToken()
  if (!token) return { success: false, error: 'Sign in to view billing' }
  const result = await getFromServer<BillingStatus>('/auth/billing', token)
  setCachedEntitlementFromStatus(result)
  return result
}
```

(c) Cache on refresh — update `refreshBillingStatus` (lines 65-75):

```ts
export async function refreshBillingStatus(input?: {
  transactionId?: string
}): Promise<BillingStatus | (BillingActionResult & { status?: never })> {
  const token = await getValidAccessToken()
  if (!token) return { success: false, error: 'Sign in to refresh billing' }
  const result = await postToServer<BillingStatus>(
    '/auth/billing/reconcile',
    input?.transactionId ? { transactionId: input.transactionId } : {},
    token
  )
  setCachedEntitlementFromStatus(result)
  return result
}
```

(d) Start the runtime on activation — replace `reconcileBillingAndSync` (lines 90-105):

```ts
export async function reconcileBillingAndSync(input?: { transactionId?: string }): Promise<void> {
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const status = await refreshBillingStatus(input)
      if ('plan' in status && isPaidBillingStatus(status)) {
        setCachedEntitlementFromStatus(status)
        await startSyncRuntime()
        await getSyncEngine()?.fullSync()
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  } catch (error) {
    log.warn('Failed to reconcile billing from deep link', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
```

(e) Add `resolveEntitlementForSyncStart` (append near the other exports, e.g. after `reconcileBillingAndSync`):

```ts
export async function resolveEntitlementForSyncStart(): Promise<CachedEntitlement> {
  const cached = getCachedEntitlement()
  if (cached && !cached.isPaid) return cached // known-unpaid: no server call

  try {
    const result = await getBillingStatus()
    if ('plan' in result) {
      return {
        isPaid: isPaidBillingStatus(result),
        plan: result.plan,
        status: result.status
      }
    }
    log.warn('Billing status unavailable; treating as unpaid for this launch')
  } catch (error) {
    log.warn('Billing status fetch failed; treating as unpaid for this launch', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
  return cached ?? { isPaid: false, plan: 'free', status: 'inactive' }
}
```

> Note: `getBillingStatus()` already calls `setCachedEntitlementFromStatus`, so the
> success branch of `resolveEntitlementForSyncStart` does not need to cache again.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/billing/paddle-billing.activation.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/billing/paddle-billing.ts apps/desktop/src/main/billing/paddle-billing.activation.test.ts
git commit -m "feat(desktop): cache entitlement on fetch and start runtime on activation"
```

---

### Task 5: Gate `startSyncRuntime` on entitlement

**Files:**

- Modify: `apps/desktop/src/main/sync/runtime.ts` (gate after the recovery-phrase guard ~line 190; add `emitLocalOnly` near `emitQuotaExceeded` ~line 82)
- Modify: `apps/desktop/src/main/sync/runtime.test.ts` (mock `../billing/paddle-billing`; add gate tests)

- [ ] **Step 1: Write the failing test**

In `apps/desktop/src/main/sync/runtime.test.ts`, add a mock for the billing module alongside the other `vi.mock` calls (the gate uses a dynamic `import('../billing/paddle-billing')`, which Vitest still intercepts):

```ts
const resolveEntitlementForSyncStart = vi.fn()
vi.mock('../billing/paddle-billing', () => ({ resolveEntitlementForSyncStart }))
```

In the existing `beforeEach`, default it to paid so existing happy-path tests still start the engine:

```ts
resolveEntitlementForSyncStart.mockResolvedValue({ isPaid: true, plan: 'plus', status: 'active' })
```

Then add a new test next to the recovery-phrase test:

```ts
it('skips startup when the account is not on a paid plan', async () => {
  resolveEntitlementForSyncStart.mockResolvedValue({
    isPaid: false,
    plan: 'free',
    status: 'inactive'
  })
  const runtime = await loadRuntime()

  await expect(runtime.startSyncRuntime()).resolves.toBeNull()

  expect(runtimeMocks.getDatabase).not.toHaveBeenCalled()
  expect(runtime.getSyncEngine()).toBeNull()
})
```

> If the mock name `resolveEntitlementForSyncStart` collides with the hoisted
> `runtimeMocks` pattern in this file, define it inside the existing
> `vi.hoisted(() => { ... })` block as `runtimeMocks.resolveEntitlementForSyncStart`
> and reference it the same way the file references its other hoisted mocks.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/sync/runtime.test.ts`
Expected: FAIL — the new test fails because the gate does not exist yet (engine starts, `getDatabase` is called).

- [ ] **Step 3: Add the gate and the emit helper**

In `apps/desktop/src/main/sync/runtime.ts`:

(a) Add `emitLocalOnly` next to the existing `emitQuotaExceeded` (around line 82):

```ts
function emitLocalOnly(): void {
  const event: SyncStatusChangedEvent = {
    status: 'local_only',
    pendingCount: 0
  }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(EVENT_CHANNELS.STATUS_CHANGED, event)
  }
}
```

(b) Insert the gate in `startSyncRuntime`, immediately after the recovery-phrase guard (after line 191, before `startPromise = (async () => {`):

```ts
const { resolveEntitlementForSyncStart } = await import('../billing/paddle-billing')
const entitlement = await resolveEntitlementForSyncStart()
if (!entitlement.isPaid) {
  log.info('Sync runtime skipped: not on a paid plan')
  emitLocalOnly()
  return null
}
```

> The dynamic `import()` (same pattern as the existing
> `await import('./device-registration')` in this file) breaks the
> `runtime ↔ paddle-billing` static import cycle.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/sync/runtime.test.ts`
Expected: PASS (the new gate test passes; pre-existing tests still pass thanks to the paid default in `beforeEach`).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/sync/runtime.ts apps/desktop/src/main/sync/runtime.test.ts
git commit -m "fix(desktop): gate sync runtime on paid entitlement (no 402 for free users)"
```

---

### Task 6: Start the runtime from `TRIGGER_SYNC`; surface `local_only` in `GET_STATUS`

**Files:**

- Modify: `apps/desktop/src/main/ipc/sync-core-handlers.ts:144-159`
- Modify: `apps/desktop/src/main/ipc/sync-core-handlers.test.ts`

- [ ] **Step 1: Write the failing test**

In `apps/desktop/src/main/ipc/sync-core-handlers.test.ts`, ensure `startSyncRuntime` and the entitlement cache are mockable, then add two tests. (Match the file's existing mock style; it already mocks `../sync/runtime` per the earlier grep showing `startSyncRuntime: vi.fn()`.)

```ts
// in the ../sync/runtime mock, ensure: startSyncRuntime: mockStartSyncRuntime, getSyncEngine: mockGetSyncEngine
// add a cache mock:
vi.mock('../billing/entitlement-cache', () => ({
  getCachedEntitlement: mockGetCachedEntitlement
}))

it('TRIGGER_SYNC starts the runtime when no engine is running', async () => {
  mockResolveSyncEngine.mockReturnValueOnce(null) // no engine yet
  const startedEngine = { fullSync: vi.fn().mockResolvedValue(undefined) }
  mockStartSyncRuntime.mockResolvedValue(startedEngine)

  const result = await invokeHandler(SYNC_CHANNELS.TRIGGER_SYNC)

  expect(mockStartSyncRuntime).toHaveBeenCalledTimes(1)
  expect(startedEngine.fullSync).toHaveBeenCalledTimes(1)
  expect(result).toEqual({ success: true })
})

it('GET_STATUS returns local_only when no engine and cached entitlement is unpaid', () => {
  mockResolveSyncEngine.mockReturnValueOnce(null)
  mockGetCachedEntitlement.mockReturnValueOnce({ isPaid: false, plan: 'free', status: 'inactive' })

  const result = invokeHandler(SYNC_CHANNELS.GET_STATUS)

  expect(result).toEqual({ status: 'local_only', pendingCount: 0 })
})
```

> Use the file's existing helper for invoking a registered handler (e.g. capturing
> the `ipcMain.handle` callback). If none exists, capture handlers via the existing
> `ipcMain` mock the test file already sets up.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/ipc/sync-core-handlers.test.ts`
Expected: FAIL — `TRIGGER_SYNC` returns the not-initialized error; `GET_STATUS` returns `idle`.

- [ ] **Step 3: Modify the handlers**

In `apps/desktop/src/main/ipc/sync-core-handlers.ts`, add imports at the top:

```ts
import { startSyncRuntime } from '../sync/runtime'
import { getCachedEntitlement } from '../billing/entitlement-cache'
```

Replace the `GET_STATUS` handler (lines 144-148):

```ts
ipcMain.handle(SYNC_CHANNELS.GET_STATUS, () => {
  const engine = resolveSyncEngine()
  if (!engine) {
    const cached = getCachedEntitlement()
    if (cached && !cached.isPaid) {
      return { status: 'local_only', pendingCount: 0 }
    }
    return { status: 'idle', pendingCount: 0 }
  }
  return engine.getStatus()
})
```

Replace the `TRIGGER_SYNC` handler (lines 150-159):

```ts
ipcMain.handle(SYNC_CHANNELS.TRIGGER_SYNC, async () => {
  let engine = resolveSyncEngine()
  if (!engine) {
    engine = await startSyncRuntime()
  }
  if (!engine) {
    return { success: false, error: 'errors:sync.engineNotInitialized' }
  }
  return withErrorHandler(async () => {
    await engine.fullSync()
    return { success: true }
  }, 'errors:sync.triggerFailed')()
})
```

> If `resolveSyncEngine` and `startSyncRuntime` return the same engine type this
> compiles directly. If `resolveSyncEngine`'s type differs, assign through a
> `let engine: SyncEngine | null`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/ipc/sync-core-handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Regenerate + check the IPC invoke map (handler return types changed)**

Run: `pnpm ipc:generate && pnpm ipc:check`
Expected: PASS (invoke map regenerated and in sync). Stage any regenerated file it updates.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/ipc/sync-core-handlers.ts apps/desktop/src/main/ipc/sync-core-handlers.test.ts apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts
git commit -m "feat(desktop): trigger-sync starts runtime; get-status reports local_only"
```

---

### Task 7: Full verification

- [ ] **Step 1: Run the desktop main test suite**

Run: `pnpm --filter @memry/desktop test:main`
Expected: PASS (including the new gate/cache/handler tests).

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm --filter @memry/desktop typecheck && pnpm --filter @memry/contracts typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 3: Docs gate (desktop change)**

Run: `pnpm docs:impact --base origin/main --strict`
Expected: PASS, or `missing-docs` → run `pnpm docs:ai-update --base origin/main` (or update `apps/docs/src`), then re-run `--strict`.

- [ ] **Step 4: Manual QA (build + run)**

- Sign in as a brand-new (free) account → **no sync error**; app fully usable locally; sync pill shows "Local only".
- Existing checkout flow (Upgrade) → on activation the app starts syncing.
- Relaunch as a paid user → cache says paid → re-verifies → sync starts.
- Relaunch as a free user → **no `/auth/billing` call** beyond what sign-in already did (verify via logs/network).

---

## Self-Review

**Spec coverage:**

- Gate (spec §"The gap" #1) → Task 5. ✅
- Cache-first, no server call for known-unpaid (spec §Design 1, Decision #3) → Task 3 + Task 4 `resolveEntitlementForSyncStart` (cached-unpaid short-circuit) → asserted in Task 4 Step 1 test. ✅
- Activation starts runtime (spec §Design 3, gap #2) → Task 4 (reconcile) + Task 6 (`TRIGGER_SYNC`). ✅
- Cache freshness on fetch/refresh (spec §Design 3) → Task 4 (b)(c). ✅
- `local_only` status (spec §Design 4, gap #3) → Task 1 + Task 5 (`emitLocalOnly`) + Task 6 (`GET_STATUS`). ✅
- Lapsed = unpaid (spec edge cases) → `isPaidBillingStatus` requires `active` (Task 3 truth table). ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✅

**Type consistency:** `CachedEntitlement` defined in `store.ts` (Task 2), re-exported from `entitlement-cache.ts` (Task 3), consumed in `paddle-billing.ts` (Task 4). `isPaidBillingStatus`, `getCachedEntitlement`, `setCachedEntitlementFromStatus`, `resolveEntitlementForSyncStart` names match across Tasks 3–6. `SyncStatusValue` `'local_only'` (Task 1) used by `emitLocalOnly` (Task 5) and `GET_STATUS` (Task 6). ✅

**Import cycles:** `entitlement-cache` is pure (store + type-only `BillingStatus`). `paddle-billing → entitlement-cache` (runtime) + `→ runtime` (static). `runtime → paddle-billing` via **dynamic import** only (no static cycle). `sync-core-handlers → runtime` + `→ entitlement-cache` (pure). ✅

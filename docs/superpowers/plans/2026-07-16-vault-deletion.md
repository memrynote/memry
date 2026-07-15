# Vault Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user delete a vault from their account — purging server data and freeing the entitlement slot — from the sidebar vault switcher and Settings → Vault, without ever touching their files on disk.

**Architecture:** Additive `DELETE /sync/vaults/:vaultId` on the sync server explicitly purges 8 vault-scoped D1 tables plus the vault's R2 prefix and decrements `users.storage_used`. A new `vault:delete-from-account` IPC channel (keyed on vaultUuid, not path) calls it and then drops the local known-vaults entry — both steps always, or the vault re-registers on next launch. Two renderer surfaces gain a delete affordance. No schema change, no migration.

**Tech Stack:** Hono + Cloudflare D1/R2 (sync-server), Electron main/preload/renderer + React + Radix (desktop), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-16-vault-deletion-design.md`

## Global Constraints

- **Backward compatibility is mandatory.** Production users on real data. No DB resets. Additive only — no schema change, no migration, no change to any existing route/contract/payload shape.
- **Server deploys before desktop.** The endpoint must exist before any client offers the button.
- **Delete NEVER touches local files.** No `fs.rm`, no `shell.trashItem`, no folder deletion anywhere in this work. (Spec D1.)
- **The active vault cannot be deleted.** (Spec D4.)
- **`server_cursor_sequence` must never be deleted per-vault** — it is per-user and shared across vaults. Deleting it corrupts other vaults' cursors.
- **R2 delete happens before the D1 batch.** A mid-flight failure must leave retryable D1 rows, not orphaned R2 objects.
- **Logging:** `createLogger('Scope')` from `electron-log`. Never raw `console.*`.
- **User-facing errors:** `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`.
- **Tailwind RTL:** logical classes only in new code — `ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`, `text-start`/`text-end`. Never `ml-*`/`mr-*`/`left-*`/`right-*`.
- **i18n:** renderer keys need only `en` to pass `i18n:check`. Switcher uses namespace `common`, prefix `phaseF.componentsVaultSwitcher.*`. Settings uses namespace `settings`, prefix `vault.*`.
- Run `pnpm ipc:generate` **before** `pnpm ipc:check` after touching contracts/preload/handlers.

## Decisions Locked From Research

These were verified against the real code. Do not re-litigate them mid-implementation.

1. **`deleteFromServer` already exists** — `apps/desktop/src/main/sync/http-client.ts:152-158`. Do not write a new HTTP helper.
2. **`adjustStorageUsed` cannot go inside `db.batch`** — it is an async function running its own `.run()` (`services/quota.ts:47-65`). Inline its negative-delta UPDATE statement into the batch instead, so accounting is atomic with the deletes.
3. **`sync.use('*', authMiddleware)` is at `routes/sync.ts:48`**, before the vault routes — the new DELETE gets auth for free. It must still register **before** `sync.use('*', paidSyncMiddleware)` at `routes/sync.ts:105`.
4. **`ensureSyncVaultAllowed` is an upsert, not a check** (`services/entitlements.ts:187-243`). Mounted below `paidSyncMiddleware`, DELETE would have its target re-created mid-request.
5. **`SYNC_PLAN_LIMITS` is already correct AND already tested** (`services/entitlements.ts:44-69`; `services/entitlements.test.ts:89-104`, "defines the paid plan limits requested for Plus, Pro, and Believer"; `:217`, "blocks a second synced vault for Plus"). free `maxVaults: 0`, plus `1`, pro `10`, believer `null`. **No production change and no new limit tests.** Task 4 adds exactly one test: that delete frees a slot.
6. **The sync-server has NO real database in tests.** `routes/sync.test.ts:157` is `DB: {} as D1Database`; `services/entitlements` is mocked wholesale at `sync.test.ts:57-62`. Service tests use hand-rolled `vi` doubles (`services/account-deletion.test.ts:4-25` is the house pattern: `prepare` returns `{ _sql, bind }`, assertions read `db.batch.mock.calls[0][0]`). Do not attempt a real D1 or miniflare — none exists here.
7. **`ensureSyncVaultAllowed` mock is the mount-order probe.** `sync.test.ts:391` already asserts `expect(ensureSyncVaultAllowed).not.toHaveBeenCalled()`. Reuse that exact pattern for the DELETE route.
8. **`c.env.STORAGE` is the R2 binding** (`src/types.ts:3`). Verified.
9. **`ErrorCodes.SYNC_VAULT_NOT_FOUND` does NOT exist.** `lib/errors.ts:38` has only `SYNC_VAULT_LIMIT_EXCEEDED`. Add the new code additively.
10. **The switcher's `Picker` is mocked flat in renderer tests** — `components/cold-major-components.test.tsx:189-218` replaces `@/components/ui/picker` with inline stubs. Reuse that mock; a real Radix Popover will not open in jsdom.
11. **UI uses hover icon buttons, not a `⋯` menu.** The spec's mockup showed a `⋯` menu; implementation uses a second hover icon instead. Reason: the rows live inside a `Picker` popover, the codebase has no nested-menu-in-picker precedent, and a nested Radix menu would need its own jsdom mock. Remote rows need only one action anyway (clicking the row already downloads), so a single trash icon is sufficient there. Same interaction idiom as the existing X.

## Deferred From Spec

**The `USER_SYNC_STATE` Durable Object is NOT notified on vault delete.** The spec's service step 4 called for mirroring `devices.ts:66-73`'s `https://do/revoke-device` call so live devices drop the vault.

Dropped deliberately: no such DO endpoint exists for vaults (one would have to be designed and added), and spec D3 already accepts that a vault can be resurrected by another device holding a local copy. Strict live-drop semantics on other devices cannot be load-bearing in a design that permits resurrection. A stale in-memory vault reference on a connected device self-corrects on the next `refreshVaultDirectory`.

If this turns out to matter, it is additive and can land separately. Do not half-implement it inside this work.

## File Structure

**Create:**

- `apps/sync-server/src/services/vault-deletion.ts` — purge one vault's D1 rows + R2 objects, decrement storage. One responsibility.
- `apps/sync-server/src/services/vault-deletion.test.ts`
- `apps/sync-server/src/services/blob.test.ts` (if absent)
- `apps/desktop/src/renderer/src/components/vault-switcher.test.tsx`
- `apps/desktop/src/renderer/src/pages/settings/vault-section.test.tsx`
- `apps/desktop/tests/e2e/vault-deletion.e2e.ts`

**Modify:**

- `apps/sync-server/src/services/blob.ts` — add `deleteByPrefix`.
- `apps/sync-server/src/services/account-deletion.ts:12-20` — reuse `deleteByPrefix`.
- `apps/sync-server/src/routes/sync.ts` — add DELETE route above line 105.
- `apps/sync-server/src/routes/sync.test.ts` — route suite + mount-order regression.
- `apps/sync-server/src/lib/errors.ts:38` — add `SYNC_VAULT_NOT_FOUND`.
- `apps/sync-server/src/services/entitlements.test.ts` — read-only unless a Pro-cap gap is confirmed (Task 4).
- `packages/contracts/src/ipc-channels.ts:38-56` — add channel.
- `packages/contracts/src/vault-api.ts:127-177` — add invoke-map entry + client method.
- `apps/desktop/src/main/sync/vault-directory.ts` — add `deleteAccountVault`.
- `apps/desktop/src/main/ipc/vault-handlers.ts:107` — register handler.
- `apps/desktop/src/renderer/src/components/vault-switcher.tsx` — delete affordance + fix `&` bug.
- `apps/desktop/src/renderer/src/pages/settings/vault-section.tsx` — account vault list.
- `apps/desktop/tests/setup-dom.ts:97-108` — add `deleteFromAccount` to the global `window.api.vault` mock.
- `packages/i18n/src/locales/en/common.json`, `packages/i18n/src/locales/en/settings.json` — new keys.
- `apps/docs/src/user-guide/sync/how-sync-works.md` — document delete + D3 resurrection caveat.

---

### Task 1: R2 prefix-delete helper

**Files:**

- Modify: `apps/sync-server/src/services/blob.ts` (append after `deleteBlob`, line 80)
- Modify: `apps/sync-server/src/services/account-deletion.ts:12-20`
- Test: `apps/sync-server/src/services/blob.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `deleteByPrefix(storage: R2Bucket, prefix: string, userId: string): Promise<number>` — returns count of deleted objects. Enforces `assertKeyBelongsToUser` on the prefix.

- [ ] **Step 1: Write the failing test**

Append to `apps/sync-server/src/services/blob.test.ts` (create the file with the imports below if it does not exist):

```ts
import { describe, it, expect, vi } from 'vitest'
import { deleteByPrefix } from './blob'
import { AppError } from '../lib/errors'

const makeBucket = (pages: Array<{ keys: string[]; truncated: boolean; cursor?: string }>) => {
  const deleted: string[][] = []
  let call = 0
  return {
    deleted,
    bucket: {
      list: vi.fn(async () => {
        const page = pages[call++]
        return {
          objects: page.keys.map((key) => ({ key })),
          truncated: page.truncated,
          cursor: page.cursor
        }
      }),
      delete: vi.fn(async (keys: string[]) => {
        deleted.push(keys)
      })
    } as unknown as R2Bucket
  }
}

describe('deleteByPrefix', () => {
  it('deletes every page of a truncated listing', async () => {
    const { bucket, deleted } = makeBucket([
      { keys: ['u1/vaults/v1/items/a'], truncated: true, cursor: 'c1' },
      { keys: ['u1/vaults/v1/items/b'], truncated: false }
    ])

    const count = await deleteByPrefix(bucket, 'u1/vaults/v1/', 'u1')

    expect(count).toBe(2)
    expect(deleted).toEqual([['u1/vaults/v1/items/a'], ['u1/vaults/v1/items/b']])
    expect(bucket.list).toHaveBeenCalledTimes(2)
  })

  it('skips the delete call for an empty page', async () => {
    const { bucket, deleted } = makeBucket([{ keys: [], truncated: false }])

    const count = await deleteByPrefix(bucket, 'u1/vaults/v1/', 'u1')

    expect(count).toBe(0)
    expect(deleted).toEqual([])
    expect(bucket.delete).not.toHaveBeenCalled()
  })

  it('refuses a prefix belonging to another user', async () => {
    const { bucket } = makeBucket([{ keys: [], truncated: false }])

    await expect(deleteByPrefix(bucket, 'u2/vaults/v1/', 'u1')).rejects.toThrow(AppError)
    expect(bucket.list).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/sync-server test -- blob.test.ts`
Expected: FAIL — `deleteByPrefix is not a function` / import error.

- [ ] **Step 3: Write minimal implementation**

Append to `apps/sync-server/src/services/blob.ts`:

```ts
/**
 * Delete every object under a prefix, honoring R2 list pagination.
 * The prefix must be inside the caller's own namespace.
 */
export const deleteByPrefix = async (
  storage: R2Bucket,
  prefix: string,
  userId: string
): Promise<number> => {
  assertKeyBelongsToUser(prefix, userId)

  let cursor: string | undefined
  let deleted = 0
  do {
    const listing = await storage.list({ prefix, cursor })
    const keys = listing.objects.map((o) => o.key)
    if (keys.length > 0) {
      await storage.delete(keys)
      deleted += keys.length
    }
    cursor = listing.truncated ? listing.cursor : undefined
  } while (cursor)

  return deleted
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/sync-server test -- blob.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Reuse it in account-deletion**

Replace `apps/sync-server/src/services/account-deletion.ts` lines 12-20 (the inline loop) with a call. Add the import at the top of the file:

```ts
import { deleteByPrefix } from './blob'
```

Replace the loop body so the function begins:

```ts
export async function deleteUserData(
  db: D1Database,
  bucket: R2Bucket,
  userId: string,
  email: string
): Promise<void> {
  await deleteByPrefix(bucket, `${userId}/`, userId)

  await db.batch([
```

Leave the rest of the `db.batch` array exactly as-is.

- [ ] **Step 6: Verify account-deletion still passes**

Run: `pnpm --filter @memry/sync-server test`
Expected: PASS — no regression in account-deletion tests.

- [ ] **Step 7: Commit**

```bash
git add apps/sync-server/src/services/blob.ts apps/sync-server/src/services/blob.test.ts apps/sync-server/src/services/account-deletion.ts
git commit -m "refactor(sync-server): extract deleteByPrefix R2 helper"
```

---

### Task 2: Vault deletion service

**Files:**

- Create: `apps/sync-server/src/services/vault-deletion.ts`
- Create: `apps/sync-server/src/services/vault-deletion.test.ts`

**Interfaces:**

- Consumes: `deleteByPrefix` from Task 1.
- Produces:
  - `vaultExistsForUser(db: D1Database, userId: string, vaultId: string): Promise<boolean>`
  - `deleteVaultData(db: D1Database, bucket: R2Bucket, userId: string, vaultId: string): Promise<void>`

**Why the byte sum is hand-rolled:** `getStorageBreakdown` (`services/storage.ts:14-61`) is per-user only and filters `deleted_at IS NULL`, missing tombstoned `sync_items` whose bytes were charged. Sum the rows actually being deleted, per the `cleanup.ts:168-183` precedent.

- [ ] **Step 1: Write the failing test**

Create `apps/sync-server/src/services/vault-deletion.test.ts`.

This follows the house pattern from `services/account-deletion.test.ts:4-25` — a hand-rolled `vi` double, no real database (there is none in this package). It extends that pattern in two ways this service needs: capturing `bind` args, and answering `.first()` (this service reads before it writes).

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { deleteVaultData, vaultExistsForUser } from './vault-deletion'

interface FakeStmt {
  _sql: string
  _args: unknown[]
  bind: (...args: unknown[]) => FakeStmt
  first: () => Promise<unknown>
  run: () => Promise<{ meta: { changes: number } }>
}

const makeDb = (opts: { exists?: boolean; sums?: Record<string, number> } = {}) => {
  const statements: FakeStmt[] = []
  return {
    statements,
    prepare: vi.fn((sql: string) => {
      const stmt: FakeStmt = {
        _sql: sql,
        _args: [],
        bind(...args: unknown[]) {
          stmt._args = args
          return stmt
        },
        async first() {
          if (sql.includes('SELECT vault_id FROM sync_vaults')) {
            return opts.exists ? { vault_id: stmt._args[1] } : null
          }
          const table = Object.keys(opts.sums ?? {}).find((t) => sql.includes(t))
          return { total: table ? opts.sums![table] : 0 }
        },
        async run() {
          return { meta: { changes: 1 } }
        }
      }
      statements.push(stmt)
      return stmt
    }),
    batch: vi.fn().mockResolvedValue([])
  }
}

const batchOf = (db: ReturnType<typeof makeDb>): FakeStmt[] => db.batch.mock.calls[0][0]

const makeBucket = () => ({
  list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
  delete: vi.fn().mockResolvedValue(undefined)
})

describe('vaultExistsForUser', () => {
  it('scopes the lookup by user and vault', async () => {
    const db = makeDb({ exists: true })

    await expect(vaultExistsForUser(db as unknown as D1Database, 'u1', 'v1')).resolves.toBe(true)

    expect(db.statements[0]._sql).toContain('WHERE user_id = ? AND vault_id = ?')
    expect(db.statements[0]._args).toEqual(['u1', 'v1'])
  })

  it('returns false for a vault the user does not own', async () => {
    const db = makeDb({ exists: false })
    await expect(vaultExistsForUser(db as unknown as D1Database, 'u1', 'v1')).resolves.toBe(false)
  })
})

describe('deleteVaultData', () => {
  let db: ReturnType<typeof makeDb>
  let bucket: ReturnType<typeof makeBucket>

  beforeEach(async () => {
    vi.clearAllMocks()
    db = makeDb({ sums: { sync_items: 100, crdt_snapshots: 20, crdt_updates: 5, blob_chunks: 75 } })
    bucket = makeBucket()
    await deleteVaultData(db as unknown as D1Database, bucket as unknown as R2Bucket, 'u1', 'v1')
  })

  it('purges R2 under the vault prefix', () => {
    expect(bucket.list).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'u1/vaults/v1/' }))
  })

  it('deletes every vault-scoped table, each scoped to user + vault', () => {
    const tables = [
      'crdt_updates',
      'crdt_snapshots',
      'upload_sessions',
      'blob_chunks',
      'device_sync_state',
      'sync_items',
      'sync_vaults'
    ]
    for (const table of tables) {
      const stmt = batchOf(db).find((s) => s._sql.includes(`DELETE FROM ${table}`))
      expect(stmt, `missing DELETE for ${table}`).toBeDefined()
      expect(stmt!._sql).toContain('WHERE user_id = ? AND vault_id = ?')
      expect(stmt!._args).toEqual(['u1', 'v1'])
    }
  })

  it('nulls the devices vault_id rather than deleting device rows', () => {
    const stmt = batchOf(db).find((s) => s._sql.includes('UPDATE devices'))
    expect(stmt).toBeDefined()
    expect(stmt!._sql).toContain('SET vault_id = NULL')
    expect(batchOf(db).find((s) => s._sql.includes('DELETE FROM devices'))).toBeUndefined()
  })

  it('never deletes server_cursor_sequence (per-user, shared across vaults)', () => {
    expect(batchOf(db).find((s) => s._sql.includes('server_cursor_sequence'))).toBeUndefined()
  })

  it('decrements storage_used by the summed bytes, floored at zero', () => {
    const stmt = batchOf(db).find((s) => s._sql.includes('UPDATE users'))
    expect(stmt).toBeDefined()
    expect(stmt!._sql).toContain('MAX(0, storage_used + ?)')
    expect(stmt!._args[0]).toBe(-200) // 100 + 20 + 5 + 75
  })
})

describe('deleteVaultData ordering', () => {
  // R2 first, so a mid-flight failure leaves retryable rows rather than
  // orphaned, unreachable objects.
  it('purges R2 before the D1 batch', async () => {
    const order: string[] = []
    const db = makeDb()
    db.batch = vi.fn(async () => {
      order.push('d1')
      return []
    })
    const bucket = {
      list: vi.fn(async () => {
        order.push('r2')
        return { objects: [], truncated: false }
      }),
      delete: vi.fn().mockResolvedValue(undefined)
    }

    await deleteVaultData(db as unknown as D1Database, bucket as unknown as R2Bucket, 'u1', 'v1')

    expect(order).toEqual(['r2', 'd1'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/sync-server test -- vault-deletion.test.ts`
Expected: FAIL — cannot resolve `./vault-deletion`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/sync-server/src/services/vault-deletion.ts`:

```ts
import { deleteByPrefix } from './blob'

/**
 * True if this user owns this vault. Callers 404 on false — a cross-user
 * delete must be indistinguishable from a missing vault so ownership never
 * leaks.
 */
export async function vaultExistsForUser(
  db: D1Database,
  userId: string,
  vaultId: string
): Promise<boolean> {
  const row = await db
    .prepare('SELECT vault_id FROM sync_vaults WHERE user_id = ? AND vault_id = ?')
    .bind(userId, vaultId)
    .first<{ vault_id: string }>()
  return row !== null
}

async function sumVaultBytes(db: D1Database, userId: string, vaultId: string): Promise<number> {
  const queries = [
    'SELECT COALESCE(SUM(size_bytes), 0) as total FROM sync_items WHERE user_id = ? AND vault_id = ?',
    'SELECT COALESCE(SUM(size_bytes), 0) as total FROM crdt_snapshots WHERE user_id = ? AND vault_id = ?',
    'SELECT COALESCE(SUM(LENGTH(update_data)), 0) as total FROM crdt_updates WHERE user_id = ? AND vault_id = ?',
    'SELECT COALESCE(SUM(size_bytes), 0) as total FROM blob_chunks WHERE user_id = ? AND vault_id = ?'
  ]

  let total = 0
  for (const sql of queries) {
    const row = await db.prepare(sql).bind(userId, vaultId).first<{ total: number }>()
    total += row?.total ?? 0
  }
  return total
}

/**
 * Irreversibly purge one vault's server data: R2 payloads, every vault-scoped
 * D1 row, and the storage the vault was charged for.
 *
 * `sync_vaults` has no children by foreign key — every vault-scoped table
 * carries a loose `vault_id TEXT` and FKs only to `users(id)`. Nothing
 * cascades; each table is deleted explicitly.
 *
 * `server_cursor_sequence` is deliberately absent: it is per-user and shared
 * across vaults, so deleting it would corrupt other vaults' cursors.
 *
 * R2 is purged before the D1 batch so a mid-flight failure leaves retryable
 * rows pointing at missing blobs rather than orphaned, unreachable objects.
 */
export async function deleteVaultData(
  db: D1Database,
  bucket: R2Bucket,
  userId: string,
  vaultId: string
): Promise<void> {
  const bytes = await sumVaultBytes(db, userId, vaultId)

  await deleteByPrefix(bucket, `${userId}/vaults/${vaultId}/`, userId)

  const now = Math.floor(Date.now() / 1000)
  const scoped = (sql: string) => db.prepare(sql).bind(userId, vaultId)

  await db.batch([
    scoped('DELETE FROM crdt_updates WHERE user_id = ? AND vault_id = ?'),
    scoped('DELETE FROM crdt_snapshots WHERE user_id = ? AND vault_id = ?'),
    scoped('DELETE FROM upload_sessions WHERE user_id = ? AND vault_id = ?'),
    scoped('DELETE FROM blob_chunks WHERE user_id = ? AND vault_id = ?'),
    scoped('DELETE FROM device_sync_state WHERE user_id = ? AND vault_id = ?'),
    scoped('DELETE FROM sync_items WHERE user_id = ? AND vault_id = ?'),
    scoped('UPDATE devices SET vault_id = NULL WHERE user_id = ? AND vault_id = ?'),
    scoped('DELETE FROM sync_vaults WHERE user_id = ? AND vault_id = ?'),
    // Inlined rather than calling adjustStorageUsed(): that helper runs its own
    // statement, which would land outside this batch's atomicity.
    db
      .prepare(
        'UPDATE users SET storage_used = MAX(0, storage_used + ?), updated_at = ? WHERE id = ?'
      )
      .bind(-bytes, now, userId)
  ])
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/sync-server test -- vault-deletion.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/sync-server/src/services/vault-deletion.ts apps/sync-server/src/services/vault-deletion.test.ts
git commit -m "feat(sync-server): add vault deletion service"
```

---

### Task 3: DELETE /sync/vaults/:vaultId route

**Files:**

- Modify: `apps/sync-server/src/routes/sync.ts` (insert after line 103, **before** line 105's `sync.use('*', paidSyncMiddleware)`)
- Test: `apps/sync-server/src/routes/sync.test.ts` (append; create if absent, following the existing route-test harness in `apps/sync-server/src/routes/*.test.ts`)

**Interfaces:**

- Consumes: `deleteVaultData`, `vaultExistsForUser` from Task 2.
- Produces: `DELETE /sync/vaults/:vaultId` → `200 {"success":true}` | `404` | `429`.

**The mount-order test is the highest-value test in this plan.** If someone later moves the route below `paidSyncMiddleware`, `ensureSyncVaultAllowed` silently re-creates the vault mid-request and delete becomes a no-op that still returns 200. The test must fail loudly.

- [ ] **Step 1: Write the failing test**

There is no real database here (`sync.test.ts:157` is `DB: {} as D1Database`). Mock the service and assert the route's contract: ownership check, status codes, and mount order.

Add to the existing `vi.mock` block set at the top of `sync.test.ts`:

```ts
vi.mock('../services/vault-deletion', () => ({
  vaultExistsForUser: vi.fn().mockResolvedValue(true),
  deleteVaultData: vi.fn().mockResolvedValue(undefined)
}))
```

and import alongside the other service imports (near line 121):

```ts
import { deleteVaultData, vaultExistsForUser } from '../services/vault-deletion'
```

Then append the suite. `createEnv()` and the app/request setup already exist in this file (see `env = createEnv()` at line 232) — reuse them exactly as the neighbouring `/vaults` suites do rather than inventing a new harness.

```ts
describe('DELETE /sync/vaults/:vaultId', () => {
  beforeEach(() => {
    vi.mocked(vaultExistsForUser).mockResolvedValue(true)
    vi.mocked(deleteVaultData).mockResolvedValue(undefined)
  })

  it('purges the vault and returns success', async () => {
    const res = await app.request(
      '/sync/vaults/vault-a',
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      env
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(deleteVaultData).toHaveBeenCalledWith(env.DB, env.STORAGE, userId, 'vault-a')
  })

  it('checks ownership scoped to the caller', async () => {
    await app.request(
      '/sync/vaults/vault-a',
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      env
    )

    expect(vaultExistsForUser).toHaveBeenCalledWith(env.DB, userId, 'vault-a')
  })

  it('404s and purges nothing when the caller does not own the vault', async () => {
    vi.mocked(vaultExistsForUser).mockResolvedValue(false)

    const res = await app.request(
      '/sync/vaults/someone-elses',
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      env
    )

    expect(res.status).toBe(404)
    expect(deleteVaultData).not.toHaveBeenCalled()
  })

  it('400s on a malformed vault id', async () => {
    const res = await app.request(
      '/sync/vaults/not%20a%20valid%20id!',
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      env
    )

    expect(res.status).toBe(400)
    expect(deleteVaultData).not.toHaveBeenCalled()
  })

  it('401s without a token', async () => {
    const res = await app.request('/sync/vaults/vault-a', { method: 'DELETE' }, env)
    expect(res.status).toBe(401)
    expect(deleteVaultData).not.toHaveBeenCalled()
  })

  // REGRESSION — the sharpest edge in this feature.
  // paidSyncMiddleware runs ensureSyncVaultAllowed, which UPSERTS. If this route
  // ever registers below that middleware, the vault is re-created mid-request
  // and delete silently becomes a no-op that still returns 200.
  // Same probe as the existing assertion at sync.test.ts:391.
  it('does not run ensureSyncVaultAllowed (would resurrect the vault)', async () => {
    await app.request(
      '/sync/vaults/vault-a',
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, 'X-Memry-Vault-Id': 'vault-a' }
      },
      env
    )

    expect(
      ensureSyncVaultAllowed,
      'DELETE must register above paidSyncMiddleware'
    ).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/sync-server test -- sync.test.ts -t "DELETE /sync/vaults"`
Expected: FAIL — 404 on every case (route does not exist).

- [ ] **Step 3: Write minimal implementation**

Add the import to `apps/sync-server/src/routes/sync.ts` alongside the other service imports:

```ts
import { deleteVaultData, vaultExistsForUser } from '../services/vault-deletion'
```

Insert **between** line 103 (`sync.post('/vaults', ...)`) and line 105 (`sync.use('*', paidSyncMiddleware)`):

```ts
// Auth-only like GET/POST /vaults, and registered before paidSyncMiddleware for
// a sharper reason: that middleware runs ensureSyncVaultAllowed, which UPSERTS.
// Below it, this route would have its own target re-created mid-request.
const handleDeleteVault = async (c: Context<AppContext>): Promise<Response> => {
  const userId = c.get('userId')!
  const vaultId = c.req.param('vaultId')

  if (!vaultId || !/^[a-zA-Z0-9_-]{1,128}$/.test(vaultId)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid vault id', 400)
  }

  if (!(await vaultExistsForUser(c.env.DB, userId, vaultId))) {
    throw new AppError(ErrorCodes.SYNC_VAULT_NOT_FOUND, 'Vault not found', 404)
  }

  await deleteVaultData(c.env.DB, c.env.STORAGE, userId, vaultId)

  safeWaitUntil(c, captureBusinessEvent(c.env, 'vault_deleted', userId, {}))

  return c.json({ success: true })
}

sync.delete('/vaults/:vaultId', vaultsRateLimit, handleDeleteVault)
```

**`ErrorCodes.SYNC_VAULT_NOT_FOUND` does not exist yet** — `lib/errors.ts:38` has only `SYNC_VAULT_LIMIT_EXCEEDED`. Add it additively next to that one; do not reuse an unrelated code:

```ts
  SYNC_VAULT_NOT_FOUND: 'SYNC_VAULT_NOT_FOUND',
```

(`c.env.STORAGE` is confirmed correct — `src/types.ts:3`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/sync-server test -- sync.test.ts -t "DELETE /sync/vaults"`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full server suite**

Run: `pnpm test:sync-server`
Expected: PASS. Note `d1.test.ts` has a known parallel flake — re-run it alone before believing a failure there.

- [ ] **Step 6: Commit**

```bash
git add apps/sync-server/src/routes/sync.ts apps/sync-server/src/routes/sync.test.ts apps/sync-server/src/lib/errors.ts
git commit -m "feat(sync-server): add DELETE /sync/vaults/:vaultId"
```

---

### Task 4: Verify entitlement vault limits (mostly already done)

**Files:**

- Read: `apps/sync-server/src/services/entitlements.test.ts`
- Modify: same file, only if a gap is confirmed

**Interfaces:**

- Consumes: nothing. Produces: nothing.

**Read this before doing anything.** The requirement "plus=1, pro=10, believer=unlimited" is **already implemented and already tested**:

- `services/entitlements.ts:44-69` — `SYNC_PLAN_LIMITS` encodes free `0`, plus `1`, pro `10`, believer `null`.
- `services/entitlements.test.ts:89-104` — "defines the paid plan limits requested for Plus, Pro, and Believer" asserts `maxVaults` for all three via `toEqual`.
- `services/entitlements.test.ts:217` — "blocks a second synced vault for Plus" covers enforcement.

**No production change. Probably no test change.** This task exists to confirm that, not to manufacture work.

**Why there is no "delete frees a slot" integration test:** this package has no real database — `sync.test.ts:157` is `DB: {} as D1Database` and every service test hand-rolls `vi` doubles. A "Pro at 10 → delete → 11th succeeds" test would have to mock the `COUNT(*)` response, which makes it assert that a mock returns a smaller number. That is tautological and worse than no test.

The property is genuinely covered by composition instead:

- Task 2 proves `deleteVaultData` emits `DELETE FROM sync_vaults WHERE user_id = ? AND vault_id = ?`.
- `entitlements.ts:205` counts exactly those rows.
- Task 8's E2E exercises the real path against the real D1-backed `TestSyncServer`.

If a real slot-freeing assertion is wanted, E2E is the only honest place for it. Note it there; do not fake it here.

- [ ] **Step 1: Confirm the existing coverage**

Run: `pnpm --filter @memry/sync-server test -- entitlements.test.ts`
Expected: PASS, including "defines the paid plan limits requested for Plus, Pro, and Believer" and "blocks a second synced vault for Plus".

- [ ] **Step 2: Check for one real gap**

Read the file and determine whether **Pro's 10-vault cap enforcement** is exercised, or only the constant. Plus enforcement exists at `:217`; Pro may not.

If Pro enforcement is absent, add one test mirroring the `:217` structure exactly (same mock setup, same shape) with the count at the Pro boundary:

```ts
it('blocks an eleventh synced vault for Pro', async () => {
  // Mirror the mock setup from 'blocks a second synced vault for Plus' (:217),
  // substituting the pro entitlement and a COUNT(*) response of 10.
  await expect(
    ensureSyncVaultAllowed(db as unknown as D1Database, 'user-1', 'v10', proEntitlement)
  ).rejects.toMatchObject({ statusCode: 402 })
})
```

If Pro enforcement is already covered, **add nothing** and say so.

- [ ] **Step 3: Commit (only if a test was added)**

```bash
git add apps/sync-server/src/services/entitlements.test.ts
git commit -m "test(sync-server): cover pro vault cap enforcement"
```

---

### Task 5: IPC contract + main handler

**Files:**

- Modify: `packages/contracts/src/ipc-channels.ts:38-56`
- Modify: `packages/contracts/src/vault-api.ts:127-177`
- Modify: `apps/desktop/src/main/sync/vault-directory.ts`
- Modify: `apps/desktop/src/main/ipc/vault-handlers.ts:107`
- Test: `apps/desktop/src/main/sync/vault-directory.test.ts` (append; create if absent)

**Interfaces:**

- Consumes: `DELETE /sync/vaults/:vaultId` from Task 3; `deleteFromServer` (already exists at `http-client.ts:152`).
- Produces:
  - Channel constant `VaultChannels.invoke.DELETE_FROM_ACCOUNT = 'vault:delete-from-account'`
  - `deleteAccountVault(vaultUuid: string): Promise<void>` in `vault-directory.ts`
  - Renderer method `window.api.vault.deleteFromAccount(vaultUuid: string): Promise<void>`

**Why not reuse `vault:remove`:** it takes a `vaultPath` and only filters the local store. A path cannot address a cloud-only vault — the exact case that matters. Its dialog also promises files remain, a contract overloading would break.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  deleteFromServer: vi.fn(),
  getValidAccessToken: vi.fn(),
  getVaults: vi.fn(),
  removeVaultFromStore: vi.fn(),
  getCurrentVaultPath: vi.fn()
}))

vi.mock('./http-client', () => ({ deleteFromServer: mocks.deleteFromServer }))
vi.mock('./token-manager', () => ({ getValidAccessToken: mocks.getValidAccessToken }))
vi.mock('../store', () => ({
  getVaults: mocks.getVaults,
  removeVaultFromStore: mocks.removeVaultFromStore,
  getCurrentVaultPath: mocks.getCurrentVaultPath,
  getAccountVaultsCache: () => null,
  setAccountVaultsCache: vi.fn()
}))

import { deleteAccountVault } from './vault-directory'

describe('deleteAccountVault', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getValidAccessToken.mockResolvedValue('tok')
    mocks.getVaults.mockReturnValue([])
    mocks.getCurrentVaultPath.mockReturnValue('/vaults/Active')
    mocks.deleteFromServer.mockResolvedValue({ success: true })
  })

  it('calls the server with the url-encoded vault uuid', async () => {
    await deleteAccountVault('uuid-a')
    expect(mocks.deleteFromServer).toHaveBeenCalledWith('/sync/vaults/uuid-a', 'tok')
  })

  // Without this, refreshVaultDirectory re-registers the vault on next launch
  // and the delete silently undoes itself.
  it('removes the local store entry so it cannot re-register', async () => {
    mocks.getVaults.mockReturnValue([{ path: '/vaults/Old', name: 'Old', vaultUuid: 'uuid-a' }])
    await deleteAccountVault('uuid-a')
    expect(mocks.removeVaultFromStore).toHaveBeenCalledWith('/vaults/Old')
  })

  it('succeeds for a cloud-only vault with no local entry', async () => {
    await expect(deleteAccountVault('uuid-a')).resolves.toBeUndefined()
    expect(mocks.removeVaultFromStore).not.toHaveBeenCalled()
  })

  it('refuses to delete the active vault', async () => {
    mocks.getVaults.mockReturnValue([
      { path: '/vaults/Active', name: 'Active', vaultUuid: 'uuid-a' }
    ])
    await expect(deleteAccountVault('uuid-a')).rejects.toThrow(/active vault/i)
    expect(mocks.deleteFromServer).not.toHaveBeenCalled()
  })

  it('throws when signed out', async () => {
    mocks.getValidAccessToken.mockResolvedValue(null)
    await expect(deleteAccountVault('uuid-a')).rejects.toThrow(/sign/i)
    expect(mocks.deleteFromServer).not.toHaveBeenCalled()
  })

  it('leaves the local entry alone when the server call fails', async () => {
    mocks.getVaults.mockReturnValue([{ path: '/vaults/Old', name: 'Old', vaultUuid: 'uuid-a' }])
    mocks.deleteFromServer.mockRejectedValue(new Error('boom'))
    await expect(deleteAccountVault('uuid-a')).rejects.toThrow('boom')
    expect(mocks.removeVaultFromStore).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- vault-directory.test.ts`
Expected: FAIL — `deleteAccountVault` is not exported.

- [ ] **Step 3: Add the channel constant**

In `packages/contracts/src/ipc-channels.ts`, inside `VaultChannels.invoke`, after `DOWNLOAD_REMOTE` (line 55):

```ts
    /** Provision + open a cloud-only vault locally */
    DOWNLOAD_REMOTE: 'vault:download-remote',
    /** Purge a vault from the sync account; never touches files on disk */
    DELETE_FROM_ACCOUNT: 'vault:delete-from-account'
```

- [ ] **Step 4: Add the contract types**

In `packages/contracts/src/vault-api.ts`, in the invoke map after line 137:

```ts
  [VaultChannels.invoke.DELETE_FROM_ACCOUNT]: (vaultUuid: string) => Promise<void>
```

and in `VaultClientAPI` after line 176:

```ts
  deleteFromAccount(vaultUuid: string): Promise<void>
```

- [ ] **Step 5: Implement `deleteAccountVault`**

In `apps/desktop/src/main/sync/vault-directory.ts`, add `removeVaultFromStore` to the existing `../store` import block (lines 11-16), add `deleteFromServer` to the `./http-client` import (line 17), then append:

```ts
/**
 * Purge a vault from the sync account and drop its local list entry.
 *
 * Both halves always run together: refreshVaultDirectory self-registers every
 * local vault, so a server-only delete would resurrect itself on the next
 * refresh. Files on disk are never touched.
 */
export async function deleteAccountVault(vaultUuid: string): Promise<void> {
  const local = getVaults().find((v) => v.vaultUuid === vaultUuid)
  if (local && local.path === getCurrentVaultPath()) {
    throw new Error('Cannot delete the active vault. Switch to another vault first.')
  }

  const token = await getValidAccessToken()
  if (!token) {
    throw new Error('Sign in to delete a vault from your account.')
  }

  await deleteFromServer(`/sync/vaults/${encodeURIComponent(vaultUuid)}`, token)

  if (local) removeVaultFromStore(local.path)

  log.info('Vault deleted from account', { vaultUuid, hadLocalCopy: !!local })
}
```

- [ ] **Step 6: Register the handler**

In `apps/desktop/src/main/ipc/vault-handlers.ts`, after line 107 (`vault:remove`):

```ts
// vault:delete-from-account - Purge vault from sync account (never deletes files)
ipcMain.handle(
  VaultChannels.invoke.DELETE_FROM_ACCOUNT,
  createStringHandler(async (vaultUuid) => {
    const { deleteAccountVault, refreshVaultDirectory } = await import('../sync/vault-directory')
    await deleteAccountVault(vaultUuid)
    await refreshVaultDirectory({ force: true })
  })
)
```

The forced refresh repopulates the account cache so the switcher's "In your account" list drops the row immediately (`listAccountVaults` reads that cache).

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- vault-directory.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 8: Regenerate and check the IPC map**

Run: `pnpm ipc:generate && pnpm ipc:check`
Expected: invoke map regenerated with the new channel; check passes.

Then verify preload exposes it — inspect `apps/desktop/src/preload/index.ts` and its `index.d.ts`. If the vault API surface is hand-listed there, add `deleteFromAccount` alongside `downloadRemote`.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts apps/desktop/src/main apps/desktop/src/preload
git commit -m "feat(vault): add vault:delete-from-account IPC channel"
```

---

### Task 6: Vault switcher delete affordance

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/vault-switcher.tsx`
- Modify: `packages/i18n/src/locales/en/common.json`
- Modify: `apps/desktop/tests/setup-dom.ts:97-108`
- Create: `apps/desktop/src/renderer/src/components/vault-switcher.test.tsx`

**Interfaces:**

- Consumes: `window.api.vault.deleteFromAccount` from Task 5.
- Produces: nothing consumed downstream.

**UI shape (see locked decision 7 — hover icons, not a `⋯` menu):**

- Local non-active row: `X` (remove from list, unchanged) + `Trash2` (delete from account), both hover-revealed.
- Active row: neither icon.
- Remote "In your account" row: `Trash2` only (clicking the row already downloads).

- [ ] **Step 1: Add i18n keys**

In `packages/i18n/src/locales/en/common.json`, inside the `phaseF.componentsVaultSwitcher` object:

```json
"deleteFromAccount": "Delete from account",
"deleteVaultTitle": "Delete “{name}” from your account?",
"deleteVaultBody": "This permanently removes all synced data for this vault from Memry's servers and cannot be undone. Your files on disk are not deleted.",
"deleteVaultConfirm": "Delete from account",
"deleteVaultFailed": "Could not delete vault"
```

Note ICU single braces: `{name}`, not `{{name}}`.

- [ ] **Step 2: Add the mock method**

In `apps/desktop/tests/setup-dom.ts`, in the `vault` block (lines 97-108), alongside `remove`:

```ts
    deleteFromAccount: vi.fn().mockResolvedValue(undefined),
```

- [ ] **Step 3: Write the failing test**

Create `apps/desktop/src/renderer/src/components/vault-switcher.test.tsx`. Copy the `@/components/ui/picker` mock verbatim from `cold-major-components.test.tsx:189-218` — a real Radix Popover will not open in jsdom.

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import React from 'react'

const mocks = vi.hoisted(() => ({
  status: { path: '/vaults/Active' } as { path: string } | null,
  vaults: [
    { path: '/vaults/Active', name: 'Active', vaultUuid: 'uuid-active' },
    { path: '/vaults/Old', name: 'Old', vaultUuid: 'uuid-old' }
  ],
  accountVaults: [
    { vaultUuid: 'uuid-cloud', name: 'Cloud', itemCount: 12, localPath: null, createdAt: null }
  ],
  removeVault: vi.fn().mockResolvedValue(undefined),
  switchVault: vi.fn(),
  selectVault: vi.fn(),
  openSettings: vi.fn(),
  refresh: vi.fn()
}))

vi.mock('@/components/ui/picker', async () => {
  const PickerContext = React.createContext<(value: string) => void>(() => {})
  function Picker({
    children,
    onValueChange
  }: {
    children: ReactNode
    onValueChange: (value: string) => void
  }) {
    return <PickerContext.Provider value={onValueChange}>{children}</PickerContext.Provider>
  }
  Picker.Trigger = ({ children }: { children: ReactNode }) => <>{children}</>
  Picker.Content = ({ children }: { children: ReactNode }) => <div>{children}</div>
  Picker.List = ({ children }: { children: ReactNode }) => <div>{children}</div>
  Picker.Separator = () => <hr />
  Picker.Empty = ({ message }: { message: string }) => <div>{message}</div>
  Picker.Item = ({ value, label }: { value: string; label: string }) => {
    const onValueChange = React.useContext(PickerContext)
    return (
      <button type="button" onClick={() => onValueChange(value)}>
        {label}
      </button>
    )
  }
  return { Picker }
})

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars?.name ? `${key}:${vars.name}` : key)
  })
}))
vi.mock('@/hooks/use-vault', () => ({
  useVault: () => ({
    status: mocks.status,
    isLoading: false,
    selectVault: mocks.selectVault,
    switchVault: mocks.switchVault
  }),
  useVaultList: () => ({ vaults: mocks.vaults, removeVault: mocks.removeVault })
}))
vi.mock('@/hooks/use-account-vaults', () => ({
  useAccountVaults: () => ({ accountVaults: mocks.accountVaults, refresh: mocks.refresh })
}))
vi.mock('@/contexts/settings-modal-context', () => ({
  useSettingsModal: () => ({ open: mocks.openSettings })
}))
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ state: { status: 'authenticated', email: 'k@example.com' } })
}))
vi.mock('@/components/ui/sidebar', () => ({
  SidebarMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenuButton: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  useSidebar: () => ({ isMobile: false })
}))
vi.mock('@/components/download-vault-dialog', () => ({
  DownloadVaultDialog: () => null
}))

import { VaultSwitcher } from './vault-switcher'

describe('VaultSwitcher delete from account', () => {
  beforeEach(() => vi.clearAllMocks())

  it('offers delete on a local non-active vault', async () => {
    render(<VaultSwitcher />)
    fireEvent.click(screen.getByLabelText('Delete Old from account'))
    fireEvent.click(screen.getByText('phaseF.componentsVaultSwitcher.deleteVaultConfirm'))
    await waitFor(() => expect(window.api.vault.deleteFromAccount).toHaveBeenCalledWith('uuid-old'))
  })

  it('offers delete on a cloud-only vault', async () => {
    render(<VaultSwitcher />)
    fireEvent.click(screen.getByLabelText('Delete Cloud from account'))
    fireEvent.click(screen.getByText('phaseF.componentsVaultSwitcher.deleteVaultConfirm'))
    await waitFor(() =>
      expect(window.api.vault.deleteFromAccount).toHaveBeenCalledWith('uuid-cloud')
    )
  })

  it('never offers delete on the active vault', () => {
    render(<VaultSwitcher />)
    expect(screen.queryByLabelText('Delete Active from account')).not.toBeInTheDocument()
  })

  it('keeps remove-from-list separate from delete', async () => {
    render(<VaultSwitcher />)
    fireEvent.click(screen.getByLabelText('Remove Old from list'))
    fireEvent.click(screen.getByText('phaseF.componentsVaultSwitcher.remove2'))
    await waitFor(() => expect(mocks.removeVault).toHaveBeenCalledWith('/vaults/Old'))
    expect(window.api.vault.deleteFromAccount).not.toHaveBeenCalled()
  })

  it('does not call the IPC when the confirm is cancelled', () => {
    render(<VaultSwitcher />)
    fireEvent.click(screen.getByLabelText('Delete Old from account'))
    fireEvent.click(screen.getByText('phaseF.componentsVaultSwitcher.cancel'))
    expect(window.api.vault.deleteFromAccount).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- vault-switcher.test.tsx`
Expected: FAIL — no element labelled `Delete Old from account`.

Note: the renderer project must be selected. If the runner picks up the wrong project, use `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer vault-switcher.test.tsx`.

- [ ] **Step 5: Implement**

In `vault-switcher.tsx`:

Add `Trash2` to the icon import (line 4) and `extractErrorMessage` from `@/lib/ipc-error`.

Add state and handlers alongside the existing ones (after line 40):

```tsx
const [vaultToDelete, setVaultToDelete] = useState<{ uuid: string; name: string } | null>(null)
const [deleting, setDeleting] = useState(false)
const [deleteError, setDeleteError] = useState<string | null>(null)

const handleDeleteClick = (e: React.MouseEvent, uuid: string, name: string): void => {
  e.stopPropagation()
  setDeleteError(null)
  setVaultToDelete({ uuid, name })
}

const handleConfirmDelete = useCallback(async () => {
  if (!vaultToDelete) return
  setDeleting(true)
  try {
    await window.api.vault.deleteFromAccount(vaultToDelete.uuid)
    setVaultToDelete(null)
    await refreshAccountVaults()
  } catch (err) {
    setDeleteError(
      extractErrorMessage(err, tPhaseF('phaseF.componentsVaultSwitcher.deleteVaultFailed'))
    )
  } finally {
    setDeleting(false)
  }
}, [vaultToDelete, refreshAccountVaults, tPhaseF])
```

In the local-vault row, extend the existing `{!isActive && (...)}` block (lines 149-163) to render the trash icon after the X. Both live in one wrapper so they share the hover reveal:

```tsx
{
  !isActive && (
    <span className="flex items-center gap-0.5 opacity-0 group-hover/vault:opacity-100 transition-all">
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => handleRemoveClick(e, vault)}
        onKeyDown={(e) =>
          e.key === 'Enter' && handleRemoveClick(e as unknown as React.MouseEvent, vault)
        }
        className="size-5 flex items-center justify-center rounded hover:bg-accent"
        aria-label={`Remove ${vault.name} from list`}
      >
        <X className="size-3 text-muted-foreground" />
      </span>
      {vault.vaultUuid && isAuthenticated && (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => handleDeleteClick(e, vault.vaultUuid!, vault.name)}
          onKeyDown={(e) =>
            e.key === 'Enter' &&
            handleDeleteClick(e as unknown as React.MouseEvent, vault.vaultUuid!, vault.name)
          }
          className="size-5 flex items-center justify-center rounded hover:bg-destructive/10"
          aria-label={`Delete ${vault.name} from account`}
        >
          <Trash2 className="size-3 text-muted-foreground" />
        </span>
      )}
    </span>
  )
}
```

In the remote row (lines 177-197), the outer element is a `<button>`, so the delete control cannot be a nested `<button>`. Keep the `role="button"` `<span>` idiom and `stopPropagation` so it does not trigger download:

```tsx
<span
  role="button"
  tabIndex={0}
  onClick={(e) =>
    handleDeleteClick(
      e,
      vault.vaultUuid,
      vault.name ?? tPhaseF('phaseF.componentsVaultSwitcher.untitledVault')
    )
  }
  onKeyDown={(e) =>
    e.key === 'Enter' &&
    handleDeleteClick(
      e as unknown as React.MouseEvent,
      vault.vaultUuid,
      vault.name ?? tPhaseF('phaseF.componentsVaultSwitcher.untitledVault')
    )
  }
  className="size-5 flex items-center justify-center rounded hover:bg-destructive/10"
  aria-label={`Delete ${vault.name ?? 'vault'} from account`}
>
  <Trash2 className="size-3 text-muted-foreground" />
</span>
```

Add the delete confirm dialog next to the existing one (after line 253):

```tsx
<AlertDialog
  open={!!vaultToDelete}
  onOpenChange={(o) => {
    if (!o) {
      setVaultToDelete(null)
      setDeleteError(null)
    }
  }}
>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>
        {tPhaseF('phaseF.componentsVaultSwitcher.deleteVaultTitle', {
          name: vaultToDelete?.name ?? ''
        })}
      </AlertDialogTitle>
      <AlertDialogDescription>
        {tPhaseF('phaseF.componentsVaultSwitcher.deleteVaultBody')}
      </AlertDialogDescription>
    </AlertDialogHeader>
    {deleteError && <p className="text-xs/4 text-destructive px-1">{deleteError}</p>}
    <AlertDialogFooter>
      <AlertDialogCancel disabled={deleting}>
        {tPhaseF('phaseF.componentsVaultSwitcher.cancel')}
      </AlertDialogCancel>
      <AlertDialogAction
        onClick={(e) => {
          e.preventDefault()
          void handleConfirmDelete()
        }}
        disabled={deleting}
        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
      >
        {tPhaseF('phaseF.componentsVaultSwitcher.deleteVaultConfirm')}
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

Import `AlertDialogCancel` and `AlertDialogAction` from `@/components/ui/alert-dialog` (extend the import at lines 13-20).

- [ ] **Step 6: Fix the `&` bug in the existing dialog title**

Line 236 currently emits a literal `&`:

```tsx
              {tPhaseF('phaseF.componentsVaultSwitcher.remove')}
              {vaultToRemove?.name}&{tPhaseF('phaseF.componentsVaultSwitcher.rdquoFromList')}
```

Replace those two lines with a single interpolated key:

```tsx
{
  tPhaseF('phaseF.componentsVaultSwitcher.removeVaultTitle', {
    name: vaultToRemove?.name ?? ''
  })
}
```

Add to `common.json` under the same object, and leave the old `remove` / `rdquoFromList` keys in place (other locales still reference them; removing them is out of scope):

```json
"removeVaultTitle": "Remove “{name}” from list?",
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @memry/desktop test:renderer -- vault-switcher.test.tsx`
Expected: PASS (5 tests).

Then confirm the pre-existing omnibus case still passes — it asserts on `Remove Side from list` and `remove2`, both preserved:

Run: `pnpm --filter @memry/desktop test:renderer -- cold-major-components.test.tsx`
Expected: PASS.

- [ ] **Step 8: Check i18n**

Run: `pnpm --filter @memry/desktop i18n:check`
Expected: PASS. `missingLocales` warnings for non-English locales are warnings, not failures.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/renderer/src/components/vault-switcher.tsx apps/desktop/src/renderer/src/components/vault-switcher.test.tsx apps/desktop/tests/setup-dom.ts packages/i18n/src/locales/en/common.json
git commit -m "feat(vault): delete from account in the vault switcher"
```

---

### Task 7: Settings → Vault account list

**Files:**

- Modify: `apps/desktop/src/renderer/src/pages/settings/vault-section.tsx`
- Modify: `packages/i18n/src/locales/en/settings.json`
- Create: `apps/desktop/src/renderer/src/pages/settings/vault-section.test.tsx`

**Interfaces:**

- Consumes: `window.api.vault.deleteFromAccount` (Task 5), `window.api.vault.listAccount()`, `useAccountVaults`.
- Produces: nothing.

**Why a list, not a Danger Zone:** the section is scoped to the current vault, and the active vault cannot be deleted (spec D4/D5). A Danger Zone here would always be disabled. The list is also the surface that matches the original complaint ("I see two in my account").

Settings needs no routing work: `VaultSettings` is already imported (`settings.tsx:26`), in the nav (145-151), and rendered (182).

- [ ] **Step 1: Add i18n keys**

In `packages/i18n/src/locales/en/settings.json`, inside the `vault` object:

```json
"groups": {
  "accountVaults": "Vaults in your account"
},
"accountVaults": {
  "empty": "No vaults synced to your account yet.",
  "signedOut": "Sign in to see the vaults in your account.",
  "active": "Active",
  "cloudOnly": "Not on this device",
  "itemsCount": "{count} items",
  "delete": "Delete",
  "deleteTitle": "Delete “{name}” from your account?",
  "deleteBody": "This permanently removes all synced data for this vault from Memry's servers and cannot be undone. Your files on disk are not deleted.",
  "deleteConfirm": "Delete from account",
  "deleteFailed": "Could not delete vault",
  "activeHint": "Switch to another vault to delete this one."
}
```

Merge into the existing `vault.groups` object rather than replacing it — `storageUsage` and `location` already live there.

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/src/renderer/src/pages/settings/vault-section.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  accountVaults: [
    {
      vaultUuid: 'uuid-active',
      name: 'Active',
      itemCount: 3,
      localPath: '/vaults/Active',
      createdAt: null
    },
    { vaultUuid: 'uuid-old', name: 'Old', itemCount: 9, localPath: null, createdAt: null }
  ],
  refresh: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars?.name ? `${key}:${vars.name}` : key)
  })
}))
vi.mock('@/hooks/use-storage-usage', () => ({
  useStorageUsage: () => ({ data: null, loading: false, refresh: vi.fn() })
}))
vi.mock('@/hooks/use-account-vaults', () => ({
  useAccountVaults: () => ({ accountVaults: mocks.accountVaults, refresh: mocks.refresh })
}))

import { VaultSettings } from './vault-section'

describe('VaultSettings account vaults', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.api.vault.getStatus = vi.fn().mockResolvedValue({ path: '/vaults/Active' })
  })

  it('lists every vault in the account', async () => {
    render(<VaultSettings />)
    expect(await screen.findByText('Active')).toBeInTheDocument()
    expect(screen.getByText('Old')).toBeInTheDocument()
  })

  it('deletes a non-active vault after confirmation', async () => {
    render(<VaultSettings />)
    fireEvent.click(await screen.findByLabelText('Delete Old from account'))
    fireEvent.click(screen.getByText('vault.accountVaults.deleteConfirm'))
    await waitFor(() => expect(window.api.vault.deleteFromAccount).toHaveBeenCalledWith('uuid-old'))
  })

  it('disables delete for the active vault', async () => {
    render(<VaultSettings />)
    await screen.findByText('Active')
    expect(screen.getByLabelText('Delete Active from account')).toBeDisabled()
  })

  it('does not delete when cancelled', async () => {
    render(<VaultSettings />)
    fireEvent.click(await screen.findByLabelText('Delete Old from account'))
    fireEvent.click(screen.getByText('vault.accountVaults.cancel'))
    expect(window.api.vault.deleteFromAccount).not.toHaveBeenCalled()
  })
})
```

If `settings.json` has no `cancel` under `vault.accountVaults`, use the shared cancel key the other settings dialogs use — check `account-section.tsx:517-538` and match it. Update the test's expected key to whatever that is.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- vault-section.test.tsx`
Expected: FAIL — no `Old` text, no delete control.

- [ ] **Step 4: Implement**

In `vault-section.tsx`, add imports:

```tsx
import { useAccountVaults } from '@/hooks/use-account-vaults'
import { extractErrorMessage } from '@/lib/ipc-error'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
```

Add state inside `VaultSettings` after line 24:

```tsx
const { accountVaults, refresh: refreshAccountVaults } = useAccountVaults()
const [vaultToDelete, setVaultToDelete] = useState<{ uuid: string; name: string } | null>(null)
const [deleting, setDeleting] = useState(false)
const [deleteError, setDeleteError] = useState<string | null>(null)

const handleConfirmDelete = useCallback(async () => {
  if (!vaultToDelete) return
  setDeleting(true)
  try {
    await window.api.vault.deleteFromAccount(vaultToDelete.uuid)
    setVaultToDelete(null)
    await refreshAccountVaults()
  } catch (err) {
    setDeleteError(extractErrorMessage(err, t('vault.accountVaults.deleteFailed')))
  } finally {
    setDeleting(false)
  }
}, [vaultToDelete, refreshAccountVaults, t])
```

Add the group between the Storage Usage group (ends line 114) and the Location group (line 116):

```tsx
<SettingsGroup label={t('vault.groups.accountVaults')}>
  {accountVaults.length === 0 ? (
    <div className="py-3 px-4">
      <p className="text-xs/4 text-muted-foreground">{t('vault.accountVaults.empty')}</p>
    </div>
  ) : (
    accountVaults.map((vault) => {
      const isActive = !!vault.localPath && vault.localPath === vaultPath
      const name = vault.name ?? vault.vaultUuid
      return (
        <SettingRow
          key={vault.vaultUuid}
          label={name}
          description={
            isActive
              ? t('vault.accountVaults.activeHint')
              : (vault.localPath ??
                `${t('vault.accountVaults.cloudOnly')} · ${t('vault.accountVaults.itemsCount', { count: vault.itemCount })}`)
          }
        >
          <Button
            variant="outline"
            size="sm"
            disabled={isActive}
            onClick={() => {
              setDeleteError(null)
              setVaultToDelete({ uuid: vault.vaultUuid, name })
            }}
            aria-label={`Delete ${name} from account`}
            className="h-7 px-3 text-xs/4 text-destructive border-destructive/30 hover:bg-destructive/10"
          >
            {t('vault.accountVaults.delete')}
          </Button>
        </SettingRow>
      )
    })
  )}
</SettingsGroup>
```

The button styling copies the sign-out pattern at `account-section.tsx:499-513` — outline with destructive tint, not solid.

Add the dialog before the closing `</div>` (line 129):

```tsx
<AlertDialog
  open={!!vaultToDelete}
  onOpenChange={(o) => {
    if (!o) {
      setVaultToDelete(null)
      setDeleteError(null)
    }
  }}
>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>
        {t('vault.accountVaults.deleteTitle', { name: vaultToDelete?.name ?? '' })}
      </AlertDialogTitle>
      <AlertDialogDescription>{t('vault.accountVaults.deleteBody')}</AlertDialogDescription>
    </AlertDialogHeader>
    {deleteError && <p className="text-xs/4 text-destructive px-1">{deleteError}</p>}
    <AlertDialogFooter>
      <AlertDialogCancel disabled={deleting}>{t('vault.accountVaults.cancel')}</AlertDialogCancel>
      <AlertDialogAction
        onClick={(e) => {
          e.preventDefault()
          void handleConfirmDelete()
        }}
        disabled={deleting}
        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
      >
        {t('vault.accountVaults.deleteConfirm')}
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- vault-section.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Verify the settings i18n test still passes**

Run: `pnpm --filter @memry/desktop test:renderer -- settings-page.i18n.test.tsx settings-sections.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/settings/vault-section.tsx apps/desktop/src/renderer/src/pages/settings/vault-section.test.tsx packages/i18n/src/locales/en/settings.json
git commit -m "feat(vault): list and delete account vaults in settings"
```

---

### Task 8: E2E

**Files:**

- Create: `apps/desktop/tests/e2e/vault-deletion.e2e.ts`

**Interfaces:**

- Consumes: everything above.
- Produces: nothing.

Two scenarios from the spec. Scenario 2 is the one that matters — it is the only test that catches a regression turning delete into data loss.

Use the real `TestSyncServer` (`tests/e2e/utils/sync-backend.ts`, `startSharedSyncBootstrap()`); E2E runs a real D1-backed server and signed-in state is reachable. Model the setup on `shared-sync-bootstrap.e2e.ts` / `account-sync.e2e.ts`. **Do not** model on `vault.e2e.ts` — it is `@ts-nocheck` with soft assertions (`.isVisible().catch(() => false)`, no expect) and is not a baseline worth copying.

- [ ] **Step 1: Write the spec**

```ts
import fs from 'fs'
import path from 'path'
import { test, expect } from './fixtures'
import { waitForAppReady, waitForVaultReady } from './utils/electron-helpers'

test.describe('vault deletion', () => {
  test('deletes a cloud-only vault from the account', async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)

    // Register a vault that exists only on the server (no local copy).
    const uuid = await page.evaluate(async () => {
      const id = 'e2e-cloud-only'
      await window.api.vault.listAccount()
      return id
    })

    const before = await page.evaluate(() => window.api.vault.listAccount())
    expect(before.some((v) => v.vaultUuid === uuid)).toBe(true)

    await page.evaluate((id) => window.api.vault.deleteFromAccount(id), uuid)

    const after = await page.evaluate(() => window.api.vault.listAccount())
    expect(after.some((v) => v.vaultUuid === uuid)).toBe(false)
  })

  // THE guarantee: delete must never destroy files on disk.
  test('leaves files on disk untouched when deleting a local vault', async ({
    page,
    testVaultPath
  }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)

    // A second vault, because the fixture's vault is active and D4 forbids
    // deleting the active one.
    const secondPath = path.join(path.dirname(testVaultPath), 'e2e-second-vault')
    fs.mkdirSync(path.join(secondPath, 'notes'), { recursive: true })
    fs.writeFileSync(path.join(secondPath, 'notes', 'keep-me.md'), '# keep me\n')

    const uuid = await page.evaluate(async (p) => {
      const res = await window.api.vault.create(p, 'Second')
      return res.success ? res.vault?.vaultUuid : null
    }, secondPath)
    expect(uuid).toBeTruthy()

    // create() opens the new vault; switch back so it is not active.
    await page.evaluate((p) => window.api.vault.switch(p), testVaultPath)
    await waitForVaultReady(page)

    await page.evaluate((id) => window.api.vault.deleteFromAccount(id), uuid)

    expect(fs.existsSync(secondPath), 'vault folder must survive').toBe(true)
    expect(
      fs.readFileSync(path.join(secondPath, 'notes', 'keep-me.md'), 'utf8'),
      'notes must survive'
    ).toContain('keep me')

    fs.rmSync(secondPath, { recursive: true, force: true })
  })

  test('refuses to delete the active vault', async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)

    const activeUuid = await page.evaluate(async () => {
      const vaults = await window.api.vault.listAccount()
      return vaults.find((v) => v.localPath)?.vaultUuid ?? null
    })
    test.skip(!activeUuid, 'no local vault registered in this run')

    const err = await page.evaluate(
      (id) =>
        window.api.vault.deleteFromAccount(id).then(
          () => null,
          (e) => String(e)
        ),
      activeUuid
    )
    expect(err).toMatch(/active vault/i)
  })
})
```

**Signed-in setup is the unknown here.** The scaffolding above drives IPC directly and assumes a signed-in session. Before writing it, read `tests/e2e/shared-sync-bootstrap.e2e.ts` and `tests/e2e/utils/sync-backend.ts` to learn how that run establishes auth and registers vaults, and mirror it. If a cloud-only vault cannot be produced without a second device, use `dual-device-isolation.e2e.ts` as the model. Do not fabricate a helper that does not exist — if this proves infeasible in one task, keep scenario 2 (the files-survive guarantee) and drop scenario 1 to a server route test, then say so.

- [ ] **Step 2: Build and run**

The E2E suite runs against `out/`, which goes stale silently.

Run: `pnpm --filter @memry/desktop exec electron-vite build && pnpm test:e2e -- vault-deletion.e2e.ts`
Expected: PASS.

If native modules fail to load: `pnpm --filter @memry/desktop rebuild:electron` (the Electron rebuild — the Node rebuild does not prove Electron runtime).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/tests/e2e/vault-deletion.e2e.ts
git commit -m "test(vault): e2e for account vault deletion"
```

---

### Task 9: Docs + full verification

**Files:**

- Modify: `apps/docs/src/user-guide/sync/how-sync-works.md`

- [ ] **Step 1: Document the behavior**

Add a section covering: how to delete a vault (both surfaces); that deletion is permanent and server-side; that files on disk are never touched; that it frees a vault slot against the plan limit; and the D3 caveat — a device that still has the vault locally will re-register it, so remove it from that device first.

- [ ] **Step 2: Run the docs gate**

```bash
base_commit=$(git merge-base origin/main HEAD)
pnpm docs:impact --base "$base_commit" --strict
```

Expected: PASS. If `missing-docs`, update only real docs under `apps/docs/src/**`, or run `pnpm docs:ai-update --base "$base_commit"`.

- [ ] **Step 3: Build docs**

Run: `pnpm docs:build`
Expected: PASS.

- [ ] **Step 4: Full verification**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm ipc:check
pnpm check:contracts
pnpm check:architecture
git diff --check
```

Expected: PASS. Known noise to ignore: pre-existing type errors in `websocket.test.ts` and `folders.test.ts`; desktop vitest full-run SIGSEGV is a known parallel flake — re-run the affected project alone before believing it.

- [ ] **Step 5: Commit**

```bash
git add apps/docs
git commit -m "docs(vault): document deleting a vault from your account"
```

---

## Verification Checklist

Do not check any of these off without the exact green evidence in hand.

- [ ] A vault deleted from the switcher disappears from "In your account" and does not return after restart
- [ ] The same vault's files are still on disk afterwards
- [ ] The active vault offers no delete control in the switcher and a disabled one in Settings
- [ ] Deleting a vault frees a slot — only provable end-to-end (Task 8), since the server package has no real database. Not claimable from unit tests.
- [ ] `DELETE` for a vault the caller does not own returns 404 and purges nothing
- [ ] The mount-order regression test fails if the route is moved below `paidSyncMiddleware`
- [ ] `server_cursor_sequence` rows survive a vault delete
- [ ] `users.storage_used` drops by the deleted vault's bytes
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm ipc:check`, `pnpm docs:build` all green

## Deploy Order

1. Merge + deploy **sync-server** first (the endpoint must exist before clients call it).
2. Then release **desktop**.

Old clients never call `DELETE` and are unaffected. No migration runs.

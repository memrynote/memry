# Plan A — Sync-Type Capability Negotiation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sync server serve each client only the item types that client declares it understands, so adding any new sync item type can never break an already-shipped binary.

**Architecture:** The client sends `X-Memry-Sync-Types: <comma-separated>` alongside the existing `X-Memry-Vault-Id` header. A Hono middleware resolves that header into a negotiated type list on the request context; `getChanges`, `getManifest` and `pullItems` bind that list into their existing `item_type IN (...)` SQL instead of the compile-time `RECORD_SYNC_ITEM_TYPES` constant. A request with no header resolves to a **frozen** legacy list, which is what protects binaries already in users' hands.

**Tech Stack:** TypeScript, Hono, Cloudflare D1/R2 (sync-server), Electron main process (desktop client), Zod contracts, Vitest.

## Global Constraints

- **Live beta, real users on macOS/Windows/Linux. Backward compatibility is mandatory.** No DB resets. Old clients must keep working.
- **Deploy order is a hard rule:** this server change goes to production BEFORE any desktop build carrying a new item type (Plan B). Staging auto-deploys on `main` push; prod is manual + approval via GitHub Actions.
- **`LEGACY_RECORD_SYNC_ITEM_TYPES` is frozen forever.** It is never edited when a new sync type is added. That is the entire point of the constant.
- No D1 migration is required — `sync_items.item_type` is a bare `TEXT NOT NULL` with no CHECK constraint.
- Do not add `Co-Authored-By` to commit messages.
- Logging: `createLogger('Scope')`, never raw `console.*`.

## Background — why this exists

`getChanges` already filters `item_type IN (...)` in SQL before `LIMIT`, binding the server's own compile-time `RECORD_SYNC_ITEM_TYPES`. The moment a server is deployed whose contracts include a new type, it serves refs of that type to **every** client, including binaries that predate it. On such a client:

1. `/sync/changes` is fetched via `getFromServer<T>` → `syncFetch<T>` — a generic cast with **no runtime validation** — so the unknown ref is accepted.
2. `pullChangesPage` maps every ref to an id with no type filter (`pull-coordinator.ts:268`).
3. `RecordPullResponseSchema.safeParse` validates the **whole page**; the unknown type fails the old binary's `z.enum(RECORD_SYNC_ITEM_TYPES)`, so `processPage` returns `applied: 0` (`pull-coordinator.ts:453-456`) without throwing.
4. `pullChanges` still persists `LAST_CURSOR` (`pull-coordinator.ts:1291`), so the page's notes and tasks are skipped **permanently**.

Cursor mechanics need no change: because the type filter runs in SQL before `LIMIT`, excluded rows never enter a page and `nextCursor` steps over them for free.

## File Structure

| File                                                                | Responsibility                                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `packages/contracts/src/sync-api.ts` (modify)                       | Add the frozen `LEGACY_RECORD_SYNC_ITEM_TYPES` constant + `LegacyRecordSyncItemType` type. |
| `packages/contracts/src/sync-api.test.ts` (modify)                  | Freeze-test the legacy list.                                                               |
| `apps/sync-server/src/lib/sync-types.ts` (create)                   | `SYNC_TYPES_HEADER` + `resolveSyncTypes(header)` — pure, fully unit-testable.              |
| `apps/sync-server/src/lib/sync-types.test.ts` (create)              | Unit tests for `resolveSyncTypes`.                                                         |
| `apps/sync-server/src/types.ts` (modify)                            | `AppContext` Variables gain `syncTypes`.                                                   |
| `apps/sync-server/src/middleware/sync-types.ts` (create)            | Middleware writing `syncTypes` onto the context.                                           |
| `apps/sync-server/src/middleware/sync-types.test.ts` (create)       | Middleware tests.                                                                          |
| `apps/sync-server/src/services/sync.ts` (modify)                    | `getChanges`/`getManifest`/`pullItems` take an explicit `types` argument.                  |
| `apps/sync-server/src/services/sync.test.ts` (modify)               | Assert the negotiated list is what gets bound.                                             |
| `apps/sync-server/src/routes/sync.ts` (modify)                      | Register middleware; pass `c.get('syncTypes')` into the three services.                    |
| `apps/sync-server/src/routes/sync.test.ts` (modify)                 | Update call-arg assertions; add header-negotiation cases.                                  |
| `apps/desktop/src/main/sync/http-client.ts` (modify)                | Send `X-Memry-Sync-Types`.                                                                 |
| `apps/desktop/src/main/sync/http-client.test.ts` (create or modify) | Assert the header is sent.                                                                 |

---

### Task 1: Freeze the legacy item-type list in contracts

**Files:**

- Modify: `packages/contracts/src/sync-api.ts` (after the `CRDT_SYNC_ITEM_TYPES` declaration, ~line 79)
- Test: `packages/contracts/src/sync-api.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `LEGACY_RECORD_SYNC_ITEM_TYPES: readonly RecordSyncItemType[]` and `type LegacyRecordSyncItemType`. Task 2 and Task 3 both import the constant.

- [ ] **Step 1: Write the failing test**

Append to `packages/contracts/src/sync-api.test.ts`:

```ts
import { LEGACY_RECORD_SYNC_ITEM_TYPES, RECORD_SYNC_ITEM_TYPES } from './sync-api'

describe('LEGACY_RECORD_SYNC_ITEM_TYPES', () => {
  // This list is FROZEN. It describes what already-shipped binaries understand.
  // If a new sync item type makes this test fail, the fix is NEVER to update this
  // list — it is to leave it alone. See 2026-07-15-template-sync-design.md.
  it('is exactly the 15 record types that shipped before type negotiation', () => {
    expect(LEGACY_RECORD_SYNC_ITEM_TYPES).toEqual([
      'note',
      'task',
      'project',
      'settings',
      'inbox',
      'filter',
      'journal',
      'tag_definition',
      'folder_config',
      'calendar_event',
      'calendar_source',
      'calendar_binding',
      'calendar_external_event',
      'agent_conversation',
      'agent_message'
    ])
  })

  it('only contains types the server still supports', () => {
    for (const type of LEGACY_RECORD_SYNC_ITEM_TYPES) {
      expect(RECORD_SYNC_ITEM_TYPES).toContain(type)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/contracts test -- sync-api`
Expected: FAIL — `LEGACY_RECORD_SYNC_ITEM_TYPES` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/contracts/src/sync-api.ts`, immediately after the `CRDT_SYNC_ITEM_TYPES` declaration:

```ts
/**
 * The record sync item types understood by every client shipped BEFORE
 * per-request sync-type negotiation existed.
 *
 * FROZEN — never add to this list, not even when adding a new sync item type.
 *
 * A pre-negotiation binary sends no `X-Memry-Sync-Types` header, so the server
 * serves it exactly these types. Without this, a newer item type reaches a
 * binary whose `z.enum(RECORD_SYNC_ITEM_TYPES)` rejects it, which fails the
 * whole-page `RecordPullResponseSchema.safeParse` and silently drops a page of
 * notes and tasks while the device cursor advances past them.
 */
export const LEGACY_RECORD_SYNC_ITEM_TYPES = [
  'note',
  'task',
  'project',
  'settings',
  'inbox',
  'filter',
  'journal',
  'tag_definition',
  'folder_config',
  'calendar_event',
  'calendar_source',
  'calendar_binding',
  'calendar_external_event',
  'agent_conversation',
  'agent_message'
] as const

export type LegacyRecordSyncItemType = (typeof LEGACY_RECORD_SYNC_ITEM_TYPES)[number]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/contracts test -- sync-api`
Expected: PASS. Then `pnpm typecheck` — no new errors.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/sync-api.ts packages/contracts/src/sync-api.test.ts
git commit -m "feat(contracts): freeze legacy record sync item type list

Describes what pre-negotiation clients understand. Never edited when a new
sync type is added; the server serves exactly this list to any client that
sends no X-Memry-Sync-Types header."
```

---

### Task 2: `resolveSyncTypes` header parser

**Files:**

- Create: `apps/sync-server/src/lib/sync-types.ts`
- Test: `apps/sync-server/src/lib/sync-types.test.ts`

**Interfaces:**

- Consumes: `LEGACY_RECORD_SYNC_ITEM_TYPES`, `RECORD_SYNC_ITEM_TYPES`, `RecordSyncItemType` from `@memry/contracts/sync-api` (Task 1).
- Produces: `SYNC_TYPES_HEADER: 'X-Memry-Sync-Types'` and `resolveSyncTypes(header: string | undefined | null): RecordSyncItemType[]`. Task 4 (middleware) is the only caller.

- [ ] **Step 1: Write the failing test**

Create `apps/sync-server/src/lib/sync-types.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { LEGACY_RECORD_SYNC_ITEM_TYPES } from '@memry/contracts/sync-api'
import { resolveSyncTypes, SYNC_TYPES_HEADER } from './sync-types'

describe('resolveSyncTypes', () => {
  const legacy = [...LEGACY_RECORD_SYNC_ITEM_TYPES]

  it('exposes the header name', () => {
    expect(SYNC_TYPES_HEADER).toBe('X-Memry-Sync-Types')
  })

  // THE regression that protects shipped binaries.
  it('falls back to the frozen legacy list when the header is absent', () => {
    expect(resolveSyncTypes(undefined)).toEqual(legacy)
    expect(resolveSyncTypes(null)).toEqual(legacy)
    expect(resolveSyncTypes('')).toEqual(legacy)
  })

  it('returns only the declared types when the header is present', () => {
    expect(resolveSyncTypes('note,task')).toEqual(['note', 'task'])
  })

  it('tolerates whitespace and empty segments', () => {
    expect(resolveSyncTypes(' note , task ,, ')).toEqual(['note', 'task'])
  })

  it('drops types the server does not support', () => {
    expect(resolveSyncTypes('note,bogus,task')).toEqual(['note', 'task'])
  })

  it('falls back to legacy when nothing in the header is recognized', () => {
    expect(resolveSyncTypes('bogus,nonsense')).toEqual(legacy)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/sync-server test -- sync-types`
Expected: FAIL — cannot resolve `./sync-types`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/sync-server/src/lib/sync-types.ts`:

```ts
import {
  LEGACY_RECORD_SYNC_ITEM_TYPES,
  RECORD_SYNC_ITEM_TYPES,
  type RecordSyncItemType
} from '@memry/contracts/sync-api'

export const SYNC_TYPES_HEADER = 'X-Memry-Sync-Types'

const SUPPORTED = new Set<string>(RECORD_SYNC_ITEM_TYPES)

/**
 * Resolve the item types a client is willing to receive.
 *
 * No header means the client predates negotiation, so it gets exactly the
 * frozen legacy list — never the server's current type list, which may contain
 * types that binary would choke on.
 *
 * Unrecognized entries are dropped rather than trusted; an entirely
 * unrecognized header is treated as no header at all.
 */
export function resolveSyncTypes(header: string | undefined | null): RecordSyncItemType[] {
  if (!header) return [...LEGACY_RECORD_SYNC_ITEM_TYPES]

  const negotiated = header
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry): entry is RecordSyncItemType => entry.length > 0 && SUPPORTED.has(entry))

  if (negotiated.length === 0) return [...LEGACY_RECORD_SYNC_ITEM_TYPES]

  return negotiated
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/sync-server test -- sync-types`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/sync-server/src/lib/sync-types.ts apps/sync-server/src/lib/sync-types.test.ts
git commit -m "feat(sync-server): resolve client sync types from request header

Absent or fully-unrecognized header resolves to the frozen legacy list."
```

---

### Task 3: Services take an explicit negotiated type list

**Files:**

- Modify: `apps/sync-server/src/services/sync.ts` — `getManifest` (~518-551), `getChanges` (~553-610), `pullItems` (~672-721)
- Test: `apps/sync-server/src/services/sync.test.ts`

**Interfaces:**

- Consumes: `RecordSyncItemType` from contracts.
- Produces — the exact signatures Task 5 calls:
  - `getManifest(db: D1Database, userId: string, vaultId?: string, types?: readonly RecordSyncItemType[]): Promise<RecordSyncManifest>`
  - `getChanges(db: D1Database, userId: string, cursor: number, limit?: number, vaultId?: string, types?: readonly RecordSyncItemType[]): Promise<RecordChangesResponse>`
  - `pullItems(db: D1Database, storage: R2Bucket, userId: string, itemIds: string[], vaultId?: string, types?: readonly RecordSyncItemType[]): Promise<RecordPullItemResponse[]>`

Each `types` parameter defaults to `LEGACY_RECORD_SYNC_ITEM_TYPES` — **not** `RECORD_SYNC_ITEM_TYPES`. A forgotten call site must fail closed (serving too little) rather than open (breaking old clients).

- [ ] **Step 1: Write the failing test**

Add to `apps/sync-server/src/services/sync.test.ts`. The existing D1 fake is `createMockDb()` with a chainable `createMockStatement()`; reuse them.

```ts
import { LEGACY_RECORD_SYNC_ITEM_TYPES } from '@memry/contracts/sync-api'

describe('sync-type negotiation', () => {
  it('getChanges binds only the negotiated types', async () => {
    // #given
    const db = createMockDb()
    const stmt = createMockStatement()
    db.prepare.mockReturnValue(stmt)

    // #when
    await getChanges(db as unknown as D1Database, 'user-1', 0, 10, 'vault-1', ['note', 'task'])

    // #then
    expect(db.prepare.mock.calls[0][0]).toContain('item_type IN (?, ?)')
    expect(stmt.bind).toHaveBeenCalledWith('user-1', 'vault-1', 0, 'note', 'task', 11)
  })

  it('getChanges defaults to the frozen legacy list when types are omitted', async () => {
    // #given
    const db = createMockDb()
    const stmt = createMockStatement()
    db.prepare.mockReturnValue(stmt)

    // #when
    await getChanges(db as unknown as D1Database, 'user-1', 0, 10, 'vault-1')

    // #then
    expect(stmt.bind).toHaveBeenCalledWith(
      'user-1',
      'vault-1',
      0,
      ...LEGACY_RECORD_SYNC_ITEM_TYPES,
      11
    )
  })

  it('getManifest binds only the negotiated types', async () => {
    // #given
    const db = createMockDb()
    const stmt = createMockStatement()
    db.prepare.mockReturnValue(stmt)

    // #when
    await getManifest(db as unknown as D1Database, 'user-1', 'vault-1', ['note'])

    // #then
    expect(db.prepare.mock.calls[0][0]).toContain('item_type IN (?)')
    expect(stmt.bind).toHaveBeenCalledWith('user-1', 'vault-1', 'note')
  })

  it('pullItems binds only the negotiated types', async () => {
    // #given
    const db = createMockDb()
    const stmt = createMockStatement()
    db.prepare.mockReturnValue(stmt)

    // #when
    await pullItems(
      db as unknown as D1Database,
      {} as unknown as R2Bucket,
      'user-1',
      ['item-1'],
      'vault-1',
      ['note', 'task']
    )

    // #then
    expect(db.prepare.mock.calls[0][0]).toContain('item_type IN (?, ?)')
    expect(stmt.bind).toHaveBeenCalledWith('user-1', 'vault-1', 'note', 'task', 'item-1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/sync-server test -- services/sync`
Expected: FAIL — the extra argument is ignored, so `bind` still receives all 15 `RECORD_SYNC_ITEM_TYPES`.

- [ ] **Step 3: Write minimal implementation**

In `apps/sync-server/src/services/sync.ts`, add the import and a placeholder helper next to the existing constants (~line 22-27). **Delete** the now-unused module constant `RECORD_SYNC_ITEM_TYPE_PLACEHOLDERS`:

```ts
import { LEGACY_RECORD_SYNC_ITEM_TYPES, type RecordSyncItemType } from '@memry/contracts/sync-api'

const placeholdersFor = (types: readonly RecordSyncItemType[]): string =>
  types.map(() => '?').join(', ')
```

`getManifest` — add the parameter and use it:

```ts
export const getManifest = async (
  db: D1Database,
  userId: string,
  vaultId = 'default',
  types: readonly RecordSyncItemType[] = LEGACY_RECORD_SYNC_ITEM_TYPES
): Promise<RecordSyncManifest> => {
  const rows = await db
    .prepare(
      `SELECT item_id, item_type, version, updated_at, size_bytes, state_vector
       FROM sync_items
       WHERE user_id = ? AND vault_id = ? AND deleted_at IS NULL AND item_type IN (${placeholdersFor(types)})
       ORDER BY server_cursor ASC`
    )
    .bind(userId, vaultId, ...types)
    .all<{
      item_id: string
      item_type: string
      version: number
      updated_at: number
      size_bytes: number
      state_vector: string | null
    }>()
  // ...rest of the function body is unchanged
```

`getChanges` — same treatment:

```ts
export const getChanges = async (
  db: D1Database,
  userId: string,
  cursor: number,
  limit?: number,
  vaultId = 'default',
  types: readonly RecordSyncItemType[] = LEGACY_RECORD_SYNC_ITEM_TYPES
): Promise<RecordChangesResponse> => {
  const effectiveLimit = Math.min(limit ?? DEFAULT_CHANGES_LIMIT, MAX_CHANGES_LIMIT)

  const rows = await db
    .prepare(
      `SELECT item_id, item_type, version, updated_at, size_bytes, state_vector, server_cursor, deleted_at
       FROM sync_items
       WHERE user_id = ? AND vault_id = ? AND server_cursor > ? AND item_type IN (${placeholdersFor(types)})
       ORDER BY server_cursor ASC
       LIMIT ?`
    )
    .bind(userId, vaultId, cursor, ...types, effectiveLimit + 1)
    .all<{
      item_id: string
      item_type: string
      version: number
      updated_at: number
      size_bytes: number
      state_vector: string | null
      server_cursor: number
      deleted_at: number | null
    }>()
  // ...rest of the function body is unchanged
```

`pullItems` — the parameter, and `BATCH_SIZE` must derive from `types.length`, not the module constant:

```ts
export const pullItems = async (
  db: D1Database,
  storage: R2Bucket,
  userId: string,
  itemIds: string[],
  vaultId = 'default',
  types: readonly RecordSyncItemType[] = LEGACY_RECORD_SYNC_ITEM_TYPES
): Promise<RecordPullItemResponse[]> => {
  if (itemIds.length === 0) {
    return []
  }

  // 95 D1 bind params, minus user_id + vault_id, minus one per negotiated type.
  const BATCH_SIZE = D1_MAX_BIND_PARAMS - 2 - types.length

  const allDbRows: StoredSyncItemPullRow[] = []

  for (let i = 0; i < itemIds.length; i += BATCH_SIZE) {
    const batch = itemIds.slice(i, i + BATCH_SIZE)
    const placeholders = batch.map(() => '?').join(', ')
    const rows = await db
      .prepare(
        `SELECT item_id, item_type, blob_key, crypto_version, operation, signer_device_id, signature,
                state_vector, clock, deleted_at, server_cursor
         FROM sync_items
         WHERE user_id = ? AND vault_id = ? AND item_type IN (${placeholdersFor(types)})
           AND item_id IN (${placeholders})
         ORDER BY server_cursor ASC`
      )
      .bind(userId, vaultId, ...types, ...batch)
      .all<StoredSyncItemPullRow>()
    allDbRows.push(...(rows.results ?? []))
  }
  // ...rest of the function body is unchanged
```

Leave `isSupportedRecordSyncItemType` and the JS-side `.filter(...)` alone — they narrow the TypeScript union; the SQL is what enforces negotiation.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/sync-server test -- services/sync`
Expected: PASS. Then `pnpm --filter @memry/sync-server typecheck` — expect an error if `RECORD_SYNC_ITEM_TYPE_PLACEHOLDERS` is still referenced anywhere; remove those references.

- [ ] **Step 5: Commit**

```bash
git add apps/sync-server/src/services/sync.ts apps/sync-server/src/services/sync.test.ts
git commit -m "feat(sync-server): bind negotiated item types in changes/manifest/pull

Types default to the frozen legacy list so a missed call site fails closed.
pullItems BATCH_SIZE now derives from the negotiated list length."
```

---

### Task 4: Sync-types middleware

**Files:**

- Create: `apps/sync-server/src/middleware/sync-types.ts`
- Modify: `apps/sync-server/src/types.ts` (`AppContext` Variables)
- Test: `apps/sync-server/src/middleware/sync-types.test.ts`

**Interfaces:**

- Consumes: `resolveSyncTypes`, `SYNC_TYPES_HEADER` (Task 2).
- Produces: `syncTypesMiddleware: MiddlewareHandler<AppContext>`, and `c.get('syncTypes')` typed `RecordSyncItemType[]`. Task 5 reads it.

- [ ] **Step 1: Write the failing test**

Create `apps/sync-server/src/middleware/sync-types.test.ts`:

```ts
import { Hono } from 'hono'
import { describe, it, expect } from 'vitest'
import { LEGACY_RECORD_SYNC_ITEM_TYPES } from '@memry/contracts/sync-api'
import type { AppContext } from '../types'
import { syncTypesMiddleware } from './sync-types'

const createApp = () => {
  const app = new Hono<AppContext>()
  app.use('*', syncTypesMiddleware)
  app.get('/probe', (c) => c.json({ syncTypes: c.get('syncTypes') }))
  return app
}

describe('syncTypesMiddleware', () => {
  it('sets the frozen legacy list when no header is sent', async () => {
    // #when
    const res = await createApp().request('/probe', { method: 'GET' })

    // #then
    const json = (await res.json()) as { syncTypes: string[] }
    expect(json.syncTypes).toEqual([...LEGACY_RECORD_SYNC_ITEM_TYPES])
  })

  it('sets the declared types when the header is sent', async () => {
    // #when
    const res = await createApp().request('/probe', {
      method: 'GET',
      headers: { 'X-Memry-Sync-Types': 'note,task' }
    })

    // #then
    const json = (await res.json()) as { syncTypes: string[] }
    expect(json.syncTypes).toEqual(['note', 'task'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/sync-server test -- middleware/sync-types`
Expected: FAIL — cannot resolve `./sync-types`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/sync-server/src/middleware/sync-types.ts`:

```ts
import type { MiddlewareHandler } from 'hono'

import { resolveSyncTypes, SYNC_TYPES_HEADER } from '../lib/sync-types'
import type { AppContext } from '../types'

/**
 * Resolve which item types this client can safely receive.
 *
 * Mirrors the X-Memry-Vault-Id pattern: read the header once here, and let
 * handlers read the resolved value off the context.
 */
export const syncTypesMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  c.set('syncTypes', resolveSyncTypes(c.req.header(SYNC_TYPES_HEADER)))
  await next()
}
```

In `apps/sync-server/src/types.ts`, add to the `AppContext` `Variables` block (alongside `vaultId`):

```ts
import type { RecordSyncItemType } from '@memry/contracts/sync-api'

// ...inside AppContext['Variables']:
  syncTypes: RecordSyncItemType[]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/sync-server test -- middleware/sync-types`
Expected: PASS (2 tests). Then `pnpm --filter @memry/sync-server typecheck`.

- [ ] **Step 5: Commit**

```bash
git add apps/sync-server/src/middleware/sync-types.ts apps/sync-server/src/middleware/sync-types.test.ts apps/sync-server/src/types.ts
git commit -m "feat(sync-server): add sync-types middleware

Resolves X-Memry-Sync-Types onto the request context, mirroring the
X-Memry-Vault-Id pattern."
```

---

### Task 5: Wire the middleware and services into the routes

**Files:**

- Modify: `apps/sync-server/src/routes/sync.ts` — register middleware after `sync.use('*', paidSyncMiddleware)` (~line 105); update `handleRecordManifest` (~247), `handleRecordChanges` (~254), `handleRecordPull` (~371)
- Test: `apps/sync-server/src/routes/sync.test.ts`

**Interfaces:**

- Consumes: `syncTypesMiddleware` (Task 4); the service signatures from Task 3.
- Produces: no new exports. Routes now pass `c.get('syncTypes')!` as the final argument to all three services.

**Note:** every record route is registered **twice** — under `/sync/records/*` and `/sync/*` (`routes/sync.ts:409-425`). Registering the middleware with `sync.use('*', ...)` covers both, since `recordSync` is mounted onto `sync` via `sync.route('/records', recordSync)`.

- [ ] **Step 1: Write the failing test**

In `apps/sync-server/src/routes/sync.test.ts`, update the existing assertions and add negotiation cases. The existing tests assert 5-arg / 3-arg calls and **will fail** once the routes pass a 6th/4th argument — that is expected and correct.

Replace the existing `'should pass userId to getManifest'` test:

```ts
it('should pass userId and negotiated types to getManifest', async () => {
  // #when
  await app.request('/sync/manifest', { method: 'GET' }, env, executionCtx)

  // #then
  expect(getManifest).toHaveBeenCalledWith(env.DB, 'user-1', 'vault-1', [
    ...LEGACY_RECORD_SYNC_ITEM_TYPES
  ])
})
```

Replace `'should forward cursor and limit query params'` and `'should default cursor to 0 when omitted'`:

```ts
it('should forward cursor and limit query params', async () => {
  // #when
  await app.request('/sync/changes?cursor=5&limit=10', { method: 'GET' }, env, executionCtx)

  // #then
  expect(getChanges).toHaveBeenCalledWith(env.DB, 'user-1', 5, 10, 'vault-1', [
    ...LEGACY_RECORD_SYNC_ITEM_TYPES
  ])
})

it('should default cursor to 0 when omitted', async () => {
  // #when
  await app.request('/sync/changes', { method: 'GET' }, env, executionCtx)

  // #then
  expect(getChanges).toHaveBeenCalledWith(env.DB, 'user-1', 0, undefined, 'vault-1', [
    ...LEGACY_RECORD_SYNC_ITEM_TYPES
  ])
})
```

Add a new `describe` block covering negotiation end-to-end through the routes:

```ts
// ==========================================================================
// Sync-type negotiation
// ==========================================================================

describe('sync-type negotiation', () => {
  // A client that predates negotiation sends no header. It must never be
  // served a type its z.enum would reject — that drops a whole pull page.
  it('serves the frozen legacy list to a header-less client', async () => {
    // #when
    await app.request('/sync/changes', { method: 'GET' }, env, executionCtx)

    // #then
    expect(getChanges).toHaveBeenCalledWith(env.DB, 'user-1', 0, undefined, 'vault-1', [
      ...LEGACY_RECORD_SYNC_ITEM_TYPES
    ])
  })

  it('narrows to the declared types when the header is sent', async () => {
    // #when
    await app.request(
      '/sync/changes',
      { method: 'GET', headers: { 'X-Memry-Sync-Types': 'note,task' } },
      env,
      executionCtx
    )

    // #then
    expect(getChanges).toHaveBeenCalledWith(env.DB, 'user-1', 0, undefined, 'vault-1', [
      'note',
      'task'
    ])
  })

  it('passes negotiated types to pullItems', async () => {
    // #when
    await app.request(
      '/sync/pull',
      {
        ...jsonPost('/sync/pull', { itemIds: [VALID_UUID] }),
        headers: { 'Content-Type': 'application/json', 'X-Memry-Sync-Types': 'note' }
      },
      env,
      executionCtx
    )

    // #then
    expect(pullItems).toHaveBeenCalledWith(env.DB, env.STORAGE, 'user-1', [VALID_UUID], 'vault-1', [
      'note'
    ])
  })

  it('applies negotiation on the /sync/records/* mount too', async () => {
    // #when
    await app.request(
      '/sync/records/changes',
      { method: 'GET', headers: { 'X-Memry-Sync-Types': 'note' } },
      env,
      executionCtx
    )

    // #then
    expect(getChanges).toHaveBeenCalledWith(env.DB, 'user-1', 0, undefined, 'vault-1', ['note'])
  })
})
```

Add the import at the top of the test file, next to the other contract imports:

```ts
import { LEGACY_RECORD_SYNC_ITEM_TYPES } from '@memry/contracts/sync-api'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/sync-server test -- routes/sync`
Expected: FAIL — services are still called without the types argument (`expected 6 arguments, received 5`).

- [ ] **Step 3: Write minimal implementation**

In `apps/sync-server/src/routes/sync.ts`, add the import:

```ts
import { syncTypesMiddleware } from '../middleware/sync-types'
```

Register it immediately after the existing `sync.use('*', paidSyncMiddleware)` (~line 105):

```ts
sync.use('*', paidSyncMiddleware)
sync.use('*', syncTypesMiddleware)
```

`handleRecordManifest`:

```ts
const handleRecordManifest = async (c: Context<AppContext>): Promise<Response> => {
  const userId = c.get('userId')!
  const vaultId = c.get('vaultId')!
  const manifest = await getManifest(c.env.DB, userId, vaultId, c.get('syncTypes')!)
  return c.json(manifest)
}
```

In `handleRecordChanges`, change only the `getChanges` call:

```ts
const changes = await getChanges(c.env.DB, userId, cursor, limit, vaultId, c.get('syncTypes')!)
```

In `handleRecordPull`, change only the `pullItems` call:

```ts
const items = await pullItems(
  c.env.DB,
  c.env.STORAGE,
  userId,
  parsed.itemIds,
  vaultId,
  c.get('syncTypes')!
)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/sync-server test -- routes/sync`
Expected: PASS. Then `pnpm --filter @memry/sync-server test && pnpm --filter @memry/sync-server typecheck` — all green.

- [ ] **Step 5: Commit**

```bash
git add apps/sync-server/src/routes/sync.ts apps/sync-server/src/routes/sync.test.ts
git commit -m "feat(sync-server): serve each client only its negotiated sync types

Header-less clients receive the frozen legacy list, so a new item type can
never reach a binary that would reject it and drop a whole pull page."
```

---

### Task 6: Client declares its supported types

**Files:**

- Modify: `apps/desktop/src/main/sync/http-client.ts` — `syncFetch` header block (~68-133)
- Test: `apps/desktop/src/main/sync/http-client.test.ts` (create if it does not exist)

**Interfaces:**

- Consumes: `RECORD_SYNC_ITEM_TYPES` from `@memry/contracts/sync-api`.
- Produces: no new exports — `syncFetch` simply sends one more header.

**Why inside `if (token)`:** `X-Memry-Vault-Id` is only attached for authenticated calls (`http-client.ts:172-175`). Sync-type negotiation is only meaningful on authenticated sync endpoints, so the new header belongs in the same block.

- [ ] **Step 1: Write the failing test**

Create (or extend) `apps/desktop/src/main/sync/http-client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RECORD_SYNC_ITEM_TYPES } from '@memry/contracts/sync-api'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

vi.mock('../database', () => ({ getDatabase: vi.fn().mockReturnValue({}) }))
vi.mock('../agent/storage/vault-id', () => ({
  getOrCreateVaultUuid: vi.fn().mockReturnValue('vault-1')
}))

import { getFromServer } from './http-client'

describe('syncFetch sync-type header', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SYNC_SERVER_URL = 'https://sync.example.com'
  })

  it('declares the supported record sync types on authenticated calls', async () => {
    // #given
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )

    // #when
    await getFromServer('/sync/manifest', 'token-1', fetchFn)

    // #then
    const headers = fetchFn.mock.calls[0][1].headers as Record<string, string>
    expect(headers['X-Memry-Sync-Types']).toBe(RECORD_SYNC_ITEM_TYPES.join(','))
  })

  it('does not declare sync types on unauthenticated calls', async () => {
    // #given
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )

    // #when
    await getFromServer('/health', undefined, fetchFn)

    // #then
    const headers = fetchFn.mock.calls[0][1].headers as Record<string, string>
    expect(headers['X-Memry-Sync-Types']).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- http-client`
Expected: FAIL — `expected undefined to be 'note,task,...'`.
If this errors with `ERR_DLOPEN_FAILED`, run `pnpm --filter @memry/desktop rebuild:node` first.

- [ ] **Step 3: Write minimal implementation**

In `apps/desktop/src/main/sync/http-client.ts`, add the import and a module constant:

```ts
import { RECORD_SYNC_ITEM_TYPES } from '@memry/contracts/sync-api'

// Declared to the server so it never sends this build an item type our
// RecordPullResponseSchema would reject — one unknown type fails the whole-page
// safeParse and silently drops the page.
const SYNC_TYPES_HEADER_VALUE = RECORD_SYNC_ITEM_TYPES.join(',')
```

Then extend the authenticated header block inside `syncFetch`:

```ts
if (token) {
  headers['Authorization'] = `Bearer ${token}`
  headers['X-Memry-Sync-Types'] = SYNC_TYPES_HEADER_VALUE
  Object.assign(headers, await getSyncVaultHeaders())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- http-client`
Expected: PASS (2 tests). Then `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/sync/http-client.ts apps/desktop/src/main/sync/http-client.test.ts
git commit -m "feat(sync): declare supported record sync types to the server

Sent alongside X-Memry-Vault-Id on authenticated sync calls so the server
can withhold item types this build cannot parse."
```

---

## Verification (run before pushing)

- [ ] `pnpm --filter @memry/contracts test` — legacy list frozen.
- [ ] `pnpm --filter @memry/sync-server test && pnpm --filter @memry/sync-server typecheck` — negotiation green, no dangling `RECORD_SYNC_ITEM_TYPE_PLACEHOLDERS`.
- [ ] `pnpm --filter @memry/desktop test:main -- http-client` — header sent.
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm check:contracts && pnpm check:architecture`
- [ ] `pnpm docs:impact --base origin/main --strict` — sync-server + desktop sync changes are docs-relevant. If it reports `missing-docs`, update `apps/docs/src/**` or run `pnpm docs:ai-update --base origin/main`, then re-run and `pnpm docs:build`.

**Manual two-profile check:** run `pnpm --filter @memry/desktop dev:a` and `dev:b` against one linked vault and confirm notes/tasks still converge. Negotiation is invisible when both clients declare the same list — this is a no-regression check, not a feature check.

## Deploy

1. Merge Plan A.
2. Deploy sync-server to **staging** (automatic on `main` push); confirm sync still works.
3. Deploy sync-server to **production** (manual + approval, GitHub Actions).
4. Only then may Plan B's desktop build ship.

## Follow-up

Once this lands, correct `docs/superpowers/plans/2026-07-14-server-desktop-additive-d6-d8.md:1873`. It currently claims _"old clients simply never pull types they don't register"_ — false, and the reason this plan exists. Rewrite that backward-compat section to reference sync-type negotiation, and note that `home_page` / `bookmark` / `reminder` are safe to add only once this is deployed to production.

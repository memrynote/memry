import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSqliteD1, type SqliteD1 } from './d1-sqlite'
import { getManifest } from '../services/sync'
import { RECORD_SYNC_ITEM_TYPES } from '@memry/contracts/sync-api'

/**
 * Manifest pagination against real SQLite provisioned by the real migrations.
 *
 * The mock-D1 suite in services/sync.test.ts proves the SQL is ASSEMBLED
 * correctly; this suite proves the assembled SQL DOES what the desktop
 * integrity check depends on: a param-less call still returns the complete
 * manifest (old clients), and walking pages yields every row exactly once with
 * stable ordering — including a row whose server_cursor moves mid-walk.
 */

const USER_ID = 'user-manifest'
const VAULT_ID = 'default'

let harness: SqliteD1

const now = () => Math.floor(Date.now() / 1000)

const seedUser = (): void => {
  harness.raw
    .prepare(
      `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
       VALUES (?, ?, 1, 'otp', 0, 0, ?, ?)`
    )
    .run(USER_ID, 'manifest@example.com', now(), now())
}

const insertItem = (opts: {
  itemId: string
  cursor: number
  type?: string
  deletedAt?: number | null
}): void => {
  harness.raw
    .prepare(
      `INSERT INTO sync_items (
         id, user_id, vault_id, item_type, item_id, blob_key, size_bytes,
         content_hash, version, crypto_version, operation, signature,
         server_cursor, deleted_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'update', 'sig', ?, ?, ?, ?)`
    )
    .run(
      `row-${opts.itemId}`,
      USER_ID,
      VAULT_ID,
      opts.type ?? 'task',
      opts.itemId,
      `${USER_ID}/blobs/${opts.itemId}`,
      64,
      `hash-${opts.itemId}`,
      opts.cursor,
      opts.deletedAt ?? null,
      now(),
      now()
    )
}

const bumpCursor = (itemId: string, cursor: number): void => {
  harness.raw
    .prepare('UPDATE sync_items SET server_cursor = ? WHERE user_id = ? AND item_id = ?')
    .run(cursor, USER_ID, itemId)
}

beforeEach(() => {
  harness = createSqliteD1()
  seedUser()
})

afterEach(() => {
  harness.close()
})

describe('manifest pagination over real SQLite', () => {
  const seedEightLiveRows = (): string[] => {
    const ids: string[] = []
    for (let i = 1; i <= 8; i++) {
      const itemId = `item-${i}`
      insertItem({ itemId, cursor: i * 10 })
      ids.push(itemId)
    }
    // Soft-deleted rows never appear in any manifest, paged or not.
    insertItem({ itemId: 'item-deleted', cursor: 85, deletedAt: now() })
    return ids
  }

  it('returns the complete manifest for a param-less (old client) call', async () => {
    // #given
    const ids = seedEightLiveRows()

    // #when — exactly what every already-shipped client sends
    const result = await getManifest(harness.db, USER_ID, VAULT_ID, RECORD_SYNC_ITEM_TYPES)

    // #then — every live row, server_cursor order, and no nextCursor field
    expect(result.items.map((i) => i.id)).toEqual(ids)
    expect('nextCursor' in result).toBe(false)
  })

  it('walks pages with no duplicate and no missing row, in stable order', async () => {
    // #given
    seedEightLiveRows()
    const full = await getManifest(harness.db, USER_ID, VAULT_ID, RECORD_SYNC_ITEM_TYPES)

    // #when — page with limit 3 until the server stops handing back a cursor
    const paged: string[] = []
    const pageSizes: number[] = []
    let cursor = 0
    for (;;) {
      const page = await getManifest(harness.db, USER_ID, VAULT_ID, RECORD_SYNC_ITEM_TYPES, {
        cursor,
        limit: 3
      })
      paged.push(...page.items.map((i) => i.id))
      pageSizes.push(page.items.length)
      if (page.nextCursor === undefined) break
      cursor = page.nextCursor
    }

    // #then — 3 + 3 + 2, the exact param-less sequence, nothing twice
    expect(pageSizes).toEqual([3, 3, 2])
    expect(paged).toEqual(full.items.map((i) => i.id))
    expect(new Set(paged).size).toBe(paged.length)
  })

  it('never loses a row whose cursor moves mid-walk; the repeat dedups by ref', async () => {
    // #given
    seedEightLiveRows()

    // #when — first page served, then item-2 (already served) and item-6 (not
    // yet served) are both updated, pushing their cursors past everything
    const first = await getManifest(harness.db, USER_ID, VAULT_ID, RECORD_SYNC_ITEM_TYPES, {
      cursor: 0,
      limit: 3
    })
    bumpCursor('item-2', 200)
    bumpCursor('item-6', 210)

    const seen = new Map<string, number>()
    for (const item of first.items) seen.set(item.id, (seen.get(item.id) ?? 0) + 1)
    let cursor = first.nextCursor!
    for (;;) {
      const page = await getManifest(harness.db, USER_ID, VAULT_ID, RECORD_SYNC_ITEM_TYPES, {
        cursor,
        limit: 3
      })
      for (const item of page.items) seen.set(item.id, (seen.get(item.id) ?? 0) + 1)
      if (page.nextCursor === undefined) break
      cursor = page.nextCursor
    }

    // #then — every live row was seen at least once (nothing vanished)...
    for (let i = 1; i <= 8; i++) {
      expect(seen.has(`item-${i}`), `item-${i} must not be lost`).toBe(true)
    }
    // ...the already-served updated row is the only repeat, and only once more
    expect(seen.get('item-2')).toBe(2)
    for (const [id, count] of seen) {
      if (id !== 'item-2') expect(count, `${id} must appear exactly once`).toBe(1)
    }
  })
})

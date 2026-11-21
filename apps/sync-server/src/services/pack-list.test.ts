import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSqliteD1, type SqliteD1 } from '../__tests__/d1-sqlite'
import { listPacks } from './pack-list'
import type { R2PresignConfig } from './r2-presign'

/**
 * Pack discovery (#1839) against the real migration ledger: newest-first
 * keyset pagination, presigned URLs with minutes-scale TTLs, graceful
 * degradation when presign is unconfigured, and the empty-vault case.
 */

const USER = 'user-list'
const VAULT = 'default'
const OTHER_VAULT = 'other'

let harness: SqliteD1

const PRESIGN_CONFIG: R2PresignConfig = {
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  endpoint: 'https://test-account.r2.cloudflarestorage.com',
  bucket: 'test-bucket'
}

const seedPack = (overrides: {
  id: string
  kind?: string
  minCursor?: number
  maxCursor?: number
  vaultId?: string
}): void => {
  harness.raw
    .prepare(
      `INSERT INTO pack_index (id, user_id, vault_id, pack_key, item_kind, min_cursor, max_cursor, item_count, byte_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 10, 64000, 1700000000)`
    )
    .run(
      overrides.id,
      USER,
      overrides.vaultId ?? VAULT,
      `${USER}/vaults/${overrides.vaultId ?? VAULT}/packs/record/${overrides.minCursor ?? 0}_${overrides.maxCursor ?? 0}.pack`,
      overrides.kind ?? 'record',
      overrides.minCursor ?? 0,
      overrides.maxCursor ?? 0
    )
}

beforeEach(() => {
  harness = createSqliteD1()
  harness.raw
    .prepare(
      `INSERT INTO users (id, email, auth_method, created_at, updated_at)
       VALUES (?, 'list@example.com', 'otp', 1, 1)`
    )
    .run(USER)
})

afterEach(() => {
  harness.close()
})

describe('listPacks', () => {
  it('returns an empty page for a vault with no packs', async () => {
    const result = await listPacks(harness.db, USER, VAULT)
    expect(result.packs).toEqual([])
    expect(result.nextCursor).toBeUndefined()
  })

  it('lists packs newest-first with all advertised fields', async () => {
    seedPack({ id: 'p-old', minCursor: 1, maxCursor: 100 })
    seedPack({ id: 'p-new', minCursor: 101, maxCursor: 200 })
    seedPack({ id: 'p-snaps', kind: 'crdt_snapshot', minCursor: 1700000000, maxCursor: 1700001000 })

    const result = await listPacks(harness.db, USER, VAULT, {}, PRESIGN_CONFIG)
    // Ordered by max_cursor DESC regardless of insertion order.
    expect(result.packs.map((p) => p.id)).toEqual(['p-snaps', 'p-new', 'p-old'])
    expect(result.packs[1]).toMatchObject({
      itemKind: 'record',
      minCursor: 101,
      maxCursor: 200,
      itemCount: 10,
      byteSize: 64000
    })
  })

  it('issues one GET presigned URL per pack with minutes-scale expiry', async () => {
    seedPack({ id: 'p-1', minCursor: 1, maxCursor: 50 })
    const before = Math.floor(Date.now() / 1000)
    const result = await listPacks(harness.db, USER, VAULT, {}, PRESIGN_CONFIG)

    const pack = result.packs[0]
    expect(pack.url).toContain(
      `https://test-account.r2.cloudflarestorage.com/test-bucket/${USER}/vaults/${VAULT}/packs/`
    )
    expect(pack.url).toContain('X-Amz-Signature=')
    expect(pack.expiresAt).toBeGreaterThanOrEqual(before + 295)
    expect(pack.expiresAt).toBeLessThanOrEqual(before + 300)
  })

  it('omits urls entirely when the deployment has no presign config', async () => {
    seedPack({ id: 'p-1' })
    const result = await listPacks(harness.db, USER, VAULT, {}, null)
    expect(result.packs[0].url).toBeUndefined()
    expect(result.packs[0].expiresAt).toBeUndefined()
    // The packKey is still advertised so clients can identify the object.
    expect(result.packs[0].packKey).toContain('/packs/')
  })

  it('paginates via opaque keyset cursor without skipping or repeating rows', async () => {
    for (let i = 0; i < 5; i++) {
      seedPack({ id: `p-${i}`, minCursor: i * 100 + 1, maxCursor: (i + 1) * 100 })
    }

    const page1 = await listPacks(harness.db, USER, VAULT, { limit: 2 }, PRESIGN_CONFIG)
    expect(page1.packs.map((p) => p.id)).toEqual(['p-4', 'p-3'])
    expect(page1.nextCursor).toBeDefined()

    const page2 = await listPacks(
      harness.db,
      USER,
      VAULT,
      { cursor: page1.nextCursor!, limit: 2 },
      PRESIGN_CONFIG
    )
    expect(page2.packs.map((p) => p.id)).toEqual(['p-2', 'p-1'])

    const page3 = await listPacks(
      harness.db,
      USER,
      VAULT,
      { cursor: page2.nextCursor!, limit: 2 },
      PRESIGN_CONFIG
    )
    expect(page3.packs.map((p) => p.id)).toEqual(['p-0'])
    expect(page3.nextCursor).toBeUndefined() // final page
  })

  it('ends without a cursor when the row count is an exact multiple of the limit', async () => {
    // The 5-pack case above always leaves a 1-row final page, so the
    // rows.length === effectiveLimit boundary of the LIMIT+1 over-fetch is
    // never exercised there. An off-by-one here costs every bootstrap an extra
    // rate-limited round trip that returns zero packs.
    for (let i = 0; i < 4; i++) {
      seedPack({ id: `p-${i}`, minCursor: i * 100 + 1, maxCursor: (i + 1) * 100 })
    }

    const page1 = await listPacks(harness.db, USER, VAULT, { limit: 2 }, PRESIGN_CONFIG)
    expect(page1.packs.map((p) => p.id)).toEqual(['p-3', 'p-2'])
    expect(page1.nextCursor).toBeDefined()

    const page2 = await listPacks(
      harness.db,
      USER,
      VAULT,
      { cursor: page1.nextCursor!, limit: 2 },
      PRESIGN_CONFIG
    )
    expect(page2.packs.map((p) => p.id)).toEqual(['p-1', 'p-0'])
    expect(page2.nextCursor).toBeUndefined()
  })

  it("never leaks other users' or other vaults' packs", async () => {
    seedPack({ id: 'mine' })
    harness.raw
      .prepare(
        `INSERT INTO users (id, email, auth_method, created_at, updated_at)
         VALUES ('user-b', 'b@example.com', 'otp', 1, 1)`
      )
      .run()
    harness.raw
      .prepare(
        `INSERT INTO pack_index (id, user_id, vault_id, pack_key, item_kind, min_cursor, max_cursor, item_count, byte_size, created_at)
       VALUES ('theirs', 'user-b', 'default', 'k', 'record', 1, 2, 1, 10, 1)`
      )
      .run()
    seedPack({ id: 'my-other-vault', vaultId: OTHER_VAULT, maxCursor: 999 })

    const mine = await listPacks(harness.db, USER, VAULT, {}, PRESIGN_CONFIG)
    expect(mine.packs.map((p) => p.id)).toEqual(['mine'])
  })
})

describe('listPacks coverage (protocol 08 §8.10, #5230)', () => {
  const setWatermark = (kind: string, coveredThrough: number | null): void => {
    harness.raw
      .prepare(
        `INSERT INTO pack_watermarks (user_id, vault_id, item_kind, last_sort_value, last_sort_tiebreak, updated_at, covered_through)
         VALUES (?, ?, ?, 0, '', 1, ?)`
      )
      .run(USER, VAULT, kind, coveredThrough)
  }

  it('states record coverage on the first page only, with each pack range', async () => {
    seedPack({ id: 'a', minCursor: 1, maxCursor: 10 })
    seedPack({ id: 'b', minCursor: 11, maxCursor: 20 })
    harness.raw
      .prepare(`UPDATE pack_index SET cover_from = 0, cover_through = 10 WHERE id = 'a'`)
      .run()
    harness.raw
      .prepare(`UPDATE pack_index SET cover_from = 10, cover_through = 20 WHERE id = 'b'`)
      .run()
    setWatermark('record', 20)

    const first = await listPacks(harness.db, USER, VAULT, { limit: 1 })
    const second = await listPacks(harness.db, USER, VAULT, { cursor: first.nextCursor })

    expect(first.coverage).toEqual([{ itemKind: 'record', packedThrough: 20, coveredThrough: 20 }])
    expect(first.packs[0]).toMatchObject({ id: 'b', coverFrom: 10, coverThrough: 20 })
    expect(second.coverage).toBeUndefined()
    expect(second.packs[0]).toMatchObject({ id: 'a', coverFrom: 0, coverThrough: 10 })
  })

  it('states nothing for a cache-only record chain or for body kinds', async () => {
    seedPack({ id: 'a', minCursor: 1, maxCursor: 10 })
    setWatermark('record', null)
    setWatermark('crdt_update', 40)

    const page = await listPacks(harness.db, USER, VAULT)

    expect(page.coverage).toEqual([])
    expect('coverFrom' in page.packs[0]).toBe(false)
  })
})

describe('PACK_COVERAGE_DISABLED (#5392, step 14 rollback)', () => {
  const seedCovered = (vaultId: string): void => {
    seedPack({ id: `${vaultId}-a`, minCursor: 1, maxCursor: 10, vaultId })
    harness.raw
      .prepare(`UPDATE pack_index SET cover_from = 0, cover_through = 10 WHERE vault_id = ?`)
      .run(vaultId)
    harness.raw
      .prepare(
        `INSERT INTO pack_watermarks (user_id, vault_id, item_kind, last_sort_value, last_sort_tiebreak, updated_at, covered_through)
         VALUES (?, ?, 'record', 10, '', 1, 10)`
      )
      .run(USER, vaultId)
  }
  const stored = () => ({
    packs: harness.raw.prepare('SELECT * FROM pack_index ORDER BY id').all(),
    watermarks: harness.raw.prepare('SELECT * FROM pack_watermarks ORDER BY vault_id').all()
  })

  it('serves no packs and no coverage while set, writes nothing, and lists again once unset', async () => {
    seedCovered(VAULT)
    const before = stored()
    const unset = await listPacks(harness.db, USER, VAULT, { limit: 1 })

    const first = await listPacks(harness.db, USER, VAULT, { coverageDisabled: '*' })
    const later = await listPacks(harness.db, USER, VAULT, {
      cursor: '99:z',
      coverageDisabled: '*'
    })

    expect(first.packs).toEqual([])
    expect(first.coverage).toEqual([])
    expect('nextCursor' in first).toBe(false)
    expect(later.packs).toEqual([])
    expect(later.coverage).toBeUndefined()
    expect(stored()).toEqual(before)
    const restored = await listPacks(harness.db, USER, VAULT, { limit: 1 })
    expect({ ...restored, serverTime: 0 }).toEqual({ ...unset, serverTime: 0 })
    expect(restored.coverage).toEqual([
      { itemKind: 'record', packedThrough: 10, coveredThrough: 10 }
    ])
  })

  it('a vault list switches off only the vaults it names', async () => {
    seedCovered(VAULT)
    seedCovered(OTHER_VAULT)

    const off = await listPacks(harness.db, USER, VAULT, { coverageDisabled: ` x, ${VAULT} ` })
    const other = await listPacks(harness.db, USER, OTHER_VAULT, {
      coverageDisabled: ` x, ${VAULT} `
    })
    const empty = await listPacks(harness.db, USER, VAULT, { coverageDisabled: '' })

    expect(off).toMatchObject({ packs: [], coverage: [] })
    expect(other.packs.map((pack) => pack.id)).toEqual([`${OTHER_VAULT}-a`])
    expect(other.coverage).toHaveLength(1)
    expect(empty.packs).toHaveLength(1)
  })
})

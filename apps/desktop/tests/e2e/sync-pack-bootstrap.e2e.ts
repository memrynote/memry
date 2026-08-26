/**
 * Pack pipeline E2E (#1839 / #1840).
 *
 * Drives the real compaction pipeline inside Miniflare: device A seeds a vault
 * whose note snapshots reach the server, the Worker's scheduled handler runs
 * the pack backfill, and a fresh device B bootstraps against the result.
 *
 * What is covered here:
 *   - packs are actually BUILT by the real Worker against the real D1 ledger;
 *   - `crdt_snapshot` is the only packed kind — a packed `record` carries no
 *     signature and must never be minted (#1852);
 *   - a fresh device asks `GET /sync/packs` and gets a well-formed listing;
 *   - the vault converges either way — with packs present and with none at
 *     all, which is the item-granular fallback.
 *
 * What is NOT covered here, deliberately: downloading and applying pack bytes.
 * A pack is only fetchable through a presigned R2 GET, and Miniflare's R2
 * binding exposes no S3 endpoint to presign against, so this deployment shape
 * is exactly the "presign unconfigured" one — the listing arrives without a
 * url and the client falls back. Pack apply is covered by unit tests.
 */

import { test, expect, bootstrapSyncDevice } from './fixtures/sync-proxy-fixtures'
import { waitForAppReady } from './utils/electron-helpers'

const SEED_NOTE_COUNT = 40

interface PackRow {
  item_kind: string
  min_cursor: number
  max_cursor: number
  item_count: number
}

async function seedAndPush(
  page: Parameters<typeof waitForAppReady>[0],
  db: D1Database,
  email: string,
  prefix: string
): Promise<void> {
  await page.evaluate(
    async ({ notePrefix, total }) => {
      for (let i = 0; i < total; i++) {
        const result = await window.api.notes.create({
          title: `${notePrefix}-${String(i).padStart(3, '0')}`,
          content: `pack seed body ${i} :: ${'the quick brown fox '.repeat(6)}${i}`
        })
        if (!result.success) throw new Error(result.error ?? `create ${i} failed`)
      }
    },
    { notePrefix: prefix, total: SEED_NOTE_COUNT }
  )

  // Snapshots are what packs are built from, so wait for them server-side
  // rather than for the note records.
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.api.syncOps.triggerSync())
        const row = await db
          .prepare(
            `SELECT COUNT(*) AS c FROM crdt_snapshots
              WHERE user_id = (SELECT id FROM users WHERE email = ?)`
          )
          .bind(email)
          .first<{ c: number }>()
        return row?.c ?? 0
      },
      { timeout: 420_000, intervals: [2_000] }
    )
    .toBeGreaterThanOrEqual(SEED_NOTE_COUNT)
}

test.describe('Pack bootstrap', () => {
  test('the Worker builds snapshot packs and a fresh device bootstraps against them', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    syncBootstrap,
    syncProxy
  }) => {
    test.setTimeout(900_000)

    await bootstrapSyncDevice(electronAppA, syncBootstrap.deviceA)
    await pageA.reload()
    await pageA.waitForLoadState('domcontentloaded')
    await waitForAppReady(pageA)

    const db = await syncBootstrap.server.getD1()
    const prefix = `pack-${Date.now().toString(36)}`
    await seedAndPush(pageA, db, syncBootstrap.email, prefix)

    // ---- run the real compaction pipeline ---------------------------------
    await syncBootstrap.server.triggerScheduled()

    const packs = await db
      .prepare(
        `SELECT item_kind, min_cursor, max_cursor, item_count FROM pack_index
          WHERE user_id = (SELECT id FROM users WHERE email = ?)
          ORDER BY min_cursor ASC`
      )
      .bind(syncBootstrap.email)
      .all<PackRow>()
    const packRows = packs.results ?? []

    expect(packRows.length, 'the backfill built no packs at all').toBeGreaterThanOrEqual(1)
    // PACKED_KINDS is ['crdt_snapshot'] only: a packed record would carry no
    // signature and no client could verify it (#1852).
    expect([...new Set(packRows.map((row) => row.item_kind))]).toEqual(['crdt_snapshot'])
    expect(packRows.reduce((sum, row) => sum + row.item_count, 0)).toBeGreaterThanOrEqual(
      SEED_NOTE_COUNT
    )
    for (const row of packRows) {
      expect(row.max_cursor).toBeGreaterThanOrEqual(row.min_cursor)
    }

    // ---- fresh device -----------------------------------------------------
    await bootstrapSyncDevice(electronAppB, syncBootstrap.deviceB)
    await pageB.reload()
    await pageB.waitForLoadState('domcontentloaded')
    await waitForAppReady(pageB)

    await expect
      .poll(
        async () => {
          await pageB.evaluate(() => window.api.syncOps.triggerSync())
          return pageB.evaluate(
            (titlePrefix) =>
              window.api.notes
                .list({})
                .then((r) => r.notes.filter((n) => n.title.startsWith(titlePrefix)).length),
            prefix
          )
        },
        { timeout: 420_000, intervals: [2_000] }
      )
      .toBe(SEED_NOTE_COUNT)

    // The fresh device asked for the pack listing, and the server answered it.
    const packListings = syncProxy.requests({ method: 'GET', pathPrefix: '/sync/packs' })
    expect(packListings.length, 'a fresh device never asked for packs').toBeGreaterThanOrEqual(1)
    expect([...new Set(packListings.map((entry) => entry.status))]).toEqual([200])
  })

  test('a vault with no packs falls back to the item-granular bootstrap', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    syncBootstrap,
    syncProxy
  }) => {
    test.setTimeout(900_000)

    await bootstrapSyncDevice(electronAppA, syncBootstrap.deviceA)
    await pageA.reload()
    await pageA.waitForLoadState('domcontentloaded')
    await waitForAppReady(pageA)

    const db = await syncBootstrap.server.getD1()
    const prefix = `nopack-${Date.now().toString(36)}`
    await seedAndPush(pageA, db, syncBootstrap.email, prefix)

    // Deliberately NO scheduled run: this vault has never been compacted.
    const packCount = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM pack_index
          WHERE user_id = (SELECT id FROM users WHERE email = ?)`
      )
      .bind(syncBootstrap.email)
      .first<{ c: number }>()
    expect(packCount?.c ?? 0).toBe(0)

    await bootstrapSyncDevice(electronAppB, syncBootstrap.deviceB)
    await pageB.reload()
    await pageB.waitForLoadState('domcontentloaded')
    await waitForAppReady(pageB)

    await expect
      .poll(
        async () => {
          await pageB.evaluate(() => window.api.syncOps.triggerSync())
          return pageB.evaluate(
            (titlePrefix) =>
              window.api.notes
                .list({})
                .then((r) => r.notes.filter((n) => n.title.startsWith(titlePrefix)).length),
            prefix
          )
        },
        { timeout: 420_000, intervals: [2_000] }
      )
      .toBe(SEED_NOTE_COUNT)

    // Asking is fine; every pack listing must have been an empty, healthy one.
    for (const entry of syncProxy.requests({ method: 'GET', pathPrefix: '/sync/packs' })) {
      expect(entry.status).toBe(200)
    }
  })
})

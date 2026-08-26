/**
 * Seeding-push cursor semantics E2E (#1833).
 *
 * The push rewrite stages a wave and commits the cursor range in one atomic
 * `db.batch`, so a wave lands whole or rejects whole. Two consequences are
 * observable in D1 and are what this spec pins:
 *
 *   - A seeding-sized push (well past the 100-item request cap, so several
 *     waves) leaves a CONTIGUOUS cursor range with no gaps. A wave that
 *     allocated cursors and then failed part-way would burn cursors and show
 *     up here as a hole.
 *   - No two items share a cursor.
 *
 * Compat matrix: the same server still accepts the one-item batches an older
 * client produces, and those land in the same gap-free sequence. Small-batch
 * pushes are issued by the second device, which is a genuinely separate
 * client rather than a replayed payload.
 */

import { test, expect, bootstrapSyncDevice } from './fixtures/sync-auth-fixtures'
import { waitForAppReady } from './utils/electron-helpers'

/** `notes:list` pages at 100 by default; the seeds are larger than that. */
const NOTE_LIST_LIMIT = 1000

/** Past the 100-item `PushRequestSchema` cap, so the seed spans several waves. */
const SEED_NOTE_COUNT = 130

interface CursorShape {
  count: number
  distinctCursors: number
  minCursor: number
  maxCursor: number
}

async function readCursorShape(db: D1Database, email: string): Promise<CursorShape> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count,
              COUNT(DISTINCT server_cursor) AS distinctCursors,
              MIN(server_cursor) AS minCursor,
              MAX(server_cursor) AS maxCursor
         FROM sync_items
        WHERE user_id = (SELECT id FROM users WHERE email = ?)`
    )
    .bind(email)
    .first<CursorShape>()
  if (!row) throw new Error('no sync_items rows for the test account')
  return row
}

test.describe('Seeding push', () => {
  test('a seeding-sized push lands as one gap-free cursor range and small batches still land', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    syncBootstrap
  }) => {
    test.setTimeout(900_000)

    await bootstrapSyncDevice(electronAppA, syncBootstrap.deviceA)
    await pageA.reload()
    await pageA.waitForLoadState('domcontentloaded')
    await waitForAppReady(pageA)

    const prefix = `seed-${Date.now().toString(36)}`
    const created = await pageA.evaluate(
      async ({ notePrefix, total }) => {
        const ids: string[] = []
        for (let i = 0; i < total; i++) {
          const result = await window.api.notes.create({
            title: `${notePrefix}-${String(i).padStart(4, '0')}`,
            content: `seeding push body ${i}`
          })
          if (!result.success || !result.note) {
            throw new Error(result.error ?? `failed to create note ${i}`)
          }
          ids.push(result.note.id)
        }
        return ids
      },
      { notePrefix: prefix, total: SEED_NOTE_COUNT }
    )
    expect(created).toHaveLength(SEED_NOTE_COUNT)

    const db = await syncBootstrap.server.getD1()
    await expect
      .poll(
        async () => {
          await pageA.evaluate(() => window.api.syncOps.triggerSync())
          const row = await db
            .prepare(
              `SELECT COUNT(*) AS c FROM sync_items
                WHERE user_id = (SELECT id FROM users WHERE email = ?)
                  AND item_type = 'note' AND deleted_at IS NULL`
            )
            .bind(syncBootstrap.email)
            .first<{ c: number }>()
          return row?.c ?? 0
        },
        { timeout: 420_000, intervals: [2_000] }
      )
      .toBeGreaterThanOrEqual(SEED_NOTE_COUNT)

    const afterSeed = await readCursorShape(db, syncBootstrap.email)
    expect(afterSeed.distinctCursors, 'two items shared a cursor').toBe(afterSeed.count)
    expect(
      afterSeed.maxCursor - afterSeed.minCursor + 1,
      'the seeding push left a hole in the cursor sequence — a wave did not land whole'
    ).toBe(afterSeed.count)

    // ---- compat: one-item batches from a second client --------------------
    await bootstrapSyncDevice(electronAppB, syncBootstrap.deviceB)
    await pageB.reload()
    await pageB.waitForLoadState('domcontentloaded')
    await waitForAppReady(pageB)

    // Sync B down to the seeded state first, so its own pushes are the only
    // new items and the range stays attributable.
    await expect
      .poll(
        async () => {
          await pageB.evaluate(() => window.api.syncOps.triggerSync())
          return pageB.evaluate(
            ({ titlePrefix, limit }) =>
              window.api.notes
                .list({ limit })
                .then((r) => r.notes.filter((n) => n.title.startsWith(titlePrefix)).length),
            { titlePrefix: prefix, limit: NOTE_LIST_LIMIT }
          )
        },
        { timeout: 420_000, intervals: [2_000] }
      )
      .toBe(SEED_NOTE_COUNT)

    const smallBatchTitles: string[] = []
    for (let i = 0; i < 3; i++) {
      const title = `${prefix}-small-${i}`
      smallBatchTitles.push(title)
      await pageB.evaluate(async (noteTitle) => {
        const result = await window.api.notes.create({
          title: noteTitle,
          content: `small batch body ${noteTitle}`
        })
        if (!result.success) throw new Error(result.error ?? 'small-batch create failed')
      }, title)
      // One create, one sync: the smallest wave an old client ever produces.
      await pageB.evaluate(() => window.api.syncOps.triggerSync())
    }

    await expect
      .poll(
        async () => {
          await pageB.evaluate(() => window.api.syncOps.triggerSync())
          const row = await db
            .prepare(
              `SELECT COUNT(*) AS c FROM sync_items
                WHERE user_id = (SELECT id FROM users WHERE email = ?)
                  AND item_type = 'note' AND deleted_at IS NULL`
            )
            .bind(syncBootstrap.email)
            .first<{ c: number }>()
          return row?.c ?? 0
        },
        { timeout: 300_000, intervals: [2_000] }
      )
      .toBeGreaterThanOrEqual(SEED_NOTE_COUNT + smallBatchTitles.length)

    const afterSmall = await readCursorShape(db, syncBootstrap.email)
    expect(afterSmall.distinctCursors).toBe(afterSmall.count)
    expect(
      afterSmall.maxCursor - afterSmall.minCursor + 1,
      'a one-item batch left a hole in the cursor sequence'
    ).toBe(afterSmall.count)
    expect(afterSmall.count).toBeGreaterThan(afterSeed.count)
  })
})

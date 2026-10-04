/**
 * Attachment upload re-drive E2E (#2651).
 *
 * A file that lands in a note's attachments folder without a save event (the
 * watcher never sees that folder) is queued only by the backfill, and the
 * backfill and the outbox drain used to run once, when the sync runtime
 * started. This drives the real app against the local sync server: a file
 * added after the start reaches the server once the connection comes back,
 * without a restart.
 */

import fs from 'node:fs'
import path from 'node:path'

import { test, expect, bootstrapSyncDevice } from './fixtures/sync-auth-fixtures'
import { waitForAppReady } from './utils/electron-helpers'
import { goOffline, goOnline } from './utils/network-control'

test.describe('Attachment upload re-drive', () => {
  test('uploads a file added mid-session once the connection comes back', async ({
    electronAppA,
    pageA,
    vaultPathA,
    syncBootstrap
  }) => {
    test.setTimeout(300_000)

    const noteId = await pageA.evaluate(async () => {
      const created = await window.api.notes.create({ title: 'upload redrive', content: 'body' })
      if (!created.success || !created.note) throw new Error(created.error ?? 'create failed')
      return created.note.id
    })

    await bootstrapSyncDevice(electronAppA, syncBootstrap.deviceA)
    await pageA.reload()
    await pageA.waitForLoadState('domcontentloaded')
    await waitForAppReady(pageA)
    await expect
      .poll(() => pageA.evaluate(() => window.api.syncOps.triggerSync().then((r) => r.success)), {
        timeout: 60_000
      })
      .toBe(true)

    // The backfill scans the vault recorded as current, which opening a vault
    // sets. The harness opens TEST_VAULT_PATH without recording it, and doing
    // so before sign-in would hold sync for a vault with local content.
    await electronAppA.evaluate((_context, vaultPath) => {
      const debug = (
        globalThis as typeof globalThis & {
          __memryDebug?: { store: { set(key: string, value: unknown): void } }
        }
      ).__memryDebug
      if (!debug) throw new Error('Memry debug handles are not registered')
      debug.store.set('currentVault', vaultPath)
    }, vaultPathA)

    const db = await syncBootstrap.server.getD1()
    const uploadedChunks = async (): Promise<number> => {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS c FROM blob_chunks
             WHERE user_id = (SELECT id FROM users WHERE email = ?)`
        )
        .bind(syncBootstrap.email)
        .first<{ c: number }>()
      return row?.c ?? 0
    }

    const dir = path.join(vaultPathA, 'attachments', noteId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'mid-session.txt'), 'added after the sync runtime started')
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    expect(await uploadedChunks(), 'nothing uploads the file before the reconnect').toBe(0)

    await goOffline(electronAppA)
    await goOnline(electronAppA)

    await expect
      .poll(uploadedChunks, {
        message: 'the reconnect re-drive uploads the file',
        timeout: 60_000
      })
      .toBeGreaterThan(0)
  })
})

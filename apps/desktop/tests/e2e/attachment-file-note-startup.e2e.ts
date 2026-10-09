/**
 * A file note indexed at startup, across two devices (#2965). The image is in
 * device A's vault before A launches, so the watcher never sees it add. The
 * backfill queues it under the file note's own id, and device B gets it at
 * `sources/photo.png`.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'

import { test as base, expect, bootstrapSyncDevice } from './fixtures/sync-auth-fixtures'
import { waitForAppReady } from './utils/electron-helpers'
import { goOffline, goOnline } from './utils/network-control'

type DebugGlobal = typeof globalThis & {
  __memryDebug?: {
    query(sql: string, ...params: unknown[]): unknown[]
    store: { set(key: string, value: unknown): void }
  }
}

// A 1x1 PNG with a unique trailer so its checksum is new to the server.
const png = Buffer.concat([
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  ),
  Buffer.from(`memry ${Date.now()}`)
])

// electronAppA depends on vaultPathA, so the file is on disk before A launches.
const test = base.extend({
  vaultPathA: async ({ vaultPathA }, use) => {
    fs.mkdirSync(path.join(vaultPathA, 'sources'), { recursive: true })
    fs.writeFileSync(path.join(vaultPathA, 'sources', 'photo.png'), png)
    await use(vaultPathA)
  }
})

async function signIn(
  app: ElectronApplication,
  page: Page,
  vaultPath: string,
  device: Parameters<typeof bootstrapSyncDevice>[1]
): Promise<void> {
  await bootstrapSyncDevice(app, device)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await waitForAppReady(page)
  await app.evaluate((_context, vault) => {
    const debug = (globalThis as DebugGlobal).__memryDebug
    if (!debug) throw new Error('Memry debug handles are not registered')
    debug.store.set('currentVault', vault)
  }, vaultPath)
}

function query<T>(app: ElectronApplication, sql: string, ...params: unknown[]): Promise<T[]> {
  return app.evaluate(
    (_context, args) => {
      const debug = (globalThis as DebugGlobal).__memryDebug
      if (!debug) throw new Error('Memry debug handles are not registered')
      return debug.query(args.sql, ...args.params)
    },
    { sql, params }
  ) as Promise<T[]>
}

test.describe('File note indexed at startup', () => {
  test('uploads its own bytes and lands on a second device', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    vaultPathB,
    vaultPathA,
    syncBootstrap
  }) => {
    test.setTimeout(420_000)

    await signIn(electronAppA, pageA, vaultPathA, syncBootstrap.deviceA)
    await expect
      .poll(
        async () =>
          (
            await query(
              electronAppA,
              "SELECT id FROM note_metadata WHERE path = 'sources/photo.png'"
            )
          ).length,
        { message: 'A indexes the image at startup', timeout: 60_000 }
      )
      .toBe(1)
    // A reconnect runs the upload re-drive now instead of at its five-minute tick.
    await goOffline(electronAppA)
    await goOnline(electronAppA)
    await expect
      .poll(
        async () => {
          await pageA.evaluate(() => window.api.syncOps.triggerSync())
          const rows = await query<{ attachmentId: string | null }>(
            electronAppA,
            "SELECT attachment_id AS attachmentId FROM note_metadata WHERE path = 'sources/photo.png'"
          )
          return rows[0]?.attachmentId ?? null
        },
        { message: 'the file note uploads under its own id', timeout: 180_000 }
      )
      .not.toBeNull()

    await signIn(electronAppB, pageB, vaultPathB, syncBootstrap.deviceB)
    const onB = path.join(vaultPathB, 'sources', 'photo.png')
    await expect
      .poll(
        async () => {
          await pageA.evaluate(() => window.api.syncOps.triggerSync())
          await pageB.evaluate(() => window.api.syncOps.triggerSync())
          return fs.existsSync(onB)
        },
        { message: 'the file note lands on B at its own path', timeout: 180_000 }
      )
      .toBe(true)
    await expect.poll(() => fs.readFileSync(onB).equals(png), { timeout: 30_000 }).toBe(true)
  })
})

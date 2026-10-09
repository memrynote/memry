/**
 * An embedded vault file that is a file note of its own, across two devices
 * (#2812). Device A has `sources/photo.png`, indexed as a file note, and a note
 * that embeds it. The bytes reach the server once, with the file note, and
 * device B ends with one copy at `sources/photo.png`.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'

import { test, expect, bootstrapSyncDevice } from './fixtures/sync-auth-fixtures'
import { waitForAppReady } from './utils/electron-helpers'
import { goOffline, goOnline } from './utils/network-control'

type DebugGlobal = typeof globalThis & {
  __memryDebug?: {
    query(sql: string, ...params: unknown[]): unknown[]
    store: { set(key: string, value: unknown): void }
  }
}

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

const readOrNull = (file: string): string | null =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null

test.describe('Embedded file note', () => {
  test('uploads once and lands once on a second device', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    vaultPathA,
    vaultPathB,
    syncBootstrap
  }) => {
    test.setTimeout(420_000)

    // A 1x1 PNG with a unique trailer so its checksum is new to the server.
    const png = Buffer.concat([
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
      ),
      Buffer.from(`memry ${Date.now()}`)
    ])
    await signIn(electronAppA, pageA, vaultPathA, syncBootstrap.deviceA)
    // Added while A runs, so the watcher indexes it and queues its upload.
    fs.mkdirSync(path.join(vaultPathA, 'sources'), { recursive: true })
    fs.writeFileSync(path.join(vaultPathA, 'sources', 'photo.png'), png)
    await expect
      .poll(
        async () =>
          (
            await query<{ id: string }>(
              electronAppA,
              "SELECT id FROM note_metadata WHERE path = 'sources/photo.png'"
            )
          ).length,
        { message: 'A indexes the image as a file note', timeout: 60_000 }
      )
      .toBe(1)

    const db = await syncBootstrap.server.getD1()
    const serverChunks = async (): Promise<number> => {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS c FROM blob_chunks
             WHERE user_id = (SELECT id FROM users WHERE email = ?)`
        )
        .bind(syncBootstrap.email)
        .first<{ c: number }>()
      return row?.c ?? 0
    }
    await expect
      .poll(
        async () => {
          await pageA.evaluate(() => window.api.syncOps.triggerSync())
          return serverChunks()
        },
        { message: 'the file note uploads', timeout: 120_000 }
      )
      .toBeGreaterThan(0)
    const chunksAfterFileNote = await serverChunks()

    const noteId = await pageA.evaluate(async () => {
      const created = await window.api.notes.create({ title: 'trip', content: 'body' })
      if (!created.success || !created.note) throw new Error(created.error ?? 'create failed')
      const updated = await window.api.notes.update({
        id: created.note.id,
        content: '![p](sources/photo.png)\n'
      })
      if (!updated.success) throw new Error(updated.error ?? 'update failed')
      return created.note.id
    })

    const bodyOnB = async (): Promise<string | null> => {
      await pageA.evaluate(() => window.api.syncOps.triggerSync())
      await pageB.evaluate(() => window.api.syncOps.triggerSync())
      const rows = await query<{ path: string }>(
        electronAppB,
        'SELECT path FROM note_metadata WHERE id = ?',
        noteId
      )
      return rows[0] ? readOrNull(path.join(vaultPathB, rows[0].path)) : null
    }
    await signIn(electronAppB, pageB, vaultPathB, syncBootstrap.deviceB)
    await expect
      .poll(bodyOnB, { message: 'the embedding note reaches B', timeout: 120_000 })
      .toContain('sources/photo.png')
    await expect
      .poll(() => fs.existsSync(path.join(vaultPathB, 'sources', 'photo.png')), {
        message: 'the file note lands on B at its own path',
        timeout: 120_000
      })
      .toBe(true)

    await goOffline(electronAppA)
    await goOnline(electronAppA)
    await expect
      .poll(() => query(electronAppA, 'SELECT note_id FROM attachment_upload_queue'), {
        message: "A's outbox settles",
        timeout: 60_000
      })
      .toEqual([])
    await pageA.evaluate(() => window.api.syncOps.triggerSync())
    await pageB.evaluate(() => window.api.syncOps.triggerSync())

    const refs = await query<{ refs: string | null }>(
      electronAppA,
      'SELECT attachment_references AS refs FROM note_metadata WHERE id = ?',
      noteId
    )
    expect(refs[0]?.refs ? JSON.parse(refs[0].refs) : [], 'the note holds no copy').toEqual([])
    expect(await serverChunks(), 'the embed uploaded nothing').toBe(chunksAfterFileNote)
    expect(fs.existsSync(path.join(vaultPathB, 'attachments', noteId, 'photo.png'))).toBe(false)
    expect(fs.readFileSync(path.join(vaultPathB, 'sources', 'photo.png')).equals(png)).toBe(true)
  })
})

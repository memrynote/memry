/**
 * Attachments a note links outside its own folder, across two devices (#2755).
 *
 * Device A embeds two vault files from `sources/`. Device B starts fresh: the
 * first file must land at the path the body links, not in the note's
 * attachments folder. B already holds the second file at its linked path, the
 * way a vault also kept in iCloud would, so the download stays in the note's
 * folder and B's own copy must be tied to the attachment already on the server
 * instead of being uploaded a second time.
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

test.describe('Attachments linked outside the note folder', () => {
  test('land at the linked path on a fresh device and are not uploaded twice', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    vaultPathA,
    vaultPathB,
    syncBootstrap
  }) => {
    test.setTimeout(420_000)

    const linkedBytes = `linked ${Date.now()} ${'a'.repeat(64)}`
    const sharedBytes = `shared ${Date.now()} ${'b'.repeat(64)}`
    fs.mkdirSync(path.join(vaultPathA, 'sources'), { recursive: true })
    fs.writeFileSync(path.join(vaultPathA, 'sources', 'linked.txt'), linkedBytes)
    fs.writeFileSync(path.join(vaultPathA, 'sources', 'shared.txt'), sharedBytes)

    await signIn(electronAppA, pageA, vaultPathA, syncBootstrap.deviceA)
    const noteId = await pageA.evaluate(async () => {
      const created = await window.api.notes.create({ title: 'linked sources', content: 'body' })
      if (!created.success || !created.note) throw new Error(created.error ?? 'create failed')
      const updated = await window.api.notes.update({
        id: created.note.id,
        content: '![linked](sources/linked.txt)\n'
      })
      if (!updated.success) throw new Error(updated.error ?? 'update failed')
      return created.note.id
    })

    const referencesOn = async (app: ElectronApplication): Promise<string[]> => {
      const rows = await query<{ refs: string | null }>(
        app,
        'SELECT attachment_references AS refs FROM note_metadata WHERE id = ?',
        noteId
      )
      return rows[0]?.refs ? (JSON.parse(rows[0].refs) as string[]) : []
    }
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
    const pushFromA = async (): Promise<void> => {
      await pageA.evaluate(() => window.api.syncOps.triggerSync())
    }

    await expect.poll(() => referencesOn(electronAppA), { timeout: 60_000 }).toHaveLength(1)
    await pushFromA()

    await signIn(electronAppB, pageB, vaultPathB, syncBootstrap.deviceB)
    const ownFolderB = path.join(vaultPathB, 'attachments', noteId)
    await expect
      .poll(
        async () => {
          await pageB.evaluate(() => window.api.syncOps.triggerSync())
          return {
            linkedPath: readOrNull(path.join(vaultPathB, 'sources', 'linked.txt')),
            noteFolder: readOrNull(path.join(ownFolderB, 'linked.txt'))
          }
        },
        { message: 'the linked file lands at the path the body links', timeout: 120_000 }
      )
      .toEqual({ linkedPath: linkedBytes, noteFolder: null })

    const updated = await pageA.evaluate(
      (id) =>
        window.api.notes.update({
          id,
          content: '![linked](sources/linked.txt)\n\n![shared](sources/shared.txt)\n'
        }),
      noteId
    )
    expect(updated.success, updated.error ?? 'update failed').toBe(true)
    await expect.poll(() => referencesOn(electronAppA), { timeout: 60_000 }).toHaveLength(2)
    const uploadedIds = (await referencesOn(electronAppA)).sort()
    const chunksAfterA = await serverChunks()

    fs.writeFileSync(path.join(vaultPathB, 'sources', 'shared.txt'), sharedBytes)
    await expect
      .poll(
        async () => {
          await pushFromA()
          await pageB.evaluate(() => window.api.syncOps.triggerSync())
          return readOrNull(path.join(ownFolderB, 'shared.txt'))
        },
        {
          message: 'a taken linked path keeps the download in the note folder',
          timeout: 120_000
        }
      )
      .toBe(sharedBytes)
    expect(readOrNull(path.join(vaultPathB, 'sources', 'shared.txt'))).toBe(sharedBytes)

    await goOffline(electronAppB)
    await goOnline(electronAppB)
    const sharedRecord = (): Promise<Array<{ id: string | null }>> =>
      query(
        electronAppB,
        'SELECT attachment_id AS id FROM attachment_files WHERE note_id = ? AND path = ?',
        noteId,
        'sources/shared.txt'
      )
    await expect
      .poll(sharedRecord, { message: 'B records its own copy', timeout: 120_000 })
      .toHaveLength(1)
    await expect
      .poll(() => query(electronAppB, 'SELECT note_id FROM attachment_upload_queue'), {
        message: "B's outbox settles",
        timeout: 60_000
      })
      .toEqual([])

    expect(await serverChunks(), 'B uploaded nothing').toBe(chunksAfterA)
    expect(uploadedIds).toContain((await sharedRecord())[0].id)
    expect((await referencesOn(electronAppB)).sort()).toEqual(uploadedIds)
  })
})

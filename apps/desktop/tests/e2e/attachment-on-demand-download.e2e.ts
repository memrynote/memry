/**
 * Attachment auto-download off (#5616). The setting says files "download only
 * when you open them", so device B, with the setting off, holds neither an
 * embedded image nor a binary note's file after the pull, and gets each one
 * when the note is opened.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'

import { test, expect, bootstrapSyncDevice } from './fixtures/sync-auth-fixtures'
import { SELECTORS, waitForAppReady } from './utils/electron-helpers'
import { minimalPdfBytes } from './utils/desktop-test-helpers'

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

async function openInUi(page: Page, note: { id: string; title: string }): Promise<void> {
  // The open listener mounts with the vault, and a CustomEvent has no queue:
  // re-dispatch until the tab shows. OPEN_TAB dedupes by entityId.
  const tab = page.locator(SELECTORS.tab).filter({ hasText: note.title }).first()
  await expect
    .poll(
      async () => {
        await page.evaluate((detail) => {
          window.dispatchEvent(new CustomEvent('memry:test-open-note', { detail }))
        }, note)
        return tab.isVisible().catch(() => false)
      },
      { timeout: 30_000 }
    )
    .toBe(true)
}

test.describe('Attachment auto-download off', () => {
  test('opening a note downloads its embedded image and a binary note its file', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    vaultPathA,
    vaultPathB,
    syncBootstrap
  }) => {
    test.setTimeout(480_000)

    const png = Buffer.concat([
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
      ),
      Buffer.from(`memry ${Date.now()}`)
    ])

    // B is set to on-demand before it ever pulls.
    const setting = await pageB.evaluate(() =>
      window.api.settings.setSyncSettings({ attachmentAutoDownload: false })
    )
    expect(setting.success, setting.error ?? 'could not turn auto-download off').toBe(true)

    await signIn(electronAppA, pageA, vaultPathA, syncBootstrap.deviceA)
    // A binary note: a PDF added while A runs is indexed as a file note.
    fs.mkdirSync(path.join(vaultPathA, 'files'), { recursive: true })
    fs.writeFileSync(path.join(vaultPathA, 'files', 'report.pdf'), minimalPdfBytes())

    const embedded = await pageA.evaluate(async (bytes) => {
      const created = await window.api.notes.create({ title: 'on-demand', content: 'body' })
      if (!created.success || !created.note) throw new Error(created.error ?? 'create failed')
      const file = new File([new Uint8Array(bytes)], 'photo.png', { type: 'image/png' })
      const uploaded = await window.api.notes.uploadAttachment(created.note.id, file)
      if (!uploaded.success || !uploaded.path) throw new Error(uploaded.error ?? 'upload failed')
      const updated = await window.api.notes.update({
        id: created.note.id,
        content: `![photo](${uploaded.path})\n`
      })
      if (!updated.success) throw new Error(updated.error ?? 'update failed')
      const listed = await window.api.notes.listAttachments(created.note.id)
      return { noteId: created.note.id, filename: listed[0]?.filename ?? '' }
    }, Array.from(png))
    expect(embedded.filename).not.toBe('')

    await expect
      .poll(
        async () => {
          await pageA.evaluate(() => window.api.syncOps.triggerSync())
          const rows = await query<{ refs: string | null; binary: string | null }>(
            electronAppA,
            `SELECT
               (SELECT attachment_references FROM note_metadata WHERE id = ?) AS refs,
               (SELECT attachment_id FROM note_metadata WHERE path = 'files/report.pdf') AS binary`,
            embedded.noteId
          )
          const row = rows[0]
          return Boolean(row?.refs && JSON.parse(row.refs).length > 0 && row.binary)
        },
        { message: 'A uploads the embed and the binary note', timeout: 120_000 }
      )
      .toBe(true)

    await signIn(electronAppB, pageB, vaultPathB, syncBootstrap.deviceB)
    let binaryId = ''
    await expect
      .poll(
        async () => {
          await pageA.evaluate(() => window.api.syncOps.triggerSync())
          await pageB.evaluate(() => window.api.syncOps.triggerSync())
          const rows = await query<{ refs: string | null; id: string | null }>(
            electronAppB,
            `SELECT
               (SELECT attachment_references FROM note_metadata WHERE id = ?) AS refs,
               (SELECT id FROM note_metadata WHERE attachment_id IS NOT NULL AND file_type = 'pdf') AS id`,
            embedded.noteId
          )
          const row = rows[0]
          binaryId = row?.id ?? ''
          return Boolean(row?.refs && JSON.parse(row.refs).length > 0 && row.id)
        },
        { message: 'both notes reach B with their attachment ids', timeout: 120_000 }
      )
      .toBe(true)

    const imageOnB = path.join(vaultPathB, 'attachments', embedded.noteId, embedded.filename)
    const binaryRow = await query<{ path: string }>(
      electronAppB,
      'SELECT path FROM note_metadata WHERE id = ?',
      binaryId
    )
    const binaryOnB = path.join(vaultPathB, binaryRow[0].path)
    const noteRow = await query<{ path: string }>(
      electronAppB,
      'SELECT path FROM note_metadata WHERE id = ?',
      embedded.noteId
    )
    const noteOnB = path.join(vaultPathB, noteRow[0].path)
    // The body travels as a CRDT update, apart from the note's metadata.
    await expect
      .poll(
        async () => {
          await pageB.evaluate(() => window.api.syncOps.triggerSync())
          return fs.existsSync(noteOnB) && fs.readFileSync(noteOnB, 'utf8').includes('photo')
        },
        { message: 'the note body with its embed reaches B', timeout: 120_000 }
      )
      .toBe(true)
    // Off means off: the pull fetched neither file.
    await pageB.evaluate(() => window.api.syncOps.triggerSync())
    expect(fs.existsSync(imageOnB), 'no background download of the embed').toBe(false)
    expect(fs.existsSync(binaryOnB), 'no background download of the binary note').toBe(false)

    await openInUi(pageB, { id: embedded.noteId, title: 'on-demand' })
    await expect
      .poll(() => fs.existsSync(imageOnB), {
        message: 'opening the note downloads its image',
        timeout: 60_000
      })
      .toBe(true)
    expect(fs.readFileSync(imageOnB).equals(png)).toBe(true)
    await expect(pageB.locator('img[src*="photo"]').first()).toBeVisible()
    await pageB.screenshot({ path: test.info().outputPath('embed-on-demand.png') })

    await openInUi(pageB, { id: binaryId, title: 'report' })
    await expect
      .poll(() => fs.existsSync(binaryOnB), {
        message: 'opening the binary note downloads its file',
        timeout: 60_000
      })
      .toBe(true)
    expect(fs.readFileSync(binaryOnB).equals(minimalPdfBytes())).toBe(true)
    await pageB.screenshot({ path: test.info().outputPath('binary-on-demand.png') })
  })
})

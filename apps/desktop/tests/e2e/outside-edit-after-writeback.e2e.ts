/**
 * An edit made outside the app right after a write-back reaches the open
 * editor at once (#5605). The watcher used to drop every event on a note's
 * file for 5 s after the app wrote it, so an edit made in that window stayed
 * on disk, out of the editor, until some later pass replaced the body with it.
 */

import * as fs from 'fs'
import * as path from 'path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  ensureDayPanelClosed,
  SELECTORS,
  waitForAppReady,
  waitForVaultReady
} from './utils/electron-helpers'
import { createNoteWithBody, getWritebackDebugById } from './utils/note-sync-helpers'

async function noteFilePath(page: Page, noteId: string): Promise<string> {
  const [vaultPath, notePath] = await page.evaluate(async (id) => {
    const status = await window.api.vault.getStatus()
    const note = await window.api.notes.get(id)
    return [status?.path ?? null, note?.path ?? null]
  }, noteId)
  if (!vaultPath || !notePath) throw new Error(`no file for note ${noteId}`)
  return path.join(vaultPath, notePath)
}

async function typeAtEndOfFirstLine(page: Page, text: string): Promise<void> {
  await page
    .locator(SELECTORS.noteEditor)
    .first()
    .click({ position: { x: 2, y: 10 } })
  await page.keyboard.press('End')
  await page.keyboard.type(text)
}

test.describe('outside edit right after a write-back (#5605)', () => {
  test.setTimeout(120_000)

  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
    await ensureDayPanelClosed(page)
  })

  test('shows an outside edit made within a second of a write-back, and keeps typing after it', async ({
    page,
    electronApp
  }) => {
    const note = await createNoteWithBody(page, `Outside Edit ${Date.now()}`, 'First line.')
    const file = await noteFilePath(page, note.id)
    const editor = page.locator(SELECTORS.noteEditor).first()

    // The user types, and the write-back writes the file.
    const before = (await getWritebackDebugById(electronApp, note.id))?.performedCount ?? 0
    await typeAtEndOfFirstLine(page, ' Typed here.')
    await expect
      .poll(
        async () =>
          ((await getWritebackDebugById(electronApp, note.id))?.performedCount ?? 0) > before &&
          fs.readFileSync(file, 'utf8').includes('First line. Typed here.'),
        { timeout: 20_000, intervals: [50] }
      )
      .toBe(true)
    const writtenBackSeenAt = Date.now()

    // Another program appends a line within a second of that write.
    fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}\nOutside line.\n`)
    expect(Date.now() - writtenBackSeenAt).toBeLessThan(1000)

    await expect(editor).toContainText('Outside line.', { timeout: 2000 })

    // Typing again keeps both edits, in the editor and in the file.
    await typeAtEndOfFirstLine(page, ' And more.')
    await expect
      .poll(
        () => {
          const onDisk = fs.readFileSync(file, 'utf8')
          return (
            onDisk.includes('First line. Typed here. And more.') && onDisk.includes('Outside line.')
          )
        },
        { timeout: 20_000 }
      )
      .toBe(true)
    await expect(editor).toContainText('First line. Typed here. And more.')
    await expect(editor).toContainText('Outside line.')
  })
})

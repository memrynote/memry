/**
 * Shared attachment references E2E (issue #2077).
 *
 * One PDF, two notes, one blob. Covers the user-visible insert path end to end
 * against a real vault on disk:
 *  - `/existing attachment` in the second note lists what the vault stores and
 *    inserts a ref into the FIRST note's attachments folder;
 *  - no second copy of the bytes lands anywhere;
 *  - the relationship survives a restart (the note body on disk still resolves);
 *  - deleting the attachment from the owning note keeps the bytes while the
 *    second note still references them.
 */

import fs from 'fs'
import path from 'path'
import { test, expect } from './fixtures'
import { ready, uniqueLabel, minimalPdfBytes } from './utils/desktop-test-helpers'
import { SELECTORS } from './utils/electron-helpers'

const ORIGINAL_NAME = 'shared-report.pdf'

test.describe('Shared attachment references', () => {
  test('one PDF inserted into a second note stores one blob and survives a restart', async ({
    page,
    testVaultPath
  }) => {
    await ready(page)

    const ownerTitle = uniqueLabel('Shared Owner')
    const borrowerTitle = uniqueLabel('Shared Borrower')

    // Note A uploads the PDF; note B is created empty and opened.
    const seeded = await page.evaluate(
      async ({ ownerTitle, borrowerTitle, fileName, bytes }) => {
        const api = window.api

        const owner = await api.notes.create({ title: ownerTitle, content: 'owns the pdf' })
        if (!owner.success || !owner.note) throw new Error(owner.error ?? 'owner create failed')

        const file = new File([new Uint8Array(bytes)], fileName, { type: 'application/pdf' })
        const uploaded = await api.notes.uploadAttachment(owner.note.id, file)
        if (!uploaded.success) throw new Error(uploaded.error ?? 'upload failed')

        const attachments = await api.notes.listAttachments(owner.note.id)
        const storedFilename = attachments[0]?.filename
        if (!storedFilename) throw new Error('uploaded attachment not listed')

        const borrower = await api.notes.create({ title: borrowerTitle, content: '' })
        if (!borrower.success || !borrower.note) {
          throw new Error(borrower.error ?? 'borrower create failed')
        }

        return {
          ownerNoteId: owner.note.id,
          borrowerNoteId: borrower.note.id,
          storedFilename
        }
      },
      {
        ownerTitle,
        borrowerTitle,
        fileName: ORIGINAL_NAME,
        bytes: [...minimalPdfBytes()]
      }
    )

    await restoreSingleNoteTab(page, testVaultPath, seeded.borrowerNoteId, borrowerTitle)

    // The user-visible path: `/` slash menu → "Existing attachment" → pick.
    const editor = page.locator(SELECTORS.noteEditor).first()
    await editor.click()
    await page.keyboard.type('/existing')

    await page.getByText('Existing attachment', { exact: true }).first().click()

    const dialog = page.getByTestId('insert-existing-attachment-dialog')
    await expect(dialog).toBeVisible()

    const row = dialog.getByTestId('insert-existing-attachment-row').filter({
      hasText: ORIGINAL_NAME
    })
    await expect(row).toHaveCount(1)
    await row.click()
    await expect(dialog).toBeHidden()

    // The block renders from the OWNER's folder. A PDF renders as the inline
    // preview rather than the plain file card, so key on the preview's scroller.
    await page
      .getByTestId('pdf-embed-scroll')
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 })

    // One blob, in the owner's folder only. The borrower never got a copy.
    const ownerDir = path.join(testVaultPath, 'attachments', seeded.ownerNoteId)
    const borrowerDir = path.join(testVaultPath, 'attachments', seeded.borrowerNoteId)
    expect(fs.readdirSync(ownerDir)).toEqual([seeded.storedFilename])
    expect(fs.existsSync(borrowerDir)).toBe(false)

    // Restart: the ref on disk still resolves to the one blob.
    await page.reload()
    await ready(page)
    await page.locator(SELECTORS.noteEditor).first().waitFor({ state: 'visible', timeout: 20_000 })
    await page
      .getByTestId('pdf-embed-scroll')
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    await expect(page.getByTestId('attachment-missing-card')).toHaveCount(0)

    // The ref the note actually carries, read off disk — it names the OWNER's
    // folder, at whatever depth the borrowing note happens to sit.
    const borrowerNote = await page.evaluate(
      (id) => window.api.notes.get(id),
      seeded.borrowerNoteId
    )
    const borrowerBody = fs.readFileSync(path.join(testVaultPath, borrowerNote!.path), 'utf-8')
    const refMatch = borrowerBody.match(/"url":"([^"]+)"/)
    expect(refMatch?.[1]).toContain(`attachments/${seeded.ownerNoteId}/${seeded.storedFilename}`)

    const resolved = await page.evaluate(
      ({ borrowerNoteId, url }) => window.api.notes.resolveAttachment(borrowerNoteId, url),
      { borrowerNoteId: seeded.borrowerNoteId, url: refMatch![1] }
    )
    expect(resolved.exists).toBe(true)
    expect(resolved.storedFilename).toBe(seeded.storedFilename)

    // Deleting from the OWNING note must not take the borrower's embed with it.
    const deletion = await page.evaluate(
      ({ ownerNoteId, storedFilename }) =>
        window.api.notes.deleteAttachment(ownerNoteId, storedFilename),
      seeded
    )
    expect(deletion.success).toBe(true)
    expect(deletion.deleted).toBe(false)
    expect(deletion.referencedBy).toContain(seeded.borrowerNoteId)
    expect(fs.existsSync(path.join(ownerDir, seeded.storedFilename))).toBe(true)
  })
})

/**
 * Open one note through the restored-session pattern the other attachment specs
 * use: tab state is seeded into localStorage, then the window is reloaded.
 */
async function restoreSingleNoteTab(
  page: import('@playwright/test').Page,
  vaultPath: string,
  noteId: string,
  title: string
): Promise<void> {
  await page.addInitScript(
    ({ noteId, t, storageKey }) => {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          version: 2,
          tabGroups: {
            g1: {
              id: 'g1',
              activeTabId: 'note-tab',
              tabs: [
                {
                  id: 'note-tab',
                  type: 'note',
                  title: t,
                  icon: 'file',
                  path: `/notes/${noteId}`,
                  entityId: noteId,
                  isPinned: false
                }
              ]
            }
          },
          layout: { type: 'leaf', tabGroupId: 'g1' },
          activeGroupId: 'g1',
          settings: { restoreSessionOnStart: true, tabCloseButton: 'hover' },
          savedAt: Date.now()
        })
      )
    },
    { noteId, t: title, storageKey: `memry_tab_state:${vaultPath}` }
  )
  await page.reload()
  await ready(page)
  await page.locator(SELECTORS.noteEditor).first().waitFor({ state: 'visible', timeout: 20_000 })
}

// One PDF, two notes, one file (#2077), ported from Electron's `shared-attachment-reference.e2e.ts`
// (#3531 14f-3d), on a real vault on disk:
// - `/pdf` in the second note opens the picker over what the vault stores
//   (`notes_list_vault_attachments`), and picking the PDF inserts a ref into the FIRST note's
//   folder (`notes_insert_existing_attachment`); no second copy lands anywhere;
// - the ref still resolves after a reload;
// - deleting the file from the owning note keeps it while the second note names it.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { minimalPdfBytes, uploadAttachment } from '../../harness/attachments'
import { typeInEditor } from '../../harness/editor'
import { createNote, NOTE_EDITOR, openFromSidebar, vaultOpen } from '../../harness/notes'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

const ORIGINAL_NAME = 'shared-report.pdf'

const stamp = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

test('one PDF inserted into a second note stores one file and survives a reload', async ({
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  const owner = await createNote(page, { title: `Shared Owner ${stamp()}`, content: 'owns it' })
  await uploadAttachment(page, owner.id, ORIGINAL_NAME, minimalPdfBytes())
  const listed = await invoke<Array<{ filename: string }>>(page, 'notes_list_attachments', {
    noteId: owner.id
  })
  expect(listed.length).toBe(1)
  const stored = listed[0].filename
  const borrower = await createNote(page, { title: `Shared Borrower ${stamp()}`, content: '' })

  await openFromSidebar(page, borrower)
  await page.locator(NOTE_EDITOR).first().click()
  await typeInEditor(page, '/pdf')
  await page.getByText('PDF', { exact: true }).first().click()
  const dialog = page.getByTestId('attachment-picker-dialog')
  await expect(dialog).toBeVisible()
  const row = dialog.getByTestId('attachment-picker-row').filter({ hasText: ORIGINAL_NAME })
  await expect(row).toHaveCount(1)
  await row.click()
  await expect(dialog).toBeHidden()

  // A PDF renders as the inline preview, from the owner's folder.
  await page.getByTestId('pdf-embed-scroll').first().waitFor({ state: 'visible', timeout: 20_000 })
  const ownerDir = join(testVaultPath, 'attachments', owner.id)
  expect(readdirSync(ownerDir)).toEqual([stored])
  expect(existsSync(join(testVaultPath, 'attachments', borrower.id))).toBe(false)

  // The ref the note carries on disk names the owner's folder.
  const borrowerFile = join(testVaultPath, borrower.path)
  await expect
    .poll(() => /"url":"([^"]+)"/.exec(readFileSync(borrowerFile, 'utf8'))?.[1] ?? '', {
      timeout: 15_000
    })
    .toContain(`attachments/${owner.id}/${stored}`)
  const url = /"url":"([^"]+)"/.exec(readFileSync(borrowerFile, 'utf8'))![1]

  await page.reload()
  await vaultOpen(page)
  await openFromSidebar(page, borrower)
  await page.getByTestId('pdf-embed-scroll').first().waitFor({ state: 'visible', timeout: 20_000 })
  await expect(page.getByTestId('attachment-missing-card')).toHaveCount(0)
  const resolved = await invoke<{ exists: boolean; storedFilename: string }>(
    page,
    'notes_attachment_resolve',
    { noteId: borrower.id, url }
  )
  expect(resolved.exists).toBe(true)
  expect(resolved.storedFilename).toBe(stored)

  const deletion = await invoke<{ deleted: boolean; referencedBy: string[] }>(
    page,
    'notes_delete_attachment',
    { noteId: owner.id, filename: stored }
  )
  expect(deletion.deleted).toBe(false)
  expect(deletion.referencedBy).toContain(borrower.id)
  expect(existsSync(join(ownerDir, stored))).toBe(true)
})

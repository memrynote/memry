// Attachment self-heal and the note's attachments dialog (#1713), ported from Electron's
// `attachment-self-heal.e2e.ts` (#3531 14f-3c), on a real vault on disk:
// - a file renamed outside the app with its prefix kept still shows, and the note's markdown
//   never changes;
// - an ambiguous rename stays broken, and the block names the file it expected;
// - the note menu's "Attachments…" lists the folder (`notes_list_attachments`) with the original
//   and stored names, and its OS actions reveal and open the file.
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ORIGINAL_NAME, REVEAL_LABEL, seedNoteWithFileBlock } from '../../harness/attachments'
import {
  chooseFromNoteMenu,
  NOTE_EDITOR,
  type NoteView,
  openFromSidebar,
  vaultOpen
} from '../../harness/notes'
import { osOpens, realFile } from '../../harness/os-opens'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

const stamp = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

interface Located {
  absolutePath: string
  storedFilename: string
  exists: boolean
}

/** Reloads the page and opens the note again, so its blocks mount on the files as they are now. */
async function reloadNote(page: Page, note: NoteView): Promise<void> {
  await page.reload()
  await vaultOpen(page)
  await openFromSidebar(page, note)
  await page.locator(NOTE_EDITOR).first().waitFor({ state: 'visible', timeout: 30_000 })
}

test('a rename outside the app that keeps the prefix does not break the block', async ({
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  const seeded = await seedNoteWithFileBlock(page, `Heal Rename ${stamp()}`)
  const folder = join(testVaultPath, 'attachments', seeded.hostId)
  const notePath = join(testVaultPath, seeded.note.path)
  const before = readFileSync(notePath, 'utf8')
  const renamed = seeded.storedFilename.replace(/\.txt$/, '-renamed.txt')
  renameSync(join(folder, seeded.storedFilename), join(folder, renamed))

  await reloadNote(page, seeded.note)
  await page.locator('.file-attachment').first().waitFor({ state: 'visible', timeout: 20_000 })
  await expect(page.getByTestId('attachment-missing-card')).toHaveCount(0)
  const located = await invoke<Located>(page, 'notes_attachment_resolve', {
    noteId: seeded.note.id,
    url: seeded.url
  })
  expect(located.exists).toBe(true)
  expect(located.storedFilename).toBe(renamed)
  expect(readFileSync(notePath, 'utf8')).toBe(before)
})

test('an ambiguous rename stays broken and names the expected file', async ({
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  const seeded = await seedNoteWithFileBlock(page, `Heal Ambiguous ${stamp()}`)
  const folder = join(testVaultPath, 'attachments', seeded.hostId)
  const prefix = seeded.storedFilename.slice(0, 7)
  renameSync(join(folder, seeded.storedFilename), join(folder, `${prefix}candidate-a.txt`))
  writeFileSync(join(folder, `${prefix}candidate-b.txt`), 'decoy')

  await reloadNote(page, seeded.note)
  const card = page.getByTestId('attachment-missing-card')
  await expect(card).toBeVisible({ timeout: 20_000 })
  await expect(card).toContainText(seeded.storedFilename)
})

test('the attachments dialog lists both names and reveals and opens the file', async ({
  app,
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  const seeded = await seedNoteWithFileBlock(page, `Attach Panel ${stamp()}`)
  // The dialog lists the open note's own folder.
  const own = join(testVaultPath, 'attachments', seeded.note.id)
  mkdirSync(own, { recursive: true })
  const disk = join(own, seeded.storedFilename)
  copyFileSync(join(testVaultPath, 'attachments', seeded.hostId, seeded.storedFilename), disk)
  writeFileSync(join(own, '.DS_Store'), 'x')
  const file = realFile(disk)

  await chooseFromNoteMenu(page, 'Attachments…')
  const dialog = page.getByTestId('note-attachments-dialog')
  await expect(dialog).toBeVisible()
  const row = dialog.getByTestId('note-attachment-row')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(ORIGINAL_NAME)
  await expect(row).toContainText(seeded.storedFilename)

  await row.getByRole('button', { name: REVEAL_LABEL }).click()
  await expect.poll(() => osOpens(app)).toEqual([`reveal ${file}`])
  await row.getByRole('button', { name: 'Open in default app' }).click()
  await expect.poll(() => osOpens(app)).toEqual([`reveal ${file}`, `path ${file}`])
})

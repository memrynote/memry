// An attachment over the 16 MiB single-body limit goes in 8 MiB parts (#3531 14f-2). The file
// is picked in the cover picker, whose upload tile stores it through `notesService.uploadAttachment`
// as every attachment upload does. The claim is about bytes on disk: the note's attachments
// folder holds the whole file, byte for byte, and `.memry/uploads`, where the parts wait, is
// empty afterwards. A file over the 100 MiB cap is refused on its size with Electron's message,
// and nothing is written.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { openDetailsMenu, openFromSidebar, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

const MIB = 1024 * 1024
// Twelve parts, the last one partial.
const CHUNKED_BYTES = 90 * MIB + 777
const REFUSED_BYTES = 120 * MIB

interface NoteView {
  id: string
  path: string
  title: string
}

/** Byte `i` is `i % 251`, so a part written twice, dropped or out of place shows. */
function pattern(size: number): Buffer {
  const bytes = Buffer.alloc(size)
  for (let i = 0; i < size; i++) bytes[i] = i % 251
  return bytes
}

function filesIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : []
}

/** Opens a new note's cover picker and picks a file of `size` pattern bytes built in the page. */
async function pickCover(page: Page, size: number): Promise<NoteView> {
  const note = await invoke<NoteView>(page, 'notes_create', {
    input: { title: `Chunked Upload ${Date.now()}`, content: 'Body' }
  })
  await openFromSidebar(page, note)
  await openDetailsMenu(page)
  await page.getByTestId('ghost-add-cover').click()
  await expect(page.getByTestId('cover-picker-dialog')).toBeVisible()
  await page
    .getByTestId('cover-picker-file-input')
    .evaluate((input: HTMLInputElement, length: number) => {
      const bytes = new Uint8Array(length)
      for (let i = 0; i < length; i++) bytes[i] = i % 251
      const files = new DataTransfer()
      files.items.add(new File([bytes], 'large-cover.png', { type: 'image/png' }))
      input.files = files.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }, size)
  return note
}

test('a file over the single-body limit lands whole, and no part is left', async ({
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  const note = await pickCover(page, CHUNKED_BYTES)
  await expect(page.getByTestId('cover-picker-dialog')).toBeHidden({ timeout: 60_000 })

  const noteFile = join(testVaultPath, note.path)
  await expect.poll(() => readFileSync(noteFile, 'utf8'), { timeout: 20_000 }).toMatch(/^cover: /m)
  const coverRef = (readFileSync(noteFile, 'utf8').match(/^cover: (.*?)\r?$/m) ?? [])[1] ?? ''
  expect(coverRef).toContain(`attachments/${note.id}/`)
  const onDisk = readFileSync(join(dirname(noteFile), coverRef))
  expect(onDisk.length).toBe(CHUNKED_BYTES)
  expect(onDisk.equals(pattern(CHUNKED_BYTES))).toBe(true)
  expect(filesIn(join(testVaultPath, 'attachments', note.id))).toHaveLength(1)
  expect(filesIn(join(testVaultPath, '.memry', 'uploads'))).toEqual([])
})

test('a file over the 100 MiB cap is refused with the size message, and nothing is written', async ({
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  const note = await pickCover(page, REFUSED_BYTES)
  await expect(page.locator('[data-sonner-toast][data-type="error"]').first()).toContainText(
    'File too large: 120.0 MB exceeds 100.0 MB limit'
  )
  expect(filesIn(join(testVaultPath, 'attachments', note.id))).toEqual([])
  expect(filesIn(join(testVaultPath, '.memry', 'uploads'))).toEqual([])
  expect(readFileSync(join(testVaultPath, note.path), 'utf8')).not.toMatch(/^cover: /m)
})

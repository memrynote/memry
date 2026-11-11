// The attachment block menu (#1709), ported from Electron's `attachment-block-menu.e2e.ts`
// (#3531 14f-3c): the "⋯" dropdown and the right-click menu of a file block, the original and
// stored names in their header, Copy path, and the rename. Electron only checked that the OS
// items were there; the e2e build records what the app hands the OS (`e2e_os_opens`), so here
// they are clicked and the file revealed or opened is read back. The menu reaches Rust through
// `notes_attachment_resolve`, `notes_attachment_reveal_in_finder` and
// `notes_attachment_open_external`.
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { ORIGINAL_NAME, REVEAL_LABEL, seedNoteWithFileBlock } from '../../harness/attachments'
import { setBlocks } from '../../harness/editor'
import { vaultOpen } from '../../harness/notes'
import { osOpens, realFile } from '../../harness/os-opens'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'

const stamp = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

/**
 * Opens the block's "⋯" menu from the keyboard: the button shows on hover, and a WebDriver
 * pointer move in WKWebView sets no `:hover`.
 */
async function openDropdown(page: Page) {
  const button = page.locator('.file-attachment').first().getByTestId('attachment-menu-button')
  await button.focus()
  await page.keyboard.press('Enter')
  const menu = page.getByTestId('attachment-dropdown-menu')
  await expect(menu).toBeVisible()
  return menu
}

/** The copy is read where the page hands it to the clipboard API (see note-menu-actions). */
async function captureCopies(page: Page): Promise<void> {
  await page.evaluate(() => {
    const copies: string[] = []
    ;(window as unknown as { __copies: string[] }).__copies = copies
    navigator.clipboard.writeText = async (text: string) => {
      copies.push(text)
    }
  })
}

test('the dropdown shows both names, reveals and opens the file, and copies its path', async ({
  app,
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  const seeded = await seedNoteWithFileBlock(page, `Attachment Menu ${stamp()}`)
  const disk = join(testVaultPath, 'attachments', seeded.hostId, seeded.storedFilename)
  const file = realFile(disk)

  let menu = await openDropdown(page)
  await expect(menu.getByText(ORIGINAL_NAME, { exact: true })).toBeVisible()
  await expect(menu.getByText(`Stored as ${seeded.storedFilename}`)).toBeVisible()
  await menu.getByRole('menuitem', { name: REVEAL_LABEL }).click()
  await expect.poll(() => osOpens(app)).toEqual([`reveal ${file}`])

  menu = await openDropdown(page)
  await menu.getByRole('menuitem', { name: 'Open in default app' }).click()
  await expect.poll(() => osOpens(app)).toEqual([`reveal ${file}`, `path ${file}`])

  await captureCopies(page)
  menu = await openDropdown(page)
  await menu.getByRole('menuitem', { name: 'Copy path' }).click()
  await expect(page.getByText('Path copied').first()).toBeVisible()
  const copies = await page.evaluate(() => (window as unknown as { __copies: string[] }).__copies)
  expect(copies.map(realFile)).toEqual([file])
})

test('right-click on the block opens the same menu', async ({ page }) => {
  await vaultOpen(page)
  const seeded = await seedNoteWithFileBlock(page, `Attachment Context ${stamp()}`)

  await page.locator('.file-attachment').first().click({ button: 'right' })
  const menu = page.getByTestId('attachment-context-menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByText(`Stored as ${seeded.storedFilename}`)).toBeVisible()
  for (const label of [REVEAL_LABEL, 'Open in default app', 'Copy path']) {
    await expect(menu.getByRole('menuitem', { name: label })).toBeVisible()
  }
  await page.keyboard.press('Escape')
})

test('a file not on this device is not revealed or opened', async ({
  app,
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  const seeded = await seedNoteWithFileBlock(page, `Attachment Gone ${stamp()}`)
  // Gone with nothing self-heal could serve in its place.
  const folder = join(testVaultPath, 'attachments', seeded.hostId)
  rmSync(join(folder, seeded.storedFilename))

  for (const command of ['notes_attachment_reveal_in_finder', 'notes_attachment_open_external']) {
    const refused = await page.evaluate(
      ([name, noteId, url]: [string, string, string]) =>
        window.__TAURI__.core.invoke(name, { noteId, url }).then(
          () => 'resolved',
          (error: unknown) => JSON.stringify(error)
        ),
      [command, seeded.note.id, seeded.url] as [string, string, string]
    )
    expect(refused).toContain('"code":"attachment_not_found"')
  }
  expect(await osOpens(app)).toEqual([])
})

test('rename renames the file on disk and rewrites the block ref in the note', async ({
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  // The rename takes only the open note's own files, so the note uploads to itself.
  const seeded = await seedNoteWithFileBlock(page, `Attachment Rename ${stamp()}`)
  const own = join(testVaultPath, 'attachments', seeded.note.id)
  cpSync(join(testVaultPath, 'attachments', seeded.hostId), own, { recursive: true })
  const url = `../attachments/${seeded.note.id}/${seeded.storedFilename}`
  await setBlocks(page, [
    { type: 'file', props: { url, name: ORIGINAL_NAME, size: 14, mimeType: 'text/plain' } }
  ])

  const menu = await openDropdown(page)
  await menu.getByRole('menuitem', { name: 'Rename…' }).click()
  const dialog = page.getByTestId('attachment-rename-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Attachment name').fill('quarterly-report')
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click()

  const renamed = `${seeded.storedFilename.slice(0, 7)}quarterly-report.txt`
  await expect.poll(() => existsSync(join(own, renamed)), { timeout: 10_000 }).toBe(true)
  expect(existsSync(join(own, seeded.storedFilename))).toBe(false)
  await expect(
    page.locator('.file-attachment').first().getByText('quarterly-report.txt')
  ).toBeVisible()
  await expect
    .poll(() => readFileSync(join(testVaultPath, seeded.note.path), 'utf8'), { timeout: 15_000 })
    .toContain(renamed)
})

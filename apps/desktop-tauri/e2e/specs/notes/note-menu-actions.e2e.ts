// The file actions of the note page's "More actions" menu (Step 13f, #3530), ported from
// Electron's `note-menu-actions.e2e.ts`. Electron only checked that the OS items were there;
// the e2e build records what the app hands the OS (`e2e_os_opens`), so here they are clicked
// and the file shown or opened is read back, as are the move and the delete.
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

import { invokeTest } from '../../harness/invoke-test'
import {
  NOTE_TITLE,
  type NoteView,
  chooseFromNoteMenu,
  createNote,
  getNote,
  listedIds,
  openFromSidebar,
  vaultOpen
} from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'

type App = Parameters<typeof invokeTest>[0]

// The reveal item is named for the host's file manager.
const REVEAL_LABEL =
  process.platform === 'darwin'
    ? 'Reveal in Finder'
    : process.platform === 'win32'
      ? 'Show in Explorer'
      : 'Show in file manager'

const FILE_ACTIONS = [
  'Find…',
  'Rename…',
  'Move to folder…',
  'Copy path',
  REVEAL_LABEL,
  'Reveal in navigation',
  'Open in default app',
  'Delete note'
]

const stamp = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

async function seedAndOpen(page: Page, title: string): Promise<NoteView> {
  await vaultOpen(page)
  const note = await createNote(page, { title, content: 'Body for menu actions', folder: 'notes' })
  await openFromSidebar(page, note)
  return note
}

/**
 * What the app handed the OS, as `reveal <file>` or `path <file>`, each file named by its real
 * path. The app hands over a canonical path, which is `\\?\`-prefixed on Windows and under
 * `/private` on macOS.
 */
async function osOpens(app: App): Promise<string[]> {
  const opens = await invokeTest<string[]>(app, 'e2e_os_opens')
  return opens.map((entry) => {
    const [kind, ...rest] = entry.split(' ')
    return `${kind} ${realFile(rest.join(' ').replace(/^\\\\\?\\/, ''))}`
  })
}

const realFile = (path: string): string =>
  existsSync(path) ? realpathSync.native(path) : `missing ${path}`

test('the menu offers every file action', async ({ page }) => {
  await seedAndOpen(page, `Menu Items ${stamp()}`)
  await page.getByRole('button', { name: 'More actions' }).click()
  for (const label of FILE_ACTIONS) {
    const item = page.getByRole('option', { name: label, exact: true })
    await expect(item).toBeVisible()
    await expect(item).toBeEnabled()
  }
})

test('Find opens the find bar, and Rename puts the caret in the title', async ({ page }) => {
  await seedAndOpen(page, `Find And Rename ${stamp()}`)
  await chooseFromNoteMenu(page, 'Find…')
  await expect(page.getByRole('textbox', { name: 'Find, replace, ask...' })).toBeVisible()
  await page.keyboard.press('Escape')

  await chooseFromNoteMenu(page, 'Rename…')
  await expect(page.locator(NOTE_TITLE).first()).toBeFocused()
})

// The copy is read where the page hands it to the clipboard API, which answers here instead of the
// OS. WebView2 refuses a clipboard write from a window without focus, which a CI worker's window
// often is, and the OS clipboard is shared with every other worker's app.
test('Copy path hands the vault-relative path to the clipboard', async ({ page }) => {
  const note = await seedAndOpen(page, `Copy Path ${stamp()}`)
  await page.evaluate(() => {
    const copies: string[] = []
    ;(window as unknown as { __copies: string[] }).__copies = copies
    navigator.clipboard.writeText = async (text: string) => {
      copies.push(text)
    }
  })
  await chooseFromNoteMenu(page, 'Copy path')
  await expect(page.getByText('Path copied').first()).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __copies: string[] }).__copies)).toEqual(
    [note.path]
  )
})

test('the reveal item shows the file, and Open in default app opens it', async ({
  app,
  page,
  testVaultPath
}) => {
  const note = await seedAndOpen(page, `OS Items ${stamp()}`)
  const file = realFile(join(testVaultPath, note.path))

  await chooseFromNoteMenu(page, REVEAL_LABEL)
  await expect.poll(() => osOpens(app)).toEqual([`reveal ${file}`])

  await chooseFromNoteMenu(page, 'Open in default app')
  await expect.poll(() => osOpens(app)).toEqual([`reveal ${file}`, `path ${file}`])
})

test('Move to folder moves the note and its file', async ({ page, testVaultPath }) => {
  // A note made in the folder makes the folder, and the folder list hears of it.
  await vaultOpen(page)
  await createNote(page, { title: 'Already archived', folder: 'Archive' })
  const note = await seedAndOpen(page, `Move From Menu ${stamp()}`)

  await chooseFromNoteMenu(page, 'Move to folder…')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Archive', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  const moved = `Archive/${note.path.split('/').pop()}`
  await expect.poll(async () => (await getNote(page, note.id))?.path).toBe(moved)
  expect(existsSync(join(testVaultPath, moved))).toBe(true)
  expect(existsSync(join(testVaultPath, note.path))).toBe(false)
})

test('Delete removes the note and its file after the confirm, and closes its tab', async ({
  page,
  testVaultPath
}) => {
  const title = `Delete From Menu ${stamp()}`
  const note = await seedAndOpen(page, title)

  await chooseFromNoteMenu(page, 'Delete note')
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()

  await expect.poll(async () => (await listedIds(page)).includes(note.id)).toBe(false)
  expect(await getNote(page, note.id)).toBeNull()
  expect(existsSync(join(testVaultPath, note.path))).toBe(false)
  await expect(page.locator(`${NOTE_TITLE}[value="${title}"]`)).toHaveCount(0)
  await expect(page.getByRole('tab', { name: title })).toHaveCount(0)
})

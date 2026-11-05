// Notes made, edited and saved in the running app (Step 13f, #3530), ported from Electron's
// `notes.e2e.ts`. Electron's cases that asserted nothing (`expect(true)`: wiki links, backlinks,
// search, delete and undo) are not ported: the delete is `note-menu-actions.e2e.ts`, and the
// links have their own specs. Its reorder cases called `notes.reorder` and read the positions
// back through the API, which the Rust tests of `notes_reorder` own. What is left, made to
// assert: a new note named and written from the UI reaches its file, an outside edit reaches the
// open note, and the properties section keeps its collapse across a reload.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SHORTCUTS } from '../../harness/app-helpers'
import {
  NOTE_EDITOR,
  NOTE_TITLE,
  type NoteView,
  createNote,
  getNote,
  newNote,
  openFromSidebar,
  vaultOpen
} from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'
import { pollUntil } from '../../harness/wait'

const stamp = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

function localIsoDate(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

const propertiesHeader = (page: Page) => page.getByRole('button', { name: /^Properties/ }).first()

async function reloadApp(page: Page): Promise<void> {
  await page.reload()
  await vaultOpen(page)
}

test('Cmd-N makes a note whose typed title names its file and whose typed body is saved', async ({
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  await page.keyboard.press(SHORTCUTS.newNote)
  const title = page.locator(NOTE_TITLE).first()
  await expect(title).toBeFocused()
  // Cmd-N names the file `New note`; the field shows it empty.
  const { id } = await newNote(page, [], (note) => note.title === 'New note')

  const name = `Groceries ${stamp()}`
  await title.fill(name)
  await title.press('Enter')
  await expect.poll(async () => (await getNote(page, id))?.title).toBe(name)

  // WebDriver's key actions put no text into the editor's contenteditable; the browser's own
  // editing command does, as `beforeinput`.
  await page.locator(NOTE_EDITOR).first().click()
  await page.keyboard.insertText('Milk and bread')
  const saved = await getNote(page, id)
  const file = join(testVaultPath, (saved as NoteView).path)
  expect((saved as NoteView).path.endsWith(`${name}.md`)).toBe(true)
  expect(
    await pollUntil(() => existsSync(file) && readFileSync(file, 'utf8').includes('Milk and bread'))
  ).toBe(true)
  await expect.poll(async () => (await getNote(page, id))?.content.trim()).toBe('Milk and bread')
})

test('an edit made outside the app reaches the open note', async ({ page, testVaultPath }) => {
  await vaultOpen(page)
  const note = await createNote(page, {
    title: `Outside Edit ${stamp()}`,
    content: 'Written in the app',
    folder: 'notes'
  })
  await openFromSidebar(page, note)
  const editor = page.locator(NOTE_EDITOR).first()
  await expect(editor).toContainText('Written in the app')

  writeFileSync(join(testVaultPath, note.path), 'Rewritten by another program\n')
  await expect(editor).toContainText('Rewritten by another program')
  await expect(editor).not.toContainText('Written in the app')
  await expect
    .poll(async () => (await getNote(page, note.id))?.content.trim())
    .toBe('Rewritten by another program')
})

test('the properties section stays collapsed across a reload', async ({ page }) => {
  await vaultOpen(page)
  const note = await createNote(page, {
    title: `Props Persist ${stamp()}`,
    folder: 'notes',
    properties: { Status: 'Draft' }
  })
  await openFromSidebar(page, note)

  const header = propertiesHeader(page)
  await expect(header).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('#properties-content')).toBeVisible()
  await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('#properties-content')).toHaveCount(0)

  await reloadApp(page)
  await openFromSidebar(page, note)
  await expect(propertiesHeader(page)).toHaveAttribute('aria-expanded', 'false')
})

test('adding a property while the section is collapsed opens it', async ({ page }) => {
  await vaultOpen(page)
  const note = await createNote(page, {
    title: `Props Expand ${stamp()}`,
    folder: 'notes',
    properties: { Status: 'Draft' }
  })
  await openFromSidebar(page, note)

  const header = propertiesHeader(page)
  await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'false')

  // The header's "add details" row takes pointer events only while the header is hovered, which
  // a WebDriver pointer move does not do in WKWebView, so its menu opens from the keyboard.
  const details = page.getByTestId('ghost-add-details')
  await details.waitFor({ state: 'attached' })
  await details.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('menuitem', { name: 'Add property' }).click()
  await page.getByRole('option', { name: 'Text' }).first().click()

  await expect(header).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('#properties-content')).toBeVisible()
  await expect(page.locator('ul[aria-label="Properties list"] > *')).toHaveCount(2)
})

test("a journal day's properties section stays collapsed across a reload", async ({ page }) => {
  await vaultOpen(page)
  await invoke(page, 'journal_create_entry', {
    input: { date: localIsoDate(), content: 'Journal body', properties: { Mood: 'Focused' } }
  })
  const openJournal = async (): Promise<void> => {
    await page.getByTestId('rail-journal').click()
    await expect(propertiesHeader(page)).toBeVisible()
  }
  await openJournal()

  const header = propertiesHeader(page)
  await expect(header).toHaveAttribute('aria-expanded', 'true')
  await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('#properties-content')).toHaveCount(0)

  await reloadApp(page)
  await openJournal()
  await expect(propertiesHeader(page)).toHaveAttribute('aria-expanded', 'false')
})

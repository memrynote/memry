// An outside edit that empties the open note's body (#3530): the editor shows the empty body
// instead of the text it held. On Tauri no CRDT doc carries the edit to the editor, so the editor
// reloads from the note's body, as it does for any other outside edit. A tag template's Undo
// reaches the editor the same way.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SELECTORS } from '../../harness/app-helpers'
import { createNote, getNote, openFromSidebar, vaultOpen } from '../../harness/notes'
import { test, expect } from '../../harness/test'

test('an outside edit that empties the body empties the open editor', async ({
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  const note = await createNote(page, {
    title: `Emptied Outside ${Date.now().toString(36)}`,
    content: 'Written before the outside edit',
    folder: 'notes'
  })
  await openFromSidebar(page, note)
  const editor = page.locator(SELECTORS.noteEditor).first()
  await expect(editor).toContainText('Written before the outside edit')

  // The file keeps its frontmatter and loses its body.
  const file = join(testVaultPath, note.path)
  const text = readFileSync(file, 'utf8')
  writeFileSync(file, text.match(/^---\n[\s\S]*?\n---\n/)?.[0] ?? '')

  await expect.poll(async () => (await getNote(page, note.id))?.content).toBe('')
  await expect(editor).not.toContainText('Written before the outside edit')
})

// Unsaved typing wins over an outside edit, and its save replaces the outside text on disk. The
// core keeps that text as a version, and a toast says so once, with a way into version history.
// The save lands up to 1 s after the typing, before or after the watcher reports the outside
// edit: the editor holds the event's text, or the save's answer says it went over one.
test('typing saved over an outside edit says so and opens version history', async ({
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  const note = await createNote(page, {
    title: `Replaced Outside ${Date.now().toString(36)}`,
    content: 'Written before the outside edit',
    folder: 'notes'
  })
  await openFromSidebar(page, note)
  const editor = page.locator(SELECTORS.noteEditor).first()
  await expect(editor).toContainText('Written before the outside edit')

  await editor.click()
  await page.keyboard.insertText(' typed')
  const file = join(testVaultPath, note.path)
  const frontmatter = readFileSync(file, 'utf8').match(/^---\n[\s\S]*?\n---\n/)?.[0] ?? ''
  writeFileSync(file, `${frontmatter}Written by an agent\n`)

  const toast = page.locator(
    '[data-sonner-toast]:has-text("An outside change was replaced by your typing")'
  )
  await expect(toast).toBeVisible()
  expect(readFileSync(file, 'utf8')).toContain(' typed')
  await toast.getByRole('button', { name: 'Show versions' }).click()
  await expect(page.getByRole('dialog', { name: 'Version History' })).toBeVisible()
  // The panel lists the kept version once Step 14 (#3531) ports `notes_get_versions`; the core
  // keeping it is `notes_update::a_save_says_when_it_replaced_an_outside_edit_not_fed_yet`.
})

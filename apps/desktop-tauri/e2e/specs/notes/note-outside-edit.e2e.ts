// An outside edit that empties the open note's body (#3530): the editor shows the empty body
// instead of the text it held. The core feeds the edit into the note's document, and the editor,
// bound to that document (#3531 14b-2), takes it as an update. A tag template's Undo reaches the
// editor the same way.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SELECTORS } from '../../harness/app-helpers'
import { invokeTest } from '../../harness/invoke-test'
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

// Typing the file does not have yet wins over an outside edit (#4030), the editor bound to the
// core's document included (#3531 14b-2): the core keeps the outside file as a version, the
// write-back writes the typing over it, and a toast says so once, with a way into version history.
test('typing not yet written wins over an outside edit, says so and opens version history', async ({
  app,
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
  await page.keyboard.press('End')
  await page.keyboard.insertText(' typed')
  const file = join(testVaultPath, note.path)
  const frontmatter = readFileSync(file, 'utf8').match(/^---\n[\s\S]*?\n---\n/)?.[0] ?? ''
  const outside = `${frontmatter}Written by an agent\n`
  writeFileSync(file, outside)

  const toast = page.locator(
    '[data-sonner-toast]:has-text("An outside change was replaced by your typing")'
  )
  await expect(toast).toBeVisible()
  await expect(editor).toContainText(' typed')
  await expect(editor).not.toContainText('Written by an agent')
  await expect.poll(() => readFileSync(file, 'utf8')).toContain(' typed')
  const versions = await invokeTest<{ content: string }[]>(app, 'e2e_debug_query', {
    sql: `SELECT content FROM note_snapshots WHERE note_id = '${note.id}'`
  })
  expect(versions.map((version) => version.content)).toContain(outside)
  await toast.getByRole('button', { name: 'Show versions' }).click()
  await expect(page.getByRole('dialog', { name: 'Version History' })).toBeVisible()
})

// Typing made while an outside edit holds the editor's typing (#4222): the editor refuses it then,
// and replays it once the edit's frame applied, over the edit. Typing that reached the document
// before the edit would win over it instead, and a dropped keystroke would leave the edit alone.
test('typing made while an outside edit holds the editor goes in over the edit', async ({
  app,
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  const note = await createNote(page, {
    title: `Held Outside ${Date.now().toString(36)}`,
    content: 'Written before the hold',
    folder: 'notes'
  })
  await openFromSidebar(page, note)
  const editor = page.locator(SELECTORS.noteEditor).first()
  await expect(editor).toContainText('Written before the hold')
  await editor.click()
  await page.keyboard.press('End')

  // Nothing of the editor's own is left to write, so the outside edit wins over the document.
  await expect
    .poll(async () => {
      const debug = await invokeTest<{ pending: boolean } | null>(
        app,
        'e2e_writeback_debug_state',
        { noteId: note.id }
      )
      return debug?.pending ?? false
    })
    .toBe(false)
  // The hold an outside edit asks for before it applies, kept on past the edit.
  expect(
    await invokeTest<boolean>(app, 'e2e_editor_hold_typing', { noteId: note.id, ms: 3000 })
  ).toBe(true)
  await page.keyboard.insertText(' typed')
  const file = join(testVaultPath, note.path)
  const frontmatter = readFileSync(file, 'utf8').match(/^---\n[\s\S]*?\n---\n/)?.[0] ?? ''
  writeFileSync(file, `${frontmatter}Written before the hold\n\nAdded by an agent\n`)

  await expect(editor).toContainText('Added by an agent')
  await expect(editor).toContainText('Written before the hold typed')
  await expect
    .poll(() => readFileSync(file, 'utf8'))
    .toContain('Written before the hold typed\n\nAdded by an agent')
  await expect(
    page.locator('[data-sonner-toast]:has-text("An outside change was replaced by your typing")')
  ).toHaveCount(0)
})

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

// An outside edit made while the typing before it waits for its write-back (#3531 14b-2): the
// file wins, as in Electron (`feedExternalEditToCrdt` replaces the body). The editor and the file
// show the outside text, and the core keeps the body it replaced, typing included, as a version.
// The typing is durable in the document before the outside write, and the write-back waits for
// the note to be quiet, then keeps a file it has not read.
test('an outside edit replaces typing not yet written, which is kept as a version', async ({
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
  writeFileSync(file, `${frontmatter}Written by an agent\n`)

  await expect(editor).toContainText('Written by an agent')
  await expect(editor).not.toContainText(' typed')
  const versions = () =>
    invokeTest<{ content: string }[]>(app, 'e2e_debug_query', {
      sql: `SELECT content FROM note_snapshots WHERE note_id = '${note.id}'`
    })
  await expect
    .poll(async () => (await versions()).some((version) => version.content.includes(' typed')))
    .toBe(true)
  expect(readFileSync(file, 'utf8')).not.toContain(' typed')
})

// "New note from this note" (#2329, Step 13f, #3530), ported from Electron's
// `new-note-from-note.e2e.ts`: the note menu and the sidebar row's menu both make an empty note
// in the source's folder that starts with the source's icon, header tags and properties, and a
// later edit of the source does not reach a copy already made.
import {
  NOTE_TITLE,
  chooseFromNoteMenu,
  createNote,
  getNoteByPath,
  openFromSidebar,
  treeRow,
  vaultOpen
} from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

const FOLDER = 'Clients/A'
const SOURCE_TITLE = 'Project X'
const SOURCE_TAGS = ['client-a', '2026']
const SOURCE_PROPERTIES = { Status: 'Active', Priority: 'High', Owner: 'Kaan' }
const SOURCE_ICON = '📁'

async function copyAt(page: Page, path: string) {
  const note = await getNoteByPath(page, path)
  return note
    ? {
        emoji: note.emoji,
        tags: note.headerTags,
        properties: note.properties,
        content: note.content.trim()
      }
    : null
}

test('copies the icon, tags and properties into an empty note in the same folder', async ({
  page
}) => {
  await vaultOpen(page)
  const source = await createNote(page, {
    title: SOURCE_TITLE,
    content: 'Kickoff body',
    folder: FOLDER,
    tags: SOURCE_TAGS,
    properties: SOURCE_PROPERTIES,
    emoji: SOURCE_ICON
  })
  await openFromSidebar(page, source)

  await chooseFromNoteMenu(page, 'New note from this note')
  await expect(
    page.getByText('Created with 2 tags and 3 properties from Project X').first()
  ).toBeVisible()
  // The new note opens with its title field empty and focused (#3323); the placeholder names the
  // file, which the vault titled `New note`.
  const titleField = page.locator(NOTE_TITLE).first()
  await expect(titleField).toBeFocused()
  await expect(titleField).toHaveValue('')
  await expect(titleField).toHaveAttribute('placeholder', 'New note')

  const expected = {
    emoji: SOURCE_ICON,
    tags: SOURCE_TAGS,
    properties: SOURCE_PROPERTIES,
    content: ''
  }
  await expect.poll(() => copyAt(page, `${FOLDER}/New note.md`)).toEqual(expected)

  await titleField.press('Escape')
  await invoke(page, 'notes_update', {
    input: { id: source.id, headerTags: { remove: SOURCE_TAGS, add: ['changed-later'] } }
  })
  // A later edit to the source does not reach the copy.
  expect((await copyAt(page, `${FOLDER}/New note.md`))?.tags).toEqual(SOURCE_TAGS)

  await treeRow(page, source.id).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'New note from this note' }).click()
  // The sidebar's entry point makes a second copy in the same folder.
  await expect
    .poll(() => copyAt(page, `${FOLDER}/New note 1.md`))
    .toEqual({ ...expected, tags: ['changed-later'] })
})

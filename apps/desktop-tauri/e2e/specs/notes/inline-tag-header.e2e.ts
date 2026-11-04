// An inline #tag typed in a note's body (Step 13f, #3530), ported from Electron's
// `inline-tag-header.e2e.ts`: the editor's save (`notes_update`) adds the tag to the note's
// header and its tags row, and deleting the tag text takes it out of both. WebDriver's key
// actions put no text into the editor's contenteditable, so the text goes in and out as the
// browser's own editing commands, which reach ProseMirror as `beforeinput`.
import { SHORTCUTS } from '../../harness/app-helpers'
import { NOTE_EDITOR, NOTE_TITLE, getNote, newNote, vaultOpen } from '../../harness/notes'
import { test, expect } from '../../harness/test'

const TAG = 'e2e-inline-car'

test('joins the tags row and the file header, and leaves with the text', async ({ page }) => {
  await vaultOpen(page)
  await page.keyboard.press(SHORTCUTS.newNote)
  await expect(page.locator(NOTE_TITLE).first()).toBeFocused()
  // Cmd-N names the file `New note`; the field shows it empty.
  const { id } = await newNote(page, [], (note) => note.title === 'New note')

  const editor = page.locator(NOTE_EDITOR).first()
  await editor.click()
  await page.keyboard.insertText(`Drove the #${TAG} today `)
  const headerTags = async (): Promise<string[]> => (await getNote(page, id))?.headerTags ?? []

  // The typed tag reaches the header and the tags row.
  await expect.poll(headerTags).toContain(TAG)
  const tagsRow = page.getByRole('list', { name: 'Tags' })
  await expect(tagsRow.getByRole('option', { name: TAG })).toBeVisible()

  await page.evaluate((selector: string) => {
    const body = document.querySelector(selector) as HTMLElement
    body.focus()
    const selection = getSelection() as Selection
    selection.selectAllChildren(body)
    selection.collapseToEnd()
    for (let i = 0; i < 12; i++) document.execCommand('delete')
  }, NOTE_EDITOR)
  await expect(editor).not.toContainText(TAG)

  // Deleting the tag text takes it out of the header.
  await expect.poll(headerTags).not.toContain(TAG)
  await expect(tagsRow.getByRole('option', { name: TAG })).toHaveCount(0)
})

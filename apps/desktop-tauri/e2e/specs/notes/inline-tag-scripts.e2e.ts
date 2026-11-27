// A `#tag` in any script is a tag (#5716, ported to Tauri in #5826), after Electron's
// `inline-tag-script-sync.e2e.ts` without its second device: typed in the body it becomes a chip
// and joins the note's header, the file keeps the bytes typed, a `#` followed by digits only stays
// text, a tag only a body names is listed, and a rename into a non-Latin name rewrites the body.
// WebDriver's key actions put no text into the editor's contenteditable, so the text goes in as
// the browser's own editing command, which reaches ProseMirror as `beforeinput`.
import { SHORTCUTS } from '../../harness/app-helpers'
import { NOTE_EDITOR, NOTE_TITLE, createNote, getNote, newNote } from '../../harness/notes'
import { expandTagsSection, listedTags, openTagTab, unique, vaultOpen } from '../../harness/tags'
import { test, expect } from '../../harness/test'

const BODY = 'Met #퓨리 #привет #हिन्दी #タグ #2024년 #2024 '
/** In `toSorted()`'s UTF-16 order. */
const TAGS = ['2024년', 'привет', 'हिन्दी', 'タグ', '퓨리']

test('chips a tag typed in any script and keeps the bytes', async ({ page }) => {
  await vaultOpen(page)
  await page.keyboard.press(SHORTCUTS.newNote)
  await expect(page.locator(NOTE_TITLE).first()).toBeFocused()
  const { id } = await newNote(page, [], (note) => note.title === 'New note')

  await page.locator(NOTE_EDITOR).first().click()
  // One insert per word: the editor chips the whole tag right before the cursor, as it does for
  // the text an input method commits.
  for (const part of BODY.split(/( )/).filter(Boolean)) await page.keyboard.insertText(part)

  const headerTags = async (): Promise<string[]> =>
    ((await getNote(page, id))?.headerTags ?? []).toSorted()
  await expect.poll(headerTags).toEqual(TAGS)
  const chips = await page.evaluate(() =>
    [...document.querySelectorAll('.inline-hash-tag')].map((el) => el.getAttribute('data-hash-tag'))
  )
  expect(chips).toEqual(['퓨리', 'привет', 'हिन्दी', 'タグ', '2024년'])
  await expect.poll(async () => (await getNote(page, id))?.content.trimEnd()).toBe(BODY.trimEnd())
})

test('lists a tag only the body names', async ({ page }) => {
  await vaultOpen(page)
  const tag = `퓨리${unique()}`
  await createNote(page, { title: `Body tag ${tag}`, content: `Note body #${tag}` })

  await expect
    .poll(async () => (await listedTags(page)).map((listed) => listed.name), { timeout: 15_000 })
    .toContain(tag)
})

test('renames a tag into a Korean child tag in the body', async ({ page }) => {
  await vaultOpen(page)
  const tag = `태그${unique()}`
  const renamed = `${tag}/하위`
  const { id } = await createNote(page, {
    title: `Tag Test ${tag}`,
    content: `Note body #${tag}`,
    tags: [tag]
  })
  await openTagTab(page, tag)

  await page.locator('button[aria-label="Tag actions"]').click()
  await page.getByRole('menuitem', { name: 'Rename tag' }).click()
  await page.locator('#tag-rename-input').fill(renamed)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('[role="tab"]').filter({ hasText: tag })).toHaveCount(0, {
    timeout: 10_000
  })
  await expandTagsSection(page)

  await expect.poll(async () => (await getNote(page, id))?.content).toBe(`Note body #${renamed}\n`)
  expect((await getNote(page, id))?.headerTags).toEqual([renamed])
})

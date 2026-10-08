import { test, expect } from './fixtures'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'
import { createNote, SELECTORS } from './utils/electron-helpers'

/**
 * Typing a plain `#tag` in a note body adds it to the note's tags row and its
 * frontmatter `tags:` list, and deleting it from the body takes it out again.
 */

const TAG = 'e2e-inline-car'

test.describe('Inline #tag in the note body', () => {
  test('joins the tags row and the file header, and leaves with the text', async ({ page }) => {
    await ready(page)
    const title = uniqueLabel('Inline Tag Header')
    await createNote(page, title, `Drove the #${TAG} today `)

    const noteId = await page.evaluate(async (noteTitle) => {
      const { notes } = await window.api.notes.list({})
      return notes.find((note) => note.title === noteTitle)?.id ?? null
    }, title)
    if (!noteId) throw new Error(`no note titled "${title}"`)
    const headerTags = (): Promise<string[]> =>
      page.evaluate(async (id) => (await window.api.notes.get(id))?.headerTags ?? [], noteId)

    await expect
      .poll(headerTags, { message: 'the typed tag reaches the header', timeout: 10_000 })
      .toContain(TAG)
    await expect(
      page.getByRole('list', { name: 'Tags' }).getByRole('option', { name: TAG }),
      'the tags row shows the typed tag'
    ).toBeVisible()

    // At the start of the line, away from the chip, which opens its tag page when clicked.
    await page
      .locator(SELECTORS.noteEditor)
      .first()
      .click({ position: { x: 2, y: 10 } })
    await page.keyboard.press('End')
    for (let i = 0; i < 12; i++) await page.keyboard.press('Backspace')
    await expect(page.locator(SELECTORS.noteEditor).first()).not.toContainText(TAG)

    await expect
      .poll(headerTags, {
        message: 'deleting the tag text takes it out of the header',
        timeout: 10_000
      })
      .not.toContain(TAG)
    await expect(
      page.getByRole('list', { name: 'Tags' }).getByRole('option', { name: TAG })
    ).toHaveCount(0)
  })
})

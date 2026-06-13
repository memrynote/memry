import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'
import { createNote, SELECTORS } from './utils/electron-helpers'

/**
 * Inline `@`-date ghost autocomplete (date-mention-ghost-plugin.ts):
 *   - typing a date-ish `@query` paints a neutral grey "activated" background
 *     (`.date-mention-typing`) and previews the rest of the best completion as
 *     faded ghost text (`.date-mention-ghost`),
 *   - Tab fills the ghost into real text; a second Tab commits the date pill
 *     (`.date-mention`) once the phrase is complete,
 *   - a non-date mention (e.g. `@meeting`) gets no ghost and no highlight.
 *
 * Date-dependent expectations (next/last weekday) are computed from the live
 * clock so the suite is stable on any day.
 */

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const TYPING = '.date-mention-typing'
const GHOST = '.date-mention-ghost'
const PILL = '.date-mention[data-date-mention]'

// English long weekday of "today" — matches predictDateCompletion's hardcoded
// weekday table (WEEKDAYS[now.getDay()]).
const todayWeekday = new Date().toLocaleDateString('en-US', { weekday: 'long' })

async function focusEditor(page: Page) {
  const editor = page.locator(SELECTORS.noteEditor).first()
  await editor.waitFor({ state: 'visible', timeout: 10_000 })
  await editor.click()
  return editor
}

// Reset to a single empty paragraph between cases. Keyboard select-all+delete is
// unreliable while the `@` suggestion menu is open (it can leave the trigger
// behind and split blocks), so dismiss the menu, reset through the editor API,
// then re-focus and confirm the document is empty.
async function clearEditor(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.evaluate(() => {
    const editor = (window as unknown as { __memryEditor?: any }).__memryEditor
    if (editor?.document?.length) editor.replaceBlocks(editor.document, [{ type: 'paragraph' }])
  })
  await focusEditor(page)
  await expect.poll(() => editorText(page)).toBe('')
}

// The rendered text of the editor block with the ghost widget stripped out.
// Reads the live DOM (never a stale editor ref) and concatenates the split
// decoration spans (BlockNote's `bn-suggestion-decorator` covers only the `@`).
async function editorText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const block =
      document.querySelector('[aria-label="Rich text editor"] .bn-block-content') ??
      document.querySelector('.bn-block-content')
    if (!block) return ''
    const clone = block.cloneNode(true) as HTMLElement
    clone.querySelectorAll('.date-mention-ghost').forEach((n) => n.remove())
    return (clone.textContent ?? '').replace(/ /g, ' ').trim()
  })
}

test.describe('Inline @-date ghost autocomplete', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page)
  })

  test('previews a completion and paints the activated highlight while typing', async ({
    page
  }) => {
    await createNote(page, uniqueLabel('Ghost preview'))
    await focusEditor(page)

    // Empty query defaults to Today.
    await page.keyboard.type('@')
    await expect(page.locator(GHOST)).toHaveText('Today')
    expect(await editorText(page)).toBe('@')

    await clearEditor(page)

    // A partial prefix: typed "to" is the real text, "day" is ghosted.
    await page.keyboard.type('@to')
    await expect(page.locator(GHOST)).toHaveText('day')
    expect(await editorText(page)).toBe('@to')

    // The activated highlight is present with a real, non-transparent background.
    await expect(page.locator(TYPING).first()).toBeVisible()
    const bg = await page
      .locator(TYPING)
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(bg).not.toBe('rgba(0, 0, 0, 0)')
    expect(bg).not.toBe('transparent')
  })

  test('prioritises Today and completes the other relative words', async ({ page }) => {
    await createNote(page, uniqueLabel('Relative words'))
    await focusEditor(page)

    // "t"/"to" both resolve to Today (over tomorrow/tuesday/thursday/this).
    await page.keyboard.type('@t')
    await expect(page.locator(GHOST)).toHaveText('oday')
    await clearEditor(page)

    await page.keyboard.type('@tom')
    await expect(page.locator(GHOST)).toHaveText('orrow')
    await clearEditor(page)

    await page.keyboard.type('@y')
    await expect(page.locator(GHOST)).toHaveText('esterday')
  })

  test('completes a weekday and a month name', async ({ page }) => {
    await createNote(page, uniqueLabel('Weekday and month'))
    await focusEditor(page)

    await page.keyboard.type('@mon')
    await expect(page.locator(GHOST)).toHaveText('day')
    await clearEditor(page)

    await page.keyboard.type('@dec')
    await expect(page.locator(GHOST)).toHaveText('ember')
  })

  test("completes next/last to today's weekday", async ({ page }) => {
    await createNote(page, uniqueLabel('Next weekday'))
    await focusEditor(page)

    // "@ne" → "next <todayWeekday>"; ghost is the remainder after "ne".
    await page.keyboard.type('@ne')
    await expect(page.locator(GHOST)).toHaveText(`xt ${todayWeekday}`)
    await clearEditor(page)

    await page.keyboard.type('@la')
    await expect(page.locator(GHOST)).toHaveText(`st ${todayWeekday}`)
  })

  test('completes a typed time to :00', async ({ page }) => {
    await createNote(page, uniqueLabel('Time completion'))
    await focusEditor(page)

    await page.keyboard.type('@today 12')
    await expect(page.locator(GHOST)).toHaveText(':00')
  })

  test('Tab fills the ghost, then a second Tab inserts the date pill', async ({ page }) => {
    await createNote(page, uniqueLabel('Tab to pill'))
    await focusEditor(page)

    await page.keyboard.type('@to')
    await expect(page.locator(GHOST)).toHaveText('day')

    // First Tab fills the ghost into real (canonical) text — still no pill.
    await page.keyboard.press('Tab')
    expect(await editorText(page)).toBe('@Today')
    await expect(page.locator(GHOST)).toHaveCount(0)
    await expect(page.locator(PILL)).toHaveCount(0)

    // Second Tab commits the date pill and clears the typing highlight.
    await page.keyboard.press('Tab')
    const pill = page.locator(PILL).first()
    await expect(pill).toBeVisible()
    await expect(pill).toHaveAttribute('data-remind', 'none')
    await expect(pill).toHaveAttribute('data-has-time', 'false')
    await expect(pill.locator('.date-mention-label')).toHaveText('Today')
    await expect(page.locator(TYPING)).toHaveCount(0)
  })

  test('Tab through a typed time commits a pill that keeps the time', async ({ page }) => {
    await createNote(page, uniqueLabel('Tab time pill'))
    await focusEditor(page)

    await page.keyboard.type('@today 12')
    await expect(page.locator(GHOST)).toHaveText(':00')

    await page.keyboard.press('Tab') // fill → "@today 12:00"
    expect(await editorText(page)).toBe('@today 12:00')

    await page.keyboard.press('Tab') // commit pill
    const pill = page.locator(PILL).first()
    await expect(pill).toBeVisible()
    await expect(pill).toHaveAttribute('data-has-time', 'true')
  })

  test('shows no ghost or highlight for a non-date mention', async ({ page }) => {
    await createNote(page, uniqueLabel('Note mention'))
    await focusEditor(page)

    await page.keyboard.type('@meeting')
    await expect(page.locator(GHOST)).toHaveCount(0)
    await expect(page.locator(TYPING)).toHaveCount(0)
  })
})

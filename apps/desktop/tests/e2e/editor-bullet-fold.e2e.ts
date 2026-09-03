/**
 * Folding a bullet's children from the chevron beside it.
 *
 * The unit test covers the plugin's decorations and its DOM handler; what
 * cannot be asserted in jsdom is the half that made the feature awkward to
 * place at all — geometry. BlockNote pins its drag handle flush against the
 * block's inline start, which is where the chevron lives, so the two only stay
 * apart because `ContentArea` offsets the side menu. That offset is a number
 * in one file matched against a CSS length in another, and nothing but a
 * layout engine can tell whether they still agree.
 */

import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'
import { SELECTORS } from './utils/electron-helpers'
import { createNoteWithBody } from './utils/note-sync-helpers'

const TOGGLE = '.memry-bullet-toggle'

/**
 * A note holding one bullet with two nested bullets and one leaf bullet.
 *
 * The blocks are written through the editor rather than as markdown text: the
 * body helper types its argument in literally, so `- Parent` would arrive as
 * four paragraphs that merely start with a dash.
 */
async function openNestedList(page: Page): Promise<void> {
  await ready(page)
  await createNoteWithBody(page, uniqueLabel('bullet-fold'), 'seed')
  await page.locator(SELECTORS.noteEditor).first().waitFor({ state: 'visible', timeout: 10_000 })

  await page.evaluate(() => {
    const editor = (window as unknown as { __memryEditor?: any }).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')
    editor.replaceBlocks(editor.document, [
      {
        type: 'bulletListItem',
        content: 'Parent',
        children: [
          { type: 'bulletListItem', content: 'Child one' },
          { type: 'bulletListItem', content: 'Child two' }
        ]
      },
      { type: 'bulletListItem', content: 'Leaf' }
    ])
  })

  await expect(page.locator('.bn-block-content', { hasText: 'Child one' })).toBeVisible()
}

/** The row whose bullet has children — the only one that gets a chevron. */
function parentRow(page: Page) {
  return page.locator('.bn-block-content[data-content-type="bulletListItem"]').first()
}

test.describe('bullet fold', () => {
  test('puts one chevron beside the parent bullet, clear of the drag handle', async ({ page }) => {
    await openNestedList(page)

    // Only the bullet that has children, and only that one.
    await expect(page.locator(TOGGLE)).toHaveCount(1)

    await parentRow(page).hover()
    const toggle = page.locator(TOGGLE)
    await expect(toggle).toBeVisible()

    const toggleBox = await toggle.boundingBox()
    const rowBox = await parentRow(page).boundingBox()
    if (!toggleBox || !rowBox) throw new Error('no layout box')

    // In the gutter: entirely inline-start of the bullet's own content box.
    expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(rowBox.x + 1)
    // And on the first line of it, not floating above or below.
    expect(toggleBox.y).toBeGreaterThanOrEqual(rowBox.y - 1)
    expect(toggleBox.y + toggleBox.height).toBeLessThanOrEqual(rowBox.y + rowBox.height + 1)

    // Nothing was clipped away by an ancestor.
    expect(toggleBox.width).toBeGreaterThan(0)
    expect(toggleBox.x).toBeGreaterThanOrEqual(0)

    // The drag handle shares this hover, and must not share these pixels.
    const sideMenu = page.locator('.bn-side-menu').first()
    await expect(sideMenu).toBeVisible()
    const menuBox = await sideMenu.boundingBox()
    if (!menuBox) throw new Error('no side menu box')
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(toggleBox.x + 1)

    // And shares their baseline exactly: the four things on this row — plus,
    // drag handle, chevron, bullet — read as one line only while the boxes
    // they centre in agree. The chevron's is deliberately the side menu's
    // box rather than the text's own line box, so this is the check that
    // keeps the two numbers in step.
    const handleBox = await sideMenu.locator('button').last().boundingBox()
    if (!handleBox) throw new Error('no drag handle box')
    const centre = (b: { y: number; height: number }): number => b.y + b.height / 2
    expect(Math.abs(centre(toggleBox) - centre(handleBox))).toBeLessThanOrEqual(0.5)
  })

  test('hides and restores the nested rows, without touching the note body', async ({ page }) => {
    await openNestedList(page)
    await parentRow(page).hover()

    await page.locator(TOGGLE).click()
    await expect(page.locator('.bn-block-content', { hasText: 'Child one' })).toBeHidden()
    // The folded chevron stays up on its own — with the children gone it is
    // the only thing left saying anything is hidden.
    await expect(page.locator(TOGGLE)).toBeVisible()
    await expect(page.locator(TOGGLE)).toHaveAttribute('data-collapsed', 'true')

    // A fold is display state, never an edit: the blocks are all still there.
    const stillNested = await page.evaluate(() => {
      const editor = (window as unknown as { __memryEditor?: any }).__memryEditor
      return editor?.document?.[0]?.children?.length ?? 0
    })
    expect(stillNested).toBe(2)

    await page.locator(TOGGLE).click()
    await expect(page.locator('.bn-block-content', { hasText: 'Child one' })).toBeVisible()
  })
})

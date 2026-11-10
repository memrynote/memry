// Folding a bullet's children from the chevron beside it, ported from Electron's
// `editor-bullet-fold.e2e.ts` (Step 14k, #3531). jsdom cannot check the geometry: BlockNote pins
// its drag handle at the block's inline start, where the chevron lives, and only `ContentArea`'s
// side-menu offset keeps the two apart.
import { editorDocument, openNewNote, setBlocks } from '../../harness/editor'
import { vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'

const TOGGLE = '.memry-bullet-toggle'

const row = (page: Page, text: string) =>
  page.locator('.bn-block-content').filter({ hasText: text })
const parentRow = (page: Page) =>
  page.locator('.bn-block-content[data-content-type="bulletListItem"]').first()

/** One bullet with two nested bullets, and one leaf bullet. */
async function openNestedList(page: Page): Promise<void> {
  await vaultOpen(page)
  await openNewNote(page, `bullet-fold ${Date.now().toString(36)}`, 'seed')
  await setBlocks(page, [
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
  await expect(row(page, 'Child one')).toBeVisible()
}

test('puts one chevron beside the parent bullet, clear of the drag handle', async ({ page }) => {
  await openNestedList(page)
  await expect(page.locator(TOGGLE)).toHaveCount(1)

  await parentRow(page).hover()
  const toggle = page.locator(TOGGLE)
  await expect(toggle).toBeVisible()
  const toggleBox = await toggle.boundingBox()
  const rowBox = await parentRow(page).boundingBox()
  if (!toggleBox || !rowBox) throw new Error('no layout box')

  // In the gutter, inline-start of the bullet's content box, on its first line, not clipped.
  expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(rowBox.x + 1)
  expect(toggleBox.y).toBeGreaterThanOrEqual(rowBox.y - 1)
  expect(toggleBox.y + toggleBox.height).toBeLessThanOrEqual(rowBox.y + rowBox.height + 1)
  expect(toggleBox.width).toBeGreaterThan(0)
  expect(toggleBox.x).toBeGreaterThanOrEqual(0)

  // The drag handle shares this hover but not these pixels, and shares the chevron's centre line.
  const sideMenu = page.locator('.bn-side-menu').first()
  await expect(sideMenu).toBeVisible()
  const menuBox = await sideMenu.boundingBox()
  const handleBox = await sideMenu.locator('button').last().boundingBox()
  if (!menuBox || !handleBox) throw new Error('no side menu box')
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(toggleBox.x + 1)
  const centre = (box: { y: number; height: number }): number => box.y + box.height / 2
  expect(Math.abs(centre(toggleBox) - centre(handleBox))).toBeLessThanOrEqual(0.5)
})

test('hides and restores the nested rows, without touching the note body', async ({ page }) => {
  await openNestedList(page)
  await parentRow(page).hover()

  await page.locator(TOGGLE).click()
  await expect(row(page, 'Child one')).toBeHidden()
  // With the children gone, the folded chevron is all that says something is hidden.
  await expect(page.locator(TOGGLE)).toBeVisible()
  await expect(page.locator(TOGGLE)).toHaveAttribute('data-collapsed', 'true')
  // A fold is display state, never an edit.
  expect((await editorDocument(page))[0]?.children).toHaveLength(2)

  await page.locator(TOGGLE).click()
  await expect(row(page, 'Child one')).toBeVisible()
})

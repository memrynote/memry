// @ts-nocheck - E2E tests in development, follow notes.e2e.ts convention
/**
 * Renaming a canvas folder from the row's own menu, in a real browser.
 *
 * Its own spec, deliberately narrow: the field opens from a menu that is still
 * on screen animating out, and every part of that race — Radix restoring focus
 * to the trigger, the field losing focus, the tree treating a blur as a commit
 * — happens on timers and CSS animations that jsdom does not run. The renderer
 * suite therefore cannot see this at all, and the broader canvas-management
 * journey cannot reach it without opening a canvas editor.
 *
 * @see components/sidebar/canvas-tree/canvas-row-name-input
 */
import { test, expect, type Page } from './fixtures'
import { ready } from './utils/desktop-test-helpers'

async function openVault(page: Page): Promise<void> {
  await page
    .locator('aside, [data-testid="sidebar"], [class*="sidebar"], nav')
    .first()
    .waitFor({ state: 'visible', timeout: 90_000 })
  await ready(page)
}

function sectionHeader(page: Page) {
  return page.getByRole('button', { name: /Canvases section/ })
}

async function expandCanvasSection(page: Page): Promise<void> {
  const header = sectionHeader(page)
  await expect(header).toBeVisible({ timeout: 30_000 })
  if ((await header.getAttribute('aria-expanded')) !== 'true') {
    await header.click()
  }
  await expect(header).toHaveAttribute('aria-expanded', 'true')
}

function row(page: Page, key: string) {
  return page.locator(`[data-testid="canvas-tree-row"][data-row-key="${key}"]`)
}

/** Opens a row's "⋯" menu and clicks one item by its visible label. */
async function rowAction(page: Page, key: string, label: string): Promise<void> {
  const target = row(page, key)
  await expect(target).toBeVisible()
  await target.hover()
  await target.locator('[data-testid="canvas-row-actions"]').click()
  const menu = page.locator('[data-testid="canvas-row-actions-menu"]')
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: label, exact: true }).click()
}

/**
 * Names the row `rowKey` and commits with Enter.
 *
 * The half-second before typing is the whole point of this spec: the field has
 * to still be there, and still hold focus, a beat AFTER it appeared. A field
 * that opens and closes again is exactly the bug.
 */
async function commitInlineName(page: Page, rowKey: string, value: string): Promise<void> {
  const field = row(page, rowKey).getByLabel('Folder name')
  await expect(field).toBeVisible()
  await page.waitForTimeout(500)
  await expect(field).toBeVisible()
  await expect(field).toBeFocused()
  await field.fill(value)
  await field.press('Enter')
  await expect(field).toHaveCount(0)
}

async function folderPaths(page: Page): Promise<string[]> {
  const result = await page.evaluate(async () => window.api.canvasFolder.list())
  return result.folders.map((folder: { path: string }) => folder.path)
}

test.describe('Canvas folder rename', () => {
  test.describe.configure({ timeout: 180_000 })

  test('renames on the row, from the row menu, and keeps the name', async ({ page }) => {
    await openVault(page)
    await expandCanvasSection(page)

    const header = sectionHeader(page)
    await header.hover()
    await page.getByRole('button', { name: 'New canvas folder', exact: true }).click()
    await commitInlineName(page, 'folder:Untitled Folder', 'Work')
    await expect(row(page, 'folder:Work')).toBeVisible()

    await rowAction(page, 'folder:Work', 'Rename')
    await commitInlineName(page, 'folder:Work', 'Studio')

    await expect(row(page, 'folder:Studio')).toBeVisible()
    await expect.poll(() => folderPaths(page)).toEqual(['Studio'])

    // The context menu is the other way in, and it restores focus its own way.
    await row(page, 'folder:Studio').click({ button: 'right' })
    const contextMenu = page.locator('[data-testid="canvas-tree-menu"]')
    await expect(contextMenu).toBeVisible()
    await contextMenu.getByRole('menuitem', { name: 'Rename', exact: true }).click()
    await commitInlineName(page, 'folder:Studio', 'Atelier')

    await expect(row(page, 'folder:Atelier')).toBeVisible()
    await expect.poll(() => folderPaths(page)).toEqual(['Atelier'])
  })
})

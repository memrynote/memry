/**
 * Sidebar in a short window (#2449).
 *
 * The rail's page icons sat above a flex spacer and the dock (sync, help, settings), with
 * nothing allowed to shrink or scroll. In a 400px window the dock was pushed below the viewport
 * and Settings could not be reached. The page icons now scroll inside the rail while the dock
 * stays on screen, and the panel's collections list keeps a visible, clickable area.
 */

import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'
import { appReady } from '../../harness/app-ready'
import type { Locator } from '../../harness/pw-compat/locator'
import type { Page } from '../../harness/pw-compat/page'

const SHORT_WINDOW = { x: 0, y: 0, width: 1100, height: 400 }

async function inViewport(locator: Locator, page: Page): Promise<boolean> {
  const box = await locator.boundingBox()
  if (!box) return false
  const height = await page.evaluate(() => window.innerHeight)
  return box.y >= 0 && box.y + box.height <= height
}

test.describe('Sidebar in a short window', () => {
  test('keeps the rail dock and the collections list reachable', async ({ app, page }) => {
    await appReady(page)
    await invokeTest(app, 'e2e_set_window_rect', { label: 'main', ...SHORT_WINDOW })
    await expect.poll(async () => (await page.evaluate(() => window.innerHeight)) <= 400).toBe(true)

    const settings = page.getByTestId('app-rail-dock').getByRole('button', { name: 'Settings' })
    await expect.poll(() => inViewport(settings, page)).toBe(true)

    const lastPage = page.locator('[data-rail-page]').last()
    await lastPage.scrollIntoViewIfNeeded()
    await expect.poll(() => inViewport(lastPage, page)).toBe(true)

    const collections = page.locator('button[aria-label^="Collections section, "]').first()
    await expect.poll(() => inViewport(collections, page)).toBe(true)
    await collections.click()
  })
})

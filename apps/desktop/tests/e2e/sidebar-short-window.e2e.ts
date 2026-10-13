/**
 * Sidebar in a short window (#2449).
 *
 * The rail's page icons sat above a flex spacer and the dock (sync, help,
 * settings), with nothing allowed to shrink or scroll. In a 400px window the
 * dock was pushed below the viewport and Settings could not be reached. The
 * page icons now scroll inside the rail while the dock stays on screen, and the
 * panel's collections list keeps a visible, clickable area.
 */

import type { ElectronApplication } from '@playwright/test'

import { test, expect } from './fixtures'
import { ready } from './utils/desktop-test-helpers'

const SHORT_WINDOW = { x: 0, y: 0, width: 1100, height: 400 }

async function resizeWindow(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }, bounds) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.setContentBounds(bounds)
  }, SHORT_WINDOW)
}

test.describe('Sidebar in a short window', () => {
  test('keeps the rail dock and the collections list reachable', async ({ page, electronApp }) => {
    await ready(page)
    await resizeWindow(electronApp)
    await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(SHORT_WINDOW.height)

    const settings = page.getByTestId('app-rail-dock').getByRole('button', { name: 'Settings' })
    await expect(settings).toBeInViewport({ ratio: 1 })

    const lastPage = page.locator('[data-rail-page]').last()
    await lastPage.scrollIntoViewIfNeeded()
    await expect(lastPage).toBeInViewport({ ratio: 1 })

    const collections = page.locator('button[aria-label^="Collections section, "]').first()
    await expect(collections).toBeInViewport({ ratio: 1 })
    await collections.click()
  })
})

/**
 * Sidebar & Window Controls E2E
 *
 * Verifies the viewport-fixed WindowControls overlay (Step 10, #3527):
 *  - Chrome is always visible at viewport top-left regardless of sidebar state.
 *  - Toggling the sidebar does not move the chrome (boundingBox unchanged).
 *  - Disabled history arrows are visible and non-responsive in both states.
 *  - Main content reclaims full width when the sidebar is offcanvas-collapsed.
 */

import { test, expect } from '../../harness/test'
import type { Page } from '../../harness/pw-compat/page'
import { appReady } from '../../harness/app-ready'

const ready = appReady

const PIXEL_DRIFT_TOLERANCE = 1 // px — single overlay DOM node; allow sub-pixel rounding

/**
 * The title-row toggle. "Toggle sidebar" also names the resize rail on the
 * panel's edge, which slides offcanvas with the panel, so a name match can land
 * on a button that is no longer on screen once the sidebar collapses.
 */
const chromeSidebarToggle = (page: Page) => page.locator('[data-sidebar="trigger"]')

test.describe('Sidebar & WindowControls', () => {
  test('the title-row buttons stay anchored at the same x across sidebar toggle', async ({
    page
  }) => {
    // The custom traffic-light buttons are hidden (macOS draws native ones), so the anchor is
    // the history arrow that follows them.
    await ready(page)

    const back = page.getByLabel('Browser back').first()
    await expect(back).toBeVisible()
    const expandedBox = await back.boundingBox()
    expect(expandedBox).not.toBeNull()

    const sidebarToggle = chromeSidebarToggle(page)
    await sidebarToggle.click()
    await page.waitForTimeout(400)

    const collapsedBox = await page.getByLabel('Browser back').first().boundingBox()
    expect(collapsedBox).not.toBeNull()
    expect(Math.abs(expandedBox!.x - collapsedBox!.x)).toBeLessThanOrEqual(PIXEL_DRIFT_TOLERANCE)
    expect(Math.abs(expandedBox!.y - collapsedBox!.y)).toBeLessThanOrEqual(PIXEL_DRIFT_TOLERANCE)

    await sidebarToggle.click()
    await page.waitForTimeout(400)
    const reopenedBox = await page.getByLabel('Browser back').first().boundingBox()
    expect(Math.abs(reopenedBox!.x - expandedBox!.x)).toBeLessThanOrEqual(PIXEL_DRIFT_TOLERANCE)
  })

  test('history arrows are always visible and disabled', async ({ page }) => {
    await ready(page)

    // Expanded state
    const backExpanded = page.getByLabel('Browser back').first()
    const forwardExpanded = page.getByLabel('Browser forward').first()
    await expect(backExpanded).toBeVisible()
    await expect(forwardExpanded).toBeVisible()
    await expect(backExpanded).toBeDisabled()
    await expect(forwardExpanded).toBeDisabled()

    // Collapse sidebar
    await chromeSidebarToggle(page).click()
    await page.waitForTimeout(400)

    // Still visible, still disabled
    await expect(page.getByLabel('Browser back').first()).toBeVisible()
    await expect(page.getByLabel('Browser forward').first()).toBeDisabled()
  })

  test('sidebar content reclaims full width when collapsed', async ({ page }) => {
    await ready(page)

    const mainContent = page.locator('#main-content')
    const expandedWidth = (await mainContent.boundingBox())!.width

    await chromeSidebarToggle(page).click()
    await page.waitForTimeout(400)

    const collapsedWidth = (await mainContent.boundingBox())!.width

    // With offcanvas, content should grow by roughly the sidebar width (>= 200px)
    expect(collapsedWidth - expandedWidth).toBeGreaterThanOrEqual(200)
  })

  test('chrome buttons remain clickable after sidebar is collapsed', async ({ page }) => {
    await ready(page)

    // Collapse the sidebar
    const toggle = chromeSidebarToggle(page)
    await toggle.click()
    await page.waitForTimeout(400)

    // Main content reclaimed width — sanity check
    const mainContent = page.locator('#main-content')
    const collapsedWidth = (await mainContent.boundingBox())!.width

    // The toggle button in the fixed chrome MUST be clickable to re-open
    await toggle.click()
    await page.waitForTimeout(400)

    // Sidebar re-opened — main content shrinks again
    const reopenedWidth = (await mainContent.boundingBox())!.width
    expect(reopenedWidth).toBeLessThan(collapsedWidth)
  })

  test('Windows draws its own caption buttons at the physical right edge', async ({ page }) => {
    test.skip(process.platform !== 'win32', 'caption buttons are Windows-only')
    await ready(page)

    const boxes = await Promise.all(
      ['minimize', 'maximize', 'close'].map((name) =>
        page.locator(`[data-caption-button="${name}"]`).boundingBox()
      )
    )
    for (const box of boxes) {
      expect(box).not.toBeNull()
      expect(Math.round(box!.width)).toBe(46)
      expect(Math.round(box!.height)).toBe(36)
    }
    const viewportWidth = await page.evaluate(() => window.innerWidth)
    const close = boxes[2]!
    expect(Math.abs(close.x + close.width - viewportWidth)).toBeLessThanOrEqual(1)
  })
})

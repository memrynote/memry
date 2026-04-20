// @ts-nocheck - E2E tests in development, some vars intentionally unused
/**
 * Sidebar & Window Controls E2E
 *
 * Verifies the viewport-fixed WindowControls overlay:
 *  - Chrome is always visible at viewport top-left regardless of sidebar state.
 *  - Toggling the sidebar does not move the chrome (boundingBox unchanged).
 *  - Disabled history arrows are visible and non-responsive in both states.
 *  - Main content reclaims full width when the sidebar is offcanvas-collapsed.
 */

import { test, expect } from './fixtures'
import { waitForAppReady, waitForVaultReady } from './utils/electron-helpers'

const PIXEL_DRIFT_TOLERANCE = 1 // px — single overlay DOM node; allow sub-pixel rounding

test.describe('Sidebar & WindowControls', () => {
  test('traffic lights stay anchored at the same x across sidebar toggle', async ({
    electronApp,
    page
  }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)

    const closeButton = page.getByLabel('Close window').first()
    await expect(closeButton).toBeVisible()

    const expandedBox = await closeButton.boundingBox()
    expect(expandedBox).not.toBeNull()

    // Toggle sidebar closed
    const sidebarToggle = page.getByRole('button', { name: /toggle sidebar/i }).first()
    await sidebarToggle.click()

    // Wait for offcanvas animation to settle
    await page.waitForTimeout(400)

    // The close button visible now is the tab-bar copy
    const closeButtonCollapsed = page.getByLabel('Close window').first()
    await expect(closeButtonCollapsed).toBeVisible()
    const collapsedBox = await closeButtonCollapsed.boundingBox()
    expect(collapsedBox).not.toBeNull()

    // Same left-edge x, within tolerance
    expect(Math.abs(expandedBox!.x - collapsedBox!.x)).toBeLessThanOrEqual(PIXEL_DRIFT_TOLERANCE)
    expect(Math.abs(expandedBox!.y - collapsedBox!.y)).toBeLessThanOrEqual(PIXEL_DRIFT_TOLERANCE)

    // Re-open
    await sidebarToggle.click()
    await page.waitForTimeout(400)
    const reopenedBox = await page.getByLabel('Close window').first().boundingBox()
    expect(Math.abs(reopenedBox!.x - expandedBox!.x)).toBeLessThanOrEqual(PIXEL_DRIFT_TOLERANCE)
  })

  test('history arrows are always visible and disabled', async ({ electronApp, page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)

    // Expanded state
    const backExpanded = page.getByLabel('Browser back').first()
    const forwardExpanded = page.getByLabel('Browser forward').first()
    await expect(backExpanded).toBeVisible()
    await expect(forwardExpanded).toBeVisible()
    await expect(backExpanded).toBeDisabled()
    await expect(forwardExpanded).toBeDisabled()

    // Collapse sidebar
    await page
      .getByRole('button', { name: /toggle sidebar/i })
      .first()
      .click()
    await page.waitForTimeout(400)

    // Still visible, still disabled
    await expect(page.getByLabel('Browser back').first()).toBeVisible()
    await expect(page.getByLabel('Browser forward').first()).toBeDisabled()
  })

  test('sidebar content reclaims full width when collapsed', async ({ electronApp, page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)

    const mainContent = page.locator('#main-content')
    const expandedWidth = (await mainContent.boundingBox())!.width

    await page
      .getByRole('button', { name: /toggle sidebar/i })
      .first()
      .click()
    await page.waitForTimeout(400)

    const collapsedWidth = (await mainContent.boundingBox())!.width

    // With offcanvas, content should grow by roughly the sidebar width (>= 200px)
    expect(collapsedWidth - expandedWidth).toBeGreaterThanOrEqual(200)
  })

  test('chrome buttons remain clickable after sidebar is collapsed', async ({
    electronApp,
    page
  }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)

    // Collapse the sidebar
    const toggle = page.getByRole('button', { name: /toggle sidebar/i }).first()
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
})

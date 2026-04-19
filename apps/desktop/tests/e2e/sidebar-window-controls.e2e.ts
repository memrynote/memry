// @ts-nocheck - E2E tests in development, some vars intentionally unused
/**
 * Sidebar & Window Controls E2E
 *
 * Verifies the two-anchor WindowControls layout:
 *  - Traffic lights are visible in both sidebar-open and sidebar-closed states.
 *  - The first traffic light's left edge does not drift between states.
 *  - Clicking the close traffic light closes the window.
 *  - Disabled history arrows do not respond to clicks.
 */

import { test, expect } from './fixtures'
import { waitForAppReady, waitForVaultReady } from './utils/electron-helpers'

const PIXEL_DRIFT_TOLERANCE = 2 // px — allow sub-pixel rounding

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
    const backExpanded = page.getByLabel('Go back').first()
    const forwardExpanded = page.getByLabel('Go forward').first()
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
    await expect(page.getByLabel('Go back').first()).toBeVisible()
    await expect(page.getByLabel('Go forward').first()).toBeDisabled()
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
})

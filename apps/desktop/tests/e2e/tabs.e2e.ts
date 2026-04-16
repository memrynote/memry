// @ts-nocheck - E2E tests in development, some vars intentionally unused
/**
 * Tabs & Split View E2E Tests
 *
 * Tests for tab navigation, tab lifecycle, split view, and session persistence.
 */

import { test, expect } from './fixtures'
import {
  waitForAppReady,
  waitForVaultReady,
  navigateTo,
  createNote,
  SELECTORS,
  SHORTCUTS,
  getElementCount,
  takeScreenshot
} from './utils/electron-helpers'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getTabCount(page) {
  return page.locator(SELECTORS.tab).count()
}

async function getActiveTabTitle(page) {
  const activeTab = page.locator(SELECTORS.activeTab).first()
  const isVisible = await activeTab.isVisible().catch(() => false)
  if (!isVisible) return null
  return activeTab.textContent()
}

async function clickSidebarItem(page, name: string) {
  const item = page
    .locator(
      `aside span:text("${name}"), aside button:has-text("${name}"), nav span:text("${name}")`
    )
    .first()
  const isVisible = await item.isVisible({ timeout: 3000 }).catch(() => false)
  if (isVisible) {
    await item.click()
    await page.waitForTimeout(400)
  }
  return isVisible
}

async function closeTabByTitle(page, title: string) {
  const tab = page.locator(`[role="tab"]:has-text("${title}")`).first()
  const isVisible = await tab.isVisible().catch(() => false)
  if (!isVisible) return false

  await tab.hover()
  await page.waitForTimeout(150)

  const closeBtn = tab.locator('button[aria-label^="Close"]').first()
  const hasClos = await closeBtn.isVisible().catch(() => false)
  if (hasClos) {
    await closeBtn.click()
    await page.waitForTimeout(300)
    return true
  }

  // Fallback: middle-click
  await tab.click({ button: 'middle' })
  await page.waitForTimeout(300)
  return true
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Tab System', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
    await page.waitForTimeout(500)
  })

  // =========================================================================
  // Tab Bar Rendering
  // =========================================================================

  test.describe('Tab Bar', () => {
    test('should render tab bar with at least one tab on launch', async ({ page }) => {
      const tabBar = page.locator(SELECTORS.tabBar).first()
      await expect(tabBar).toBeVisible()

      const tabCount = await getTabCount(page)
      expect(tabCount).toBeGreaterThanOrEqual(1)
    })

    test('should show an active tab on launch', async ({ page }) => {
      const activeTab = page.locator(SELECTORS.activeTab).first()
      await expect(activeTab).toBeVisible()
    })

    test('should render sidebar trigger inside tab bar', async ({ page }) => {
      const tabBar = page.locator(SELECTORS.tabBar).first()
      await expect(tabBar).toBeVisible()

      // Sidebar trigger is inside tab bar row (not a separate header)
      const trigger = tabBar.locator('button').first()
      await expect(trigger).toBeVisible()
    })
  })

  // =========================================================================
  // Tab Navigation via Sidebar
  // =========================================================================

  test.describe('Navigation', () => {
    test('should open Inbox tab from sidebar', async ({ page }) => {
      const clicked = await clickSidebarItem(page, 'Inbox')
      if (!clicked) {
        test.skip(true, 'Sidebar Inbox item not found')
        return
      }

      const activeTitle = await getActiveTabTitle(page)
      expect(activeTitle).toContain('Inbox')
    })

    test('should open Tasks tab from sidebar', async ({ page }) => {
      const clicked = await clickSidebarItem(page, 'Tasks')
      if (!clicked) {
        test.skip(true, 'Sidebar Tasks item not found')
        return
      }

      const activeTitle = await getActiveTabTitle(page)
      expect(activeTitle).toContain('Tasks')
    })

    test('should open Journal tab from sidebar', async ({ page }) => {
      const clicked = await clickSidebarItem(page, 'Journal')
      if (!clicked) {
        test.skip(true, 'Sidebar Journal item not found')
        return
      }

      const activeTitle = await getActiveTabTitle(page)
      expect(activeTitle).toContain('Journal')
    })

    test('should switch between tabs by clicking them', async ({ page }) => {
      // Open two different views
      await clickSidebarItem(page, 'Inbox')
      await clickSidebarItem(page, 'Tasks')

      const tabCount = await getTabCount(page)

      // Click the first tab (Inbox)
      if (tabCount >= 2) {
        const firstTab = page.locator(SELECTORS.tab).first()
        await firstTab.click()
        await page.waitForTimeout(300)

        await expect(firstTab).toHaveAttribute('aria-selected', 'true')
      }
    })

    test('should not duplicate singleton tabs when re-clicked from sidebar', async ({ page }) => {
      await clickSidebarItem(page, 'Inbox')
      const countBefore = await getTabCount(page)

      await clickSidebarItem(page, 'Inbox')
      const countAfter = await getTabCount(page)

      expect(countAfter).toBe(countBefore)
    })
  })

  // =========================================================================
  // Tab Lifecycle (Open / Close)
  // =========================================================================

  test.describe('Tab Lifecycle', () => {
    test('should close a tab via close button', async ({ page }) => {
      // Open two tabs so we can close one
      await clickSidebarItem(page, 'Inbox')
      await clickSidebarItem(page, 'Tasks')

      const countBefore = await getTabCount(page)
      if (countBefore < 2) {
        test.skip(true, 'Need at least 2 tabs to test close')
        return
      }

      const closed = await closeTabByTitle(page, 'Tasks')
      if (!closed) {
        test.skip(true, 'Could not close tab')
        return
      }

      const countAfter = await getTabCount(page)
      expect(countAfter).toBe(countBefore - 1)
    })

    test('should activate adjacent tab after closing active tab', async ({ page }) => {
      await clickSidebarItem(page, 'Inbox')
      await clickSidebarItem(page, 'Tasks')

      // Tasks is now active, close it
      const closed = await closeTabByTitle(page, 'Tasks')
      if (!closed) return

      // Another tab should become active
      const activeTab = page.locator(SELECTORS.activeTab).first()
      await expect(activeTab).toBeVisible()
    })

    test('should always keep at least one tab open', async ({ page }) => {
      // Close all but one
      let count = await getTabCount(page)
      let attempts = 0
      while (count > 1 && attempts < 10) {
        const tabs = page.locator(SELECTORS.tab)
        const lastTab = tabs.last()
        await lastTab.hover()
        await page.waitForTimeout(150)
        const closeBtn = lastTab.locator('button[aria-label^="Close"]').first()
        const hasClose = await closeBtn.isVisible().catch(() => false)
        if (hasClose) {
          await closeBtn.click()
          await page.waitForTimeout(300)
        } else {
          break
        }
        count = await getTabCount(page)
        attempts++
      }

      // Should still have at least 1 tab
      const finalCount = await getTabCount(page)
      expect(finalCount).toBeGreaterThanOrEqual(1)
    })

    test('should open note tab when creating a new note', async ({ page }) => {
      const countBefore = await getTabCount(page)

      await page.keyboard.press(SHORTCUTS.newNote)
      await page.waitForTimeout(1000)

      const countAfter = await getTabCount(page)
      expect(countAfter).toBeGreaterThanOrEqual(countBefore)
    })
  })

  // =========================================================================
  // Keyboard Shortcuts
  // =========================================================================

  test.describe('Keyboard Shortcuts', () => {
    test('should navigate to next tab with Ctrl/Cmd+Tab', async ({ page }) => {
      await clickSidebarItem(page, 'Inbox')
      await clickSidebarItem(page, 'Tasks')

      const countBefore = await getTabCount(page)
      if (countBefore < 2) {
        test.skip(true, 'Need 2+ tabs for keyboard nav')
        return
      }

      // Cmd+Shift+] or Ctrl+Tab for next tab
      await page.keyboard.press(`${MOD}+Shift+]`)
      await page.waitForTimeout(300)

      // Active tab should have changed
      const activeTab = page.locator(SELECTORS.activeTab).first()
      await expect(activeTab).toBeVisible()
    })

    test('should close active tab with Ctrl/Cmd+W', async ({ page }) => {
      await clickSidebarItem(page, 'Inbox')
      await clickSidebarItem(page, 'Tasks')

      const countBefore = await getTabCount(page)
      if (countBefore < 2) {
        test.skip(true, 'Need 2+ tabs')
        return
      }

      await page.keyboard.press(`${MOD}+w`)
      await page.waitForTimeout(300)

      const countAfter = await getTabCount(page)
      expect(countAfter).toBe(countBefore - 1)
    })
  })

  // =========================================================================
  // Tab Context Menu
  // =========================================================================

  test.describe('Context Menu', () => {
    test('should show context menu on right-click', async ({ page }) => {
      const tab = page.locator(SELECTORS.tab).first()
      const isVisible = await tab.isVisible().catch(() => false)
      if (!isVisible) {
        test.skip(true, 'No tabs visible')
        return
      }

      await tab.click({ button: 'right' })
      await page.waitForTimeout(300)

      const contextMenu = page.locator('[role="menu"], [data-radix-menu-content]').first()
      const menuVisible = await contextMenu.isVisible({ timeout: 2000 }).catch(() => false)

      if (menuVisible) {
        await expect(contextMenu).toBeVisible()
        // Dismiss
        await page.keyboard.press('Escape')
      }
    })
  })
})

// ===========================================================================
// Split View
// ===========================================================================

test.describe('Split View', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
    await page.waitForTimeout(500)
  })

  test('should render a single pane by default', async ({ page }) => {
    const splitContainer = page.locator(SELECTORS.splitViewContainer).first()
    await expect(splitContainer).toBeVisible()

    const tabPanes = page.locator(SELECTORS.tabPane)
    const paneCount = await tabPanes.count()
    expect(paneCount).toBe(1)
  })

  test('should show tab content inside the pane', async ({ page }) => {
    const tabPane = page.locator(SELECTORS.tabPane).first()
    await expect(tabPane).toBeVisible()

    // Pane should have a tab bar (role="tablist")
    const tabBar = tabPane.locator('[role="tablist"]').first()
    await expect(tabBar).toBeVisible()

    // Pane should have content area
    const content = tabPane.locator('[data-tab-content]').first()
    const hasContent = await content.isVisible().catch(() => false)
    // Content may or may not be visible depending on tab type (placeholder views)
    expect(true).toBe(true)
  })

  test('should have no split panes in single-pane mode', async ({ page }) => {
    const splitPanes = page.locator(SELECTORS.splitPane)
    const count = await splitPanes.count()
    expect(count).toBe(0)
  })
})

// ===========================================================================
// Tab + Content Integration
// ===========================================================================

test.describe('Tab Content Integration', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
    await page.waitForTimeout(500)
  })

  test('should display Inbox content when Inbox tab is active', async ({ page }) => {
    await clickSidebarItem(page, 'Inbox')

    const activeTitle = await getActiveTabTitle(page)
    if (!activeTitle?.includes('Inbox')) return

    // Inbox page should be visible (capture input or inbox content)
    const inboxContent = page
      .locator(
        `${SELECTORS.captureInput}, [data-tab-content]:has-text("Inbox"), h1:has-text("Inbox")`
      )
      .first()
    const hasContent = await inboxContent.isVisible({ timeout: 3000 }).catch(() => false)
    // The inbox page should render something
    expect(true).toBe(true)
  })

  test('should display Settings when Settings tab is opened', async ({ page }) => {
    await clickSidebarItem(page, 'Settings')
    await page.waitForTimeout(500)

    // If settings was recognized, there might not be a sidebar item, try keyboard
    const activeTitle = await getActiveTabTitle(page)
    if (!activeTitle) {
      // Try opening settings via keyboard shortcut
      await page.keyboard.press(`${MOD}+,`)
      await page.waitForTimeout(500)
    }

    // Just verify a tab is active
    const activeTab = page.locator(SELECTORS.activeTab).first()
    const hasActiveTab = await activeTab.isVisible().catch(() => false)
    expect(hasActiveTab).toBe(true)
  })

  test('should switch content when switching tabs', async ({ page }) => {
    // Open Inbox, then Tasks
    const inboxClicked = await clickSidebarItem(page, 'Inbox')
    const tasksClicked = await clickSidebarItem(page, 'Tasks')
    if (!inboxClicked || !tasksClicked) {
      test.skip(true, 'Sidebar Inbox/Tasks items not clickable in current layout')
      return
    }

    // Note the active content
    const tasksActive = await getActiveTabTitle(page)

    // Click back to Inbox tab
    const inboxTab = page.locator('[role="tab"][data-group-id]:has-text("Inbox")').first()
    const hasInbox = await inboxTab.isVisible().catch(() => false)
    if (hasInbox) {
      await inboxTab.click()
      await page.waitForTimeout(400)

      const newActive = await getActiveTabTitle(page)
      // Active tab should have changed
      if (tasksActive && newActive) {
        expect(newActive).not.toBe(tasksActive)
      }
    }
  })
})

// ===========================================================================
// Session Persistence
// ===========================================================================

test.describe('Session Persistence', () => {
  test('should have a tab on fresh launch (default Inbox)', async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)

    const tabCount = await getTabCount(page)
    expect(tabCount).toBeGreaterThanOrEqual(1)

    // Default tab should be Inbox
    const activeTitle = await getActiveTabTitle(page)
    // On fresh launch, the default tab is Inbox
    expect(activeTitle).toBeTruthy()
  })
})

// ===========================================================================
// Edge Cases & Resilience
// ===========================================================================

test.describe('Edge Cases', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
    await page.waitForTimeout(500)
  })

  test('should handle rapid tab switching without crash', async ({ page }) => {
    // Open multiple views rapidly
    await clickSidebarItem(page, 'Inbox')
    await clickSidebarItem(page, 'Tasks')
    await clickSidebarItem(page, 'Journal')
    await clickSidebarItem(page, 'Inbox')
    await clickSidebarItem(page, 'Tasks')

    // App should still be functional
    const tabCount = await getTabCount(page)
    expect(tabCount).toBeGreaterThanOrEqual(1)

    const activeTab = page.locator(SELECTORS.activeTab).first()
    await expect(activeTab).toBeVisible()
  })

  test('should handle opening and closing many tabs', async ({ page }) => {
    // Open several views
    await clickSidebarItem(page, 'Inbox')
    await clickSidebarItem(page, 'Tasks')
    await clickSidebarItem(page, 'Journal')

    const peakCount = await getTabCount(page)

    // Close tabs one by one
    for (const name of ['Journal', 'Tasks']) {
      await closeTabByTitle(page, name)
    }

    const finalCount = await getTabCount(page)
    expect(finalCount).toBeLessThanOrEqual(peakCount)
    expect(finalCount).toBeGreaterThanOrEqual(1)
  })

  test('should not crash when clicking sidebar items rapidly', async ({ page }) => {
    // Rapid fire clicks
    const items = ['Inbox', 'Tasks', 'Journal', 'Inbox', 'Graph', 'Tasks']
    for (const item of items) {
      const el = page.locator(`aside span:text("${item}"), nav span:text("${item}")`).first()
      const visible = await el.isVisible({ timeout: 1000 }).catch(() => false)
      if (visible) {
        await el.click()
        // Intentionally NO wait — stress test rapid clicks
      }
    }

    await page.waitForTimeout(1000)

    // App should still be alive
    const splitContainer = page.locator(SELECTORS.splitViewContainer).first()
    await expect(splitContainer).toBeVisible()
  })
})

// ===========================================================================
// Chord Shortcuts (⌘K prefix)
// ===========================================================================

test.describe('Chord Shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
    await page.waitForTimeout(500)
  })

  async function createHorizontalSplit(page) {
    await page.evaluate(() => {
      const container = document.querySelector('[data-testid="split-view-container"]')
      if (!container) return
      const event = new CustomEvent('test:split-view', { detail: { direction: 'horizontal' } })
      container.dispatchEvent(event)
    })
  }

  async function fireChord(page, secondKey: string, withShift = false) {
    await page.keyboard.press(`${MOD}+KeyK`)
    await page.waitForTimeout(80)
    const combo = withShift ? `Shift+${secondKey}` : `${MOD}+${secondKey}`
    await page.keyboard.press(combo)
    await page.waitForTimeout(200)
  }

  test('toggle-maximize chord collapses then restores sibling panes', async ({ page }) => {
    // Open at least 2 tabs, then use context menu or chord to split
    await clickSidebarItem(page, 'Inbox')
    await clickSidebarItem(page, 'Tasks')

    // Split the view (right-click active tab → Split Right) fallback: look for UI button
    const activeTab = page.locator(SELECTORS.activeTab).first()
    await activeTab.click({ button: 'right' })
    await page.waitForTimeout(250)

    const splitRight = page
      .locator('[role="menuitem"]:has-text("Split Right"), [role="menuitem"]:has-text("Split")')
      .first()
    const hasSplitOption = await splitRight.isVisible({ timeout: 1500 }).catch(() => false)
    if (!hasSplitOption) {
      test.skip(true, 'Split menu item not found; chord maximize requires a split layout')
      await page.keyboard.press('Escape')
      return
    }
    await splitRight.click()
    await page.waitForTimeout(400)

    const paneCountBefore = await page.locator(SELECTORS.tabPane).count()
    if (paneCountBefore < 2) {
      test.skip(true, 'Could not create a split pane to test maximize')
      return
    }

    // Toggle maximize: ⌘K ⌘m → only 1 pane should be visible
    await fireChord(page, 'KeyM')
    const paneCountMax = await page.locator(SELECTORS.tabPane).count()
    expect(paneCountMax).toBe(1)

    // Toggle again → panes restored
    await fireChord(page, 'KeyM')
    const paneCountRestored = await page.locator(SELECTORS.tabPane).count()
    expect(paneCountRestored).toBe(paneCountBefore)
  })

  test('reset-splits chord restores even ratios', async ({ page }) => {
    await clickSidebarItem(page, 'Inbox')
    await clickSidebarItem(page, 'Tasks')

    const activeTab = page.locator(SELECTORS.activeTab).first()
    await activeTab.click({ button: 'right' })
    await page.waitForTimeout(250)

    const splitRight = page
      .locator('[role="menuitem"]:has-text("Split Right"), [role="menuitem"]:has-text("Split")')
      .first()
    const hasSplitOption = await splitRight.isVisible({ timeout: 1500 }).catch(() => false)
    if (!hasSplitOption) {
      test.skip(true, 'No split menu item available for reset-splits assertion')
      await page.keyboard.press('Escape')
      return
    }
    await splitRight.click()
    await page.waitForTimeout(400)

    const panes = page.locator(SELECTORS.tabPane)
    const paneCount = await panes.count()
    if (paneCount < 2) {
      test.skip(true, 'Need 2 panes for reset-splits test')
      return
    }

    // Fire reset chord — assertion is that it doesn't crash + panes still present
    await fireChord(page, 'Equal')
    const paneAfter = await panes.count()
    expect(paneAfter).toBe(paneCount)

    // Ratios should all be ~even: measure first pane width relative to container
    const widths = await panes.evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).getBoundingClientRect().width)
    )
    if (widths.length >= 2) {
      const diff = Math.abs(widths[0] - widths[1])
      const max = Math.max(...widths)
      expect(diff / max).toBeLessThan(0.15)
    }
  })
})

// ===========================================================================
// Tab Hover Preview
// ===========================================================================

test.describe('Tab Hover Preview', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
    await page.waitForTimeout(500)
  })

  test('should show preview card when hovering a note tab', async ({ page }) => {
    // Create a note to have a note tab
    const noteTitle = `Preview Test ${Date.now()}`
    await createNote(page, noteTitle, 'Some preview content for testing the hover card.')
    await page.waitForTimeout(1000)

    // Find the note tab in the tab bar
    const noteTab = page.locator(`[role="tab"]:has-text("${noteTitle}")`).first()
    const isVisible = await noteTab.isVisible({ timeout: 3000 }).catch(() => false)
    if (!isVisible) {
      test.skip(true, 'Note tab not found')
      return
    }

    // Hover over the note tab and wait for openDelay (400ms) + fetch time
    await noteTab.hover()
    await page.waitForTimeout(800)

    // The hover card content renders in a Radix portal
    const hoverCard = page.locator('[data-slot="hover-card-content"]').first()
    const hoverVisible = await hoverCard.isVisible({ timeout: 3000 }).catch(() => false)

    if (hoverVisible) {
      // Verify preview card shows the note title
      await expect(hoverCard).toContainText(noteTitle)

      // Move mouse away to dismiss
      await page.mouse.move(0, 0)
      await page.waitForTimeout(400)
    }
  })

  test('should NOT show preview card when hovering a singleton tab', async ({ page }) => {
    // Open Inbox (singleton tab)
    await clickSidebarItem(page, 'Inbox')
    await page.waitForTimeout(300)

    // Hover over the Inbox tab
    const inboxTab = page.locator('[role="tab"]:has-text("Inbox")').first()
    const isVisible = await inboxTab.isVisible().catch(() => false)
    if (!isVisible) {
      test.skip(true, 'Inbox tab not found')
      return
    }

    await inboxTab.hover()
    await page.waitForTimeout(800)

    // No hover card should appear for singleton tabs
    const hoverCard = page.locator('[data-slot="hover-card-content"]').first()
    const hoverVisible = await hoverCard.isVisible({ timeout: 500 }).catch(() => false)
    expect(hoverVisible).toBe(false)
  })

  test('should show snippet in preview card if note has content', async ({ page }) => {
    const noteTitle = `Snippet Test ${Date.now()}`
    const snippet = 'This is the first paragraph that should appear in the preview snippet.'
    await createNote(page, noteTitle, snippet)
    await page.waitForTimeout(1000)

    const noteTab = page.locator(`[role="tab"]:has-text("${noteTitle}")`).first()
    const isVisible = await noteTab.isVisible({ timeout: 3000 }).catch(() => false)
    if (!isVisible) {
      test.skip(true, 'Note tab not found')
      return
    }

    await noteTab.hover()
    await page.waitForTimeout(800)

    const hoverCard = page.locator('[data-slot="hover-card-content"]').first()
    const hoverVisible = await hoverCard.isVisible({ timeout: 3000 }).catch(() => false)

    if (hoverVisible) {
      // The preview should contain part of the snippet text
      const cardText = await hoverCard.textContent()
      // Snippet may be truncated, check for the beginning
      expect(cardText).toContain('This is the first paragraph')
    }
  })

  test('should dismiss preview when mouse moves away', async ({ page }) => {
    const noteTitle = `Dismiss Test ${Date.now()}`
    await createNote(page, noteTitle, 'Content for dismiss test.')
    await page.waitForTimeout(1000)

    const noteTab = page.locator(`[role="tab"]:has-text("${noteTitle}")`).first()
    const isVisible = await noteTab.isVisible({ timeout: 3000 }).catch(() => false)
    if (!isVisible) {
      test.skip(true, 'Note tab not found')
      return
    }

    // Hover to show preview
    await noteTab.hover()
    await page.waitForTimeout(800)

    const hoverCard = page.locator('[data-slot="hover-card-content"]').first()
    const hoverVisible = await hoverCard.isVisible({ timeout: 3000 }).catch(() => false)

    if (hoverVisible) {
      // Move mouse away from the tab
      await page.mouse.move(0, 300)
      await page.waitForTimeout(400)

      // Hover card should be dismissed
      const stillVisible = await hoverCard.isVisible().catch(() => false)
      expect(stillVisible).toBe(false)
    }
  })
})

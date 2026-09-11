/**
 * Switch-vault shortcut E2E.
 *
 * ⌘⇧O (⌃⇧O off macOS) opens the sidebar's vault switcher from anywhere, so a
 * vault switch no longer starts with reopening the sidebar. Escape closes it
 * again without touching the active vault.
 */

import type { Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { MOD, ready } from './utils/desktop-test-helpers'

const SWITCH_VAULT = `${MOD}+Shift+O`

function picker(page: Page): Locator {
  return page.locator('[data-slot="picker-content"]')
}

test.describe('Switch vault shortcut', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page)
  })

  test('opens the vault switcher and closes it on Escape', async ({ page }) => {
    await expect(picker(page)).toHaveCount(0)

    await page.keyboard.press(SWITCH_VAULT)

    const content = picker(page).first()
    await expect(content).toBeVisible()
    await expect(content).toContainText(/vault/i)

    await page.keyboard.press('Escape')
    await expect(picker(page)).toHaveCount(0)
  })

  test('stays inert while the note editor owns the chord', async ({ page }) => {
    const editor = page.locator('[contenteditable="true"]').first()
    if ((await editor.count()) === 0) test.skip(true, 'No editor surface on the current view')

    await editor.click()
    await page.keyboard.press(SWITCH_VAULT)

    await expect(picker(page)).toHaveCount(0)
  })
})

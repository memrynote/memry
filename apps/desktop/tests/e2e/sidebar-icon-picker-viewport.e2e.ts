/**
 * Sidebar icon picker viewport clipping E2E (#1984, reopened from #801).
 *
 * #801 moved the note/folder icon picker into a Radix Popover, which fixed the
 * left/right drift but not the vertical case. Radix runs `shift` BEFORE `flip`,
 * so a bottom-placed panel that is taller than the room under a low sidebar row
 * gets flipped above the trigger afterwards with no second clamp — its tab bar,
 * the only route to the Icons and Custom tabs, ends up above the viewport top.
 *
 * The picker now opens to the side, which puts Radix's vertical `shift` on the
 * axis that overflows, and the panel is capped to the height Radix measured, so
 * the emoji grid scrolls instead of pushing the tabs off screen. Asserted in a
 * deliberately short window, which is the reporter's condition.
 */

import type { ElectronApplication, Page } from '@playwright/test'

import { test, expect } from './fixtures'
import { ready } from './utils/desktop-test-helpers'

const PICKER = 'Emoji and icon picker' // notes:menus.emoji.aria
const SHORT_WINDOW = { x: 0, y: 0, width: 1100, height: 400 }

async function resizeWindow(
  electronApp: ElectronApplication,
  bounds: typeof SHORT_WINDOW
): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }, next) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.setBounds(next)
  }, bounds)
}

async function seedNotes(page: Page, count: number): Promise<void> {
  await page.evaluate(async (total) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    for (let i = 0; i < total; i++) {
      await api.notes.create({ title: `Picker Viewport ${i}`, content: 'seed' })
    }
  }, count)
}

async function expandCollectionsSection(page: Page): Promise<void> {
  const trigger = page.locator('button[aria-label^="Collections section, "]').first()
  await trigger.waitFor({ state: 'visible', timeout: 20_000 })
  const label = (await trigger.getAttribute('aria-label')) ?? ''
  if (label.includes('collapsed')) await trigger.click()
}

test.describe('Sidebar icon picker in a short window', () => {
  test('stays fully on screen so its tabs are reachable', async ({ page, electronApp }) => {
    await ready(page)
    await seedNotes(page, 6)
    await resizeWindow(electronApp, SHORT_WINDOW)
    await expandCollectionsSection(page)

    // The lowest row is the worst case: least room below, most upward shift.
    const trigger = page.getByRole('button', { name: 'Set Icon' }).last()
    await trigger.waitFor({ state: 'visible', timeout: 20_000 })
    await trigger.click()

    const picker = page.getByRole('dialog', { name: PICKER })
    await expect(picker).toBeVisible({ timeout: 10_000 })

    const box = await picker.boundingBox()
    expect(box).not.toBeNull()
    const viewportHeight = await page.evaluate(() => window.innerHeight)
    // The regression: a shifted panel reports a negative top.
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewportHeight + 1)

    // The tabs are the thing the reporter could not reach — they must click.
    const iconsTab = picker.getByRole('button', { name: 'Icons' })
    await expect(iconsTab).toBeVisible()
    await iconsTab.click()
    await expect(picker.locator('button[title]').first()).toBeVisible({ timeout: 10_000 })
  })
})

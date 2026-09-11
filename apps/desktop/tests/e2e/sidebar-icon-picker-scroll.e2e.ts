/**
 * Sidebar icon picker survives a sidebar scroll (#1986).
 *
 * Past 100 tree items the sidebar swaps to the virtualized tree, which mounts
 * only the visible rows plus a small overscan. The icon picker is a Radix
 * Popover rendered *inside* its row, so any scroll that pushed that row out of
 * the virtual window unmounted the popover with it and the panel vanished
 * before anything was picked — intermittent, and dependent on how close the row
 * sat to the edge of the window, which is exactly what the reporter described.
 *
 * The row whose picker is open is now pinned into the virtual range, so the
 * panel stays mounted and Radix just re-anchors it.
 */

import type { Page } from '@playwright/test'

import { test, expect } from './fixtures'
import { ready } from './utils/desktop-test-helpers'

const PICKER = 'Emoji and icon picker' // notes:menus.emoji.aria
// The virtualized tree takes over at 100 items (VIRTUALIZATION_THRESHOLD).
const SEEDED_NOTES = 130

async function seedNotes(page: Page, count: number): Promise<void> {
  await page.evaluate(async (total) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    for (let i = 0; i < total; i++) {
      await api.notes.create({
        title: `Picker Scroll ${String(i).padStart(3, '0')}`,
        content: 'seed'
      })
    }
  }, count)
}

async function expandCollectionsSection(page: Page): Promise<void> {
  const trigger = page.locator('button[aria-label^="Collections section, "]').first()
  await trigger.waitFor({ state: 'visible', timeout: 20_000 })
  const label = (await trigger.getAttribute('aria-label')) ?? ''
  if (label.includes('collapsed')) await trigger.click()
}

test.describe('Sidebar icon picker in the virtualized tree', () => {
  test('stays open when the sidebar scrolls under it', async ({ page }) => {
    await ready(page)
    await seedNotes(page, SEEDED_NOTES)
    await page.reload()
    await ready(page)
    await expandCollectionsSection(page)

    const triggers = page.getByRole('button', { name: 'Set Icon' })
    await triggers.first().waitFor({ state: 'visible', timeout: 30_000 })

    const trigger = triggers.nth(5)
    await trigger.click()

    const picker = page.getByRole('dialog', { name: PICKER })
    await expect(picker).toBeVisible({ timeout: 10_000 })

    // Scroll over the sidebar, not over the panel — a stray trackpad nudge.
    const box = await trigger.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + 5, box!.y + 5)
    await page.mouse.wheel(0, 800)

    // The regression: the row left the virtual window and took the panel with it.
    await expect(picker).toBeVisible()
    await expect(picker.getByRole('button', { name: 'Icons' })).toBeVisible()
  })
})

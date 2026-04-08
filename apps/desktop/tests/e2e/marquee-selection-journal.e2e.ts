// @ts-nocheck - E2E tests in development, some vars intentionally unused
/**
 * Marquee Block Selection — Journal E2E Tests
 *
 * Verifies that the same Finder-style block marquee selection that ships
 * with the note page also works on the journal day view, since both share
 * the ContentArea / BlockNote editor.
 *
 * Companion to marquee-selection.e2e.ts (note page).
 */

import { test, expect, type Page } from './fixtures'
import { waitForAppReady, waitForVaultReady, navigateTo } from './utils/electron-helpers'

const EDITOR_CONTAINER = '.bn-container'
const EDITABLE_SELECTOR = `${EDITOR_CONTAINER} [contenteditable="true"]`
const BLOCK_SELECTOR = '.bn-block[data-id]'
const HIGHLIGHTED_SELECTOR = '.marquee-block-highlight'
const OVERLAY_SELECTOR = '.marquee-overlay'
const MARQUEE_ZONE_SELECTOR = '.marquee-zone'
const METADATA_IGNORE_SELECTOR = '[data-marquee-ignore]'

async function focusJournalEditor(page: Page) {
  const container = page.locator(EDITOR_CONTAINER).first()
  await container.waitFor({ state: 'visible', timeout: 10000 })
  const editable = page.locator(EDITABLE_SELECTOR).first()
  await editable.waitFor({ state: 'visible', timeout: 10000 })
  await editable.click()
  return editable
}

async function typeBlocks(page: Page, lines: string[]): Promise<void> {
  for (let i = 0; i < lines.length; i += 1) {
    await page.keyboard.type(lines[i])
    if (i < lines.length - 1) await page.keyboard.press('Enter')
  }
}

async function getBlockBox(page: Page, index: number) {
  const box = await page.locator(BLOCK_SELECTOR).nth(index).boundingBox()
  if (!box) throw new Error(`Block at index ${index} has no bounding box`)
  return box
}

async function getBlockCount(page: Page): Promise<number> {
  return page.locator(BLOCK_SELECTOR).count()
}

async function getMarqueeZoneBox(page: Page) {
  const box = await page.locator(MARQUEE_ZONE_SELECTOR).first().boundingBox()
  if (!box) throw new Error('marquee zone not found')
  return box
}

test.describe('Journal block marquee selection', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
    await navigateTo(page, 'journal')
    await page.waitForTimeout(500)
  })

  test('drags marquee across multiple journal blocks and highlights them', async ({ page }) => {
    await focusJournalEditor(page)
    await typeBlocks(page, [
      'Journal block one for marquee',
      'Journal block two for marquee',
      'Journal block three for marquee',
      'Journal block four for marquee'
    ])
    await page.waitForTimeout(400)

    expect(await getBlockCount(page)).toBeGreaterThanOrEqual(4)

    const first = await getBlockBox(page, 0)
    const third = await getBlockBox(page, 2)

    const startX = first.x + first.width / 2
    const startY = first.y + 4
    const endX = startX
    const endY = third.y + third.height - 4

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 14 })

    // Overlay must be visible mid-drag.
    await expect(page.locator(OVERLAY_SELECTOR)).toBeVisible({ timeout: 2000 })

    // Mid-drag: at least 3 highlight rects rendered.
    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(3)

    await page.mouse.up()
    await page.waitForTimeout(150)

    // Overlay gone after release; highlights persist.
    await expect(page.locator(OVERLAY_SELECTOR)).toHaveCount(0)
    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(3)
  })

  test('Backspace deletes marquee-selected journal blocks', async ({ page }) => {
    await focusJournalEditor(page)
    await typeBlocks(page, [
      'Journal alpha survives',
      'Journal beta will die',
      'Journal gamma will die',
      'Journal delta survives'
    ])
    await page.waitForTimeout(400)

    const startCount = await getBlockCount(page)
    expect(startCount).toBeGreaterThanOrEqual(4)

    const second = await getBlockBox(page, 1)
    const third = await getBlockBox(page, 2)

    const startX = second.x + second.width / 2
    const startY = second.y + 4
    const endX = startX
    const endY = third.y + third.height - 4

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(150)

    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(2)

    await page.keyboard.press('Backspace')
    await page.waitForTimeout(400)

    expect(await getBlockCount(page)).toBeLessThan(startCount)
  })

  test('drag starting on metadata zone does NOT trigger marquee', async ({ page }) => {
    await focusJournalEditor(page)
    await typeBlocks(page, ['Block one', 'Block two', 'Block three'])
    await page.waitForTimeout(400)

    const metadataBox = await page.locator(METADATA_IGNORE_SELECTOR).first().boundingBox()
    if (!metadataBox) throw new Error('metadata zone (data-marquee-ignore) not found')
    const first = await getBlockBox(page, 0)

    // Start inside the metadata zone (date / tags / properties strip), drag down
    // into the editor. Hook must short-circuit because target.closest matches
    // [data-marquee-ignore] at mousedown.
    const startX = metadataBox.x + metadataBox.width / 2
    const startY = metadataBox.y + Math.max(metadataBox.height / 2, 8)
    const endX = first.x + first.width / 2
    const endY = first.y + first.height - 4

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 10 })

    // No overlay mid-drag.
    await expect(page.locator(OVERLAY_SELECTOR)).toHaveCount(0)
    await expect(page.locator(HIGHLIGHTED_SELECTOR)).toHaveCount(0)

    await page.mouse.up()
    await page.waitForTimeout(150)

    await expect(page.locator(OVERLAY_SELECTOR)).toHaveCount(0)
    await expect(page.locator(HIGHLIGHTED_SELECTOR)).toHaveCount(0)
  })

  test('drag from left gutter of journal scroll area selects blocks', async ({ page }) => {
    await focusJournalEditor(page)
    await typeBlocks(page, [
      'Journal gutter block one',
      'Journal gutter block two',
      'Journal gutter block three'
    ])
    await page.waitForTimeout(400)

    const zone = await getMarqueeZoneBox(page)
    const first = await getBlockBox(page, 0)
    const last = await getBlockBox(page, 2)

    // Start at the very left edge of the marquee zone (full scroll-area width).
    const startX = zone.x + 8
    const startY = first.y + first.height / 2
    const endX = first.x + first.width / 2
    const endY = last.y + last.height - 4

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 14 })

    await expect(page.locator(OVERLAY_SELECTOR)).toBeVisible({ timeout: 2000 })
    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(2)

    await page.mouse.up()
    await page.waitForTimeout(150)

    await expect(page.locator(OVERLAY_SELECTOR)).toHaveCount(0)
  })
})

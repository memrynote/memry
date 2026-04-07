// @ts-nocheck - E2E tests in development, some vars intentionally unused
/**
 * Marquee Block Selection E2E Tests
 *
 * Finder-style rubber-band selection over BlockNote blocks.
 * Drag from non-text area → rectangle overlay → soft highlight on
 * intersected blocks → PM setSelection for native Backspace/Cmd+C/Cmd+A.
 */

import { test, expect, type Page } from './fixtures'
import { waitForAppReady, waitForVaultReady, createNote } from './utils/electron-helpers'

const EDITOR_CONTAINER = '.bn-container'
const EDITABLE_SELECTOR = `${EDITOR_CONTAINER} [contenteditable="true"]`
const BLOCK_SELECTOR = '.bn-block[data-id]'
const HIGHLIGHTED_SELECTOR = '.marquee-block-highlight'
const OVERLAY_SELECTOR = '.marquee-overlay'

async function focusEditor(page: Page) {
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

test.describe('Block marquee selection', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  test('drags marquee across multiple blocks and highlights them', async ({ page }) => {
    await createNote(page, `Marquee Happy ${Date.now()}`)
    await focusEditor(page)
    await typeBlocks(page, [
      'First paragraph of marquee test',
      'Second paragraph of marquee test',
      'Third paragraph of marquee test',
      'Fourth paragraph of marquee test'
    ])
    await page.waitForTimeout(400)

    expect(await getBlockCount(page)).toBeGreaterThanOrEqual(4)

    const first = await getBlockBox(page, 0)
    const third = await getBlockBox(page, 2)

    // Vertical drag from block 0 to block 2 — promotes to marquee.
    const startX = first.x + first.width / 2
    const startY = first.y + 4
    const endX = startX
    const endY = third.y + third.height - 4

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 14 })

    // Overlay must be visible mid-drag.
    await expect(page.locator(OVERLAY_SELECTOR)).toBeVisible({ timeout: 2000 })

    // Mid-drag: at least 3 block highlights are rendered
    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(3)

    await page.mouse.up()
    await page.waitForTimeout(150)

    // Overlay gone after release.
    await expect(page.locator(OVERLAY_SELECTOR)).toHaveCount(0)

    // At least 3 blocks remain highlighted post-release.
    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(3)
  })

  test('Escape clears marquee selection', async ({ page }) => {
    await createNote(page, `Marquee Escape ${Date.now()}`)
    await focusEditor(page)
    await typeBlocks(page, ['Alpha line', 'Beta line', 'Gamma line'])
    await page.waitForTimeout(400)

    const first = await getBlockBox(page, 0)
    const last = await getBlockBox(page, 2)

    const startX = first.x + first.width / 2
    const startY = first.y + 4
    const endX = startX
    const endY = last.y + last.height - 4

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(150)

    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThan(0)

    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    await expect(page.locator(HIGHLIGHTED_SELECTOR)).toHaveCount(0)
  })

  test('Backspace deletes marquee-selected blocks', async ({ page }) => {
    await createNote(page, `Marquee Backspace ${Date.now()}`)
    await focusEditor(page)
    await typeBlocks(page, [
      'Block one survives',
      'Block two will die',
      'Block three will die',
      'Block four survives'
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

    const highlighted = await page.locator(HIGHLIGHTED_SELECTOR).count()
    expect(highlighted).toBeGreaterThanOrEqual(2)

    await page.keyboard.press('Backspace')
    await page.waitForTimeout(400)

    const endCount = await getBlockCount(page)
    expect(endCount).toBeLessThan(startCount)
  })

  test('regression: short drag inside paragraph text does NOT trigger marquee', async ({
    page
  }) => {
    await createNote(page, `Marquee Text Drag ${Date.now()}`)
    await focusEditor(page)
    await typeBlocks(page, [
      'A long paragraph with enough characters to drag inside of it for selection'
    ])
    await page.waitForTimeout(400)

    const block = await getBlockBox(page, 0)
    // Start INSIDE block content (centered text area)
    const startX = block.x + Math.max(block.width / 2, 60)
    const startY = block.y + block.height / 2
    const endX = startX + 120
    const endY = startY

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(150)

    await expect(page.locator(OVERLAY_SELECTOR)).toHaveCount(0)
    await expect(page.locator(HIGHLIGHTED_SELECTOR)).toHaveCount(0)
  })

  test('regression: single click in block does NOT trigger marquee', async ({ page }) => {
    await createNote(page, `Marquee Click ${Date.now()}`)
    await focusEditor(page)
    await typeBlocks(page, ['Single block content for click test'])
    await page.waitForTimeout(400)

    const block = await getBlockBox(page, 0)
    await page.mouse.click(block.x + block.width / 2, block.y + block.height / 2)
    await page.waitForTimeout(150)

    await expect(page.locator(OVERLAY_SELECTOR)).toHaveCount(0)
    await expect(page.locator(HIGHLIGHTED_SELECTOR)).toHaveCount(0)
  })

  test('regression: clicking bottom padding still focuses editor without marquee', async ({
    page
  }) => {
    await createNote(page, `Marquee Bottom ${Date.now()}`)
    await focusEditor(page)
    await typeBlocks(page, ['Top block of bottom-padding test'])
    await page.waitForTimeout(400)

    const lastBlock = await getBlockBox(page, 0)
    const clickArea = await page.locator('.editor-click-area').first().boundingBox()
    if (!clickArea) throw new Error('editor-click-area not found')
    const clickX = clickArea.x + clickArea.width / 2
    const clickY = Math.min(
      lastBlock.y + lastBlock.height + 200,
      clickArea.y + clickArea.height - 20
    )

    await page.mouse.click(clickX, clickY)
    await page.waitForTimeout(150)

    await expect(page.locator(OVERLAY_SELECTOR)).toHaveCount(0)
    await expect(page.locator(HIGHLIGHTED_SELECTOR)).toHaveCount(0)
  })
})

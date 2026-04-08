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
const MARQUEE_ZONE_SELECTOR = '.marquee-zone'

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

async function getMarqueeZoneBox(page: Page) {
  const box = await page.locator(MARQUEE_ZONE_SELECTOR).first().boundingBox()
  if (!box) throw new Error('marquee zone not found')
  return box
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

  test('drags from LEFT edge of scroll area into editor and selects blocks', async ({ page }) => {
    await createNote(page, `Marquee Left Strip ${Date.now()}`)
    await focusEditor(page)
    await typeBlocks(page, [
      'First block in left-strip drag',
      'Second block in left-strip drag',
      'Third block in left-strip drag'
    ])
    await page.waitForTimeout(400)

    const zone = await getMarqueeZoneBox(page)
    const first = await getBlockBox(page, 0)
    const last = await getBlockBox(page, 2)

    // Start at the very left edge of the marquee zone (full scroll-area width).
    const startX = zone.x + 8
    const startY = first.y + first.height / 2
    // End INSIDE the editor so the marquee rectangle crosses block geometry.
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
    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(2)
  })

  test('drags from RIGHT edge of scroll area into editor and selects blocks', async ({ page }) => {
    await createNote(page, `Marquee Right Strip ${Date.now()}`)
    await focusEditor(page)
    await typeBlocks(page, [
      'First block in right-strip drag',
      'Second block in right-strip drag',
      'Third block in right-strip drag'
    ])
    await page.waitForTimeout(400)

    const zone = await getMarqueeZoneBox(page)
    const first = await getBlockBox(page, 0)
    const last = await getBlockBox(page, 2)

    // Start at the very right edge of the marquee zone (full scroll-area width).
    const startX = zone.x + zone.width - 8
    const startY = first.y + first.height / 2
    // End INSIDE the editor so the marquee rectangle crosses block geometry.
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
    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(2)
  })

  test('drags from below last block into editor and selects blocks', async ({ page }) => {
    await createNote(page, `Marquee Below Drag ${Date.now()}`)
    await focusEditor(page)
    await typeBlocks(page, [
      'First block for below drag',
      'Second block for below drag',
      'Third block for below drag'
    ])
    await page.waitForTimeout(400)

    const zone = await getMarqueeZoneBox(page)
    const first = await getBlockBox(page, 0)
    const last = await getBlockBox(page, 2)

    // Start below the last block, in the marquee zone's vertical space.
    const startX = last.x + last.width / 2
    const startY = last.y + last.height + 120
    // Drag up to cross the block geometry.
    const endX = first.x + first.width / 2
    const endY = first.y + first.height / 2

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 14 })

    await expect(page.locator(OVERLAY_SELECTOR)).toBeVisible({ timeout: 2000 })
    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(2)

    await page.mouse.up()
    await page.waitForTimeout(150)

    await expect(page.locator(OVERLAY_SELECTOR)).toHaveCount(0)
    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(2)
  })

  test('regression: single click in gray strip focuses editor without marquee', async ({
    page
  }) => {
    await createNote(page, `Marquee Strip Click ${Date.now()}`)
    await focusEditor(page)
    await typeBlocks(page, ['Only block for strip-click test'])
    await page.waitForTimeout(400)

    const zone = await getMarqueeZoneBox(page)
    const block = await getBlockBox(page, 0)

    await page.mouse.click(zone.x + 24, block.y + block.height / 2)
    await page.waitForTimeout(150)

    await expect(page.locator(OVERLAY_SELECTOR)).toHaveCount(0)
    await expect(page.locator(HIGHLIGHTED_SELECTOR)).toHaveCount(0)

    const editable = page.locator(EDITABLE_SELECTOR).first()
    await expect(editable).toBeFocused()
  })

  test('regression: click on title input does NOT start marquee or focus editor', async ({
    page
  }) => {
    await createNote(page, `Marquee Title Click ${Date.now()}`)
    await focusEditor(page)
    await typeBlocks(page, ['Only block for title-click test'])
    await page.waitForTimeout(400)

    const titleBox = await page.locator('textarea').first().boundingBox()
    if (!titleBox) throw new Error('title textarea not found')

    await page.mouse.click(titleBox.x + titleBox.width / 2, titleBox.y + titleBox.height / 2)
    await page.waitForTimeout(150)

    await expect(page.locator(OVERLAY_SELECTOR)).toHaveCount(0)
    await expect(page.locator(HIGHLIGHTED_SELECTOR)).toHaveCount(0)

    // Title textarea should be focused (not the editor).
    const titleFocused = await page.evaluate(() => {
      const active = document.activeElement
      return active instanceof HTMLTextAreaElement
    })
    expect(titleFocused).toBe(true)
  })

  test('regression: drag starting on title area does NOT promote marquee', async ({ page }) => {
    await createNote(page, `Marquee Title Drag ${Date.now()}`)
    await focusEditor(page)
    await typeBlocks(page, ['First block for title-drag test', 'Second block for title-drag test'])
    await page.waitForTimeout(400)

    const titleBox = await page.locator('textarea').first().boundingBox()
    if (!titleBox) throw new Error('title textarea not found')
    const last = await getBlockBox(page, 1)

    const startX = titleBox.x + titleBox.width / 2
    const startY = titleBox.y + titleBox.height / 2
    const endX = startX
    const endY = last.y + last.height - 4

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 14 })
    await page.mouse.up()
    await page.waitForTimeout(150)

    await expect(page.locator(OVERLAY_SELECTOR)).toHaveCount(0)
    await expect(page.locator(HIGHLIGHTED_SELECTOR)).toHaveCount(0)
  })

  test('single-block marquee → produces real editor selection (no inert state)', async ({
    page
  }) => {
    await createNote(page, `Marquee Single ${Date.now()}`)
    await focusEditor(page)
    // H1 heading is visually tall enough that a vertical drag fits
    // entirely inside ITS bounds — we want exactly ONE block captured.
    await page.keyboard.type('# ')
    const headingText = 'Tall heading for single-drag test'
    await page.keyboard.type(headingText)
    await page.keyboard.press('Enter')
    await page.keyboard.type('Second survivor block')
    await page.waitForTimeout(400)

    const startCount = await getBlockCount(page)
    expect(startCount).toBeGreaterThanOrEqual(2)

    // Start in the gutter (outside editable text so promote triggers on
    // pure vertical motion) and end just inside the heading block. The
    // rect's vertical extent stays within the heading's bounds so only
    // one block is hit.
    const zone = await getMarqueeZoneBox(page)
    const headingBox = await getBlockBox(page, 0)

    const startX = zone.x + 8
    const startY = headingBox.y + 4
    const endX = headingBox.x + Math.min(40, headingBox.width / 2)
    const endY = headingBox.y + headingBox.height - 4

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 12 })

    await expect(page.locator(OVERLAY_SELECTOR)).toBeVisible({ timeout: 2000 })
    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBe(1)

    await page.mouse.up()
    await page.waitForTimeout(200)

    // Critical regression gate: the fix must turn the visual marquee
    // highlight into a REAL editor-owned selection. Previously, single-
    // block drags left the editor blurred and the window selection
    // empty → Backspace/Cmd+C/Cmd+A did nothing (inert state).
    const selectionState = await page.evaluate(() => {
      const sel = window.getSelection()
      const active = document.activeElement
      const isEditorFocused =
        active instanceof HTMLElement && active.closest('[contenteditable="true"]') !== null
      return {
        isEditorFocused,
        hasNonCollapsedRange: sel !== null && sel.rangeCount > 0 && !sel.isCollapsed,
        selectedText: sel?.toString() ?? ''
      }
    })

    expect(selectionState.isEditorFocused).toBe(true)
    expect(selectionState.hasNonCollapsedRange).toBe(true)
    expect(selectionState.selectedText).toContain('Tall heading')
  })

  test('regression: non-editor panels carry data-marquee-ignore so gestures are skipped', async ({
    page
  }) => {
    // Pure DOM assertion — both the marquee hook (shouldStartMarquee)
    // and the focus-at-end handler bail out on target.closest(
    // '[data-marquee-ignore]'). So verifying the attribute is on the
    // backlinks/linked-tasks wrapper is sufficient to prove non-editor
    // panels are excluded from both pathways. BacklinksSection and
    // LinkedTasksSection both return null when empty, so a click test
    // against the empty wrapper would be a false positive — the
    // attribute check is the reliable regression gate.
    await createNote(page, `Marquee Ignore Attr ${Date.now()}`)
    await focusEditor(page)
    await typeBlocks(page, ['Only block for ignore-attribute test'])
    await page.waitForTimeout(400)

    const attrs = await page.evaluate(() => {
      const editorClickArea = document.querySelector('.editor-click-area')
      if (!editorClickArea) return { hasEditorArea: false }

      let cursor: Element | null = editorClickArea.nextElementSibling
      const nonEditorSiblings: Array<{
        tag: string
        classes: string
        hasMarqueeIgnore: boolean
      }> = []
      while (cursor) {
        nonEditorSiblings.push({
          tag: cursor.tagName.toLowerCase(),
          classes: cursor.className,
          hasMarqueeIgnore: cursor.hasAttribute('data-marquee-ignore')
        })
        cursor = cursor.nextElementSibling
      }
      return { hasEditorArea: true, nonEditorSiblings }
    })

    expect(attrs.hasEditorArea).toBe(true)
    expect(attrs.nonEditorSiblings).toBeDefined()
    // Every non-editor sibling rendered beneath the editor must carry
    // data-marquee-ignore — gaps let graph/backlinks/tasks hijack the
    // marquee + focus-at-end paths.
    for (const sibling of attrs.nonEditorSiblings ?? []) {
      expect(sibling.hasMarqueeIgnore).toBe(true)
    }
  })

  // --- Tab / Shift+Tab indent/outdent on marquee selections ---------------
  // BlockNote nests blocks by wrapping them in a .bn-block-group inside
  // their parent block, so depth = count of .bn-block-group ancestors
  // between the block and the .bn-container. A root-level block has
  // depth 1; each indent level adds one.
  async function createBulletList(page: Page, items: string[]): Promise<void> {
    // "- " auto-converts the current paragraph into a bullet list item,
    // and subsequent Enter preserves the list. We only prefix the first.
    await page.keyboard.type('- ')
    for (let i = 0; i < items.length; i += 1) {
      await page.keyboard.type(items[i])
      if (i < items.length - 1) await page.keyboard.press('Enter')
    }
    await page.waitForTimeout(250)
  }

  async function blockDepth(page: Page, index: number): Promise<number> {
    return page.evaluate((idx) => {
      const blocks = document.querySelectorAll('.bn-container .bn-block[data-id]')
      const block = blocks[idx]
      if (!block) return -1
      let depth = 0
      let cursor: Element | null = block.parentElement
      while (cursor && !cursor.classList.contains('bn-container')) {
        if (cursor.classList.contains('bn-block-group')) depth += 1
        cursor = cursor.parentElement
      }
      return depth
    }, index)
  }

  async function marqueeSelectBlocks(page: Page, fromIndex: number, toIndex: number) {
    const from = await getBlockBox(page, fromIndex)
    const to = await getBlockBox(page, toIndex)
    const startX = from.x + from.width / 2
    const startY = from.y + 4
    const endX = startX
    const endY = to.y + to.height - 4
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 14 })
    await page.mouse.up()
    await page.waitForTimeout(200)
  }

  test('Tab indents all marquee-selected bullet items as flat siblings', async ({ page }) => {
    await createNote(page, `Marquee Tab Indent ${Date.now()}`)
    await focusEditor(page)
    await createBulletList(page, ['alpha', 'bravo', 'charlie', 'delta'])

    expect(await getBlockCount(page)).toBeGreaterThanOrEqual(4)

    // Baseline: all four at depth 1 (top-level bullets).
    expect(await blockDepth(page, 0)).toBe(1)
    expect(await blockDepth(page, 1)).toBe(1)
    expect(await blockDepth(page, 2)).toBe(1)
    expect(await blockDepth(page, 3)).toBe(1)

    // Marquee-select bravo + charlie (middle two).
    await marqueeSelectBlocks(page, 1, 2)
    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(2)

    // Tab → both indent. Forward-order loop means bravo sinks under alpha
    // first, then charlie's previous sibling becomes alpha (now holding
    // bravo), so charlie joins as a flat sibling of bravo under alpha.
    // Result: alpha holds [bravo, charlie]; delta stays at root.
    await page.keyboard.press('Tab')
    await page.waitForTimeout(250)

    // bravo and charlie are now at depth 2 (inside alpha's child group).
    expect(await blockDepth(page, 1)).toBe(2)
    expect(await blockDepth(page, 2)).toBe(2)
    // alpha and delta stay at root.
    expect(await blockDepth(page, 0)).toBe(1)
    expect(await blockDepth(page, 3)).toBe(1)

    // Marquee selection persists across indent so user can keep tabbing.
    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(2)
  })

  test('Shift+Tab outdents all marquee-selected blocks back to root', async ({ page }) => {
    await createNote(page, `Marquee Shift Tab ${Date.now()}`)
    await focusEditor(page)
    await createBulletList(page, ['root', 'child-a', 'child-b'])

    // Set up nested baseline via the marquee-Tab path we're testing
    // against: marquee-select the two children and Tab them to nest
    // both under root as flat siblings. Using single-cursor Tab here
    // doesn't work — nesting child-a first changes the tree shape so
    // the second Tab would over-nest. Test 15 already proves the
    // marquee-Tab indent path itself.
    await marqueeSelectBlocks(page, 1, 2)
    await page.keyboard.press('Tab')
    await page.waitForTimeout(250)

    // Sanity: child-a and child-b nested under root as flat siblings.
    expect(await blockDepth(page, 0)).toBe(1)
    expect(await blockDepth(page, 1)).toBe(2)
    expect(await blockDepth(page, 2)).toBe(2)

    // Re-select both nested children (the marquee persisted through
    // Tab, but re-selecting keeps this test independent of that claim).
    await marqueeSelectBlocks(page, 1, 2)
    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(2)

    // Shift+Tab → both outdent. Reverse-order loop unnests child-b
    // first (drops after root holding child-a), then child-a (drops
    // after root), yielding [root, child-a, child-b] all at depth 1.
    await page.keyboard.press('Shift+Tab')
    await page.waitForTimeout(250)

    expect(await blockDepth(page, 0)).toBe(1)
    expect(await blockDepth(page, 1)).toBe(1)
    expect(await blockDepth(page, 2)).toBe(1)

    // Marquee still alive.
    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(2)
  })

  test('repeated Tab walks marquee selection deeper each press', async ({ page }) => {
    await createNote(page, `Marquee Repeat Tab ${Date.now()}`)
    await focusEditor(page)
    await createBulletList(page, ['parent', 'one', 'two'])

    // Marquee-select the two children.
    await marqueeSelectBlocks(page, 1, 2)

    await page.keyboard.press('Tab')
    await page.waitForTimeout(250)
    expect(await blockDepth(page, 1)).toBe(2)
    expect(await blockDepth(page, 2)).toBe(2)

    // Second Tab press — marquee must still be alive for this to work.
    // Note: once "one" is nested under "parent", "two" is a sibling of
    // "one" inside parent's group, so another Tab nests "two" under "one"
    // (canNestBlock=true for "two"). "one" has no previous sibling at
    // its new level → canNestBlock=false → silently stays put.
    // Repeated Tab is idempotent-safe for the no-op case.
    await page.keyboard.press('Tab')
    await page.waitForTimeout(250)

    // "one" stayed at depth 2 (first child of its group — can't nest further).
    expect(await blockDepth(page, 1)).toBe(2)
    // "two" now at depth 3 (nested inside "one").
    expect(await blockDepth(page, 2)).toBe(3)
  })

  test('Shift+Tab at root level is a safe no-op that preserves selection', async ({ page }) => {
    await createNote(page, `Marquee Shift Tab Root ${Date.now()}`)
    await focusEditor(page)
    await createBulletList(page, ['one', 'two', 'three'])

    await marqueeSelectBlocks(page, 0, 2)
    const beforeHighlights = await page.locator(HIGHLIGHTED_SELECTOR).count()
    expect(beforeHighlights).toBeGreaterThanOrEqual(3)

    await page.keyboard.press('Shift+Tab')
    await page.waitForTimeout(250)

    // All still at depth 1 — canUnnestBlock=false at root → silent skip.
    expect(await blockDepth(page, 0)).toBe(1)
    expect(await blockDepth(page, 1)).toBe(1)
    expect(await blockDepth(page, 2)).toBe(1)

    // Marquee survives.
    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(3)
  })
})

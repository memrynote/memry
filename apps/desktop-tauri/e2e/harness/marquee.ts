// Pointer and key gestures of the editor's marquee and table specs, ported from Electron's
// `utils/marquee-helpers.ts` and the `marquee-*.e2e.ts` drags (Step 14k, #3531).
import type { Page } from './pw-compat/page'

export const BLOCK = '.bn-block[data-id]'
export const HIGHLIGHT = '.marquee-block-highlight'
export const OVERLAY = '.marquee-overlay'
export const MARQUEE_ZONE = '.marquee-zone'

interface Point {
  x: number
  y: number
}

/** Moves the pointer to `to` in `steps` moves, as Playwright's `mouse.move(x, y, { steps })`. */
export async function glide(page: Page, to: Point, steps: number): Promise<void> {
  const from = { x: page.core.mouseX, y: page.core.mouseY }
  for (let step = 1; step <= steps; step++) {
    const t = step / steps
    await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t)
  }
}

/** Presses at `from`, glides to `to` and releases there. */
export async function drag(page: Page, from: Point, to: Point, steps = 14): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await glide(page, to, steps)
  await page.mouse.up()
}

/**
 * A key with modifiers held, as a synthetic keydown and keyup on the focused element.
 * tauri-plugin-wdio-webdriver 1.5.0 sends held modifiers only with character keys, so
 * `press('Shift+Tab')` or `press('Meta+Shift+Enter')` reaches the page without them.
 */
export const pressWithModifiers = (
  page: Page,
  key: 'Tab' | 'Enter',
  modifiers: { shift?: boolean; mod?: boolean }
): Promise<void> =>
  page.evaluate(
    ({ name, shift, mod }: { name: string; shift: boolean; mod: boolean }) => {
      const mac = navigator.platform.toLowerCase().includes('mac')
      const init = {
        key: name,
        code: name,
        keyCode: name === 'Tab' ? 9 : 13,
        shiftKey: shift,
        metaKey: mod && mac,
        ctrlKey: mod && !mac
      }
      const target = document.activeElement ?? document.body
      target.dispatchEvent(
        new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })
      )
      target.dispatchEvent(new KeyboardEvent('keyup', { ...init, bubbles: true, cancelable: true }))
    },
    { name: key, shift: modifiers.shift === true, mod: modifiers.mod === true }
  )

export async function blockBox(page: Page, index: number) {
  const box = await page.locator(BLOCK).nth(index).boundingBox()
  if (!box) throw new Error(`block ${index} has no bounding box`)
  return box
}

export async function zoneBox(page: Page) {
  const box = await page.locator(MARQUEE_ZONE).first().boundingBox()
  if (!box) throw new Error('marquee zone has no bounding box')
  return box
}

export const blockCount = (page: Page): Promise<number> => page.locator(BLOCK).count()
export const highlightCount = (page: Page): Promise<number> => page.locator(HIGHLIGHT).count()

/**
 * An x in the margin beside the text column, next to block `index`. A drag meant to select blocks
 * starts outside text; one that starts in a block's text selects text. Electron aims at the
 * margin's middle; in the 1440 px e2e window that is where the block's side menu appears once the
 * pointer arrives, and a press on its drag handle drags the block. So the press lands 12 px into
 * the zone, clear of the handle, as `editor-block-type-select` does.
 */
export async function marqueeGutterX(page: Page, index = 0): Promise<number> {
  const zone = await zoneBox(page)
  const block = await blockBox(page, index)
  const gutter = block.x - zone.x
  // A narrower margin leaves nothing to aim at: the drag would start in text.
  if (gutter < 24) throw new Error(`marquee margin is ${gutter.toFixed(1)}px, need 24px`)
  return zone.x + 12
}

/** A marquee from the margin beside block `from` to the bottom of block `to`, released. */
export async function marqueeAcross(page: Page, from: number, to: number): Promise<void> {
  const first = await blockBox(page, from)
  const last = await blockBox(page, to)
  await drag(
    page,
    { x: await marqueeGutterX(page, from), y: first.y + 4 },
    { x: first.x + Math.min(40, first.width / 2), y: last.y + last.height - 4 }
  )
  await page.waitForTimeout(150)
}

/** Whether the page holds a non-collapsed native text selection, and its text. */
export const nativeSelection = (page: Page) =>
  page.evaluate(() => {
    const selection = window.getSelection()
    return {
      ranged: selection !== null && selection.rangeCount > 0 && !selection.isCollapsed,
      text: selection?.toString() ?? ''
    }
  })

// The block marquee on the journal's day, ported from Electron's `marquee-selection-journal.e2e.ts`
// (Step 14k, #3531). The day shares the note's ContentArea editor, so the same drags select its
// blocks, and a drag from the day's metadata strip (`[data-marquee-ignore]`) starts none. Blocks
// are seeded through the editor: WebDriver key actions put no text into WKWebView's editor.
import { navigateTo } from '../../harness/app-helpers'
import { glide, paragraphs, setBlocks } from '../../harness/editor'
import {
  HIGHLIGHT,
  OVERLAY,
  blockBox,
  blockCount,
  highlightCount,
  marqueeGutterX,
  nativeSelection
} from '../../harness/marquee'
import { vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'

/** The day's editor once its day has loaded: the one shown while it loads takes no input. */
const DAY_EDITOR = '.bn-editor[contenteditable="true"]'

async function openDay(page: Page, lines: string[]): Promise<void> {
  await vaultOpen(page)
  await navigateTo(page, 'journal')
  await expect(page.locator(DAY_EDITOR).first()).toBeVisible({ timeout: 15_000 })
  await page.locator(DAY_EDITOR).first().click()
  await page.waitForFunction(
    () => Boolean((window as unknown as { __memryActiveEditor?: unknown }).__memryActiveEditor),
    undefined,
    { timeout: 15_000 }
  )
  await setBlocks(page, paragraphs(lines), lines.length - 1)
  await expect.poll(() => blockCount(page)).toBeGreaterThan(lines.length - 1)
}

/** Presses in the margin beside block `from` and glides to `end` without releasing. */
async function pressAndGlide(page: Page, from: number, end: { x: number; y: number }) {
  const first = await blockBox(page, from)
  await page.mouse.move(await marqueeGutterX(page, from), first.y + 4)
  await page.mouse.down()
  await glide(page, end, 14)
}

test('drags a marquee across journal blocks and highlights them', async ({ page }) => {
  await openDay(page, [
    'Journal block one for marquee',
    'Journal block two for marquee',
    'Journal block three for marquee',
    'Journal block four for marquee'
  ])
  const first = await blockBox(page, 0)
  const third = await blockBox(page, 2)

  await pressAndGlide(page, 0, { x: first.x + first.width / 2, y: third.y + third.height - 4 })
  await expect(page.locator(OVERLAY)).toBeVisible({ timeout: 2000 })
  expect(await highlightCount(page)).toBeGreaterThanOrEqual(3)

  await page.mouse.up()
  await expect(page.locator(OVERLAY)).toHaveCount(0)
  expect(await highlightCount(page)).toBeGreaterThanOrEqual(3)
  expect(await nativeSelection(page)).toEqual({ ranged: false, text: '' })
})

test('Backspace deletes the marquee-selected journal blocks', async ({ page }) => {
  await openDay(page, [
    'Journal alpha survives',
    'Journal beta will die',
    'Journal gamma will die',
    'Journal delta survives'
  ])
  const start = await blockCount(page)
  const second = await blockBox(page, 1)
  const third = await blockBox(page, 2)

  await pressAndGlide(page, 1, { x: second.x + second.width / 2, y: third.y + third.height - 4 })
  await page.mouse.up()
  await page.waitForTimeout(150)
  expect(await highlightCount(page)).toBeGreaterThanOrEqual(2)

  await page.keyboard.press('Backspace')
  await expect.poll(async () => (await blockCount(page)) < start).toBe(true)
  await expect(page.locator(DAY_EDITOR).first()).not.toContainText('will die')
})

test('a drag that starts on the metadata strip starts no marquee', async ({ page }) => {
  await openDay(page, ['Block one', 'Block two', 'Block three'])
  const metadata = await page.locator('[data-marquee-ignore]').first().boundingBox()
  if (!metadata) throw new Error('metadata zone (data-marquee-ignore) not found')
  const first = await blockBox(page, 0)

  await page.mouse.move(
    metadata.x + metadata.width / 2,
    metadata.y + Math.max(metadata.height / 2, 8)
  )
  await page.mouse.down()
  await glide(page, { x: first.x + first.width / 2, y: first.y + first.height - 4 }, 10)
  await expect(page.locator(OVERLAY)).toHaveCount(0)
  await expect(page.locator(HIGHLIGHT)).toHaveCount(0)

  await page.mouse.up()
  await page.waitForTimeout(150)
  await expect(page.locator(OVERLAY)).toHaveCount(0)
  await expect(page.locator(HIGHLIGHT)).toHaveCount(0)
})

test('a drag from the margin beside the day selects blocks', async ({ page }) => {
  await openDay(page, [
    'Journal gutter block one',
    'Journal gutter block two',
    'Journal gutter block three'
  ])
  const first = await blockBox(page, 0)
  const last = await blockBox(page, 2)

  await page.mouse.move(await marqueeGutterX(page, 0), first.y + first.height / 2)
  await page.mouse.down()
  await glide(page, { x: first.x + 2, y: last.y + last.height - 4 }, 14)
  await expect(page.locator(OVERLAY)).toBeVisible({ timeout: 2000 })
  expect(await highlightCount(page)).toBeGreaterThanOrEqual(2)

  await page.mouse.up()
  await expect(page.locator(OVERLAY)).toHaveCount(0)
})

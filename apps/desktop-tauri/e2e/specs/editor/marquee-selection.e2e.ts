// Finder-style rubber-band selection over a note's blocks, ported from Electron's
// `marquee-selection.e2e.ts` (Step 14k, #3531): a drag from outside the text draws the overlay and
// highlights the blocks it crosses, keys act on them, and drags or clicks in text never start it.
// Blocks are seeded through the editor rather than typed: WebDriver key actions put no text into
// WKWebView's contenteditable, and the gestures under test start once the blocks exist.
import { glide, openNewNote, paragraphs, setBlocks } from '../../harness/editor'
import {
  HIGHLIGHT,
  OVERLAY,
  blockBox,
  blockCount,
  drag,
  highlightCount,
  marqueeGutterX,
  nativeSelection,
  pressWithModifiers,
  zoneBox
} from '../../harness/marquee'
import { NOTE_EDITOR, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'

const label = (name: string): string => `${name} ${Date.now().toString(36)}`

async function openWith(page: Page, name: string, blocks: unknown[]): Promise<void> {
  await vaultOpen(page)
  await openNewNote(page, label(name), 'seed')
  await setBlocks(page, blocks, blocks.length - 1)
  await expect.poll(() => blockCount(page)).toBeGreaterThan(blocks.length - 1)
}

const openLines = (page: Page, name: string, lines: string[]): Promise<void> =>
  openWith(page, name, paragraphs(lines))

const bullets = (items: string[]): unknown[] =>
  items.map((text) => ({ type: 'bulletListItem', content: text }))

/** Presses in the margin beside block `from`, glides into the middle of block `to`'s bottom. */
async function pressAndGlide(page: Page, from: number, to: number, startY?: number) {
  const first = await blockBox(page, from)
  const last = await blockBox(page, to)
  await page.mouse.move(await marqueeGutterX(page, from), startY ?? first.y + 4)
  await page.mouse.down()
  await glide(page, { x: first.x + first.width / 2, y: last.y + last.height - 4 }, 14)
}

async function marqueeSelect(page: Page, from: number, to: number): Promise<void> {
  await pressAndGlide(page, from, to)
  await page.mouse.up()
  await page.waitForTimeout(200)
}

/** How many `.bn-block-group`s hold block `index`: 1 at the root, one more per nesting level. */
const blockDepth = (page: Page, index: number): Promise<number> =>
  page.evaluate((at: number) => {
    const block = document.querySelectorAll('.bn-container .bn-block[data-id]')[at]
    if (!block) return -1
    let depth = 0
    for (
      let cursor = block.parentElement;
      cursor && !cursor.classList.contains('bn-container');
      cursor = cursor.parentElement
    ) {
      if (cursor.classList.contains('bn-block-group')) depth += 1
    }
    return depth
  }, index)

const depths = async (page: Page, count: number): Promise<number[]> => {
  const out: number[] = []
  for (let index = 0; index < count; index++) out.push(await blockDepth(page, index))
  return out
}

async function expectNoMarquee(page: Page): Promise<void> {
  await expect(page.locator(OVERLAY)).toHaveCount(0)
  await expect(page.locator(HIGHLIGHT)).toHaveCount(0)
}

test('drags a marquee across blocks and highlights them', async ({ page }) => {
  await openLines(page, 'Marquee Happy', [
    'First paragraph of marquee test',
    'Second paragraph of marquee test',
    'Third paragraph of marquee test',
    'Fourth paragraph of marquee test'
  ])

  await pressAndGlide(page, 0, 2)
  await expect(page.locator(OVERLAY)).toBeVisible({ timeout: 2000 })
  expect(await highlightCount(page)).toBeGreaterThanOrEqual(3)

  await page.mouse.up()
  await expect(page.locator(OVERLAY)).toHaveCount(0)
  expect(await highlightCount(page)).toBeGreaterThanOrEqual(3)
  expect(await nativeSelection(page)).toEqual({ ranged: false, text: '' })
})

test('Escape clears the marquee selection', async ({ page }) => {
  await openLines(page, 'Marquee Escape', ['Alpha line', 'Beta line', 'Gamma line'])
  await marqueeSelect(page, 0, 2)
  expect(await highlightCount(page)).toBeGreaterThan(0)

  await page.keyboard.press('Escape')
  await expect(page.locator(HIGHLIGHT)).toHaveCount(0)
})

test('Backspace deletes the marquee-selected blocks', async ({ page }) => {
  await openLines(page, 'Marquee Backspace', [
    'Block one survives',
    'Block two will die',
    'Block three will die',
    'Block four survives'
  ])
  const start = await blockCount(page)

  await marqueeSelect(page, 1, 2)
  expect(await highlightCount(page)).toBeGreaterThanOrEqual(2)

  await page.keyboard.press('Backspace')
  await expect.poll(async () => (await blockCount(page)) < start).toBe(true)
  await expect(page.locator(NOTE_EDITOR)).not.toContainText('will die')
  await expect(page.locator(NOTE_EDITOR)).toContainText('Block four survives')
})

test('a short drag inside paragraph text starts no marquee', async ({ page }) => {
  await openLines(page, 'Marquee Text Drag', [
    'A long paragraph with enough characters to drag inside of it for selection'
  ])
  const block = await blockBox(page, 0)
  const start = { x: block.x + Math.max(block.width / 2, 60), y: block.y + block.height / 2 }
  await drag(page, start, { x: start.x + 120, y: start.y }, 8)
  await page.waitForTimeout(150)
  await expectNoMarquee(page)
})

// #1441: pressing inside a line and dragging straight down flipped into a block selection. The
// drag makes no native text selection here (the driver's pointer events are synthetic), so this
// pins the half that was the bug: no marquee.
test('a vertical drag inside text never selects blocks', async ({ page }) => {
  await openLines(page, 'Marquee Vertical Text', [
    'First paragraph of the vertical drag regression',
    'Second paragraph of the vertical drag regression',
    'Third paragraph of the vertical drag regression'
  ])
  const first = await blockBox(page, 0)
  const third = await blockBox(page, 2)
  const x = first.x + Math.min(60, first.width / 2)
  await drag(page, { x, y: first.y + first.height / 2 }, { x, y: third.y + third.height / 2 })
  await page.waitForTimeout(150)
  await expectNoMarquee(page)
})

test('a single click in a block starts no marquee', async ({ page }) => {
  await openLines(page, 'Marquee Click', ['Single block content for click test'])
  const block = await blockBox(page, 0)
  await page.mouse.click(block.x + block.width / 2, block.y + block.height / 2)
  await page.waitForTimeout(150)
  await expectNoMarquee(page)
})

test('a click in the bottom padding starts no marquee', async ({ page }) => {
  await openLines(page, 'Marquee Bottom', ['Top block of bottom-padding test'])
  const last = await blockBox(page, 0)
  const area = await page.locator('.editor-click-area').first().boundingBox()
  if (!area) throw new Error('editor-click-area not found')
  await page.mouse.click(
    area.x + area.width / 2,
    Math.min(last.y + last.height + 200, area.y + area.height - 20)
  )
  await page.waitForTimeout(150)
  await expectNoMarquee(page)
})

for (const edge of ['left', 'right'] as const) {
  test(`a drag from the ${edge} edge of the scroll area selects blocks`, async ({ page }) => {
    await openLines(page, `Marquee ${edge} Strip`, [
      `First block in ${edge}-strip drag`,
      `Second block in ${edge}-strip drag`,
      `Third block in ${edge}-strip drag`
    ])
    const zone = await zoneBox(page)
    const first = await blockBox(page, 0)
    const last = await blockBox(page, 2)

    await page.mouse.move(
      edge === 'left' ? zone.x + 8 : zone.x + zone.width - 8,
      first.y + first.height / 2
    )
    await page.mouse.down()
    await glide(page, { x: first.x + first.width / 2, y: last.y + last.height - 4 }, 14)
    await expect(page.locator(OVERLAY)).toBeVisible({ timeout: 2000 })
    expect(await highlightCount(page)).toBeGreaterThanOrEqual(2)

    await page.mouse.up()
    await expect(page.locator(OVERLAY)).toHaveCount(0)
    expect(await highlightCount(page)).toBeGreaterThanOrEqual(2)
  })
}

test('a drag from below the last block selects blocks', async ({ page }) => {
  await openLines(page, 'Marquee Below Drag', [
    'First block for below drag',
    'Second block for below drag',
    'Third block for below drag'
  ])
  const first = await blockBox(page, 0)
  const last = await blockBox(page, 2)

  await page.mouse.move(last.x + last.width / 2, last.y + last.height + 120)
  await page.mouse.down()
  await glide(page, { x: first.x + first.width / 2, y: first.y + first.height / 2 }, 14)
  await expect(page.locator(OVERLAY)).toBeVisible({ timeout: 2000 })
  expect(await highlightCount(page)).toBeGreaterThanOrEqual(2)

  await page.mouse.up()
  await expect(page.locator(OVERLAY)).toHaveCount(0)
  expect(await highlightCount(page)).toBeGreaterThanOrEqual(2)
})

test('a click in the gray strip focuses the editor without a marquee', async ({ page }) => {
  await openLines(page, 'Marquee Strip Click', ['Only block for strip-click test'])
  const zone = await zoneBox(page)
  const block = await blockBox(page, 0)
  await page.mouse.click(zone.x + 24, block.y + block.height / 2)
  await page.waitForTimeout(150)
  await expectNoMarquee(page)
  await expect(page.locator(NOTE_EDITOR).first()).toBeFocused()
})

test('a click on the title focuses the title and starts no marquee', async ({ page }) => {
  await openLines(page, 'Marquee Title Click', ['Only block for title-click test'])
  const title = await page.locator('textarea').first().boundingBox()
  if (!title) throw new Error('title textarea not found')
  await page.mouse.click(title.x + title.width / 2, title.y + title.height / 2)
  await page.waitForTimeout(150)
  await expectNoMarquee(page)
  expect(await page.evaluate(() => document.activeElement instanceof HTMLTextAreaElement)).toBe(
    true
  )
})

test('a drag that starts on the title starts no marquee', async ({ page }) => {
  await openLines(page, 'Marquee Title Drag', [
    'First block for title-drag test',
    'Second block for title-drag test'
  ])
  const title = await page.locator('textarea').first().boundingBox()
  if (!title) throw new Error('title textarea not found')
  const last = await blockBox(page, 1)
  const x = title.x + title.width / 2
  await drag(page, { x, y: title.y + title.height / 2 }, { x, y: last.y + last.height - 4 })
  await page.waitForTimeout(150)
  await expectNoMarquee(page)
})

test('a one-block marquee selects the block, not its text', async ({ page }) => {
  // A heading is tall enough for a vertical drag to stay inside it, so exactly one block is hit.
  await openWith(page, 'Marquee Single', [
    { type: 'heading', props: { level: 1 }, content: 'Tall heading for single-drag test' },
    { type: 'paragraph', content: 'Second survivor block' }
  ])
  const start = await blockCount(page)
  const zone = await zoneBox(page)
  const heading = await blockBox(page, 0)

  await page.mouse.move(zone.x + 8, heading.y + 4)
  await page.mouse.down()
  await glide(
    page,
    { x: heading.x + Math.min(40, heading.width / 2), y: heading.y + heading.height - 4 },
    12
  )
  await expect(page.locator(OVERLAY)).toBeVisible({ timeout: 2000 })
  expect(await highlightCount(page)).toBe(1)

  await page.mouse.up()
  await page.waitForTimeout(200)
  expect(await highlightCount(page)).toBe(1)
  expect(await nativeSelection(page)).toEqual({ ranged: false, text: '' })

  await page.keyboard.press('Backspace')
  await expect.poll(async () => (await blockCount(page)) < start).toBe(true)
})

// Both the marquee hook and the focus-at-end handler skip a target inside `[data-marquee-ignore]`,
// so every panel rendered below the editor carries it. The panels render nothing while empty,
// which is why the attribute and not a click is the gate.
test('every panel below the editor carries data-marquee-ignore', async ({ page }) => {
  await openLines(page, 'Marquee Ignore Attr', ['Only block for ignore-attribute test'])
  const siblings = await page.evaluate(() => {
    const area = document.querySelector('.editor-click-area')
    if (!area) return null
    const out: Array<{ tag: string; ignored: boolean }> = []
    for (let next = area.nextElementSibling; next; next = next.nextElementSibling) {
      out.push({
        tag: next.tagName.toLowerCase(),
        ignored: next.hasAttribute('data-marquee-ignore')
      })
    }
    return out
  })
  expect(siblings).not.toBeNull()
  for (const sibling of siblings ?? []) expect(sibling).toEqual({ ...sibling, ignored: true })
})

test('Tab indents every marquee-selected bullet as flat siblings', async ({ page }) => {
  await openWith(page, 'Marquee Tab Indent', bullets(['alpha', 'bravo', 'charlie', 'delta']))
  expect(await depths(page, 4)).toEqual([1, 1, 1, 1])

  await marqueeSelect(page, 1, 2)
  expect(await highlightCount(page)).toBeGreaterThanOrEqual(2)

  // bravo sinks under alpha, then charlie joins it as a sibling; delta stays at the root.
  await page.keyboard.press('Tab')
  await expect.poll(() => depths(page, 4)).toEqual([1, 2, 2, 1])
  // The selection survives, so the user can keep tabbing.
  expect(await highlightCount(page)).toBeGreaterThanOrEqual(2)
})

test('Shift+Tab outdents every marquee-selected block back to the root', async ({ page }) => {
  await openWith(page, 'Marquee Shift Tab', bullets(['root', 'child-a', 'child-b']))
  await marqueeSelect(page, 1, 2)
  await page.keyboard.press('Tab')
  await expect.poll(() => depths(page, 3)).toEqual([1, 2, 2])

  await marqueeSelect(page, 1, 2)
  expect(await highlightCount(page)).toBeGreaterThanOrEqual(2)
  await pressWithModifiers(page, 'Tab', { shift: true })
  await expect.poll(() => depths(page, 3)).toEqual([1, 1, 1])
  expect(await highlightCount(page)).toBeGreaterThanOrEqual(2)
})

test('a second Tab walks the marquee selection deeper', async ({ page }) => {
  await openWith(page, 'Marquee Repeat Tab', bullets(['parent', 'one', 'two']))
  await marqueeSelect(page, 1, 2)

  await page.keyboard.press('Tab')
  await expect.poll(() => depths(page, 3)).toEqual([1, 2, 2])
  // "one" is now the first child of its group and cannot nest; "two" nests under it.
  await page.keyboard.press('Tab')
  await expect.poll(() => depths(page, 3)).toEqual([1, 2, 3])
})

test('Shift+Tab at the root changes nothing and keeps the selection', async ({ page }) => {
  await openWith(page, 'Marquee Shift Tab Root', bullets(['one', 'two', 'three']))
  await marqueeSelect(page, 0, 2)
  expect(await highlightCount(page)).toBeGreaterThanOrEqual(3)

  await pressWithModifiers(page, 'Tab', { shift: true })
  await page.waitForTimeout(250)
  expect(await depths(page, 3)).toEqual([1, 1, 1])
  expect(await highlightCount(page)).toBeGreaterThanOrEqual(3)
})

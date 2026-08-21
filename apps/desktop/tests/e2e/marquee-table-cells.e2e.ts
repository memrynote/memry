/**
 * Dragging across table cells must select cells, not the table.
 *
 * The reported symptom: dragging from one cell to another highlighted the cells
 * but also ran the block marquee, and because a table is a single block the
 * marquee took the whole table. Backspace then deleted the table instead of the
 * cells' contents.
 *
 * This lives in E2E because the gesture is the bug. The predicate underneath is
 * covered in `marquee-hit-test.integration.test.ts`, but only a real drag over
 * real geometry shows what the two selections do when they compete — jsdom has
 * no layout, so every `boundingBox()` here would be zero.
 */

import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'
import { openNoteByTitle } from './utils/note-sync-helpers'
import { marqueeGutterX } from './utils/marquee-helpers'

const EDITABLE_SELECTOR = '.bn-container [contenteditable="true"]'
const HIGHLIGHTED_SELECTOR = '.marquee-block-highlight'

const TABLE_NOTE_BODY = [
  'Intro',
  '',
  '| Task    | Owner  |',
  '| ------- | ------ |',
  '| Ship it | Kaan   |',
  '| Review  | Nobody |',
  ''
].join('\n')

async function seedTableNote(page: Page, title: string): Promise<string> {
  const created = await page.evaluate(
    async ({ t, c }) => window.api.notes.create({ title: t, content: c }),
    { t: title, c: TABLE_NOTE_BODY }
  )
  const id = created?.note?.id
  if (!id) throw new Error(`could not seed "${title}"`)
  return id
}

/** The table's cells as plain strings, row by row — `null` when it is gone. */
async function tableCells(page: Page): Promise<string[][] | null> {
  return page.evaluate(() => {
    const editor = (window as any).__memryEditor
    if (!editor) return null
    const table = editor.document.find((block: any) => block.type === 'table')
    if (!table) return null
    return table.content.rows.map((row: any) =>
      row.cells.map((cell: any) =>
        (cell.content ?? [])
          .map((inline: any) => (inline.type === 'text' ? inline.text : `<${inline.type}>`))
          .join('')
      )
    )
  })
}

async function openTableNote(page: Page, title: string): Promise<void> {
  await openNoteByTitle(page, title)
  await page.locator(EDITABLE_SELECTOR).first().waitFor({ state: 'visible', timeout: 20_000 })
  await expect
    .poll(() => tableCells(page), { timeout: 20_000 })
    .toEqual([
      ['Task', 'Owner'],
      ['Ship it', 'Kaan'],
      ['Review', 'Nobody']
    ])
}

function cell(page: Page, text: string) {
  return page
    .locator(`${EDITABLE_SELECTOR} td, ${EDITABLE_SELECTOR} th`)
    .filter({ hasText: text })
    .first()
}

/** Centre of the cell whose text reads `text`. */
async function cellCentre(page: Page, text: string): Promise<{ x: number; y: number }> {
  const box = await cell(page, text).boundingBox()
  if (!box) throw new Error(`the "${text}" cell has no bounding box`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** A real press-move-release, with enough travel to clear the marquee threshold. */
async function dragBetween(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number }
): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  // Several steps: the marquee promotes on movement, so one jump could skip the
  // very state this test is about.
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 })
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.mouse.up()
}

test.describe('Marquee and table cells', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page)
  })

  test('dragging across cells leaves the table alone', async ({ page }) => {
    const title = uniqueLabel('Marquee Table Cells')
    await seedTableNote(page, title)
    await openTableNote(page, title)

    await dragBetween(page, await cellCentre(page, 'Ship it'), await cellCentre(page, 'Kaan'))

    // No block marquee: the table is one block, so any highlight here is the
    // whole table being selected behind the cell selection.
    await expect(page.locator(HIGHLIGHTED_SELECTOR)).toHaveCount(0)

    await page.keyboard.press('Backspace')

    // The table survives, and only the dragged-over cells were emptied.
    await expect
      .poll(() => tableCells(page), { timeout: 10_000 })
      .toEqual([
        ['Task', 'Owner'],
        ['', ''],
        ['Review', 'Nobody']
      ])
  })

  test('still selects the table as a block from the margin beside it', async ({ page }) => {
    const title = uniqueLabel('Marquee Table Margin')
    await seedTableNote(page, title)
    await openTableNote(page, title)

    // The table is the second block. Starting in the gray margin beside it is
    // how a whole table is selected, and that has to keep working — the cell
    // rule must not have made tables unselectable.
    const gutterX = await marqueeGutterX(page, 1)
    const tableBox = await page.locator('.bn-block[data-id]').nth(1).boundingBox()
    if (!tableBox) throw new Error('the table block has no bounding box')

    // The rectangle has to reach into the table, not just run down the margin
    // beside it — a marquee highlights the blocks it intersects.
    await dragBetween(
      page,
      { x: gutterX, y: tableBox.y - 4 },
      { x: tableBox.x + tableBox.width / 2, y: tableBox.y + tableBox.height - 4 }
    )

    await expect(page.locator(HIGHLIGHTED_SELECTOR)).not.toHaveCount(0)

    await page.keyboard.press('Backspace')

    // Selected as a block, Backspace takes the whole table — the behaviour the
    // cell drag must not trigger.
    await expect.poll(() => tableCells(page), { timeout: 10_000 }).toBeNull()
  })
})

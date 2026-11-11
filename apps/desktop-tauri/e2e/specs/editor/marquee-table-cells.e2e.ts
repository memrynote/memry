// A drag across table cells selects cells, not the table, ported from Electron's
// `marquee-table-cells.e2e.ts` (Step 14k, #3531). A table is one block, so a marquee running
// behind the cell selection took the whole table and Backspace deleted it. Only a drag over real
// layout shows the two selections competing.
import { BLOCK, HIGHLIGHT, drag, marqueeGutterX } from '../../harness/marquee'
import { vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { cellByText, openTableNote, tableCells } from '../../harness/table'
import { test, expect } from '../../harness/test'

const label = (name: string): string => `${name} ${Date.now().toString(36)}`

async function cellCentre(page: Page, text: string): Promise<{ x: number; y: number }> {
  const box = await cellByText(page, text).boundingBox()
  if (!box) throw new Error(`the "${text}" cell has no bounding box`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test('dragging across cells leaves the table alone', async ({ page }) => {
  await vaultOpen(page)
  await openTableNote(page, label('Marquee Table Cells'))
  // Without a press into the editor first, the driver's drag makes no cell selection in WKWebView.
  const start = await cellCentre(page, 'Ship it')
  await page.mouse.click(start.x, start.y)

  // Several steps: the marquee promotes on movement, so one jump could skip the state under test.
  await drag(page, await cellCentre(page, 'Ship it'), await cellCentre(page, 'Kaan'), 12)

  // The table is one block, so any highlight is the whole table selected behind the cells.
  await expect(page.locator(HIGHLIGHT)).toHaveCount(0)

  await page.keyboard.press('Backspace')
  await expect
    .poll(() => tableCells(page), { timeout: 10_000 })
    .toEqual([
      ['Task', 'Owner'],
      ['', ''],
      ['Review', 'Nobody']
    ])
})

test('still selects the table as a block from the margin beside it', async ({ page }) => {
  await vaultOpen(page)
  await openTableNote(page, label('Marquee Table Margin'))

  // The table is the second block. The rectangle has to reach into it: a marquee highlights the
  // blocks it intersects.
  const gutterX = await marqueeGutterX(page, 1)
  const table = await page.locator(BLOCK).nth(1).boundingBox()
  if (!table) throw new Error('the table block has no bounding box')
  await drag(
    page,
    { x: gutterX, y: table.y - 4 },
    { x: table.x + table.width / 2, y: table.y + table.height - 4 },
    12
  )
  await expect(page.locator(HIGHLIGHT)).not.toHaveCount(0)

  await page.keyboard.press('Backspace')
  await expect.poll(() => tableCells(page), { timeout: 10_000 }).toBeNull()
})

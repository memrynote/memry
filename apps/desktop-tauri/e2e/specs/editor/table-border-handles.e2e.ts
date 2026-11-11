// The table handles sit ON the cell border lines, ported from Electron's
// `table-border-handles.e2e.ts` (Step 14k, #3531). Our handles are measured from the DOM and
// painted over the 1px border, which only a real layout can settle, so this asserts geometry:
// each bar's box against the border segment it claims, the hover morph against Notion's 22x14
// box, and that each nub's menu acts on its own row, column and cell.
import { glide, noteBody, openNewNote, setBlocks, typeInEditor } from '../../harness/editor'
import { pressWithModifiers } from '../../harness/marquee'
import { NOTE_EDITOR, vaultOpen } from '../../harness/notes'
import type { Locator } from '../../harness/pw-compat/locator'
import type { Page } from '../../harness/pw-compat/page'
import { tableBlock, tableShape } from '../../harness/table'
import { test, expect } from '../../harness/test'

/** 2x2: one header row, one body row, what `/table` inserts. */
const TABLE_DOC = [
  tableBlock([
    ['Task', 'State'],
    ['Shipping', 'Open']
  ])
]

/**
 * 3x3, every cell separately named, so a menu that acted on the neighbouring row, column or cell
 * shows up as the wrong name surviving, not as a count that happens to match.
 */
const GRID = [
  ['H1', 'H2', 'H3'],
  ['A1', 'A2', 'A3'],
  ['B1', 'B2', 'B3']
]
const GRID_DOC = [tableBlock(GRID)]

/**
 * Where to aim inside a cell: a fixed 120 px cell leaves a short word's middle empty, and the
 * block drag handle overhangs the first column's corner.
 */
const IN_CELL = { x: 20, y: 20 }

/** `BAR_LENGTH` and `BAR_THICKNESS` in table-border-handles.tsx. */
const BAR_LENGTH = 18
const BAR_THICKNESS = 3
/** Every comparison is "the same line", so a pixel of rounding is the budget. */
const TOLERANCE = 1

async function box(locator: Locator) {
  const value = await locator.boundingBox()
  if (!value) throw new Error(`${locator} has no box`)
  return value
}

/** Centre of the border line of width `border` that starts at `edge`. */
const lineFrom = (edge: number, border: number): number => edge + border / 2
/** Centre of the border line of width `border` that ends at `edge`. */
const lineTo = (edge: number, border: number): number => edge - border / 2

async function textGrid(page: Page): Promise<string[][]> {
  const shape = await tableShape(page)
  if (!shape) throw new Error('no table in the document')
  return shape.map((row) => row.map((value) => value.text))
}

/** Rests the pointer at `IN_CELL` inside `cell`, as Playwright's `hover({ position })`. */
async function hoverIn(page: Page, cell: Locator): Promise<void> {
  const rect = await box(cell)
  await page.mouse.move(rect.x + IN_CELL.x, rect.y + IN_CELL.y)
}

/**
 * Puts the caret at the end of `cell`'s text and waits until ProseMirror's selection is there. A
 * click through the driver leaves ProseMirror's caret where it was in WKWebView, so the DOM caret
 * is set and ProseMirror takes it from `selectionchange`, which WebKitGTK delivers to the view only
 * while it holds the focus.
 */
async function caretIn(page: Page, cell: Locator): Promise<void> {
  const text = (await cell.textContent()) ?? ''
  await expect
    .poll(
      async () => {
        await cell.evaluate((element: HTMLElement) => {
          element.closest<HTMLElement>('[contenteditable="true"]')?.focus()
          const node = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()
          if (node) window.getSelection()?.collapse(node, node.textContent?.length ?? 0)
        })
        await page.waitForTimeout(100)
        return page.evaluate(() => {
          const view = (
            window as unknown as {
              __memryActiveEditor?: {
                prosemirrorView?: {
                  state: { selection: { $from: { parent: { textContent: string } } } }
                }
              }
            }
          ).__memryActiveEditor?.prosemirrorView
          return view?.state.selection.$from.parent.textContent ?? null
        })
      },
      { timeout: 10_000 }
    )
    .toBe(text)
}

async function openGridNote(page: Page, title: string, doc: unknown[] = GRID_DOC) {
  await vaultOpen(page)
  const note = await openNewNote(page, `${title} ${Date.now()}`, 'seed')
  await setBlocks(page, doc)
  const rows = page.locator(NOTE_EDITOR).first().locator('table tr')
  await expect(rows).toHaveCount(doc === GRID_DOC ? 3 : 2, { timeout: 15_000 })
  return { note, rows }
}

test('every bar lands on the cell border it claims', async ({ page }) => {
  // Three columns: for the MIDDLE column the table's outer inline-start edge and the cell's own
  // inline-start border are different lines, which is the only way to tell where the row bar sits.
  const { rows } = await openGridNote(page, 'Table Border Handles')
  const middleCell = rows.nth(1).locator('td').nth(1)

  // BlockNote's own handles are gone: nothing floats beside the table.
  await hoverIn(page, middleCell)
  await expect(page.locator('.bn-table-handle')).toHaveCount(0)

  // Three bars, all placed from the one hovered cell: the table's inline-start edge beside its
  // row, the table's block-start edge above its column, and its own inline-end border.
  const bars = page.locator('[data-memry-table-handles] .memry-table-handle')
  await expect(bars).toHaveCount(3, { timeout: 10_000 })

  const tableBox = await box(page.locator(NOTE_EDITOR).first().locator('table').first())
  const hovered = await box(middleCell)
  const border = await middleCell.evaluate((element: HTMLElement) =>
    parseFloat(getComputedStyle(element).borderInlineStartWidth)
  )
  expect(border).toBeGreaterThan(0)

  /** A nub covers the middle BAR_LENGTH of its segment, not the whole line. */
  const nubStart = (segmentStart: number, span: number): number =>
    segmentStart + (span - Math.min(BAR_LENGTH, span)) / 2
  const nubLength = (span: number): number => Math.min(BAR_LENGTH, span)

  // The row bar: on the table's inline-start outer border, beside the hovered cell's row.
  const rowBar = await box(page.locator('[data-memry-table-bar="row"]'))
  expect(Math.abs(rowBar.width - BAR_THICKNESS)).toBeLessThanOrEqual(TOLERANCE)
  expect(Math.abs(rowBar.x + rowBar.width / 2 - lineFrom(tableBox.x, border))).toBeLessThanOrEqual(
    TOLERANCE
  )
  expect(Math.abs(rowBar.y - nubStart(hovered.y, hovered.height))).toBeLessThanOrEqual(TOLERANCE)
  expect(Math.abs(rowBar.height - nubLength(hovered.height))).toBeLessThanOrEqual(TOLERANCE)

  // The column bar: centred on the table's block-start border, over the hovered cell's extent.
  const colBar = await box(page.locator('[data-memry-table-bar="column"]'))
  expect(Math.abs(colBar.height - BAR_THICKNESS)).toBeLessThanOrEqual(TOLERANCE)
  expect(Math.abs(colBar.y + colBar.height / 2 - lineFrom(tableBox.y, border))).toBeLessThanOrEqual(
    TOLERANCE
  )
  expect(Math.abs(colBar.x - nubStart(hovered.x, hovered.width))).toBeLessThanOrEqual(TOLERANCE)
  expect(Math.abs(colBar.width - nubLength(hovered.width))).toBeLessThanOrEqual(TOLERANCE)

  // One cell bar, centred on the hovered cell's inline-end border.
  const cellBars = page.locator('[data-memry-table-bar="cell"]')
  await expect(cellBars).toHaveCount(1)
  const cellBar = await box(cellBars.first())
  expect(Math.abs(cellBar.width - BAR_THICKNESS)).toBeLessThanOrEqual(TOLERANCE)
  expect(
    Math.abs(cellBar.x + cellBar.width / 2 - lineTo(hovered.x + hovered.width, border))
  ).toBeLessThanOrEqual(TOLERANCE)
  expect(Math.abs(cellBar.y - nubStart(hovered.y, hovered.height))).toBeLessThanOrEqual(TOLERANCE)
  expect(Math.abs(cellBar.height - nubLength(hovered.height))).toBeLessThanOrEqual(TOLERANCE)

  // Nothing sits on the INTERIOR line to the hovered cell's left: that line is also the previous
  // cell's inline-end border, so a handle there would address two cells at once.
  const verticalCentres = await page
    .locator('[data-memry-table-handles] .memry-table-handle[data-orientation="vertical"]')
    .evaluateAll((nodes: Element[]) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect()
        return rect.x + rect.width / 2
      })
    )
  expect(verticalCentres).toHaveLength(2)
  for (const centre of verticalCentres) {
    expect(Math.abs(centre - lineFrom(hovered.x, border))).toBeGreaterThan(TOLERANCE)
  }

  // A resting bar is a bare line: no border, no ring, no outline, read off the pill it paints.
  const resting = await page
    .locator('[data-memry-table-handle="row"] .memry-table-handle-pill')
    .evaluate((element: HTMLElement) => {
      const style = getComputedStyle(element)
      return {
        borderTopWidth: style.borderTopWidth,
        outlineStyle: style.outlineStyle,
        boxShadow: style.boxShadow,
        borderRadius: style.borderTopLeftRadius
      }
    })
  expect(resting).toEqual({
    borderTopWidth: '0px',
    outlineStyle: 'none',
    boxShadow: 'none',
    borderRadius: '0px'
  })
})

// An opened bar is Notion's button: the row pill 14 wide x 22 tall and still centred on the
// table's inline-start line, the column pill 22x14 on its block-start line. Asserted through the
// open menu, which holds the box while the pointer is over the menu (#4200); WebDriver pointer
// moves set no CSS `:hover` in WKWebView, so the hover morph is not asserted here.
test("an opened bar holds Notion's 14x22 button box on its border line", async ({ page }) => {
  const { rows } = await openGridNote(page, 'Table Nub Open')
  const middleCell = rows.nth(1).locator('td').nth(1)
  const tableBox = await box(page.locator(NOTE_EDITOR).first().locator('table').first())
  const border = await middleCell.evaluate((element: HTMLElement) =>
    parseFloat(getComputedStyle(element).borderInlineStartWidth)
  )

  for (const { kind, size } of [
    { kind: 'row', size: '14x22' },
    { kind: 'column', size: '22x14' }
  ]) {
    // Bars follow `pointerover`: from outside the table, so the second pass raises them again.
    await page.mouse.move(5, 5)
    await hoverIn(page, middleCell)
    const control = page.locator(`[data-memry-table-handle="${kind}"]`)
    await expect(control).toBeVisible({ timeout: 10_000 })
    await control.click()
    await expect(control).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 })

    const pill = control.locator('.memry-table-handle-pill')
    await expect
      .poll(
        async () => {
          const grown = await pill.boundingBox()
          return grown ? `${Math.round(grown.width)}x${Math.round(grown.height)}` : 'gone'
        },
        { timeout: 5_000 }
      )
      .toBe(size)

    // Still centred on the border line it rests on.
    const grown = await box(pill)
    if (kind === 'row') {
      expect(
        Math.abs(grown.x + grown.width / 2 - lineFrom(tableBox.x, border))
      ).toBeLessThanOrEqual(TOLERANCE)
    } else {
      expect(
        Math.abs(grown.y + grown.height / 2 - lineFrom(tableBox.y, border))
      ).toBeLessThanOrEqual(TOLERANCE)
    }

    await page.keyboard.press('Escape')
    await expect(page.locator('[data-memry-table-handles]')).toHaveCount(0, { timeout: 10_000 })
  }
})

test('the nub reaches past the line it paints, and survives the resize shield', async ({
  page
}) => {
  const { rows } = await openGridNote(page, 'Table Nub Reach')
  const middleCell = rows.nth(1).locator('td').nth(1)

  // The caret in the middle cell puts its nub and the resize shield on its inline-end border.
  await caretIn(page, middleCell)
  await expect(page.locator('[data-memry-table-resize-shield]')).toHaveCount(1, {
    timeout: 10_000
  })
  await hoverIn(page, middleCell)
  const cellNub = page.locator('[data-memry-table-handle="cell"]')
  const cellPill = cellNub.locator('.memry-table-handle-pill')
  await expect(cellNub).toBeVisible({ timeout: 10_000 })

  // The hit box reaches past the 3px bar across the thin axis, where the pointer arrives; the
  // long axis is left alone because a column resize drag starts there.
  const restingPill = await box(cellPill)
  const restingHit = await box(cellNub)
  expect(Math.abs(restingPill.width - BAR_THICKNESS)).toBeLessThanOrEqual(TOLERANCE)
  expect(restingHit.width).toBeGreaterThan(restingPill.width + 4)
  expect(Math.abs(restingHit.height - restingPill.height)).toBeLessThanOrEqual(TOLERANCE)

  // The pointer travels along that border, over the shield and off the nub, and the bars stay:
  // the shield is not a `<td>`, and reading it as "the table was left" hid a focused cell's nub.
  const cellBox = await box(middleCell)
  const edge = cellBox.x + cellBox.width
  await page.mouse.move(edge - 1, cellBox.y + 4)
  await expect(cellNub).toBeVisible()
  await expect(page.locator('[data-memry-table-handles] .memry-table-handle')).toHaveCount(3)

  // Arriving from inside the cell, a press one pixel short of the line opens the cell menu.
  await page.mouse.click(edge - 5, cellBox.y + cellBox.height / 2)
  await expect(page.getByText('Colors', { exact: true }).first()).toBeVisible({ timeout: 5_000 })
})

test("the caret's cell is ringed in the accent, and the ring follows the caret", async ({
  page
}) => {
  const { rows } = await openGridNote(page, 'Table Cell Focus')
  const ring = page.locator('[data-memry-table-cell-focus]')

  /** The ring's seam, and how far its box is from the given cell's box. */
  const ringOn = async (rowIndex: number, colIndex: number) => {
    const cellBox = await box(rows.nth(rowIndex).locator('td, th').nth(colIndex))
    const ringBox = await box(ring)
    return {
      count: await ring.count(),
      row: await ring.getAttribute('data-row-index'),
      col: await ring.getAttribute('data-col-index'),
      offBy: Math.max(
        Math.abs(ringBox.x - cellBox.x),
        Math.abs(ringBox.y - cellBox.y),
        Math.abs(ringBox.width - cellBox.width),
        Math.abs(ringBox.height - cellBox.height)
      )
    }
  }

  await caretIn(page, rows.nth(1).locator('td').nth(0))
  await expect(ring).toHaveCount(1, { timeout: 10_000 })
  const first = await ringOn(1, 0)
  expect({ count: first.count, row: first.row, col: first.col }).toEqual({
    count: 1,
    row: '1',
    col: '0'
  })
  expect(first.offBy).toBeLessThanOrEqual(TOLERANCE)

  // Painted in the user's accent, resolved through a probe because `--tint-border` is a
  // `color-mix()` that `getPropertyValue` hands back unevaluated.
  const paint = await ring.evaluate((element: HTMLElement) => {
    const probe = document.createElement('div')
    probe.style.color = 'var(--tint-border)'
    element.ownerDocument.body.appendChild(probe)
    const tint = getComputedStyle(probe).color
    probe.remove()
    return { border: getComputedStyle(element).borderTopColor, tint }
  })
  expect(paint.border).toBe(paint.tint)

  // The caret moves down with the keyboard, and the ring moves with it, leaving A1 bare.
  await page.keyboard.press('ArrowDown')
  await expect(ring).toHaveAttribute('data-row-index', '2', { timeout: 10_000 })
  const moved = await ringOn(2, 0)
  expect(moved.count).toBe(1)
  expect(moved.col).toBe('0')
  expect(moved.offBy).toBeLessThanOrEqual(TOLERANCE)
  const neighbour = await box(rows.nth(1).locator('td').nth(0))
  expect(Math.abs((await box(ring)).y - neighbour.y)).toBeGreaterThan(TOLERANCE)

  // Typing does not shake it off its cell.
  await typeInEditor(page, 'xy')
  await expect(ring).toHaveAttribute('data-row-index', '2')
  expect((await ringOn(2, 0)).offBy).toBeLessThanOrEqual(TOLERANCE)

  // A caret put straight into another cell hands it over.
  await caretIn(page, rows.nth(1).locator('td').nth(2))
  await expect(ring).toHaveAttribute('data-col-index', '2', { timeout: 10_000 })
  const clicked = await ringOn(1, 2)
  expect(clicked.count).toBe(1)
  expect(clicked.row).toBe('1')
  expect(clicked.offBy).toBeLessThanOrEqual(TOLERANCE)
})

test('an open menu leaves the table wrapper and takes the pointer', async ({ page }) => {
  const { rows } = await openGridNote(page, 'Table Menu Layer', TABLE_DOC)
  const bodyCell = rows.nth(1).locator('td').first()

  await hoverIn(page, bodyCell)
  const rowNub = page.locator('[data-memry-table-handle="row"]')
  await expect(rowNub).toBeVisible({ timeout: 10_000 })
  await rowNub.click()
  await expect(page.getByText('Delete row', { exact: true }).first()).toBeVisible({
    timeout: 10_000
  })

  // The menu is not mounted inside `.tableWrapper`, the table's own scroll container
  // (`overflow-x: auto`, `overflow-y: hidden`, `position: relative`), which would cut it to the
  // table's box and paint it under the editor's own layers.
  const layer = await page.evaluate(() => {
    const menu = document.querySelector('.memry-table-menu')
    const wrapper = document.querySelector('.tableWrapper')
    const table = wrapper?.querySelector('table')
    if (!menu || !wrapper || !table) return null
    const rect = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect()
      return { x, y, width, height }
    }
    const menuBox = rect(menu)
    const hit = document.elementFromPoint(
      menuBox.x + menuBox.width / 2,
      menuBox.y + menuBox.height / 2
    )
    return {
      insideWrapper: Boolean(menu.closest('.tableWrapper')),
      hit: hit
        ? hit === menu || menu.contains(hit)
          ? 'menu'
          : `${hit.tagName}.${hit.className}`
        : '',
      hitCursor: hit ? getComputedStyle(hit).cursor : 'none',
      menuBox,
      tableBox: rect(table),
      wrapperBox: rect(wrapper),
      viewport: { width: window.innerWidth, height: window.innerHeight }
    }
  })
  if (!layer) throw new Error('no open menu found next to the table')
  expect(layer.insideWrapper).toBe(false)

  // The middle of the menu is the menu: a clipped or under-painted one leaves the editor's content
  // under that point, which is also why the caret cursor used to survive over it.
  expect(layer.hit).toBe('menu')
  expect(layer.hitCursor).toBe('pointer')

  // Taller than its table and reaching past the wrapper's bottom edge, which the clip cut off.
  expect(layer.menuBox.height).toBeGreaterThan(layer.tableBox.height)
  expect(layer.menuBox.y + layer.menuBox.height).toBeGreaterThan(
    layer.wrapperBox.y + layer.wrapperBox.height
  )

  // None of it is off screen.
  expect(layer.menuBox.x).toBeGreaterThanOrEqual(0)
  expect(layer.menuBox.y).toBeGreaterThanOrEqual(0)
  expect(layer.menuBox.x + layer.menuBox.width).toBeLessThanOrEqual(layer.viewport.width)
  expect(layer.menuBox.y + layer.menuBox.height).toBeLessThanOrEqual(layer.viewport.height)
})

test('the focused cell stops its own column resizing from fighting the nub', async ({ page }) => {
  const { rows } = await openGridNote(page, 'Table Resize Shield')
  const firstCell = rows.nth(1).locator('td').nth(0)
  const middleCell = rows.nth(1).locator('td').nth(1)

  /**
   * Drags the middle cell's inline-end border, always the same edge, so the only difference
   * between the two halves is which cell holds the caret. Aimed near the edge's TOP: the nub owns
   * its middle 18px and swallows a drag there, shield or not. The approach before the press is
   * not padding: prosemirror-tables arms a resize on a `mousemove` near the edge.
   */
  const dragMiddleEdge = async (by: number): Promise<number> => {
    const rect = await box(middleCell)
    const edge = rect.x + rect.width
    const y = rect.y + 5
    await page.mouse.move(edge - 12, y)
    await glide(page, { x: edge, y }, 4)
    await page.mouse.down()
    await glide(page, { x: edge + by, y }, 8)
    await page.mouse.up()
    await page.waitForTimeout(200)
    return (await box(middleCell)).width
  }

  // The caret in the FIRST cell: nothing shields the middle cell's edge, and it resizes.
  await caretIn(page, firstCell)
  await expect(page.locator('[data-memry-table-resize-shield]')).toHaveCount(1, {
    timeout: 10_000
  })
  const unshielded = await box(middleCell)
  expect(await dragMiddleEdge(60)).toBeGreaterThan(unshielded.width + 1)

  // The caret in the middle cell puts its nub and shield on that edge: the same drag moves nothing.
  await caretIn(page, middleCell)
  await expect
    .poll(() =>
      page
        .locator('[data-memry-table-resize-shield]')
        .evaluate((element: HTMLElement) => element.getBoundingClientRect().x)
    )
    .toBeGreaterThan(0)
  const shielded = await box(middleCell)
  const afterShielded = await dragMiddleEdge(60)
  expect(Math.abs(afterShielded - shielded.width)).toBeLessThanOrEqual(TOLERANCE)
})

test('each nub opens the menu for its own row, column and cell', async ({ page }) => {
  const { note, rows } = await openGridNote(page, 'Table Handle Menus')
  const cellNub = page.locator('[data-memry-table-handle="cell"]')
  const rowNub = page.locator('[data-memry-table-handle="row"]')
  const colNub = page.locator('[data-memry-table-handle="column"]')

  // A1's inline-end nub is 3px wide on the line A1 and A2 share, so the element under the cursor
  // is as likely to be A2: a menu that read the hovered cell would colour the neighbour.
  await hoverIn(page, rows.nth(1).locator('td').nth(0))
  await expect(cellNub).toBeVisible({ timeout: 10_000 })
  await cellNub.click()
  const colorsItem = page.getByText('Colors', { exact: true }).first()
  await expect(colorsItem).toBeVisible({ timeout: 10_000 })
  await colorsItem.click()
  await page.locator('[data-test="background-color-red"]').first().click()

  await expect
    .poll(async () =>
      ((await tableShape(page)) ?? []).map((row) =>
        row.map((value) => value.backgroundColor === 'red')
      )
    )
    .toEqual([
      [false, false, false],
      [true, false, false],
      [false, false, false]
    ])

  // The saved note names that one cell, `row:column`, and only it.
  await expect
    .poll(async () => (await noteBody(page, note.id)) ?? '', { timeout: 20_000 })
    .toContain('<!-- table-colors:')
  const saved = await noteBody(page, note.id)
  expect(saved).toContain('"1:0":{"backgroundColor":"red"}')
  expect(saved).not.toContain('"1:1"')

  // The LAST body row's inline-start nub deletes that row, not the one above it.
  await setBlocks(page, GRID_DOC)
  await hoverIn(page, rows.nth(2).locator('td').nth(1))
  await expect(rowNub).toBeVisible({ timeout: 10_000 })
  await rowNub.click()
  await page.getByText('Delete row', { exact: true }).first().click()
  await expect.poll(() => textGrid(page)).toEqual([GRID[0], GRID[1]])

  // The middle column's block-start nub deletes column 1, in every row.
  await setBlocks(page, GRID_DOC)
  await hoverIn(page, rows.nth(1).locator('td').nth(1))
  await expect(colNub).toBeVisible({ timeout: 10_000 })
  await colNub.click()
  await page.getByText('Delete column', { exact: true }).first().click()
  await expect
    .poll(() => textGrid(page))
    .toEqual([
      ['H1', 'H3'],
      ['A1', 'A3'],
      ['B1', 'B3']
    ])
})

/**
 * Starts the caret in the FIRST header cell, then walks to A2 with keys: a menu that read the
 * starting cell instead of the caret's would act on H1 and be caught by the grid that comes out. Tab, not
 * ArrowRight, crosses a cell boundary in one press.
 */
async function walkToA2(page: Page, rows: Locator): Promise<void> {
  await caretIn(page, rows.nth(0).locator('th, td').nth(0))
  const anchor = page.locator('[data-memry-table-keyboard-anchor]')
  await expect(anchor).toHaveCount(1, { timeout: 10_000 })
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Tab')
  await expect(anchor).toHaveAttribute('data-row-index', '1', { timeout: 10_000 })
  await expect(anchor).toHaveAttribute('data-col-index', '1')
}

/** Cmd/Ctrl+Shift+Enter, the table menu's shortcut. */
const openKeyboardMenu = (page: Page): Promise<void> =>
  pressWithModifiers(page, 'Enter', { shift: true, mod: true })

/** The label of the menu item holding the focus, or '' while the focus is on the menu's box. */
const focusedItem = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const active = document.activeElement
    if (active?.getAttribute('data-slot') !== 'dropdown-menu-item') return ''
    return (active.textContent ?? '').trim()
  })

/**
 * Walks the open menu with ArrowDown until `label` holds the focus, then runs it with Enter. Each
 * press waits for the highlight to move: Radix moves the focus a frame after the key.
 */
async function runByKeyboard(page: Page, label: string): Promise<void> {
  const walked: string[] = []
  for (let step = 0; step < 12; step += 1) {
    const here = await focusedItem(page)
    if (here === label) {
      await page.keyboard.press('Enter')
      return
    }
    walked.push(here || '(menu)')
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => focusedItem(page), { timeout: 5_000 }).not.toBe(here)
  }
  throw new Error(`${label} never took the focus. Walked: ${walked.join(' -> ')}`)
}

test('a keyboard alone adds a row, and names the cell it will act on', async ({ page }) => {
  const { rows } = await openGridNote(page, 'Table Keyboard Row')
  await walkToA2(page, rows)
  const menu = page.locator('.memry-table-keyboard-menu')
  await openKeyboardMenu(page)
  await expect(menu).toBeVisible({ timeout: 10_000 })

  // The menu names its cell, counted the way a person counts, and Radix hands that name to the
  // dropdown as its own.
  await expect(menu).toContainText('Row 2 · Column 2')
  const menuName = await menu.evaluate((element: HTMLElement) => {
    const id = element.getAttribute('aria-labelledby')
    return id ? (document.getElementById(id)?.getAttribute('aria-label') ?? '') : ''
  })
  expect(menuName).toBe('Table actions for row 2, column 2')

  // The keystroke that opened it never reached the editor: the cell is not split.
  expect((await textGrid(page))[1][1]).toBe('A2')

  await runByKeyboard(page, 'Add row below')
  await expect.poll(() => textGrid(page)).toEqual([GRID[0], GRID[1], ['', '', ''], GRID[2]])
})

test('a keyboard alone deletes the caret’s column', async ({ page }) => {
  const { rows } = await openGridNote(page, 'Table Keyboard Column')
  await walkToA2(page, rows)
  await openKeyboardMenu(page)
  await expect(page.locator('.memry-table-keyboard-menu')).toBeVisible({ timeout: 10_000 })
  await runByKeyboard(page, 'Delete column')
  await expect
    .poll(() => textGrid(page))
    .toEqual([
      ['H1', 'H3'],
      ['A1', 'A3'],
      ['B1', 'B3']
    ])
})

test('Escape closes the keyboard menu and hands the caret back to its cell', async ({ page }) => {
  const { rows } = await openGridNote(page, 'Table Keyboard Escape')

  // Electron walks there with a click, ArrowDown and End; the driver's End moves no caret in
  // WKWebView, so the caret is put at the end of A1 directly.
  await caretIn(page, rows.nth(1).locator('td').nth(0))
  const anchor = page.locator('[data-memry-table-keyboard-anchor]')
  await expect(anchor).toHaveAttribute('data-row-index', '1', { timeout: 10_000 })
  await expect(anchor).toHaveAttribute('data-col-index', '0')

  // The caret stands at the END of A1 before the menu opens.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const state = (
            window as unknown as {
              __memryActiveEditor?: {
                prosemirrorView?: {
                  state: {
                    selection: { $from: { parent: { textContent: string }; parentOffset: number } }
                  }
                }
              }
            }
          ).__memryActiveEditor?.prosemirrorView?.state
          if (!state) return null
          const $from = state.selection.$from
          return { text: $from.parent.textContent, offset: $from.parentOffset }
        }),
      { timeout: 10_000 }
    )
    .toEqual({ text: 'A1', offset: 2 })

  const menu = page.locator('.memry-table-keyboard-menu')
  await openKeyboardMenu(page)
  await expect(menu).toBeVisible({ timeout: 10_000 })
  // Visible is paint, not readiness: Radix wires its dismiss scope a beat after mounting, and an
  // Escape in that gap dies unheard. Focus inside the menu is the signal the scope is live.
  await expect
    .poll(
      () =>
        page.evaluate(() => Boolean(document.activeElement?.closest('.memry-table-keyboard-menu'))),
      { timeout: 10_000 }
    )
    .toBe(true)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0, { timeout: 10_000 })

  // The focus is back in the editor, not on the box the menu hung from.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const active = document.activeElement
          if (!active) return 'none'
          if (active.hasAttribute('data-memry-table-keyboard-anchor')) return 'anchor'
          return active.closest('.bn-editor') ? 'editor' : 'elsewhere'
        }),
      { timeout: 10_000 }
    )
    .toBe('editor')

  // ProseMirror syncs the DOM selection a beat after the view regains focus, and typing in that
  // gap lands at the cell's start: wait for the caret at the end of A1 first.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const sel = window.getSelection()
          if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return 'no-caret'
          const range = sel.getRangeAt(0)
          const node = range.startContainer
          const el = node instanceof Element ? node : node.parentElement
          if (el?.closest('td, th')?.textContent !== 'A1') return 'outside-cell'
          const atEnd =
            node.nodeType === Node.TEXT_NODE
              ? range.startOffset === (node.textContent?.length ?? 0)
              : range.startOffset >= node.childNodes.length
          return atEnd ? 'end-of-A1' : 'in-A1'
        }),
      { timeout: 10_000 }
    )
    .toBe('end-of-A1')

  // Typing lands back in the cell the menu was opened from, at its caret; nothing else moved.
  await typeInEditor(page, 'zz')
  await expect
    .poll(() => textGrid(page), { timeout: 10_000 })
    .toEqual([GRID[0], ['A1zz', 'A2', 'A3'], GRID[2]])
})

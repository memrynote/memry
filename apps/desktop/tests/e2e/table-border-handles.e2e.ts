// @ts-nocheck - E2E test; window.api typing lives in the renderer bundle
/**
 * The table handles have to sit ON the cell border lines, not beside them.
 *
 * BlockNote's own handles (`tableHandles`, now off in the note editor) are
 * floating-ui elements anchored `placement: 'left'` / `'top'` against a row or
 * a column, so they always float NEXT TO the table geometry. Ours are measured
 * from the DOM and painted over the 1px border, which is a claim only a real
 * browser can settle — jsdom has no layout, so every number here would be 0.
 *
 * So this asserts geometry, not classes: each bar's box against the border
 * segment it claims to cover, and the hover morph against Notion's 22x14 box.
 */

import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

import type { Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready } from './utils/desktop-test-helpers'
import { SELECTORS } from './utils/electron-helpers'
import { getNoteFileBodyById, openNoteByHandle } from './utils/note-sync-helpers'

const cell = (text: string) => ({
  type: 'tableCell',
  content: [{ type: 'text', text, styles: {} }],
  props: { colspan: 1, rowspan: 1 }
})

/** 2x2: one header row, one body row — what `/table` inserts. */
const TABLE_DOC = [
  {
    type: 'table',
    content: {
      type: 'tableContent',
      columnWidths: [null, null],
      headerRows: 1,
      rows: [{ cells: [cell('Task'), cell('State')] }, { cells: [cell('Shipping'), cell('Open')] }]
    }
  }
]

/**
 * 3x3: one header row, two body rows, every cell separately named so a menu
 * that acted on the neighbouring row/column/cell shows up as the wrong name
 * surviving, not as a count that happens to match.
 */
const GRID_DOC = [
  {
    type: 'table',
    content: {
      type: 'tableContent',
      columnWidths: [null, null, null],
      headerRows: 1,
      rows: [
        { cells: [cell('H1'), cell('H2'), cell('H3')] },
        { cells: [cell('A1'), cell('A2'), cell('A3')] },
        { cells: [cell('B1'), cell('B2'), cell('B3')] }
      ]
    }
  }
]

/**
 * Where to aim a pointer inside a cell. Not the centre: a cell is a fixed
 * 120px wide and a short word leaves the middle empty. Not `{8, 8}` either —
 * the block drag handle overhangs the first column there.
 */
const IN_CELL = { x: 20, y: 20 }

/** Matches `BAR_LENGTH` in table-border-handles.tsx. */
const BAR_LENGTH = 18

/**
 * Matches `BAR_THICKNESS`. A nub is thicker than the line it covers — matching
 * the border's own 1px was tried and rejected as too faint to find — so this is
 * asserted against the constant, while the CENTRE of the nub is still asserted
 * against the measured border line.
 */
const BAR_THICKNESS = 3
/** Every comparison is "the same line", so a pixel of rounding is the budget. */
const TOLERANCE = 1

const SHOT_DIR = process.env.MEMRY_TABLE_HANDLE_SHOTS ?? ''

async function createNote(page: Page, title: string, content = '') {
  return page.evaluate(
    async ({ noteTitle, noteContent }) => {
      const result = await window.api.notes.create({ title: noteTitle, content: noteContent })
      if (!result.success || !result.note) throw new Error(result.error || 'note create failed')
      return { id: result.note.id, title: result.note.title, emoji: result.note.emoji ?? null }
    },
    { noteTitle: title, noteContent: content }
  )
}

async function setDocument(page: Page, blocks: unknown[]): Promise<void> {
  await page.locator(SELECTORS.noteEditor).first().waitFor({ state: 'visible', timeout: 15_000 })
  await page.evaluate((next) => {
    const editor = (window as any).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')
    editor.replaceBlocks(editor.document, next)
  }, blocks)
}

async function box(locator: Locator) {
  const value = await locator.boundingBox()
  if (!value) throw new Error('element has no box')
  return value
}

/** Centre of the border line of width `border` that STARTS at `edge`. */
const lineFrom = (edge: number, border: number): number => edge + border / 2
/** Centre of the border line of width `border` that ENDS at `edge`. */
const lineTo = (edge: number, border: number): number => edge - border / 2

/** Every cell as `text` / `background`, row by row, from the live document. */
async function tableShape(page: Page): Promise<{ text: string; background?: string }[][]> {
  return page.evaluate(() => {
    const editor = (window as any).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')
    const table = editor.document.find((block: any) => block.type === 'table')
    if (!table) throw new Error('no table in the document')
    return table.content.rows.map((row: any) =>
      row.cells.map((value: any) => ({
        text: (value.content ?? []).map((part: any) => part.text ?? '').join(''),
        background: value.props?.backgroundColor
      }))
    )
  })
}

/** Just the text, which is what a wrong row/column deletion would give away. */
const textGrid = (shape: { text: string }[][]): string[][] =>
  shape.map((row) => row.map((value) => value.text))

/** Save the whole window — a menu is portalled out of the table's own box. */
async function shootPage(page: Page, name: string): Promise<void> {
  if (!SHOT_DIR) return
  if (!existsSync(SHOT_DIR)) mkdirSync(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(SHOT_DIR, name) })
}

/** Save a tight crop of the table so 1px bars are actually visible. */
async function shootTable(page: Page, wrapper: Locator, name: string): Promise<void> {
  if (!SHOT_DIR) return
  if (!existsSync(SHOT_DIR)) mkdirSync(SHOT_DIR, { recursive: true })
  const area = await box(wrapper)
  const pad = 10
  await page.screenshot({
    path: path.join(SHOT_DIR, name),
    clip: {
      x: Math.max(0, area.x - pad),
      y: Math.max(0, area.y - pad),
      width: area.width + pad * 2,
      height: area.height + pad * 2
    }
  })
}

test.describe('Table border handles', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page)
  })

  test('every bar lands on the cell border it claims, and morphs on hover', async ({ page }) => {
    // #given a note holding a 3x3 table. Three columns on purpose: for a cell
    // in the MIDDLE column the table's outer inline-start edge and that cell's
    // own inline-start border are different lines, which is the only way to
    // tell where the row bar actually sits.
    const note = await createNote(page, `Table Border Handles ${Date.now()}`)
    await openNoteByHandle(page, note)
    await setDocument(page, GRID_DOC)

    const editor = page.locator(SELECTORS.noteEditor).first()
    const bodyRow = editor.locator('table tr').nth(1)
    const middleCell = bodyRow.locator('td').nth(1)
    await expect(middleCell).toBeVisible({ timeout: 15_000 })

    // #and BlockNote's own handles are gone — nothing floats beside the table
    await middleCell.hover({ position: IN_CELL })
    await expect(page.locator('.bn-table-handle')).toHaveCount(0)

    // #when the pointer rests in the middle body cell
    const bars = page.locator('[data-memry-table-handles] .memry-table-handle')

    // #then exactly three bars are up, all placed from the ONE hovered cell:
    // the table's inline-start edge beside its row, the table's block-start
    // edge above its column, and its own inline-end border.
    await expect(bars).toHaveCount(3, { timeout: 10_000 })

    const table = editor.locator('table').first()
    const tableBox = await box(table)
    const hovered = await box(middleCell)

    // The nub is as thick as the line it covers, and the line's width is the
    // cell's own — read it from the DOM instead of writing the number twice.
    const border = await middleCell.evaluate((element) =>
      parseFloat(getComputedStyle(element).borderInlineStartWidth)
    )
    expect(border).toBeGreaterThan(0)

    /** A nub covers the middle BAR_LENGTH of its segment, not the whole line. */
    const nubStart = (segmentStart: number, span: number): number =>
      segmentStart + (span - Math.min(BAR_LENGTH, span)) / 2
    const nubLength = (span: number): number => Math.min(BAR_LENGTH, span)

    // --- the row bar: on the TABLE's inline-start outer border, beside the
    // hovered cell's row ---
    const rowBar = await box(page.locator('[data-memry-table-bar="row"]'))
    expect(Math.abs(rowBar.width - BAR_THICKNESS)).toBeLessThanOrEqual(TOLERANCE)
    expect(
      Math.abs(rowBar.x + rowBar.width / 2 - lineFrom(tableBox.x, border))
    ).toBeLessThanOrEqual(TOLERANCE)
    expect(Math.abs(rowBar.y - nubStart(hovered.y, hovered.height))).toBeLessThanOrEqual(TOLERANCE)
    expect(Math.abs(rowBar.height - nubLength(hovered.height))).toBeLessThanOrEqual(TOLERANCE)

    // --- the column bar: centred on the table's block-start border, over the
    // hovered cell's own inline extent ---
    const colBar = await box(page.locator('[data-memry-table-bar="column"]'))
    expect(Math.abs(colBar.height - BAR_THICKNESS)).toBeLessThanOrEqual(TOLERANCE)
    expect(
      Math.abs(colBar.y + colBar.height / 2 - lineFrom(tableBox.y, border))
    ).toBeLessThanOrEqual(TOLERANCE)
    expect(Math.abs(colBar.x - nubStart(hovered.x, hovered.width))).toBeLessThanOrEqual(TOLERANCE)
    expect(Math.abs(colBar.width - nubLength(hovered.width))).toBeLessThanOrEqual(TOLERANCE)

    // --- one cell bar, centred on the hovered cell's inline-end border ---
    const cellBars = page.locator('[data-memry-table-bar="cell"]')
    await expect(cellBars).toHaveCount(1)
    const cellBar = await box(cellBars.first())
    expect(Math.abs(cellBar.width - BAR_THICKNESS)).toBeLessThanOrEqual(TOLERANCE)
    expect(
      Math.abs(cellBar.x + cellBar.width / 2 - lineTo(hovered.x + hovered.width, border))
    ).toBeLessThanOrEqual(TOLERANCE)
    expect(Math.abs(cellBar.y - nubStart(hovered.y, hovered.height))).toBeLessThanOrEqual(TOLERANCE)
    expect(Math.abs(cellBar.height - nubLength(hovered.height))).toBeLessThanOrEqual(TOLERANCE)

    // #and nothing sits on the INTERIOR line to the hovered cell's left. That
    // line is also the previous cell's inline-end border, so a handle there
    // would address two cells at once — which is why the row bar moved out to
    // the table's own edge.
    const verticalCentres = await page
      .locator('[data-memry-table-handles] .memry-table-handle[data-orientation="vertical"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect()
          return rect.x + rect.width / 2
        })
      )
    expect(verticalCentres).toHaveLength(2)
    for (const centre of verticalCentres) {
      expect(Math.abs(centre - lineFrom(hovered.x, border))).toBeGreaterThan(TOLERANCE)
    }

    // #and a resting bar is a bare line: no border, no ring, no outline.
    // Read off the PILL, which is what the nub paints — the button around it
    // is a transparent hit area padded out past the line on the thin axis.
    const resting = await page
      .locator('[data-memry-table-handle="row"] .memry-table-handle-pill')
      .evaluate((element) => {
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

    await shootTable(page, editor.locator('.tableWrapper').first(), 'table-bars-resting.png')

    // #when the pointer moves onto the row bar it becomes Notion's button,
    // 14 wide x 22 tall for a bar standing on the inline axis
    const rowControl = page.locator('[data-memry-table-handle="row"]')
    const rowPill = rowControl.locator('.memry-table-handle-pill')
    await rowControl.hover()
    await expect
      .poll(
        async () => {
          const grown = await rowPill.boundingBox()
          return grown ? `${Math.round(grown.width)}x${Math.round(grown.height)}` : 'gone'
        },
        { timeout: 5_000 }
      )
      .toBe('14x22')

    // #and it is still centred on the same border line it was resting on
    const grown = await box(rowPill)
    expect(Math.abs(grown.x + grown.width / 2 - lineFrom(tableBox.x, border))).toBeLessThanOrEqual(
      TOLERANCE
    )

    await shootTable(page, editor.locator('.tableWrapper').first(), 'table-bar-hovered.png')

    // #and the column bar takes the same box lying down
    const colControl = page.locator('[data-memry-table-handle="column"]')
    await colControl.hover()
    await expect
      .poll(
        async () => {
          const wide = await colControl.locator('.memry-table-handle-pill').boundingBox()
          return wide ? `${Math.round(wide.width)}x${Math.round(wide.height)}` : 'gone'
        },
        { timeout: 5_000 }
      )
      .toBe('22x14')
  })

  test('the nub reaches past the line it paints, and survives the resize shield', async ({
    page
  }) => {
    // #given a note holding a 3x3 table
    const note = await createNote(page, `Table Nub Reach ${Date.now()}`)
    await openNoteByHandle(page, note)
    await setDocument(page, GRID_DOC)

    const editor = page.locator(SELECTORS.noteEditor).first()
    const bodyRow = editor.locator('table tr').nth(1)
    const middleCell = bodyRow.locator('td').nth(1)
    await expect(middleCell).toBeVisible({ timeout: 15_000 })

    // #when the caret is put in the middle cell, so its own inline-end border
    // carries BOTH its nub and the resize shield
    await middleCell.click({ position: IN_CELL })
    await expect(page.locator('[data-memry-table-resize-shield]')).toHaveCount(1, {
      timeout: 10_000
    })

    const cellNub = page.locator('[data-memry-table-handle="cell"]')
    const cellPill = cellNub.locator('.memry-table-handle-pill')
    await expect(cellNub).toBeVisible({ timeout: 10_000 })

    // #then the nub's hit box reaches past the 3px bar it paints. The pointer
    // arrives across the thin axis, so that is the axis that is padded — the
    // long axis is left alone because it is where a column resize drag starts.
    const restingPill = await box(cellPill)
    const restingHit = await box(cellNub)
    expect(Math.abs(restingPill.width - BAR_THICKNESS)).toBeLessThanOrEqual(TOLERANCE)
    expect(restingHit.width).toBeGreaterThan(restingPill.width + 4)
    expect(Math.abs(restingHit.height - restingPill.height)).toBeLessThanOrEqual(TOLERANCE)

    // #and the pointer can travel along that border — over the shield, off the
    // nub — without the bars dropping. The shield is not a `<td>`, and reading
    // it as "the table was left" is what made a focused cell's nub unreachable.
    const cellBox = await box(middleCell)
    const edge = cellBox.x + cellBox.width
    await page.mouse.move(edge - 1, cellBox.y + 4)
    await expect(cellNub).toBeVisible()
    await expect(page.locator('[data-memry-table-handles] .memry-table-handle')).toHaveCount(3)

    // #and arriving from inside the cell, a press one pixel short of the line
    // opens the cell menu instead of landing in the text
    await page.mouse.move(edge - 5, cellBox.y + cellBox.height / 2)
    await page.mouse.down()
    await page.mouse.up()
    await expect(page.getByText('Colors', { exact: true }).first()).toBeVisible({ timeout: 5_000 })
  })

  test("the caret's cell is ringed in the accent, and the ring follows the caret", async ({
    page
  }) => {
    // #given a note holding a 3x3 table
    const note = await createNote(page, `Table Cell Focus ${Date.now()}`)
    await openNoteByHandle(page, note)
    await setDocument(page, GRID_DOC)

    const editor = page.locator(SELECTORS.noteEditor).first()
    const rows = editor.locator('table tr')
    await expect(rows).toHaveCount(3, { timeout: 15_000 })

    const ring = page.locator('[data-memry-table-cell-focus]')

    /** The ring's seam, and whether its box is the given cell's box. */
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

    // #when the caret is put in A1 by clicking
    await rows.nth(1).locator('td').nth(0).click({ position: IN_CELL })
    await expect(ring).toHaveCount(1, { timeout: 10_000 })

    // #then the ring is exactly that cell's box, and there is only one of them
    const first = await ringOn(1, 0)
    expect({ count: first.count, row: first.row, col: first.col }).toEqual({
      count: 1,
      row: '1',
      col: '0'
    })
    expect(first.offBy).toBeLessThanOrEqual(TOLERANCE)

    // #and it is painted in the user's accent, not a colour of its own. The
    // token is resolved through a probe because `--tint-border` is a
    // `color-mix()` that `getPropertyValue` hands back unevaluated.
    const paint = await ring.evaluate((element) => {
      const probe = document.createElement('div')
      probe.style.color = 'var(--tint-border)'
      element.ownerDocument.body.appendChild(probe)
      const tint = getComputedStyle(probe).color
      probe.remove()
      return { border: getComputedStyle(element).borderTopColor, tint }
    })
    expect(paint.border).toBe(paint.tint)

    await shootTable(page, editor.locator('.tableWrapper').first(), 'table-cell-focus.png')

    // #when the caret moves to the cell below with the KEYBOARD
    await page.keyboard.press('ArrowDown')
    await expect(ring).toHaveAttribute('data-row-index', '2', { timeout: 10_000 })

    // #then the ring moved with it and left A1 bare
    const moved = await ringOn(2, 0)
    expect(moved.count).toBe(1)
    expect(moved.col).toBe('0')
    expect(moved.offBy).toBeLessThanOrEqual(TOLERANCE)
    const neighbour = await box(rows.nth(1).locator('td').nth(0))
    const ringBox = await box(ring)
    expect(Math.abs(ringBox.y - neighbour.y)).toBeGreaterThan(TOLERANCE)

    // #and typing does not shake it off the cell it is on
    await page.keyboard.type('xy')
    await expect(ring).toHaveAttribute('data-row-index', '2')
    const typed = await ringOn(2, 0)
    expect(typed.offBy).toBeLessThanOrEqual(TOLERANCE)

    // #and clicking straight into another cell hands it over
    await rows.nth(1).locator('td').nth(2).click({ position: IN_CELL })
    await expect(ring).toHaveAttribute('data-col-index', '2', { timeout: 10_000 })
    const clicked = await ringOn(1, 2)
    expect(clicked.count).toBe(1)
    expect(clicked.row).toBe('1')
    expect(clicked.offBy).toBeLessThanOrEqual(TOLERANCE)
  })

  test('an open menu leaves the table wrapper and takes the pointer', async ({ page }) => {
    // #given a note holding a 2x2 table
    const note = await createNote(page, `Table Menu Layer ${Date.now()}`)
    await openNoteByHandle(page, note)
    await setDocument(page, TABLE_DOC)

    const editor = page.locator(SELECTORS.noteEditor).first()
    const bodyCell = editor.locator('table tr').nth(1).locator('td').first()
    await expect(bodyCell).toBeVisible({ timeout: 15_000 })

    // #when the row menu is opened from that cell's inline-start nub
    await bodyCell.hover({ position: IN_CELL })
    const rowNub = page.locator('[data-memry-table-handle="row"]')
    await expect(rowNub).toBeVisible({ timeout: 10_000 })
    await rowNub.click()
    await expect(page.getByText('Delete row', { exact: true }).first()).toBeVisible({
      timeout: 10_000
    })
    await shootPage(page, 'table-row-menu-open.png')

    // #then it is not mounted inside `.tableWrapper`. That wrapper is the
    // table's own scroll container — `overflow-x: auto`, `overflow-y: hidden`,
    // `position: relative` — so a menu left beside its trigger is cut to the
    // table's box and painted under the editor's own layers.
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
        hitIsMenu: Boolean(hit) && (hit === menu || menu.contains(hit as Node)),
        hitDescription: hit ? `${hit.tagName}.${String(hit.className || '(no class)')}` : 'nothing',
        hitCursor: hit ? getComputedStyle(hit).cursor : 'none',
        menuBox,
        tableBox: rect(table),
        wrapperBox: rect(wrapper),
        viewport: { width: window.innerWidth, height: window.innerHeight }
      }
    })
    if (!layer) throw new Error('no open menu found next to the table')
    expect(layer.insideWrapper).toBe(false)

    // #and the middle of the menu is the menu: a clipped or under-painted one
    // leaves the editor's own content as the element under that point, which
    // is also why the caret cursor used to survive over it
    expect(layer.hitIsMenu, `the menu's own centre hit ${layer.hitDescription}`).toBe(true)
    expect(layer.hitCursor).toBe('pointer')

    // #and it is taller than the table it came from and reaches past the
    // wrapper's bottom edge, which is exactly what the clip used to cut off
    expect(layer.menuBox.height).toBeGreaterThan(layer.tableBox.height)
    expect(layer.menuBox.y + layer.menuBox.height).toBeGreaterThan(
      layer.wrapperBox.y + layer.wrapperBox.height
    )

    // #and none of it is off screen
    expect(layer.menuBox.x).toBeGreaterThanOrEqual(0)
    expect(layer.menuBox.y).toBeGreaterThanOrEqual(0)
    expect(layer.menuBox.x + layer.menuBox.width).toBeLessThanOrEqual(layer.viewport.width)
    expect(layer.menuBox.y + layer.menuBox.height).toBeLessThanOrEqual(layer.viewport.height)
  })

  test('the focused cell stops its own column resizing from fighting the nub', async ({ page }) => {
    // #given a note holding a 3x3 table
    const note = await createNote(page, `Table Resize Shield ${Date.now()}`)
    await openNoteByHandle(page, note)
    await setDocument(page, GRID_DOC)

    const editor = page.locator(SELECTORS.noteEditor).first()
    const bodyRow = editor.locator('table tr').nth(1)
    const firstCell = bodyRow.locator('td').nth(0)
    const middleCell = bodyRow.locator('td').nth(1)
    await expect(middleCell).toBeVisible({ timeout: 15_000 })

    /**
     * Drag the middle cell's inline-end border. Always the SAME edge — the only
     * thing that changes between the two halves of this test is which cell holds
     * the caret, so a difference in outcome can only be the shield.
     *
     * Aimed near the TOP of the edge, never its middle: the nub occupies the
     * middle 18px and swallows the pointer there, so a drag at the centre
     * resizes nothing whether or not the shield exists — measured, and it is
     * exactly how an earlier version of this test passed while proving nothing.
     *
     * The move before `mouse.down()` is not padding either: prosemirror-tables
     * arms the resize from a `mousemove` near the edge and only then does
     * `mousedown` start a drag, so pressing without approaching first is inert.
     */
    const dragMiddleEdge = async (by: number): Promise<number> => {
      const rect = await box(middleCell)
      const edge = rect.x + rect.width
      const y = rect.y + 5
      await page.mouse.move(edge - 12, y)
      await page.mouse.move(edge, y, { steps: 4 })
      await page.mouse.down()
      await page.mouse.move(edge + by, y, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(200)
      return (await box(middleCell)).width
    }

    // #when the caret is in the FIRST cell, so nothing shields the middle
    // cell's edge, and that edge is dragged
    await firstCell.click({ position: IN_CELL })
    await expect(page.locator('[data-memry-table-resize-shield]')).toHaveCount(1, {
      timeout: 10_000
    })
    const unshielded = await box(middleCell)
    const afterUnshielded = await dragMiddleEdge(60)

    // #then it resizes — column resizing at large is untouched
    expect(afterUnshielded).toBeGreaterThan(unshielded.width + 1)

    // #when the caret moves into the middle cell, putting its nub and its
    // shield on that same edge, and the identical drag is repeated
    await middleCell.click({ position: IN_CELL })
    await expect(
      page
        .locator('[data-memry-table-resize-shield]')
        .evaluate((el) => el.getBoundingClientRect().x)
    ).resolves.toBeGreaterThan(0)
    const shielded = await box(middleCell)
    const afterShielded = await dragMiddleEdge(60)

    // #then the edge does not move: the nub keeps it
    expect(Math.abs(afterShielded - shielded.width)).toBeLessThanOrEqual(TOLERANCE)
  })

  test('each nub opens the menu for its own row, column and cell', async ({ page }) => {
    // #given a note holding a 3x3 table whose every cell is separately named
    const note = await createNote(page, `Table Handle Menus ${Date.now()}`)
    await openNoteByHandle(page, note)
    await setDocument(page, GRID_DOC)

    const editor = page.locator(SELECTORS.noteEditor).first()
    const rows = editor.locator('table tr')
    await expect(rows).toHaveCount(3, { timeout: 15_000 })

    const cellNub = page.locator('[data-memry-table-handle="cell"]')
    const rowNub = page.locator('[data-memry-table-handle="row"]')
    const colNub = page.locator('[data-memry-table-handle="column"]')

    // --- the cell menu ---
    // #when A1's inline-end nub is opened. That nub is 3px wide and centred on
    // the 1px line A1 and A2 share, so the element under the cursor is as
    // likely to be A2 — a menu that read the hovered cell instead of the nub's
    // own would colour the neighbour, and would look identical doing it.
    await rows.nth(1).locator('td').nth(0).hover({ position: IN_CELL })
    await expect(cellNub).toBeVisible({ timeout: 10_000 })
    await cellNub.click()

    const colorsItem = page.getByText('Colors', { exact: true }).first()
    await expect(colorsItem).toBeVisible({ timeout: 10_000 })
    await shootPage(page, 'table-cell-menu-open.png')
    await colorsItem.click()
    await page.locator('[data-test="background-color-red"]').first().click()

    // #then the colour is on A1 — row 1, column 0 — and on no other cell
    await expect.poll(async () => (await tableShape(page))[1][0].background).toBe('red')
    const coloured = await tableShape(page)
    expect(coloured[1][1].background).not.toBe('red')
    expect(coloured[0][0].background).not.toBe('red')
    expect(coloured[2][0].background).not.toBe('red')

    // #and the saved note names that one cell, `row:column`, and only it
    await expect
      .poll(async () => (await getNoteFileBodyById(page, note.id)) ?? '', { timeout: 20_000 })
      .toContain('<!-- table-colors:')
    const saved = await getNoteFileBodyById(page, note.id)
    expect(saved).toContain('"1:0":{"backgroundColor":"red"}')
    expect(saved).not.toContain('"1:1"')

    // --- the row menu ---
    // #when the LAST body row's inline-start nub deletes a row
    await setDocument(page, GRID_DOC)
    await rows.nth(2).locator('td').nth(1).hover({ position: IN_CELL })
    await expect(rowNub).toBeVisible({ timeout: 10_000 })
    await rowNub.click()
    await page.getByText('Delete row', { exact: true }).first().click()

    // #then row 2 is the row that went, not the row above it
    await expect
      .poll(async () => textGrid(await tableShape(page)))
      .toEqual([
        ['H1', 'H2', 'H3'],
        ['A1', 'A2', 'A3']
      ])

    // --- the column menu ---
    // #when the middle column's block-start nub deletes a column
    await setDocument(page, GRID_DOC)
    await rows.nth(1).locator('td').nth(1).hover({ position: IN_CELL })
    await expect(colNub).toBeVisible({ timeout: 10_000 })
    await colNub.click()
    await page.getByText('Delete column', { exact: true }).first().click()

    // #then column 1 is the column that went, in every row
    await expect
      .poll(async () => textGrid(await tableShape(page)))
      .toEqual([
        ['H1', 'H3'],
        ['A1', 'A3'],
        ['B1', 'B3']
      ])
  })

  /**
   * Everything below is driven by keys.
   *
   * The caret has to start somewhere and the editor is only reachable by
   * clicking into it, so each test clicks the FIRST header cell once and walks
   * to its target from there: a menu that read the clicked cell instead of the
   * caret's would act on H1 and be caught by the grid that comes out.
   */
  const walkToA2 = async (page: Page): Promise<void> => {
    const rows = page.locator(SELECTORS.noteEditor).first().locator('table tr')
    await expect(rows).toHaveCount(3, { timeout: 15_000 })
    await rows.nth(0).locator('th, td').nth(0).click({ position: IN_CELL })
    const anchor = page.locator('[data-memry-table-keyboard-anchor]')
    await expect(anchor).toHaveCount(1, { timeout: 10_000 })
    // ArrowRight would walk the text inside a cell first; Tab is the one that
    // crosses a cell boundary in a single press.
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Tab')
    await expect(anchor).toHaveAttribute('data-row-index', '1', { timeout: 10_000 })
    await expect(anchor).toHaveAttribute('data-col-index', '1')
  }

  /**
   * The label of the menu item that holds the focus, or '' while the focus is
   * still on the menu's own box.
   */
  const focusedItem = (page: Page): Promise<string> =>
    page.evaluate(() => {
      const active = document.activeElement
      if (active?.getAttribute('data-slot') !== 'dropdown-menu-item') return ''
      return (active.textContent ?? '').trim()
    })

  /**
   * Walk the open menu with ArrowDown until `label` holds the focus, then run
   * it with Enter.
   *
   * Each press waits for the highlight to actually move: Radix moves the focus
   * a frame after the key, and pressing again before it lands leaves the walk
   * stuck on the first item.
   */
  const runByKeyboard = async (page: Page, label: string): Promise<void> => {
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
    // #given a note holding a 3x3 table whose every cell is separately named,
    // so acting on the neighbouring row shows up as the wrong name surviving
    // rather than as a count that happens to match
    const note = await createNote(page, `Table Keyboard Row ${Date.now()}`)
    await openNoteByHandle(page, note)
    await setDocument(page, GRID_DOC)

    // #when the caret is walked to A2 — row 1, column 1 — and the table menu is
    // asked for with the keyboard
    await walkToA2(page)
    const menu = page.locator('.memry-table-keyboard-menu')
    await page.keyboard.press('ControlOrMeta+Shift+Enter')
    await expect(menu).toBeVisible({ timeout: 10_000 })

    // #then the menu names the cell it will act on, counted the way a person
    // counts, and Radix hands that name to the dropdown as its own
    await expect(menu).toContainText('Row 2 · Column 2')
    const menuName = await menu.evaluate((element) => {
      const id = element.getAttribute('aria-labelledby')
      return id ? (document.getElementById(id)?.getAttribute('aria-label') ?? '') : ''
    })
    expect(menuName).toBe('Table actions for row 2, column 2')

    // #and the keystroke that opened it never reached the editor: the cell is
    // not split and still holds the one line it started with
    expect(textGrid(await tableShape(page))[1][1]).toBe('A2')

    // #when "Add row below" is reached with the arrow keys and run with Enter
    await runByKeyboard(page, 'Add row below')

    // #then the new row is under A, not under the header and not at the end
    await expect
      .poll(async () => textGrid(await tableShape(page)))
      .toEqual([
        ['H1', 'H2', 'H3'],
        ['A1', 'A2', 'A3'],
        ['', '', ''],
        ['B1', 'B2', 'B3']
      ])
  })

  test('a keyboard alone deletes the caret’s column', async ({ page }) => {
    // #given the same 3x3 table, with the caret walked to A2
    const note = await createNote(page, `Table Keyboard Column ${Date.now()}`)
    await openNoteByHandle(page, note)
    await setDocument(page, GRID_DOC)
    await walkToA2(page)

    // #when the menu is opened and "Delete column" is run, both from keys
    await page.keyboard.press('ControlOrMeta+Shift+Enter')
    await expect(page.locator('.memry-table-keyboard-menu')).toBeVisible({ timeout: 10_000 })
    await runByKeyboard(page, 'Delete column')

    // #then column 1 is the column that went, in every row
    await expect
      .poll(async () => textGrid(await tableShape(page)))
      .toEqual([
        ['H1', 'H3'],
        ['A1', 'A3'],
        ['B1', 'B3']
      ])
  })

  test('Escape closes the keyboard menu and hands the caret back to its cell', async ({ page }) => {
    // #given a 3x3 table with the caret at the END of A1, put there with keys
    const note = await createNote(page, `Table Keyboard Escape ${Date.now()}`)
    await openNoteByHandle(page, note)
    await setDocument(page, GRID_DOC)

    const editor = page.locator(SELECTORS.noteEditor).first()
    const rows = editor.locator('table tr')
    await expect(rows).toHaveCount(3, { timeout: 15_000 })

    // The CRDT provider rebinds the fresh note a beat after it opens, replacing
    // the editor state wholesale (`view.updateState`, no transaction) — and a
    // caret placed before that lands degrades to its CELL'S START, which is
    // exactly the position this test is about. Wait for the doc identity to
    // hold still across two polls before placing the caret.
    await page.waitForFunction(
      () => {
        const w = window as any
        const doc = w.__memryEditor?.prosemirrorView?.state.doc
        if (!doc) return false
        const settled = w.__docProbe === doc
        w.__docProbe = doc
        return settled
      },
      undefined,
      { timeout: 15_000, polling: 500 }
    )

    await rows.nth(0).locator('th, td').nth(0).click({ position: IN_CELL })
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('End')

    const anchor = page.locator('[data-memry-table-keyboard-anchor]')
    await expect(anchor).toHaveAttribute('data-row-index', '1', { timeout: 10_000 })
    await expect(anchor).toHaveAttribute('data-col-index', '0')

    // And prove the caret truly stands at the END of A1 before the menu opens —
    // the whole point of the journey that follows.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const state = (window as any).__memryEditor.prosemirrorView?.state
            if (!state) return null
            const $from = state.selection.$from
            return { text: $from.parent.textContent, offset: $from.parentOffset }
          }),
        { timeout: 10_000 }
      )
      .toEqual({ text: 'A1', offset: 2 })

    // #when the menu is opened and then dismissed with Escape
    const menu = page.locator('.memry-table-keyboard-menu')
    await page.keyboard.press('ControlOrMeta+Shift+Enter')
    await expect(menu).toBeVisible({ timeout: 10_000 })
    // Visible is paint, not readiness: Radix wires its dismiss/focus scope a
    // beat after the content mounts, and an Escape in that gap dies unheard.
    // Focus arriving inside the menu is the signal the scope is live — the
    // same signal every runByKeyboard walk already waits on.
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Boolean(document.activeElement?.closest('.memry-table-keyboard-menu'))
          ),
        { timeout: 10_000 }
      )
      .toBe(true)
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0, { timeout: 10_000 })

    // #then the focus is back inside the editor, not left on the box the menu
    // hung from
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

    // Focus in the editor is not yet the caret: ProseMirror syncs the DOM
    // selection from its state a beat after the view regains focus, and typing
    // in that gap lands at the cell's start ("zzA1"). Wait for the caret to
    // stand where the menu found it — the end of A1 — before typing.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const sel = window.getSelection()
            if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return 'no-caret'
            const range = sel.getRangeAt(0)
            const node = range.startContainer
            const el = node instanceof Element ? node : node.parentElement
            const cell = el?.closest('td, th')
            if (!cell || cell.textContent !== 'A1') return 'outside-cell'
            const atEnd =
              node.nodeType === Node.TEXT_NODE
                ? range.startOffset === (node.textContent?.length ?? 0)
                : range.startOffset >= node.childNodes.length
            return atEnd ? 'end-of-A1' : 'in-A1'
          }),
        { timeout: 10_000 }
      )
      .toBe('end-of-A1')

    // #and typing lands back in the cell the menu was opened from, at the caret
    // it was opened with — nothing else in the table moved
    await page.keyboard.type('zz')
    await expect
      .poll(async () => textGrid(await tableShape(page)), { timeout: 10_000 })
      .toEqual([
        ['H1', 'H2', 'H3'],
        ['A1zz', 'A2', 'A3'],
        ['B1', 'B2', 'B3']
      ])
  })
})

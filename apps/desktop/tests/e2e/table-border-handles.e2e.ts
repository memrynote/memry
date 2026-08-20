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
import { openNoteByHandle } from './utils/note-sync-helpers'

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
 * Where to aim a pointer inside a cell. Not the centre: a cell is a fixed
 * 120px wide and a short word leaves the middle empty. Not `{8, 8}` either —
 * the block drag handle overhangs the first column there.
 */
const IN_CELL = { x: 20, y: 20 }

/** The 1px border `@blocknote/core` paints on every `th`/`td`. */
const CELL_BORDER = 1
/** The resting bar covers that line and 1px either side of it. */
const BAR_THICKNESS = 3

/** Matches `BAR_LENGTH` in table-border-handles.tsx. */
const BAR_LENGTH = 18
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

/** Centre of the border line that STARTS at `edge` (a cell's start side). */
const lineFrom = (edge: number): number => edge + CELL_BORDER / 2
/** Centre of the border line that ENDS at `edge` (a cell's end side). */
const lineTo = (edge: number): number => edge - CELL_BORDER / 2

/** Save a tight crop of the table so 3px bars are actually visible. */
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
    // #given a note holding a 2x2 table
    const note = await createNote(page, `Table Border Handles ${Date.now()}`)
    await openNoteByHandle(page, note)
    await setDocument(page, TABLE_DOC)

    const editor = page.locator(SELECTORS.noteEditor).first()
    const bodyRow = editor.locator('table tr').nth(1)
    const bodyCells = bodyRow.locator('td')
    const firstBodyCell = bodyCells.first()
    await expect(firstBodyCell).toBeVisible({ timeout: 15_000 })

    // #and BlockNote's own handles are gone — nothing floats beside the table
    await firstBodyCell.hover({ position: IN_CELL })
    await expect(page.locator('.bn-table-handle')).toHaveCount(0)

    // #when the pointer rests in the first body cell
    const bars = page.locator('[data-memry-table-handles] .memry-table-handle')

    // #then exactly three bars are up, and all three belong to the ONE hovered
    // cell: its inline-start border, its inline-end border, and the table's
    // block-start border above it. Not the rest of the row, not the table.
    await expect(bars).toHaveCount(3, { timeout: 10_000 })

    const table = editor.locator('table').first()
    const tableBox = await box(table)
    const cell0 = await box(bodyCells.nth(0))

    /** A nub covers the middle BAR_LENGTH of its segment, not the whole line. */
    const nubStart = (segmentStart: number, span: number): number =>
      segmentStart + (span - Math.min(BAR_LENGTH, span)) / 2
    const nubLength = (span: number): number => Math.min(BAR_LENGTH, span)

    // --- the row bar: centred on the hovered cell's inline-start border ---
    const rowBar = await box(page.locator('[data-memry-table-bar="row"]'))
    expect(rowBar.width).toBeCloseTo(BAR_THICKNESS, 0)
    expect(Math.abs(rowBar.x + rowBar.width / 2 - lineFrom(cell0.x))).toBeLessThanOrEqual(TOLERANCE)
    expect(Math.abs(rowBar.y - nubStart(cell0.y, cell0.height))).toBeLessThanOrEqual(TOLERANCE)
    expect(Math.abs(rowBar.height - nubLength(cell0.height))).toBeLessThanOrEqual(TOLERANCE)

    // --- the column bar: centred on the table's block-start border, over the
    // hovered cell's own inline extent ---
    const colBar = await box(page.locator('[data-memry-table-bar="column"]'))
    expect(colBar.height).toBeCloseTo(BAR_THICKNESS, 0)
    expect(Math.abs(colBar.y + colBar.height / 2 - lineFrom(tableBox.y))).toBeLessThanOrEqual(
      TOLERANCE
    )
    expect(Math.abs(colBar.x - nubStart(cell0.x, cell0.width))).toBeLessThanOrEqual(TOLERANCE)
    expect(Math.abs(colBar.width - nubLength(cell0.width))).toBeLessThanOrEqual(TOLERANCE)

    // --- one cell bar, centred on the hovered cell's inline-end border ---
    const cellBars = page.locator('[data-memry-table-bar="cell"]')
    await expect(cellBars).toHaveCount(1)
    const cellBar = await box(cellBars.first())
    expect(cellBar.width).toBeCloseTo(BAR_THICKNESS, 0)
    expect(
      Math.abs(cellBar.x + cellBar.width / 2 - lineTo(cell0.x + cell0.width))
    ).toBeLessThanOrEqual(TOLERANCE)
    expect(Math.abs(cellBar.y - nubStart(cell0.y, cell0.height))).toBeLessThanOrEqual(TOLERANCE)
    expect(Math.abs(cellBar.height - nubLength(cell0.height))).toBeLessThanOrEqual(TOLERANCE)

    // #and a resting bar is a bare line: no border, no ring, no outline
    const resting = await page.locator('[data-memry-table-handle="row"]').evaluate((element) => {
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
    await rowControl.hover()
    await expect
      .poll(
        async () => {
          const grown = await rowControl.boundingBox()
          return grown ? `${Math.round(grown.width)}x${Math.round(grown.height)}` : 'gone'
        },
        { timeout: 5_000 }
      )
      .toBe('14x22')

    // #and it is still centred on the same border line it was resting on
    const grown = await box(rowControl)
    expect(Math.abs(grown.x + grown.width / 2 - lineFrom(cell0.x))).toBeLessThanOrEqual(TOLERANCE)

    await shootTable(page, editor.locator('.tableWrapper').first(), 'table-bar-hovered.png')

    // #and the column bar takes the same box lying down
    const colControl = page.locator('[data-memry-table-handle="column"]')
    await colControl.hover()
    await expect
      .poll(
        async () => {
          const wide = await colControl.boundingBox()
          return wide ? `${Math.round(wide.width)}x${Math.round(wide.height)}` : 'gone'
        },
        { timeout: 5_000 }
      )
      .toBe('22x14')
  })
})

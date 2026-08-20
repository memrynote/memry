// @ts-nocheck - E2E test; window.api typing lives in the renderer bundle
/**
 * The table row/column handle rests as a slim pill, not an icon button.
 *
 * BlockNote's handle is the 6-dot drag button at a row's inline-start edge and
 * a column's top edge. Neither @blocknote/core nor @blocknote/shadcn styles
 * `.bn-table-handle`, so out of the box it is the full 24px icon the moment the
 * pointer enters a table. base.css re-cuts it: a 6x18 pill at rest (18x6 for a
 * column, under BlockNote's own inline rotation), expanding back into the icon
 * button when the handle itself is hovered.
 *
 * The source-level guard for that stylesheet is
 * src/renderer/src/assets/blocknote-table-handle-css.test.ts. It can only prove
 * the rule is written; this proves it lands — that our declarations actually
 * beat the bundled shadcn Button utilities in the real cascade, and that the
 * measured box is what the design asked for.
 *
 * WHEN the handle appears is BlockNote's own hover tracking and is untouched;
 * these tests lean on it exactly as the neighbouring table specs do.
 */

import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready } from './utils/desktop-test-helpers'
import { SELECTORS } from './utils/electron-helpers'
import { openNoteByHandle } from './utils/note-sync-helpers'

const cell = (text: string) => ({
  type: 'tableCell',
  content: [{ type: 'text', text, styles: {} }],
  props: { colspan: 1, rowspan: 1 }
})

/** A two-column table with one header row — what `/table` inserts. */
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
 * Where to aim a pointer gesture inside a cell.
 *
 * Not the centre: a cell is a fixed 120px wide, a short word leaves the middle
 * empty. Not the very corner either — the block drag handle overhangs the first
 * column at {8, 8}.
 */
const CELL_POINT = { x: 20, y: 20 }

/**
 * base.css declares `width: 6px; height: 18px` on a `content-box` element with
 * a 2px ring, so the element measures 10x22 — the pill plus its knockout ring.
 * The column handle is the same box under an inline `rotate(0.25turn)`, and a
 * bounding box is axis-aligned, so it reads back transposed.
 */
const REST = { width: 10, height: 22 }
/** `width: 24px; height: 24px` plus the same 2px ring, now transparent. */
const EXPANDED = { width: 28, height: 28 }

/**
 * Both boxes are whole-pixel CSS on an unscaled element, so the measured box
 * should land on the integer; 1px of slack absorbs subpixel rounding without
 * letting a wrong box through.
 */
function expectAbout(actual: number, expected: number, what: string): void {
  const message = `${what} measured ${actual}, expected ~${expected}`
  expect(actual, message).toBeGreaterThanOrEqual(expected - 1)
  expect(actual, message).toBeLessThanOrEqual(expected + 1)
}

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

async function setTableDocument(page: Page): Promise<void> {
  const editor = page.locator(SELECTORS.noteEditor).first()
  await editor.waitFor({ state: 'visible', timeout: 15_000 })
  await page.evaluate((next) => {
    const editor = (window as any).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')
    editor.replaceBlocks(editor.document, next)
  }, TABLE_DOC)
}

/**
 * The handle the way it is actually painted: its measured box, the styles the
 * cascade settled on, and the drag icon's opacity.
 */
async function paintedHandle(locator) {
  const box = await locator.boundingBox()
  const style = await locator.evaluate((element: HTMLElement) => {
    const computed = getComputedStyle(element)
    const icon = element.querySelector('[data-test="tableHandle"]') as HTMLElement | null
    return {
      backgroundColor: computed.backgroundColor,
      borderBlockStartWidth: computed.borderBlockStartWidth,
      borderStartStartRadius: computed.borderStartStartRadius,
      boxSizing: computed.boxSizing,
      // Read through the element so the token resolves in its own theme.
      tertiary: computed.getPropertyValue('--text-tertiary').trim(),
      background: computed.getPropertyValue('--background').trim(),
      iconOpacity: icon ? getComputedStyle(icon).opacity : null
    }
  })
  return { box, ...style }
}

/**
 * '#8c8c8c' -> 'rgb(140, 140, 140)', so a token can be compared to a paint.
 * Three-digit hex is expanded first — the themes mix both forms.
 */
function tokenToRgb(hex: string): string {
  const digits = hex.replace('#', '')
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits
  const channels = [0, 2, 4].map((offset) => parseInt(full.slice(offset, offset + 2), 16))
  expect(channels.some(Number.isNaN), `\`${hex}\` is not a hex token`).toBe(false)
  return `rgb(${channels.join(', ')})`
}

test.describe('Table handle pill E2E', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page)
  })

  test('the row handle rests as a slim pill and expands back into the icon button', async ({
    page
  }) => {
    // #given a note holding a table
    const note = await createNote(page, `Table Handle Row ${Date.now()}`)
    await openNoteByHandle(page, note)
    await setTableDocument(page)

    // #when the pointer enters a body cell, BlockNote shows its handles. The
    // row handle is the one it does not rotate.
    const bodyCell = page.locator(`${SELECTORS.noteEditor} td`).first()
    await bodyCell.hover({ position: CELL_POINT })
    const rowHandle = page.locator('.bn-table-handle:not([style*="rotate"])').first()
    await expect(rowHandle).toBeVisible({ timeout: 10_000 })

    // #then it is a slim vertical pill, not the icon button
    const resting = await paintedHandle(rowHandle)
    expectAbout(resting.box.width, REST.width, 'resting row handle width')
    expectAbout(resting.box.height, REST.height, 'resting row handle height')
    expect(resting.box.height).toBeGreaterThan(resting.box.width)

    // #and the paint came from the theme tokens, which is the proof our
    // declarations beat the bundled shadcn ghost-button utilities
    expect(resting.boxSizing).toBe('content-box')
    expect(resting.backgroundColor).toBe(tokenToRgb(resting.tertiary))
    expect(resting.borderBlockStartWidth).toBe('2px')
    expect(resting.borderStartStartRadius).toBe('4px')

    // #and the drag dots are gone
    expect(resting.iconOpacity).toBe('0')

    // #when the handle itself is hovered
    await rowHandle.hover()

    // #then it grows back into the icon button and the dots come back
    await expect
      .poll(async () => Math.round((await rowHandle.boundingBox()).width), { timeout: 5_000 })
      .toBe(EXPANDED.width)
    const expanded = await paintedHandle(rowHandle)
    expectAbout(expanded.box.height, EXPANDED.height, 'expanded row handle height')
    expect(expanded.box.width).toBeGreaterThan(resting.box.width)
    expect(expanded.box.height).toBeGreaterThan(resting.box.height)
    expect(expanded.iconOpacity).toBe('1')
    expect(expanded.backgroundColor).not.toBe(resting.backgroundColor)
  })

  test('the column handle is the same pill, lying down', async ({ page }) => {
    // #given a note holding a table
    const note = await createNote(page, `Table Handle Column ${Date.now()}`)
    await openNoteByHandle(page, note)
    await setTableDocument(page)

    // #when the pointer enters a body cell, the rotated handle is the column's
    const bodyCell = page.locator(`${SELECTORS.noteEditor} td`).first()
    await bodyCell.hover({ position: CELL_POINT })
    const columnHandle = page.locator('.bn-table-handle[style*="rotate"]').first()
    await expect(columnHandle).toBeVisible({ timeout: 10_000 })

    // #then the same 10x22 box reads back transposed, because a bounding box is
    // axis-aligned and BlockNote rotates this one a quarter turn
    const resting = await paintedHandle(columnHandle)
    expectAbout(resting.box.width, REST.height, 'resting column handle width')
    expectAbout(resting.box.height, REST.width, 'resting column handle height')
    expect(resting.box.width).toBeGreaterThan(resting.box.height)
    expect(resting.iconOpacity).toBe('0')

    // #and the ring is painted in the editor background, so the pill knocks
    // itself out of the cell border it sits on rather than merging with it
    expect(resting.backgroundColor).toBe(tokenToRgb(resting.tertiary))
    const border = await columnHandle.evaluate(
      (element: HTMLElement) => getComputedStyle(element).borderBlockStartColor
    )
    expect(border).toBe(tokenToRgb(resting.background))

    // #when the handle itself is hovered it expands the same way
    await columnHandle.hover()
    await expect
      .poll(async () => Math.round((await columnHandle.boundingBox()).height), { timeout: 5_000 })
      .toBe(EXPANDED.height)
    expect((await paintedHandle(columnHandle)).iconOpacity).toBe('1')
  })
})
